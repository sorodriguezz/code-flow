//! Whole-install export/import of the API client's data — every workspace at once, so moving to
//! another machine is one file rather than one export per collection.
//!
//! What travels: workspaces (the shell only — name/icon/colour), collections, folders, requests
//! (examples ride inside each request's `spec`) and environments. What does not: `api_history` and
//! `api_cookies`. History is a log, not configuration, and the cookie jar holds live sessions —
//! carrying either between machines would be noise at best and a leaked session at worst.
//!
//! Projects are deliberately left out too: a project is a path on *this* disk, and recreating rows
//! that point at directories the new machine doesn't have would break the workspace, not restore it.
//!
//! Encryption is not done here. The backend hands the payload over as plain structs; the frontend
//! decides whether the file that reaches the disk is ciphertext (see `src/lib/api/backup.ts`).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::api_queries;
use super::models::{ApiCollection, ApiEnvironment, ApiFolder, ApiRequestRow, Workspace};
use super::queries::now;

/// One workspace and everything the API client keeps under it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupWorkspace {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub collections: Vec<ApiCollection>,
    pub folders: Vec<ApiFolder>,
    pub requests: Vec<ApiRequestRow>,
    pub environments: Vec<ApiEnvironment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiBackup {
    pub workspaces: Vec<BackupWorkspace>,
}

/// How an import should treat the workspaces it names.
#[derive(Debug, Clone, Copy)]
pub struct ImportOptions {
    /// Empty each workspace in the payload before writing it, for a clean restore.
    pub replace: bool,
    /// When a workspace's id is not on this machine, adopt one with the same name instead of
    /// creating it.
    ///
    /// Right for a backup — it is the same person's other machine, where "Personal" was re-created
    /// by hand. **Wrong for a shared workspace**: joining someone else's "Backend" would silently
    /// adopt your own unrelated "Backend", and the next push would upload its contents to them.
    pub match_by_name: bool,
}

/// What an import actually changed. Counts rows the database reported as written, not rows
/// considered: a merge where every record was already current has to be distinguishable from one
/// that landed, or callers reload the whole tree on every quiet sync.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportSummary {
    pub workspaces: i64,
    pub collections: i64,
    pub folders: i64,
    pub requests: i64,
    pub environments: i64,
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

pub fn export_all(conn: &Connection) -> rusqlite::Result<ApiBackup> {
    // One consistent snapshot. Without it the read spans several statements, and a sync applying a
    // pull between two of them would put a backup on disk that holds a collection but not the
    // requests that arrived with it — a state that never existed.
    let tx = conn.unchecked_transaction()?;
    let mut workspaces = Vec::new();
    for ws in super::queries::list_workspaces(&tx)? {
        let tree = api_queries::load_tree(&tx, &ws.id)?;
        workspaces.push(BackupWorkspace {
            id: ws.id.clone(),
            name: ws.name,
            icon: ws.icon,
            color: ws.color,
            collections: tree.collections,
            folders: tree.folders,
            requests: tree.requests,
            environments: api_queries::list_environments(&tx, &ws.id)?,
        });
    }
    Ok(ApiBackup { workspaces })
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Which workspace on *this* machine a backed-up one lands in: the same id if it is still here,
/// otherwise one with the same name (the usual case — "Personal" was created by hand on both
/// machines before either was ever exported), otherwise a fresh row keeping the original id, so
/// the next round trip matches by id and stops guessing.
fn resolve_workspace(conn: &Connection, ws: &BackupWorkspace, match_by_name: bool) -> rusqlite::Result<String> {
    let existing: Vec<Workspace> = super::queries::list_workspaces(conn)?;
    if let Some(found) = existing.iter().find(|w| w.id == ws.id) {
        return Ok(found.id.clone());
    }
    if match_by_name {
        if let Some(found) = existing
            .iter()
            .find(|w| w.name.trim().eq_ignore_ascii_case(ws.name.trim()))
        {
            return Ok(found.id.clone());
        }
    }
    let sort_order = existing.len() as i64;
    // A shared workspace arrives with no icon or colour — the project only stores its id and name —
    // and writing the empty strings through would produce a workspace whose colour is an invalid
    // CSS value, not a default one. The column defaults exist for exactly this.
    let icon = if ws.icon.is_empty() { "folder" } else { &ws.icon };
    let color = if ws.color.is_empty() { "#6366f1" } else { &ws.color };
    conn.execute(
        "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![ws.id, ws.name, icon, color, sort_order, now()],
    )?;
    for (kind, default) in [
        ("review_standard", crate::ai::DEFAULT_PR_REVIEW_STANDARD),
        ("pr_description", crate::ai::DEFAULT_PR_DESCRIPTION_TEMPLATE),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO workspace_prompts (workspace_id, kind, content, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![ws.id, kind, default, now()],
        )?;
    }
    Ok(ws.id.clone())
}

/// Everything the API client owns in one workspace, minus the Globals row: `replace` starts from a
/// clean slate, and Globals is an invariant of the workspace (exactly one row, never deletable)
/// rather than content, so it is merged into instead of dropped and re-created.
fn wipe_workspace(conn: &Connection, workspace_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM api_collections WHERE workspace_id = ?1",
        params![workspace_id],
    )?;
    conn.execute(
        "DELETE FROM api_environments WHERE workspace_id = ?1 AND is_global = 0",
        params![workspace_id],
    )?;
    Ok(())
}

