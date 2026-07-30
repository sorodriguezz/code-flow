//! The JVM sidecar that carries the InterSystems JDBC driver.
//!
//! IRIS's only real client is a Type 4 JDBC driver, which is Java, so the driver in
//! [`super::iris`] is a client of *this* — a single `java` process running
//! `com.codeflow.iris.IrisBridge`, talked to in newline-delimited JSON over its stdin and stdout.
//!
//! What that buys, and what it costs:
//!
//! - **One process for every IRIS session, not one per connection.** The explorer opens a session
//!   per namespace and a JVM apiece would cost tens of megabytes each. Sessions are multiplexed by
//!   the id in each request; the Java side keeps a `Connection` per id.
//! - **It exists only while IRIS is in use.** The process is spawned on the first connection and
//!   asked to exit when the last one closes, so a workspace with no IRIS connection never pays for
//!   it. Reopening pays the ~300 ms spawn again, which is the right side of that trade for a tool
//!   that is idle most of the time.
//! - **The password crosses on stdin, never in argv.** A command line is world-readable in `ps`;
//!   a pipe between parent and child is not.
//!
//! The runtime itself is bundled — a `jlink`-trimmed JRE under the app's resources, built by
//! `scripts/build-iris-runtime.mjs` — so nothing has to be installed for IRIS to work. An
//! already-installed JDK is still honoured when the bundle isn't there, which is what makes
//! `cargo test` and a dev build work before that script has ever run.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

/// The live bridge, or nothing when IRIS isn't in use.
///
/// A `tokio` mutex rather than a `std` one because obtaining it spans the spawn, and holding a
/// blocking lock across `await` would stall the runtime's worker thread.
static BRIDGE: OnceLock<AsyncMutex<Option<Arc<Bridge>>>> = OnceLock::new();

/// Hands back the running bridge, starting one if there isn't a usable one.
pub async fn bridge() -> Result<Arc<Bridge>, String> {
    let slot = BRIDGE.get_or_init(|| AsyncMutex::new(None));
    let mut guard = slot.lock().await;
    if let Some(existing) = guard.as_ref() {
        if existing.alive.load(Ordering::SeqCst) {
            return Ok(existing.clone());
        }
    }
    let started = Arc::new(Bridge::spawn().await?);
    *guard = Some(started.clone());
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
    /// bundled one and a system JDK fail in very different ways, and the fix differs with them.
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
    async fn spawn() -> Result<Self, String> {
        let runtime = Runtime::locate()?;

        // Through `proc` rather than `Command::new`: `java.exe` is a console binary, and Windows
        // hands one a `conhost` window of its own. Opening a database would flash a black console
        // over the app — which reads as the app running something behind your back, not as a driver
        // starting.
        let mut child = crate::proc::command(&runtime.java)
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
            .arg("com.codeflow.iris.IrisBridge")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Without this, quitting the app while a query is running would leave the JVM behind.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                format!(
                    "CodeFlow couldn't start the Java runtime it uses to reach IRIS \
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
                    eprintln!("iris-bridge: {line}");
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
                        eprintln!("iris-bridge: unreadable frame: {line}");
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
                            .unwrap_or("The IRIS bridge failed without saying why.")
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
    /// inside the async runtime. This is what [`super::iris::IrisSession`]'s `Drop` uses.
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

    /// False once the JVM is gone. The IRIS driver reports this as the session being dead, which is
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

const POISONED: &str = "The IRIS bridge's request table was left in a broken state.";

/// What every in-flight call fails with when the JVM goes away. Never reported bare — it says what
/// happened and not why, so it is always composed by [`died_message`], which adds the cause.
pub const BRIDGE_DIED: &str =
    "The Java bridge CodeFlow uses to reach IRIS stopped running. The next statement reconnects.";

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
    /// The bundled runtime, else whatever JDK the machine already has.
    ///
    /// The fallbacks are not a convenience feature — they are what makes a source checkout work
    /// before `scripts/build-iris-runtime.mjs` has produced the bundle, and what keeps a damaged
    /// install recoverable instead of simply broken.
    fn locate() -> Result<Self, String> {
        let dir = iris_resource_dir().ok_or_else(|| missing_resources().to_string())?;
        let classpath = classpath(&dir)?;

        let bundled = dir.join("runtime").join("bin").join(java_exe());
        if bundled.is_file() {
            return Ok(Self {
                java: bundled,
                classpath,
            });
        }
        // Only the fallbacks are version-checked. The bundled runtime is built by
        // `scripts/build-iris-runtime.mjs` against the same release the bridge is compiled for, so
        // it cannot be too old; a JDK that happens to be on the machine very much can, and a JVM
        // started on one dies on its first class file with a message no dialog ever sees.
        if let Some(home) = std::env::var_os("JAVA_HOME") {
            let candidate = Path::new(&home).join("bin").join(java_exe());
            if candidate.is_file() {
                too_old(&candidate, "JAVA_HOME")?;
                return Ok(Self {
                    java: candidate,
                    classpath,
                });
            }
        }
        if let Some(candidate) = which_java() {
            too_old(&candidate, "PATH")?;
            return Ok(Self {
                java: PathBuf::from("java"),
                classpath,
            });
        }
        Err(format!(
            "CodeFlow ships its own Java runtime for IRIS, and this install doesn't have it \
             (expected {}). Reinstalling the app restores it; installing a JDK and setting \
             JAVA_HOME also works.",
            bundled.display()
        ))
    }
}

/// The jar `scripts/build-iris-runtime.mjs` compiles from `src-tauri/java`. Named here because its
/// absence is the one classpath problem worth its own message.
const BRIDGE_JAR: &str = "iris-bridge.jar";

/// Every jar in the resource directory, in one classpath.
///
/// Scanned rather than named so that bumping the driver's version is a change to the build script
/// alone — nothing here has to learn the new file name.
fn classpath(dir: &Path) -> Result<String, String> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut jars: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("{} ({}: {e})", missing_resources(), dir.display()))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jar"))
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if jars.is_empty() {
        return Err(format!(
            "{} (no .jar in {})",
            missing_resources(),
            dir.display()
        ));
    }
    // The bridge by name, not just "some jar". A build whose `javac` step failed still leaves the
    // driver jar here — it is downloaded first — and a classpath of only the driver starts a JVM
    // that dies on `Could not find or load main class`, which reaches the user as "the bridge
    // stopped running" and names nothing that can be fixed.
    if !jars.iter().any(|jar| jar.ends_with(BRIDGE_JAR)) {
        return Err(format!(
            "{} ({BRIDGE_JAR} is not in {})",
            missing_resources(),
            dir.display()
        ));
    }
    // Deterministic, so a classpath conflict fails the same way twice rather than by directory
    // iteration order.
    jars.sort();
    Ok(jars.join(&separator.to_string()))
}

