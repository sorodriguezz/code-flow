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

use super::models::{
    DbConnectionRow, DbConsole, DbGroupRow, DbQueryHistoryEntry, DbWorkspaceTree,
};
use super::queries::now;

/// Backstop on `add_history`. Well above what the UI lists, so it only stops the table growing
/// without bound over the app's lifetime.
const HISTORY_HARD_CAP: i64 = 2000;

const CONNECTION_COLUMNS: &str =
    "id, workspace_id, name, group_name, kind, spec, color, sort_order, created_at, updated_at, scope";
const GROUP_COLUMNS: &str = "id, workspace_id, name, sort_order, created_at, scope";
const CONSOLE_COLUMNS: &str =
    "id, connection_id, name, body, database_name, schema_name, sort_order, created_at, updated_at";
const HISTORY_COLUMNS: &str = "id, workspace_id, connection_id, connection_name, statement, \
                               database_name, duration_ms, row_count, error, ran_at";

fn map_connection(row: &rusqlite::Row) -> rusqlite::Result<DbConnectionRow> {
    Ok(DbConnectionRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        group_name: row.get(3)?,
        kind: row.get(4)?,
        spec: row.get(5)?,
        color: row.get(6)?,
        sort_order: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        scope: row.get(10)?,
    })
}

fn map_group(row: &rusqlite::Row) -> rusqlite::Result<DbGroupRow> {
    Ok(DbGroupRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        scope: row.get(5)?,
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

/// One workspace's connections, groups and every console under them, in one round trip. The UI
/// nests them client-side.
///
/// The groups come back as their own list rather than being derived from the connections, because
/// the two disagree in both directions and the tree needs both halves: a group row with no member
/// is a folder the user made and hasn't filled, and a `group_name` with no row is a connection
/// dragged into a name nobody created. The tree unions them.
pub fn load_tree(conn: &Connection, workspace_id: &str) -> rusqlite::Result<DbWorkspaceTree> {
    let mut statement = conn.prepare(&format!(
        "SELECT {CONNECTION_COLUMNS} FROM db_connections WHERE workspace_id = ?1 OR scope = 'global' \
         ORDER BY sort_order, name"
    ))?;
    let connections = statement
        .query_map(params![workspace_id], map_connection)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare(&format!(
        "SELECT {GROUP_COLUMNS} FROM db_groups WHERE workspace_id = ?1 OR scope = 'global' \
         ORDER BY sort_order, name"
    ))?;
    let groups = statement
        .query_map(params![workspace_id], map_group)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Joined through the connection rather than filtered on a column of its own — a console's
    // workspace is whatever its connection's is, and storing it twice is a way for the two to
    // disagree.
    let mut statement = conn.prepare(&format!(
        "SELECT {} FROM db_consoles c \
         JOIN db_connections n ON n.id = c.connection_id \
         WHERE n.workspace_id = ?1 OR n.scope = 'global' ORDER BY c.sort_order, c.created_at",
        CONSOLE_COLUMNS.split(", ").map(|c| format!("c.{c}")).collect::<Vec<_>>().join(", ")
    ))?;
    let consoles = statement
        .query_map(params![workspace_id], map_console)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(DbWorkspaceTree { connections, groups, consoles })
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
    group_name: &str,
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
    // A connection made inside a group that is already global is global too — otherwise it would
    // be filed in a folder every workspace can see and be invisible from all but one of them.
    let scope: String = conn
        .query_row(
            "SELECT scope FROM db_groups WHERE (workspace_id = ?1 OR scope = 'global') AND name = ?2",
            params![workspace_id, group_name],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "workspace".to_string());
    conn.execute(
        "INSERT INTO db_connections (id, workspace_id, name, group_name, kind, spec, color, sort_order, created_at, updated_at, scope) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)",
        params![id, workspace_id, name, group_name, kind, spec, color, sort_order, timestamp, scope],
    )?;
    Ok(DbConnectionRow {
        id,
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        group_name: group_name.to_string(),
        kind: kind.to_string(),
        spec: spec.to_string(),
        color: color.to_string(),
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        scope,
    })
}

pub fn update_connection(conn: &Connection, row: &DbConnectionRow) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE db_connections SET name = ?2, group_name = ?3, kind = ?4, spec = ?5, color = ?6, \
         sort_order = ?7, updated_at = ?8 WHERE id = ?1",
        params![
            row.id,
            row.name,
            row.group_name,
            row.kind,
            row.spec,
            row.color,
            row.sort_order,
            now()
        ],
    )?;
    Ok(())
}

