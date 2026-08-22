//! The `llama-server` process: when it starts, when it stops, and how it is stopped for good.
//!
//! Shaped after [`crate::datasource::jvm`], which solves the same problem for the IRIS driver — a
//! bundled executable, spawned on first real need, spoken to over a private channel, and reaped
//! when the last user goes away. Read that module before changing this one; the differences are
//! deliberate and few:
//!
//! * The channel is HTTP on a loopback port rather than stdio, because that is the interface
//!   `llama-server` has.
//! * There is no session count to fall to zero. An editor never "closes" its use of completion, so
//!   the process is retired on an idle timer instead — see [`IDLE_TIMEOUT`].
//! * It holds a gigabyte or more of resident memory, which is why that timer exists at all. The
//!   JVM's floor is tens of megabytes and it can afford to linger.
//!
//! # What "lazy" means here, precisely
//!
//! Four things that could each plausibly start the engine, and only the last one does:
//!
//! | Moment | Starts it? | Why |
//! |---|---|---|
//! | App launch | No | Most sessions never open a code file, and the ones that do may not have the feature on. |
//! | The setting is switched on | No | Switching a setting is not asking for a completion, and the settings window is usually nowhere near the editor. |
//! | A model finishes downloading | No | Same reason, plus the download already took minutes and nobody is typing. |
//! | An editor asks for a completion | **Yes** | It is the first moment the answer is actually wanted. |
//!
//! That last one is affordable because starting is cheap: llama.cpp mmaps the GGUF rather than
//! reading it, and a 0.5B model measured 540 ms from spawn to `/health` answering on this
//! hardware. The *first* completion after a cold start still misses — [`ensure`] returns
//! [`Status::Starting`] rather than blocking a keystroke behind a model load — but the second one,
//! a second later, does not. Blocking would be the worse trade: a provider that stalls the editor
//! for a second is a provider the user turns off.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;

use super::catalogue::ModelSpec;

/// How long the process may sit with no completion request before it is retired.
///
/// Five minutes. The number is a trade between a gigabyte of resident memory and a 540 ms cold
/// start, and it is set from the side of the memory: a developer who leaves the editor to read
/// something, take a call, or run a build should not still be paying for an idle model twenty
/// minutes later, and the cost of being wrong is half a second the next time they type.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// How often the reaper wakes to compare the clock against `last_used`.
const REAP_INTERVAL: Duration = Duration::from_secs(30);

/// Context window the server is launched with.
///
/// Explicit, and deliberately not `-c 0` ("take it from the model") even though llama.cpp's own
/// `--fim-qwen-*` presets use that. Qwen2.5-Coder declares 32k, and reserving a KV cache for 32k
/// measured ~1 GB resident for a model whose weights are 531 MB — memory spent on context this
/// feature will never send. The prompt cannot approach 8k tokens: the editor trims it to 256 lines
/// before the caret and 64 after (`useInlineCompletion`), and
/// [`super::complete::MAX_SIDE_CHARS`] caps each side at 24 KiB regardless.
pub const CTX_SIZE: u32 = 8192;

/// Batch sizes, taken verbatim from llama.cpp's `--fim-qwen-1.5b-default` preset in
/// `common/arg.cpp`. They are larger than the defaults (2048/512) because a FIM prompt arrives all
/// at once and prompt evaluation is the dominant cost of a completion — 123 ms of the 173 ms
/// measured on the 0.5B.
const BATCH: u32 = 1024;
const UBATCH: u32 = 1024;

/// Tokens of prompt prefix llama.cpp may reuse from the previous request rather than re-evaluating.
///
/// The single most valuable flag here, and also from the same preset. Consecutive completions in
/// one file share almost all of their prefix, so without this every keystroke pays full prompt
/// evaluation over hundreds of lines.
const CACHE_REUSE: u32 = 256;

