//! How the app is used — Settings › Estadísticas, for every workspace, one workspace or one
//! repository: apps and time, chats, AI (by task, engine, model, outcome, tokens, cost), git, the
//! actions inside each app, shortcuts and commands, and what failed.
//!
//! # Counters, never content
//!
//! One row per **day × workspace × repository × kind × key** (`usage_daily`), bumped in place, and
//! one per **day × hour × workspace** (`usage_hourly`) for the hour-of-week heat map. A key names a
//! *kind of thing* (`api.send`, `db.query.postgres`, `claude/opus`) — never a prompt, a query, a URL
//! or a file name. Counters are a few hundred rows a month and keep for ever, so there is no
//! retention sweep (unlike `ai_usage`, thirty days).
//!
//! # Kinds
//!
//! | kind | key | from |
//! |---|---|---|
//! | `view` | app / repository tab | frontend (`usageTracker`), `seconds` = time in front |
//! | `feature` | settings, palette, terminal… | frontend |
//! | `session` | `launch`, `active` | frontend |
//! | `chat` | `<surface>.<event>` | frontend (the invoke hook) |
//! | `chat_engine` | `provider/model` | frontend |
//! | `action` | `<app>.<action>` | frontend (the invoke hook) |
//! | `error` | `<app>.<operation>` | frontend, and failed AI runs here |
//! | `shortcut` / `command` / `settings` | catalogue id | frontend |
//! | `ai`, `ai_provider`, `ai_model` | task / engine / `engine/model` | [`ai_run`] (runs, seconds) + [`ai_spend`] (tokens, cost) |
//! | `ai_outcome` | success, error, cancelled, quota | [`ai_run`] |
//! | `ai_tokens` | input, output, cache_read, cache_write | [`ai_spend`] |
//! | `git` | commit, push, rebase… | `git_ops.rs` through [`git`] |
//! | `git_lines` | added, removed, files | [`commit_stats`] |
//!
//! # Attribution
//!
//! The frontend sends its own workspace and repository. A backend event has neither, so it takes
//! the workspace the frontend last named ([`set_context`]) and the repository from what it was
//! given: a git command's `repo_path`, an AI run's working directory (carried by a task-local
//! across [`with_run_repo`]), resolved to the project's id by [`repo_for_path`]. `''` is "none".
//! No foreign keys: deleting a workspace or a repository keeps its history in the totals.
//!
//! Recording never fails a caller.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const KINDS: [&str; 17] = [
    "view",
    "feature",
    "session",
    "chat",
    "chat_engine",
    "action",
    "error",
    "shortcut",
    "command",
    "settings",
    "ai",
    "ai_provider",
    "ai_model",
    "ai_outcome",
    "ai_tokens",
    "git",
    "git_lines",
];

/// The workspace and repository backend events are filed under when they bring none.
static CONTEXT: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));

tokio::task_local! {
    /// The repository (project id) an AI run works in, for the spend it reports from inside the run.
    static RUN_REPO: String;
}

pub fn set_context(workspace: &str, repo: &str) {
    if let Ok(mut context) = CONTEXT.lock() {
        *context = (workspace.to_string(), repo.to_string());
    }
}

fn context() -> (String, String) {
    CONTEXT.lock().map(|context| context.clone()).unwrap_or_default()
}

/// Runs `future` with `repo` as the repository its AI spend is filed under.
pub async fn with_run_repo<F: std::future::Future>(repo: String, future: F) -> F::Output {
    RUN_REPO.scope(repo, future).await
}

fn run_repo() -> Option<String> {
    RUN_REPO.try_with(|repo| repo.clone()).ok()
}

fn now_local() -> chrono::DateTime<chrono::Local> {
    chrono::Local::now()
}