/// Moves a connection into a group, or out of every group when `group_name` is empty.
///
/// Its own statement rather than a full `update_connection` because this is the one edit that must
/// not disturb the session: dragging a row between folders says nothing about the server it talks
/// to, and closing a live connection over a filing decision would be a surprise.
pub fn set_connection_group(
    conn: &Connection,
    id: &str,
    group_name: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE db_connections SET group_name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, group_name, now()],
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
        &source.group_name,
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
// Groups
// ---------------------------------------------------------------------------

/// Writes the order the folders are drawn in. `ids` is the whole list, in the order wanted.
///
/// The same shape as [`reorder_connections`], and for the same reason: the caller has the complete
/// list on screen and sending it whole is the only version that cannot leave two rows claiming one
/// position. A group named by a connection but with no row of its own has no id to send and is not
/// orderable — it is drawn after the real folders; see `groupConnections` on the frontend.
pub fn reorder_groups(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE db_groups SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    Ok(())
}

/// Creates an empty group, or returns the one already carrying that name.
///
/// Idempotent on purpose: "New group" typed twice with the same name is a user who wants that
/// group, not an error dialog. The `INSERT OR IGNORE` and the read-back together are what make the
/// unique index a deduplicator rather than a failure mode.
pub fn create_group(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
) -> rusqlite::Result<DbGroupRow> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM db_groups WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;
    conn.execute(
        &format!("INSERT OR IGNORE INTO db_groups ({GROUP_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"),
        params![Uuid::new_v4().to_string(), workspace_id, name, sort_order, now(), "workspace"],
    )?;
    conn.query_row(
        &format!("SELECT {GROUP_COLUMNS} FROM db_groups WHERE workspace_id = ?1 AND name = ?2"),
        params![workspace_id, name],
        map_group,
    )
}

/// Renames a group: its members, and the folder row itself.
///
/// Two writes rather than one because membership and existence are recorded separately — see the
/// tables' comments in `migrations`. The members move whether or not a folder row exists, which is
/// what keeps a group that was only ever implied by its connections renameable.
///
/// **Renaming onto an existing name merges.** The alternative is a unique-index failure the user
/// reads as "you can't call it that", when what they almost always meant was "put these together".
///
/// Every clause here addresses `(workspace_id = ?1 OR scope = 'global')` rather than the workspace
/// alone, and that is not defensive coding — it is what makes the rename match what is on screen.
/// `idx_db_groups_name` is unique per *workspace*, so a global "Prod" and a local "Prod" are two
/// legal rows; `groupConnections` merges them into one bucket in the tree. Addressed by workspace
/// alone, this function would rename half of that bucket and leave the other half behind.
pub fn rename_group(
    conn: &Connection,
    workspace_id: &str,
    from: &str,
    to: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE db_connections SET group_name = ?3, updated_at = ?4 \
         WHERE (workspace_id = ?1 OR scope = 'global') AND group_name = ?2",
        params![workspace_id, from, to, now()],
    )?;

    let target_exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM db_groups WHERE (workspace_id = ?1 OR scope = 'global') AND name = ?2",
        params![workspace_id, to],
        |row| row.get(0),
    )?;
    if target_exists {
        // The members are already there; the source folder is now a duplicate of the target.
        conn.execute(
            "DELETE FROM db_groups WHERE (workspace_id = ?1 OR scope = 'global') AND name = ?2",
            params![workspace_id, from],
        )?;
    } else {
        // `OR IGNORE`: with two scopes in play the rename can still collide on the unique index —
        // a global "Staging" renamed to "Prod" while this workspace has its own "Prod". The
        // members have already moved, which is what the user sees; skipping the folder row leaves
        // the surviving one to render the bucket.
        conn.execute(
            "UPDATE OR IGNORE db_groups SET name = ?3 \
             WHERE (workspace_id = ?1 OR scope = 'global') AND name = ?2",
            params![workspace_id, from, to],
        )?;
    }
    Ok(())
}

/// Deletes a group and turns its members loose.
///
/// **Never the connections.** A folder and the databases filed in it are not the same thing, and a
/// delete that took the connections with it would be the one destructive action in this tree —
/// taking their consoles by cascade, and their keychain entries with them. They move to ungrouped,
/// where they are still there to be found.
pub fn delete_group(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE db_connections SET group_name = '', updated_at = ?3 \
         WHERE (workspace_id = ?1 OR scope = 'global') AND group_name = ?2",
        params![workspace_id, name, now()],
    )?;
    conn.execute(
        "DELETE FROM db_groups WHERE (workspace_id = ?1 OR scope = 'global') AND name = ?2",
        params![workspace_id, name],
    )?;
    Ok(())
}

