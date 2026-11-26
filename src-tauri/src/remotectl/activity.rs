//! What paired devices did on this machine, kept to be read later.
//!
//! The notification centre already says "commit desde un dispositivo" the moment it happens — and
//! forgets it when the app closes, because it is session state. That is the right lifetime for a
//! notification and the wrong one for the question somebody asks the morning after leaving a phone
//! on a café table: *what did that device do?* This is the answer that survives a restart.
//!
//! One row per act [`dispatch::announce_for`](super::dispatch::announce_for) names — the same
//! judgement about what is worth telling a person, reused rather than made twice — plus the writes a
//! read-only device was refused, which are exactly what the owner of a lent phone wants to see.

use rusqlite::{params, Connection};
use serde::Serialize;

/// How many rows are kept. A log somebody reads, not an archive: at a few dozen acts a day this is
/// weeks, and past it the oldest go.
const KEEP: i64 = 500;

/// One recorded act, as the settings panel shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: i64,
    pub device_id: String,
    pub device_name: String,
    /// A `remote.action.*` key. Rendered by the desk in its own language, like the notification.
    pub action: String,
    /// `ok`, `error` or `refused`.
    pub status: String,
    pub detail: String,
    pub created_at: String,
}

/// How a recorded act ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// It ran and failed on its own terms — a push rejected, a commit with nothing staged.
    Failed,
    /// A read-only device asked to write. Nothing ran.
    Refused,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Done => "ok",
            Outcome::Failed => "error",
            Outcome::Refused => "refused",
        }
    }
}

/// Files one act and trims the log. Never fails the call it is recording: a log that cannot be
/// written must not turn a commit that succeeded into an error on somebody's phone.
pub fn record(conn: &Connection, device_id: &str, device_name: &str, action: &str, outcome: Outcome, detail: &str) {
    let detail: String = detail.chars().take(160).collect();
    let _ = conn.execute(
        "INSERT INTO remote_activity (device_id, device_name, action, status, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![device_id, device_name, action, outcome.as_str(), detail, crate::db::queries::now()],
    );
    let _ = conn.execute(
        "DELETE FROM remote_activity WHERE id <= (SELECT MAX(id) FROM remote_activity) - ?1",
        params![KEEP],
    );
}

/// The newest acts first.
pub fn list(conn: &Connection, limit: i64) -> Result<Vec<Activity>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, device_id, device_name, action, status, detail, created_at
             FROM remote_activity ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit.clamp(1, KEEP)], |row| {
            Ok(Activity {
                id: row.get(0)?,
                device_id: row.get(1)?,
                device_name: row.get(2)?,
                action: row.get(3)?,
                status: row.get(4)?,
                detail: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// Empties the log — the panel's "clear" button.
pub fn clear(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM remote_activity", []).map_err(|e| e.to_string())?;
    Ok(())
}

/// What a call was about, when it named something short enough to put beside the act: the folder
/// name of the repository. Never the path — the row is shown in a narrow list — and never free text
/// from the request (a commit message, a chat turn), which is the user's content and not a label.
pub fn subject(args: &serde_json::Value) -> String {
    args.get("repoPath")
        .or_else(|| args.get("repo_path"))
        .and_then(serde_json::Value::as_str)
        .and_then(|path| path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn acts_are_listed_newest_first_with_how_they_ended() {
        let conn = db();
        record(&conn, "d1", "iPhone", "remote.action.commit", Outcome::Done, "api");
        record(&conn, "d1", "iPhone", "remote.action.push", Outcome::Failed, "api");
        record(&conn, "d2", "Tablet", "remote.action.commit", Outcome::Refused, "web");

        let rows = list(&conn, 50).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[0].device_name.as_str(), rows[0].status.as_str()), ("Tablet", "refused"));
        assert_eq!((rows[1].action.as_str(), rows[1].status.as_str()), ("remote.action.push", "error"));
        assert_eq!(rows[2].status, "ok");

        clear(&conn).unwrap();
        assert!(list(&conn, 50).unwrap().is_empty());
    }

    /// A log, not an archive: past the cap the oldest rows go, and the newest are the ones kept.
    #[test]
    fn the_log_is_trimmed_to_the_newest() {
        let conn = db();
        for n in 0..(KEEP + 25) {
            record(&conn, "d1", "iPhone", "remote.action.commit", Outcome::Done, &n.to_string());
        }
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM remote_activity", [], |r| r.get(0)).unwrap();
        assert_eq!(count, KEEP);
        assert_eq!(list(&conn, 1).unwrap()[0].detail, (KEEP + 24).to_string());
    }

    /// The label is the repository's folder name, on either platform's separators, and nothing
    /// else a request carries.
    #[test]
    fn the_subject_is_the_repository_folder_and_never_request_text() {
        assert_eq!(subject(&serde_json::json!({ "repoPath": "/home/dev/work/api/" })), "api");
        assert_eq!(subject(&serde_json::json!({ "repoPath": "C:\\work\\web" })), "web");
        assert_eq!(subject(&serde_json::json!({ "message": "secreto", "projectId": "p1" })), "");
    }
}
