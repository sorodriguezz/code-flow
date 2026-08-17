//! Live output and cancellation for AI runs.
//!
//! Every AI feature funnels through [`crate::ai::run`], which used to spawn its CLI and block
//! until the process exited: no output until the end, and no way to stop it. This module is what
//! makes a run observable and interruptible without threading an extra parameter through the
//! dozen operation signatures in `ai.rs` — the command layer wraps its call in [`scoped`], and
//! the plumbing deep inside picks the context up from a task-local.
//!
//! The `run_id` is minted by the frontend *before* it invokes, so it can subscribe to this run's
//! output and hold a cancel handle for it while the command is still in flight. For the flows
//! that already carry a job id (PR review, change analysis) that id doubles as the run id, which
//! is what lets the job list show live output for the row it already renders.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

/// Prefix on the error of a run the user stopped, so the frontend can render "cancelled" instead
/// of a red failure banner. Mirrors [`crate::ai::QUOTA_MARKER`]'s role for quota refusals.
pub const CANCELLED_MARKER: &str = "RUN_CANCELLED::";

/// A single emitted line is capped before it crosses the IPC boundary: a CLI that draws a
/// progress bar can produce megabytes on one "line", and the UI only ever shows a tail anyway.
const MAX_LINE_CHARS: usize = 2_000;

/// How many lines of a run are kept for its stored trace. Enough to reconstruct what an agent
/// did, bounded so one chatty run can't bloat the database — the oldest lines are dropped first,
/// since the tail is what explains how a turn ended up where it did.
const MAX_TRACE_LINES: usize = 300;

/// How long a batch of output waits before it goes out as one event.
///
/// A busy agentic turn under `--output-format stream-json --verbose` produces 20-60 lines a
/// second, and one IPC message + one JS callback + one React render *per line* is what makes the
/// window stutter while an agent is thinking. 100ms is the deliberate middle: fast enough that the
/// log still reads as live streaming (ten repaints a second is past what the eye reads as
/// continuous), slow enough that a burst collapses into a single render instead of sixty.
const BATCH_INTERVAL: Duration = Duration::from_millis(100);

/// A batch that reaches this many lines goes out immediately rather than waiting for the tick, so
/// a firehose never builds a queue the user is waiting behind.
const BATCH_MAX_LINES: usize = 32;

#[derive(Clone)]
pub struct RunCtx {
    pub app: AppHandle,
    pub run_id: String,
    /// Everything emitted for this run, so a finished turn can still show how it got there.
    /// Shared because the pumps that fill it run in their own tasks.
    ///
    /// A `VecDeque` and not a `Vec` for one reason: the cap is enforced on every single line, and
    /// dropping the oldest of 300 elements out of a `Vec` memmoves the other 299 each time. Serde
    /// writes a `VecDeque` as the same JSON array, so the stored trace is byte-identical.
    trace: Arc<Mutex<VecDeque<TraceLine>>>,
    /// Lines emitted since the last batch went out. See [`flush_batch`].
    batch: Arc<Mutex<Vec<TraceLine>>>,
}

/// One recorded line of a run, in the shape the frontend already renders.
#[derive(Clone, Serialize)]
pub struct TraceLine {
    pub stream: &'static str,
    pub line: String,
}

tokio::task_local! {
    static CURRENT: RunCtx;
}

/// A run's output, several lines at a time — the only output event there is.
///
/// It replaced a per-line `ai:output`, which cost one IPC message, one JS callback and one React
/// render *per line* of a stream that runs at 20-60 lines a second. The two were emitted side by
/// side for exactly as long as it took `aiRunStore` to switch over; the per-line one is gone now
/// that nothing listens for it, and the run log costs one render per 100ms instead of one per line.
/// Same lines, same order — see [`flush_batch`] for how the order is held under a racing flush, and
/// [`Ticker`] for why the tail can never arrive after the run's completion.
#[derive(Clone, Serialize)]
struct AiOutputBatchEvent {
    run_id: String,
    /// In arrival order, oldest first. Never empty — an empty batch is simply not emitted.
    lines: Vec<TraceLine>,
}

/// Which engine and model a run is actually about to use, announced the moment it starts.
///
/// The UI can't work this out on its own: the provider and model are resolved per *task* (review,
/// fix, chat…) from routing overrides the panel showing the run doesn't read, and "working…" with
/// no name on it is the one question every user asks of a run that is taking a while.
#[derive(Clone, Serialize)]
struct AiEngineEvent {
    run_id: String,
    /// The engine's display name — "Claude", "Codex", "Cline"…
    engine: String,
    /// The model id this run forces. Empty when nothing was configured and the CLI picks its own
    /// default, which is a real state and shows as the engine alone rather than as a guess.
    model: String,
}

