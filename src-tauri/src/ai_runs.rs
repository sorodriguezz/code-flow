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

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

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

#[derive(Clone)]
pub struct RunCtx {
    pub app: AppHandle,
    pub run_id: String,
    /// Everything emitted for this run, so a finished turn can still show how it got there.
    /// Shared because the pumps that fill it run in their own tasks.
    trace: Arc<Mutex<Vec<TraceLine>>>,
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

#[derive(Clone, Serialize)]
struct AiOutputEvent {
    run_id: String,
    /// `"stdout"` or `"stderr"` — the UI dims the latter, since most CLIs use it for progress
    /// chatter rather than for failures.
    stream: &'static str,
    line: String,
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
    let trace = Arc::new(Mutex::new(Vec::new()));
    let ctx = RunCtx { app, run_id: run_id.clone(), trace: Arc::clone(&trace) };
    let output = CURRENT.scope(ctx, fut).await;
    if let Ok(mut map) = registry().lock() {
        map.remove(&run_id);
    }
    let collected = trace.lock().map(|t| t.clone()).unwrap_or_default();
    (output, collected)
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

/// Pushes one line of a run's output to the frontend. Blank lines are dropped — the CLIs pad
/// their output generously and the log reads better without the gaps.
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
            trace.remove(0);
        }
        trace.push(TraceLine { stream, line: line.clone() });
    }
    let _ = ctx.app.emit("ai:output", AiOutputEvent { run_id: ctx.run_id.clone(), stream, line });
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
        let killed = tokio::process::Command::new("taskkill")
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