/// Ceiling on how long [`ensure`] will keep polling `/health` before calling the start a failure.
///
/// Generous on purpose. 540 ms is what a 0.5B took here with a warm page cache; a 7B model on a
/// cold spinning disk, or a machine where an antivirus scans every page of an 8 GB file on first
/// read, is a different story, and giving up on a start that would have worked is worse than
/// waiting.
const START_BUDGET: Duration = Duration::from_secs(180);

/// How long to wait between `/health` polls while starting.
const HEALTH_POLL: Duration = Duration::from_millis(150);

/// Lines of the server's stderr kept so a failed start can say *why*.
///
/// The first lines, not the last — same reasoning as `jvm::Diagnostics`. A process that fails to
/// start says so immediately; a later warning is noise on top of the real cause. And under
/// `windows_subsystem = "windows"` there is no console for them to reach otherwise.
const DIAGNOSTICS_KEPT: usize = 10;

/// The running server, or nothing.
///
/// A tokio mutex rather than a `std` one because acquiring it spans a spawn and several awaits,
/// and holding a blocking lock across `await` parks a runtime worker.
static ENGINE: OnceLock<AsyncMutex<Option<Arc<Engine>>>> = OnceLock::new();

/// What the UI is told, without having to touch [`ENGINE`].
///
/// A separate `std::sync::Mutex` on purpose: the status is read by a synchronous Tauri command on
/// every settings render and by the editor before each request, and making those await the same
/// lock a 180-second model load is holding would freeze the pane that exists to explain the wait.
static STATUS: OnceLock<Mutex<Status>> = OnceLock::new();

/// Where the engine is in its life, from the outside.
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Status {
    /// Not running, and nothing is wrong. The resting state.
    Off,
    /// Spawned, model loading, `/health` not answering yet.
    Starting { model_id: String },
    Ready { model_id: String },
    /// The last start or request failed. Holds a sentence for the user; the engine will be retried
    /// on the next request rather than latching forever.
    Failed { message: String },
}

fn status_cell() -> &'static Mutex<Status> {
    STATUS.get_or_init(|| Mutex::new(Status::Off))
}

/// The handle [`set_status`] announces through.
///
/// Stored rather than threaded because the places that change the status — a spawn deep inside
/// `ensure`, the idle reaper's timer task, a crash noticed while polling `/health` — have no
/// `AppHandle` and no business acquiring one. Same shape and same reason as `ai_usage::attach`.
static EMITTER: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Gives this module a way to tell the UI when the engine wakes, becomes ready, or dies.
///
/// Called once from `run()`'s `setup`. Without it everything still works and the status is simply
/// never pushed — the settings pane would learn it on its next read, and the editor's warm-up
/// indicator would never appear.
pub fn attach(app: tauri::AppHandle) {
    let _ = EMITTER.set(app);
}

/// The event name the frontend listens on.
pub const STATUS_EVENT: &str = "localai:engine";

/// The current status. Never blocks for long — see [`STATUS`].
pub fn status() -> Status {
    status_cell().lock().map(|s| s.clone()).unwrap_or(Status::Off)
}

fn set_status(next: Status) {
    // Only announced when it actually changed. The reaper and `ensure` both re-assert the current
    // status on paths where nothing moved, and a UI that re-renders the status bar every thirty
    // seconds to draw the same thing is a UI that costs battery for nothing.
    let changed = match status_cell().lock() {
        Ok(mut slot) => {
            let moved = *slot != next;
            *slot = next.clone();
            moved
        }
        Err(_) => false,
    };
    if changed {
        if let Some(app) = EMITTER.get() {
            use tauri::Emitter;
            let _ = app.emit(STATUS_EVENT, next);
        }
    }
}

pub struct Engine {
    pub model_id: String,
    pub port: u16,
    /// One client, reused. Building a `reqwest::Client` per request would open a fresh connection
    /// every keystroke and throw away the keep-alive that makes a loopback request cost nothing.
    client: reqwest::Client,
    /// Held so that dropping this struct reaps the process rather than leaving a zombie. Never
    /// awaited on the hot path.
    child: Mutex<tokio::process::Child>,
    alive: Arc<AtomicBool>,
    /// Epoch milliseconds of the last completion request, for the reaper.
    last_used: Arc<AtomicU64>,
    diagnostics: Arc<Mutex<Vec<String>>>,
}

