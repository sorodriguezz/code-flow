//! CRUD over `remote_hosts` and `remote_snippets` — the Remote workspace's inventory.
//!
//! Scoped per workspace the same way `datasource_queries` is, and for the same reason: a host
//! belongs to the environment a workspace's repositories are deployed to, not to any one
//! repository, so switching repository must not change what is in the list.
//!
//! Two things deliberately do *not* live here. Passwords and key passphrases: they are in the OS
//! keychain, and the only thing this module does about them is delete the entry when its host goes
//! ([`delete_host`]). And host *content*: `spec` is stored verbatim as the JSON
//! [`crate::remotes::RemoteHostSpec`] will parse, so adding a flag needs no change in this file.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    RemoteGroupRow, RemoteHostRow, RemoteLogEntry, RemoteSnippet, RemoteWorkspaceTree,
};
use super::queries::now;

const HOST_COLUMNS: &str =
    "id, workspace_id, name, group_name, spec, color, sort_order, created_at, updated_at";
const GROUP_COLUMNS: &str = "id, workspace_id, name, sort_order, created_at";
const SNIPPET_COLUMNS: &str = "id, workspace_id, name, body, sort_order, created_at, updated_at";

fn map_host(row: &rusqlite::Row) -> rusqlite::Result<RemoteHostRow> {
    Ok(RemoteHostRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        group_name: row.get(3)?,
        spec: row.get(4)?,
        color: row.get(5)?,
        sort_order: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn map_group(row: &rusqlite::Row) -> rusqlite::Result<RemoteGroupRow> {
    Ok(RemoteGroupRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn map_snippet(row: &rusqlite::Row) -> rusqlite::Result<RemoteSnippet> {
    Ok(RemoteSnippet {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        body: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/// One workspace's hosts, groups and snippets in a single round trip.
///
/// The groups come back as their own list rather than being derived from the hosts, because the
/// two disagree in both directions and the UI needs both halves: a group row with no member is a
/// folder the user made and hasn't filled, and a `group_name` with no row is a host imported or
/// dragged into a name nobody created. The tree unions them.
pub fn load_tree(conn: &Connection, workspace_id: &str) -> rusqlite::Result<RemoteWorkspaceTree> {
    let mut statement = conn.prepare(&format!(
        "SELECT {HOST_COLUMNS} FROM remote_hosts WHERE workspace_id = ?1 \
         ORDER BY sort_order, name"
    ))?;
    let hosts = statement
        .query_map(params![workspace_id], map_host)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare(&format!(
        "SELECT {GROUP_COLUMNS} FROM remote_groups WHERE workspace_id = ?1 \
         ORDER BY sort_order, name"
    ))?;
    let groups = statement
        .query_map(params![workspace_id], map_group)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare(&format!(
        "SELECT {SNIPPET_COLUMNS} FROM remote_snippets WHERE workspace_id = ?1 \
         ORDER BY sort_order, name"
    ))?;
    let snippets = statement
        .query_map(params![workspace_id], map_snippet)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(RemoteWorkspaceTree { hosts, groups, snippets })
}

pub fn get_host(conn: &Connection, id: &str) -> rusqlite::Result<Option<RemoteHostRow>> {
    conn.query_row(
        &format!("SELECT {HOST_COLUMNS} FROM remote_hosts WHERE id = ?1"),
        params![id],
        map_host,
    )
    .optional()
}

pub fn create_host(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
    group_name: &str,
    spec: &str,
    color: &str,
) -> rusqlite::Result<RemoteHostRow> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    // Appended rather than inserted at the top: a list the user has ordered must not be reordered
    // by adding to it.
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM remote_hosts WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;
    conn.execute(
        &format!(
            "INSERT INTO remote_hosts ({HOST_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ),
        params![id, workspace_id, name, group_name, spec, color, sort_order, timestamp, timestamp],
    )?;
    Ok(RemoteHostRow {
        id,
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        group_name: group_name.to_string(),
        spec: spec.to_string(),
        color: color.to_string(),
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub fn update_host(conn: &Connection, row: &RemoteHostRow) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE remote_hosts SET name = ?2, group_name = ?3, spec = ?4, color = ?5, \
         updated_at = ?6 WHERE id = ?1",
        params![row.id, row.name, row.group_name, row.spec, row.color, now()],
    )?;
    Ok(())
}

/// Deletes a host and the credential saved against it.
///
/// The keychain entry is keyed by host id, so a later host reusing the id — which `uuid` makes
/// impossible, but a restored backup does not — would silently inherit a stranger's password. A
/// keychain failure is not allowed to block the delete; the row is what the user asked to remove.
///
/// Its live forwards go too, for the plainer reason that a listening port whose host no longer
/// exists is a port nothing can close.
pub fn delete_host(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let _ = crate::secrets::delete_secret(&crate::remotes::password_key(id));
    crate::remotes::forward::close_host(id);
    conn.execute("DELETE FROM remote_hosts WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn duplicate_host(conn: &Connection, id: &str) -> rusqlite::Result<RemoteHostRow> {
    let source = get_host(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    // The copy deliberately does not carry the password across. Copying a credential silently is
    // the sort of thing that makes two hosts share one secret without anybody deciding to.
    create_host(
        conn,
        &source.workspace_id,
        &format!("{} copy", source.name),
        &source.group_name,
        &source.spec,
        &source.color,
    )
}

pub fn reorder_hosts(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let timestamp = now();
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE remote_hosts SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, index as i64, timestamp],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/// Creates an empty group, or returns the one already carrying that name.
///
/// Idempotent on purpose: "New group" typed twice with the same name is a user who wants that
/// group, not an error dialog. The `INSERT OR IGNORE` and the read-back together are what make the
/// unique index a deduplicator rather than a failure mode.
pub fn create_group(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
) -> rusqlite::Result<RemoteGroupRow> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM remote_groups WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;
    conn.execute(
        &format!("INSERT OR IGNORE INTO remote_groups ({GROUP_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5)"),
        params![Uuid::new_v4().to_string(), workspace_id, name, sort_order, now()],
    )?;
    conn.query_row(
        &format!("SELECT {GROUP_COLUMNS} FROM remote_groups WHERE workspace_id = ?1 AND name = ?2"),
        params![workspace_id, name],
        map_group,
    )
}

/// Renames a group: its members, and the folder row itself.
///
/// Two writes rather than one because membership and existence are recorded separately — see the
/// tables' comments in `migrations`. The members move whether or not a folder row exists, which is
/// what keeps a group that was only ever implied by its hosts renameable.
///
/// **Renaming onto an existing name merges.** The alternative is a unique-index failure the user
/// reads as "you can't call it that", when what they almost always meant was "put these together".
pub fn rename_group(
    conn: &Connection,
    workspace_id: &str,
    from: &str,
    to: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE remote_hosts SET group_name = ?3, updated_at = ?4 \
         WHERE workspace_id = ?1 AND group_name = ?2",
        params![workspace_id, from, to, now()],
    )?;

    let target_exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM remote_groups WHERE workspace_id = ?1 AND name = ?2",
        params![workspace_id, to],
        |row| row.get(0),
    )?;
    if target_exists {
        // The members are already there; the source folder is now a duplicate of the target.
        conn.execute(
            "DELETE FROM remote_groups WHERE workspace_id = ?1 AND name = ?2",
            params![workspace_id, from],
        )?;
    } else {
        conn.execute(
            "UPDATE remote_groups SET name = ?3 WHERE workspace_id = ?1 AND name = ?2",
            params![workspace_id, from, to],
        )?;
    }
    Ok(())
}

/// Deletes a group and turns its members loose.
///
/// **Never the hosts.** A folder and the machines in it are not the same thing, and a delete that
/// took the machines with it would be the one destructive action in this tree — undoable only by
/// retyping every host. They move to ungrouped, where they are still there to be found.
pub fn delete_group(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE remote_hosts SET group_name = '', updated_at = ?3 \
         WHERE workspace_id = ?1 AND group_name = ?2",
        params![workspace_id, name, now()],
    )?;
    conn.execute(
        "DELETE FROM remote_groups WHERE workspace_id = ?1 AND name = ?2",
        params![workspace_id, name],
    )?;
    Ok(())
}

/// Whether this workspace already has a host with that name — what the `~/.ssh/config` import
/// checks before adding, so running it twice doesn't produce two of everything.
pub fn host_name_taken(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM remote_hosts WHERE workspace_id = ?1 AND name = ?2",
        params![workspace_id, name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

const LOG_COLUMNS: &str = "id, workspace_id, host_id, host_name, kind, detail, error, at";

/// Backstop on [`add_log`]. Well above what the UI lists, so it only stops the table growing
/// without bound over the app's lifetime.
const LOG_HARD_CAP: i64 = 2000;

fn map_log(row: &rusqlite::Row) -> rusqlite::Result<RemoteLogEntry> {
    Ok(RemoteLogEntry {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        host_id: row.get(2)?,
        host_name: row.get(3)?,
        kind: row.get(4)?,
        detail: row.get(5)?,
        error: row.get(6)?,
        at: row.get(7)?,
    })
}

pub fn add_log(
    conn: &Connection,
    workspace_id: &str,
    host_id: &str,
    host_name: &str,
    kind: &str,
    detail: &str,
    error: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO remote_log ({LOG_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
        params![Uuid::new_v4().to_string(), workspace_id, host_id, host_name, kind, detail, error, now()],
    )?;
    // Trimmed on write rather than on a schedule: there is no other moment this table changes, and
    // a background sweep would be a timer existing solely to delete rows nobody has looked at.
    conn.execute(
        "DELETE FROM remote_log WHERE workspace_id = ?1 AND id NOT IN \
         (SELECT id FROM remote_log WHERE workspace_id = ?1 ORDER BY at DESC LIMIT ?2)",
        params![workspace_id, LOG_HARD_CAP],
    )?;
    Ok(())
}

pub fn list_logs(
    conn: &Connection,
    workspace_id: &str,
    limit: i64,
) -> rusqlite::Result<Vec<RemoteLogEntry>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {LOG_COLUMNS} FROM remote_log WHERE workspace_id = ?1 ORDER BY at DESC LIMIT ?2"
    ))?;
    // Collected into a `Vec` before returning rather than handing the iterator back: it borrows
    // `statement`, which dies at the end of this function.
    let rows = statement
        .query_map(params![workspace_id, limit], map_log)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn clear_logs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM remote_log WHERE workspace_id = ?1", params![workspace_id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

pub fn create_snippet(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
    body: &str,
) -> rusqlite::Result<RemoteSnippet> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM remote_snippets WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;
    conn.execute(
        &format!("INSERT INTO remote_snippets ({SNIPPET_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"),
        params![id, workspace_id, name, body, sort_order, timestamp, timestamp],
    )?;
    Ok(RemoteSnippet {
        id,
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        body: body.to_string(),
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

/// One snippet by id — what a host's startup snippet is resolved through.
pub fn get_snippet(conn: &Connection, id: &str) -> rusqlite::Result<Option<RemoteSnippet>> {
    conn.query_row(
        &format!("SELECT {SNIPPET_COLUMNS} FROM remote_snippets WHERE id = ?1"),
        params![id],
        map_snippet,
    )
    .optional()
}

pub fn update_snippet(conn: &Connection, snippet: &RemoteSnippet) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE remote_snippets SET name = ?2, body = ?3, updated_at = ?4 WHERE id = ?1",
        params![snippet.id, snippet.name, snippet.body, now()],
    )?;
    Ok(())
}

pub fn delete_snippet(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM remote_snippets WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, sort_order) VALUES ('w1', 'W', 't', 0)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn hosts_are_appended_in_the_order_they_are_created() {
        let conn = db();
        create_host(&conn, "w1", "a", "", "{}", "").unwrap();
        create_host(&conn, "w1", "b", "", "{}", "").unwrap();
        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(tree.hosts.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(tree.hosts[1].sort_order, 1);
    }

    #[test]
    fn reordering_writes_the_positions_the_caller_gave() {
        let conn = db();
        let a = create_host(&conn, "w1", "a", "", "{}", "").unwrap();
        let b = create_host(&conn, "w1", "b", "", "{}", "").unwrap();
        reorder_hosts(&conn, &[b.id.clone(), a.id.clone()]).unwrap();
        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(tree.hosts.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), ["b", "a"]);
    }

    #[test]
    fn renaming_a_group_moves_every_host_in_it_and_nothing_else() {
        let conn = db();
        create_host(&conn, "w1", "a", "Prod", "{}", "").unwrap();
        create_host(&conn, "w1", "b", "Prod", "{}", "").unwrap();
        create_host(&conn, "w1", "c", "Staging", "{}", "").unwrap();
        rename_group(&conn, "w1", "Prod", "Production").unwrap();
        let tree = load_tree(&conn, "w1").unwrap();
        let groups: Vec<&str> = tree.hosts.iter().map(|h| h.group_name.as_str()).collect();
        assert_eq!(groups, ["Production", "Production", "Staging"]);
    }

    /// The whole reason the table exists: a folder with nothing in it survives a reload.
    #[test]
    fn an_empty_group_still_exists_after_being_created() {
        let conn = db();
        create_group(&conn, "w1", "Staging").unwrap();
        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(tree.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["Staging"]);
        assert!(tree.hosts.is_empty());
    }

    #[test]
    fn creating_a_group_twice_returns_the_same_one_rather_than_failing() {
        let conn = db();
        let first = create_group(&conn, "w1", "Prod").unwrap();
        let second = create_group(&conn, "w1", "Prod").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(load_tree(&conn, "w1").unwrap().groups.len(), 1);
    }

    #[test]
    fn renaming_a_group_row_carries_the_folder_across_with_its_members() {
        let conn = db();
        create_group(&conn, "w1", "Prod").unwrap();
        create_host(&conn, "w1", "a", "Prod", "{}", "").unwrap();
        rename_group(&conn, "w1", "Prod", "Production").unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(tree.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["Production"]);
        assert_eq!(tree.hosts[0].group_name, "Production");
    }

    /// Renaming onto a name that already exists is a merge, not a unique-index error.
    #[test]
    fn renaming_a_group_onto_an_existing_one_merges_them() {
        let conn = db();
        create_group(&conn, "w1", "Prod").unwrap();
        create_group(&conn, "w1", "Production").unwrap();
        create_host(&conn, "w1", "a", "Prod", "{}", "").unwrap();
        create_host(&conn, "w1", "b", "Production", "{}", "").unwrap();

        rename_group(&conn, "w1", "Prod", "Production").unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(tree.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["Production"]);
        let groups: Vec<&str> = tree.hosts.iter().map(|h| h.group_name.as_str()).collect();
        assert_eq!(groups, ["Production", "Production"]);
    }

    /// A group that only ever existed because hosts named it is still renameable.
    #[test]
    fn renaming_a_group_that_has_no_row_still_moves_its_hosts() {
        let conn = db();
        create_host(&conn, "w1", "a", "Implied", "{}", "").unwrap();
        rename_group(&conn, "w1", "Implied", "Named").unwrap();
        assert_eq!(load_tree(&conn, "w1").unwrap().hosts[0].group_name, "Named");
    }

    /// The destructive-action guard: deleting a folder must never delete machines.
    #[test]
    fn deleting_a_group_ungroups_its_hosts_rather_than_removing_them() {
        let conn = db();
        create_group(&conn, "w1", "Prod").unwrap();
        create_host(&conn, "w1", "a", "Prod", "{}", "").unwrap();
        create_host(&conn, "w1", "b", "Staging", "{}", "").unwrap();

        delete_group(&conn, "w1", "Prod").unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert!(tree.groups.is_empty());
        assert_eq!(tree.hosts.len(), 2, "the hosts must all still be there");
        let a = tree.hosts.iter().find(|h| h.name == "a").unwrap();
        assert_eq!(a.group_name, "", "its host moved to ungrouped");
        let b = tree.hosts.iter().find(|h| h.name == "b").unwrap();
        assert_eq!(b.group_name, "Staging", "another group is untouched");
    }

    #[test]
    fn deleting_the_workspace_takes_its_groups_with_it() {
        let conn = db();
        create_group(&conn, "w1", "Prod").unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; DELETE FROM workspaces WHERE id = 'w1';")
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM remote_groups", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn a_duplicate_is_a_new_row_that_shares_no_id() {
        let conn = db();
        let source = create_host(&conn, "w1", "web", "Prod", r#"{"host":"a"}"#, "#f00").unwrap();
        let copy = duplicate_host(&conn, &source.id).unwrap();
        assert_ne!(copy.id, source.id);
        assert_eq!(copy.name, "web copy");
        assert_eq!(copy.spec, source.spec);
        assert_eq!(copy.group_name, "Prod");
    }

    #[test]
    fn deleting_the_workspace_takes_its_hosts_and_snippets_with_it() {
        let conn = db();
        create_host(&conn, "w1", "a", "", "{}", "").unwrap();
        create_snippet(&conn, "w1", "s", "uptime").unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; DELETE FROM workspaces WHERE id = 'w1';")
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM remote_hosts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM remote_snippets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn the_import_can_tell_whether_it_would_be_creating_a_second_copy() {
        let conn = db();
        create_host(&conn, "w1", "web-01", "", "{}", "").unwrap();
        assert!(host_name_taken(&conn, "w1", "web-01").unwrap());
        assert!(!host_name_taken(&conn, "w1", "web-02").unwrap());
    }
}