/// "That run is over." See the emit at the end of [`scoped_with_trace`] for why this exists at all
/// when every desktop caller already knows.
#[derive(Clone, Serialize)]
struct AiDoneEvent {
    run_id: String,
}

type Registry = Mutex<HashMap<String, watch::Sender<bool>>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

/// Runs `fut` as an identified, cancellable AI run. A `None` id means "not tracked" — the future
/// runs exactly as before, with no events and no cancel handle, which is what keeps the internal
/// auxiliary calls (model listing, provider probes) out of the UI's run list.
pub async fn scoped<F: Future>(app: AppHandle, run_id: Option<String>, fut: F) -> F::Output {
    scoped_with_trace(app, run_id, fut).await.0
}

/// [`scoped`], plus the run's recorded output. Callers that persist a turn (the chat) use this;
/// everyone else takes [`scoped`] and lets the trace be dropped with the run.
pub async fn scoped_with_trace<F: Future>(
    app: AppHandle,
    run_id: Option<String>,
    fut: F,
) -> (F::Output, Vec<TraceLine>) {
    let Some(run_id) = run_id.filter(|id| !id.trim().is_empty()) else {
        return (fut.await, Vec::new());
    };
    // Registered here rather than at spawn time so a cancel that arrives during the (potentially
    // slow) DB reads and diff building before the process even starts is still observed.
    let (tx, _) = watch::channel(false);
    if let Ok(mut map) = registry().lock() {
        map.insert(run_id.clone(), tx);
    }
    let trace = Arc::new(Mutex::new(VecDeque::new()));
    // Kept aside because `app` is about to move into the `RunCtx`, and the completion event below
    // is emitted after that context has been dropped along with the ticker.
    let app_for_done = app.clone();
    let ctx = RunCtx {
        app,
        run_id: run_id.clone(),
        trace: Arc::clone(&trace),
        batch: Arc::new(Mutex::new(Vec::new())),
    };
    // The heartbeat that makes a batch feel live: without it a run that goes quiet after twenty
    // lines would sit on them until it produced thirty-two more. `Delay` and not the default
    // burst behaviour, because a tick missed while the machine was busy must not turn into two
    // flushes back to back — there is nothing to catch up on, only the current batch to send.
    let ticker = Ticker(
        {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(BATCH_INTERVAL);
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tick.tick().await;
                    flush_batch(&ctx);
                }
            })
        },
        ctx.clone(),
    );
    let output = CURRENT.scope(ctx.clone(), fut).await;
    // Dropped here by hand rather than at the end of the scope, because dropping it is what sends
    // the last partial batch (see [`Ticker`]) and that has to happen before this function returns:
    // the caller emits its "this run is done" event the moment it gets control back, and the tail
    // of a run must never arrive after the signal that the run is over.
    drop(ticker);
    if let Ok(mut map) = registry().lock() {
        map.remove(&run_id);
    }
    // "This run is over", said by the run itself.
    //
    // Every desktop caller already knows this — its `invoke` promise resolves — which is why there
    // was no event here. A run started from a *paired phone* has no such promise on this machine:
    // the desktop sees `ai:engine`, shows an agent working, and would then have nothing to tell it
    // the work had finished. The row would sit in the running-agents panel forever.
    //
    // Emitted after `drop(ticker)` on purpose, and the ordering is the whole point: dropping the
    // ticker is what flushes the last partial batch, so the tail of the output is already on the
    // wire before anything says the run is done. A listener can therefore treat this as final.
    let _ = app_for_done.emit("ai:done", AiDoneEvent { run_id: run_id.clone() });
    let collected = trace.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default();
    (output, collected)
}

/// The batch ticker, plus the promise that whatever it was holding still goes out.
///
/// A guard and not two plain statements after the await, because there is a third way a run can
/// end: the whole future being dropped — a command cancelled out from under us, or the app shutting
/// down mid-run. That path never reaches any line written after the await, and without this it
/// would leak a task ticking every 100ms forever, holding an `AppHandle`, and swallow the last few
/// lines of the run with it. `abort` before the flush is safe in either order: it only takes effect
/// at an await point, and [`flush_batch`] has none.
struct Ticker(tokio::task::JoinHandle<()>, RunCtx);

impl Drop for Ticker {
    fn drop(&mut self) {
        self.0.abort();
        flush_batch(&self.1);
    }
}

