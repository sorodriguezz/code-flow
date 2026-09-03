//! Past versions of a note or a diagram.
//!
//! Notes and diagrams autosave, and they are the two workspaces in this app whose content is
//! *original* — everywhere else the file system or git is the undo. Here there was none: a
//! select-all and a keystroke was final the moment the editor session ended. The DBML workbench
//! next door has had a history panel since it shipped, which is what made the absence conspicuous.
//!
//! **The design is deliberately blunt: whole snapshots, not diffs.** These documents are kilobytes;
//! the reader wants to look at one and put it back, not reconstruct it; and a chain of diffs is a
//! chain that breaks in the middle. What keeps that affordable is the throttle and the cap below.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// How many versions one document keeps. Older ones are pruned on every save.
///
/// Fifty is chosen against the throttle: at one version every two minutes of active editing, fifty
/// is roughly a day and a half of work on one document — past the point where anybody is trying to
/// recover something, and small enough that the whole list draws without paging.
const MAX_VERSIONS: i64 = 50;

/// The shortest gap between two versions of the same document, in seconds.
///
/// Without it, autosave would write a version every few seconds and the list would be a hundred
/// snapshots of the same paragraph being typed. Two minutes is long enough that consecutive entries
/// are recognisably different and short enough that an accidental deletion is never more than two
/// minutes from a snapshot that predates it.
const THROTTLE_SECONDS: i64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocVersion {
    pub id: String,
    pub kind: String,
    pub doc_id: String,
    pub title: String,
    pub created_at: String,
    /// Characters, so the list can say "12 KB" without carrying the content of fifty versions.
    pub size: i64,
}

/// A version's full text — asked for one at a time, when the reader opens one.
pub fn version_content(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT content FROM doc_versions WHERE id = ?1", params![id], |row| {
        row.get(0)
    })
    .optional()
}