impl Engine {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// Records that the engine was just used, so the reaper leaves it alone.
    pub fn touch(&self) {
        self.last_used.store(now_millis(), Ordering::Relaxed);
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// The running engine for `spec`, starting one if there is not already a usable one.
///
/// Returns `Ok(None)` — not an error — while a start is in progress. The caller is a completion
/// request, and "not yet" is a normal answer to that: it means show no ghost text this time and
/// try again on the next keystroke, which is a second away.
pub async fn ensure(spec: &ModelSpec, model_path: PathBuf) -> Result<Option<Arc<Engine>>, String> {
    let slot = ENGINE.get_or_init(|| AsyncMutex::new(None));

    // Two guards before `lock().await`, and they are the difference between "not yet" being a real
    // answer and being a lie.
    //
    // A start holds this mutex for as long as the model takes to load — up to [`START_BUDGET`].
    // Awaiting it would park every keystroke's request behind that load instead of declining them,
    // and on a 7B that is a queue of abandoned futures deep enough to matter. Neither of these is
    // an optimisation: without them the `Ok(None)` this function documents is unreachable.
    if matches!(status(), Status::Starting { .. }) {
        return Ok(None);
    }
    let Ok(mut guard) = slot.try_lock() else {
        // Contended. In the ready path the lock is held only long enough to clone an `Arc`, so
        // this means somebody is in the slow path — declining costs one completion, which the next
        // keystroke retries a moment later.
        return Ok(None);
    };

    if let Some(existing) = guard.as_ref() {
        if existing.is_alive() && existing.model_id == spec.id {
            existing.touch();
            return Ok(Some(existing.clone()));
        }
        // Either it died, or the user picked a different model. Both mean this one goes: a server
        // is bound to the single `-m` it was launched with, so switching models is a restart and
        // there is no in-place variant of it.
        stop_locked(&mut guard).await;
    }

    set_status(Status::Starting { model_id: spec.id.to_string() });
    match Engine::spawn(spec, model_path).await {
        Ok(engine) => {
            let engine = Arc::new(engine);
            *guard = Some(engine.clone());
            set_status(Status::Ready { model_id: spec.id.to_string() });
            spawn_reaper();
            Ok(Some(engine))
        }
        Err(message) => {
            set_status(Status::Failed { message: message.clone() });
            Err(message)
        }
    }
}

/// Stops the engine if one is running. Idempotent.
pub async fn shutdown() {
    let slot = ENGINE.get_or_init(|| AsyncMutex::new(None));
    let mut guard = slot.lock().await;
    stop_locked(&mut guard).await;
    set_status(Status::Off);
}

async fn stop_locked(guard: &mut Option<Arc<Engine>>) {
    let Some(engine) = guard.take() else { return };
    engine.alive.store(false, Ordering::SeqCst);
    // `kill_on_drop(true)` would do this when the last `Arc` goes, but "when the last Arc goes" is
    // not a moment anyone controls — a completion request in flight holds a clone. Killing here
    // makes the stop synchronous with the decision to stop.
    if let Ok(mut child) = engine.child.lock() {
        let _ = child.start_kill();
    }
    clear_pidfile();
}

impl Engine {
    async fn spawn(spec: &ModelSpec, model_path: PathBuf) -> Result<Self, String> {
        let binary = locate()?;
        let port = free_port()?;

        let mut child = crate::proc::command(&binary)
            .arg("-m")
            .arg(&model_path)
            // Loopback only. This server has no authentication of any kind and will happily
            // complete code for anyone who can reach it; binding anything else would put the
            // user's source on the local network.
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("-c")
            .arg(CTX_SIZE.to_string())
            .arg("-b")
            .arg(BATCH.to_string())
            .arg("-ub")
            .arg(UBATCH.to_string())
            .arg("--cache-reuse")
            .arg(CACHE_REUSE.to_string())
            // Offload everything the GPU will take. A number rather than a probe: llama.cpp
            // silently keeps on the CPU whatever does not fit, so "99" means "as much as
            // possible" on a Mac with Metal and costs nothing on a machine with no GPU at all.
            .arg("-ngl")
            .arg("99")
            // The bundled web UI is several megabytes of assets served to nobody — this server is
            // reachable only by this process.
            .arg("--no-webui")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            // The backstop for every path that does not reach `stop_locked`: a panic unwinding
            // past the owner, or the app exiting while a request is in flight.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                format!(
                    "CodeFlow couldn't start its local completion engine ({}): {e}",
                    binary.display()
                )
            })?;

