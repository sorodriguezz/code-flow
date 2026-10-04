//! The JVM sidecar that carries every JDBC driver.
//!
//! IRIS's only real client is a Type 4 JDBC driver, which is Java, and so are Oracle's thin driver and
//! every engine of the driver catalogue that has no Rust driver at all. They are all clients of
//! *this* — a `java` process running `com.codeflow.jdbc.JdbcBridge`, talked to in newline-delimited
//! JSON over its stdin and stdout. Each session names the jars of its driver when it opens, and the
//! bridge loads them into a class loader of their own.
//!
//! What that buys, and what it costs:
//!
//! - **One process for every session, not one per connection.** The explorer opens a session per
//!   database and a JVM apiece would cost tens of megabytes each. Sessions are multiplexed by the id
//!   in each request; the Java side keeps a `Connection` per id.
//! - **One process per JVM configuration, not one for everything.** A driver can be given JVM
//!   options of its own (`-Xmx2g`, `-Duser.timezone=UTC`) or a Java home of its own, and those are
//!   properties of a process — so bridges are keyed by [`JvmOptions`], and every driver left at the
//!   defaults shares one.
//! - **It exists only while it is in use.** A bridge is spawned on the first connection that needs
//!   it and asked to exit when the last one closes, so a workspace with no JDBC connection never pays
//!   for it.
//! - **The password crosses on stdin, never in argv.** A command line is world-readable in `ps`;
//!   a pipe between parent and child is not.
//!
//! Neither the runtime nor the drivers ship with the app: both are downloaded on first use
//! ([`super::drivers`]). What ships is the bridge itself, a few kilobytes built from
//! `src-tauri/java/` by `scripts/build-jdbc-bridge.mjs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use super::drivers::JvmOptions;

/// The live bridges, one per JVM configuration in use.
///
/// A `tokio` mutex rather than a `std` one because obtaining it spans the spawn, and holding a
/// blocking lock across `await` would stall the runtime's worker thread.
static BRIDGES: OnceLock<AsyncMutex<HashMap<JvmOptions, Arc<Bridge>>>> = OnceLock::new();

/// Hands back the running bridge for a JVM configuration, starting one if there isn't a usable one.
pub async fn bridge_for(jvm: &JvmOptions) -> Result<Arc<Bridge>, String> {
    let slot = BRIDGES.get_or_init(|| AsyncMutex::new(HashMap::new()));
    let mut bridges = slot.lock().await;
    if let Some(existing) = bridges.get(jvm) {
        if existing.alive.load(Ordering::SeqCst) {
            return Ok(existing.clone());
        }
    }
    // Dead ones go: a bridge that exited is only kept as the key to replace.
    bridges.retain(|_, bridge| bridge.alive.load(Ordering::SeqCst));
    let started = Arc::new(Bridge::spawn(jvm).await?);
    bridges.insert(jvm.clone(), started.clone());
    Ok(started)
}

/// Request id → where its answer goes. Shared with the reader task, which is the only thing that
/// removes entries.
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Bridge {
    stdin: AsyncMutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    /// Cleared when the process dies, so [`bridge`] replaces it instead of writing into a pipe
    /// nobody is reading.
    alive: Arc<AtomicBool>,
    /// Open sessions. The JVM is asked to exit when this reaches zero.
    sessions: AtomicUsize,
    /// Held so that replacing a dead bridge reaps its process rather than leaving a zombie.
    child: Mutex<tokio::process::Child>,
    /// Which `java` this was started with, so a failure can say *whose* runtime failed — the
    /// downloaded one and a Java home set on a driver fail in very different ways, and the fix
    /// differs with them.
    java: String,
    /// What the JVM wrote to stderr before it died. See [`Diagnostics`].
    diagnostics: Diagnostics,
    /// The runtime this was started on, captured because a session's `Drop` needs to spawn the
    /// close and cannot rely on running inside one: `db_disconnect` is a *sync* Tauri command, so
    /// the drop that closes a session happens on a thread with no runtime in context. Without this
    /// the JDBC connection would be held open inside the JVM until the app exited.
    handle: tokio::runtime::Handle,
}

/// The opening lines the JVM wrote to stderr, kept so that a bridge which dies can say why.
///
/// The *opening* lines, not the last ones: when a JVM fails to start — class files built for a
/// newer release than it implements, a jar it can't read, a missing main class — it says so
/// immediately, and that first line is the one a user can act on. A stack trace from a query that
/// went wrong later is already reported through that query's own error.
///
/// This exists because `eprintln!` reaches nobody in a packaged build: on Windows the app runs
/// under `windows_subsystem = "windows"` and has no console at all, so without keeping the lines
/// here the only thing left of a failed start is "the bridge stopped running" — the symptom, never
/// the cause.
type Diagnostics = Arc<Mutex<Vec<String>>>;