/// One increment, as the frontend batches them.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageEvent {
    pub kind: String,
    pub key: String,
    /// `None` → the workspace the backend last heard of.
    pub workspace_id: Option<String>,
    /// A project id; `None` → none (`''`), never the current one: most events are not about a repo.
    pub repo: Option<String>,
    pub count: i64,
    pub seconds: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    /// `YYYY-MM-DD`; `None` → today. A batch flushed just after midnight keeps the day it happened on.
    pub day: Option<String>,
    /// 0–23, local; `None` → now.
    pub hour: Option<u32>,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    // The first shape (2026-10-29, never released) had no repository column, and a primary key
    // cannot be altered in SQLite: rebuilt once, rows kept under "no repository".
    let has_table: bool =
        conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'usage_daily'", [], |r| r.get::<_, i64>(0))? > 0;
    let has_repo: bool = has_table
        && conn.query_row("SELECT COUNT(*) FROM pragma_table_info('usage_daily') WHERE name = 'repo'", [], |r| r.get::<_, i64>(0))? > 0;
    if has_table && !has_repo {
        conn.execute_batch("ALTER TABLE usage_daily RENAME TO usage_daily_v1; DROP INDEX IF EXISTS idx_usage_daily_ws;")?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_daily (
            day TEXT NOT NULL,
            workspace_id TEXT NOT NULL DEFAULT '',
            repo TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            seconds INTEGER NOT NULL DEFAULT 0,
            tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (day, workspace_id, repo, kind, key)
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS idx_usage_daily_ws ON usage_daily(workspace_id, repo, day);
         CREATE TABLE IF NOT EXISTS usage_hourly (
            day TEXT NOT NULL,
            hour INTEGER NOT NULL,
            workspace_id TEXT NOT NULL DEFAULT '',
            seconds INTEGER NOT NULL DEFAULT 0,
            events INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, hour, workspace_id)
         ) WITHOUT ROWID;",
    )?;
    if has_table && !has_repo {
        conn.execute_batch(
            "INSERT OR IGNORE INTO usage_daily (day, workspace_id, repo, kind, key, count, seconds, tokens, cost_usd)
               SELECT day, workspace_id, '', kind, key, count, seconds, tokens, cost_usd FROM usage_daily_v1;
             DROP TABLE usage_daily_v1;",
        )?;
    }
    Ok(())
}

fn valid_day(day: &str) -> bool {
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_ok()
}

/// A key is a name for a kind of thing; anything long or multi-line is content and is dropped.
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 120 && !key.chars().any(char::is_control)
}

/// Adds `events` to their counters. Unknown kinds, bad keys and negative amounts are dropped rather
/// than stored: this table is only ever read back as sums.
pub fn record(conn: &Connection, events: &[UsageEvent]) -> rusqlite::Result<()> {
    let (fallback_ws, _) = context();
    let now = now_local();
    let today = now.format("%Y-%m-%d").to_string();
    let this_hour = chrono::Timelike::hour(&now);
    let mut daily = conn.prepare_cached(
        "INSERT INTO usage_daily (day, workspace_id, repo, kind, key, count, seconds, tokens, cost_usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(day, workspace_id, repo, kind, key) DO UPDATE SET
            count = count + excluded.count,
            seconds = seconds + excluded.seconds,
            tokens = tokens + excluded.tokens,
            cost_usd = cost_usd + excluded.cost_usd",
    )?;
    let mut hourly = conn.prepare_cached(
        "INSERT INTO usage_hourly (day, hour, workspace_id, seconds, events) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(day, hour, workspace_id) DO UPDATE SET seconds = seconds + excluded.seconds, events = events + excluded.events",
    )?;
    for event in events {
        let key = event.key.trim();
        if !KINDS.contains(&event.kind.as_str()) || !valid_key(key) {
            continue;
        }
        let (count, seconds, tokens) = (event.count.max(0), event.seconds.max(0), event.tokens.max(0));
        let cost = if event.cost_usd.is_finite() { event.cost_usd.max(0.0) } else { 0.0 };
        if count == 0 && seconds == 0 && tokens == 0 && cost == 0.0 {
            continue;
        }
        let day = event.day.as_deref().filter(|day| valid_day(day)).unwrap_or(&today);
        let workspace = event.workspace_id.as_deref().unwrap_or(&fallback_ws);
        let repo = event.repo.as_deref().unwrap_or_default();
        daily.execute(params![day, workspace, repo, event.kind, key, count, seconds, tokens, cost])?;

        // The heat map: time in front of the app, and things done. Not the AI spend rows (`count`
        // 0) and not view time, which `session/active` already carries once.
        let hour = event.hour.filter(|hour| *hour < 24).unwrap_or(this_hour);
        let (hour_seconds, hour_events) = match (event.kind.as_str(), key) {
            ("session", "active") => (seconds, 0),
            ("view", _) | ("session", _) => (0, 0),
            _ => (0, count),
        };
        if hour_seconds > 0 || hour_events > 0 {
            hourly.execute(params![day, hour, workspace, hour_seconds, hour_events])?;
        }
    }
    Ok(())
}

/// Runs `write` against the app's connection. A no-op before `setup` (every unit test).
fn with_db(write: impl FnOnce(&Connection)) {
    crate::ai_usage::with_conn(write);
}

