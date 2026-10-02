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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

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

/// How long a stopped run is given to exit on its own before it is killed outright.
///
/// Long enough for a Node CLI to flush its session file and shut its MCP servers down, short enough
/// that Stop still reads as immediate — this is a button somebody just pressed, and a spinner that
/// lingers for a second and a half is the longest anyone reads as "working on it".
#[cfg(unix)]
const TERM_GRACE: Duration = Duration::from_millis(1_500);

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
    /// The engine's stable provider id — `"claude"`, `"gemini"`, `"codex"`… Sent beside the label
    /// rather than instead of it because the two are for different readers: the label is the word a
    /// person sees, and this is what the frontend keys its brand mark off. Deriving one from the
    /// other would mean matching on a string that [`AiEngine::label`] is explicitly allowed to
    /// rename.
    provider: String,
    /// The engine's display name — "Claude", "Codex", "Cline"…
    engine: String,
    /// The model id this run forces. Empty when nothing was configured and the CLI picks its own
    /// default, which is a real state and shows as the engine alone rather than as a guess.
    model: String,
    /// How much silence the watchdog allows this run before stopping it, in seconds — `None` when
    /// the watchdog is off. The card counts down to it, so a quiet run says when it will end by
    /// itself instead of leaving the user to guess. While a sub-agent is open the allowance is
    /// [`SUBAGENT_IDLE_FACTOR`] times this; the frontend mirrors that.
    idle_limit_secs: Option<u64>,
}

/// "That run is over." See the emit at the end of [`scoped_with_trace`] for why this exists at all
/// when every desktop caller already knows.
#[derive(Clone, Serialize)]
struct AiDoneEvent {
    run_id: String,
}

/// One chunk of a reply as it is being written, on its way to the bubble that is painting it.
///
/// Serialized in camelCase because this is the one event here whose consumer is a *component*
/// rather than the run store: `conversationStore` routes a chunk straight into the message it
/// belongs to, and every other field it handles is camelCase. The rest of this module's events
/// predate that and are read by code that already spells them the other way.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChatDeltaEvent {
    run_id: String,
    conversation_id: String,
    message_id: String,
    /// `"text"` or `"thinking"` — see [`crate::ai::AiDeltaKind`], which is what produces it.
    kind: String,
    text: String,
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
pub fn emit_engine(ctx: &RunCtx, provider: &str, engine: &str, model: &str, idle_limit: Option<Duration>) {
    let _ = ctx.app.emit(
        "ai:engine",
        AiEngineEvent {
            run_id: ctx.run_id.clone(),
            provider: provider.to_string(),
            engine: engine.to_string(),
            model: model.to_string(),
            idle_limit_secs: idle_limit.map(|limit| limit.as_secs()),
        },
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

/// One chunk of a reply as it is being written. **Deliberately not routed through
/// [`emit_line`]**, and this is the single most important thing about this function.
///
/// `emit_line` records into a 300-entry ring ([`MAX_TRACE_LINES`], `trace.pop_front()`) that is
/// persisted as the turn's trace: what the agent read, which tools it called, how it got to the
/// answer. A turn run with `--include-partial-messages` emits one frame *per token*, so sending
/// deltas through that path would leave every stored trace holding the last three hundred word
/// fragments of the reply and nothing else — every tool call evicted by the text of the answer the
/// trace sits next to. The reply is already stored, in full, as the message itself.
///
/// It also skips the 100ms batch. The batch exists because the run log is a list nobody reads at
/// sixty renders a second; a chunk here is a character appearing in a sentence somebody is
/// watching, and holding it back for a tenth of a second is exactly the stutter the batch was
/// built to remove from the other stream. The volume is the same either way — this is what the
/// process is already producing — but the destination is a single `useState` write, not a list.
///
/// Fire-and-forget like everything else here: a chunk that fails to emit costs this reply its
/// typing, not its answer, which still arrives whole when the run returns.
///
/// **Not forwarded to a paired phone.** `remotectl::bridge` documents why `ai:output` was dropped
/// in favour of the batch — per-line traffic over a phone's wifi is worse than on the desktop —
/// and token granularity is that argument again, an order of magnitude further along. It is not in
/// `FORWARDED` and must not be added to it.
pub fn emit_delta(ctx: &RunCtx, conversation_id: &str, message_id: &str, kind: &str, text: &str) {
    let _ = ctx.app.emit(
        "ai:chat-delta",
        AiChatDeltaEvent {
            run_id: ctx.run_id.clone(),
            conversation_id: conversation_id.to_string(),
            message_id: message_id.to_string(),
            kind: kind.to_string(),
            text: text.to_string(),
        },
    );
}

/// Stops a run's process **and everything it started**.
///
/// `Child::kill` sends SIGKILL to exactly one process. That was this whole function on Unix, and it
/// is why Stop appeared to do nothing on a run that had been going for a while: every engine here
/// is a Node CLI that spawns children of its own — MCP servers, ripgrep, subagent processes — and a
/// run that has just started has none of them yet while one twenty minutes in has a tree. Killing
/// the root reparented the rest to init, where they carried on working and burning tokens with
/// nothing on screen left to say so.
///
/// So the group is signalled rather than the process. `proc::own_process_group` is the other half:
/// the child is spawned as its own group leader, which makes its pid the group id and makes this
/// safe — a group signal cannot reach back into CodeFlow's own group.
///
/// **SIGTERM, a moment, then SIGKILL.** These CLIs flush a session file and release their MCP
/// servers on SIGTERM, and a run stopped with SIGKILL alone can leave a half-written transcript
/// behind. The grace period is short because Stop is a button somebody just pressed: anything still
/// alive after it gets no further say.
///
/// Windows keeps `taskkill /T /F`, which walks the tree from a pid by itself.
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

    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The pid *is* the group id — see `proc::own_process_group`. A negative pid is how every
        // Unix names a process group.
        let group = -(pid as i32);
        // SAFETY: `kill` is async-signal-safe and takes only integers. A group that has already
        // exited answers `ESRCH`, which is why the result is discarded rather than checked: this is
        // "make sure it is gone", not "report whether it was there".
        unsafe { libc::kill(group, libc::SIGTERM) };
        // Given a chance to leave cleanly, and no more than that.
        if tokio::time::timeout(TERM_GRACE, child.wait()).await.is_ok() {
            // The root is gone, but a descendant that ignored SIGTERM would still be running: the
            // group signal below is what closes that off, and it costs nothing when the group is
            // already empty.
            unsafe { libc::kill(group, libc::SIGKILL) };
            return;
        }
        unsafe { libc::kill(group, libc::SIGKILL) };
    }

    let _ = child.kill().await;
}