        let diagnostics: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        if let Some(stderr) = child.stderr.take() {
            collect_diagnostics(stderr, diagnostics.clone());
        }

        write_pidfile(child.id(), port);

        let client = reqwest::Client::builder()
            // No proxy, ever. A machine configured with a corporate HTTP proxy would otherwise
            // send every keystroke of the user's source code through it on its way to 127.0.0.1.
            .no_proxy()
            .build()
            .map_err(|e| format!("Couldn't create the completion HTTP client: {e}"))?;

        let engine = Self {
            model_id: spec.id.to_string(),
            port,
            client,
            child: Mutex::new(child),
            alive: Arc::new(AtomicBool::new(true)),
            last_used: Arc::new(AtomicU64::new(now_millis())),
            diagnostics,
        };

        engine.await_ready(spec).await?;
        Ok(engine)
    }

    /// Polls `/health` until the model is loaded, the process dies, or [`START_BUDGET`] runs out.
    ///
    /// `/health` is the right signal and stdout parsing is not: the server answers 503 with
    /// `{"error":{"message":"Loading model"}}` while loading and 200 `{"status":"ok"}` when it can
    /// serve, which is exactly the question being asked, and it does not depend on a log line
    /// whose wording is not part of any interface.
    async fn await_ready(&self, spec: &ModelSpec) -> Result<(), String> {
        let url = format!("{}/health", self.base_url());
        let deadline = std::time::Instant::now() + START_BUDGET;

        while std::time::Instant::now() < deadline {
            // Checked first, so a server that dies on startup is reported in milliseconds with its
            // own stderr attached rather than after three minutes of polling a closed port.
            if let Ok(mut child) = self.child.lock() {
                if let Ok(Some(exit)) = child.try_wait() {
                    self.alive.store(false, Ordering::SeqCst);
                    return Err(format!(
                        "The local completion engine stopped immediately ({exit}). {}",
                        self.diagnostic_tail()
                    ));
                }
            }

            if let Ok(response) = self.client.get(&url).timeout(Duration::from_secs(2)).send().await
            {
                if response.status().is_success() {
                    return Ok(());
                }
            }
            tokio::time::sleep(HEALTH_POLL).await;
        }

        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
        Err(format!(
            "{} didn't finish loading within {} seconds. {}",
            spec.label,
            START_BUDGET.as_secs(),
            self.diagnostic_tail()
        ))
    }

    /// The kept stderr lines, as one sentence to append to an error.
    fn diagnostic_tail(&self) -> String {
        let Ok(lines) = self.diagnostics.lock() else { return String::new() };
        if lines.is_empty() {
            return String::new();
        }
        format!("It said: {}", lines.join(" / "))
    }
}

/// Drains the child's stderr into `sink`, keeping the first [`DIAGNOSTICS_KEPT`] interesting lines.
///
/// Detached rather than awaited: the point is to have the lines *if* something goes wrong, and a
/// healthy server writes to stderr for as long as it lives. The task ends when the pipe closes,
/// which is when the process dies.
fn collect_diagnostics(stderr: tokio::process::ChildStderr, sink: Arc<Mutex<Vec<String>>>) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(mut kept) = sink.lock() else { return };
            if kept.len() >= DIAGNOSTICS_KEPT {
                // Keep reading and discarding. Stopping here would eventually fill the pipe buffer
                // and block the server on its own logging.
                continue;
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                kept.push(trimmed.to_string());
            }
        }
    });
}