/// What to say when the runtime and jars aren't there.
///
/// The advice differs by build, and giving the wrong one wastes real time: a packaged app has a
/// damaged install, while a source checkout has simply never run the generator — the directory is
/// in git but its contents are build outputs.
fn missing_resources() -> &'static str {
    if cfg!(debug_assertions) {
        "CodeFlow's IRIS support files (the Java runtime, the bridge and the InterSystems JDBC \
         driver) haven't been built. Run `pnpm iris:runtime` — it needs a JDK 17+ and only has to \
         be done once."
    } else {
        "CodeFlow's IRIS support files (the Java runtime, the bridge and the InterSystems JDBC \
         driver) aren't where they should be. Reinstalling the app restores them."
    }
}

/// The Java release the bridge's class files are built for — `RELEASE` in
/// `scripts/build-iris-runtime.mjs`. A JVM older than this cannot load them at all.
const REQUIRED_JAVA: u32 = 17;

/// Refuses a fallback JVM that is too old to load the bridge, and says so in the terms the user can
/// act on.
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
        "CodeFlow's own Java runtime for IRIS isn't in this install, and the Java it fell back to \
         is too old: {} (on {found_via}) is Java {version}, and the IRIS bridge needs {REQUIRED_JAVA} \
         or newer. Reinstalling CodeFlow restores the bundled runtime; installing a JDK \
         {REQUIRED_JAVA}+ and pointing JAVA_HOME at it also works.",
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

fn java_exe() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

fn which_java() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(java_exe()))
        .find(|candidate| candidate.is_file())
}

