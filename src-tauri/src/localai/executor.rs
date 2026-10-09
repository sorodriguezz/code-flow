//! The second `llama-server`: the one the hybrid task's executor talks to.
//!
//! [`super::engine`] is the first, and it stays exactly as it was — one process bound to a base
//! (fill-in-the-middle) model, an 8k context sized for a keystroke, and an `ensure` that answers
//! "not yet" rather than make anyone wait. Every one of those choices is wrong for this slot, which
//! is why it is a slot of its own and not a mode of that one:
//!
//! * **Instruct weights and the chat endpoint.** The executor is asked to rewrite a region and
//!   answers through `/v1/chat/completions`; llama.cpp b10587 applies the GGUF's own chat template
//!   (`--jinja` is on by default, checked with `--help`).
//! * **The context is the user's choice**, from 8k to whatever the model was trained for, because
//!   it is the budget every task is cut to fit. A different context is a different process.
//! * **[`ensure_ready`] waits.** A task asked for an answer and will wait the minute a 20 GB model
//!   takes to map; a keystroke would not.
//! * **The reaper counts requests in flight.** A completion lasts a fifth of a second, so the
//!   completion slot only has to remember when it was last *started*. A 32B writing a 400-line file
//!   can still be generating when the idle timer fires, and killing it there would be a bug that
//!   only ever happens on the biggest jobs.
//!
//! Both slots can run at once — the editor completing in one window while a task runs in another —
//! which is two models resident. The settings pane's memory estimate counts both.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;

use super::engine::{self, Status};
use super::exec_catalogue::ExecModelSpec;

/// How long the executor may sit idle before it is retired.
///
/// The same five minutes as the completion engine, measured from the end of the last request
/// rather than its start (see [`InFlight`]). Between two tasks of one run the gap is seconds; after
/// the run, the memory is given back by the run itself when "free memory when done" is on, and by
/// this timer when it is off.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

const REAP_INTERVAL: Duration = Duration::from_secs(30);

/// How long [`ensure_ready`] will wait for `/health`. The same three minutes as the completion
/// slot: a 20 GB model on a cold disk is exactly the case that budget was written for.
const START_BUDGET: Duration = Duration::from_secs(180);

const HEALTH_POLL: Duration = Duration::from_millis(250);

/// The event the frontend listens on for this slot. Same payload shape as the completion engine's.
pub const STATUS_EVENT: &str = "localai:executor";

static ENGINE: OnceLock<AsyncMutex<Option<Arc<ExecEngine>>>> = OnceLock::new();
static STATUS: OnceLock<Mutex<Status>> = OnceLock::new();

fn status_cell() -> &'static Mutex<Status> {
    STATUS.get_or_init(|| Mutex::new(Status::Off))
}

pub fn status() -> Status {
    status_cell().lock().map(|s| s.clone()).unwrap_or(Status::Off)
}

fn set_status(next: Status) {
    let changed = match status_cell().lock() {
        Ok(mut slot) => {
            let moved = *slot != next;
            *slot = next.clone();
            moved
        }
        Err(_) => false,
    };
    if changed {
        engine::emit(STATUS_EVENT, next);
    }
}

/// What a running executor was launched with. Two launches with different values are two
/// different processes — llama-server cannot change its model or context in place.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Launch {
    pub model_id: String,
    pub ctx: u32,
    /// `--reasoning-budget 0`: thinking models answer without a thinking phase. Spends nothing on
    /// models that have none.
    pub no_reasoning: bool,
}

pub struct ExecEngine {
    pub launch: Launch,
    pub port: u16,
    client: reqwest::Client,
    child: Mutex<tokio::process::Child>,
    alive: Arc<AtomicBool>,
    last_used: Arc<AtomicU64>,
    in_flight: Arc<AtomicUsize>,
    diagnostics: Arc<Mutex<Vec<String>>>,
}