/// Puts a connection on every workspace's shelf, or takes it back off.
///
/// Its own statement rather than a field on [`update_connection`], and for the reason
/// [`set_connection_group`] gives: this must not disturb the session. Nothing about the server has
/// changed, so a live connection — and the SSH tunnel under it — survives being re-scoped.
pub fn set_connection_scope(conn: &Connection, id: &str, global: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE db_connections SET scope = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, if global { "global" } else { "workspace" }, now()],
    )?;
    Ok(())
}

/// Moves a connection to another workspace and files it there.
pub fn move_connection_to_workspace(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
) -> rusqlite::Result<()> {
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM db_connections WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "UPDATE db_connections SET workspace_id = ?2, scope = 'workspace', sort_order = ?3, \
         updated_at = ?4 WHERE id = ?1",
        params![id, workspace_id, sort_order, now()],
    )?;
    Ok(())
}

/// Puts a group and its members on every workspace's shelf, or takes them back off.
///
/// The members go with it, always. A group is a *name*, not a container — `db_connections.
/// group_name` is the sole record of membership — so a group row that went global while its
/// connections did not would render, from every other workspace, as a folder that is there and
/// empty. That is not a lesser version of the feature; it is a bug that looks like one.
pub fn set_group_scope(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
    global: bool,
) -> rusqlite::Result<()> {
    let scope = if global { "global" } else { "workspace" };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE db_connections SET scope = ?3, updated_at = ?4 \
         WHERE (workspace_id = ?1 OR scope = 'global') AND group_name = ?2",
        params![workspace_id, name, scope, now()],
    )?;
    tx.execute(
        "UPDATE db_groups SET scope = ?3 WHERE (workspace_id = ?1 OR scope = 'global') AND name = ?2",
        params![workspace_id, name, scope],
    )?;
    tx.commit()
}

