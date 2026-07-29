//! CRUD over the `api_*` tables (see `migrations.rs`).
//!
//! Scoped per workspace. Only the four roots — collections, environments, history and cookies —
//! carry a `workspace_id`; folders and requests are reached through their collection, so a listing
//! query scopes them by joining rather than by filtering a column of their own. Anything addressed
//! by a unique `id` needs no workspace argument: the id already picks exactly one row.
//!
//! The editable content of a request travels inside its `spec` JSON blob and is stored verbatim —
//! the only thing read out of it is `method`/`url`, and only to keep the denormalized tree columns
//! honest.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{ApiCollection, ApiCookie, ApiEnvironment, ApiFolder, ApiHistoryEntry, ApiRequestRow, ApiTree};
use super::queries::now;

/// Backstop applied on every `add_history` insert. Deliberately well above the largest value the
/// settings UI offers (`historyLimit`, default 500): that setting decides how many entries are
/// *shown*, this one only stops the table growing without bound over the app's lifetime.
const HISTORY_HARD_CAP: i64 = 2000;

/// Guards `move_node`'s parent walk against a tree that is already cyclic — without it a corrupt
/// `parent_id` chain would spin forever instead of failing the move.
const MAX_FOLDER_DEPTH: usize = 256;

const COLLECTION_COLUMNS: &str =
    "id, workspace_id, name, description, auth, pre_script, post_script, variables, sort_order, pinned, created_at, updated_at";
const FOLDER_COLUMNS: &str =
    "id, collection_id, parent_id, name, description, auth, pre_script, post_script, sort_order, created_at, updated_at";
const REQUEST_COLUMNS: &str =
    "id, collection_id, folder_id, name, protocol, method, url, spec, sort_order, created_at, updated_at";
const ENVIRONMENT_COLUMNS: &str =
    "id, workspace_id, name, variables, is_global, sort_order, created_at, updated_at";
const HISTORY_COLUMNS: &str =
    "id, workspace_id, request_id, name, protocol, method, url, status, duration_ms, size_bytes, snapshot, created_at";
const COOKIE_COLUMNS: &str =
    "id, workspace_id, domain, path, name, value, secure, http_only, expires, updated_at";

