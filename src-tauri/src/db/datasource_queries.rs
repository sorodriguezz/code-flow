//! CRUD over the `db_*` tables — the database workspace's connections, consoles and query history.
//!
//! Scoped per workspace the same way `api_queries` is: connections and history carry a
//! `workspace_id`, consoles reach it through their connection. Anything addressed by its own `id`
//! needs no workspace argument.
//!
//! Two things deliberately do *not* live here. Passwords: they are in the OS keychain, and the only
//! thing this module does about them is delete the entry when its connection goes ([`delete_connection`]).
//! And connection *content*: `spec` is stored verbatim as the JSON the driver layer will parse, so
//! adding an engine or a driver option needs no change in this file.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{DbConnectionRow, DbConsole, DbQueryHistoryEntry, DbWorkspaceTree};
use super::queries::now;

/// Backstop on `add_history`. Well above what the UI lists, so it only stops the table growing
/// without bound over the app's lifetime.
const HISTORY_HARD_CAP: i64 = 2000;

const CONNECTION_COLUMNS: &str =
    "id, workspace_id, name, kind, spec, color, sort_order, created_at, updated_at";
const CONSOLE_COLUMNS: &str =
    "id, connection_id, name, body, database_name, schema_name, sort_order, created_at, updated_at";
const HISTORY_COLUMNS: &str = "id, workspace_id, connection_id, connection_name, statement, \
                               database_name, duration_ms, row_count, error, ran_at";