/// Retires the engine once it has gone [`IDLE_TIMEOUT`] without a request.
///
/// One task for the life of the process rather than one per engine: it is re-armed by [`ensure`]
/// on every start, and the latch keeps the second and later arms from stacking up timers that all
/// wake to find the same idle engine.
fn spawn_reaper() {
    static ARMED: OnceLock<()> = OnceLock::new();
    if ARMED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(REAP_INTERVAL).await;
            let slot = ENGINE.get_or_init(|| AsyncMutex::new(None));
            let mut guard = slot.lock().await;
            let idle = match guard.as_ref() {
                None => continue,
                Some(engine) => {
                    now_millis().saturating_sub(engine.last_used.load(Ordering::Relaxed))
                }
            };
            if idle >= IDLE_TIMEOUT.as_millis() as u64 {
                stop_locked(&mut guard).await;
                set_status(Status::Off);
            }
        }
    });
}

/// The bundled `llama-server`.
///
/// No fallback to a copy on `PATH`, unlike [`crate::datasource::jvm`]'s hunt for a system JDK. The
/// two cases are not alike: a JDK on the machine is a real runtime that will run our jar, whereas
/// picking up whatever `llama-server` a developer happens to have installed means completions come
/// from a build nobody chose, with flags this code did not write, and a bug report that cannot be
/// reproduced. When it is missing, the honest answer is that this install does not have it.
fn locate() -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };

    // A packaged app. `resource_dir()` is `None` under `cargo test` and in some dev runs, which is
    // why the source-checkout path below exists rather than this being the only branch.
    if let Some(resources) = crate::paths::resource_dir() {
        let bundled = resources.join("llama").join(name);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }

    // A source checkout, where `scripts/build-llama-runtime.mjs` writes into `src-tauri/resources`
    // and nothing has bundled it yet. Mirrors how the IRIS resources are found in dev.
    let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("llama").join(name);
    if checkout.is_file() {
        return Ok(checkout);
    }

    Err(format!(
        "CodeFlow ships a local completion engine and this install doesn't have it (expected \
         `llama/{name}` in the app resources). Reinstalling restores it; in a source checkout, run \
         `pnpm llama:runtime`."
    ))
}

/// Whether this install actually has the engine binary.
///
/// Answered before the user is offered anything, so a partial install says "this copy of CodeFlow
/// is missing its completion engine" instead of letting them download four gigabytes of weights and
/// only then discovering there is nothing to run them with.
pub fn is_available() -> bool {
    locate().is_ok()
}

/// An unused loopback port.
///
/// Asked of the OS rather than picked from a range, and *not* delegated to the server: llama-server
/// has no ephemeral-port mode — `--port 0` was tried against b10587 and the process comes up
/// listening on nothing at all — so the port has to be chosen here and handed over.
///
/// The listener is bound and dropped, which leaves a window in which something else could take the
/// port before the server binds it. That race is real and is handled where it shows up: a server
/// that cannot bind exits immediately, `await_ready` notices within a poll, and the next completion
/// request starts a fresh one on a fresh port.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Couldn't find a free local port for the completion engine: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Couldn't read back the local port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

// ---------------------------------------------------------------------------
// Surviving the parent
// ---------------------------------------------------------------------------
//
// `kill_on_drop(true)` plus the explicit kill in `stop_locked` covers everything that runs Rust
// destructors: a normal quit, a window close, a panic that unwinds. What neither covers is the
// process being killed outright — `kill -9`, Force Quit, End Task, a power loss — after which
// `llama-server` is left holding a gigabyte with no parent.
//
// The answer is a note on disk and a sweep at the next launch. Deliberately *not* a kill by pid
// alone: pids are reused, and on a machine that has rebooted since, the recorded number is as
// likely to name the user's browser. The sweep confirms the executable path first.