/// How many lines to keep, and how many of them to put in front of the user. The cap is what keeps
/// a chatty driver from growing this without limit.
const DIAGNOSTICS_KEPT: usize = 8;
const DIAGNOSTICS_SHOWN: usize = 4;

impl Bridge {
    async fn spawn(jvm: &JvmOptions) -> Result<Self, String> {
        let runtime = Runtime::locate(jvm)?;

        // Through `proc` rather than `Command::new`: `java.exe` is a console binary, and Windows
        // hands one a `conhost` window of its own. Opening a database would flash a black console
        // over the app — which reads as the app running something behind your back, not as a driver
        // starting.
        let mut command = crate::proc::command(&runtime.java);
        command
            .arg("-cp")
            .arg(&runtime.classpath)
            // The bridge is a request/response servant, not a server: a small heap keeps a result
            // set honest and keeps the process's footprint near the JVM's own floor.
            .arg("-Xms16m")
            .arg("-Xmx512m")
            // Nothing here benefits from a second's worth of JIT warmup, and C1-only shaves both
            // startup and resident memory.
            .arg("-XX:TieredStopAtLevel=1")
            .arg("-XX:+UseSerialGC")
            .arg("-Dfile.encoding=UTF-8")
            // Apache Arrow — inside Snowflake's driver, the Flight SQL one InfluxDB uses and
            // Databricks' — reads direct buffers through `java.nio` internals, which Java 16 and
            // later close by default: without this, those drivers connect and then fail on the
            // first result set. Opening one package to the classpath costs every other driver nothing.
            .arg("--add-opens=java.base/java.nio=ALL-UNNAMED")
            // The driver's own options last, so one of them overrides ours — the JVM takes the last
            // of a repeated flag, which is what makes `-Xmx2g` on a driver mean what it says.
            .args(&jvm.vm_options)
            .envs(jvm.env.iter().map(|(key, value)| (key.as_str(), value.as_str())))
            .arg("com.codeflow.jdbc.JdbcBridge");
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Without this, quitting the app while a query is running would leave the JVM behind.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                format!(
                    "CodeFlow couldn't start the Java runtime its JDBC drivers run on \
                     ({}): {e}",
                    runtime.java.display()
                )
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or("the Java bridge exposed no stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("the Java bridge exposed no stdout")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("the Java bridge exposed no stderr")?;

        let alive = Arc::new(AtomicBool::new(true));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        // Anything the JVM or the driver writes to stderr is a diagnostic, not a frame. It is worth
        // keeping — a stack trace here is the only clue when the bridge dies mid-query.
        let diagnostics: Diagnostics = Arc::new(Mutex::new(Vec::new()));
        {
            let sink = diagnostics.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("jdbc-bridge: {line}");
                    if let Ok(mut kept) = sink.lock() {
                        if kept.len() < DIAGNOSTICS_KEPT && !line.trim().is_empty() {
                            kept.push(line);
                        }
                    }
                }
            });
        }

        // The reader owns response routing. When stdout ends the process is gone, so every caller
        // still waiting is failed rather than left hanging forever.
        {
            let alive = alive.clone();
            let pending = pending.clone();
            let diagnostics = diagnostics.clone();
            let java = runtime.java.display().to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                        eprintln!("jdbc-bridge: unreadable frame: {line}");
                        continue;
                    };
                    let Some(id) = frame.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    let waiting = pending.lock().ok().and_then(|mut map| map.remove(&id));
                    let Some(waiting) = waiting else { continue };
                    let answer = if frame.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                        Ok(frame.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("The JDBC bridge failed without saying why.")
                            .to_string())
                    };
                    let _ = waiting.send(answer);
                }
                alive.store(false, Ordering::SeqCst);
                let orphaned: Vec<_> = pending
                    .lock()
                    .map(|mut map| map.drain().map(|(_, tx)| tx).collect())
                    .unwrap_or_default();
                let reason = died_message(&java, &diagnostics);
                for tx in orphaned {
                    let _ = tx.send(Err(reason.clone()));
                }
            });
        }

        Ok(Self {
            stdin: AsyncMutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            alive,
            sessions: AtomicUsize::new(0),
            child: Mutex::new(child),
            java: runtime.java.display().to_string(),
            diagnostics,
            // Always valid here: spawning is only ever reached from an async command.
            handle: tokio::runtime::Handle::current(),
        })
    }

    /// Closes a session without waiting for it, from anywhere — including a thread that is not
    /// inside the async runtime. This is what every JDBC session's `Drop` uses.
    pub fn close_session_detached(self: &Arc<Self>, session: String) {
        let bridge = self.clone();
        self.handle
            .spawn(async move { bridge.close_session(&session).await });
    }

    /// Sends one request and waits for its answer.
    ///
    /// No timeout on purpose: a report that takes four minutes is a report, not a hang, and the
    /// console's Cancel button is the way to stop one — the same choice the rest of the database
    /// workspace makes. The one bounded call is `open`, which passes its own `timeoutMs` for the
    /// Java side to apply to the connect.
    pub async fn call(
        &self,
        op: &str,
        session: &str,
        fields: Map<String, Value>,
    ) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(self.died());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        let mut request = fields;
        request.insert("id".into(), Value::from(id));
        request.insert("op".into(), Value::from(op));
        request.insert("session".into(), Value::from(session));

        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|_| POISONED)?.insert(id, tx);

        let mut line = serde_json::to_string(&Value::Object(request)).map_err(|e| e.to_string())?;
        line.push('\n');

        let write = async {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        };
        if let Err(e) = write.await {
            self.pending.lock().map_err(|_| POISONED)?.remove(&id);
            self.alive.store(false, Ordering::SeqCst);
            return Err(format!("{} ({e})", self.died()));
        }

        match rx.await {
            Ok(answer) => answer,
            Err(_) => Err(self.died()),
        }
    }

    /// [`BRIDGE_DIED`], with whatever the JVM said on its way out.
    ///
    /// Every path that reports a dead bridge goes through this, because "it stopped running" on its
    /// own is unactionable: it is the same sentence whether the runtime is missing, is too old for
    /// these class files, or the server hung up. The JVM already said which — this is what carries
    /// that sentence to the person reading the dialog.
    fn died(&self) -> String {
        died_message(&self.java, &self.diagnostics)
    }

    /// False once the JVM is gone. A JDBC session reports this as the session being dead, which is
    /// what makes the registry reconnect rather than replay every statement into a closed pipe.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Records that a session was opened, so the JVM knows when it is no longer needed.
    pub fn session_opened(&self) {
        self.sessions.fetch_add(1, Ordering::SeqCst);
    }

    /// Closes one session, and the whole JVM with it when it was the last one.
    pub async fn close_session(&self, session: &str) {
        let _ = self.call("close", session, Map::new()).await;
        // `fetch_update` rather than `fetch_sub`: a double close must not wrap the counter around
        // and leave the process running forever.
        let was_last = self
            .sessions
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .map(|previous| previous == 1)
            .unwrap_or(false);
        if was_last {
            // The JVM halts itself on this, so the reply may never arrive — which is why the result
            // is discarded and the process is reaped rather than waited on.
            let _ = self.call("shutdown", "", Map::new()).await;
            self.alive.store(false, Ordering::SeqCst);
            if let Ok(mut child) = self.child.lock() {
                let _ = child.start_kill();
            }
        }
    }
}