/// The project whose folder holds `path` — the longest matching `local_path`, so a nested checkout
/// wins over its parent — or `''` when none does.
pub fn repo_for_path(conn: &Connection, path: &str) -> String {
    let normal = |p: &str| p.trim_end_matches(['/', '\\']).replace('\\', "/").to_lowercase();
    let wanted = normal(path);
    if wanted.is_empty() {
        return String::new();
    }
    let Ok(mut statement) = conn.prepare_cached("SELECT id, local_path FROM projects") else { return String::new() };
    let Ok(rows) = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else {
        return String::new();
    };
    rows.flatten()
        .filter(|(_, root)| {
            let root = normal(root);
            !root.is_empty() && (wanted == root || wanted.starts_with(&format!("{root}/")))
        })
        .max_by_key(|(_, root)| root.len())
        .map(|(id, _)| id)
        .unwrap_or_default()
}

/// The repository (project id) for a path, through the app's connection.
pub fn repo_of(path: Option<&str>) -> String {
    let Some(path) = path else { return String::new() };
    crate::ai_usage::with_conn(|conn| repo_for_path(conn, path)).unwrap_or_default()
}

fn backend_event(kind: &str, key: &str, repo: &str, count: i64, seconds: i64, tokens: i64, cost: f64) -> UsageEvent {
    UsageEvent {
        kind: kind.into(),
        key: key.into(),
        repo: Some(repo.into()),
        count,
        seconds,
        tokens,
        cost_usd: cost,
        ..Default::default()
    }
}

/// A git operation made from the app, in the repository at `repo_path`.
pub fn git(operation: &str, repo_path: &str) {
    with_db(|conn| {
        let repo = repo_for_path(conn, repo_path);
        let _ = record(conn, &[backend_event("git", operation, &repo, 1, 0, 0, 0.0)]);
    });
}

/// A commit's size: files touched and lines added and removed, read from its own diff.
pub fn commit_stats(repo_path: &str, oid: &str) {
    let stats = (|| -> Option<(i64, i64, i64)> {
        let repo = git2::Repository::open(repo_path).ok()?;
        let commit = repo.find_commit(git2::Oid::from_str(oid).ok()?).ok()?;
        let tree = commit.tree().ok()?;
        let parent = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
        let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), None).ok()?;
        let stats = diff.stats().ok()?;
        Some((stats.files_changed() as i64, stats.insertions() as i64, stats.deletions() as i64))
    })();
    let Some((files, added, removed)) = stats else { return };
    with_db(|conn| {
        let repo = repo_for_path(conn, repo_path);
        let rows = [
            backend_event("git_lines", "files", &repo, files, 0, 0, 0.0),
            backend_event("git_lines", "added", &repo, added, 0, 0, 0.0),
            backend_event("git_lines", "removed", &repo, removed, 0, 0, 0.0),
        ];
        let _ = record(conn, &rows);
    });
}

/// How a run ended, as the statistics name it.
pub fn outcome_key(outcome: &Result<crate::ai::AiRun, String>) -> &'static str {
    match outcome {
        Ok(_) => "success",
        Err(error) if error.starts_with(crate::ai_runs::CANCELLED_MARKER) => "cancelled",
        Err(error) => match crate::ai::classify_failure(error).kind {
            crate::ai::AiFailureKind::Quota => "quota",
            _ => "error",
        },
    }
}

fn model_key(provider: &str, model: &str) -> String {
    let model = model.trim();
    format!("{provider}/{}", if model.is_empty() { "default" } else { model })
}

/// One finished AI run: counted once, with how long it took and how it ended. Spend is [`ai_spend`].
pub fn ai_run(provider: &str, model: &str, task: &str, cwd: Option<&str>, outcome: &str, seconds: i64) {
    let task = if task.is_empty() { "other" } else { task };
    with_db(|conn| {
        let repo = cwd.map(|cwd| repo_for_path(conn, cwd)).unwrap_or_default();
        let mut rows = vec![
            backend_event("ai", task, &repo, 1, seconds, 0, 0.0),
            backend_event("ai_provider", provider, &repo, 1, seconds, 0, 0.0),
            backend_event("ai_model", &model_key(provider, model), &repo, 1, seconds, 0, 0.0),
            backend_event("ai_outcome", outcome, &repo, 1, seconds, 0, 0.0),
        ];
        if outcome == "error" || outcome == "quota" {
            rows.push(backend_event("error", &format!("ai.{task}"), &repo, 1, 0, 0, 0.0));
        }
        let _ = record(conn, &rows);
    });
}