/// `merge` keeps whichever side has the newer `updated_at`; `replace` has already emptied the
/// workspace, so the guard is a no-op there and the row always lands.
const COLLECTION_UPSERT: &str = "\
    INSERT INTO api_collections
        (id, workspace_id, name, description, auth, pre_script, post_script, variables, sort_order, pinned, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        name         = excluded.name,
        description  = excluded.description,
        auth         = excluded.auth,
        pre_script   = excluded.pre_script,
        post_script  = excluded.post_script,
        variables    = excluded.variables,
        sort_order   = excluded.sort_order,
        pinned       = excluded.pinned,
        updated_at   = excluded.updated_at
    WHERE excluded.updated_at > api_collections.updated_at";

/// Folders resolve last-write-wins like everything else, now that they carry an `updated_at` of
/// their own.
const FOLDER_UPSERT: &str = "\
    INSERT INTO api_folders
        (id, collection_id, parent_id, name, description, auth, pre_script, post_script, sort_order, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    ON CONFLICT(id) DO UPDATE SET
        collection_id = excluded.collection_id,
        parent_id     = excluded.parent_id,
        name          = excluded.name,
        description   = excluded.description,
        auth          = excluded.auth,
        pre_script    = excluded.pre_script,
        post_script   = excluded.post_script,
        sort_order    = excluded.sort_order,
        updated_at    = excluded.updated_at
    WHERE excluded.updated_at > api_folders.updated_at";

const REQUEST_UPSERT: &str = "\
    INSERT INTO api_requests
        (id, collection_id, folder_id, name, protocol, method, url, spec, sort_order, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    ON CONFLICT(id) DO UPDATE SET
        collection_id = excluded.collection_id,
        folder_id     = excluded.folder_id,
        name          = excluded.name,
        protocol      = excluded.protocol,
        method        = excluded.method,
        url           = excluded.url,
        spec          = excluded.spec,
        sort_order    = excluded.sort_order,
        updated_at    = excluded.updated_at
    WHERE excluded.updated_at > api_requests.updated_at";

const ENVIRONMENT_UPSERT: &str = "\
    INSERT INTO api_environments
        (id, workspace_id, name, variables, is_global, sort_order, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        name         = excluded.name,
        variables    = excluded.variables,
        sort_order   = excluded.sort_order,
        updated_at   = excluded.updated_at
    WHERE excluded.updated_at > api_environments.updated_at";

/// Applies a whole backup.
///
/// `replace = false` (merge) only ever adds or updates: a request deleted on the other machine
/// stays here, because nothing in the schema records deletions and "absent from the backup" and
/// "created since the backup" are the same thing to a reader. `replace = true` is the clean
/// restore — the workspaces named in the file are emptied first.
pub fn import_all(
    conn: &mut Connection,
    backup: &ApiBackup,
    options: ImportOptions,
) -> rusqlite::Result<ImportSummary> {
    let tx = conn.transaction()?;
    // Folders reference their parent folder and requests reference both, and neither list is
    // guaranteed to arrive parent-first. Deferring lets the whole set land and checks the graph
    // once, at commit.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;

    let mut summary = ImportSummary::default();

    for ws in &backup.workspaces {
        let workspace_id = resolve_workspace(&tx, ws, options.match_by_name)?;
        summary.workspaces += 1;
        if options.replace {
            wipe_workspace(&tx, &workspace_id)?;
        }

        for c in &ws.collections {
            summary.collections += tx.execute(
                COLLECTION_UPSERT,
                params![
                    c.id,
                    workspace_id,
                    c.name,
                    c.description,
                    c.auth,
                    c.pre_script,
                    c.post_script,
                    c.variables,
                    c.sort_order,
                    c.pinned,
                    c.created_at,
                    c.updated_at
                ],
            )? as i64;
        }

        for f in &ws.folders {
            summary.folders += tx.execute(
                FOLDER_UPSERT,
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
                    f.updated_at
                ],
            )? as i64;
        }

        for r in &ws.requests {
            summary.requests += tx.execute(
                REQUEST_UPSERT,
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
                    r.updated_at
                ],
            )? as i64;
        }

        for e in &ws.environments {
            if e.is_global {
                // One Globals row per workspace is an invariant this import must not break: the
                // one already here keeps its id and only takes the backup's variables.
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT id FROM api_environments WHERE workspace_id = ?1 AND is_global = 1 LIMIT 1",
                        params![workspace_id],
                        |row| row.get(0),
                    )
                    .ok();
                if let Some(id) = existing {
                    summary.environments += tx.execute(
                        "UPDATE api_environments SET variables = ?2, updated_at = ?3
                          WHERE id = ?1 AND ?3 > updated_at",
                        params![id, e.variables, e.updated_at],
                    )? as i64;
                    continue;
                }
            }
            summary.environments += tx.execute(
                ENVIRONMENT_UPSERT,
                params![
                    e.id,
                    workspace_id,
                    e.name,
                    e.variables,
                    e.is_global,
                    e.sort_order,
                    e.created_at,
                    e.updated_at
                ],
            )? as i64;
        }
    }

    tx.commit()?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two ways a backup is applied, named so the assertions read as intent.
    const MERGE: ImportOptions = ImportOptions { replace: false, match_by_name: true };
    const RESTORE: ImportOptions = ImportOptions { replace: true, match_by_name: true };

    /// A database with one workspace holding a collection, a nested folder, a request, Globals and
    /// one selectable environment — the shape every assertion below is about.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Flow', '', '', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                VALUES ('c1', 'w1', 'My API', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_folders (id, collection_id, parent_id, name, created_at)
                VALUES ('f1', 'c1', NULL, 'Auth', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_requests (id, collection_id, folder_id, name, url, spec, created_at, updated_at)
                VALUES ('r1', 'c1', 'f1', 'Login', 'https://a', '{}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_environments (id, workspace_id, name, variables, is_global, sort_order, created_at)
                VALUES ('e1', 'w1', 'Dev', '[]', 0, 0, '2026-01-01T00:00:00+00:00');
            -- Every workspace has exactly one Globals row; the import must not create a second.
            INSERT INTO api_environments (id, workspace_id, name, variables, is_global, sort_order, created_at)
                VALUES ('g1', 'w1', 'Globals', '[]', 1, 0, '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();
        conn
    }

    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn export_then_import_into_an_empty_database_restores_everything() {
        let source = seeded();
        let backup = export_all(&source).unwrap();

        let mut target = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&target).unwrap();
        let summary = import_all(&mut target, &backup, MERGE).unwrap();

        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_collections WHERE id = 'c1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_folders WHERE id = 'f1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 1);
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM api_environments WHERE id = 'e1'"),
            1
        );
        assert!(summary.requests >= 1);
        // The workspace came across, and the request still hangs off its folder.
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM api_requests WHERE folder_id = 'f1'"),
            1
        );
    }

    #[test]
    fn importing_twice_never_duplicates_and_never_makes_a_second_globals() {
        let source = seeded();
        let backup = export_all(&source).unwrap();

        let mut target = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&target).unwrap();
        import_all(&mut target, &backup, MERGE).unwrap();
        import_all(&mut target, &backup, MERGE).unwrap();

        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM workspaces WHERE id = 'w1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_collections"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_requests"), 1);
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM api_environments WHERE workspace_id = 'w1' AND is_global = 1"
            ),
            1
        );
    }

    #[test]
    fn merging_keeps_the_newer_side_and_leaves_local_rows_alone() {
        let source = seeded();
        let backup = export_all(&source).unwrap();

        let mut target = seeded();
        // Local edits: one request renamed *after* the backup was taken, plus a request the backup
        // has never heard of. Merge must keep both.
        target
            .execute_batch(
                r#"
                UPDATE api_requests SET name = 'Login v2', updated_at = '2027-01-01T00:00:00+00:00' WHERE id = 'r1';
                INSERT INTO api_requests (id, collection_id, folder_id, name, url, spec, created_at, updated_at)
                    VALUES ('r2', 'c1', NULL, 'Local only', 'https://b', '{}', '2026-06-01T00:00:00+00:00', '2026-06-01T00:00:00+00:00');
                "#,
            )
            .unwrap();

        import_all(&mut target, &backup, MERGE).unwrap();

        let name: String = target
            .query_row("SELECT name FROM api_requests WHERE id = 'r1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Login v2", "the newer local edit must survive a merge");
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_requests WHERE id = 'r2'"), 1);
    }

    #[test]
    fn replacing_drops_what_the_backup_does_not_contain() {
        let source = seeded();
        let backup = export_all(&source).unwrap();

        let mut target = seeded();
        target
            .execute_batch(
                "INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                 VALUES ('c9', 'w1', 'Not in the backup', '2026-06-01T00:00:00+00:00', '2026-06-01T00:00:00+00:00');",
            )
            .unwrap();

        import_all(&mut target, &backup, RESTORE).unwrap();

        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_collections WHERE id = 'c9'"), 0);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_collections WHERE id = 'c1'"), 1);
    }

    #[test]
    fn a_workspace_with_the_same_name_is_reused_rather_than_duplicated() {
        let source = seeded();
        let backup = export_all(&source).unwrap();

        // Same name, different id — the workspace the user re-created by hand on the new machine.
        let mut target = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&target).unwrap();
        target
            .execute("DELETE FROM workspaces", [])
            .unwrap();
        target
            .execute_batch(
                "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('other-id', 'Flow', '', '', 0, '2026-01-01T00:00:00+00:00');",
            )
            .unwrap();

        import_all(&mut target, &backup, MERGE).unwrap();

        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM workspaces"), 1);
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM api_collections WHERE workspace_id = 'other-id'"
            ),
            1
        );
    }
}