const POISONED: &str = "The JDBC bridge's request table was left in a broken state.";

/// What every in-flight call fails with when the JVM goes away. Never reported bare — it says what
/// happened and not why, so it is always composed by [`died_message`], which adds the cause.
pub const BRIDGE_DIED: &str =
    "The Java bridge CodeFlow runs JDBC drivers in stopped running. The next statement reconnects.";

/// See [`Bridge::died`]. A free function because the reader task needs it too, and that task
/// outlives no `Bridge` — it is spawned while one is still being built.
fn died_message(java: &str, diagnostics: &Diagnostics) -> String {
    let said: Vec<String> = diagnostics
        .lock()
        .map(|kept| kept.iter().take(DIAGNOSTICS_SHOWN).cloned().collect())
        .unwrap_or_default();
    if said.is_empty() {
        return format!("{BRIDGE_DIED}\n\n{java} exited without saying why.");
    }
    format!("{BRIDGE_DIED}\n\n{java} reported:\n{}", said.join("\n"))
}

// ---------------------------------------------------------------------------
// Locating the runtime
// ---------------------------------------------------------------------------

struct Runtime {
    java: PathBuf,
    classpath: String,
}

impl Runtime {
    /// The `java` a driver's options name — the downloaded runtime, unless the driver was given a
    /// Java home of its own — and the bridge jar to run on it.
    ///
    /// A Java home the user picked is version-checked; the downloaded runtime is the release the
    /// catalogue asks for and cannot be too old.
    fn locate(jvm: &JvmOptions) -> Result<Self, String> {
        if jvm.java.as_os_str().is_empty() || !jvm.java.is_file() {
            return Err(format!(
                "{}jvm\nThe Java runtime CodeFlow's JDBC drivers run on hasn't been downloaded yet.",
                super::drivers::MISSING
            ));
        }
        if super::drivers::runtime_java().as_deref() != Some(jvm.java.as_path()) {
            too_old(&jvm.java, "the driver's settings")?;
        }
        let jar = bridge_jar().ok_or_else(|| missing_bridge().to_string())?;
        Ok(Self { java: jvm.java.clone(), classpath: jar.to_string_lossy().into_owned() })
    }
}