// ---------- every AI process, for the moment the app quits ----------
//
// `kill_tree` stops one run whose `Child` somebody is holding. Quitting has to stop all of them and
// holds none — each `Child` lives inside the `ai::spawn_once` that started it — and quitting ends
// in `std::process::exit`, which runs no destructor. So a CLI the quit does not stop by hand is not
// stopped at all, and it is not even in CodeFlow's process group to die with it: it was spawned
// into its own (that is what makes Stop work), so it is reparented to init and carries on editing
// the repository with nothing on screen to say so. The next launch then finds its chain step
// marked interrupted and offers to run it again — into a working copy that engine is still
// writing to.

/// Every AI CLI this process started and has not yet seen exit: pid → the run it belongs to.
fn live() -> &'static Mutex<HashMap<u32, Option<String>>> {
    static LIVE: OnceLock<Mutex<HashMap<u32, Option<String>>>> = OnceLock::new();
    LIVE.get_or_init(Mutex::default)
}

/// Set once the app has begun to quit, and never cleared: nothing starts after that point.
static STOPPING: AtomicBool = AtomicBool::new(false);

/// A process on the list above, for as long as this guard lives — `ai::spawn_once` holds one from
/// the moment its child exists until the child is gone, by every route out.
pub(crate) struct LiveProcess(u32);

impl Drop for LiveProcess {
    fn drop(&mut self) {
        if let Ok(mut live) = live().lock() {
            live.remove(&self.0);
        }
    }
}

/// Puts a freshly spawned CLI on the quit path's list.
pub(crate) fn register_process(pid: u32, run_id: Option<&str>) -> LiveProcess {
    if let Ok(mut live) = live().lock() {
        live.insert(pid, run_id.map(str::to_string));
    }
    LiveProcess(pid)
}

/// Whether the app is quitting. A run that ends while this is set ended *because* of it — a
/// cancellation, not a failure — and a run about to start must not.
pub fn stopping() -> bool {
    STOPPING.load(Ordering::SeqCst)
}

