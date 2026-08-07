//! What the engines have actually spent, and the rolling windows the status bar reads it back as.
//!
//! **Measured, not predicted.** Every row here is one finished run's own report of its tokens and,
//! where the CLI said so, its cost. Nothing is estimated from a price table and nothing is a
//! provider quota: none of the CLIs this app dispatches to publishes "how much of your plan is
//! left" in a form a program can read, so the honest thing to show is what has been used, over a
//! window, by engine — and to say plainly when an engine reports nothing at all.
//!
//! Recording is fire-and-forget by design. A meter is not worth failing a turn over: if the write
//! fails, the run still succeeded and the bar is merely a little behind.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::ai::AiUsage;
use crate::db::{queries, Db};

/// The handle every recorded run reaches its database through.
///
/// A global rather than a parameter for the same reason `ai_runs` uses a task-local: the recording
/// point is deep inside [`crate::ai::run`], and threading an `AppHandle` down to it would mean an
/// extra argument on every high-level operation in `ai.rs` for something none of them are about.
/// Unlike the task-local, this is set once at startup and therefore also covers the flows that are
/// not wrapped in a run scope — a generated commit message spends tokens like anything else.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Called once from `setup`. A second call is ignored rather than a panic: nothing about a meter
/// justifies taking the app down.
pub fn attach(app: AppHandle) {
    let _ = APP.set(app);
}

/// Files one finished run's usage. Never fails and never blocks the caller.
///
/// `task` is the feature that spent it — one of [`crate::ai::task`]'s constants.
pub fn record(provider: &str, model: &str, task: &str, usage: &AiUsage) {
    if usage.is_empty() {
        return;
    }
    let Some(app) = APP.get() else { return };
    let Ok(db) = app.try_state::<Db>().ok_or(()) else { return };
    let Ok(conn) = db.0.lock() else { return };
    let _ = queries::record_ai_usage(&conn, provider, model, task, usage);
}

/// One engine's consumption over one window.
#[derive(Debug, Clone, Serialize)]
pub struct UsageWindow {
    pub provider: String,
    /// Runs that reported anything in this window. `0` is the honest empty state and is what lets
    /// the bar distinguish "this engine has been idle" from "this engine reports nothing".
    pub runs: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// Summed only over the runs that reported a cost. An engine that never reports one totals
    /// `0.0` here with `costed_runs` at `0`, which the UI shows as "not reported" rather than free.
    pub cost_usd: f64,
    pub costed_runs: i64,
}

/// Both windows at once, plus when the oldest row still kept was written.
#[derive(Debug, Clone, Serialize)]
pub struct UsageSummary {
    /// The last five hours — the shape of a working session, and the same span the CLIs' own
    /// short-term limits are usually cut on.
    pub session: Vec<UsageWindow>,
    /// The last seven days.
    pub week: Vec<UsageWindow>,
    /// RFC 3339, or empty when nothing has ever been recorded.
    pub since: String,
}

/// How long a session window is, in hours.
pub const SESSION_HOURS: i64 = 5;
/// How long the long window is, in days.
pub const WEEK_DAYS: i64 = 7;
/// Rows older than this are swept on every read: a meter that only ever shows two windows has no
/// use for a year of history, and this table is written to on every single AI turn.
pub const KEEP_DAYS: i64 = 30;

// ---------- the statistics view ----------
//
// Everything below is read by one screen and nothing else. It is deliberately computed in SQL
// rather than shipped as raw rows and folded in the frontend: a month of turns is thousands of
// rows, and the answer the screen wants is a few dozen numbers.

/// One engine's slice of a window, plus what it cost per run — the figure that actually separates
/// "I used this a lot" from "this one is expensive".
#[derive(Debug, Clone, Serialize)]
pub struct ProviderStat {
    pub provider: String,
    pub runs: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_usd: f64,
    pub costed_runs: i64,
}

/// One model of one engine. Kept apart from [`ProviderStat`] because the interesting question at
/// this level is which *model* the tokens went to — an engine routed across a cheap and an
/// expensive model reads as one average otherwise.
#[derive(Debug, Clone, Serialize)]
pub struct ModelStat {
    pub provider: String,
    /// Empty when the CLI picked for itself and never said which.
    pub model: String,
    pub runs: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    pub costed_runs: i64,
}

/// One feature's slice of a window — the answer to "is my PR review being counted at all?".
///
/// Kept apart from [`ProviderStat`] because they answer opposite questions: that one says which
/// *engine* the spend went to, this one says which *part of the app* asked for it. A meter with
/// only the first can be read for a total and cannot be read for a gap.
#[derive(Debug, Clone, Serialize)]
pub struct TaskStat {
    /// One of [`crate::ai::task`]'s constants, or empty for rows written before they existed.
    pub task: String,
    pub runs: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    pub costed_runs: i64,
}

/// One column of the chart. The bucket is closed at `start` and open at the next one.
#[derive(Debug, Clone, Serialize)]
pub struct UsageBucket {
    /// RFC 3339, the instant the bucket opens.
    pub start: String,
    pub runs: i64,
    pub tokens: i64,
    pub cost_usd: f64,
}

/// Everything the statistics screen draws, for one window.
#[derive(Debug, Clone, Serialize)]
pub struct UsageStats {
    /// How far back this covers, in hours — echoed so a late answer cannot be drawn under the
    /// wrong heading after the user has moved the picker.
    pub window_hours: i64,
    /// How wide one column of `series` is, in minutes.
    pub bucket_minutes: i64,
    pub series: Vec<UsageBucket>,
    pub providers: Vec<ProviderStat>,
    pub models: Vec<ModelStat>,
    /// Every feature that spent anything in the window, busiest first. A feature absent from here
    /// spent nothing — which is either true, or the bug.
    pub tasks: Vec<TaskStat>,
    /// The busiest single bucket, as tokens. Zero for an empty window — the chart needs a scale
    /// and dividing by the maximum is the only one that does not need a quota to exist.
    pub peak_tokens: i64,
    /// RFC 3339 of the oldest row kept at all, so the screen can say when a window is longer than
    /// the history behind it.
    pub since: String,
}

/// How wide a column should be for a given window: about two to three dozen of them, which is as
/// many as a chart this size can show without the bars becoming lines.
pub fn bucket_minutes_for(window_hours: i64) -> i64 {
    match window_hours {
        h if h <= 6 => 15,
        h if h <= 48 => 60,
        h if h <= 24 * 8 => 60 * 6,
        _ => 60 * 24,
    }
}