/// The jar `scripts/build-jdbc-bridge.mjs` compiles from `src-tauri/java` — the only Java the app
/// ships. The drivers' jars are not on its classpath: each session names its own (see
/// `JdbcBridge.Drivers`).
const BRIDGE_JAR: &str = "codeflow-jdbc-bridge.jar";

/// Where the bridge jar is.
///
/// In a packaged app that is the resource directory Tauri unpacks to. In a source checkout it is the
/// build script's own output directory, which is why a dev build needs no install step.
fn bridge_jar() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(resources) = crate::paths::resource_dir() {
        candidates.push(resources.join("jdbc").join(BRIDGE_JAR));
    }
    // Debug only. In a release build this path names the *build* machine, so it could never
    // resolve on a user's — and baking it into the shipped binary would leak it for nothing.
    #[cfg(debug_assertions)]
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("jdbc").join(BRIDGE_JAR));
    candidates.into_iter().find(|jar| jar.is_file())
}

/// What to say when the bridge jar isn't there.
///
/// The advice differs by build, and giving the wrong one wastes real time: a packaged app has a
/// damaged install, while a source checkout has simply never run the generator — the directory is
/// in git but its contents are build outputs.
fn missing_bridge() -> &'static str {
    if cfg!(debug_assertions) {
        "CodeFlow's JDBC bridge (codeflow-jdbc-bridge.jar) hasn't been built. Run `pnpm jdbc:bridge` \
         — it needs a JDK 17+ and only has to be done once."
    } else {
        "CodeFlow's JDBC bridge (codeflow-jdbc-bridge.jar) isn't where it should be. Reinstalling the \
         app restores it."
    }
}

/// The Java release the bridge's class files are built for — `RELEASE` in
/// `scripts/build-jdbc-bridge.mjs`. A JVM older than this cannot load them at all.
const REQUIRED_JAVA: u32 = 17;

/// Refuses a Java the user pointed a driver at that is too old to load the bridge, and says so in
/// the terms the user can act on.
///
/// Fails *open*: an unparseable `-version` is allowed through. The banner is here to replace a
/// confusing failure with a clear one, and refusing a JDK we simply failed to interrogate would be
/// a new failure of its own — one that breaks a machine where everything actually works.
fn too_old(java: &Path, found_via: &str) -> Result<(), String> {
    let Some(version) = java_release(java) else {
        return Ok(());
    };
    if version >= REQUIRED_JAVA {
        return Ok(());
    }
    Err(format!(
        "The Java set in {found_via} is too old: {} is Java {version}, and CodeFlow's JDBC bridge \
         needs {REQUIRED_JAVA} or newer. Point the driver at a newer Java home, or clear it to use the \
         runtime CodeFlow downloads.",
        java.display()
    ))
}

/// The feature version of a `java` binary, or `None` when it can't be read. `-version` writes to
/// stderr, which is why both streams are searched.
fn java_release(java: &Path) -> Option<u32> {
    let output = crate::proc::std_command(java)
        .arg("-version")
        .output()
        .ok()?;
    parse_java_release(&format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    ))
}

