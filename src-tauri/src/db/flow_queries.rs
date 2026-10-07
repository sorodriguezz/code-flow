//! CRUD over `flows` and `flow_folders` — the Flujos workspace.
//!
//! A sibling of [`super::diagram_queries`], and the same three rules hold:
//!
//! - **The tree never carries documents.** [`load_tree`] projects [`FlowMeta`] — every column but
//!   `spec`. A flow's document arrives alone, through [`get_flow`], when it is opened.
//! - **The root is a real place.** `folder_id` may be null, and every query that scopes by folder
//!   treats null as a container like any other.
//! - **`spec` is opaque here.** The command layer validates it (`crate::flows::spec`) and hands
//!   down the derived columns; nothing in this file parses a document.
//!
//! Two things differ. Flows carry the `scope` column (`'global'` puts a flow on every workspace's
//! shelf — see `codeflow-row-scope`), and saves are **versioned**: `version` counts them, and a save
//! that names the version it started from is refused as a conflict when another write got there
//! first, so a stale window can never put back an older drawing over a newer one.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use super::queries::now;
use super::version_queries;
use crate::flows::spec::Derived;

/// The `doc_versions.kind` a flow's history is filed under.
pub const VERSION_KIND: &str = "flow";

const META_COLUMNS: &str = "id, workspace_id, scope, folder_id, name, description, node_count, \
                            trigger_types, active, version, sort_order, created_at, updated_at, \
                            exec_hash, (exec_hash = '' OR exec_hash = trusted_hash)";
