//! Translating one workspace between the local tables and the shared `cf_items` rows.
//!
//! Both directions go through the backup module's shapes rather than a second serialisation of the
//! same records: a shared item's payload *is* an `ApiCollection`, `ApiFolder`, `ApiRequestRow` or
//! `ApiEnvironment`, so applying a pull is the merge import that already exists and is tested.

use rusqlite::{params, Connection};

use super::api_backup::{self, ApiBackup, BackupWorkspace, ImportOptions, ImportSummary};
use super::api_queries;
use super::queries::now;
use crate::supabase::SharedItem;

/// What a pull did, split because the two halves fail differently: an import that applied nothing
/// is a no-op, a deletion sweep that removed a hundred rows is not.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SyncResult {
    pub applied: ImportSummary,
    pub deleted: i64,
    /// The newest `updated_at` seen, so the next pull can ask for changes after it.
    pub cursor: String,
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// The fields of an `AuthConfig` that hold a credential, per scheme. The same list the plaintext
/// backup uses (`src/lib/api/backup.ts`); the two must not drift, or one path protects a secret the
/// other publishes.
const AUTH_SECRET_FIELDS: &[(&str, &[&str])] = &[
    ("basic", &["password"]),
    ("digest", &["password"]),
    ("bearer", &["token"]),
    ("apikey", &["value"]),
    ("jwt", &["secret"]),
    ("awsv4", &["secretKey", "sessionToken"]),
    ("oauth2", &["clientSecret", "password", "accessToken", "refreshToken"]),
];

/// Blanks the credential fields of a JSON `AuthConfig` string, leaving its shape intact.
fn redact_auth(raw: &str) -> String {
    if raw.trim().is_empty() {
        return raw.to_string();
    }
    let Ok(mut auth) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    redact_auth_value(&mut auth);
    auth.to_string()
}

fn redact_auth_value(auth: &mut serde_json::Value) {
    for (scheme, fields) in AUTH_SECRET_FIELDS {
        let Some(block) = auth.get_mut(scheme) else { continue };
        for field in *fields {
            if let Some(slot) = block.get_mut(field) {
                *slot = serde_json::Value::String(String::new());
            }
        }
    }
}

/// Blanks both values of every variable flagged secret, keeping the key so the shape survives and
/// each member can fill in their own.
fn redact_variables(raw: &str) -> String {
    let Ok(mut variables) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    let Some(list) = variables.as_array_mut() else {
        return raw.to_string();
    };
    for variable in list.iter_mut() {
        if variable.get("secret").and_then(|s| s.as_bool()) != Some(true) {
            continue;
        }
        for field in ["initialValue", "currentValue"] {
            if let Some(slot) = variable.get_mut(field) {
                *slot = serde_json::Value::String(String::new());
            }
        }
    }
    variables.to_string()
}

/// A request's `spec` carries its own auth block inside the JSON blob.
fn redact_spec(raw: &str) -> String {
    let Ok(mut spec) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    if let Some(auth) = spec.get_mut("auth") {
        redact_auth_value(auth);
    }
    spec.to_string()
}