/// 17 from `openjdk version "17.0.9" …`, 8 from `java version "1.8.0_402"`. Every JVM quotes its
/// version on the first line of `-version`, which is the one thing about that output that has been
/// stable across every vendor and every release.
fn parse_java_release(text: &str) -> Option<u32> {
    let quoted = text.split('"').nth(1)?;
    let mut parts = quoted.split(['.', '-', '_', '+']);
    let first: u32 = parts.next()?.parse().ok()?;
    // `1.8.0` is Java 8: everything before 9 numbered itself `1.x`.
    if first == 1 {
        return parts.next()?.parse().ok();
    }
    Some(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The version guard is only worth having if it reads the real thing, and every vendor prints
    /// its own wording around the one quoted number.
    #[test]
    fn a_jvm_reports_its_feature_version() {
        let cases = [
            (
                "openjdk version \"17.0.9\" 2023-10-17\nOpenJDK Runtime Environment",
                Some(17),
            ),
            (
                "java version \"1.8.0_402\"\nJava(TM) SE Runtime Environment",
                Some(8),
            ),
            ("openjdk version \"21\" 2023-09-19", Some(21)),
            ("openjdk version \"11.0.21\" 2023-10-17", Some(11)),
            ("openjdk version \"22-ea\" 2024-03-19", Some(22)),
            // Not a JVM's answer at all: no quoted version, so nothing is claimed about it.
            ("bash: java: command not found", None),
            ("", None),
        ];
        for (output, expected) in cases {
            assert_eq!(parse_java_release(output), expected, "{output:?}");
        }
    }

    /// The one that matters: Java 8 is the version a Windows machine is most likely to already have
    /// on PATH, and it cannot load a class file built for 17.
    #[test]
    fn a_java_too_old_for_the_bridge_is_refused_by_number() {
        assert!(parse_java_release("java version \"1.8.0_402\"").unwrap() < REQUIRED_JAVA);
        assert!(parse_java_release("openjdk version \"17.0.9\"").unwrap() >= REQUIRED_JAVA);
    }

    /// Starts the real bridge and talks to it.
    ///
    /// Everything between `locate` and the reply is only exercised together: finding the runtime,
    /// assembling the classpath, spawning the JVM, framing a request and matching the answer back
    /// to the caller that is waiting for it. A unit test of any one of those would have passed
    /// while the chain was broken.
    ///
    /// Skipped rather than failed when either half is missing — a runtime nobody has downloaded
    /// on this machine, or a bridge `pnpm jdbc:bridge` hasn't built — since neither is a broken
    /// test.
    #[tokio::test]
    async fn the_downloaded_runtime_answers() {
        let Some(java) = super::super::drivers::runtime_java() else {
            eprintln!("skipping: no Java runtime downloaded");
            return;
        };
        if bridge_jar().is_none() {
            eprintln!("skipping: the bridge isn't built — run `pnpm jdbc:bridge`");
            return;
        }
        let jvm = JvmOptions { java, ..Default::default() };
        let bridge = match bridge_for(&jvm).await {
            Ok(bridge) => bridge,
            Err(e) => panic!("could not start the JDBC bridge: {e}"),
        };
        let answer = bridge
            .call("ping", "", Map::new())
            .await
            .expect("ping failed");
        assert_eq!(answer.get("pong").and_then(Value::as_bool), Some(true));

        // A session that was never opened must be refused by name, not crash the bridge — this is
        // the path a stale request from a closed connection takes.
        let missing = bridge.call("exec", "nobody", Map::new()).await;
        assert!(missing.is_err(), "{missing:?}");

        // And the bridge is still usable afterwards.
        assert!(bridge.call("ping", "", Map::new()).await.is_ok());
    }
}

/// The data editor's `batch` request: every statement, and how many rows each must affect (`-1` for
/// "don't check"). Shared by IRIS and Oracle, which apply edits the same way over the bridge.
pub(super) fn edit_batch_request(statements: &[String], edits: &[super::DbRowEdit]) -> serde_json::Map<String, serde_json::Value> {
    use serde_json::Value;
    let expect: Vec<Value> = edits
        .iter()
        .map(|edit| Value::from(if super::edit_expects_one_row(edit) { 1 } else { -1 }))
        .collect();
    let mut request = serde_json::Map::new();
    request.insert("statements".into(), Value::from(statements.to_vec()));
    request.insert("transactional".into(), Value::from(true));
    request.insert("expect".into(), Value::Array(expect));
    request
}

/// The bridge's answer to [`edit_batch_request`], as the data editor reports it.
pub(super) fn edit_batch_result(answer: &serde_json::Value, statements: Vec<String>) -> super::DbEditResult {
    use serde_json::Value;
    let applied = answer.get("applied").and_then(Value::as_u64).unwrap_or(0) as u32;
    let mismatch = answer.get("mismatchIndex").and_then(Value::as_u64);
    let error = match mismatch {
        Some(index) => {
            let affected = answer.get("affected").and_then(Value::as_i64).unwrap_or(0).max(0) as u64;
            let statement = statements.get(index as usize).map(String::as_str).unwrap_or_default();
            Some(super::wrong_row_count(index as usize + 1, statements.len(), affected, statement))
        }
        None => answer.get("error").and_then(Value::as_str).map(|message| {
            match answer.get("failedStatement").and_then(Value::as_str) {
                Some(statement) if !statement.is_empty() => format!("{message}\n\n{statement}"),
                _ => message.to_string(),
            }
        }),
    };
    super::DbEditResult { applied, statements, error }
}