/// What one run reported spending, from [`crate::ai_usage::record`] — inside the run's own lock on
/// the connection, so it takes the connection rather than locking again.
pub fn ai_spend(conn: &Connection, provider: &str, model: &str, task: &str, usage: &crate::ai::AiUsage) {
    let task = if task.is_empty() { "other" } else { task };
    let repo = run_repo().unwrap_or_default();
    let tokens = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
    let cost = usage.cost_usd.unwrap_or(0.0);
    let rows = [
        backend_event("ai", task, &repo, 0, 0, tokens, cost),
        backend_event("ai_provider", provider, &repo, 0, 0, tokens, cost),
        backend_event("ai_model", &model_key(provider, model), &repo, 0, 0, tokens, cost),
        backend_event("ai_tokens", "input", &repo, 0, 0, usage.input_tokens, 0.0),
        backend_event("ai_tokens", "output", &repo, 0, 0, usage.output_tokens, 0.0),
        backend_event("ai_tokens", "cache_read", &repo, 0, 0, usage.cache_read_tokens, 0.0),
        backend_event("ai_tokens", "cache_write", &repo, 0, 0, usage.cache_write_tokens, 0.0),
    ];
    let _ = record(conn, &rows);
}

// ---------------------------------------------------------------------------------- reading back

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyStat {
    pub kind: String,
    pub key: String,
    pub count: i64,
    pub seconds: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    /// Days on which it was used at all.
    pub days: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub day: String,
    pub views: i64,
    pub seconds: i64,
    pub ai_runs: i64,
    pub git_ops: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    pub actions: i64,
    pub errors: i64,
}

/// The headline numbers of a window, for this period and the one before it.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub seconds: i64,
    pub views: i64,
    pub ai_runs: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    pub git_ops: i64,
    pub actions: i64,
    pub chats: i64,
    pub errors: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupStat {
    /// A workspace id or a project id; `''` is "none".
    pub id: String,
    pub views: i64,
    pub seconds: i64,
    pub ai_runs: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    pub git_ops: i64,
    pub actions: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub keys: Vec<KeyStat>,
    /// Every day of the window, oldest first, zeros included, for windows of at most 92 days;
    /// "all time" lists the recorded days.
    pub daily: Vec<DayStat>,
    /// Per workspace; only for the global scope.
    pub workspaces: Vec<GroupStat>,
    /// Per repository, inside the scope (not when the scope is one repository).
    pub repos: Vec<GroupStat>,
    /// `[weekday 0=Monday][hour]` = active seconds; and the same grid of events.
    pub heat_seconds: Vec<Vec<i64>>,
    pub heat_events: Vec<Vec<i64>>,
    pub totals: Totals,
    /// The same window just before this one; `None` for all time.
    pub previous: Option<Totals>,
    /// The first day anything was recorded in this scope.
    pub since: Option<String>,
    pub active_days: i64,
    /// Consecutive days with use, ending today (or yesterday, if today is still empty).
    pub streak: i64,
    pub longest_streak: i64,
}

/// What a report is about.
#[derive(Debug, Clone, Default)]
pub struct Scope<'a> {
    pub workspace: Option<&'a str>,
    pub repo: Option<&'a str>,
    pub days: Option<i64>,
}

const DAY_SUMS: &str = "SUM(CASE WHEN kind = 'view' THEN count ELSE 0 END),
    SUM(CASE WHEN kind = 'session' AND key = 'active' THEN seconds ELSE 0 END),
    SUM(CASE WHEN kind = 'ai' THEN count ELSE 0 END),
    SUM(CASE WHEN kind = 'git' THEN count ELSE 0 END),
    SUM(CASE WHEN kind = 'ai' THEN tokens ELSE 0 END),
    SUM(CASE WHEN kind = 'ai' THEN cost_usd ELSE 0 END),
    SUM(CASE WHEN kind = 'action' THEN count ELSE 0 END),
    SUM(CASE WHEN kind = 'error' THEN count ELSE 0 END),
    SUM(CASE WHEN kind = 'chat' AND key LIKE '%.sent' THEN count ELSE 0 END)";