/// Held for the length of one request. While any is held the reaper leaves the engine alone; when
/// the last one drops, the idle clock starts from *then*.
pub struct InFlight {
    count: Arc<AtomicUsize>,
    last_used: Arc<AtomicU64>,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.last_used.store(engine::now_millis(), Ordering::Relaxed);
        self.count.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ExecEngine {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Marks a request as started. Keep the guard alive until the response has been read.
    pub fn begin(&self) -> InFlight {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        self.last_used.store(engine::now_millis(), Ordering::Relaxed);
        InFlight { count: self.in_flight.clone(), last_used: self.last_used.clone() }
    }
}

/// The running executor for `launch`, starting (and waiting for) one when there is not a matching
/// one already.
///
/// Waits for the lock rather than declining it: the only other holder is another task's start,
/// and a task behind it wants the same answer after the same wait.
pub async fn ensure_ready(entry: &ExecModelSpec, model_path: PathBuf, launch: Launch) -> Result<Arc<ExecEngine>, String> {
    if !model_path.is_file() {
        return Err(format!(
            "{} isn't downloaded. Download it in Settings › AI engines › Local model.",
            entry.spec.label
        ));
    }
    let slot = ENGINE.get_or_init(|| AsyncMutex::new(None));
    let mut guard = slot.lock().await;

    if let Some(existing) = guard.as_ref() {
        if existing.is_alive() && existing.launch == launch {
            existing.last_used.store(engine::now_millis(), Ordering::Relaxed);
            return Ok(existing.clone());
        }
        stop_locked(&mut guard).await;
    }

    set_status(Status::Starting { model_id: launch.model_id.clone() });
    match ExecEngine::spawn(entry, model_path, launch.clone()).await {
        Ok(engine) => {
            let engine = Arc::new(engine);
            *guard = Some(engine.clone());
            set_status(Status::Ready { model_id: launch.model_id });
            spawn_reaper();
            Ok(engine)
        }
        Err(message) => {
            set_status(Status::Failed { message: message.clone() });
            Err(message)
        }
    }
}

/// Stops the executor if one is running. Idempotent.
pub async fn shutdown() {
    let slot = ENGINE.get_or_init(|| AsyncMutex::new(None));
    let mut guard = slot.lock().await;
    stop_locked(&mut guard).await;
    set_status(Status::Off);
}

/// The model the running executor has open, if any — so deleting that model's file can stop it
/// first (a mapped file cannot be unlinked on Windows).
pub fn running_model() -> Option<String> {
    match status() {
        Status::Ready { model_id } | Status::Starting { model_id } => Some(model_id),
        _ => None,
    }
}

async fn stop_locked(guard: &mut Option<Arc<ExecEngine>>) {
    let Some(engine) = guard.take() else { return };
    engine.alive.store(false, Ordering::SeqCst);
    if let Ok(mut child) = engine.child.lock() {
        let _ = child.start_kill();
    }
    clear_pidfile();
}

impl ExecEngine {
    async fn spawn(entry: &ExecModelSpec, model_path: PathBuf, launch: Launch) -> Result<Self, String> {
        let binary = engine::locate()?;
        let port = engine::free_port()?;

        let mut command = crate::proc::command(&binary);
        command
            .arg("-m")
            .arg(&model_path)
            // Loopback only, for the reason the completion engine gives: no authentication, and the
            // prompts are the user's source.
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("-c")
            .arg(launch.ctx.to_string())
            // One slot, so the whole context belongs to the one request in flight. With the default
            // (`-1`, automatic) llama-server may split the context between several slots, and the
            // budget every task was cut to would silently stop being true.
            .arg("-np")
            .arg("1")
            // No `-ngl`. llama.cpp's `--fit` (on by default) places as many layers as the GPU's free
            // memory holds and keeps the rest on the CPU — mixture experts first — but only for
            // the arguments left unset: given `-ngl 99`, b10587 gives up the moment a model does
            // not fit ("n_gpu_layers already set by user to 99, abort") and puts every layer on the
            // GPU anyway, which on a card smaller than the model fails to allocate or pages VRAM
            // through system memory. Measured on an M4 with the 7B: unset, it still offloads 29/29
            // layers when they fit (fitting took 0.11 s); with 9 GB held back, 18/29, the rest on
            // the CPU.
            .arg("--no-webui");
        if launch.no_reasoning {
            command.arg("--reasoning-budget").arg("0");
        }
        let mut child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("CodeFlow couldn't start its local model ({}): {e}", binary.display()))?;

