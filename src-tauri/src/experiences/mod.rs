//! Experiences: what happened after an AI answer, kept as evidence.
//!
//! A model's answer is not an experience; what the user and the project did with it is — kept or
//! discarded in the turn review, applied from a code block, reverted from a checkpoint, a check that
//! passed or failed after a hybrid task, a fix that verified. Those signals used to live in
//! `localStorage` or nowhere. Here they become rows the memory engine proposes rules from
//! (`crate::ai_memory`), the bench turns into new tasks, and the dataset builder reads
//! (`crate::learning`).
//!
//! Three rules hold for every row:
//! - **Redacted on capture** (`secret_scan::redact`): a key pasted into a chat never becomes
//!   evidence, let alone training data.
//! - **Not training data by default.** `training_allowed` comes from the workspace's own switch
//!   (`ai_training_allowed:<workspace>`, off unless turned on), and a row's `quality` must also be
//!   `approved` before a dataset may use it.
//! - **Linked, not copied.** A chat turn is pointed at (`run_ref`), not duplicated; the review's
//!   finding states stay in `review_runs`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How long experiences are kept unless the setting says otherwise.
pub const DEFAULT_KEEP_DAYS: i64 = 365;
pub const KEY_KEEP_DAYS: &str = "ai_experiences_keep_days";

/// The workspace switch that lets its experiences be used for training.
pub fn training_key(workspace_id: &str) -> String {
    format!("ai_training_allowed:{workspace_id}")
}

/// Where an experience came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    TurnReview,
    ApplyCode,
    CheckpointRestore,
    HybridCheck,
    FixVerify,
    Chat,
    Memory,
    Manual,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::TurnReview => "turn_review",
            Source::ApplyCode => "apply_code",
            Source::CheckpointRestore => "checkpoint_restore",
            Source::HybridCheck => "hybrid_check",
            Source::FixVerify => "fix_verify",
            Source::Chat => "chat",
            Source::Memory => "memory",
            Source::Manual => "manual",
        }
    }
}

/// What the signal says about the answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Signal {
    Accepted,
    Rejected,
    Reverted,
    Passed,
    Failed,
    Error,
    Cancelled,
    Corrected,
}

impl Signal {
    pub fn as_str(self) -> &'static str {
        match self {
            Signal::Accepted => "accepted",
            Signal::Rejected => "rejected",
            Signal::Reverted => "reverted",
            Signal::Passed => "passed",
            Signal::Failed => "failed",
            Signal::Error => "error",
            Signal::Cancelled => "cancelled",
            Signal::Corrected => "corrected",
        }
    }
}

/// An experience to record.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewExperience {
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub source: Option<Source>,
    pub signal: Option<Signal>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub digest: Option<String>,
    pub task: Option<String>,
    pub run_ref: Option<String>,
    pub prompt: Option<String>,
    pub response: Option<String>,
    /// Evidence: paths, the check and its exit code, the checkpoint…
    #[serde(default)]
    pub detail: serde_json::Value,
    /// The checkout it happened in, when the caller knows the path rather than the project: the
    /// project and workspace are resolved from it.
    #[serde(default)]
    pub repo_path: Option<String>,
}

/// One stored experience.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Experience {
    pub id: String,
    pub created_at: i64,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub source: String,
    pub signal: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub digest: Option<String>,
    pub task: Option<String>,
    pub run_ref: Option<String>,
    pub prompt: Option<String>,
    pub response: Option<String>,
    pub detail: serde_json::Value,
    pub training_allowed: bool,
    pub quality: String,
}

const MAX_TEXT: usize = 60_000;

fn clean(text: Option<String>) -> Option<String> {
    let text = text.filter(|t| !t.trim().is_empty())?;
    let (redacted, _) = crate::secret_scan::redact(&text);
    Some(if redacted.chars().count() > MAX_TEXT { redacted.chars().take(MAX_TEXT).collect() } else { redacted })
}

fn training_allowed(conn: &Connection, workspace_id: Option<&str>) -> bool {
    let Some(ws) = workspace_id else { return false };
    crate::db::queries::get_setting(conn, &training_key(ws)).ok().flatten().is_some_and(|v| v == "1" || v == "true")
}

/// Records `input`. A second recording of the same event (same source, signal, run and evidence) is
/// ignored, so a button pressed twice or a retried call does not count twice. Returns the id, or
/// `None` when it was a duplicate.
pub fn record(conn: &Connection, input: NewExperience) -> rusqlite::Result<Option<String>> {
    let source = input.source.unwrap_or(Source::Manual);
    let signal = input.signal.unwrap_or(Signal::Accepted);
    let detail = if input.detail.is_null() { serde_json::json!({}) } else { input.detail };
    let detail_text = crate::secret_scan::redact(&detail.to_string()).0;
    let fingerprint = {
        let mut hash = Sha256::new();
        for part in [
            source.as_str(),
            signal.as_str(),
            input.run_ref.as_deref().unwrap_or_default(),
            input.workspace_id.as_deref().unwrap_or_default(),
            &detail_text,
            input.response.as_deref().unwrap_or_default(),
        ] {
            hash.update(part.as_bytes());
            hash.update([0]);
        }
        format!("{:x}", hash.finalize())
    };
    let id = uuid::Uuid::new_v4().to_string();
    let allowed = training_allowed(conn, input.workspace_id.as_deref());
    let changed = conn.execute(
        "INSERT OR IGNORE INTO ai_experiences
             (id, created_at, workspace_id, project_id, source, signal, provider, model, digest, task, run_ref, prompt, response, detail, training_allowed, quality, fingerprint)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'unreviewed', ?16)",
        params![
            id,
            chrono::Utc::now().timestamp_millis(),
            input.workspace_id,
            input.project_id,
            source.as_str(),
            signal.as_str(),
            input.provider,
            input.model,
            input.digest,
            input.task,
            input.run_ref,
            clean(input.prompt),
            clean(input.response),
            detail_text,
            allowed,
            fingerprint,
        ],
    )?;
    Ok((changed > 0).then_some(id))
}

