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
use tokio::process::{ChildStdin, Command};
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
    /// The runtime this was started on, captured because a session's `Drop` needs to spawn the
    /// close and cannot rely on running inside one: `db_disconnect` is a *sync* Tauri command, so
    /// the drop that closes a session happens on a thread with no runtime in context. Without this
    /// the JDBC connection would be held open inside the JVM until the app exited.
    handle: tokio::runtime::Handle,
}

impl Bridge {
    async fn spawn() -> Result<Self, String> {
        let runtime = Runtime::locate()?;

        let mut child = Command::new(&runtime.java)
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

        let stdin = child.stdin.take().ok_or("the Java bridge exposed no stdin")?;
        let stdout = child.stdout.take().ok_or("the Java bridge exposed no stdout")?;
        let stderr = child.stderr.take().ok_or("the Java bridge exposed no stderr")?;

        let alive = Arc::new(AtomicBool::new(true));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        // Anything the JVM or the driver writes to stderr is a diagnostic, not a frame. It is worth
        // keeping — a stack trace here is the only clue when the bridge dies mid-query.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("iris-bridge: {line}");
            }
        });

        // The reader owns response routing. When stdout ends the process is gone, so every caller
        // still waiting is failed rather than left hanging forever.
        {
            let alive = alive.clone();
            let pending = pending.clone();
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
                    let Some(id) = frame.get("id").and_then(Value::as_u64) else { continue };
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
                for tx in orphaned {
                    let _ = tx.send(Err(BRIDGE_DIED.to_string()));
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
            // Always valid here: spawning is only ever reached from an async command.
            handle: tokio::runtime::Handle::current(),
        })
    }

    /// Closes a session without waiting for it, from anywhere — including a thread that is not
    /// inside the async runtime. This is what [`super::iris::IrisSession`]'s `Drop` uses.
    pub fn close_session_detached(self: &Arc<Self>, session: String) {
        let bridge = self.clone();
        self.handle.spawn(async move { bridge.close_session(&session).await });
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
            return Err(BRIDGE_DIED.to_string());
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
            return Err(format!("{BRIDGE_DIED} ({e})"));
        }

        match rx.await {
            Ok(answer) => answer,
            Err(_) => Err(BRIDGE_DIED.to_string()),
        }
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

/// What every in-flight call fails with when the JVM goes away. Matched by the IRIS driver so a
/// dead bridge reads as a lost connection rather than a query error.
pub const BRIDGE_DIED: &str =
    "The Java bridge CodeFlow uses to reach IRIS stopped running. The next statement reconnects.";

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
        let dir = iris_resource_dir().ok_or_else(|| MISSING_RESOURCES.to_string())?;
        let classpath = classpath(&dir)?;

        let bundled = dir.join("runtime").join("bin").join(java_exe());
        if bundled.is_file() {
            return Ok(Self { java: bundled, classpath });
        }
        if let Some(home) = std::env::var_os("JAVA_HOME") {
            let candidate = Path::new(&home).join("bin").join(java_exe());
            if candidate.is_file() {
                return Ok(Self { java: candidate, classpath });
            }
        }
        if which_java().is_some() {
            return Ok(Self { java: PathBuf::from("java"), classpath });
        }
        Err(format!(
            "CodeFlow ships its own Java runtime for IRIS, and this install doesn't have it \
             (expected {}). Reinstalling the app restores it; installing a JDK and setting \
             JAVA_HOME also works.",
            bundled.display()
        ))
    }
}

/// Every jar in the resource directory, in one classpath.
///
/// Scanned rather than named so that bumping the driver's version is a change to the build script
/// alone — nothing here has to learn the new file name.
fn classpath(dir: &Path) -> Result<String, String> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut jars: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("{MISSING_RESOURCES} ({}: {e})", dir.display()))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("jar")))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if jars.is_empty() {
        return Err(format!("{MISSING_RESOURCES} (no .jar in {})", dir.display()));
    }
    // Deterministic, so a classpath conflict fails the same way twice rather than by directory
    // iteration order.
    jars.sort();
    Ok(jars.join(&separator.to_string()))
}

const MISSING_RESOURCES: &str =
    "CodeFlow's IRIS support files (the Java bridge and the InterSystems JDBC driver) aren't \
     where they should be. Reinstalling the app restores them.";

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
    if let Some(resources) = crate::paths::resource_dir() {
        let bundled = resources.join("iris");
        if bundled.is_dir() {
            return Some(bundled);
        }
    }
    // Debug only. In a release build this path names the *build* machine, so it could never
    // resolve on a user's — and baking it into the shipped binary would leak it for nothing.
    #[cfg(debug_assertions)]
    {
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("iris");
        if checkout.is_dir() {
            return Some(checkout);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The classpath has to hold every jar in the directory — the bridge and the driver are two
    /// separate files, and dropping either one makes the JVM start and immediately fail.
    #[test]
    fn the_classpath_collects_every_jar() {
        let dir = std::env::temp_dir().join(format!("cf-iris-cp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b-bridge.jar"), b"").unwrap();
        std::fs::write(dir.join("a-driver.jar"), b"").unwrap();
        std::fs::write(dir.join("notes.txt"), b"").unwrap();

        let built = classpath(&dir).unwrap();
        let separator = if cfg!(windows) { ';' } else { ':' };
        let parts: Vec<&str> = built.split(separator).collect();
        assert_eq!(parts.len(), 2, "{built}");
        assert!(parts[0].ends_with("a-driver.jar"), "{built}");
        assert!(parts[1].ends_with("b-bridge.jar"), "{built}");
        assert!(!built.contains("notes.txt"));

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
    /// Skipped rather than failed when the runtime hasn't been built — a fresh checkout has no
    /// `resources/iris` until `pnpm iris:runtime` runs, and that is not a broken test.
    #[tokio::test]
    async fn the_bundled_runtime_answers() {
        if iris_resource_dir().is_none() {
            eprintln!("skipping: no IRIS runtime built — run `pnpm iris:runtime`");
            return;
        }
        let bridge = match bridge().await {
            Ok(bridge) => bridge,
            Err(e) => panic!("could not start the IRIS bridge: {e}"),
        };
        let answer = bridge.call("ping", "", Map::new()).await.expect("ping failed");
        assert_eq!(answer.get("pong").and_then(Value::as_bool), Some(true));

        // A session that was never opened must be refused by name, not crash the bridge — this is
        // the path a stale request from a closed connection takes.
        let missing = bridge.call("exec", "nobody", Map::new()).await;
        assert!(missing.is_err(), "{missing:?}");

        // And the bridge is still usable afterwards.
        assert!(bridge.call("ping", "", Map::new()).await.is_ok());
    }
}