/// Moves a group and its members to another workspace, and files them there.
pub fn move_group_to_workspace(
    conn: &Connection,
    from: &str,
    name: &str,
    to: &str,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE db_connections SET workspace_id = ?3, scope = 'workspace', updated_at = ?4 \
         WHERE (workspace_id = ?1 OR scope = 'global') AND group_name = ?2",
        params![from, name, to, now()],
    )?;
    // `OR IGNORE` then a conditional delete: the destination may already have a folder of this
    // name, and the unique index would refuse the move. The members are there either way — the
    // surviving row is the destination's own, which is the same merge `rename_group` performs.
    tx.execute(
        "UPDATE OR IGNORE db_groups SET workspace_id = ?3, scope = 'workspace' \
         WHERE (workspace_id = ?1 OR scope = 'global') AND name = ?2",
        params![from, name, to],
    )?;
    tx.execute(
        "DELETE FROM db_groups WHERE workspace_id = ?1 AND name = ?2 \
           AND EXISTS (SELECT 1 FROM db_groups WHERE workspace_id = ?3 AND name = ?2)",
        params![from, name, to],
    )?;
    tx.commit()
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
        let mine = create_connection(&conn, "w1", "Local", "", "postgres", "{}", "").unwrap();
        let theirs = create_connection(&conn, "w2", "Theirs", "", "postgres", "{}", "").unwrap();
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
        let connection = create_connection(&conn, "w1", "Local", "", "postgres", "{}", "").unwrap();
        create_console(&conn, &connection.id, "C", "", "", "").unwrap();
        delete_connection(&conn, &connection.id).unwrap();
        assert_eq!(load_tree(&conn, "w1").unwrap().consoles.len(), 0);
    }

    /// History outlives the connection it ran against: the record of "what did I run last Tuesday"
    /// must not disappear because the connection was tidied up.
    #[test]
    fn history_survives_its_connection() {
        let conn = setup();
        let connection = create_connection(&conn, "w1", "Prod", "", "postgres", "{}", "").unwrap();
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

    fn second_workspace(conn: &Connection) {
        conn.execute(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) \
             VALUES ('w2', 'Other', '', '', 1, 't')",
            [],
        )
        .unwrap();
    }

    /// A global connection is on every workspace's shelf — and so are its consoles, which reach
    /// their workspace through it and so have their own way to be missed.
    #[test]
    fn a_global_connection_brings_its_consoles_to_every_workspace() {
        let conn = setup();
        second_workspace(&conn);
        let connection = create_connection(&conn, "w1", "Prod", "", "postgres", "{}", "").unwrap();
        create_console(&conn, &connection.id, "scratch", "", "", "").unwrap();

        assert!(load_tree(&conn, "w2").unwrap().connections.is_empty(), "not global yet");

        set_connection_scope(&conn, &connection.id, true).unwrap();

        let other = load_tree(&conn, "w2").unwrap();
        assert_eq!(other.connections.len(), 1);
        assert_eq!(other.consoles.len(), 1, "the console came through the join");
    }

    /// The `idx_db_groups_name` trap, exactly as it is reachable from the UI: a global "Prod" and a
    /// local "Prod" are two legal rows that the tree merges into one bucket. Renaming that bucket
    /// has to move both halves, or the user renames a folder and half its contents stay behind
    /// under the old name.
    #[test]
    fn renaming_a_bucket_moves_the_global_half_as_well_as_the_local_one() {
        let conn = setup();
        second_workspace(&conn);
        // A global group with a member, homed in w2.
        create_group(&conn, "w2", "Prod").unwrap();
        let shared = create_connection(&conn, "w2", "Shared", "Prod", "postgres", "{}", "").unwrap();
        set_group_scope(&conn, "w2", "Prod", true).unwrap();
        // …and a local group of the same name in w1, with its own member.
        create_group(&conn, "w1", "Prod").unwrap();
        let local = create_connection(&conn, "w1", "Local", "Prod", "postgres", "{}", "").unwrap();

        rename_group(&conn, "w1", "Prod", "Producción").unwrap();

        for id in [&shared.id, &local.id] {
            let group: String = conn
                .query_row("SELECT group_name FROM db_connections WHERE id = ?1", params![id], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(group, "Producción", "both halves of the bucket move together");
        }
    }

    /// Re-scoping a group has to carry its members, or it renders as a folder that is there and
    /// empty from every workspace but its home.
    #[test]
    fn making_a_group_global_takes_its_connections_with_it() {
        let conn = setup();
        second_workspace(&conn);
        create_group(&conn, "w1", "Prod").unwrap();
        create_connection(&conn, "w1", "Local", "Prod", "postgres", "{}", "").unwrap();

        set_group_scope(&conn, "w1", "Prod", true).unwrap();

        let other = load_tree(&conn, "w2").unwrap();
        assert_eq!(other.groups.len(), 1);
        assert_eq!(other.connections.len(), 1, "the folder is not empty on the other shelf");
    }

    /// A connection created inside an already-global group is global too.
    #[test]
    fn a_connection_inherits_the_scope_of_the_group_it_is_made_in() {
        let conn = setup();
        second_workspace(&conn);
        create_group(&conn, "w1", "Prod").unwrap();
        set_group_scope(&conn, "w1", "Prod", true).unwrap();

        let made = create_connection(&conn, "w1", "Nueva", "Prod", "postgres", "{}", "").unwrap();
        assert_eq!(made.scope, "global");
        assert_eq!(load_tree(&conn, "w2").unwrap().connections.len(), 1);
    }

    /// "Move to workspace" files a group and its members there rather than leaving them everywhere.
    #[test]
    fn moving_a_group_to_another_workspace_takes_its_members() {
        let conn = setup();
        second_workspace(&conn);
        create_group(&conn, "w1", "Prod").unwrap();
        create_connection(&conn, "w1", "Local", "Prod", "postgres", "{}", "").unwrap();

        move_group_to_workspace(&conn, "w1", "Prod", "w2").unwrap();

        assert!(load_tree(&conn, "w1").unwrap().connections.is_empty());
        let destination = load_tree(&conn, "w2").unwrap();
        assert_eq!(destination.connections.len(), 1);
        assert_eq!(destination.groups.len(), 1);
        assert!(destination.connections.iter().all(|c| c.scope == "workspace"));
    }

    /// The whole reason `db_groups` exists: a folder with nothing in it survives a reload.
    #[test]
    fn an_empty_group_still_exists_after_being_created() {
        let conn = setup();
        create_group(&conn, "w1", "Producción").unwrap();
        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(
            tree.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
            ["Producción"]
        );
        assert!(tree.connections.is_empty());
    }

    #[test]
    fn creating_a_group_twice_returns_the_same_one_rather_than_failing() {
        let conn = setup();
        let first = create_group(&conn, "w1", "Prod").unwrap();
        let second = create_group(&conn, "w1", "Prod").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(load_tree(&conn, "w1").unwrap().groups.len(), 1);
    }

    #[test]
    fn renaming_a_group_carries_the_folder_across_with_its_members() {
        let conn = setup();
        create_group(&conn, "w1", "Prod").unwrap();
        create_connection(&conn, "w1", "Local", "Prod", "postgres", "{}", "").unwrap();
        create_connection(&conn, "w1", "Other", "Staging", "postgres", "{}", "").unwrap();

        rename_group(&conn, "w1", "Prod", "Producción").unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(
            tree.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
            ["Producción"]
        );
        let names: Vec<&str> = tree.connections.iter().map(|c| c.group_name.as_str()).collect();
        assert_eq!(names, ["Producción", "Staging"], "another group is untouched");
    }

    /// A group that only ever existed because connections named it is still renameable.
    #[test]
    fn renaming_a_group_that_has_no_row_still_moves_its_connections() {
        let conn = setup();
        create_connection(&conn, "w1", "Local", "Implied", "postgres", "{}", "").unwrap();
        rename_group(&conn, "w1", "Implied", "Named").unwrap();
        assert_eq!(load_tree(&conn, "w1").unwrap().connections[0].group_name, "Named");
    }

    /// Renaming onto a name that already exists is a merge, not a unique-index error.
    #[test]
    fn renaming_a_group_onto_an_existing_one_merges_them() {
        let conn = setup();
        create_group(&conn, "w1", "Prod").unwrap();
        create_group(&conn, "w1", "Producción").unwrap();
        create_connection(&conn, "w1", "A", "Prod", "postgres", "{}", "").unwrap();
        create_connection(&conn, "w1", "B", "Producción", "postgres", "{}", "").unwrap();

        rename_group(&conn, "w1", "Prod", "Producción").unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(
            tree.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
            ["Producción"]
        );
        let names: Vec<&str> = tree.connections.iter().map(|c| c.group_name.as_str()).collect();
        assert_eq!(names, ["Producción", "Producción"]);
    }

    /// The destructive-action guard: deleting a folder must never delete connections — which would
    /// take their consoles by cascade and their keychain entries with them.
    #[test]
    fn deleting_a_group_ungroups_its_connections_rather_than_removing_them() {
        let conn = setup();
        create_group(&conn, "w1", "Prod").unwrap();
        let member = create_connection(&conn, "w1", "A", "Prod", "postgres", "{}", "").unwrap();
        create_connection(&conn, "w1", "B", "Staging", "postgres", "{}", "").unwrap();
        create_console(&conn, &member.id, "C", "", "", "").unwrap();

        delete_group(&conn, "w1", "Prod").unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert!(tree.groups.is_empty());
        assert_eq!(tree.connections.len(), 2, "the connections must all still be there");
        assert_eq!(tree.consoles.len(), 1, "and so must their consoles");
        let a = tree.connections.iter().find(|c| c.name == "A").unwrap();
        assert_eq!(a.group_name, "", "its connection moved to ungrouped");
        let b = tree.connections.iter().find(|c| c.name == "B").unwrap();
        assert_eq!(b.group_name, "Staging", "another group is untouched");
    }

    /// Filing a connection is not a settings change: it must not disturb anything else on the row.
    #[test]
    fn setting_a_group_moves_only_the_group() {
        let conn = setup();
        let row = create_connection(&conn, "w1", "A", "", "postgres", "{\"host\":\"x\"}", "#f00")
            .unwrap();
        set_connection_group(&conn, &row.id, "Prod").unwrap();

        let after = get_connection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(after.group_name, "Prod");
        assert_eq!(after.spec, row.spec);
        assert_eq!(after.color, row.color);
        assert_eq!(after.sort_order, row.sort_order);

        set_connection_group(&conn, &row.id, "").unwrap();
        assert_eq!(get_connection(&conn, &row.id).unwrap().unwrap().group_name, "");
    }

    #[test]
    fn deleting_the_workspace_takes_its_groups_with_it() {
        let conn = setup();
        create_group(&conn, "w1", "Prod").unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; DELETE FROM workspaces WHERE id = 'w1';")
            .unwrap();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM db_groups", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    /// A duplicate is a starting point, not a clone of the credential.
    #[test]
    fn a_duplicate_does_not_inherit_the_password() {
        let conn = setup();
        let source =
            create_connection(&conn, "w1", "Prod", "", "postgres", "{\"host\":\"db\"}", "#f00").unwrap();
        let copy = duplicate_connection(&conn, &source.id).unwrap();
        assert_ne!(copy.id, source.id);
        assert_eq!(copy.name, "Prod copy");
        assert_eq!(copy.spec, source.spec);
        assert_eq!(copy.sort_order, 1);
    }
}