/// [`record`] through the app's database, for capture points that hold no connection. Never fails
/// the caller: an experience lost is better than an action refused.
pub fn record_global(input: NewExperience) {
    let _ = crate::ai_usage::with_conn(|conn| record(conn, input));
}

/// The project (and its workspace) a checkout path belongs to, when one does.
pub fn project_for_path(conn: &Connection, path: &str) -> Option<(String, Option<String>)> {
    conn.query_row(
        "SELECT id, workspace_id FROM projects WHERE local_path = ?1 LIMIT 1",
        params![path.trim_end_matches(['/', '\\'])],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    )
    .ok()
}

/// Records an event that happened in the checkout at `repo_path`, filed under its project and
/// workspace. For the backend's own capture points; never fails the caller.
pub fn capture_at(repo_path: &str, source: Source, signal: Signal, run_ref: Option<String>, detail: serde_json::Value) {
    let _ = crate::ai_usage::with_conn(|conn| {
        let (project_id, workspace_id) = match project_for_path(conn, repo_path) {
            Some((project, workspace)) => (Some(project), workspace),
            None => (None, None),
        };
        record(conn, NewExperience { workspace_id, project_id, source: Some(source), signal: Some(signal), run_ref, detail, ..Default::default() })
    });
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub workspace_id: Option<String>,
    pub source: Option<String>,
    pub signal: Option<String>,
    pub quality: Option<String>,
    pub limit: Option<usize>,
}

fn row_to_experience(row: &rusqlite::Row<'_>) -> rusqlite::Result<Experience> {
    let detail: String = row.get(13)?;
    Ok(Experience {
        id: row.get(0)?,
        created_at: row.get(1)?,
        workspace_id: row.get(2)?,
        project_id: row.get(3)?,
        source: row.get(4)?,
        signal: row.get(5)?,
        provider: row.get(6)?,
        model: row.get(7)?,
        digest: row.get(8)?,
        task: row.get(9)?,
        run_ref: row.get(10)?,
        prompt: row.get(11)?,
        response: row.get(12)?,
        detail: serde_json::from_str(&detail).unwrap_or(serde_json::Value::Null),
        training_allowed: row.get(14)?,
        quality: row.get(15)?,
    })
}

const COLUMNS: &str =
    "id, created_at, workspace_id, project_id, source, signal, provider, model, digest, task, run_ref, prompt, response, detail, training_allowed, quality";

pub fn list(conn: &Connection, filter: &Filter) -> rusqlite::Result<Vec<Experience>> {
    sweep(conn)?;
    let mut sql = format!("SELECT {COLUMNS} FROM ai_experiences WHERE 1 = 1");
    let mut values: Vec<String> = Vec::new();
    for (column, value) in [("workspace_id", &filter.workspace_id), ("source", &filter.source), ("signal", &filter.signal), ("quality", &filter.quality)] {
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            values.push(value.clone());
            sql.push_str(&format!(" AND {column} = ?{}", values.len()));
        }
    }
    sql.push_str(&format!(" ORDER BY created_at DESC LIMIT {}", filter.limit.unwrap_or(200).clamp(1, 5_000)));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), row_to_experience)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Experience>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM ai_experiences WHERE id = ?1"), params![id], row_to_experience).optional()
}

/// `approved` (a dataset may use it, if training is allowed), `excluded`, or back to `unreviewed`.
pub fn set_quality(conn: &Connection, id: &str, quality: &str) -> rusqlite::Result<()> {
    let quality = match quality {
        "approved" | "excluded" => quality,
        _ => "unreviewed",
    };
    conn.execute("UPDATE ai_experiences SET quality = ?1 WHERE id = ?2", params![quality, id])?;
    Ok(())
}

/// Turns a workspace's training switch on or off, for its existing rows too.
pub fn set_training_allowed(conn: &Connection, workspace_id: &str, allowed: bool) -> rusqlite::Result<()> {
    crate::db::queries::set_setting(conn, &training_key(workspace_id), if allowed { "1" } else { "0" })?;
    conn.execute("UPDATE ai_experiences SET training_allowed = ?1 WHERE workspace_id = ?2", params![allowed, workspace_id])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ai_experiences WHERE id = ?1", params![id])?;
    Ok(())
}