const FOLDER_COLUMNS: &str = "id, workspace_id, name, sort_order, created_at, updated_at";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FlowMeta {
    pub id: String,
    /// The flow's home. A global flow still has one: it is where it was made, and where it goes back
    /// to being local if it is restricted again.
    pub workspace_id: String,
    pub scope: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub description: String,
    pub node_count: i64,
    /// JSON array of trigger type ids, in canvas order — see `spec::Derived`.
    pub trigger_types: String,
    /// Whether its triggers are armed. Nothing reads it before the scheduler exists.
    pub active: bool,
    pub version: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    /// What the flow would run, hashed — `spec::executable_hash`; empty when it runs nothing.
    pub exec_hash: String,
    /// Whether what it runs is what the user trusted: written in this app's editor, or reviewed and
    /// accepted. An imported flow is not, until someone looks at it.
    pub trusted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FlowRow {
    #[serde(flatten)]
    pub meta: FlowMeta,
    pub spec: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FlowFolderRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlowsTree {
    pub folders: Vec<FlowFolderRow>,
    pub flows: Vec<FlowMeta>,
}

/// What a save answers. `meta` is `None` when the flow was deleted while it was open; `conflict`
/// says the save named a version that is no longer the latest, and nothing was written.
#[derive(Debug, Clone, Serialize)]
pub struct FlowSaved {
    pub meta: Option<FlowMeta>,
    pub conflict: bool,
    /// Set when the flow was active and its triggers could not be armed again from what was saved:
    /// it has been switched off, and this says why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_error: Option<String>,
}

fn map_meta(row: &rusqlite::Row) -> rusqlite::Result<FlowMeta> {
    Ok(FlowMeta {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        scope: row.get(2)?,
        folder_id: row.get(3)?,
        name: row.get(4)?,
        description: row.get(5)?,
        node_count: row.get(6)?,
        trigger_types: row.get(7)?,
        active: row.get::<_, i64>(8)? != 0,
        version: row.get(9)?,
        sort_order: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        exec_hash: row.get(13)?,
        trusted: row.get::<_, i64>(14)? != 0,
    })
}

fn map_folder(row: &rusqlite::Row) -> rusqlite::Result<FlowFolderRow> {
    Ok(FlowFolderRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn trigger_json(derived: &Derived) -> String {
    serde_json::to_string(&derived.trigger_types).unwrap_or_else(|_| "[]".into())
}

// ---------- reads ----------

/// The workspace's folders and every flow it can see: its own, and the global ones.
pub fn load_tree(conn: &Connection, workspace_id: &str) -> rusqlite::Result<FlowsTree> {
    let mut folders = conn.prepare(&format!(
        "SELECT {FOLDER_COLUMNS} FROM flow_folders WHERE workspace_id = ?1 \
         ORDER BY sort_order, name COLLATE NOCASE"
    ))?;
    let folders = folders
        .query_map(params![workspace_id], map_folder)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut flows = conn.prepare(&format!(
        "SELECT {META_COLUMNS} FROM flows WHERE workspace_id = ?1 OR scope = 'global' \
         ORDER BY sort_order, name COLLATE NOCASE"
    ))?;
    let flows = flows
        .query_map(params![workspace_id], map_meta)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(FlowsTree { folders, flows })
}

pub fn get_meta(conn: &Connection, id: &str) -> rusqlite::Result<Option<FlowMeta>> {
    conn.query_row(&format!("SELECT {META_COLUMNS} FROM flows WHERE id = ?1"), params![id], map_meta)
        .optional()
}

/// One flow with its document — the only read in this file that returns `spec`.
pub fn get_flow(conn: &Connection, id: &str) -> rusqlite::Result<Option<FlowRow>> {
    conn.query_row(
        &format!("SELECT {META_COLUMNS}, spec FROM flows WHERE id = ?1"),
        params![id],
        |row| Ok(FlowRow { meta: map_meta(row)?, spec: row.get(15)? }),
    )
    .optional()
}

/// The next `sort_order` at the end of a container (null = the root).
fn next_flow_order(conn: &Connection, workspace_id: &str, folder_id: Option<&str>) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM flows WHERE workspace_id = ?1 AND folder_id IS ?2",
        params![workspace_id, folder_id],
        |row| row.get(0),
    )
}

// ---------- flows ----------

pub fn create_flow(
    conn: &Connection,
    workspace_id: &str,
    folder_id: Option<&str>,
    name: &str,
    spec: &str,
    derived: &Derived,
    trusted: bool,
) -> rusqlite::Result<FlowMeta> {
    create_flow_as(conn, &Uuid::new_v4().to_string(), workspace_id, folder_id, name, spec, derived, trusted)
}

/// [`create_flow`] under a given id — a shared flow keeps the id of its share, on every machine
/// that holds it, so a share and the flow it publishes are the same row everywhere.
#[allow(clippy::too_many_arguments)]
pub fn create_flow_as(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    folder_id: Option<&str>,
    name: &str,
    spec: &str,
    derived: &Derived,
    trusted: bool,
) -> rusqlite::Result<FlowMeta> {
    let id = id.to_string();
    let stamp = now();
    let order = next_flow_order(conn, workspace_id, folder_id)?;
    let trusted_hash = if trusted { derived.exec_hash.as_str() } else { "" };
    conn.execute(
        "INSERT INTO flows (id, workspace_id, scope, folder_id, name, description, spec, node_count, \
                            trigger_types, active, version, sort_order, created_at, updated_at, exec_hash, trusted_hash) \
         VALUES (?1, ?2, 'workspace', ?3, ?4, '', ?5, ?6, ?7, 0, 1, ?8, ?9, ?9, ?10, ?11)",
        params![id, workspace_id, folder_id, name, spec, derived.node_count, trigger_json(derived), order, stamp, derived.exec_hash, trusted_hash],
    )?;
    Ok(get_meta(conn, &id)?.expect("the row was just written"))
}

/// The autosave path. See [`FlowSaved`] for the two shapes of "not saved".
///
/// The previous document is recorded as a version before it is overwritten — throttled and capped
/// by `version_queries`, so an afternoon of dragging is a handful of snapshots, not hundreds. An
/// unchanged document writes nothing and keeps its version number: autosave fires on a timer as
/// well as on an edit.
pub fn save_spec(
    conn: &Connection,
    id: &str,
    spec: &str,
    derived: &Derived,
    expected_version: Option<i64>,
    keep_trust: bool,
) -> rusqlite::Result<FlowSaved> {
    let current: Option<(i64, String, String, bool)> = conn
        .query_row(
            "SELECT version, name, spec, (exec_hash = '' OR exec_hash = trusted_hash) FROM flows WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? != 0)),
        )
        .optional()?;
    let Some((version, name, previous, was_trusted)) = current else {
        return Ok(FlowSaved { meta: None, conflict: false, trigger_error: None });
    };
    if expected_version.is_some_and(|expected| expected != version) {
        return Ok(FlowSaved { meta: get_meta(conn, id)?, conflict: true, trigger_error: None });
    }
    if previous == spec {
        return Ok(FlowSaved { meta: get_meta(conn, id)?, conflict: false, trigger_error: None });
    }
    let stamp = now();
    let _ = version_queries::record_version(conn, VERSION_KIND, id, &name, &previous, &stamp);
    // Trust follows the user's own edits: a trusted flow edited here stays trusted, whatever it now
    // runs — the user wrote it. One not yet trusted stays that way until it is reviewed: moving a node
    // of an imported flow must not accept its commands. A change the user did not write (an accepted
    // AI proposal, `keep_trust: false`) carries nothing either.
    let was_trusted = was_trusted && keep_trust;
    conn.execute(
        "UPDATE flows SET spec = ?2, node_count = ?3, trigger_types = ?4, version = version + 1, \
                          updated_at = ?5, exec_hash = ?6, trusted_hash = CASE WHEN ?7 THEN ?6 ELSE trusted_hash END \
         WHERE id = ?1",
        params![id, spec, derived.node_count, trigger_json(derived), stamp, derived.exec_hash, was_trusted],
    )?;
    Ok(FlowSaved { meta: get_meta(conn, id)?, conflict: false, trigger_error: None })
}

/// A teammate's version of a shared flow, written over this one (`flows::share`). Like a save it
/// keeps the previous document in the history and bumps `version` — so an editor holding the old
/// one gets `conflict` on its next save instead of writing over it. Unlike a save it **never
/// carries trust** (someone else wrote it) and takes the remote's `updated_at`, which is the clock
/// the share's three-way comparison runs on.
pub fn apply_shared(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    spec: &str,
    derived: &Derived,
    updated_at: &str,
) -> rusqlite::Result<Option<FlowMeta>> {
    let current: Option<(String, String)> = conn
        .query_row("SELECT name, spec FROM flows WHERE id = ?1", params![id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    let Some((previous_name, previous)) = current else { return Ok(None) };
    if previous != spec {
        let _ = version_queries::record_version(conn, VERSION_KIND, id, &previous_name, &previous, &now());
    }
    conn.execute(
        "UPDATE flows SET spec = ?2, name = ?3, description = ?4, node_count = ?5, trigger_types = ?6, \
                          version = version + 1, updated_at = ?7, exec_hash = ?8 \
         WHERE id = ?1",
        params![id, spec, name, description, derived.node_count, trigger_json(derived), updated_at, derived.exec_hash],
    )?;
    get_meta(conn, id)
}

/// Sets a flow's `updated_at` without touching anything else — a shared flow whose two sides turned
/// out to hold the same document agree on the remote's clock.
pub fn set_updated_at(conn: &Connection, id: &str, updated_at: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE flows SET updated_at = ?2 WHERE id = ?1", params![id, updated_at])?;
    Ok(())
}

/// Trusts what a flow runs — the hash the user reviewed. Refused (`None`) when the flow changed
/// since: what was reviewed is not what it would run now.
pub fn trust_flow(conn: &Connection, id: &str, exec_hash: &str) -> rusqlite::Result<Option<FlowMeta>> {
    let changed = conn.execute("UPDATE flows SET trusted_hash = exec_hash WHERE id = ?1 AND exec_hash = ?2", params![id, exec_hash])?;
    if changed == 0 {
        return Ok(None);
    }
    get_meta(conn, id)
}

/// Switches a flow on or off. Only the flag: arming its triggers is `flows::triggers`' business.
pub fn set_active(conn: &Connection, id: &str, active: bool) -> rusqlite::Result<Option<FlowMeta>> {
    conn.execute("UPDATE flows SET active = ?2 WHERE id = ?1", params![id, active as i64])?;
    get_meta(conn, id)
}

/// Every active flow, in any workspace — what startup arms.
pub fn active_flow_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT id FROM flows WHERE active = 1")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect()
}

pub fn rename_flow(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<Option<FlowMeta>> {
    conn.execute("UPDATE flows SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, name, now()])?;
    get_meta(conn, id)
}

pub fn set_description(conn: &Connection, id: &str, description: &str) -> rusqlite::Result<Option<FlowMeta>> {
    conn.execute(
        "UPDATE flows SET description = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, description, now()],
    )?;
    get_meta(conn, id)
}

/// Files a flow in a folder (or the root), at the end of it. A folder of another workspace is
/// refused by answering `None` — the tree that offered it was stale.
///
/// `updated_at` is left alone: where a flow is filed is not part of the flow. A move that touched
/// it would mark a flow saved in a repository as edited since (`flows_repo_scan` compares the two)
/// and send a shared flow's unchanged document to every teammate (`flows::share` syncs by it).
pub fn move_flow(conn: &Connection, id: &str, folder_id: Option<&str>) -> rusqlite::Result<Option<FlowMeta>> {
    let Some(meta) = get_meta(conn, id)? else { return Ok(None) };
    if let Some(folder) = folder_id {
        let home: Option<String> = conn
            .query_row("SELECT workspace_id FROM flow_folders WHERE id = ?1", params![folder], |row| row.get(0))
            .optional()?;
        if home.as_deref() != Some(meta.workspace_id.as_str()) {
            return Ok(None);
        }
    }
    if meta.folder_id.as_deref() == folder_id {
        return Ok(Some(meta));
    }
    let order = next_flow_order(conn, &meta.workspace_id, folder_id)?;
    conn.execute(
        "UPDATE flows SET folder_id = ?2, sort_order = ?3 WHERE id = ?1",
        params![id, folder_id, order],
    )?;
    get_meta(conn, id)
}

/// Puts one list of a workspace's flows — a folder's, or the root's — in the order given: the
/// first id gets `sort_order` 0. What a drag in the explorer ends with, after the move that put the
/// flow in that list.
///
/// Only the workspace's own flows are renumbered. A global flow of another workspace is drawn in the
/// root list too, but its order belongs to its home's list; an id of one is skipped rather than
/// written into a numbering it is not part of. `updated_at` is left alone, as in [`move_flow`].
pub fn reorder_flows(conn: &Connection, workspace_id: &str, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut update = tx.prepare("UPDATE flows SET sort_order = ?2 WHERE id = ?1 AND workspace_id = ?3")?;
        for (index, id) in ids.iter().enumerate() {
            update.execute(params![id, index as i64, workspace_id])?;
        }
    }
    tx.commit()
}

/// The same for a workspace's folders, which are one flat list.
pub fn reorder_folders(conn: &Connection, workspace_id: &str, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut update =
            tx.prepare("UPDATE flow_folders SET sort_order = ?2 WHERE id = ?1 AND workspace_id = ?3")?;
        for (index, id) in ids.iter().enumerate() {
            update.execute(params![id, index as i64, workspace_id])?;
        }
    }
    tx.commit()
}

/// `true` puts the flow on every workspace's shelf; `false` back on its home's alone.
pub fn set_scope(conn: &Connection, id: &str, global: bool) -> rusqlite::Result<Option<FlowMeta>> {
    let scope = if global { "global" } else { "workspace" };
    conn.execute("UPDATE flows SET scope = ?2, updated_at = ?3 WHERE id = ?1", params![id, scope, now()])?;
    get_meta(conn, id)
}

/// Moves a flow to another workspace and files it *there*: local, at the root (its folder belongs to
/// the workspace it is leaving). The same rule `note_queries::move_book_to_workspace` keeps.
pub fn move_to_workspace(conn: &Connection, id: &str, workspace_id: &str) -> rusqlite::Result<Option<FlowMeta>> {
    let order = next_flow_order(conn, workspace_id, None)?;
    conn.execute(
        "UPDATE flows SET workspace_id = ?2, scope = 'workspace', folder_id = NULL, sort_order = ?3, \
                          updated_at = ?4 WHERE id = ?1",
        params![id, workspace_id, order, now()],
    )?;
    get_meta(conn, id)
}

/// A copy beside the original, under the name the caller chose (it is translated upstairs). A copy
/// starts inactive whatever the original was: duplicating a scheduled flow must not double its runs.
pub fn duplicate_flow(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<Option<FlowMeta>> {
    let Some(row) = get_flow(conn, id)? else { return Ok(None) };
    let copy = Uuid::new_v4().to_string();
    let stamp = now();
    let order = next_flow_order(conn, &row.meta.workspace_id, row.meta.folder_id.as_deref())?;
    conn.execute(
        "INSERT INTO flows (id, workspace_id, scope, folder_id, name, description, spec, node_count, \
                            trigger_types, active, version, sort_order, created_at, updated_at, exec_hash, trusted_hash) \
         SELECT ?1, workspace_id, scope, folder_id, ?2, description, spec, node_count, trigger_types, 0, 1, ?3, ?4, ?4, \
                exec_hash, trusted_hash \
         FROM flows WHERE id = ?5",
        params![copy, name, order, stamp, id],
    )?;
    get_meta(conn, &copy)
}

/// Deletes a flow and its history together — a flow is deleted from a confirmation that names it,
/// and fifty snapshots of something the user asked to be rid of are not a recovery feature.
pub fn delete_flow(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    version_queries::delete_versions(&tx, VERSION_KIND, id)?;
    // The file stays in its repository; only the link to it goes.
    tx.execute("DELETE FROM flow_repo_links WHERE flow_id = ?1", params![id])?;
    // Its executions have no foreign key to cascade from (see `add_flow_run_tables`); their files
    // are the caller's to remove, after the commit.
    super::flow_run_queries::delete_runs_of_flow(&tx, id)?;
    tx.execute("DELETE FROM flow_run_days WHERE flow_id = ?1", params![id])?;
    let deleted = tx.execute("DELETE FROM flows WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(deleted)
}

// ---------- repository links ----------

/// A flow linked to a file in one of the workspace's repositories — see `flows::repo`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoLink {
    pub flow_id: String,
    pub project_id: String,
    pub path: String,
    pub file_hash: String,
    pub synced_at: String,
}

fn map_link(row: &rusqlite::Row) -> rusqlite::Result<RepoLink> {
    Ok(RepoLink { flow_id: row.get(0)?, project_id: row.get(1)?, path: row.get(2)?, file_hash: row.get(3)?, synced_at: row.get(4)? })
}

pub fn repo_links(conn: &Connection) -> rusqlite::Result<Vec<RepoLink>> {
    let mut statement = conn.prepare("SELECT flow_id, project_id, path, file_hash, synced_at FROM flow_repo_links")?;
    let rows = statement.query_map([], map_link)?;
    rows.collect()
}

pub fn repo_link(conn: &Connection, flow_id: &str) -> rusqlite::Result<Option<RepoLink>> {
    conn.query_row("SELECT flow_id, project_id, path, file_hash, synced_at FROM flow_repo_links WHERE flow_id = ?1", params![flow_id], map_link)
        .optional()
}

/// Links a flow to a file, or moves its link — a file is linked to one flow at most.
pub fn put_repo_link(conn: &Connection, flow_id: &str, project_id: &str, path: &str, file_hash: &str) -> rusqlite::Result<RepoLink> {
    let stamp = now();
    conn.execute("DELETE FROM flow_repo_links WHERE project_id = ?1 AND path = ?2 AND flow_id != ?3", params![project_id, path, flow_id])?;
    conn.execute(
        "INSERT INTO flow_repo_links (flow_id, project_id, path, file_hash, synced_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(flow_id) DO UPDATE SET project_id = ?2, path = ?3, file_hash = ?4, synced_at = ?5",
        params![flow_id, project_id, path, file_hash, stamp],
    )?;
    Ok(RepoLink { flow_id: flow_id.into(), project_id: project_id.into(), path: path.into(), file_hash: file_hash.into(), synced_at: stamp })
}

pub fn delete_repo_link(conn: &Connection, flow_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_repo_links WHERE flow_id = ?1", params![flow_id])?;
    Ok(())
}

// ---------- templates ----------

/// A template the user saved from a flow — see `migrations::add_flow_templates`. Listed without its
/// document, as the flows are.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowTemplateMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The node type whose glyph stands for it: the first trigger of the flow it was saved from.
    pub icon: String,
    pub node_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

const TEMPLATE_COLUMNS: &str = "id, name, description, icon, node_count, created_at, updated_at";

fn map_template(row: &rusqlite::Row) -> rusqlite::Result<FlowTemplateMeta> {
    Ok(FlowTemplateMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        icon: row.get(3)?,
        node_count: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// Every saved template, by name.
pub fn list_templates(conn: &Connection) -> rusqlite::Result<Vec<FlowTemplateMeta>> {
    let mut statement = conn.prepare(&format!("SELECT {TEMPLATE_COLUMNS} FROM flow_templates ORDER BY name COLLATE NOCASE, created_at"))?;
    let rows = statement.query_map([], map_template)?;
    rows.collect()
}

pub fn get_template(conn: &Connection, id: &str) -> rusqlite::Result<Option<FlowTemplateMeta>> {
    conn.query_row(&format!("SELECT {TEMPLATE_COLUMNS} FROM flow_templates WHERE id = ?1"), params![id], map_template)
        .optional()
}

/// A template's document and the trust it carries: `(spec, trusted_hash)`.
pub fn template_document(conn: &Connection, id: &str) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row("SELECT spec, trusted_hash FROM flow_templates WHERE id = ?1", params![id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
}

/// Whether a flow made from a template starts trusted: when it runs nothing, or exactly what the
/// user had trusted in the flow the template was saved from — a duplicate's rule, across time.
pub fn template_trusted(trusted_hash: &str, derived: &Derived) -> bool {
    derived.exec_hash.is_empty() || (!trusted_hash.is_empty() && trusted_hash == derived.exec_hash)
}

/// Saves `flow` (its document as stored, read with [`get_flow`]) as a template called `name`: a new
/// one, taking the flow's description, or over `replace` — the same row, so it keeps its place and
/// the name and description it was given; only what it contains changes. A `replace` that no longer
/// exists is saved as a new one. The flow's trust comes along only for the document it was given on.
pub fn save_template(
    conn: &Connection,
    flow: &FlowRow,
    name: &str,
    replace: Option<&str>,
    derived: &Derived,
) -> rusqlite::Result<FlowTemplateMeta> {
    let trusted_hash = if flow.meta.trusted && derived.exec_hash == flow.meta.exec_hash { derived.exec_hash.as_str() } else { "" };
    let icon = derived.trigger_types.first().map(String::as_str).unwrap_or_default();
    let stamp = now();
    if let Some(id) = replace {
        let updated = conn.execute(
            "UPDATE flow_templates SET icon = ?2, spec = ?3, node_count = ?4, trusted_hash = ?5, updated_at = ?6 WHERE id = ?1",
            params![id, icon, flow.spec, derived.node_count, trusted_hash, stamp],
        )?;
        if updated > 0 {
            return Ok(get_template(conn, id)?.expect("the row was just written"));
        }
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO flow_templates (id, name, description, icon, spec, node_count, trusted_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, name, flow.meta.description, icon, flow.spec, derived.node_count, trusted_hash, stamp],
    )?;
    Ok(get_template(conn, &id)?.expect("the row was just written"))
}

/// Renames a template and rewrites its description. `None` when it is gone.
pub fn update_template(conn: &Connection, id: &str, name: &str, description: &str) -> rusqlite::Result<Option<FlowTemplateMeta>> {
    conn.execute(
        "UPDATE flow_templates SET name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, description, now()],
    )?;
    get_template(conn, id)
}

/// Deletes a template. Flows made from it are their own and stay as they are.
pub fn delete_template(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM flow_templates WHERE id = ?1", params![id])? > 0)
}

// ---------- folders ----------

pub fn create_folder(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<FlowFolderRow> {
    let id = Uuid::new_v4().to_string();
    let stamp = now();
    let order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM flow_folders WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO flow_folders (id, workspace_id, parent_id, name, sort_order, created_at, updated_at) \
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?5)",
        params![id, workspace_id, name, order, stamp],
    )?;
    conn.query_row(&format!("SELECT {FOLDER_COLUMNS} FROM flow_folders WHERE id = ?1"), params![id], map_folder)
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<Option<FlowFolderRow>> {
    conn.execute(
        "UPDATE flow_folders SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, now()],
    )?;
    conn.query_row(&format!("SELECT {FOLDER_COLUMNS} FROM flow_folders WHERE id = ?1"), params![id], map_folder)
        .optional()
}

/// Deletes a folder and puts its flows back at the root — explicitly, rather than trusting the
/// foreign key's `ON DELETE SET NULL` to be enforced on this connection.
///
/// They go after the root's own flows, in the order they had in the folder: the root's order is
/// one the user may have dragged into shape, and numbers that collided with it would shuffle both.
/// `updated_at` is left alone, as in [`move_flow`].
pub fn delete_folder(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let home: Option<String> = tx
        .query_row("SELECT workspace_id FROM flow_folders WHERE id = ?1", params![id], |row| row.get(0))
        .optional()?;
    if let Some(workspace_id) = home {
        let base = next_flow_order(&tx, &workspace_id, None)?;
        let members: Vec<String> = {
            let mut statement =
                tx.prepare("SELECT id FROM flows WHERE folder_id = ?1 ORDER BY sort_order, name COLLATE NOCASE")?;
            let rows = statement.query_map(params![id], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for (index, flow) in members.iter().enumerate() {
            tx.execute(
                "UPDATE flows SET folder_id = NULL, sort_order = ?2 WHERE id = ?1",
                params![flow, base + index as i64],
            )?;
        }
    }
    let deleted = tx.execute("DELETE FROM flow_folders WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flows::spec;

    fn workspaces() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        // On, as the app's own connection has it: the workspace test leans on the cascade.
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Plataforma', 'workflow', '#111', 0, '2026-01-01T00:00:00+00:00'),
                        ('w2', 'Personal', 'workflow', '#222', 1, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
    }

    fn create(conn: &Connection, workspace: &str, name: &str) -> FlowMeta {
        let text = spec::empty_text();
        let derived = spec::derive(&spec::parse(&text).unwrap());
        create_flow(conn, workspace, None, name, &text, &derived, true).unwrap()
    }

    fn with_trigger() -> (String, Derived) {
        let text = r#"{"schema":1,"nodes":[{"id":"n1","type":"trigger.schedule","name":"Cada hora","pos":[0,0]}]}"#;
        let derived = spec::derive(&spec::parse(text).unwrap());
        (text.to_string(), derived)
    }

    #[test]
    fn a_workspace_sees_its_own_flows_and_the_global_ones() {
        let conn = workspaces();
        let mine = create(&conn, "w1", "Informe");
        let theirs = create(&conn, "w2", "Respaldo");
        assert_eq!(load_tree(&conn, "w1").unwrap().flows, vec![mine.clone()]);

        set_scope(&conn, &theirs.id, true).unwrap();
        let seen: Vec<String> = load_tree(&conn, "w1").unwrap().flows.into_iter().map(|f| f.id).collect();
        assert_eq!(seen.len(), 2);
        assert!(seen.contains(&theirs.id));
    }

    #[test]
    fn a_save_bumps_the_version_records_history_and_refuses_a_stale_writer() {
        let conn = workspaces();
        let flow = create(&conn, "w1", "Informe");
        assert_eq!(flow.version, 1);
        let (text, derived) = with_trigger();

        let saved = save_spec(&conn, &flow.id, &text, &derived, Some(1), true).unwrap();
        let meta = saved.meta.unwrap();
        assert!(!saved.conflict);
        assert_eq!(meta.version, 2);
        assert_eq!(meta.node_count, 1);
        assert_eq!(meta.trigger_types, r#"["trigger.schedule"]"#);
        // The document it replaced is now the flow's first version.
        assert_eq!(version_queries::list_versions(&conn, VERSION_KIND, &flow.id).unwrap().len(), 1);

        // A window still holding version 1 is told, and writes nothing.
        let stale = save_spec(&conn, &flow.id, &spec::empty_text(), &spec::derive(&spec::empty()), Some(1), true).unwrap();
        assert!(stale.conflict);
        assert_eq!(get_flow(&conn, &flow.id).unwrap().unwrap().spec, text);

        // Saving the same document again changes nothing, version included.
        let same = save_spec(&conn, &flow.id, &text, &derived, Some(2), true).unwrap();
        assert_eq!(same.meta.unwrap().version, 2);
    }

    #[test]
    fn a_deleted_flow_answers_none_and_takes_its_history() {
        let conn = workspaces();
        let flow = create(&conn, "w1", "Informe");
        let (text, derived) = with_trigger();
        save_spec(&conn, &flow.id, &text, &derived, None, true).unwrap();
        assert_eq!(delete_flow(&conn, &flow.id).unwrap(), 1);
        assert!(save_spec(&conn, &flow.id, &text, &derived, None, true).unwrap().meta.is_none());
        assert!(version_queries::list_versions(&conn, VERSION_KIND, &flow.id).unwrap().is_empty());
    }

    #[test]
    fn folders_file_flows_and_give_them_back_when_deleted() {
        let conn = workspaces();
        let flow = create(&conn, "w1", "Informe");
        let folder = create_folder(&conn, "w1", "Pagos").unwrap();
        let elsewhere = create_folder(&conn, "w2", "Ajena").unwrap();

        assert_eq!(move_flow(&conn, &flow.id, Some(&folder.id)).unwrap().unwrap().folder_id, Some(folder.id.clone()));
        // Another workspace's folder is not a place this flow can go.
        assert!(move_flow(&conn, &flow.id, Some(&elsewhere.id)).unwrap().is_none());

        delete_folder(&conn, &folder.id).unwrap();
        assert_eq!(get_meta(&conn, &flow.id).unwrap().unwrap().folder_id, None);
    }

    /// The workspace's own flows as the tree lists them — the global ones of other workspaces left out.
    fn order(conn: &Connection, workspace: &str) -> Vec<String> {
        load_tree(conn, workspace)
            .unwrap()
            .flows
            .into_iter()
            .filter(|f| f.workspace_id == workspace)
            .map(|f| f.name)
            .collect()
    }

    /// A drag ends with a move and a renumbering, and neither is an edit of the flow.
    #[test]
    fn a_drag_orders_a_list_without_marking_its_flows_edited() {
        let conn = workspaces();
        let a = create(&conn, "w1", "A");
        let b = create(&conn, "w1", "B");
        let c = create(&conn, "w1", "C");
        let foreign = create(&conn, "w2", "Ajeno");
        set_scope(&conn, &foreign.id, true).unwrap();
        let before = get_meta(&conn, &a.id).unwrap().unwrap().updated_at;

        reorder_flows(&conn, "w1", &[c.id.clone(), a.id.clone(), b.id.clone(), foreign.id.clone()]).unwrap();
        assert_eq!(order(&conn, "w1"), ["C", "A", "B"]);
        assert_eq!(
            get_meta(&conn, &foreign.id).unwrap().unwrap().sort_order,
            foreign.sort_order,
            "another workspace's flow keeps its own place in its own list",
        );

        let folder = create_folder(&conn, "w1", "Pagos").unwrap();
        let moved = move_flow(&conn, &a.id, Some(&folder.id)).unwrap().unwrap();
        assert_eq!(moved.folder_id.as_deref(), Some(folder.id.as_str()));
        assert_eq!(moved.updated_at, before, "where a flow is filed is not part of the flow");
    }

    /// Deleting a folder hands its flows to the root after the root's own, in the folder's order.
    #[test]
    fn a_deleted_folder_hands_its_flows_to_the_end_of_the_root() {
        let conn = workspaces();
        let root = create(&conn, "w1", "Raíz");
        let folder = create_folder(&conn, "w1", "Pagos").unwrap();
        let second = create(&conn, "w1", "Segundo");
        let first = create(&conn, "w1", "Primero");
        move_flow(&conn, &second.id, Some(&folder.id)).unwrap();
        move_flow(&conn, &first.id, Some(&folder.id)).unwrap();
        reorder_flows(&conn, "w1", &[first.id.clone(), second.id.clone()]).unwrap();

        delete_folder(&conn, &folder.id).unwrap();
        let tree = load_tree(&conn, "w1").unwrap();
        let names: Vec<_> = tree.flows.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Raíz", "Primero", "Segundo"]);
        assert!(tree.flows.iter().all(|f| f.folder_id.is_none()));
        assert_eq!(get_meta(&conn, &root.id).unwrap().unwrap().sort_order, 0);
    }

    #[test]
    fn folders_take_the_order_they_are_dragged_into() {
        let conn = workspaces();
        let a = create_folder(&conn, "w1", "A").unwrap();
        let b = create_folder(&conn, "w1", "B").unwrap();
        let other = create_folder(&conn, "w2", "Otra").unwrap();
        reorder_folders(&conn, "w1", &[b.id.clone(), a.id.clone(), other.id.clone()]).unwrap();
        let names: Vec<_> = load_tree(&conn, "w1").unwrap().folders.into_iter().map(|f| f.name).collect();
        assert_eq!(names, ["B", "A"]);
        let untouched: i64 = conn
            .query_row("SELECT sort_order FROM flow_folders WHERE id = ?1", params![other.id], |row| row.get(0))
            .unwrap();
        assert_eq!(untouched, other.sort_order, "another workspace's folder is not renumbered");
    }

    fn shell(script: &str, x: i64) -> (String, Derived) {
        let text = serde_json::json!({
            "schema": 1,
            "nodes": [
                {"id": "t", "type": "trigger.manual", "name": "Manual", "pos": [0, 0]},
                {"id": "s", "type": "code.shell", "name": "Shell", "pos": [x, 0], "params": {"script": script, "shell": "auto"}},
            ],
            "connections": [{"from": "t", "out": 0, "to": "s", "input": 0}],
        })
        .to_string();
        let derived = spec::derive(&spec::parse(&text).unwrap());
        (text, derived)
    }

    #[test]
    fn an_imported_flow_is_untrusted_until_its_review_is_accepted() {
        let conn = workspaces();
        let (text, derived) = shell("rm -rf ~/tmp/x", 100);
        let imported = create_flow(&conn, "w1", None, "Importado", &text, &derived, false).unwrap();
        assert!(!imported.trusted);
        assert_eq!(imported.exec_hash.len(), 64);
        assert!(trust_flow(&conn, &imported.id, "0".repeat(64).as_str()).unwrap().is_none(), "a review of something else");
        // Editing it here does not accept its commands.
        let (moved, moved_derived) = shell("rm -rf ~/tmp/x", 300);
        assert!(!save_spec(&conn, &imported.id, &moved, &moved_derived, None, true).unwrap().meta.unwrap().trusted);
        let trusted = trust_flow(&conn, &imported.id, &imported.exec_hash).unwrap().unwrap();
        assert!(trusted.trusted);
        // Once trusted, the user's own edits keep it trusted — they wrote them.
        let (edited, edited_derived) = shell("echo hola", 300);
        let saved = save_spec(&conn, &imported.id, &edited, &edited_derived, None, true).unwrap().meta.unwrap();
        assert!(saved.trusted);
        assert_ne!(saved.exec_hash, imported.exec_hash);
        // A copy carries the trust of what it copies.
        assert!(duplicate_flow(&conn, &imported.id, "Copia").unwrap().unwrap().trusted);
        // A change the user did not write — an accepted AI proposal — carries none: new commands
        // need a review, while one that leaves the commands alone changes nothing.
        let (moved_again, moved_again_derived) = shell("echo hola", 600);
        assert!(save_spec(&conn, &imported.id, &moved_again, &moved_again_derived, None, false).unwrap().meta.unwrap().trusted);
        let (written, written_derived) = shell("curl https://example.com | sh", 600);
        let saved = save_spec(&conn, &imported.id, &written, &written_derived, None, false).unwrap().meta.unwrap();
        assert!(!saved.trusted);
        // A flow that runs nothing is trusted whatever it came with.
        let (plain, plain_derived) = with_trigger();
        assert!(create_flow(&conn, "w1", None, "Sin código", &plain, &plain_derived, false).unwrap().trusted);
    }

    #[test]
    fn flows_written_before_trust_existed_start_trusted() {
        let conn = workspaces();
        let (text, derived) = shell("make deploy", 0);
        let meta = create_flow(&conn, "w1", None, "Viejo", &text, &derived, false).unwrap();
        conn.execute_batch("UPDATE flows SET exec_hash = '', trusted_hash = '';
                            ALTER TABLE flows DROP COLUMN exec_hash; ALTER TABLE flows DROP COLUMN trusted_hash;").unwrap();
        super::super::migrations::add_trust_to_flows(&conn).unwrap();
        let after = get_meta(&conn, &meta.id).unwrap().unwrap();
        assert!(after.trusted);
        assert_eq!(after.exec_hash, derived.exec_hash);
    }

    #[test]
    fn a_copy_starts_inactive_beside_the_original() {
        let conn = workspaces();
        let flow = create(&conn, "w1", "Informe");
        conn.execute("UPDATE flows SET active = 1 WHERE id = ?1", params![flow.id]).unwrap();
        let copy = duplicate_flow(&conn, &flow.id, "Informe (copia)").unwrap().unwrap();
        assert_ne!(copy.id, flow.id);
        assert!(!copy.active);
        assert_eq!(copy.folder_id, flow.folder_id);
        assert_eq!(get_flow(&conn, &copy.id).unwrap().unwrap().spec, spec::empty_text());
    }

    #[test]
    fn moving_to_another_workspace_files_it_there_locally() {
        let conn = workspaces();
        let flow = create(&conn, "w1", "Informe");
        let folder = create_folder(&conn, "w1", "Pagos").unwrap();
        move_flow(&conn, &flow.id, Some(&folder.id)).unwrap();
        set_scope(&conn, &flow.id, true).unwrap();

        let moved = move_to_workspace(&conn, &flow.id, "w2").unwrap().unwrap();
        assert_eq!(moved.workspace_id, "w2");
        assert_eq!(moved.scope, "workspace");
        assert_eq!(moved.folder_id, None);
        assert!(load_tree(&conn, "w1").unwrap().flows.is_empty());
    }

    /// A workspace deleted out from under a global flow must not take the flow with it — the rule
    /// `rehome_global_rows` keeps for every scoped table.
    #[test]
    fn a_global_flow_survives_its_home_workspace() {
        let conn = workspaces();
        let global = create(&conn, "w1", "Compartido");
        let local = create(&conn, "w1", "Local");
        set_scope(&conn, &global.id, true).unwrap();
        crate::db::queries::delete_workspace(&conn, "w1").unwrap();
        let left: Vec<String> = load_tree(&conn, "w2").unwrap().flows.into_iter().map(|f| f.id).collect();
        assert_eq!(left, vec![global.id]);
        assert!(get_meta(&conn, &local.id).unwrap().is_none());
    }

    #[test]
    fn a_template_carries_trust_only_from_a_trusted_flow() {
        let conn = workspaces();
        let (text, derived) = shell("make deploy", 0);
        let mine = create_flow(&conn, "w1", None, "Desplegar", &text, &derived, true).unwrap();
        let imported = create_flow(&conn, "w1", None, "Importado", &text, &derived, false).unwrap();
        let from_mine = save_template(&conn, &get_flow(&conn, &mine.id).unwrap().unwrap(), "Desplegar", None, &derived).unwrap();
        let from_imported = save_template(&conn, &get_flow(&conn, &imported.id).unwrap().unwrap(), "Importado", None, &derived).unwrap();
        assert_eq!((from_mine.icon.as_str(), from_mine.node_count), ("trigger.manual", 2));

        let (kept, trusted_hash) = template_document(&conn, &from_mine.id).unwrap().unwrap();
        assert_eq!(kept, text);
        assert!(template_trusted(&trusted_hash, &derived), "the user's own, unchanged, starts trusted");
        let (_, untrusted) = template_document(&conn, &from_imported.id).unwrap().unwrap();
        assert!(!template_trusted(&untrusted, &derived), "an unreviewed flow's template is reviewed too");
        // A template that runs nothing needs no review, whoever saved it.
        let quiet = spec::derive(&spec::parse(&spec::empty_text()).unwrap());
        assert!(template_trusted("", &quiet));
        // And one whose commands are not the ones trusted is reviewed, however it got that way.
        let (_, other) = shell("rm -rf build", 0);
        assert!(!template_trusted(&trusted_hash, &other));
    }

    #[test]
    fn saving_over_a_template_keeps_its_place_and_its_words() {
        let conn = workspaces();
        let (text, derived) = shell("make deploy", 0);
        let flow = create_flow(&conn, "w1", None, "Desplegar", &text, &derived, true).unwrap();
        let first = save_template(&conn, &get_flow(&conn, &flow.id).unwrap().unwrap(), "Desplegar", None, &derived).unwrap();
        update_template(&conn, &first.id, "Desplegar a producción", "Sube la rama principal").unwrap();

        let (changed, changed_derived) = shell("make release", 40);
        let mut row = get_flow(&conn, &flow.id).unwrap().unwrap();
        row.spec = changed.clone();
        let replaced = save_template(&conn, &row, "Desplegar", Some(&first.id), &changed_derived).unwrap();
        assert_eq!(replaced.id, first.id);
        assert_eq!((replaced.name.as_str(), replaced.description.as_str()), ("Desplegar a producción", "Sube la rama principal"));
        assert_eq!(template_document(&conn, &first.id).unwrap().unwrap().0, changed);
        assert_eq!(list_templates(&conn).unwrap().len(), 1);

        // Deleting it leaves the flows made from it alone; a replace aimed at it saves a new one.
        assert!(delete_template(&conn, &first.id).unwrap());
        assert!(!delete_template(&conn, &first.id).unwrap());
        assert!(get_meta(&conn, &flow.id).unwrap().is_some());
        let again = save_template(&conn, &row, "Desplegar", Some(&first.id), &changed_derived).unwrap();
        assert_ne!(again.id, first.id);
        assert_eq!(list_templates(&conn).unwrap(), vec![again]);
    }
}
