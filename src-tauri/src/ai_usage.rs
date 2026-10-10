//! What the engines have actually spent, and the breakdown the statistics screen reads it back as.
//!
//! **Measured, not predicted.** Every row here is one finished run's own report of its tokens and,
//! where the CLI said so, its cost. Nothing is estimated from a price table, and none of it is a
//! provider quota — that is [`crate::ai_quota`], which asks the providers themselves. The two are
//! deliberately never mixed: a "% of plan used" computed from these rows would be a guess wearing a
//! limit's clothes.
//!
//! **One reader.** This is the Settings → AI screen's material and nothing else's. The status bar
//! used to draw a spend meter from it as well, and no longer does — spend is a screen's worth of
//! history, and the bar answers the one question that can run out.
//!
//! Recording is fire-and-forget by design. A statistic is not worth failing a turn over: if the
//! write fails, the run still succeeded and the screen is merely missing a row.

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

/// One `app_settings` row, read through the same handle — for the few settings the run plumbing in
/// `ai.rs` has to consult for itself (the watchdog's limit, the language its message is written in)
/// without an argument threaded through every operation to carry them.
///
/// `None` before `setup` has attached the handle, which is every unit test: callers fall back to
/// their defaults, exactly as for a setting nobody has written.
pub(crate) fn setting(key: &str) -> Option<String> {
    with_conn(|conn| queries::get_setting(conn, key).ok().flatten()).flatten()
}

/// The database itself, through the same handle — for an engine that runs inside this process and
/// reads a group of settings at once (`crate::local_agent` and the «Modelo local» configuration).
/// `None` before `setup`, like [`setting`]. Hold it briefly: it is the app's one connection.
pub(crate) fn with_conn<T>(read: impl FnOnce(&rusqlite::Connection) -> T) -> Option<T> {
    let app = APP.get()?;
    let db = app.try_state::<Db>()?;
    let conn = db.0.lock().ok()?;
    Some(read(&conn))
}

/// Files one finished run's usage. Never fails and never blocks the caller.
///
/// `task` is the feature that spent it — one of [`crate::ai::task`]'s constants.
/// `account_id` is the account that ran it — `None` for the CLI's system account. See
/// `crate::ai_accounts`.
pub fn record(provider: &str, model: &str, task: &str, account_id: Option<&str>, usage: &AiUsage) {
    if usage.is_empty() {
        return;
    }
    let Some(app) = APP.get() else { return };
    let Ok(db) = app.try_state::<Db>().ok_or(()) else { return };
    let Ok(conn) = db.0.lock() else { return };
    let _ = queries::record_ai_usage(&conn, provider, model, task, account_id, usage);
}

/// Rows older than this are swept when the statistics screen reads: a screen that only ever looks
/// back over a chosen window has no use for a year of history, and this table is written to on
/// every single AI turn.
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

/// One account's share of a window. `account_id` is `None` for the system account, which is also
/// what every row recorded before accounts existed ran as.
#[derive(Debug, Clone, Serialize)]
pub struct AccountStat {
    pub provider: String,
    pub account_id: Option<String>,
    pub runs: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    pub costed_runs: i64,
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
    /// Per account, across providers — the breakdown the account filter is chosen from, so it is
    /// always computed over the whole window rather than over the filtered slice.
    pub accounts: Vec<AccountStat>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::AiUsage;
    use rusqlite::Connection;

    fn install() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn usage(input: i64, output: i64, cost: Option<f64>) -> AiUsage {
        AiUsage { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: cost }
    }

    /// Two to three dozen columns whatever the window, and never a narrower column for a wider one.
    #[test]
    fn columns_widen_with_the_window() {
        let mut previous = 0;
        for hours in [1, 5, 6, 7, 24, 48, 49, 24 * 8, 24 * 8 + 1, 24 * 30, 24 * 90] {
            let minutes = bucket_minutes_for(hours);
            assert!(minutes >= previous, "{hours}h got {minutes} min after {previous}");
            let columns = hours * 60 / minutes;
            assert!(columns <= 96, "{hours}h would draw {columns} columns");
            previous = minutes;
        }
    }

    /// A run that says nothing is not a run that cost nothing: an empty report adds no row, so the
    /// screen does not count it as one.
    #[test]
    fn an_empty_report_is_not_a_row() {
        let conn = install();
        queries::record_ai_usage(&conn, "claude", "m", crate::ai::task::CHAT, None, &usage(0, 0, None)).unwrap();
        let stats = queries::ai_usage_stats(&conn, 24, None).unwrap();
        assert!(stats.providers.is_empty(), "{:?}", stats.providers);
    }

    /// What `ai::record_failed_usage` files for a failed or stopped run lands in the same totals as
    /// an answered one — which is the point: the meter's job is what was spent, and a run that
    /// failed after twelve tool calls spent it all.
    #[test]
    fn a_failed_runs_report_counts_like_any_other() {
        let conn = install();
        queries::record_ai_usage(&conn, "claude", "m", crate::ai::task::CHAT, None, &usage(100, 20, Some(0.5))).unwrap();
        queries::record_ai_usage(&conn, "claude", "m", crate::ai::task::REVIEW_PR, None, &usage(300, 40, Some(1.5))).unwrap();
        let stats = queries::ai_usage_stats(&conn, 24, None).unwrap();
        let claude = stats.providers.iter().find(|p| p.provider == "claude").expect("claude row");
        assert_eq!(claude.runs, 2);
        assert_eq!(claude.input_tokens, 400);
        assert_eq!(claude.output_tokens, 60);
        assert!((claude.cost_usd - 2.0).abs() < 1e-9);
        assert_eq!(stats.tasks.len(), 2, "each feature keeps its own line");
    }

    /// Before `setup` attaches the handle there is nothing to read, and that is "unset", not a panic.
    #[test]
    fn settings_read_as_unset_without_an_app() {
        assert_eq!(setting(crate::ai_runs::IDLE_TIMEOUT_KEY), None);
    }
}
