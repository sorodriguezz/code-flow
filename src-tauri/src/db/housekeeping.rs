//! Keeping `codeflow.db` from growing for ever.
//!
//! Three things, run off the boot path (see `start`) and then once a day:
//!
//! - **Retention** for the histories nothing else prunes. Past reviews and analyses
//!   (`job_history`, `workspace_activity`) hold the whole markdown of each run, tens of kilobytes a
//!   row; a run goes only when it is both beyond the newest [`KEEP_RUNS`] of its repository and
//!   older than [`KEEP_RUN_DAYS`] — what nobody scrolls back to. Chat conversations
//!   (`activity_log`) are never deleted here, they are the user's; only the *trace* of an old turn
//!   (the tool-by-tool log behind the answer, the bulk of the row) is cleared after
//!   [`KEEP_TRACE_DAYS`].
//! - **Giving the space back.** SQLite never shrinks a file on its own: deleted rows become free
//!   pages inside it. The database is switched once to `auto_vacuum = INCREMENTAL` (which takes one
//!   full `VACUUM` — done here, in the background, never at boot) and from then on each pass
//!   returns the free pages with `incremental_vacuum`.
//! - **`PRAGMA optimize`**, which refreshes the planner's statistics where they are stale.

use std::time::Duration;

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

const KEEP_RUNS: i64 = 200;
const KEEP_RUN_DAYS: i64 = 180;
const KEEP_TRACE_DAYS: i64 = 90;

/// `auto_vacuum`'s value for INCREMENTAL.
const INCREMENTAL: i64 = 2;

/// Starts the daily pass, its first a minute after launch so it never competes with the boot.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("db-housekeeping".into()).spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        loop {
            if let Some(db) = app.try_state::<super::Db>() {
                if let Ok(conn) = db.0.lock() {
                    if let Err(e) = run(&conn, chrono::Utc::now()) {
                        crate::applog::info(&format!("db: housekeeping failed — {e}"));
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(24 * 60 * 60));
        }
    });
}

pub fn run(conn: &Connection, now: chrono::DateTime<chrono::Utc>) -> rusqlite::Result<()> {
    prune(conn, now)?;
    // The one-time switch. `auto_vacuum` only takes effect through a `VACUUM`, which rewrites the
    // file: seconds on a large database, holding the lock — hence here, and only once.
    let mode: i64 = conn.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
    if mode != INCREMENTAL {
        conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;")?;
    } else {
        conn.execute_batch("PRAGMA incremental_vacuum;")?;
    }
    conn.execute_batch("PRAGMA optimize;")
}

fn prune(conn: &Connection, now: chrono::DateTime<chrono::Utc>) -> rusqlite::Result<()> {
    let runs_before = (now - chrono::Duration::days(KEEP_RUN_DAYS)).to_rfc3339();
    for (table, scope) in [("job_history", "project_id"), ("workspace_activity", "workspace_id")] {
        conn.execute(
            &format!(
                "DELETE FROM {table} WHERE created_at < ?1 AND id IN (
                     SELECT id FROM (
                         SELECT id, ROW_NUMBER() OVER (PARTITION BY {scope} ORDER BY created_at DESC, id DESC) AS n
                         FROM {table}
                     ) WHERE n > ?2
                 )"
            ),
            params![runs_before, KEEP_RUNS],
        )?;
    }
    let traces_before = (now - chrono::Duration::days(KEEP_TRACE_DAYS)).to_rfc3339();
    conn.execute(
        "UPDATE activity_log SET trace = NULL WHERE trace IS NOT NULL AND created_at < ?1",
        params![traces_before],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE job_history (id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT);
             CREATE TABLE workspace_activity (id TEXT PRIMARY KEY, workspace_id TEXT, created_at TEXT);
             CREATE TABLE activity_log (id TEXT PRIMARY KEY, trace TEXT, created_at TEXT);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn keeps_the_newest_runs_and_every_recent_one() {
        let conn = db();
        let now = chrono::Utc::now();
        // 250 old runs in one project, 10 recent in another.
        for i in 0..250 {
            let at = (now - chrono::Duration::days(400) + chrono::Duration::minutes(i)).to_rfc3339();
            conn.execute("INSERT INTO job_history VALUES (?1, 'p1', ?2)", params![format!("a{i}"), at]).unwrap();
        }
        for i in 0..10 {
            conn.execute("INSERT INTO job_history VALUES (?1, 'p2', ?2)", params![format!("b{i}"), now.to_rfc3339()]).unwrap();
        }
        prune(&conn, now).unwrap();
        let left = |p: &str| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM job_history WHERE project_id = ?1", [p], |r| r.get(0)).unwrap()
        };
        assert_eq!(left("p1"), KEEP_RUNS);
        assert_eq!(left("p2"), 10);
        // The oldest went, not the newest.
        let gone: i64 = conn.query_row("SELECT COUNT(*) FROM job_history WHERE id = 'a0'", [], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0);
    }

    #[test]
    fn clears_only_old_traces() {
        let conn = db();
        let now = chrono::Utc::now();
        let old = (now - chrono::Duration::days(100)).to_rfc3339();
        conn.execute("INSERT INTO activity_log VALUES ('old', 'x', ?1)", [old]).unwrap();
        conn.execute("INSERT INTO activity_log VALUES ('new', 'y', ?1)", [now.to_rfc3339()]).unwrap();
        prune(&conn, now).unwrap();
        let trace = |id: &str| -> Option<String> {
            conn.query_row("SELECT trace FROM activity_log WHERE id = ?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(trace("old"), None);
        assert_eq!(trace("new").as_deref(), Some("y"));
    }

    #[test]
    fn switches_to_incremental_vacuum_once() {
        let path = std::env::temp_dir().join(format!("cf-housekeeping-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE job_history (id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT);
             CREATE TABLE workspace_activity (id TEXT PRIMARY KEY, workspace_id TEXT, created_at TEXT);
             CREATE TABLE activity_log (id TEXT PRIMARY KEY, trace TEXT, created_at TEXT);",
        )
        .unwrap();
        run(&conn, chrono::Utc::now()).unwrap();
        let mode: i64 = conn.query_row("PRAGMA auto_vacuum", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, INCREMENTAL);
        run(&conn, chrono::Utc::now()).unwrap();
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