fn map_collection(row: &rusqlite::Row) -> rusqlite::Result<ApiCollection> {
    Ok(ApiCollection {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        auth: row.get(4)?,
        pre_script: row.get(5)?,
        post_script: row.get(6)?,
        variables: row.get(7)?,
        sort_order: row.get(8)?,
        pinned: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn map_folder(row: &rusqlite::Row) -> rusqlite::Result<ApiFolder> {
    Ok(ApiFolder {
        id: row.get(0)?,
        collection_id: row.get(1)?,
        parent_id: row.get(2)?,
        name: row.get(3)?,
        description: row.get(4)?,
        auth: row.get(5)?,
        pre_script: row.get(6)?,
        post_script: row.get(7)?,
        sort_order: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn map_request(row: &rusqlite::Row) -> rusqlite::Result<ApiRequestRow> {
    Ok(ApiRequestRow {
        id: row.get(0)?,
        collection_id: row.get(1)?,
        folder_id: row.get(2)?,
        name: row.get(3)?,
        protocol: row.get(4)?,
        method: row.get(5)?,
        url: row.get(6)?,
        spec: row.get(7)?,
        sort_order: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn map_environment(row: &rusqlite::Row) -> rusqlite::Result<ApiEnvironment> {
    Ok(ApiEnvironment {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        variables: row.get(3)?,
        is_global: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_history(row: &rusqlite::Row) -> rusqlite::Result<ApiHistoryEntry> {
    Ok(ApiHistoryEntry {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        request_id: row.get(2)?,
        name: row.get(3)?,
        protocol: row.get(4)?,
        method: row.get(5)?,
        url: row.get(6)?,
        status: row.get(7)?,
        duration_ms: row.get(8)?,
        size_bytes: row.get(9)?,
        snapshot: row.get(10)?,
        created_at: row.get(11)?,
    })
}

fn map_cookie(row: &rusqlite::Row) -> rusqlite::Result<ApiCookie> {
    Ok(ApiCookie {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        domain: row.get(2)?,
        path: row.get(3)?,
        name: row.get(4)?,
        value: row.get(5)?,
        secure: row.get(6)?,
        http_only: row.get(7)?,
        expires: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

// ---------- tree ----------

/// One workspace's collections, folders and requests in one round trip, each already in render
/// order — the UI rebuilds the nesting from the parent ids rather than paying a query per expanded
/// node.
///
/// Folders and requests have no `workspace_id` of their own, so they are scoped through the
/// collections they hang off: anything else would hand the UI every workspace's rows at once.
pub fn load_tree(conn: &Connection, workspace_id: &str) -> rusqlite::Result<ApiTree> {
    const IN_WORKSPACE: &str = "collection_id IN (SELECT id FROM api_collections WHERE workspace_id = ?1)";
    let collections = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLLECTION_COLUMNS} FROM api_collections WHERE workspace_id = ?1 ORDER BY sort_order, created_at"
        ))?;
        let rows = stmt.query_map(params![workspace_id], map_collection)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let folders = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {FOLDER_COLUMNS} FROM api_folders
              WHERE {IN_WORKSPACE} ORDER BY collection_id, sort_order, created_at"
        ))?;
        let rows = stmt.query_map(params![workspace_id], map_folder)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let requests = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {REQUEST_COLUMNS} FROM api_requests
              WHERE {IN_WORKSPACE} ORDER BY collection_id, sort_order, created_at"
        ))?;
        let rows = stmt.query_map(params![workspace_id], map_request)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(ApiTree { collections, folders, requests })
}

// ---------- collections ----------

fn insert_collection(conn: &Connection, c: &ApiCollection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_collections
            (id, workspace_id, name, description, auth, pre_script, post_script, variables, sort_order,
             pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            c.id,
            c.workspace_id,
            c.name,
            c.description,
            c.auth,
            c.pre_script,
            c.post_script,
            c.variables,
            c.sort_order,
            c.pinned,
            c.created_at,
            c.updated_at,
        ],
    )?;
    Ok(())
}

pub fn create_collection(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<ApiCollection> {
    let ts = now();
    let collection = ApiCollection {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        description: String::new(),
        auth: String::new(),
        pre_script: String::new(),
        post_script: String::new(),
        variables: "[]".to_string(),
        sort_order: next_collection_order(conn, workspace_id)?,
        pinned: false,
        created_at: ts.clone(),
        updated_at: ts,
    };
    insert_collection(conn, &collection)?;
    Ok(collection)
}

/// Per workspace: `sort_order` is an index into one workspace's sidebar, not a global ranking.
fn next_collection_order(conn: &Connection, workspace_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM api_collections WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )
}

/// Saves the editable fields only. `sort_order` is owned by `reorder_collections`, so writing it
/// back from a client that hasn't seen a concurrent reorder would silently scramble the sidebar.
pub fn update_collection(conn: &Connection, c: &ApiCollection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE api_collections
            SET name = ?2, description = ?3, auth = ?4, pre_script = ?5, post_script = ?6,
                variables = ?7, pinned = ?8, updated_at = ?9
          WHERE id = ?1",
        params![c.id, c.name, c.description, c.auth, c.pre_script, c.post_script, c.variables, c.pinned, now()],
    )?;
    Ok(())
}

/// Folders and requests go with it through `ON DELETE CASCADE` (the connection runs with
/// `PRAGMA foreign_keys = ON`, set in `migrations::run`).
// ---------- tombstones ----------

/// Records that something was removed, so the deletion can travel to a shared workspace or another
/// machine. See the `api_tombstones` comment in `migrations.rs` for why absence alone cannot.
///
/// SQLite cascades a delete down the tree, and the rows it takes with it have to be recorded too:
/// a peer that learned only "the collection is gone" would keep its requests, and then re-upload
/// them as children of a collection that no longer exists.
fn record_tombstones(conn: &Connection, kind: &str, ids: &[String], workspace_id: &str) -> rusqlite::Result<()> {
    let stamp = now();
    for id in ids {
        conn.execute(
            "INSERT INTO api_tombstones (id, workspace_id, kind, deleted_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(workspace_id, kind, id) DO UPDATE SET deleted_at = excluded.deleted_at",
            params![id, workspace_id, kind, stamp],
        )?;
    }
    Ok(())
}

/// The folders and requests a delete is about to take with it, plus the folder ids themselves.
fn subtree_of_collection(conn: &Connection, collection_id: &str) -> rusqlite::Result<(Vec<String>, Vec<String>)> {
    let mut folders = conn.prepare("SELECT id FROM api_folders WHERE collection_id = ?1")?;
    let folders: Vec<String> = folders
        .query_map(params![collection_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut requests = conn.prepare("SELECT id FROM api_requests WHERE collection_id = ?1")?;
    let requests: Vec<String> = requests
        .query_map(params![collection_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok((folders, requests))
}

/// Descendant folders of `folder_id`, itself included. Walks generation by generation rather than
/// recursing, and stops at `MAX_FOLDER_DEPTH` for the same reason `move_node` does: a corrupt
/// `parent_id` chain must fail, not spin.
fn folder_and_descendants(conn: &Connection, folder_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut all = vec![folder_id.to_string()];
    let mut frontier = vec![folder_id.to_string()];
    for _ in 0..MAX_FOLDER_DEPTH {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for parent in &frontier {
            let mut stmt = conn.prepare("SELECT id FROM api_folders WHERE parent_id = ?1")?;
            let children: Vec<String> = stmt
                .query_map(params![parent], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for child in children {
                if !all.contains(&child) {
                    all.push(child.clone());
                    next.push(child);
                }
            }
        }
        frontier = next;
    }
    Ok(all)
}

/// The workspace a collection, folder, request or environment belongs to.
fn workspace_of(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<Option<String>> {
    let sql = match kind {
        "collection" => "SELECT workspace_id FROM api_collections WHERE id = ?1",
        "environment" => "SELECT workspace_id FROM api_environments WHERE id = ?1",
        "folder" => {
            "SELECT c.workspace_id FROM api_folders f JOIN api_collections c ON c.id = f.collection_id WHERE f.id = ?1"
        }
        _ => {
            "SELECT c.workspace_id FROM api_requests r JOIN api_collections c ON c.id = r.collection_id WHERE r.id = ?1"
        }
    };
    conn.query_row(sql, params![id], |row| row.get(0)).optional()
}

pub fn delete_collection(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if let Some(workspace_id) = workspace_of(&tx, "collection", id)? {
        let (folders, requests) = subtree_of_collection(&tx, id)?;
        record_tombstones(&tx, "collection", &[id.to_string()], &workspace_id)?;
        record_tombstones(&tx, "folder", &folders, &workspace_id)?;
        record_tombstones(&tx, "request", &requests, &workspace_id)?;
    }
    tx.execute("DELETE FROM api_collections WHERE id = ?1", params![id])?;
    tx.commit()
}

/// Deep copy: every folder and request gets a fresh id and the parent links are remapped onto
/// them, so the copy shares no row with the original and can diverge freely.
///
/// The copy stays in the source's workspace — `workspace_id` rides along with the rest of
/// `..source`, and its `sort_order` is drawn from that same workspace's sidebar.
pub fn duplicate_collection(conn: &Connection, id: &str) -> rusqlite::Result<ApiCollection> {
    let tx = conn.unchecked_transaction()?;
    let source: ApiCollection = tx.query_row(
        &format!("SELECT {COLLECTION_COLUMNS} FROM api_collections WHERE id = ?1"),
        params![id],
        map_collection,
    )?;

    let ts = now();
    let sort_order = next_collection_order(&tx, &source.workspace_id)?;
    let copy = ApiCollection {
        id: Uuid::new_v4().to_string(),
        name: format!("{} copy", source.name),
        sort_order,
        created_at: ts.clone(),
        updated_at: ts.clone(),
        ..source
    };
    insert_collection(&tx, &copy)?;

    let folders = {
        let mut stmt = tx.prepare(&format!(
            "SELECT {FOLDER_COLUMNS} FROM api_folders WHERE collection_id = ?1 ORDER BY sort_order, created_at"
        ))?;
        let rows = stmt.query_map(params![id], map_folder)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let new_folder_ids: Vec<String> = folders.iter().map(|_| Uuid::new_v4().to_string()).collect();
    let remap: HashMap<&str, &str> = folders
        .iter()
        .zip(&new_folder_ids)
        .map(|(f, new_id)| (f.id.as_str(), new_id.as_str()))
        .collect();

    // Two passes: a child folder can be listed before its parent, and inserting it with the
    // parent link already set would fail the self-referencing foreign key.
    for (folder, new_id) in folders.iter().zip(&new_folder_ids) {
        let copied = ApiFolder {
            id: new_id.clone(),
            collection_id: copy.id.clone(),
            parent_id: None,
            created_at: ts.clone(),
            ..folder.clone()
        };
        insert_folder(&tx, &copied)?;
    }
    for (folder, new_id) in folders.iter().zip(&new_folder_ids) {
        if let Some(new_parent) = folder.parent_id.as_deref().and_then(|p| remap.get(p)) {
            tx.execute(
                "UPDATE api_folders SET parent_id = ?2 WHERE id = ?1",
                params![new_id, new_parent],
            )?;
        }
    }

    let requests = {
        let mut stmt = tx.prepare(&format!(
            "SELECT {REQUEST_COLUMNS} FROM api_requests WHERE collection_id = ?1 ORDER BY sort_order, created_at"
        ))?;
        let rows = stmt.query_map(params![id], map_request)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for request in &requests {
        let copied = ApiRequestRow {
            id: Uuid::new_v4().to_string(),
            collection_id: copy.id.clone(),
            folder_id: request.folder_id.as_deref().and_then(|f| remap.get(f)).map(|f| f.to_string()),
            created_at: ts.clone(),
            updated_at: ts.clone(),
            ..request.clone()
        };
        insert_request(&tx, &copied)?;
    }

    tx.commit()?;
    Ok(copy)
}

/// `ids` is the sidebar's full order, top to bottom, for one workspace. The `workspace_id` guard is
/// belt-and-braces: a stale list from a workspace the user has just switched away from renumbers
/// nothing instead of scrambling the sidebar it does belong to.
pub fn reorder_collections(conn: &Connection, workspace_id: &str, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE api_collections SET sort_order = ?3 WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace_id, index as i64],
        )?;
    }
    tx.commit()
}

// ---------- folders ----------

fn insert_folder(conn: &Connection, f: &ApiFolder) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_folders
            (id, collection_id, parent_id, name, description, auth, pre_script, post_script, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            f.id,
            f.collection_id,
            f.parent_id,
            f.name,
            f.description,
            f.auth,
            f.pre_script,
            f.post_script,
            f.sort_order,
            f.created_at,
            f.updated_at,
        ],
    )?;
    Ok(())
}

pub fn create_folder(
    conn: &Connection,
    collection_id: &str,
    parent_id: Option<&str>,
    name: &str,
) -> rusqlite::Result<ApiFolder> {
    let folder = ApiFolder {
        id: Uuid::new_v4().to_string(),
        collection_id: collection_id.to_string(),
        parent_id: parent_id.map(str::to_string),
        name: name.to_string(),
        description: String::new(),
        auth: String::new(),
        pre_script: String::new(),
        post_script: String::new(),
        sort_order: next_child_order(conn, "api_folders", "parent_id", collection_id, parent_id)?,
        created_at: now(),
        updated_at: now(),
    };
    insert_folder(conn, &folder)?;
    Ok(folder)
}

/// Editable fields only — the structural columns (`collection_id`, `parent_id`, `sort_order`)
/// belong to `move_node`, which keeps them consistent as a set.
pub fn update_folder(conn: &Connection, f: &ApiFolder) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE api_folders
            SET name = ?2, description = ?3, auth = ?4, pre_script = ?5, post_script = ?6,
                updated_at = ?7
          WHERE id = ?1",
        params![f.id, f.name, f.description, f.auth, f.pre_script, f.post_script, now()],
    )?;
    Ok(())
}

pub fn delete_folder(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if let Some(workspace_id) = workspace_of(&tx, "folder", id)? {
        let folders = folder_and_descendants(&tx, id)?;
        let mut requests = Vec::new();
        for folder in &folders {
            let mut stmt = tx.prepare("SELECT id FROM api_requests WHERE folder_id = ?1")?;
            let ids: Vec<String> = stmt
                .query_map(params![folder], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            requests.extend(ids);
        }
        record_tombstones(&tx, "folder", &folders, &workspace_id)?;
        record_tombstones(&tx, "request", &requests, &workspace_id)?;
    }
    tx.execute("DELETE FROM api_folders WHERE id = ?1", params![id])?;
    tx.commit()
}

// ---------- requests ----------

fn insert_request(conn: &Connection, r: &ApiRequestRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_requests
            (id, collection_id, folder_id, name, protocol, method, url, spec, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            r.id,
            r.collection_id,
            r.folder_id,
            r.name,
            r.protocol,
            r.method,
            r.url,
            r.spec,
            r.sort_order,
            r.created_at,
            r.updated_at,
        ],
    )?;
    Ok(())
}

/// `method`/`url` exist as columns only so the tree can render a row without opening its blob, so
/// they're seeded from the incoming spec here rather than left at the schema default — otherwise a
/// request saved from a filled-in tab would list as `GET` with no URL until its first update.
fn denormalize(spec: &str) -> (String, String) {
    let parsed: serde_json::Value = serde_json::from_str(spec).unwrap_or(serde_json::Value::Null);
    let field = |key: &str| parsed.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let method = field("method");
    (if method.is_empty() { "GET".to_string() } else { method }, field("url"))
}

pub fn create_request(
    conn: &Connection,
    collection_id: &str,
    folder_id: Option<&str>,
    name: &str,
    protocol: &str,
    spec: &str,
) -> rusqlite::Result<ApiRequestRow> {
    let ts = now();
    let (method, url) = denormalize(spec);
    let request = ApiRequestRow {
        id: Uuid::new_v4().to_string(),
        collection_id: collection_id.to_string(),
        folder_id: folder_id.map(str::to_string),
        name: name.to_string(),
        protocol: protocol.to_string(),
        method,
        url,
        spec: spec.to_string(),
        sort_order: next_child_order(conn, "api_requests", "folder_id", collection_id, folder_id)?,
        created_at: ts.clone(),
        updated_at: ts,
    };
    insert_request(conn, &request)?;
    Ok(request)
}

/// Editable fields only; see `update_folder` for why the structural columns are excluded.
pub fn update_request(conn: &Connection, r: &ApiRequestRow) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE api_requests
            SET name = ?2, protocol = ?3, method = ?4, url = ?5, spec = ?6, updated_at = ?7
          WHERE id = ?1",
        params![r.id, r.name, r.protocol, r.method, r.url, r.spec, now()],
    )?;
    Ok(())
}

pub fn delete_request(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if let Some(workspace_id) = workspace_of(&tx, "request", id)? {
        record_tombstones(&tx, "request", &[id.to_string()], &workspace_id)?;
    }
    tx.execute("DELETE FROM api_requests WHERE id = ?1", params![id])?;
    tx.commit()
}

/// The copy lands last among its siblings, next to the original's folder.
pub fn duplicate_request(conn: &Connection, id: &str) -> rusqlite::Result<ApiRequestRow> {
    let tx = conn.unchecked_transaction()?;
    let source: ApiRequestRow = tx.query_row(
        &format!("SELECT {REQUEST_COLUMNS} FROM api_requests WHERE id = ?1"),
        params![id],
        map_request,
    )?;
    let ts = now();
    let sort_order = next_child_order(
        &tx,
        "api_requests",
        "folder_id",
        &source.collection_id,
        source.folder_id.as_deref(),
    )?;
    let copy = ApiRequestRow {
        id: Uuid::new_v4().to_string(),
        name: format!("{} copy", source.name),
        sort_order,
        created_at: ts.clone(),
        updated_at: ts,
        ..source
    };
    insert_request(&tx, &copy)?;
    tx.commit()?;
    Ok(copy)
}

// ---------- moving nodes ----------

/// Next free slot among the children of one parent. `parent_col` differs per table (`parent_id`
/// for folders, `folder_id` for requests) but means the same thing; `IS` rather than `=` so a
/// NULL parent (directly under the collection) matches.
fn next_child_order(
    conn: &Connection,
    table: &str,
    parent_col: &str,
    collection_id: &str,
    parent_id: Option<&str>,
) -> rusqlite::Result<i64> {
    conn.query_row(
        &format!(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM {table}
              WHERE collection_id = ?1 AND {parent_col} IS ?2"
        ),
        params![collection_id, parent_id],
        |row| row.get(0),
    )
}

/// True when `candidate` is `folder_id` itself or sits anywhere beneath it — i.e. dropping the
/// folder there would detach the subtree from the tree entirely.
fn is_within_subtree(conn: &Connection, folder_id: &str, candidate: Option<&str>) -> rusqlite::Result<bool> {
    let mut cursor = candidate.map(str::to_string);
    for _ in 0..MAX_FOLDER_DEPTH {
        let Some(current) = cursor else { return Ok(false) };
        if current == folder_id {
            return Ok(true);
        }
        cursor = conn
            .query_row(
                "SELECT parent_id FROM api_folders WHERE id = ?1",
                params![current],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
    }
    Ok(true)
}

/// The workspace a node currently sits in, read through its collection — the only row that records
/// it. `None` when the node no longer exists.
fn node_workspace(conn: &Connection, table: &str, id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!(
            "SELECT c.workspace_id FROM {table} n
               JOIN api_collections c ON c.id = n.collection_id
              WHERE n.id = ?1"
        ),
        params![id],
        |row| row.get(0),
    )
    .optional()
}

/// Rewrites `collection_id` on everything under `folder_id` (itself included).
///
/// Dropping a folder into another collection only moves the folder's own row; its descendants
/// still name the collection they came from, and `load_tree` would then render them under a
/// collection they are no longer reachable from. The recursive CTE walks the subtree as it stands
/// *after* the reparent, which is the same subtree either way — the move only changed the link
/// above `folder_id`, never the ones below it.
fn carry_subtree_to_collection(conn: &Connection, folder_id: &str, collection_id: &str) -> rusqlite::Result<()> {
    const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS (
             SELECT ?1
             UNION ALL
             SELECT f.id FROM api_folders f JOIN subtree ON f.parent_id = subtree.id
         )";
    conn.execute(
        &format!("{SUBTREE} UPDATE api_folders SET collection_id = ?2 WHERE id IN (SELECT id FROM subtree)"),
        params![folder_id, collection_id],
    )?;
    conn.execute(
        &format!("{SUBTREE} UPDATE api_requests SET collection_id = ?2 WHERE folder_id IN (SELECT id FROM subtree)"),
        params![folder_id, collection_id],
    )?;
    Ok(())
}

/// Reparents one node and renumbers the destination so `sort_order` stays dense `0..n` with the
/// moved node sitting at `index`.
///
/// Folders and requests are renumbered against their own kind: they live in separate tables with
/// independent `sort_order` columns, and the tree renders folders above requests, so an index the
/// UI computed is an index within one of the two lists.
///
/// Returns `Err` rather than `rusqlite::Error` because the cycle and workspace checks catch caller
/// mistakes, not database failures. The UI guards them too, but a bug there would corrupt the tree
/// irrecoverably — and a node dragged into another workspace's collection would vanish from the
/// tree the user is looking at and reappear in one they cannot see from here.
pub fn move_node(
    conn: &Connection,
    kind: &str,
    id: &str,
    collection_id: &str,
    parent_id: Option<&str>,
    index: i64,
) -> Result<(), String> {
    let (table, parent_col) = match kind {
        "folder" => ("api_folders", "parent_id"),
        "request" => ("api_requests", "folder_id"),
        other => return Err(format!("Unknown node kind {other}")),
    };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    if kind == "folder" && is_within_subtree(&tx, id, parent_id).map_err(|e| e.to_string())? {
        return Err("A folder cannot be moved inside itself".to_string());
    }

    let source_workspace = node_workspace(&tx, table, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown {kind} {id}"))?;
    let destination_workspace: String = tx
        .query_row(
            "SELECT workspace_id FROM api_collections WHERE id = ?1",
            params![collection_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown collection {collection_id}"))?;
    if source_workspace != destination_workspace {
        return Err("A node cannot be moved to a collection in another workspace".to_string());
    }

    tx.execute(
        &format!("UPDATE {table} SET collection_id = ?2, {parent_col} = ?3 WHERE id = ?1"),
        params![id, collection_id, parent_id],
    )
    .map_err(|e| e.to_string())?;

    if kind == "folder" {
        carry_subtree_to_collection(&tx, id, collection_id).map_err(|e| e.to_string())?;
    }

    let mut siblings: Vec<String> = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT id FROM {table}
                  WHERE collection_id = ?1 AND {parent_col} IS ?2 AND id <> ?3
                  ORDER BY sort_order, created_at"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![collection_id, parent_id, id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    let at = (index.max(0) as usize).min(siblings.len());
    siblings.insert(at, id.to_string());

    for (order, sibling) in siblings.iter().enumerate() {
        tx.execute(
            &format!("UPDATE {table} SET sort_order = ?2 WHERE id = ?1"),
            params![sibling, order as i64],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

// ---------- environments ----------

/// One workspace's environments, its own Globals row included — every workspace has one, seeded by
/// `ensure_globals_environment`. Globals sorts first: it is seeded with `sort_order = -1`.
pub fn list_environments(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<ApiEnvironment>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ENVIRONMENT_COLUMNS} FROM api_environments WHERE workspace_id = ?1 ORDER BY sort_order, created_at"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_environment)?;
    rows.collect()
}

fn insert_environment(conn: &Connection, e: &ApiEnvironment) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_environments
            (id, workspace_id, name, variables, is_global, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            e.id,
            e.workspace_id,
            e.name,
            e.variables,
            e.is_global,
            e.sort_order,
            e.created_at,
            e.updated_at
        ],
    )?;
    Ok(())
}

fn next_environment_order(conn: &Connection, workspace_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM api_environments WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )
}

pub fn create_environment(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<ApiEnvironment> {
    let environment = ApiEnvironment {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        variables: "[]".to_string(),
        is_global: false,
        sort_order: next_environment_order(conn, workspace_id)?,
        created_at: now(),
        updated_at: now(),
    };
    insert_environment(conn, &environment)?;
    Ok(environment)
}

/// `is_global` is never written back: which row is the Globals pseudo-environment is the
/// database's business, not something a client round trip gets to reassign.
pub fn update_environment(conn: &Connection, e: &ApiEnvironment) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE api_environments SET name = ?2, variables = ?3, updated_at = ?4 WHERE id = ?1",
        params![e.id, e.name, e.variables, now()],
    )?;
    Ok(())
}

/// A no-op on the Globals row: it is always in scope and there is no UI to recreate it.
pub fn delete_environment(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if let Some(workspace_id) = workspace_of(&tx, "environment", id)? {
        record_tombstones(&tx, "environment", &[id.to_string()], &workspace_id)?;
    }
    tx.execute("DELETE FROM api_environments WHERE id = ?1 AND is_global = 0", params![id])?;
    tx.commit()
}

/// Duplicating Globals is allowed and yields an ordinary environment — its variables are a
/// perfectly reasonable starting point for one. The copy stays in the source's workspace.
pub fn duplicate_environment(conn: &Connection, id: &str) -> rusqlite::Result<ApiEnvironment> {
    let tx = conn.unchecked_transaction()?;
    let source: ApiEnvironment = tx.query_row(
        &format!("SELECT {ENVIRONMENT_COLUMNS} FROM api_environments WHERE id = ?1"),
        params![id],
        map_environment,
    )?;
    let sort_order = next_environment_order(&tx, &source.workspace_id)?;
    let copy = ApiEnvironment {
        id: Uuid::new_v4().to_string(),
        name: format!("{} copy", source.name),
        is_global: false,
        sort_order,
        created_at: now(),
        updated_at: now(),
        ..source
    };
    insert_environment(&tx, &copy)?;
    tx.commit()?;
    Ok(copy)
}

// ---------- history ----------

pub fn list_history(conn: &Connection, workspace_id: &str, limit: i64) -> rusqlite::Result<Vec<ApiHistoryEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {HISTORY_COLUMNS} FROM api_history WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![workspace_id, limit.max(0)], map_history)?;
    rows.collect()
}

/// Inserts one send and trims that workspace's history back to `HISTORY_HARD_CAP`. The workspace
/// comes from the entry itself, and the trim is scoped to it: a busy workspace must not evict the
/// history of one the user has not opened in a while.
///
/// `created_at` is honored when the caller set it, so an entry keeps the instant the request
/// actually ran rather than the instant it happened to be persisted.
pub fn add_history(conn: &Connection, e: &ApiHistoryEntry) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let created_at = if e.created_at.trim().is_empty() { now() } else { e.created_at.clone() };
    tx.execute(
        "INSERT INTO api_history
            (id, workspace_id, request_id, name, protocol, method, url, status, duration_ms, size_bytes,
             snapshot, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO NOTHING",
        params![
            e.id,
            e.workspace_id,
            e.request_id,
            e.name,
            e.protocol,
            e.method,
            e.url,
            e.status,
            e.duration_ms,
            e.size_bytes,
            e.snapshot,
            created_at,
        ],
    )?;
    tx.execute(
        "DELETE FROM api_history WHERE workspace_id = ?1 AND id NOT IN (
             SELECT id FROM api_history WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2
         )",
        params![e.workspace_id, HISTORY_HARD_CAP],
    )?;
    tx.commit()
}

pub fn delete_history(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM api_history WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear_history(conn: &Connection, workspace_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM api_history WHERE workspace_id = ?1", params![workspace_id])?;
    Ok(())
}

// ---------- cookies ----------

pub fn list_cookies(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<ApiCookie>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COOKIE_COLUMNS} FROM api_cookies WHERE workspace_id = ?1 ORDER BY domain, path, name"
    ))?;
    let rows = stmt.query_map(params![workspace_id], map_cookie)?;
    rows.collect()
}

/// Keyed on `(workspace_id, domain, path, name)` rather than `id`: that triple is the cookie's
/// identity on the wire, so a `Set-Cookie` for one the jar already holds has to replace it, not
/// accumulate — but only within the jar it was set in, so a staging session in one workspace never
/// overwrites the same host's session in another.
pub fn upsert_cookie(conn: &Connection, c: &ApiCookie) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_cookies
            (id, workspace_id, domain, path, name, value, secure, http_only, expires, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(workspace_id, domain, path, name) DO UPDATE SET
             value = excluded.value,
             secure = excluded.secure,
             http_only = excluded.http_only,
             expires = excluded.expires,
             updated_at = excluded.updated_at",
        params![c.id, c.workspace_id, c.domain, c.path, c.name, c.value, c.secure, c.http_only, c.expires, now()],
    )?;
    Ok(())
}

pub fn delete_cookie(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM api_cookies WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn clear_cookies(conn: &Connection, workspace_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM api_cookies WHERE workspace_id = ?1", params![workspace_id])?;
    Ok(())
}

/// Everything deleted in this workspace, for the sync layer to turn into tombstone rows.
pub fn list_tombstones(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<(String, String, String)>> {
    let mut stmt =
        conn.prepare("SELECT kind, id, deleted_at FROM api_tombstones WHERE workspace_id = ?1")?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    rows.collect()
}