/// Sends whatever has accumulated since the last batch, as one event. A no-op when nothing has.
///
/// The take and the emit happen under the same lock on purpose. Two flushes can race — the ticker
/// against a batch that just hit [`BATCH_MAX_LINES`] — and if one took its half and were then
/// preempted before emitting, the other's half would reach the frontend first and the run log
/// would read scrambled. Nothing parks under this lock: `emit` serializes and posts, it never
/// awaits.
fn flush_batch(ctx: &RunCtx) {
    let Ok(mut batch) = ctx.batch.lock() else { return };
    if batch.is_empty() {
        return;
    }
    let lines = std::mem::take(&mut *batch);
    let _ = ctx
        .app
        .emit("ai:output-batch", AiOutputBatchEvent { run_id: ctx.run_id.clone(), lines });
}

/// The run the current task belongs to, if it was started through [`scoped`].
pub fn current() -> Option<RunCtx> {
    CURRENT.try_with(|ctx| ctx.clone()).ok()
}

/// A receiver that flips to `true` when this run is cancelled. `None` when the run isn't tracked
/// (or already finished), in which case callers should never cancel.
pub fn subscribe(run_id: &str) -> Option<watch::Receiver<bool>> {
    registry().lock().ok()?.get(run_id).map(watch::Sender::subscribe)
}

/// Every run that is registered right now, by id.
///
/// The registry is the authority on "is this still going": a run is inserted before its process
/// starts and removed in [`scoped_with_trace`] before `ai:done` is emitted, so anything absent here
/// has finished, whatever a listener that missed the event believes.
///
/// That is what this is for. A phone tails runs from the frames it receives, and a phone whose
/// screen was locked when a run ended never received `ai:done` — the card sat there spinning, with
/// a stop button wired to a run that no longer exists. Asking for the live set on reconnect is the
/// only way to settle it, and it costs one lock and a handful of strings.
pub fn active() -> Vec<String> {
    registry()
        .lock()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

/// Signals cancellation. `false` means there was no such live run — already finished, or the id
/// never existed.
pub fn cancel(run_id: &str) -> bool {
    let Ok(map) = registry().lock() else { return false };
    match map.get(run_id) {
        Some(tx) => tx.send(true).is_ok(),
        None => false,
    }
}

/// Resolves once the run is cancelled. A run with no cancel channel waits forever, which is
/// exactly what a `select!` arm wants: it simply never wins.
pub async fn cancelled(rx: &mut Option<watch::Receiver<bool>>) {
    match rx {
        Some(rx) => loop {
            if *rx.borrow_and_update() {
                return;
            }
            // The sender is only dropped once the run is over, so a closed channel here means
            // "this can no longer be cancelled" — never "it was".
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        },
        None => std::future::pending().await,
    }
}

/// Announces the engine and model a run is starting with. Fire-and-forget, like every other event
/// here: a run whose banner never arrives still runs, it just shows as "working…" with no name.
pub fn emit_engine(ctx: &RunCtx, engine: &str, model: &str) {
    let _ = ctx.app.emit(
        "ai:engine",
        AiEngineEvent { run_id: ctx.run_id.clone(), engine: engine.to_string(), model: model.to_string() },
    );
}

/// Records one line of a run's output and queues it for the frontend. Blank lines are dropped —
/// the CLIs pad their output generously and the log reads better without the gaps.
pub fn emit_line(ctx: &RunCtx, stream: &'static str, line: &str) {
    let line = line.trim_end();
    if line.is_empty() {
        return;
    }
    let line = if line.chars().count() > MAX_LINE_CHARS {
        format!("{}…", line.chars().take(MAX_LINE_CHARS).collect::<String>())
    } else {
        line.to_string()
    };
    if let Ok(mut trace) = ctx.trace.lock() {
        if trace.len() >= MAX_TRACE_LINES {
            trace.pop_front();
        }
        trace.push_back(TraceLine { stream, line: line.clone() });
    }
    // Queued, not emitted: the line goes out with the next batch — on the 100ms tick, immediately
    // if this one fills the batch, or from the [`Ticker`] guard if the run ends first. This is the
    // only path to the frontend now that `ai:output` is gone, so nothing here may drop a line.
    let full = match ctx.batch.lock() {
        Ok(mut batch) => {
            batch.push(TraceLine { stream, line });
            batch.len() >= BATCH_MAX_LINES
        }
        Err(_) => false,
    };
    if full {
        flush_batch(ctx);
    }
}

/// Kills a spawned CLI *and its children*.
///
/// `child.kill()` only signals the immediate process, which on Windows is usually a `.cmd` shim
/// whose real work happens in a node grandchild — killing the shim there would leave the model
/// call running and billing. `taskkill /T` takes the whole tree; on Unix the CLIs are the process
/// we spawned, so the direct kill is the right one.
pub async fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.id() {
        let killed = crate::proc::command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        if matches!(killed, Ok(status) if status.success()) {
            return;
        }
    }
    let _ = child.kill().await;
}
