//! The API client's mock rules, one JSON blob per collection (`api_mocks`, see `migrations.rs`).
//!
//! A table of its own rather than a column on `api_collections`, because collections travel — a
//! shared one is diffed and pushed by `api_sync`, exported and backed up — and a mock is a property
//! of this machine: which port it listens on, whether it starts with the services. Keeping it out of
//! the collection row keeps it out of every one of those paths without each having to strip it.

use rusqlite::{params, Connection, OptionalExtension};

use super::queries::now;

/// The saved config, or `None` when the collection never had a mock.
pub fn get(conn: &Connection, collection_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT config FROM api_mocks WHERE collection_id = ?1", params![collection_id], |row| row.get(0))
        .optional()
}

pub fn save(conn: &Connection, collection_id: &str, config: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_mocks (collection_id, config, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(collection_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
        params![collection_id, config, now()],
    )?;
    Ok(())
}

/// Every mock config in a workspace (global collections included), with each collection's name —
/// what the Services dock lists.
pub fn list_for_workspace(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT m.collection_id, c.name, m.config FROM api_mocks m
         JOIN api_collections c ON c.id = m.collection_id
         WHERE c.workspace_id = ?1 OR c.scope = 'global'
         ORDER BY c.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    rows.collect()
}

/// The collection's name and workspace, for a mock's status line.
pub fn collection_meta(conn: &Connection, collection_id: &str) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row(
        "SELECT name, workspace_id FROM api_collections WHERE id = ?1",
        params![collection_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_lists_and_cascades() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE api_collections (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, scope TEXT DEFAULT 'workspace');
             INSERT INTO api_collections (id, workspace_id, name) VALUES ('c1', 'w1', 'Shop'), ('c2', 'w2', 'Other');",
        )
        .unwrap();
        crate::db::migrations::add_api_mocks(&conn).unwrap();
        assert_eq!(get(&conn, "c1").unwrap(), None);
        save(&conn, "c1", "{\"port\":0}").unwrap();
        save(&conn, "c1", "{\"port\":4010}").unwrap();
        save(&conn, "c2", "{}").unwrap();
        assert_eq!(get(&conn, "c1").unwrap().as_deref(), Some("{\"port\":4010}"));
        let listed = list_for_workspace(&conn, "w1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].1, "Shop");
        conn.execute("DELETE FROM api_collections WHERE id = 'c1'", []).unwrap();
        assert_eq!(get(&conn, "c1").unwrap(), None);
    }
}