/// One document's versions, newest first, without their bodies.
pub fn list_versions(conn: &Connection, kind: &str, doc_id: &str) -> rusqlite::Result<Vec<DocVersion>> {
    let mut statement = conn.prepare(
        "SELECT id, kind, doc_id, title, created_at, LENGTH(content) FROM doc_versions \
         WHERE kind = ?1 AND doc_id = ?2 ORDER BY created_at DESC",
    )?;
    let rows = statement
        .query_map(params![kind, doc_id], |row| {
            Ok(DocVersion {
                id: row.get(0)?,
                kind: row.get(1)?,
                doc_id: row.get(2)?,
                title: row.get(3)?,
                created_at: row.get(4)?,
                size: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Records a version, unless one was recorded recently or nothing changed.
///
/// Returns whether a row was written, which the tests assert on and nothing else reads.
///
/// Three guards, in the order they are cheapest to check:
///
/// 1. **Nothing to record.** An empty document has no history worth keeping.
/// 2. **Unchanged since the last version.** Autosave fires on a timer, not only on an edit, so
///    without this a document left open would accumulate identical snapshots all afternoon.
/// 3. **Too soon.** See `THROTTLE_SECONDS`.
pub fn record_version(
    conn: &Connection,
    kind: &str,
    doc_id: &str,
    title: &str,
    content: &str,
    now: &str,
) -> rusqlite::Result<bool> {
    if content.trim().is_empty() {
        return Ok(false);
    }

    let latest: Option<(String, String)> = conn
        .query_row(
            "SELECT created_at, content FROM doc_versions WHERE kind = ?1 AND doc_id = ?2 \
             ORDER BY created_at DESC LIMIT 1",
            params![kind, doc_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    if let Some((created_at, previous)) = latest {
        if previous == content {
            return Ok(false);
        }
        // String comparison on RFC3339 timestamps is only ordering, not arithmetic — so the gap is
        // measured by parsing. A timestamp that cannot be parsed (a row from a hand-edited
        // database) is treated as "long ago", which errs towards keeping history rather than
        // dropping it.
        let recent = chrono::DateTime::parse_from_rfc3339(&created_at)
            .ok()
            .zip(chrono::DateTime::parse_from_rfc3339(now).ok())
            .map(|(then, current)| (current - then).num_seconds() < THROTTLE_SECONDS)
            .unwrap_or(false);
        if recent {
            return Ok(false);
        }
    }

    conn.execute(
        "INSERT INTO doc_versions (id, kind, doc_id, title, content, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![uuid::Uuid::new_v4().to_string(), kind, doc_id, title, content, now],
    )?;

    // Pruned here rather than on a timer: the only moment the list can grow is this one, so it is
    // the only moment it can need trimming.
    conn.execute(
        "DELETE FROM doc_versions WHERE kind = ?1 AND doc_id = ?2 AND id NOT IN ( \
             SELECT id FROM doc_versions WHERE kind = ?1 AND doc_id = ?2 \
             ORDER BY created_at DESC LIMIT ?3 \
         )",
        params![kind, doc_id, MAX_VERSIONS],
    )?;

    Ok(true)
}

/// Drops every version of one document — what a *permanent* delete of the document does.
///
/// Not wired to a cascade on purpose: a version's whole job is to outlive a mistake, and deleting
/// the history along with the document would delete it exactly when somebody wants it. This is
/// called from the paths that mean "and never mind the history either".
pub fn delete_versions(conn: &Connection, kind: &str, doc_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM doc_versions WHERE kind = ?1 AND doc_id = ?2",
        params![kind, doc_id],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE doc_versions (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, doc_id TEXT NOT NULL,
                content TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    /// `minutes` after a fixed origin, as RFC3339.
    fn at(minutes: i64) -> String {
        (chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap()
            + chrono::Duration::minutes(minutes))
        .to_rfc3339()
    }

    #[test]
    fn the_first_save_is_recorded() {
        let conn = db();
        assert!(record_version(&conn, "note", "n1", "Title", "hello", &at(0)).unwrap());
        assert_eq!(list_versions(&conn, "note", "n1").unwrap().len(), 1);
    }

    #[test]
    fn an_empty_document_records_nothing() {
        let conn = db();
        assert!(!record_version(&conn, "note", "n1", "Title", "   ", &at(0)).unwrap());
        assert!(list_versions(&conn, "note", "n1").unwrap().is_empty());
    }

    #[test]
    fn an_unchanged_save_records_nothing_however_long_it_has_been() {
        let conn = db();
        record_version(&conn, "note", "n1", "T", "same", &at(0)).unwrap();
        // Well past the throttle, and still nothing: autosave fires on a timer, not only on edits.
        assert!(!record_version(&conn, "note", "n1", "T", "same", &at(600)).unwrap());
        assert_eq!(list_versions(&conn, "note", "n1").unwrap().len(), 1);
    }

    #[test]
    fn a_change_within_the_throttle_waits() {
        let conn = db();
        record_version(&conn, "note", "n1", "T", "one", &at(0)).unwrap();
        assert!(!record_version(&conn, "note", "n1", "T", "two", &at(1)).unwrap());
        assert!(record_version(&conn, "note", "n1", "T", "three", &at(3)).unwrap());
        assert_eq!(list_versions(&conn, "note", "n1").unwrap().len(), 2);
    }

    #[test]
    fn versions_come_back_newest_first() {
        let conn = db();
        record_version(&conn, "note", "n1", "first", "a", &at(0)).unwrap();
        record_version(&conn, "note", "n1", "second", "b", &at(5)).unwrap();
        let rows = list_versions(&conn, "note", "n1").unwrap();
        assert_eq!(rows[0].title, "second");
        assert_eq!(rows[1].title, "first");
        assert_eq!(rows[0].size, 1, "the size is reported without carrying the body");
    }

    #[test]
    fn the_list_is_capped_and_drops_the_oldest() {
        let conn = db();
        for minute in 0..(MAX_VERSIONS + 10) {
            record_version(&conn, "note", "n1", "T", &format!("v{minute}"), &at(minute * 3)).unwrap();
        }
        let rows = list_versions(&conn, "note", "n1").unwrap();
        assert_eq!(rows.len() as i64, MAX_VERSIONS);
        // The newest survived and the oldest did not.
        assert_eq!(
            version_content(&conn, &rows[0].id).unwrap().unwrap(),
            format!("v{}", MAX_VERSIONS + 9)
        );
        assert!(!rows.iter().any(|row| row.created_at == at(0)));
    }

    #[test]
    fn documents_and_kinds_keep_separate_histories() {
        let conn = db();
        record_version(&conn, "note", "n1", "T", "a", &at(0)).unwrap();
        record_version(&conn, "note", "n2", "T", "b", &at(0)).unwrap();
        // Same id, different kind — a note and a diagram must not share a history.
        record_version(&conn, "diagram", "n1", "T", "c", &at(0)).unwrap();

        assert_eq!(list_versions(&conn, "note", "n1").unwrap().len(), 1);
        assert_eq!(list_versions(&conn, "diagram", "n1").unwrap().len(), 1);

        delete_versions(&conn, "note", "n1").unwrap();
        assert!(list_versions(&conn, "note", "n1").unwrap().is_empty());
        assert_eq!(list_versions(&conn, "note", "n2").unwrap().len(), 1, "n2 is untouched");
        assert_eq!(list_versions(&conn, "diagram", "n1").unwrap().len(), 1, "the diagram is untouched");
    }
}