        let diagnostics: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        if let Some(stderr) = child.stderr.take() {
            engine::collect_diagnostics(stderr, diagnostics.clone());
        }
        write_pidfile(child.id(), port);

        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| format!("Couldn't create the local model HTTP client: {e}"))?;

        let engine = Self {
            launch,
            port,
            client,
            child: Mutex::new(child),
            alive: Arc::new(AtomicBool::new(true)),
            last_used: Arc::new(AtomicU64::new(engine::now_millis())),
            in_flight: Arc::new(AtomicUsize::new(0)),
            diagnostics,
        };
        engine.await_ready(entry).await?;
        Ok(engine)
    }

    async fn await_ready(&self, entry: &ExecModelSpec) -> Result<(), String> {
        let url = format!("{}/health", self.base_url());
        let deadline = std::time::Instant::now() + START_BUDGET;
        while std::time::Instant::now() < deadline {
            if let Ok(mut child) = self.child.lock() {
                if let Ok(Some(exit)) = child.try_wait() {
                    self.alive.store(false, Ordering::SeqCst);
                    return Err(format!(
                        "The local model stopped immediately ({exit}). {}",
                        self.diagnostic_tail()
                    ));
                }
            }
            if let Ok(response) = self.client.get(&url).timeout(Duration::from_secs(2)).send().await {
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
            entry.spec.label,
            START_BUDGET.as_secs(),
            self.diagnostic_tail()
        ))
    }

    fn diagnostic_tail(&self) -> String {
        let Ok(lines) = self.diagnostics.lock() else { return String::new() };
        if lines.is_empty() {
            return String::new();
        }
        format!("It said: {}", lines.join(" / "))
    }
}

/// Retires the executor after [`IDLE_TIMEOUT`] with nothing in flight.
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
                // A request in flight is never idle, however long ago it started.
                Some(engine) if engine.in_flight.load(Ordering::SeqCst) > 0 => continue,
                Some(engine) => engine::now_millis().saturating_sub(engine.last_used.load(Ordering::Relaxed)),
            };
            if idle >= IDLE_TIMEOUT.as_millis() as u64 {
                stop_locked(&mut guard).await;
                set_status(Status::Off);
            }
        }
    });
}

fn pidfile() -> PathBuf {
    crate::paths::state_dir().join(".llama-exec.pid")
}

fn write_pidfile(pid: Option<u32>, port: u16) {
    let Some(pid) = pid else { return };
    let _ = std::fs::write(pidfile(), format!("{pid}\n{port}\n"));
}

fn clear_pidfile() {
    let _ = std::fs::remove_file(pidfile());
}

/// Kills an executor left behind by a previous run of the app. Called once at startup, beside the
/// completion engine's own sweep.
pub fn sweep_stale() {
    engine::sweep_pidfile(pidfile());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launches_compare_by_every_field_that_needs_a_new_process() {
        let a = Launch { model_id: "m".into(), ctx: 16_384, no_reasoning: true };
        assert_eq!(a, a.clone());
        assert_ne!(a, Launch { ctx: 32_768, ..a.clone() });
        assert_ne!(a, Launch { model_id: "other".into(), ..a.clone() });
        assert_ne!(a, Launch { no_reasoning: false, ..a.clone() });
    }

    #[test]
    fn in_flight_guards_count_and_stamp_on_release() {
        let count = Arc::new(AtomicUsize::new(1));
        let last_used = Arc::new(AtomicU64::new(0));
        drop(InFlight { count: count.clone(), last_used: last_used.clone() });
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(last_used.load(Ordering::Relaxed) > 0, "the idle clock starts when the request ends");
    }

    #[tokio::test]
    async fn a_missing_model_file_is_refused_before_anything_spawns() {
        let entry = super::super::exec_catalogue::find("qwen2.5-coder-7b-instruct").unwrap();
        let launch = Launch { model_id: entry.spec.id.into(), ctx: 8_192, no_reasoning: true };
        let error = ensure_ready(entry, PathBuf::from("/nonexistent/model.gguf"), launch)
            .await
            .err()
            .expect("must refuse");
        assert!(error.contains("isn't downloaded"), "{error}");
    }
}