/// Stops every AI run and every process each of them started. The quit path, callable from
/// anywhere; **blocks** for at most about `grace`.
///
/// In three steps, each for a reason:
///
/// 1. **The runs are cancelled** through the same channel Stop uses, so each ends as a
///    cancellation. A CLI that merely died under a signal reads as a crash, and a chat or a chain
///    step would file "claude exited with an error (signal: 15)" as the turn's answer — the next
///    launch would then show a failed step, where the truth is "the app closed mid-step", which is
///    what `queries::recover_after_restart` records for a step whose turn never landed.
/// 2. **Every live process group gets SIGTERM directly**, tracked run or not: a commit message is
///    generated with no run id, and a task scheduled on a busy runtime might not reach its own
///    `kill_tree` before the process exits. Windows gets `taskkill /T /F`, which walks the tree.
/// 3. **Whatever is still alive when `grace` runs out gets SIGKILL.** This is a quit; nothing
///    gets a longer say than that.
///
/// Returns the ids of the tracked runs that were in flight, for the caller to record.
pub fn stop_all(grace: Duration) -> Vec<String> {
    STOPPING.store(true, Ordering::SeqCst);
    stop_everything(grace)
}

/// [`stop_all`] without raising the quitting flag — the part that does the stopping, kept apart so
/// a test can exercise it without telling the rest of the process it is quitting.
fn stop_everything(grace: Duration) -> Vec<String> {
    let runs: Vec<String> = registry().lock().map(|map| map.keys().cloned().collect()).unwrap_or_default();
    for run_id in &runs {
        cancel(run_id);
    }

    let pids = || -> Vec<u32> { live().lock().map(|live| live.keys().copied().collect()).unwrap_or_default() };
    for pid in pids() {
        terminate(pid);
    }

    // Polled rather than awaited: this runs on the main thread in the middle of `RunEvent::Exit`,
    // and the runtime that would wake an await is the one whose workers are reaping these very
    // children. An entry leaves the list when its `spawn_once` has seen the child exit.
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && !pids().is_empty() {
        std::thread::sleep(Duration::from_millis(25));
    }

    #[cfg(unix)]
    for pid in pids() {
        // SAFETY: `kill` takes only integers; a group that has already gone answers `ESRCH`.
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
    runs
}

/// Asks one process group to end — the quit path's step 2.
fn terminate(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: as above. The pid is the group id — see `proc::own_process_group`.
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
    }
    #[cfg(windows)]
    {
        let _ = crate::proc::std_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

// ---------- the watchdog ----------
//
// A run used to wait for exactly two things: its process exiting, or Stop. A CLI that hangs — a
// stalled network read, an MCP server that never answers, a prompt nobody can see — gives neither,
// and it holds its repository's lease (see `ai_locks`) the whole time: every other engine is told
// that working copy is busy, for ever, and the only cure was quitting the app. So a run that prints
// nothing on either stream for long enough is taken to be hung and stopped, which ends the command
// holding the lease and releases it.

/// The `app_settings` key holding the limit, in whole minutes. `0` turns the watchdog off.
pub const IDLE_TIMEOUT_KEY: &str = "ai_idle_timeout_minutes";

/// What an unset or unreadable setting means. Generous on purpose: an agentic turn prints a line
/// per step, so twenty silent minutes is not a model thinking hard, it is a process nobody is
/// driving any more.
pub const DEFAULT_IDLE_MINUTES: u64 = 20;

/// The most the setting is taken to mean, whatever was typed: a day. Past that "never" is what was
/// meant, and `0` already says it.
const MAX_IDLE_MINUTES: u64 = 24 * 60;

/// The limit the setting's raw value asks for; `None` is "no watchdog".
///
/// Unset, blank or unparseable falls back to the default rather than to "off": a watchdog that a
/// typo quietly disabled would be missed exactly on the day a run hangs.
pub fn idle_limit_from(raw: Option<&str>) -> Option<Duration> {
    let minutes = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_IDLE_MINUTES);
    (minutes > 0).then(|| Duration::from_secs(minutes.min(MAX_IDLE_MINUTES) * 60))
}

/// The configured limit, read fresh for every run so a change in Settings applies to the next one.
pub fn idle_limit() -> Option<Duration> {
    idle_limit_from(crate::ai_usage::setting(IDLE_TIMEOUT_KEY).as_deref())
}

/// How many times the usual silence a run is allowed while one of its sub-agents is working.
///
/// Claude Code runs a `Task` sub-agent in the background and the parent's stream says nothing until
/// that sub-agent finishes a step — a long step, a long tool, or simply the wait for it to end. That
/// silence is the run working, not hanging: the watchdog stopped such runs for being quiet. Three
/// times, not forever, the same allowance [`crate::ai::AiEngine::quiet_while_working`] gets: a
/// sub-agent can hang too. Mirrored by `SUBAGENT_IDLE_FACTOR` in `AiRunLog.tsx`.
pub const SUBAGENT_IDLE_FACTOR: u32 = 3;

/// When a run last printed anything, on either stream — and which of its sub-agents are still out.
/// Cheap to clone and to touch: the pumps touch it on every read.
#[derive(Clone)]
pub struct Activity {
    started: Instant,
    /// Milliseconds after `started` of the last output.
    last_ms: Arc<AtomicU64>,
    /// Sub-agents the run started and has not heard back from, by the CLI's task id.
    subagents: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

impl Activity {
    pub fn new() -> Self {
        Activity { started: Instant::now(), last_ms: Arc::new(AtomicU64::new(0)), subagents: Arc::default() }
    }

    pub fn subagent_started(&self, task_id: &str) {
        if let Ok(mut open) = self.subagents.lock() {
            open.insert(task_id.to_string());
        }
    }

    pub fn subagent_ended(&self, task_id: &str) {
        if let Ok(mut open) = self.subagents.lock() {
            open.remove(task_id);
        }
    }

    /// Whether a sub-agent of this run is still working.
    pub fn subagents_open(&self) -> bool {
        self.subagents.lock().map(|open| !open.is_empty()).unwrap_or(false)
    }

    pub fn touch(&self) {
        self.last_ms.store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    /// How long the run has been silent. From its start, if it has never said anything.
    pub fn quiet_for(&self) -> Duration {
        self.started.elapsed().saturating_sub(Duration::from_millis(self.last_ms.load(Ordering::Relaxed)))
    }
}

impl Default for Activity {
    fn default() -> Self {
        Self::new()
    }
}

/// How much more silence `limit` allows after `quiet_for` of it — `None` once it is used up.
pub fn idle_remaining(limit: Duration, quiet_for: Duration) -> Option<Duration> {
    limit.checked_sub(quiet_for).filter(|left| !left.is_zero())
}

/// Resolves, with the limit that was reached, once the run has been silent for `limit`. With no
/// limit it never resolves — which is what a `select!` arm for a switched-off watchdog wants.
///
/// A sleep to the deadline and a re-check, rather than a tick: a chatty run moves the deadline on
/// every line, and waking once per deadline costs one timer however much it prints.
pub async fn gone_quiet(activity: &Activity, limit: Option<Duration>) -> Duration {
    let Some(limit) = limit else { return std::future::pending().await };
    loop {
        // Re-read each time round: a sub-agent opening or ending moves the deadline both ways.
        let allowed = if activity.subagents_open() { limit * SUBAGENT_IDLE_FACTOR } else { limit };
        match idle_remaining(allowed, activity.quiet_for()) {
            None => return allowed,
            // Capped, so a sub-agent that ends while this sleeps toward its longer deadline is
            // noticed within half a minute rather than at that deadline.
            Some(left) => tokio::time::sleep(left.min(Duration::from_secs(30))).await,
        }
    }
}

/// What a run the watchdog stopped ends with — said in the app's language, because this string is
/// shown as it is: in a chat bubble, under a job, in a chain step's error.
///
/// Read from the setting the way `tray.rs` reads it, and for the same reason: there is no `useT`
/// on this side. It names the remedy, because the cause is not something the user can see.
pub fn idle_error(engine: &str, limit: Duration) -> String {
    let spanish = crate::ai_usage::setting("app_language").is_some_and(|language| language.starts_with("es"));
    idle_message(engine, limit, spanish)
}

fn idle_message(engine: &str, limit: Duration, spanish: bool) -> String {
    let minutes = (limit.as_secs() / 60).max(1);
    if spanish {
        format!(
            "{engine} no escribió nada en {minutes} min y se detuvo; el repositorio vuelve a estar libre. \
             Vuelve a intentarlo o cambia el límite en Configuración \u{203a} Asistente de IA \u{203a} Proveedores."
        )
    } else {
        format!(
            "{engine} printed nothing for {minutes} min and was stopped, so its repository is free again. \
             Try again, or change the limit in Settings \u{203a} AI assistant \u{203a} Providers."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unset is the default, `0` is off, a number is minutes — and a typo is the default, never off.
    #[test]
    fn the_setting_reads_as_minutes_with_zero_meaning_off() {
        let default = Some(Duration::from_secs(DEFAULT_IDLE_MINUTES * 60));
        assert_eq!(idle_limit_from(None), default);
        assert_eq!(idle_limit_from(Some("  ")), default);
        assert_eq!(idle_limit_from(Some("veinte")), default, "a typo must not switch the watchdog off");
        assert_eq!(idle_limit_from(Some("-5")), default);
        assert_eq!(idle_limit_from(Some("0")), None);
        assert_eq!(idle_limit_from(Some(" 45 ")), Some(Duration::from_secs(45 * 60)));
        assert_eq!(idle_limit_from(Some("100000")), Some(Duration::from_secs(MAX_IDLE_MINUTES * 60)));
    }

    #[test]
    fn the_deadline_is_measured_from_the_last_output() {
        let limit = Duration::from_secs(60);
        assert_eq!(idle_remaining(limit, Duration::ZERO), Some(limit));
        assert_eq!(idle_remaining(limit, Duration::from_secs(45)), Some(Duration::from_secs(15)));
        assert_eq!(idle_remaining(limit, limit), None, "exactly the limit is over it");
        assert_eq!(idle_remaining(limit, Duration::from_secs(90)), None);
    }

    /// Output moves the deadline: a run that keeps printing is never taken for a hung one.
    #[test]
    fn printing_resets_the_silence() {
        let activity = Activity::new();
        std::thread::sleep(Duration::from_millis(30));
        assert!(activity.quiet_for() >= Duration::from_millis(30));
        activity.touch();
        assert!(activity.quiet_for() < Duration::from_millis(30));
    }

    #[tokio::test]
    async fn a_silent_run_is_caught_and_a_switched_off_watchdog_never_fires() {
        let activity = Activity::new();
        let limit = Duration::from_millis(40);
        let fired = tokio::time::timeout(Duration::from_secs(5), gone_quiet(&activity, Some(limit))).await;
        assert_eq!(fired.ok(), Some(limit));

        let off = tokio::time::timeout(Duration::from_millis(80), gone_quiet(&activity, None)).await;
        assert!(off.is_err(), "no limit means no deadline");
    }

    #[test]
    fn the_message_names_the_engine_the_limit_and_the_remedy() {
        let en = idle_message("Claude Code", Duration::from_secs(20 * 60), false);
        assert!(en.contains("Claude Code") && en.contains("20 min") && en.contains("Providers"), "{en}");
        let es = idle_message("Gemini", Duration::from_secs(60 * 60), true);
        assert!(es.contains("Gemini") && es.contains("60 min") && es.contains("Proveedores"), "{es}");
    }

    /// The two tests below share the process-wide list, and one of them signals everything on it.
    #[cfg(unix)]
    static LIST: Mutex<()> = Mutex::new(());

    /// A real process in a group of its own — never a made-up pid: `stop_all` signals the *group*
    /// a pid names, and an invented number can name somebody else's.
    #[cfg(unix)]
    fn own_group(script: &str) -> std::process::Child {
        use std::os::unix::process::CommandExt;
        std::process::Command::new("sh")
            .args(["-c", script])
            .process_group(0)
            .spawn()
            .expect("sh is on every unix")
    }

    /// The quit path's list: on while the guard lives, off by every route out.
    #[cfg(unix)]
    #[test]
    fn a_registered_process_leaves_the_list_with_its_guard() {
        let _serial = LIST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut child = own_group("exit 0");
        let pid = child.id();
        let guard = register_process(pid, Some("run-live-test"));
        assert_eq!(live().lock().unwrap().get(&pid).cloned(), Some(Some("run-live-test".to_string())));
        drop(guard);
        assert!(!live().lock().unwrap().contains_key(&pid));
        let _ = child.wait();
    }

    /// Quitting leaves no AI CLI running: a real process tree, stopped from the list alone — no
    /// `Child` handle, no runtime — along with the grandchild it started.
    #[cfg(unix)]
    #[test]
    fn stop_all_takes_down_a_whole_process_group() {
        let _serial = LIST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // `sh` starts a `sleep` of its own: exactly the descendant a plain kill of one pid misses.
        let mut child = own_group("sleep 30 & wait");
        let pid = child.id();
        let guard = register_process(pid, None);

        // Not `stop_all` itself: that also raises the quitting flag, which would make every run
        // in the rest of this test binary refuse to start.
        let _ = stop_everything(Duration::from_millis(300));

        let status = child.wait().expect("reaped");
        assert!(!status.success(), "it was stopped, not left to finish: {status:?}");
        drop(guard);
        // The group empties once the orphaned `sleep` has been reaped by init, which is not
        // instant — so the probe is given a moment rather than asked once.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            // SAFETY: signal 0 sends nothing; it only asks whether the group still exists.
            let alive = unsafe { libc::kill(-(pid as i32), 0) } == 0;
            if !alive {
                break;
            }
            assert!(Instant::now() < deadline, "a descendant outlived the stop");
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