/// Where the bundled runtime and jars live.
///
/// In a packaged app that is the resource directory Tauri unpacks to. In a source checkout it is
/// the build script's own output directory, which is why a dev build needs no install step.
fn iris_resource_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(resources) = crate::paths::resource_dir() {
        candidates.push(resources.join("iris"));
    }
    // Debug only. In a release build this path names the *build* machine, so it could never
    // resolve on a user's — and baking it into the shipped binary would leak it for nothing.
    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("iris"),
    );

    // "The directory exists" stopped being evidence of anything: *every* checkout has one now,
    // holding only the README that keeps it in git so tauri-build can find it. Taking the first
    // that existed meant a dev build locked onto Tauri's copy — which holds just that README until
    // the generator has run — and never looked at the checkout that may have the real thing.
    //
    // So the usable directory is the one with jars in it. Only when none qualifies does the first
    // existing path win, and that is purely so the error names somewhere real.
    candidates
        .iter()
        .find(|dir| classpath(dir).is_ok())
        .or_else(|| candidates.iter().find(|dir| dir.is_dir()))
        .cloned()
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

    /// The classpath has to hold every jar in the directory — the bridge and the driver are two
    /// separate files, and dropping either one makes the JVM start and immediately fail.
    #[test]
    fn the_classpath_collects_every_jar() {
        let dir = std::env::temp_dir().join(format!("cf-iris-cp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a-driver.jar"), b"").unwrap();
        std::fs::write(dir.join(BRIDGE_JAR), b"").unwrap();
        std::fs::write(dir.join("notes.txt"), b"").unwrap();

        let built = classpath(&dir).unwrap();
        let separator = if cfg!(windows) { ';' } else { ':' };
        let parts: Vec<&str> = built.split(separator).collect();
        assert_eq!(parts.len(), 2, "{built}");
        assert!(parts[0].ends_with("a-driver.jar"), "{built}");
        assert!(parts[1].ends_with(BRIDGE_JAR), "{built}");
        assert!(!built.contains("notes.txt"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The exact leftover a failed build produces: `javac` never ran, so the driver jar — which is
    /// downloaded before it — is the only thing in the directory. Accepting that starts a JVM with
    /// no main class to run.
    #[test]
    fn the_driver_alone_is_not_a_runtime() {
        let dir = std::env::temp_dir().join(format!("cf-iris-nobridge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("intersystems-jdbc-3.11.0.jar"), b"").unwrap();
        let refused = classpath(&dir).unwrap_err();
        assert!(refused.contains(BRIDGE_JAR), "{refused}");

        std::fs::write(dir.join(BRIDGE_JAR), b"").unwrap();
        assert!(classpath(&dir).is_ok());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The README-only directory that every checkout has must not count as "the runtime is here".
    ///
    /// This is the exact shape that broke a Windows dev build: Tauri's copy under `target/debug`
    /// held only that file, the old check accepted it for merely existing, and the real jars a few
    /// directories away were never looked at.
    #[test]
    fn a_directory_holding_only_the_readme_does_not_qualify() {
        let dir = std::env::temp_dir().join(format!("cf-iris-readme-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("README.md"), b"# generated, not checked in").unwrap();
        assert!(classpath(&dir).is_err(), "a README is not a runtime");

        std::fs::write(dir.join("iris-bridge.jar"), b"").unwrap();
        assert!(classpath(&dir).is_ok(), "a jar is");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// An empty directory is a broken install, not an empty classpath — starting the JVM with one
    /// would fail with `ClassNotFoundException` instead of something a user can act on.
    #[test]
    fn a_directory_without_jars_is_an_error() {
        let dir = std::env::temp_dir().join(format!("cf-iris-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(classpath(&dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Starts the real bridge and talks to it.
    ///
    /// Everything between `locate` and the reply is only exercised together: finding the runtime,
    /// assembling the classpath, spawning the JVM, framing a request and matching the answer back
    /// to the caller that is waiting for it. A unit test of any one of those would have passed
    /// while the chain was broken.
    ///
    /// Skipped rather than failed when the runtime hasn't been built — a fresh checkout has the
    /// directory (git keeps it, so tauri-build can find it) but none of its generated contents
    /// until `pnpm iris:runtime` runs, and that is not a broken test. The condition is therefore
    /// "are the jars there", not "is there a directory".
    #[tokio::test]
    async fn the_bundled_runtime_answers() {
        if !iris_resource_dir().is_some_and(|dir| classpath(&dir).is_ok()) {
            eprintln!("skipping: no IRIS runtime built — run `pnpm iris:runtime`");
            return;
        }
        let bridge = match bridge().await {
            Ok(bridge) => bridge,
            Err(e) => panic!("could not start the IRIS bridge: {e}"),
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