fn pidfile() -> PathBuf {
    crate::paths::state_dir().join(".llama-server.pid")
}

fn write_pidfile(pid: Option<u32>, port: u16) {
    let Some(pid) = pid else { return };
    let _ = std::fs::write(pidfile(), format!("{pid}\n{port}\n"));
}

fn clear_pidfile() {
    let _ = std::fs::remove_file(pidfile());
}

/// Kills an engine left behind by a previous run of the app.
///
/// Called once from `run()` at startup. Safe on every normal launch, where the file is absent
/// because the last run cleared it.
pub fn sweep_stale() {
    let path = pidfile();
    let Ok(contents) = std::fs::read_to_string(&path) else { return };
    let _ = std::fs::remove_file(&path);

    let Some(pid) = contents.lines().next().and_then(|line| line.trim().parse::<u32>().ok()) else {
        return;
    };

    let Ok(expected) = locate() else { return };

    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    let Some(process) = system.process(pid) else { return };

    // The identity check that makes this safe. A pid that has been reused names some other
    // program, and its executable will not be our bundled binary.
    let same = process.exe().is_some_and(|exe| exe == expected);
    if same {
        process.kill();
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Serializes the tests that touch this module's process-wide state.
///
/// [`STATUS`] and the pidfile are globals, and cargo runs tests as threads in one process — so
/// `status_starts_off_and_round_trips` asserting on the status while `complete::live_tests` is
/// starting a real engine is two tests writing one variable. That is a flake that appears only
/// when the timing lines up, which is the worst kind to debug, so every test that reads or writes
/// either one takes this first.
///
/// `lock().unwrap_or_else(|e| e.into_inner())` rather than `unwrap()`: a test that panics while
/// holding this would otherwise poison it and turn one failure into a cascade of them, hiding
/// which test actually broke. Same call `secrets.rs` and `git/lock_rules.rs` make.
#[cfg(test)]
pub(crate) fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_is_actually_free() {
        let port = free_port().expect("a port");
        assert!(port > 0);
        // Binding it again must succeed, which is the property the caller depends on — and the
        // reason `free_port` drops the listener rather than handing it over.
        let again = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(again.is_ok(), "port {port} was not actually free");
    }

    #[test]
    fn free_ports_differ() {
        let a = free_port().expect("a");
        let _hold = std::net::TcpListener::bind(("127.0.0.1", a)).expect("hold a");
        let b = free_port().expect("b");
        assert_ne!(a, b, "the OS handed out a port that is already bound");
    }

    #[test]
    fn status_starts_off_and_round_trips() {
        let _guard = test_guard();
        // Not `assert_eq!(status(), Status::Off)` as a first line: these tests share a process, so
        // another test may have set it. What matters is that a set is observable.
        set_status(Status::Ready { model_id: "x".into() });
        assert_eq!(status(), Status::Ready { model_id: "x".into() });
        set_status(Status::Off);
        assert_eq!(status(), Status::Off);
    }

    /// `sweep_stale` must be safe to call when there is no pidfile, when it is corrupt, and when it
    /// names a pid that is not ours — all three are ordinary states on a normal launch.
    #[test]
    fn sweep_tolerates_a_missing_or_junk_pidfile() {
        let _guard = test_guard();
        clear_pidfile();
        sweep_stale();

        let _ = std::fs::write(pidfile(), "not-a-number\n");
        sweep_stale();

        // This process's own pid. `locate()` will not resolve to this test binary, so the identity
        // check must refuse — if it did not, this test would kill the test runner.
        let _ = std::fs::write(pidfile(), format!("{}\n0\n", std::process::id()));
        sweep_stale();

        assert!(!pidfile().exists(), "the sweep must always consume the file it read");
    }
}