/// Everything in this workspace, as rows to upsert remotely — live records and the tombstones of
/// everything deleted here.
///
/// **Nothing marked secret leaves this machine.** The invitation code is the only credential the
/// shared project has, so anyone who ends up holding it can read every record in the workspace —
/// which makes a synced production token a token published to whoever the code reaches. Secret
/// variable values and the credential half of every auth block are blanked here, exactly as they
/// are in a plaintext backup; the keys travel so each member fills in their own.
///
/// Redacting on the way out and not locally is what keeps this safe in both directions: the sender
/// keeps its own values, and a peer pulling the redacted copy back cannot overwrite them, because
/// last-write-wins needs a strictly newer timestamp and the redacted row carries the same one.
///
/// Every timestamp is the record's own `updated_at`, never `now()`. A record re-stamped on each
/// push would look changed forever: every peer would pull it back every cycle, that pull would
/// count as a change, and the change would schedule another push. The loop is silent and endless,
/// and it is the reason folders and environments were given an `updated_at` of their own.
pub fn local_items(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<SharedItem>> {
    let tree = api_queries::load_tree(conn, workspace_id)?;
    let environments = api_queries::list_environments(conn, workspace_id)?;
    let mut items = Vec::new();

    for mut collection in tree.collections {
        collection.auth = redact_auth(&collection.auth);
        collection.variables = redact_variables(&collection.variables);
        items.push(SharedItem {
            id: collection.id.clone(),
            workspace_id: workspace_id.to_string(),
            kind: "collection".into(),
            updated_at: collection.updated_at.clone(),
            payload: serde_json::to_value(&collection).unwrap_or(serde_json::Value::Null),
            synced_at: String::new(),
            deleted: false,
        });
    }
    for mut folder in tree.folders {
        folder.auth = redact_auth(&folder.auth);
        items.push(SharedItem {
            id: folder.id.clone(),
            workspace_id: workspace_id.to_string(),
            kind: "folder".into(),
            updated_at: folder.updated_at.clone(),
            payload: serde_json::to_value(&folder).unwrap_or(serde_json::Value::Null),
            synced_at: String::new(),
            deleted: false,
        });
    }
    for mut request in tree.requests {
        request.spec = redact_spec(&request.spec);
        items.push(SharedItem {
            id: request.id.clone(),
            workspace_id: workspace_id.to_string(),
            kind: "request".into(),
            updated_at: request.updated_at.clone(),
            payload: serde_json::to_value(&request).unwrap_or(serde_json::Value::Null),
            synced_at: String::new(),
            deleted: false,
        });
    }
    for mut environment in environments {
        // Globals is per-installation scaffolding — every workspace has exactly one, created
        // locally — so sharing it would mean two hosts fighting over which row is *the* Globals.
        if environment.is_global {
            continue;
        }
        environment.variables = redact_variables(&environment.variables);
        items.push(SharedItem {
            id: environment.id.clone(),
            workspace_id: workspace_id.to_string(),
            kind: "environment".into(),
            updated_at: environment.updated_at.clone(),
            payload: serde_json::to_value(&environment).unwrap_or(serde_json::Value::Null),
            synced_at: String::new(),
            deleted: false,
        });
    }

    // The deletions recorded by the delete paths, so a removal travels instead of being undone by
    // the next pull.
    for (kind, id, deleted_at) in api_queries::list_tombstones(conn, workspace_id)? {
        items.push(SharedItem {
            id,
            workspace_id: workspace_id.to_string(),
            kind,
            payload: serde_json::Value::Object(serde_json::Map::new()),
            updated_at: deleted_at,
            synced_at: String::new(),
            deleted: true,
        });
    }

    Ok(items)
}

/// A tombstone built by hand — for tests, and for callers that already know a record is gone.
pub fn tombstone(workspace_id: &str, kind: &str, id: &str) -> SharedItem {
    SharedItem {
        id: id.to_string(),
        workspace_id: workspace_id.to_string(),
        kind: kind.to_string(),
        payload: serde_json::Value::Object(serde_json::Map::new()),
        updated_at: now(),
        synced_at: String::new(),
        deleted: true,
    }
}

fn table_for(kind: &str) -> Option<&'static str> {
    match kind {
        "collection" => Some("api_collections"),
        "folder" => Some("api_folders"),
        "request" => Some("api_requests"),
        "environment" => Some("api_environments"),
        _ => None,
    }
}