fn map_connection(row: &rusqlite::Row) -> rusqlite::Result<DbConnectionRow> {
    Ok(DbConnectionRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        kind: row.get(3)?,
        spec: row.get(4)?,
        color: row.get(5)?,
        sort_order: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn map_console(row: &rusqlite::Row) -> rusqlite::Result<DbConsole> {
    Ok(DbConsole {
        id: row.get(0)?,
        connection_id: row.get(1)?,
        name: row.get(2)?,
        body: row.get(3)?,
        database_name: row.get(4)?,
        schema_name: row.get(5)?,
        sort_order: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn map_history(row: &rusqlite::Row) -> rusqlite::Result<DbQueryHistoryEntry> {
    Ok(DbQueryHistoryEntry {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        connection_id: row.get(2)?,
        connection_name: row.get(3)?,
        statement: row.get(4)?,
        database_name: row.get(5)?,
        duration_ms: row.get(6)?,
        row_count: row.get(7)?,
        error: row.get(8)?,
        ran_at: row.get(9)?,
    })
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/// One workspace's connections and every console under them, in one round trip. The UI nests them
/// client-side.
pub fn load_tree(conn: &Connection, workspace_id: &str) -> rusqlite::Result<DbWorkspaceTree> {
    let mut statement = conn.prepare(&format!(
        "SELECT {CONNECTION_COLUMNS} FROM db_connections WHERE workspace_id = ?1 \
         ORDER BY sort_order, name"
    ))?;
    let connections = statement
        .query_map(params![workspace_id], map_connection)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Joined through the connection rather than filtered on a column of its own — a console's
    // workspace is whatever its connection's is, and storing it twice is a way for the two to
    // disagree.
    let mut statement = conn.prepare(&format!(
        "SELECT {} FROM db_consoles c \
         JOIN db_connections n ON n.id = c.connection_id \
         WHERE n.workspace_id = ?1 ORDER BY c.sort_order, c.created_at",
        CONSOLE_COLUMNS.split(", ").map(|c| format!("c.{c}")).collect::<Vec<_>>().join(", ")
    ))?;
    let consoles = statement
        .query_map(params![workspace_id], map_console)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(DbWorkspaceTree { connections, consoles })
}

pub fn get_connection(conn: &Connection, id: &str) -> rusqlite::Result<Option<DbConnectionRow>> {
    conn.query_row(
        &format!("SELECT {CONNECTION_COLUMNS} FROM db_connections WHERE id = ?1"),
        params![id],
        map_connection,
    )
    .optional()
}

pub fn create_connection(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
    kind: &str,
    spec: &str,
    color: &str,
) -> rusqlite::Result<DbConnectionRow> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM db_connections WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO db_connections (id, workspace_id, name, kind, spec, color, sort_order, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, workspace_id, name, kind, spec, color, sort_order, timestamp],
    )?;
    Ok(DbConnectionRow {
        id,
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        spec: spec.to_string(),
        color: color.to_string(),
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub fn update_connection(conn: &Connection, row: &DbConnectionRow) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE db_connections SET name = ?2, kind = ?3, spec = ?4, color = ?5, sort_order = ?6, \
         updated_at = ?7 WHERE id = ?1",
        params![row.id, row.name, row.kind, row.spec, row.color, row.sort_order, now()],
    )?;
    Ok(())
}

/// Deletes the connection, its consoles (by cascade) and its keychain password.
///
/// The keychain entry has to go with it: leaving it behind would mean a new connection that happens
/// to reuse the id — which `Uuid::new_v4` makes vanishingly unlikely, but a restore from backup does
/// not — would silently inherit a stranger's password. A keychain failure is not allowed to block
/// the delete; the row is what the user asked to remove.
pub fn delete_connection(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let _ = crate::secrets::delete_secret(&crate::datasource::password_key(id));
    conn.execute("DELETE FROM db_connections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn duplicate_connection(conn: &Connection, id: &str) -> rusqlite::Result<DbConnectionRow> {
    let source = get_connection(conn, id)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    // The copy deliberately does not carry the password across. Copying a credential silently is
    // the sort of thing that makes two connections share one secret without anybody deciding to.
    create_connection(
        conn,
        &source.workspace_id,
        &format!("{} copy", source.name),
        &source.kind,
        &source.spec,
        &source.color,
    )
}

pub fn reorder_connections(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let timestamp = now();
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE db_connections SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, index as i64, timestamp],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Consoles
// ---------------------------------------------------------------------------

pub fn create_console(
    conn: &Connection,
    connection_id: &str,
    name: &str,
    body: &str,
    database_name: &str,
    schema_name: &str,
) -> rusqlite::Result<DbConsole> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM db_consoles WHERE connection_id = ?1",
            params![connection_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO db_consoles (id, connection_id, name, body, database_name, schema_name, sort_order, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, connection_id, name, body, database_name, schema_name, sort_order, timestamp],
    )?;
    Ok(DbConsole {
        id,
        connection_id: connection_id.to_string(),
        name: name.to_string(),
        body: body.to_string(),
        database_name: database_name.to_string(),
        schema_name: schema_name.to_string(),
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub fn update_console(conn: &Connection, console: &DbConsole) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE db_consoles SET name = ?2, body = ?3, database_name = ?4, schema_name = ?5, \
         sort_order = ?6, updated_at = ?7 WHERE id = ?1",
        params![
            console.id,
            console.name,
            console.body,
            console.database_name,
            console.schema_name,
            console.sort_order,
            now()
        ],
    )?;
    Ok(())
}

pub fn delete_console(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM db_consoles WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

pub fn list_history(
    conn: &Connection,
    workspace_id: &str,
    limit: i64,
) -> rusqlite::Result<Vec<DbQueryHistoryEntry>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {HISTORY_COLUMNS} FROM db_query_history WHERE workspace_id = ?1 \
         ORDER BY ran_at DESC LIMIT ?2"
    ))?;
    let entries = statement
        .query_map(params![workspace_id, limit.max(1)], map_history)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(entries)
}

pub fn add_history(
    conn: &Connection,
    entry: &DbQueryHistoryEntry,
) -> rusqlite::Result<DbQueryHistoryEntry> {
    let id = Uuid::new_v4().to_string();
    let ran_at = if entry.ran_at.is_empty() { now() } else { entry.ran_at.clone() };
    conn.execute(
        "INSERT INTO db_query_history (id, workspace_id, connection_id, connection_name, statement, \
         database_name, duration_ms, row_count, error, ran_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            entry.workspace_id,
            entry.connection_id,
            entry.connection_name,
            entry.statement,
            entry.database_name,
            entry.duration_ms,
            entry.row_count,
            entry.error,
            ran_at
        ],
    )?;
    conn.execute(
        "DELETE FROM db_query_history WHERE workspace_id = ?1 AND id NOT IN \
         (SELECT id FROM db_query_history WHERE workspace_id = ?1 ORDER BY ran_at DESC LIMIT ?2)",
        params![entry.workspace_id, HISTORY_HARD_CAP],
    )?;
    Ok(DbQueryHistoryEntry { id, ran_at, ..entry.clone() })
}

pub fn delete_history(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM db_query_history WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear_history(conn: &Connection, workspace_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM db_query_history WHERE workspace_id = ?1", params![workspace_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) \
             VALUES ('w1', 'W', '', '', 0, 't')",
            [],
        )
        .unwrap();
        conn
    }

    /// Consoles reach their workspace through their connection, so the join has to be what scopes
    /// them — a console must never show up under another workspace's tree.
    #[test]
    fn the_tree_is_scoped_by_workspace_through_the_connection() {
        let conn = setup();
        conn.execute(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) \
             VALUES ('w2', 'Other', '', '', 1, 't')",
            [],
        )
        .unwrap();
        let mine = create_connection(&conn, "w1", "Local", "postgres", "{}", "").unwrap();
        let theirs = create_connection(&conn, "w2", "Theirs", "postgres", "{}", "").unwrap();
        create_console(&conn, &mine.id, "Console 1", "SELECT 1", "app", "public").unwrap();
        create_console(&conn, &theirs.id, "Theirs", "SELECT 2", "", "").unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(tree.connections.len(), 1);
        assert_eq!(tree.consoles.len(), 1);
        assert_eq!(tree.consoles[0].body, "SELECT 1");
        assert_eq!(tree.consoles[0].database_name, "app");
    }

    /// Deleting a connection takes its consoles with it — otherwise they'd linger as rows nothing
    /// can reach, and reappear if the id were ever reused.
    #[test]
    fn deleting_a_connection_cascades_to_its_consoles() {
        let conn = setup();
        let connection = create_connection(&conn, "w1", "Local", "postgres", "{}", "").unwrap();
        create_console(&conn, &connection.id, "C", "", "", "").unwrap();
        delete_connection(&conn, &connection.id).unwrap();
        assert_eq!(load_tree(&conn, "w1").unwrap().consoles.len(), 0);
    }

    /// History outlives the connection it ran against: the record of "what did I run last Tuesday"
    /// must not disappear because the connection was tidied up.
    #[test]
    fn history_survives_its_connection() {
        let conn = setup();
        let connection = create_connection(&conn, "w1", "Prod", "postgres", "{}", "").unwrap();
        add_history(
            &conn,
            &DbQueryHistoryEntry {
                id: String::new(),
                workspace_id: "w1".into(),
                connection_id: connection.id.clone(),
                connection_name: "Prod".into(),
                statement: "SELECT 1".into(),
                database_name: "app".into(),
                duration_ms: 12,
                row_count: 1,
                error: String::new(),
                ran_at: String::new(),
            },
        )
        .unwrap();
        delete_connection(&conn, &connection.id).unwrap();

        let history = list_history(&conn, "w1", 50).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].connection_name, "Prod", "the name is all that still identifies it");
        assert!(!history[0].ran_at.is_empty(), "an empty timestamp is stamped on insert");
    }

    /// A duplicate is a starting point, not a clone of the credential.
    #[test]
    fn a_duplicate_does_not_inherit_the_password() {
        let conn = setup();
        let source =
            create_connection(&conn, "w1", "Prod", "postgres", "{\"host\":\"db\"}", "#f00").unwrap();
        let copy = duplicate_connection(&conn, &source.id).unwrap();
        assert_ne!(copy.id, source.id);
        assert_eq!(copy.name, "Prod copy");
        assert_eq!(copy.spec, source.spec);
        assert_eq!(copy.sort_order, 1);
    }
}