/// Deletes every experience of a workspace (`None`: every experience).
pub fn clear(conn: &Connection, workspace_id: Option<&str>) -> rusqlite::Result<usize> {
    match workspace_id {
        Some(ws) => conn.execute("DELETE FROM ai_experiences WHERE workspace_id = ?1", params![ws]),
        None => conn.execute("DELETE FROM ai_experiences", []),
    }
}

/// Drops rows past the retention window.
pub fn sweep(conn: &Connection) -> rusqlite::Result<()> {
    let days = crate::db::queries::get_setting(conn, KEY_KEEP_DAYS)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|d| *d > 0)
        .unwrap_or(DEFAULT_KEEP_DAYS);
    let cutoff = chrono::Utc::now().timestamp_millis() - days * 86_400_000;
    conn.execute("DELETE FROM ai_experiences WHERE created_at < ?1", params![cutoff])?;
    Ok(())
}

/// Every experience matching `filter`, one JSON object per line — already redacted.
pub fn export_jsonl(conn: &Connection, filter: &Filter) -> rusqlite::Result<String> {
    let rows = list(conn, &Filter { limit: Some(5_000), ..filter.clone() })?;
    Ok(rows.iter().filter_map(|row| serde_json::to_string(row).ok()).collect::<Vec<_>>().join("\n"))
}

/// How many experiences a workspace has, by signal — the Learning pane's summary.
pub fn counts(conn: &Connection, workspace_id: Option<&str>) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT signal, COUNT(*) FROM ai_experiences WHERE (?1 IS NULL OR workspace_id = ?1) GROUP BY signal ORDER BY COUNT(*) DESC",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        conn.execute_batch("INSERT INTO workspaces VALUES ('w1'); INSERT INTO workspaces VALUES ('w2');").unwrap();
        crate::db::migrations::add_ai_platform_tables(&conn).unwrap();
        conn
    }

    fn kept(ws: &str, response: &str) -> NewExperience {
        NewExperience {
            workspace_id: Some(ws.into()),
            source: Some(Source::TurnReview),
            signal: Some(Signal::Accepted),
            run_ref: Some("checkpoint:abc".into()),
            response: Some(response.into()),
            detail: serde_json::json!({ "paths": ["src/a.ts"] }),
            ..Default::default()
        }
    }

    #[test]
    fn duplicates_are_ignored_and_secrets_redacted() {
        let conn = db();
        // Built at run time so the source never holds a token-shaped literal (GitHub push protection).
        let secret = format!("token {}", ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat());
        let first = record(&conn, kept("w1", &secret)).unwrap();
        assert!(first.is_some());
        assert!(record(&conn, kept("w1", &secret)).unwrap().is_none(), "same event twice");
        let rows = list(&conn, &Filter::default()).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].response.as_deref().unwrap().contains("ghp_abc"));
        assert!(!rows[0].training_allowed, "training is off unless the workspace turns it on");
        assert_eq!(rows[0].quality, "unreviewed");
    }

    #[test]
    fn the_training_switch_applies_to_new_and_old_rows() {
        let conn = db();
        record(&conn, kept("w1", "a")).unwrap();
        set_training_allowed(&conn, "w1", true).unwrap();
        record(&conn, kept("w1", "b")).unwrap();
        record(&conn, kept("w2", "c")).unwrap();
        let w1 = list(&conn, &Filter { workspace_id: Some("w1".into()), ..Default::default() }).unwrap();
        assert!(w1.iter().all(|e| e.training_allowed));
        let w2 = list(&conn, &Filter { workspace_id: Some("w2".into()), ..Default::default() }).unwrap();
        assert!(w2.iter().all(|e| !e.training_allowed));
    }

    #[test]
    fn quality_filter_export_and_clear() {
        let conn = db();
        let id = record(&conn, kept("w1", "x")).unwrap().unwrap();
        record(&conn, kept("w2", "y")).unwrap();
        set_quality(&conn, &id, "approved").unwrap();
        set_quality(&conn, &id, "bogus").unwrap();
        assert_eq!(get(&conn, &id).unwrap().unwrap().quality, "unreviewed", "an unknown quality is not stored");
        set_quality(&conn, &id, "approved").unwrap();
        let approved = list(&conn, &Filter { quality: Some("approved".into()), ..Default::default() }).unwrap();
        assert_eq!(approved.len(), 1);
        let jsonl = export_jsonl(&conn, &Filter::default()).unwrap();
        assert_eq!(jsonl.lines().count(), 2);
        assert_eq!(counts(&conn, Some("w1")).unwrap(), vec![("accepted".to_string(), 1)]);
        assert_eq!(clear(&conn, Some("w1")).unwrap(), 1);
        assert_eq!(list(&conn, &Filter::default()).unwrap().len(), 1);
    }

    #[test]
    fn old_rows_are_swept() {
        let conn = db();
        let id = record(&conn, kept("w1", "old")).unwrap().unwrap();
        conn.execute("UPDATE ai_experiences SET created_at = 0 WHERE id = ?1", params![id]).unwrap();
        assert!(list(&conn, &Filter::default()).unwrap().is_empty());
    }
}