fn day_string(date: chrono::NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// `[from, to]` for the last `days` days, ending today.
fn window(days: Option<i64>) -> (String, String) {
    let today = now_local().date_naive();
    match days {
        Some(days) if days > 0 => (day_string(today - chrono::Duration::days(days - 1)), day_string(today)),
        _ => (String::new(), "9999-12-31".into()),
    }
}

/// The scope filter, for statements whose parameters start `?1 from, ?2 to, ?3 workspace, ?4 repo`.
const FILTER: &str = "day >= ?1 AND day <= ?2 AND (?3 IS NULL OR workspace_id = ?3) AND (?4 IS NULL OR repo = ?4)";

fn totals(conn: &Connection, from: &str, to: &str, scope: &Scope) -> rusqlite::Result<Totals> {
    conn.query_row(&format!("SELECT {DAY_SUMS} FROM usage_daily WHERE {FILTER}"), params![from, to, scope.workspace, scope.repo], |row| {
        // `seconds` is the active time; with a repository scope there is no session row, so the
        // time spent in that repository's tabs stands in for it (see `report`).
        Ok(Totals {
            views: row.get::<_, Option<i64>>(0)?.unwrap_or(0),
            seconds: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            ai_runs: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            git_ops: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
            tokens: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            cost_usd: row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
            actions: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
            errors: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
            chats: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
        })
    })
}

fn view_seconds(conn: &Connection, from: &str, to: &str, scope: &Scope) -> rusqlite::Result<i64> {
    conn.query_row(
        &format!("SELECT COALESCE(SUM(seconds), 0) FROM usage_daily WHERE kind = 'view' AND {FILTER}"),
        params![from, to, scope.workspace, scope.repo],
        |row| row.get(0),
    )
}

fn groups(conn: &Connection, column: &str, from: &str, to: &str, scope: &Scope) -> rusqlite::Result<Vec<GroupStat>> {
    let sql = format!(
        "SELECT {column},
            SUM(CASE WHEN kind = 'view' THEN count ELSE 0 END),
            SUM(CASE WHEN kind = 'view' THEN seconds ELSE 0 END),
            SUM(CASE WHEN kind = 'ai' THEN count ELSE 0 END),
            SUM(CASE WHEN kind = 'ai' THEN tokens ELSE 0 END),
            SUM(CASE WHEN kind = 'ai' THEN cost_usd ELSE 0 END),
            SUM(CASE WHEN kind = 'git' THEN count ELSE 0 END),
            SUM(CASE WHEN kind = 'action' THEN count ELSE 0 END)
         FROM usage_daily WHERE {FILTER} GROUP BY {column} ORDER BY 3 DESC, 2 DESC, 4 DESC"
    );
    conn.prepare(&sql)?
        .query_map(params![from, to, scope.workspace, scope.repo], |row| {
            Ok(GroupStat {
                id: row.get(0)?,
                views: row.get(1)?,
                seconds: row.get(2)?,
                ai_runs: row.get(3)?,
                tokens: row.get(4)?,
                cost_usd: row.get(5)?,
                git_ops: row.get(6)?,
                actions: row.get(7)?,
            })
        })?
        .collect()
}

/// Current and longest runs of consecutive days in `days` (sorted ascending, distinct).
pub fn streaks(days: &[chrono::NaiveDate], today: chrono::NaiveDate) -> (i64, i64) {
    let (mut longest, mut run) = (0i64, 0i64);
    let mut previous: Option<chrono::NaiveDate> = None;
    for day in days {
        run = match previous {
            Some(before) if *day - before == chrono::Duration::days(1) => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        previous = Some(*day);
    }
    // The current run counts while its last day is today or yesterday: today is not over yet.
    let current = match previous {
        Some(last) if today - last <= chrono::Duration::days(1) => run,
        _ => 0,
    };
    (current, longest)
}

/// The report for one scope.
pub fn report(conn: &Connection, scope: &Scope) -> rusqlite::Result<UsageReport> {
    let (from, to) = window(scope.days);
    let args = params![from, to, scope.workspace, scope.repo];

    let keys = conn
        .prepare(&format!(
            "SELECT kind, key, SUM(count), SUM(seconds), SUM(tokens), SUM(cost_usd), COUNT(DISTINCT day)
             FROM usage_daily WHERE {FILTER} GROUP BY kind, key ORDER BY kind, SUM(count) DESC, key"
        ))?
        .query_map(args, |row| {
            Ok(KeyStat {
                kind: row.get(0)?,
                key: row.get(1)?,
                count: row.get(2)?,
                seconds: row.get(3)?,
                tokens: row.get(4)?,
                cost_usd: row.get(5)?,
                days: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let by_repo = scope.repo.is_some();
    let recorded = conn
        .prepare(&format!("SELECT day, {DAY_SUMS}, SUM(CASE WHEN kind = 'view' THEN seconds ELSE 0 END) FROM usage_daily WHERE {FILTER} GROUP BY day ORDER BY day"))?
        .query_map(args, |row| {
            let active: i64 = row.get(2)?;
            let in_views: i64 = row.get(10)?;
            Ok(DayStat {
                day: row.get(0)?,
                views: row.get(1)?,
                seconds: if by_repo { in_views } else { active },
                ai_runs: row.get(3)?,
                git_ops: row.get(4)?,
                tokens: row.get(5)?,
                cost_usd: row.get(6)?,
                actions: row.get(7)?,
                errors: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let active_days = recorded.len() as i64;
    let daily = match scope.days {
        Some(days) if (1..=92).contains(&days) => fill_days(&recorded, days),
        _ => recorded,
    };

    let workspaces = if scope.workspace.is_none() && !by_repo { groups(conn, "workspace_id", &from, &to, scope)? } else { Vec::new() };
    let repos = if by_repo { Vec::new() } else { groups(conn, "repo", &from, &to, scope)?.into_iter().filter(|g| !g.id.is_empty()).collect() };

    // The heat map has no repository dimension: for a repository scope it shows its workspace's.
    let mut heat_seconds = vec![vec![0i64; 24]; 7];
    let mut heat_events = vec![vec![0i64; 24]; 7];
    {
        let mut statement = conn.prepare(
            "SELECT day, hour, SUM(seconds), SUM(events) FROM usage_hourly
             WHERE day >= ?1 AND day <= ?2 AND (?3 IS NULL OR workspace_id = ?3) GROUP BY day, hour",
        )?;
        let rows = statement.query_map(params![from, to, scope.workspace], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
        })?;
        for (day, hour, seconds, events) in rows.flatten() {
            let Ok(date) = chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d") else { continue };
            let weekday = chrono::Datelike::weekday(&date).num_days_from_monday() as usize;
            if let Some(hour) = usize::try_from(hour).ok().filter(|h| *h < 24) {
                heat_seconds[weekday][hour] += seconds;
                heat_events[weekday][hour] += events;
            }
        }
    }

    let mut current = totals(conn, &from, &to, scope)?;
    if by_repo {
        current.seconds = view_seconds(conn, &from, &to, scope)?;
    }
    let previous = match scope.days {
        Some(days) if days > 0 => {
            let today = now_local().date_naive();
            let (p_from, p_to) = (day_string(today - chrono::Duration::days(2 * days - 1)), day_string(today - chrono::Duration::days(days)));
            let mut before = totals(conn, &p_from, &p_to, scope)?;
            if by_repo {
                before.seconds = view_seconds(conn, &p_from, &p_to, scope)?;
            }
            Some(before)
        }
        _ => None,
    };

    // Streaks and "since" look at all time in this scope, whatever the window.
    let all_days: Vec<chrono::NaiveDate> = conn
        .prepare("SELECT DISTINCT day FROM usage_daily WHERE (?1 IS NULL OR workspace_id = ?1) AND (?2 IS NULL OR repo = ?2) ORDER BY day")?
        .query_map(params![scope.workspace, scope.repo], |row| row.get::<_, String>(0))?
        .flatten()
        .filter_map(|day| chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d").ok())
        .collect();
    let (streak, longest_streak) = streaks(&all_days, now_local().date_naive());
    let since = all_days.first().map(|day| day_string(*day));

    Ok(UsageReport {
        keys,
        daily,
        workspaces,
        repos,
        heat_seconds,
        heat_events,
        totals: current,
        previous,
        since,
        active_days,
        streak,
        longest_streak,
    })
}

/// `recorded` with a zero row for every missing day of the last `days`.
fn fill_days(recorded: &[DayStat], days: i64) -> Vec<DayStat> {
    let today = now_local().date_naive();
    (0..days)
        .rev()
        .map(|back| {
            let day = day_string(today - chrono::Duration::days(back));
            recorded.iter().find(|row| row.day == day).cloned().unwrap_or(DayStat { day, ..Default::default() })
        })
        .collect()
}

/// One raw counter row, for «Exportar».
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawRow {
    pub day: String,
    pub workspace_id: String,
    pub repo: String,
    pub kind: String,
    pub key: String,
    pub count: i64,
    pub seconds: i64,
    pub tokens: i64,
    pub cost_usd: f64,
}

pub fn rows(conn: &Connection, scope: &Scope) -> rusqlite::Result<Vec<RawRow>> {
    let (from, to) = window(scope.days);
    conn.prepare(&format!(
        "SELECT day, workspace_id, repo, kind, key, count, seconds, tokens, cost_usd FROM usage_daily WHERE {FILTER}
         ORDER BY day, workspace_id, repo, kind, key"
    ))?
    .query_map(params![from, to, scope.workspace, scope.repo], |row| {
        Ok(RawRow {
            day: row.get(0)?,
            workspace_id: row.get(1)?,
            repo: row.get(2)?,
            kind: row.get(3)?,
            key: row.get(4)?,
            count: row.get(5)?,
            seconds: row.get(6)?,
            tokens: row.get(7)?,
            cost_usd: row.get(8)?,
        })
    })?
    .collect()
}

/// Forgets everything recorded in a scope (the window is ignored: clearing is all time).
pub fn clear(conn: &Connection, workspace: Option<&str>, repo: Option<&str>) -> rusqlite::Result<usize> {
    let removed = conn.execute(
        "DELETE FROM usage_daily WHERE (?1 IS NULL OR workspace_id = ?1) AND (?2 IS NULL OR repo = ?2)",
        params![workspace, repo],
    )?;
    // The hourly grid has no repository: cleared with its workspace, or with everything.
    if repo.is_none() {
        conn.execute("DELETE FROM usage_hourly WHERE (?1 IS NULL OR workspace_id = ?1)", params![workspace])?;
    }
    Ok(removed)
}

/// Whether a table exists — for `migrate`'s callers' tests.
#[allow(dead_code)]
fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [name], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY, local_path TEXT NOT NULL);").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn event(kind: &str, key: &str, ws: &str, count: i64, seconds: i64) -> UsageEvent {
        UsageEvent { kind: kind.into(), key: key.into(), workspace_id: Some(ws.into()), count, seconds, ..Default::default() }
    }

    fn all(conn: &Connection) -> UsageReport {
        report(conn, &Scope::default()).unwrap()
    }

    #[test]
    fn the_same_day_workspace_repo_and_key_add_up_in_one_row() {
        let conn = db();
        record(&conn, &[event("view", "graph", "w1", 1, 30), event("view", "graph", "w1", 2, 15)]).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM usage_daily", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        let graph = report(&conn, &Scope { days: Some(7), ..Default::default() }).unwrap().keys.into_iter().find(|k| k.key == "graph").unwrap();
        assert_eq!((graph.count, graph.seconds, graph.days), (3, 45, 1));
    }

    #[test]
    fn workspace_and_repository_scopes_see_only_their_own() {
        let conn = db();
        let in_repo = UsageEvent { repo: Some("p1".into()), ..event("git", "commit", "w1", 2, 0) };
        record(&conn, &[event("view", "editor", "w1", 4, 0), event("view", "editor", "w2", 1, 0), in_repo]).unwrap();
        let w2 = report(&conn, &Scope { workspace: Some("w2"), ..Default::default() }).unwrap();
        assert_eq!(w2.keys.iter().find(|k| k.key == "editor").unwrap().count, 1);
        assert!(w2.workspaces.is_empty());
        let global = all(&conn);
        assert_eq!(global.keys.iter().find(|k| k.key == "editor").unwrap().count, 5);
        assert_eq!(global.workspaces.len(), 2);
        assert_eq!(global.repos.len(), 1, "only real repositories are listed");
        assert_eq!(global.repos[0].git_ops, 2);
        let repo = report(&conn, &Scope { repo: Some("p1"), ..Default::default() }).unwrap();
        assert_eq!(repo.keys.len(), 1);
        assert!(repo.repos.is_empty() && repo.workspaces.is_empty());
    }

    #[test]
    fn junk_and_content_are_dropped_not_stored() {
        let conn = db();
        let long = "x".repeat(200);
        record(
            &conn,
            &[
                event("nonsense", "x", "w", 1, 0),
                event("view", "  ", "w", 1, 0),
                event("view", "a", "w", -5, -1),
                event("view", "b", "w", 0, 0),
                event("action", &long, "w", 1, 0),
                event("action", "two\nlines", "w", 1, 0),
            ],
        )
        .unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM usage_daily", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn a_window_lists_every_day_with_zeros_and_compares_with_the_one_before() {
        let conn = db();
        let old = UsageEvent { day: Some("2001-01-01".into()), ..event("view", "graph", "w", 9, 0) };
        let today_ai = event("ai", "chat", "w", 1, 0);
        let week_ago = UsageEvent { day: Some(day_string(now_local().date_naive() - chrono::Duration::days(8))), ..event("ai", "chat", "w", 3, 0) };
        record(&conn, &[old, today_ai, week_ago]).unwrap();
        let week = report(&conn, &Scope { days: Some(7), ..Default::default() }).unwrap();
        assert_eq!(week.daily.len(), 7);
        assert_eq!(week.daily.last().unwrap().ai_runs, 1);
        assert!(week.keys.iter().all(|k| k.key != "graph"));
        assert_eq!(week.since.as_deref(), Some("2001-01-01"));
        assert_eq!(week.totals.ai_runs, 1);
        assert_eq!(week.previous.unwrap().ai_runs, 3);
        assert!(all(&conn).previous.is_none());
    }

    #[test]
    fn active_time_and_events_land_on_the_heat_map_by_weekday_and_hour() {
        let conn = db();
        let monday = "2026-10-26"; // a Monday
        let active = UsageEvent { day: Some(monday.into()), hour: Some(9), ..event("session", "active", "w", 0, 600) };
        let action = UsageEvent { day: Some(monday.into()), hour: Some(9), ..event("action", "api.send", "w", 2, 0) };
        let view = UsageEvent { day: Some(monday.into()), hour: Some(9), ..event("view", "graph", "w", 1, 600) };
        record(&conn, &[active, action, view]).unwrap();
        let report = all(&conn);
        assert_eq!(report.heat_seconds[0][9], 600, "view time is not counted twice");
        assert_eq!(report.heat_events[0][9], 2);
    }

    #[test]
    fn streaks_count_consecutive_days_and_today_is_not_over() {
        let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let days = [d("2026-10-01"), d("2026-10-02"), d("2026-10-03"), d("2026-10-10"), d("2026-10-11")];
        assert_eq!(streaks(&days, d("2026-10-12")), (2, 3));
        assert_eq!(streaks(&days, d("2026-10-11")), (2, 3));
        assert_eq!(streaks(&days, d("2026-10-14")), (0, 3));
        assert_eq!(streaks(&[], d("2026-10-14")), (0, 0));
    }

    #[test]
    fn a_path_resolves_to_the_innermost_project_that_holds_it() {
        let conn = db();
        conn.execute_batch(
            "INSERT INTO projects VALUES ('outer', '/code/mono'), ('inner', '/code/mono/apps/web'), ('other', '/code/monolith');",
        )
        .unwrap();
        assert_eq!(repo_for_path(&conn, "/code/mono/apps/web/src"), "inner");
        assert_eq!(repo_for_path(&conn, "/code/mono/"), "outer");
        assert_eq!(repo_for_path(&conn, "/code/monolith"), "other", "a prefix of the name is not a parent folder");
        assert_eq!(repo_for_path(&conn, "/elsewhere"), "");
    }

    #[test]
    fn the_first_shape_is_rebuilt_with_its_rows_kept() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_daily (day TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, key TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, workspace_id, kind, key)) WITHOUT ROWID;
             INSERT INTO usage_daily VALUES ('2026-10-29', 'w', 'view', 'graph', 3, 60, 0, 0);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let (repo, count): (String, i64) = conn.query_row("SELECT repo, count FROM usage_daily", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((repo.as_str(), count), ("", 3));
        assert!(!table_exists(&conn, "usage_daily_v1"));
    }

    #[test]
    fn clearing_a_scope_leaves_the_others() {
        let conn = db();
        let r1 = UsageEvent { repo: Some("p1".into()), ..event("view", "a", "w1", 1, 0) };
        record(&conn, &[r1, event("view", "a", "w1", 1, 0), event("view", "a", "w2", 1, 0)]).unwrap();
        assert_eq!(clear(&conn, None, Some("p1")).unwrap(), 1);
        assert_eq!(clear(&conn, Some("w1"), None).unwrap(), 1);
        assert_eq!(all(&conn).keys[0].count, 1);
    }

    #[test]
    fn a_backend_event_goes_to_the_workspace_last_named() {
        let conn = db();
        set_context("w9", "");
        let backend = UsageEvent { kind: "git".into(), key: "push".into(), count: 1, ..Default::default() };
        record(&conn, &[backend]).unwrap();
        set_context("", "");
        assert_eq!(report(&conn, &Scope { workspace: Some("w9"), ..Default::default() }).unwrap().keys[0].key, "push");
    }

    #[test]
    fn ai_outcomes_are_named_from_the_run() {
        assert_eq!(outcome_key(&Err(crate::ai_runs::CANCELLED_MARKER.to_string())), "cancelled");
        assert_eq!(outcome_key(&Err("boom".to_string())), "error");
        assert_eq!(model_key("claude", ""), "claude/default");
    }
}