/// Applies a pulled batch: live rows through the merge import, tombstones as deletes.
pub fn apply_items(
    conn: &mut Connection,
    workspace_id: &str,
    workspace_name: &str,
    items: Vec<SharedItem>,
) -> rusqlite::Result<SyncResult> {
    let mut cursor = String::new();
    let mut live = BackupWorkspace {
        id: workspace_id.to_string(),
        name: workspace_name.to_string(),
        icon: String::new(),
        color: String::new(),
        collections: Vec::new(),
        folders: Vec::new(),
        requests: Vec::new(),
        environments: Vec::new(),
    };
    let mut graves: Vec<(String, String)> = Vec::new();

    for item in items {
        // The cursor advances on the server's clock, never the writer's — see `synced_at` in
        // `supabase_schema.sql`. Falling back to `updated_at` covers items built locally, which is
        // only ever the tests.
        let seen = if item.synced_at.is_empty() {
            &item.updated_at
        } else {
            &item.synced_at
        };
        if *seen > cursor {
            cursor = seen.clone();
        }
        if item.deleted {
            graves.push((item.kind, item.id));
            continue;
        }
        // A payload this build can't read is skipped rather than fatal: a newer client may be
        // sharing a record with a field this one doesn't know, and dropping one request is a much
        // better outcome than refusing the whole sync.
        match item.kind.as_str() {
            "collection" => {
                if let Ok(row) = serde_json::from_value(item.payload) {
                    live.collections.push(row);
                }
            }
            "folder" => {
                if let Ok(row) = serde_json::from_value(item.payload) {
                    live.folders.push(row);
                }
            }
            "request" => {
                if let Ok(row) = serde_json::from_value(item.payload) {
                    live.requests.push(row);
                }
            }
            "environment" => {
                if let Ok(row) = serde_json::from_value(item.payload) {
                    live.environments.push(row);
                }
            }
            _ => {}
        }
    }

    // A peer that deleted a collection tombstones its whole subtree, but the two can arrive in
    // either order and a pull can be cut short. Dropping children whose parent is neither in this
    // batch nor already here keeps a foreign-key failure from taking the entire sync down; the next
    // pull brings them back if the parent turns out to exist after all.
    let known_collections: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM api_collections WHERE workspace_id = ?1",
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| row.get::<_, String>(0))?;
        let mut ids: Vec<String> = rows.collect::<rusqlite::Result<_>>()?;
        ids.extend(live.collections.iter().map(|c| c.id.clone()));
        ids
    };
    live.folders
        .retain(|f| known_collections.contains(&f.collection_id));
    live.requests
        .retain(|r| known_collections.contains(&r.collection_id));

    let applied = api_backup::import_all(
        conn,
        &ApiBackup {
            workspaces: vec![live],
        },
        // Never by name: adopting a local workspace that merely shares a name with someone else's
        // shared one would upload its contents to them on the next push.
        ImportOptions { replace: false, match_by_name: false },
    )?;

    let mut deleted = 0;
    let tx = conn.transaction()?;
    for (kind, id) in graves {
        let Some(table) = table_for(&kind) else { continue };
        // Scoped to the workspace so a tombstone from a shared workspace can never reach a row of
        // another one that happens to share an id.
        let sql = match table {
            "api_collections" | "api_environments" => {
                format!("DELETE FROM {table} WHERE id = ?1 AND workspace_id = ?2")
            }
            _ => format!(
                "DELETE FROM {table} WHERE id = ?1 AND collection_id IN \
                 (SELECT id FROM api_collections WHERE workspace_id = ?2)"
            ),
        };
        deleted += tx.execute(&sql, params![id, workspace_id])? as i64;
    }
    tx.commit()?;

    Ok(SyncResult {
        applied,
        deleted,
        cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn a_workspace_becomes_items_of_every_kind_except_globals() {
        let items = local_items(&seeded(), "w1").unwrap();
        let kinds: Vec<&str> = items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds.iter().filter(|k| **k == "collection").count(), 1);
        assert_eq!(kinds.iter().filter(|k| **k == "folder").count(), 1);
        assert_eq!(kinds.iter().filter(|k| **k == "request").count(), 1);
        // Dev is shared; Globals is not.
        assert_eq!(kinds.iter().filter(|k| **k == "environment").count(), 1);
        assert!(items.iter().all(|i| i.workspace_id == "w1" && !i.deleted));
    }

    #[test]
    fn a_pull_lands_the_other_machines_work_in_the_local_tables() {
        let items = local_items(&seeded(), "w1").unwrap();

        let mut target = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&target).unwrap();
        target
            .execute_batch(
                "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Flow', '', '', 0, '2026-01-01T00:00:00+00:00');",
            )
            .unwrap();

        let result = apply_items(&mut target, "w1", "Flow", items).unwrap();

        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 1);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM api_folders WHERE id = 'f1'"), 1);
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM api_environments WHERE id = 'e1'"),
            1
        );
        assert!(!result.cursor.is_empty(), "the cursor must advance for the next pull");
    }

    #[test]
    fn a_tombstone_removes_the_row_it_names() {
        let mut conn = seeded();
        let graves = vec![
            tombstone("w1", "request", "r1"),
            tombstone("w1", "environment", "e1"),
        ];

        let result = apply_items(&mut conn, "w1", "Flow", graves).unwrap();

        assert_eq!(result.deleted, 2);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 0);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_environments WHERE id = 'e1'"), 0);
    }

    #[test]
    fn a_tombstone_cannot_reach_into_another_workspace() {
        let mut conn = seeded();
        conn.execute_batch(
            r#"
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w2', 'Other', '', '', 1, '2026-01-01T00:00:00+00:00');
            INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                VALUES ('c2', 'w2', 'Theirs', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();

        // A shared workspace 'w1' must not be able to delete a collection that lives in 'w2'.
        let result = apply_items(&mut conn, "w1", "Flow", vec![tombstone("w1", "collection", "c2")]).unwrap();

        assert_eq!(result.deleted, 0);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_collections WHERE id = 'c2'"), 1);
    }

    #[test]
    fn an_unreadable_payload_is_skipped_rather_than_failing_the_sync() {
        let mut conn = seeded();
        let good = local_items(&conn, "w1").unwrap();
        let mut items = vec![SharedItem {
            id: "junk".into(),
            workspace_id: "w1".into(),
            kind: "request".into(),
            payload: serde_json::json!({ "unexpected": true }),
            updated_at: "2027-01-01T00:00:00+00:00".into(),
            synced_at: String::new(),
            deleted: false,
        }];
        items.extend(good);

        let result = apply_items(&mut conn, "w1", "Flow", items).unwrap();

        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_requests WHERE id = 'junk'"), 0);
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM api_requests WHERE id = 'r1'"), 1);
        // Nothing was newer than what is already here, so nothing was written — see the next test
        // for why that number has to be zero rather than "one row considered".
        assert_eq!(result.applied.requests, 0);
    }

    /// The guard against a sync that never settles. A pull whose records are all already current
    /// has to report zero changes: the caller reloads the tree when the count is non-zero, that
    /// reload looks like a local edit, and a local edit schedules another push. Counting rows
    /// *considered* rather than rows *written* closes that loop and spins forever.
    #[test]
    fn pulling_what_we_already_have_reports_no_changes() {
        let mut conn = seeded();
        let items = local_items(&conn, "w1").unwrap();

        let first = apply_items(&mut conn, "w1", "Flow", items.clone()).unwrap();
        let second = apply_items(&mut conn, "w1", "Flow", items).unwrap();

        for result in [&first, &second] {
            assert_eq!(result.applied.collections, 0);
            assert_eq!(result.applied.folders, 0);
            assert_eq!(result.applied.requests, 0);
            assert_eq!(result.applied.environments, 0);
            assert_eq!(result.deleted, 0);
        }
    }

    /// A peer's newer edit still lands — the zero above is "nothing changed", not "nothing works".
    #[test]
    fn a_newer_edit_from_a_peer_is_applied_and_counted() {
        let mut conn = seeded();
        let mut items = local_items(&conn, "w1").unwrap();
        for item in &mut items {
            if item.kind == "request" {
                item.payload["name"] = serde_json::Value::String("Login (theirs)".into());
                item.payload["updated_at"] =
                    serde_json::Value::String("2027-01-01T00:00:00+00:00".into());
                item.updated_at = "2027-01-01T00:00:00+00:00".into();
            }
        }

        let result = apply_items(&mut conn, "w1", "Flow", items).unwrap();

        assert_eq!(result.applied.requests, 1);
        let name: String = conn
            .query_row("SELECT name FROM api_requests WHERE id = 'r1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Login (theirs)");
    }

    /// Deleting a request has to leave a trace, or the next pull puts it straight back.
    #[test]
    fn a_local_delete_travels_as_a_tombstone() {
        let conn = seeded();
        api_queries::delete_request(&conn, "r1").unwrap();

        let items = local_items(&conn, "w1").unwrap();
        let grave = items
            .iter()
            .find(|i| i.id == "r1")
            .expect("the deletion must be in the payload");

        assert!(grave.deleted);
        assert_eq!(grave.kind, "request");
    }

    /// Nothing marked secret may reach the shared project: the invitation code is its only
    /// credential, so a synced production token is a token published to whoever that code reaches.
    #[test]
    fn secrets_never_leave_this_machine() {
        let conn = seeded();
        conn.execute_batch(
            r#"
            UPDATE api_environments
               SET variables = '[{"key":"apiKey","initialValue":"AKIA-REAL","currentValue":"live-value","secret":true,"enabled":true},
                                 {"key":"baseUrl","initialValue":"https://api.example.com","currentValue":"","secret":false,"enabled":true}]'
             WHERE id = 'e1';
            UPDATE api_collections
               SET auth = '{"type":"bearer","bearer":{"token":"SUPER-SECRET"},"basic":{"username":"u","password":"pw"}}'
             WHERE id = 'c1';
            UPDATE api_requests
               SET spec = '{"auth":{"type":"basic","basic":{"username":"u","password":"hunter2"},"oauth2":{"clientSecret":"cs-999","clientId":"keep-me"}}}'
             WHERE id = 'r1';
            "#,
        )
        .unwrap();

        let wire = serde_json::to_string(&local_items(&conn, "w1").unwrap()).unwrap();

        for secret in ["AKIA-REAL", "live-value", "SUPER-SECRET", "hunter2", "cs-999"] {
            assert!(!wire.contains(secret), "{secret} must not be pushed");
        }
        // The shape survives, so a teammate sees the keys and fills in their own values.
        for kept in ["apiKey", "baseUrl", "https://api.example.com", "keep-me"] {
            assert!(wire.contains(kept), "{kept} must still be shared");
        }

        // And redaction is outbound only — the local copy is untouched.
        let local: String = conn
            .query_row("SELECT variables FROM api_environments WHERE id = 'e1'", [], |r| r.get(0))
            .unwrap();
        assert!(local.contains("AKIA-REAL"));
    }

    /// Deleting a collection cascades locally, so the whole subtree has to be tombstoned: a peer
    /// told only that the collection is gone would keep its requests and re-upload them as
    /// children of something that no longer exists.
    #[test]
    fn deleting_a_collection_tombstones_its_whole_subtree() {
        let conn = seeded();
        api_queries::delete_collection(&conn, "c1").unwrap();

        let items = local_items(&conn, "w1").unwrap();
        let graves: Vec<&str> = items
            .iter()
            .filter(|i| i.deleted)
            .map(|i| i.id.as_str())
            .collect();

        for id in ["c1", "f1", "r1"] {
            assert!(graves.contains(&id), "{id} must be tombstoned");
        }
    }
}
