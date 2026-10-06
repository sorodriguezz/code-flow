//! IPC surface for the built-in API client.
//!
//! Two kinds of command live here and nothing else: thin wrappers over `db::api_queries`, and
//! forwarders into the `api::*` transports. **Nothing here parses a request spec, resolves a
//! `{{variable}}` or applies an auth scheme** — the frontend does all of that and hands down a
//! fully-resolved request, which is what keeps a new protocol or auth mode a frontend-only change.

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::api::{
    ApiRegistry, GrpcCallRequest, GrpcDescribeRequest, GrpcResponse, GrpcServiceInfo, HttpResponse, HttpSendRequest,
    MqttConnectRequest, SocketIoConnectRequest, WsConnectRequest,
};
use crate::db::api_secrets::{self, Owner, Shape};
use crate::db::{api_cookie_seal, api_import, api_queries, api_sync, api_trust, models::*, Db};
use crate::gdrive;
use crate::supabase;

// ---------- credentials ----------
//
// Every command that reads a collection, folder, request or environment hands the frontend its
// credentials back (`api_secrets::unseal_*`), and every one that writes one moves them into the OS
// credential store first (`seal_*`) — see `db::api_secrets`. The reads are `async` so a Keychain
// prompt on the first one waits on a worker rather than on the thread that paints the window; the
// writes stay on the main thread, in order, so two saves of one request can never land their
// credentials in the opposite order from their rows.

/// Seals rows that were written with literals in them — by an import, a pull, a conflict taken from
/// the other side. Best-effort: what the store refuses stays where it was, and `seal_row` has
/// already arranged for the next launch to try again.
fn seal_rows_quietly(db: &Db, rows: impl IntoIterator<Item = (Owner, String)>) {
    let store = api_secrets::os_store();
    for (owner, id) in rows {
        let _ = api_secrets::seal_row(db, owner, &id, &store);
    }
}

fn owner_of(kind: &str) -> Option<Owner> {
    match kind {
        "collection" => Some(Owner::Collection),
        "folder" => Some(Owner::Folder),
        "request" => Some(Owner::Request),
        _ => None,
    }
}

// ---------- tree: collections ----------

#[tauri::command(async)]
pub fn api_load_tree(db: State<Db>, workspace_id: String) -> Result<ApiTree, String> {
    let mut tree = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        api_queries::load_tree(&conn, &workspace_id).map_err(|e| e.to_string())?
    };
    api_secrets::unseal_tree(&mut tree, &api_secrets::os_store());
    Ok(tree)
}

#[tauri::command]
pub fn api_create_collection(db: State<Db>, workspace_id: String, name: String) -> Result<ApiCollection, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::create_collection(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_update_collection(db: State<Db>, collection: ApiCollection) -> Result<(), String> {
    let _guard = api_secrets::seal_guard();
    let store = api_secrets::os_store();
    let mut collection = collection;
    let keep = api_secrets::seal_collection(&mut collection, &store);
    let before = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let before = api_secrets::row_keys(&conn, Owner::Collection, &collection.id).map_err(|e| e.to_string())?;
        api_queries::update_collection(&conn, &collection).map_err(|e| e.to_string())?;
        if keep.failed > 0 {
            api_secrets::retry_later(&conn).map_err(|e| e.to_string())?;
        }
        before
    };
    api_secrets::forget_stale(&store, &before, &keep.keys);
    Ok(())
}

/// Deletes a collection — for everyone, or only here, depending on whose it is.
///
/// A **guest** never deletes a shared collection for the others: their "Delete" leaves the share and
/// removes this machine's copy, and no tombstone is written that could travel (see
/// `api_queries::delete_collection_locally`). Deciding it here rather than trusting the caller to
/// pick the right command is the point — this used to be the generic delete, and a guest's click
/// deleted the collection on every machine, the host's included. The **host's** delete is the one
/// that travels, after the UI has said so and offered to stop sharing instead.
#[tauri::command]
pub fn api_delete_collection(db: State<Db>, id: String) -> Result<(), String> {
    let _guard = api_secrets::seal_guard();
    let (keys, guest) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let keys = api_secrets::collection_tree_keys(&conn, &id).map_err(|e| e.to_string())?;
        let guest = api_queries::shared_collection(&conn, &id)
            .map_err(|e| e.to_string())?
            .is_some_and(|share| share.role != "owner");
        if guest {
            api_queries::delete_collection_locally(&conn, &id).map_err(|e| e.to_string())?;
        } else {
            api_queries::delete_collection(&conn, &id).map_err(|e| e.to_string())?;
        }
        (keys, guest)
    };
    if guest {
        // The share is already forgotten here; a token the credential store would not let go of
        // is an orphan entry, not a reason to report a delete that happened as one that failed.
        let _ = supabase::leave(&id);
    }
    api_secrets::forget(&api_secrets::os_store(), keys);
    Ok(())
}

/// The copy's rows carry the original's markers, so the credentials behind them are copied to keys
/// of the copy's own — a copy that shared them would lose its token the day the original is deleted.
#[tauri::command]
pub fn api_duplicate_collection(db: State<Db>, id: String) -> Result<ApiCollection, String> {
    let _guard = api_secrets::seal_guard();
    let store = api_secrets::os_store();
    let (copy, folders, requests) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let copy = api_queries::duplicate_collection_mapped(&conn, &id).map_err(|e| e.to_string())?;
        let folders: Vec<(String, String, String)> = copy
            .folders
            .iter()
            .filter_map(|(from, to)| {
                conn.query_row("SELECT auth FROM api_folders WHERE id = ?1", [to], |row| row.get(0))
                    .ok()
                    .map(|auth: String| (from.clone(), to.clone(), auth))
            })
            .collect();
        let requests: Vec<(String, String, String)> = copy
            .requests
            .iter()
            .filter_map(|(from, to)| {
                conn.query_row("SELECT spec FROM api_requests WHERE id = ?1", [to], |row| row.get(0))
                    .ok()
                    .map(|spec: String| (from.clone(), to.clone(), spec))
            })
            .collect();
        (copy.collection, folders, requests)
    };
    api_secrets::copy_credentials(&copy.auth, Shape::Auth, Owner::Collection, &id, &copy.id, &store);
    api_secrets::copy_credentials(&copy.variables, Shape::Variables, Owner::Collection, &id, &copy.id, &store);
    for (from, to, auth) in folders {
        api_secrets::copy_credentials(&auth, Shape::Auth, Owner::Folder, &from, &to, &store);
    }
    for (from, to, spec) in requests {
        api_secrets::copy_credentials(&spec, Shape::Spec, Owner::Request, &from, &to, &store);
    }
    let mut copy = copy;
    api_secrets::unseal_collection(&mut copy, &store);
    Ok(copy)
}

/// Puts a collection on every workspace's shelf, or takes it back off.
#[tauri::command]
pub fn api_set_collection_scope(db: State<Db>, id: String, global: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::set_collection_scope(&conn, &id, global).map_err(|e| e.to_string())
}

/// Moves a collection to another workspace and files it there. Carries the share row's denormalised
/// workspace with it — see the query.
#[tauri::command]
pub fn api_move_collection_to_workspace(
    db: State<Db>,
    id: String,
    workspace_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::move_collection_to_workspace(&conn, &id, &workspace_id).map_err(|e| e.to_string())
}

// ---------- tree: folders ----------

#[tauri::command]
pub fn api_create_folder(
    db: State<Db>,
    collection_id: String,
    parent_id: Option<String>,
    name: String,
) -> Result<ApiFolder, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::create_folder(&conn, &collection_id, parent_id.as_deref(), &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_update_folder(db: State<Db>, folder: ApiFolder) -> Result<(), String> {
    let _guard = api_secrets::seal_guard();
    let store = api_secrets::os_store();
    let mut folder = folder;
    let keep = api_secrets::seal_folder(&mut folder, &store);
    let before = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let before = api_secrets::row_keys(&conn, Owner::Folder, &folder.id).map_err(|e| e.to_string())?;
        api_queries::update_folder(&conn, &folder).map_err(|e| e.to_string())?;
        if keep.failed > 0 {
            api_secrets::retry_later(&conn).map_err(|e| e.to_string())?;
        }
        before
    };
    api_secrets::forget_stale(&store, &before, &keep.keys);
    Ok(())
}

#[tauri::command]
pub fn api_delete_folder(db: State<Db>, id: String) -> Result<(), String> {
    let _guard = api_secrets::seal_guard();
    let keys = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let keys = api_secrets::folder_tree_keys(&conn, &id).map_err(|e| e.to_string())?;
        api_queries::delete_folder(&conn, &id).map_err(|e| e.to_string())?;
        keys
    };
    api_secrets::forget(&api_secrets::os_store(), keys);
    Ok(())
}

// ---------- tree: requests ----------

/// Sealed under the new row's id before the row exists, and handed back unsealed — the caller put
/// the spec's credentials in and expects to find them in the row it gets.
#[tauri::command]
pub fn api_create_request(
    db: State<Db>,
    collection_id: String,
    folder_id: Option<String>,
    name: String,
    protocol: String,
    spec: String,
) -> Result<ApiRequestRow, String> {
    let _guard = api_secrets::seal_guard();
    let id = uuid::Uuid::new_v4().to_string();
    let sealed = api_secrets::seal_text(&spec, Shape::Spec, Owner::Request, &id, &api_secrets::os_store());
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if sealed.failed > 0 {
        api_secrets::retry_later(&conn).map_err(|e| e.to_string())?;
    }
    let mut row = api_queries::create_request_as(
        &conn,
        &id,
        &collection_id,
        folder_id.as_deref(),
        &name,
        &protocol,
        &sealed.text,
    )
    .map_err(|e| e.to_string())?;
    row.spec = spec;
    Ok(row)
}

/// Returns the row's `updated_at` after the write, so an open editor tab knows which version of the
/// row its copy is — unchanged when the save only changed a credential (see `update_request`).
#[tauri::command]
pub fn api_update_request(db: State<Db>, request: ApiRequestRow) -> Result<String, String> {
    let _guard = api_secrets::seal_guard();
    let store = api_secrets::os_store();
    let mut request = request;
    let keep = api_secrets::seal_request(&mut request, &store);
    let (stamp, before) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let before = api_secrets::row_keys(&conn, Owner::Request, &request.id).map_err(|e| e.to_string())?;
        let stamp = api_queries::update_request(&conn, &request).map_err(|e| e.to_string())?;
        if keep.failed > 0 {
            api_secrets::retry_later(&conn).map_err(|e| e.to_string())?;
        }
        (stamp, before)
    };
    api_secrets::forget_stale(&store, &before, &keep.keys);
    Ok(stamp)
}

#[tauri::command]
pub fn api_delete_request(db: State<Db>, id: String) -> Result<(), String> {
    let _guard = api_secrets::seal_guard();
    let keys = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let keys = api_secrets::row_keys(&conn, Owner::Request, &id).map_err(|e| e.to_string())?;
        api_queries::delete_request(&conn, &id).map_err(|e| e.to_string())?;
        keys
    };
    api_secrets::forget(&api_secrets::os_store(), keys);
    Ok(())
}

#[tauri::command]
pub fn api_duplicate_request(db: State<Db>, id: String) -> Result<ApiRequestRow, String> {
    let _guard = api_secrets::seal_guard();
    let store = api_secrets::os_store();
    let mut copy = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        api_queries::duplicate_request(&conn, &id).map_err(|e| e.to_string())?
    };
    api_secrets::copy_credentials(&copy.spec, Shape::Spec, Owner::Request, &id, &copy.id, &store);
    api_secrets::unseal_request(&mut copy, &store);
    Ok(copy)
}

/// Returns what the move stamped — see `api_queries::MoveOutcome`.
#[tauri::command]
pub fn api_move_node(
    db: State<Db>,
    kind: String,
    id: String,
    collection_id: String,
    parent_id: Option<String>,
    index: i64,
) -> Result<api_queries::MoveOutcome, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::move_node(&conn, &kind, &id, &collection_id, parent_id.as_deref(), index)
}

#[tauri::command]
pub fn api_reorder_collections(db: State<Db>, workspace_id: String, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::reorder_collections(&conn, &workspace_id, &ids).map_err(|e| e.to_string())
}

// ---------- environments ----------

#[tauri::command(async)]
pub fn api_list_environments(db: State<Db>, workspace_id: String) -> Result<Vec<ApiEnvironment>, String> {
    let mut environments = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        api_queries::list_environments(&conn, &workspace_id).map_err(|e| e.to_string())?
    };
    let store = api_secrets::os_store();
    for environment in &mut environments {
        api_secrets::unseal_environment(environment, &store);
    }
    Ok(environments)
}

#[tauri::command]
pub fn api_create_environment(db: State<Db>, workspace_id: String, name: String) -> Result<ApiEnvironment, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::create_environment(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_update_environment(db: State<Db>, environment: ApiEnvironment) -> Result<(), String> {
    let _guard = api_secrets::seal_guard();
    let store = api_secrets::os_store();
    let mut environment = environment;
    let keep = api_secrets::seal_environment(&mut environment, &store);
    let before = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let before =
            api_secrets::row_keys(&conn, Owner::Environment, &environment.id).map_err(|e| e.to_string())?;
        api_queries::update_environment(&conn, &environment).map_err(|e| e.to_string())?;
        if keep.failed > 0 {
            api_secrets::retry_later(&conn).map_err(|e| e.to_string())?;
        }
        before
    };
    api_secrets::forget_stale(&store, &before, &keep.keys);
    Ok(())
}

#[tauri::command]
pub fn api_delete_environment(db: State<Db>, id: String) -> Result<(), String> {
    let _guard = api_secrets::seal_guard();
    let keys = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // Globals is never deleted (see `delete_environment`), so its credentials must not be either.
        let deletable: bool = conn
            .query_row("SELECT is_global = 0 FROM api_environments WHERE id = ?1", [&id], |row| row.get(0))
            .unwrap_or(false);
        let keys = if deletable {
            api_secrets::row_keys(&conn, Owner::Environment, &id).map_err(|e| e.to_string())?
        } else {
            Default::default()
        };
        api_queries::delete_environment(&conn, &id).map_err(|e| e.to_string())?;
        keys
    };
    api_secrets::forget(&api_secrets::os_store(), keys);
    Ok(())
}

#[tauri::command]
pub fn api_duplicate_environment(db: State<Db>, id: String) -> Result<ApiEnvironment, String> {
    let _guard = api_secrets::seal_guard();
    let store = api_secrets::os_store();
    let mut copy = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        api_queries::duplicate_environment(&conn, &id).map_err(|e| e.to_string())?
    };
    api_secrets::copy_credentials(&copy.variables, Shape::Variables, Owner::Environment, &id, &copy.id, &store);
    api_secrets::unseal_environment(&mut copy, &store);
    Ok(copy)
}

// ---------- history ----------

#[tauri::command]
pub fn api_list_history(db: State<Db>, workspace_id: String, limit: i64) -> Result<Vec<ApiHistoryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::list_history(&conn, &workspace_id, limit).map_err(|e| e.to_string())
}

/// The history list without the `snapshot` blob — see `api_queries::list_history_meta`.
///
/// The list only ever draws the method, URL, status and duration, but every row used to carry the
/// full request-and-response JSON of that send, so opening the API workspace parsed several MB on
/// the UI thread to render a sidebar. `snapshot` comes back as `""`, meaning "not loaded"; the one
/// entry the user clicks fetches the real thing through `api_get_history_snapshot`.
#[tauri::command(async)]
pub fn api_list_history_meta(
    db: State<Db>,
    workspace_id: String,
    limit: i64,
) -> Result<Vec<ApiHistoryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::list_history_meta(&conn, &workspace_id, limit).map_err(|e| e.to_string())
}

/// One entry's stored snapshot. `None` means the row is gone — deleted, or evicted by the hard cap
/// while its list row was still on screen — which is not the same answer as `Some("")`.
#[tauri::command(async)]
pub fn api_get_history_snapshot(db: State<Db>, id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::get_history_snapshot(&conn, &id).map_err(|e| e.to_string())
}

/// The auth blocks and variable lists in scope for a send, as the frontend holds them — where the
/// credentials [`api_add_history`] scrubs out of the entry come from.
#[derive(Debug, Default, serde::Deserialize)]
pub struct HistorySecrets {
    #[serde(default)]
    pub auths: Vec<String>,
    #[serde(default)]
    pub variables: Vec<String>,
}

/// Stores one send **without its credentials** and returns the entry as stored.
///
/// History is a record of what was sent, which used to include every `Authorization` header and
/// every token a query string carried, in plain text, for the lifetime of the row. The sensitive
/// headers keep their names with `•••` for a value, and every credential in scope is scrubbed
/// wherever it appears — see `api_secrets::redact_history`.
#[tauri::command]
pub fn api_add_history(
    db: State<Db>,
    entry: ApiHistoryEntry,
    secrets: Option<HistorySecrets>,
) -> Result<ApiHistoryEntry, String> {
    let secrets = secrets.unwrap_or_default();
    let values = api_secrets::secret_values(&secrets.auths, &secrets.variables);
    let (snapshot, url) = api_secrets::redact_history(&entry.snapshot, &entry.url, &values);
    let stored = ApiHistoryEntry { snapshot, url, ..entry };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::add_history(&conn, &stored).map_err(|e| e.to_string())?;
    Ok(stored)
}

#[tauri::command]
pub fn api_delete_history(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::delete_history(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_clear_history(db: State<Db>, workspace_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::clear_history(&conn, &workspace_id).map_err(|e| e.to_string())
}

// ---------- cookies ----------
//
// Values are sealed at rest — see `db::api_cookie_seal`. Same shape as the credentials above: the
// read is `async` so a first Keychain prompt waits on a worker, the write stays on the main thread in
// order, and the credential store is only ever asked with the database lock released.

#[tauri::command(async)]
pub fn api_list_cookies(db: State<Db>, workspace_id: String) -> Result<Vec<ApiCookie>, String> {
    let needs = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        api_cookie_seal::needs(&conn, &workspace_id).map_err(|e| e.to_string())?
    };
    let store = api_secrets::os_store();
    // Minted only when there is something in the clear to seal, read only when there is something
    // sealed to open — an empty jar never touches the credential store. A key that cannot be had is
    // not an error here: plaintext rows list as they are, and sealed ones are left out.
    let key = if needs.unsealed {
        api_cookie_seal::key_or_create(&store).ok()
    } else if needs.sealed {
        api_cookie_seal::existing_key(&store).ok().flatten()
    } else {
        None
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if let (true, Some(key)) = (needs.unsealed, key.as_ref()) {
        api_cookie_seal::seal_stored(&conn, key).map_err(|e| e.to_string())?;
    }
    let jar = api_queries::list_cookies(&conn, &workspace_id).map_err(|e| e.to_string())?;
    drop(conn);
    Ok(api_cookie_seal::open_jar(jar, key.as_ref()))
}

#[tauri::command]
pub fn api_upsert_cookie(db: State<Db>, mut cookie: ApiCookie) -> Result<(), String> {
    // An empty value is not sealed and needs no key; anything else asks the store before the lock.
    let key = if cookie.value.is_empty() {
        None
    } else {
        api_cookie_seal::key_or_create(&api_secrets::os_store()).ok()
    };
    api_cookie_seal::seal_cookie(&mut cookie, key.as_ref());
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::upsert_cookie(&conn, &cookie).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_delete_cookie(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::delete_cookie(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_clear_cookies(db: State<Db>, workspace_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::clear_cookies(&conn, &workspace_id).map_err(|e| e.to_string())
}

// ---------- import ----------

/// Creates a whole imported tree — collections, folders, requests and environments — inside one
/// transaction, so a failure part way leaves nothing half-created. See `db::api_import`.
///
/// An import brings credentials in the clear — a Postman export carries its tokens — so everything
/// it created is sealed straight after, and its variables get the same initial/current split a
/// migrated database got (importers fill both values; see `api_sync::split_current_values`).
#[tauri::command]
pub fn api_import_tree(
    db: State<Db>,
    workspace_id: String,
    payload: api_import::ImportPayload,
) -> Result<api_import::ImportOutcome, String> {
    let (outcome, rows) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let outcome = api_import::import_tree(&conn, &workspace_id, &payload)?;
        api_sync::split_variables_of(&conn, "api_collections", &outcome.collection_ids).map_err(|e| e.to_string())?;
        api_sync::split_variables_of(&conn, "api_environments", &outcome.environment_ids)
            .map_err(|e| e.to_string())?;
        let mut rows: Vec<(Owner, String)> = Vec::new();
        for collection_id in &outcome.collection_ids {
            rows.push((Owner::Collection, collection_id.clone()));
            for (table, owner) in [("api_folders", Owner::Folder), ("api_requests", Owner::Request)] {
                let mut stmt = conn
                    .prepare(&format!("SELECT id FROM {table} WHERE collection_id = ?1"))
                    .map_err(|e| e.to_string())?;
                let ids = stmt
                    .query_map([collection_id], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|e| e.to_string())?;
                rows.extend(ids.into_iter().map(|id| (owner, id)));
            }
        }
        rows.extend(outcome.environment_ids.iter().map(|id| (Owner::Environment, id.clone())));
        (outcome, rows)
    };
    seal_rows_quietly(&db, rows);
    Ok(outcome)
}

// ---------- script trust ----------

/// The trust rows that exist for these script hashes. See `db::api_trust` for what a row means.
#[tauri::command]
pub fn api_script_trust_lookup(db: State<Db>, hashes: Vec<String>) -> Result<Vec<api_trust::ScriptTrust>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_trust::lookup(&conn, &hashes).map_err(|e| e.to_string())
}

/// Records verdicts. Trust only ratchets up: nothing sent here can demote a trusted script.
#[tauri::command]
pub fn api_script_trust_record(db: State<Db>, entries: Vec<api_trust::ScriptTrust>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_trust::record(&conn, &entries).map_err(|e| e.to_string())
}

// ---------- HTTP / GraphQL ----------

#[tauri::command]
pub async fn api_send_http(request: HttpSendRequest) -> Result<HttpResponse, String> {
    crate::api::http::send(request, None, None).await
}

/// Same send, reachable by `api_cancel_http(id)` while it is in flight — and watched: an event
/// stream (or any body the request asked to stream) is emitted on `api:http-stream` under `id` as
/// it arrives.
#[tauri::command]
pub async fn api_send_http_tracked(
    app: AppHandle,
    registry: State<'_, ApiRegistry>,
    id: String,
    request: HttpSendRequest,
) -> Result<HttpResponse, String> {
    use tauri::Emitter;
    let cancel = registry.register_cancel(id.clone());
    let sink: crate::api::stream::StreamSink = {
        let id = id.clone();
        std::sync::Arc::new(move |event| {
            let message = crate::api::stream::HttpStreamMessage { id: id.clone(), event };
            let _ = app.emit(crate::api::stream::EVENT_HTTP_STREAM, message);
        })
    };
    let result = crate::api::http::send(request, Some(cancel), Some(sink)).await;
    // Cleared on both paths: ids are recycled per tab, and a token left behind would make the
    // *next* send under that id cancel itself the moment anything fired the stale entry.
    registry.clear_cancel(&id);
    result
}

#[tauri::command]
pub fn api_cancel_http(registry: State<ApiRegistry>, id: String) -> Result<(), String> {
    if let Some(tx) = registry.take_cancel(&id) {
        // The receiver is gone if the send finished a moment ago — that's a race, not a failure.
        let _ = tx.send(());
    }
    Ok(())
}

// ---------- OAuth 2.0 redirect grants ----------

/// The browser leg of the authorization-code (± PKCE) and implicit grants: binds the redirect URI
/// the provider has on file, opens `authorize_url` in the system browser, and returns the parameters
/// the redirect carried once its `state` has been checked. The frontend built the URL and redeems
/// the code itself — see `oauth::capture_redirect`.
///
/// `id` registers the wait under the same cancellation token a send uses, so `api_cancel_http(id)`
/// abandons a sign-in the user walked away from.
#[tauri::command]
pub async fn api_oauth_authorize(
    app: AppHandle,
    registry: State<'_, ApiRegistry>,
    id: String,
    authorize_url: String,
    redirect_uri: String,
    state: String,
    implicit: bool,
) -> Result<Vec<(String, String)>, String> {
    use tauri_plugin_opener::OpenerExt;

    // The URL comes from a collection, and a collection may be somebody else's: only a web page may
    // reach the system opener, never `file:`, `smb:` or an app's own scheme.
    let target = url::Url::parse(authorize_url.trim())
        .map_err(|e| format!("'{authorize_url}' is not a valid authorization URL: {e}"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err(format!("the authorization URL must be http or https, not '{}'", target.scheme()));
    }
    if state.trim().is_empty() {
        return Err("a sign-in needs a state value to check the redirect against".to_string());
    }
    let redirect = crate::oauth::loopback_redirect(&redirect_uri)?;
    let mode = if implicit {
        crate::oauth::RedirectMode::Token
    } else {
        crate::oauth::RedirectMode::Code
    };

    let mut cancel = registry.register_cancel(id.clone());
    let flow = crate::oauth::capture_redirect(&redirect, &state, mode, || {
        app.opener()
            .open_url(target.as_str(), None::<&str>)
            .map_err(|e| format!("could not open the browser: {e}"))
    });
    tokio::pin!(flow);
    let result = tokio::select! {
        result = &mut flow => result,
        signalled = &mut cancel => match signalled {
            Ok(()) => Err("Sign-in cancelled".to_string()),
            // The sender went away without firing: nothing can cancel us now, so keep waiting.
            Err(_) => flow.await,
        },
    };
    registry.clear_cancel(&id);
    result
}

// ---------- WebSocket / Socket.IO ----------

#[tauri::command]
pub async fn api_ws_connect(app: AppHandle, id: String, request: WsConnectRequest) -> Result<(), String> {
    crate::api::ws::connect(app, id, request).await
}

#[tauri::command]
pub fn api_ws_send(
    registry: State<ApiRegistry>,
    id: String,
    payload: String,
    binary: bool,
) -> Result<(), String> {
    crate::api::ws::send(registry.inner(), &id, payload, binary)
}

#[tauri::command]
pub async fn api_socketio_connect(
    app: AppHandle,
    id: String,
    request: SocketIoConnectRequest,
) -> Result<(), String> {
    crate::api::socketio::connect(app, id, request).await
}

#[tauri::command]
pub fn api_socketio_emit(
    registry: State<ApiRegistry>,
    id: String,
    event: String,
    payload_json: String,
) -> Result<(), String> {
    crate::api::socketio::emit(registry.inner(), &id, &event, &payload_json)
}

// ---------- MQTT ----------

#[tauri::command]
pub async fn api_mqtt_connect(app: AppHandle, id: String, request: MqttConnectRequest) -> Result<(), String> {
    crate::api::mqtt::connect(app, id, request).await
}

#[tauri::command]
pub fn api_mqtt_publish(
    registry: State<ApiRegistry>,
    id: String,
    topic: String,
    payload: String,
    qos: u8,
    retain: bool,
) -> Result<(), String> {
    crate::api::mqtt::publish(registry.inner(), &id, &topic, &payload, qos, retain)
}

#[tauri::command]
pub fn api_mqtt_subscribe(registry: State<ApiRegistry>, id: String, topic: String, qos: u8) -> Result<(), String> {
    crate::api::mqtt::subscribe(registry.inner(), &id, &topic, qos)
}

#[tauri::command]
pub fn api_mqtt_unsubscribe(registry: State<ApiRegistry>, id: String, topic: String) -> Result<(), String> {
    crate::api::mqtt::unsubscribe(registry.inner(), &id, &topic)
}

// ---------- shared: closing any live connection ----------

#[tauri::command]
pub fn api_stream_disconnect(registry: State<ApiRegistry>, id: String) -> Result<(), String> {
    registry.close(&id);
    Ok(())
}

// ---------- gRPC ----------

#[tauri::command]
pub async fn api_grpc_describe(request: GrpcDescribeRequest) -> Result<Vec<GrpcServiceInfo>, String> {
    crate::api::grpc::describe(request).await
}

#[tauri::command]
pub async fn api_grpc_call(
    registry: State<'_, ApiRegistry>,
    id: String,
    request: GrpcCallRequest,
) -> Result<GrpcResponse, String> {
    let cancel = registry.register_cancel(id.clone());
    // `grpc::call` has no cancel channel of its own, so dropping the future is what actually
    // aborts the RPC — the select has to own it for `api_cancel_http` to have any effect here.
    let result = tokio::select! {
        response = crate::api::grpc::call(request) => response,
        _ = cancel => Err("Call cancelled".to_string()),
    };
    registry.clear_cancel(&id);
    result
}

// ---------- files ----------

/// What `api_read_file_base64` hands back: the bytes, a MIME guess for the `Content-Type` the UI
/// pre-fills, and the size so the builder can warn before a huge body enters the webview heap.
#[derive(Serialize)]
pub struct FileBase64 {
    pub base64: String,
    pub mime: String,
    pub size: u64,
}

/// Extension-based only. A real content sniff would be more accurate, but this value is a
/// *suggestion* the user can overwrite in the headers tab, and guessing from bytes would
/// disagree with the extension exactly when the user picked the extension deliberately.
fn guess_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "json" => "application/json",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "txt" | "log" | "md" => "text/plain",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub fn api_read_file_base64(path: String) -> Result<FileBase64, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(FileBase64 {
        size: bytes.len() as u64,
        mime: guess_mime(&path).to_string(),
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// Native "open file" dialog. Async and callback-driven for the same reason as
/// `repos::pick_folder` — a blocking picker deadlocks against the main thread on macOS.
#[tauri::command]
pub async fn api_pick_file(app: AppHandle, extensions: Vec<String>) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if !extensions.is_empty() {
        let allowed: Vec<&str> = extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(extensions.join(", "), &allowed);
    }
    builder.pick_file(move |file| {
        let _ = tx.send(file.map(|p| p.to_string()));
    });
    rx.await.ok().flatten()
}

/// Returns `None` when the user dismissed the dialog; the file is written only on a real pick.
#[tauri::command]
pub async fn api_save_file(app: AppHandle, default_name: String, contents: String) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(default_name.as_str())
        .save_file(move |file| {
            let _ = tx.send(file.map(|p| p.to_string()));
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))?;
    Ok(Some(path))
}

/// The binary twin of `api_save_file`, for the exports that aren't text — a rasterised diagram, an
/// image pulled out of a response.
///
/// The bytes arrive as Base64 because the bridge carries a Rust `String` and nothing else; writing
/// that string straight out would leave a file named `.png` that no viewer can open. Decoded before
/// the dialog opens, so a malformed payload fails without first making the user pick a destination.
#[tauri::command]
pub async fn api_save_binary_file(app: AppHandle, default_name: String, base64: String) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("not valid Base64: {e}"))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(default_name.as_str())
        .save_file(move |file| {
            let _ = tx.send(file.map(|p| p.to_string()));
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    std::fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))?;
    Ok(Some(path))
}

#[tauri::command]
pub fn api_read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{path} is not valid UTF-8 text"))
}

/// One file of a collection kept as a folder on disk (Bruno's layout).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CollectionFile {
    /// Relative to the folder, `/`-separated whatever the platform.
    pub path: String,
    pub text: String,
}

/// Bounds on what one folder import reads — a Bruno collection is small text; hitting these means
/// the folder picked was not one.
const COLLECTION_DIR_MAX_FILES: usize = 5000;
const COLLECTION_DIR_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const COLLECTION_DIR_MAX_DEPTH: usize = 32;

/// Reads a Bruno collection folder: every `.bru` file and `bruno.json`, recursively. `None` when
/// `path` is not a directory, so a dropped file falls back to being read as one.
///
/// Hidden folders and `node_modules` are skipped — a collection kept in a repo sits beside both.
#[tauri::command]
pub fn api_read_collection_dir(path: String) -> Result<Option<Vec<CollectionFile>>, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Ok(None);
    }
    let mut files = Vec::new();
    read_collection_dir(root, root, 0, &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Some(files))
}

fn read_collection_dir(
    root: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    out: &mut Vec<CollectionFile>,
) -> Result<(), String> {
    if depth > COLLECTION_DIR_MAX_DEPTH {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // `symlink_metadata`, not `metadata`: a link is not followed out of the folder picked.
        let meta = entry.path().symlink_metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            read_collection_dir(root, &entry.path(), depth + 1, out)?;
            continue;
        }
        if !meta.is_file() || !(name.ends_with(".bru") || name == "bruno.json") {
            continue;
        }
        if out.len() >= COLLECTION_DIR_MAX_FILES {
            return Err(format!("more than {COLLECTION_DIR_MAX_FILES} collection files — is this the right folder?"));
        }
        if meta.len() > COLLECTION_DIR_MAX_FILE_BYTES {
            continue;
        }
        let bytes = std::fs::read(entry.path()).map_err(|e| format!("{}: {e}", entry.path().display()))?;
        let Ok(text) = String::from_utf8(bytes) else { continue };
        let relative = entry
            .path()
            .strip_prefix(root)
            .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
            .unwrap_or(name);
        out.push(CollectionFile { path: relative, text });
    }
    Ok(())
}

#[cfg(test)]
mod collection_dir_tests {
    use super::*;

    #[test]
    fn a_bruno_folder_is_read_recursively_and_nothing_else_is() {
        let root = std::env::temp_dir().join(format!("cf-bruno-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("orders/nested")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("bruno.json"), r#"{"name":"Orders"}"#).unwrap();
        std::fs::write(root.join("orders/List.bru"), "meta {\n  name: List\n}\n").unwrap();
        std::fs::write(root.join("orders/nested/Get.bru"), "meta {\n  name: Get\n}\n").unwrap();
        std::fs::write(root.join("orders/notes.md"), "ignored").unwrap();
        std::fs::write(root.join("node_modules/pkg/x.bru"), "ignored").unwrap();
        std::fs::write(root.join(".git/config.bru"), "ignored").unwrap();

        let files = api_read_collection_dir(root.to_string_lossy().into_owned()).unwrap().unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["bruno.json", "orders/List.bru", "orders/nested/Get.bru"]);

        // A file is not a folder: the caller reads it as a file instead.
        assert_eq!(api_read_collection_dir(root.join("bruno.json").to_string_lossy().into_owned()).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}

// ---------- Google Drive as a backup destination ----------
//
// Only the connection lives here. Finding, uploading and downloading the backup itself are
// driven from `backup_cmd`, which never sends the bytes across the bridge.

/// Whether the pieces of the Drive connection are in place. Two flags rather than one because the
/// UI has to say *which* step is missing: credentials not entered, or consent not granted.
#[derive(Serialize)]
pub struct DriveStatus {
    pub has_secret: bool,
    pub connected: bool,
}

#[tauri::command]
pub fn gdrive_status() -> Result<DriveStatus, String> {
    Ok(DriveStatus {
        has_secret: gdrive::has_client_secret()?,
        connected: gdrive::is_connected()?,
    })
}

#[tauri::command]
pub fn gdrive_set_client_secret(secret: String) -> Result<(), String> {
    gdrive::set_client_secret(&secret)
}

/// Opens the browser for consent and stores the refresh token. Returns the account that granted it.
#[tauri::command]
pub async fn gdrive_connect(client_id: String) -> Result<gdrive::DriveAccount, String> {
    gdrive::connect(client_id).await
}

#[tauri::command]
pub fn gdrive_disconnect() -> Result<(), String> {
    gdrive::disconnect()
}

// ---------- shared collections on the user's own Supabase project ----------

/// The SQL the host runs once in their project's editor. Served from the backend so the "copy"
/// button and the schema the code expects can never be two different things.
///
/// Asked about one project (`url`), it also records this machine as the owner of every collection
/// — and every flow, which Flujos shares through the same tables — it already shares there; see
/// `supabase::install_sql_for` for why that belongs in the script. One script for both apps: the
/// API client's and Flujos' Collaboration panes each copy it for their own projects.
#[tauri::command]
pub fn supabase_install_sql(db: State<Db>, url: Option<String>) -> Result<String, String> {
    let Some(url) = url.filter(|url| !url.trim().is_empty()) else {
        return Ok(supabase::INSTALL_SQL.to_string());
    };
    let owned: Vec<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let collections = api_queries::list_shared_collections(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|share| share.role == "owner" && supabase::same_project(&share.project_url, &url))
            .map(|share| share.collection_id);
        let flows = crate::db::flow_share_queries::list(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|share| share.role == "owner" && supabase::same_project(&share.project_url, &url))
            .map(|share| share.flow_id);
        collections.chain(flows).collect()
    };
    supabase::install_sql_for(&owned)
}

/// Stores the anon key **for one project**. A user can be on several.
#[tauri::command]
pub fn supabase_set_anon_key(url: String, anon_key: String) -> Result<(), String> {
    supabase::set_credentials(&url, &anon_key)
}

#[tauri::command]
pub fn supabase_has_key(url: String) -> Result<bool, String> {
    supabase::has_credentials(&url)
}

/// The stored anon key for one project. Public by design — see `supabase::public_anon_key`.
#[tauri::command]
pub fn supabase_anon_key(url: String) -> Result<Option<String>, String> {
    supabase::public_anon_key(&url)
}

/// Adopts a project for every share that predates per-share projects.
#[tauri::command]
pub fn api_backfill_share_projects(db: State<Db>, url: String) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::backfill_share_projects(&conn, &url).map_err(|e| e.to_string())
}

/// The invitation token for one shared collection — what the host hands out, so the UI has to be
/// able to read it back to build the invitation code.
#[tauri::command]
pub fn supabase_share_token(collection_id: String) -> Result<Option<String>, String> {
    supabase::share_token(&collection_id)
}

/// Is the project reachable, and has the schema been installed — and which version of it. About the
/// *project*, not about any one share — see `supabase_probe` for that.
///
/// On a project whose script knows about owners, this is also where the host's app records itself
/// as the owner of every share it hosts there. A project upgraded from an earlier script holds shares
/// with no owner yet, and the first claim wins; the connection test is what the host runs right
/// after re-running the script (the script says so), which makes it the earliest safe moment.
#[tauri::command]
pub async fn supabase_check(db: State<'_, Db>, url: String) -> Result<supabase::ConnectionCheck, String> {
    let check = supabase::check(url.clone()).await?;
    if check.schema_installed && !check.schema_outdated {
        let owned: Vec<String> = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            api_queries::list_shared_collections(&conn)
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|share| share.role == "owner" && supabase::same_project(&share.project_url, &url))
                .map(|share| share.collection_id)
                .collect()
        };
        for collection_id in owned {
            let _ = supabase::claim_owner(url.clone(), collection_id).await;
        }
    }
    Ok(check)
}

/// The name the remote has for this collection's share, or `None` if the token no longer resolves —
/// which is what a rotated or revoked invitation looks like from a member's machine.
#[tauri::command]
pub async fn supabase_probe(url: String, collection_id: String) -> Result<Option<String>, String> {
    supabase::probe(url, collection_id).await
}

/// Every collection shared on this machine, across every workspace.
#[tauri::command]
pub fn api_shared_collections(db: State<Db>) -> Result<Vec<api_queries::SharedCollectionRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::list_shared_collections(&conn).map_err(|e| e.to_string())
}

/// Starts sharing one collection and returns the invitation material.
#[tauri::command]
pub async fn supabase_share(
    db: State<'_, Db>,
    url: String,
    collection_id: String,
    workspace_id: String,
    name: String,
) -> Result<supabase::SharedCollection, String> {
    let shared = supabase::share(url.clone(), collection_id.clone(), name.clone()).await?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::upsert_shared_collection(&conn, &collection_id, &workspace_id, &url, &name, "owner")
        .map_err(|e| e.to_string())?;
    Ok(shared)
}

/// Keeps the remote's display name in step with a local rename. Host only.
#[tauri::command]
pub async fn supabase_rename_share(
    db: State<'_, Db>,
    url: String,
    collection_id: String,
    name: String,
) -> Result<(), String> {
    require_owner(&db, &collection_id)?;
    supabase::rename(url, collection_id.clone(), name.clone()).await?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::rename_shared_collection(&conn, &collection_id, &name).map_err(|e| e.to_string())
}

/// Refuses anything that reaches into the *host's* half of a share.
///
/// A member holds a token that row-level security cannot tell apart from the host's — it is the
/// same credential, and the project has no idea which of the two people holding it is which. So the
/// distinction has to be kept here, against the role recorded when the share was created or
/// accepted. Without it, rotating the code is something any member can do, and doing it locks the
/// host and every other member out of their own collection.
fn require_owner(db: &State<'_, Db>, collection_id: &str) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let share = api_queries::shared_collection(&conn, collection_id)
        .map_err(|e| e.to_string())?
        .ok_or("this collection is not shared")?;
    if share.role != "owner" {
        return Err("only the host of a shared collection can do that".to_string());
    }
    Ok(())
}

/// Accepts an invitation: resolves the token, files the share under the workspace the user picked,
/// and leaves the first pull to the caller's normal sync.
#[tauri::command]
pub async fn supabase_join(
    db: State<'_, Db>,
    url: String,
    token: String,
    workspace_id: String,
) -> Result<supabase::SharedCollection, String> {
    let shared = supabase::join(url.clone(), token).await?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::upsert_shared_collection(
        &conn,
        &shared.id,
        &workspace_id,
        &url,
        &shared.name,
        "member",
    )
    .map_err(|e| e.to_string())?;
    Ok(shared)
}

/// Host only: rotating is how access is taken back, so a member doing it would be locking out the
/// person whose project this is.
#[tauri::command]
pub async fn supabase_rotate(
    db: State<'_, Db>,
    url: String,
    collection_id: String,
) -> Result<String, String> {
    require_owner(&db, &collection_id)?;
    supabase::rotate(url, collection_id).await
}

/// Stops syncing this collection here. The local copy stays; the remote one is the host's to end,
/// by rotating the code.
#[tauri::command]
pub fn supabase_leave(db: State<Db>, collection_id: String) -> Result<(), String> {
    supabase::leave(&collection_id)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::forget_shared_collection(&conn, &collection_id).map_err(|e| e.to_string())
}

/// The newest change the server holds for this share, as its own clock saw it.
///
/// One indexed row and no payload — cheap enough to ask every few seconds, which is what stands in
/// for a realtime socket here. The caller pulls only when this is ahead of the cursor.
#[tauri::command]
pub async fn supabase_watermark(
    db: State<'_, Db>,
    url: String,
    collection_id: String,
) -> Result<String, String> {
    // The probe is also the health check. A revoked invitation code fails here and nowhere else —
    // there is nothing left to sync, so `supabase_sync` never runs to record why — and a share that
    // quietly stopped working while still claiming "synced 5 minutes ago" is the one failure mode
    // this feature cannot afford.
    match supabase::watermark(url, collection_id.clone()).await {
        Ok(mark) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            api_queries::set_sync_progress(&conn, &collection_id, None, Some(&mark), false, Some(""))
                .map_err(|e| e.to_string())?;
            Ok(mark)
        }
        Err(e) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            api_queries::set_sync_progress(&conn, &collection_id, None, None, false, Some(&e))
                .map_err(|e| e.to_string())?;
            Err(e)
        }
    }
}

/// One full round for one shared collection: send what changed here, then take what changed
/// elsewhere.
///
/// Push first on purpose. The reverse order would let a teammate's older copy of a record land over
/// an edit made here that hasn't been sent yet, and — worse — that edit would then look like a
/// remote change on the next round and freeze a record nobody is actually fighting over.
///
/// Kept in one command rather than orchestrated from the frontend because the bookkeeping between
/// the two halves is not optional: the base has to move the instant the push is acknowledged, and a
/// window where it hasn't is a window where every pushed record conflicts with its own echo.
#[tauri::command]
pub async fn supabase_sync(
    db: State<'_, Db>,
    url: String,
    collection_id: String,
) -> Result<api_sync::SyncResult, String> {
    let (outbound, workspace_id, since) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let share = api_queries::shared_collection(&conn, &collection_id)
            .map_err(|e| e.to_string())?
            .ok_or("this collection is not shared")?;
        let items = api_sync::local_items(&conn, &collection_id).map_err(|e| e.to_string())?;
        (items, share.workspace_id, share.cursor)
    };

    if let Err(e) = supabase::push(url.clone(), collection_id.clone(), outbound.clone()).await {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        api_queries::set_sync_progress(&conn, &collection_id, None, None, false, Some(&e))
            .map_err(|e| e.to_string())?;
        return Err(e);
    }

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        api_sync::record_base(&conn, &collection_id, &outbound).map_err(|e| e.to_string())?;
        api_sync::clear_delivered_tombstones(&conn, &collection_id, &outbound)
            .map_err(|e| e.to_string())?;
    }

    let incoming = match supabase::pull(url, collection_id.clone(), since).await {
        Ok(items) => items,
        Err(e) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            api_queries::set_sync_progress(&conn, &collection_id, None, None, false, Some(&e))
                .map_err(|e| e.to_string())?;
            return Err(e);
        }
    };

    let result = {
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        // Left while this round was on the wire — a guest's delete forgets the share and removes the
        // collection here. Applying the pull now would put the collection straight back, as an
        // ordinary local one nobody asked for.
        if api_queries::shared_collection(&conn, &collection_id).map_err(|e| e.to_string())?.is_none() {
            return Ok(api_sync::SyncResult::default());
        }
        let result = api_sync::apply_items(&mut conn, &collection_id, &workspace_id, incoming)
            .map_err(|e| e.to_string())?;
        // An empty cursor means the pull returned nothing; keeping the old one is what stops a quiet
        // round from replaying the whole history next time.
        let cursor = (!result.cursor.is_empty()).then_some(result.cursor.as_str());
        api_queries::set_sync_progress(&conn, &collection_id, cursor, cursor, true, Some(""))
            .map_err(|e| e.to_string())?;

        // The collection is gone and the round that would have carried that fact has just finished:
        // either we deleted it and the tombstone is now everyone's, or someone else did and we just
        // applied theirs. Either way there is nothing left to sync, and a share row pointing at
        // nothing would keep probing a collection that no longer exists on any machine.
        if api_queries::load_collection(&conn, &collection_id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            supabase::leave(&collection_id)?;
            api_queries::forget_shared_collection(&conn, &collection_id).map_err(|e| e.to_string())?;
        }
        result
    };
    // A credential that arrived in the clear — an older peer still pushes an MQTT password — goes
    // into the store like any other, now that the lock is released.
    seal_rows_quietly(
        &db,
        result.touched.iter().filter_map(|(kind, id)| owner_of(kind).map(|owner| (owner, id.clone()))),
    );
    Ok(result)
}

/// Everything frozen in this workspace, waiting for someone to pick a side.
#[tauri::command]
pub fn api_sync_conflicts(
    db: State<Db>,
    workspace_id: String,
) -> Result<Vec<api_sync::SyncConflict>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_sync::list_conflicts(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Settles one frozen record. `keep` is `"mine"` or `"theirs"`.
#[tauri::command]
pub fn api_resolve_conflict(
    db: State<Db>,
    collection_id: String,
    kind: String,
    id: String,
    keep: api_sync::Resolution,
) -> Result<(), String> {
    {
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        api_sync::resolve(&mut conn, &collection_id, &kind, &id, keep).map_err(|e| e.to_string())?;
    }
    if let Some(owner) = owner_of(&kind) {
        seal_rows_quietly(&db, [(owner, id)]);
    }
    Ok(())
}

// ---------- API client credentials in the OS credential store ----------

/// Moves whatever the API client still stores in the clear into the OS credential store, and takes
/// credentials out of the history written before this existed. Run in the background every time the
/// API workspace loads; after one clean run it returns at once. See `api_secrets::seal_stored`.
#[tauri::command(async)]
pub fn api_seal_stored_secrets(db: State<Db>) -> Result<api_secrets::SealReport, String> {
    api_secrets::seal_stored(&db, &api_secrets::os_store())
}

/// `api_open_tabs:<workspace>`, with the credentials of every open draft put back.
#[tauri::command(async)]
pub fn api_load_open_tabs(db: State<Db>, workspace_id: String) -> Result<Option<String>, String> {
    api_secrets::load_open_tabs(&db, &workspace_id, &api_secrets::os_store())
}

/// Persists the open tabs with every draft's credentials moved into the store. A tab holds the same
/// token its request does, and an unsaved one may hold a token nothing else does.
#[tauri::command]
pub fn api_save_open_tabs(db: State<Db>, workspace_id: String, value: String) -> Result<(), String> {
    api_secrets::save_open_tabs(&db, &workspace_id, &value, &api_secrets::os_store())
}

/// `api_settings`, with every client certificate's passphrase put back.
#[tauri::command(async)]
pub fn api_load_settings(db: State<Db>) -> Result<Option<String>, String> {
    api_secrets::load_settings(&db, &api_secrets::os_store())
}

/// Same shape as `commands::settings::SettingChanged`, which the listening half in
/// `lib/settingsSync.ts` reads.
#[derive(Clone, Serialize)]
struct SettingChanged<'a> {
    key: &'a str,
    origin: &'a str,
}

/// Writes `api_settings` with the certificate passphrases moved into the store, then announces the
/// write exactly as `set_setting` does — every window holding the API client re-reads it.
#[tauri::command]
pub fn api_save_settings(webview: tauri::Webview, db: State<Db>, value: String) -> Result<(), String> {
    api_secrets::save_settings(&db, &value, &api_secrets::os_store())?;
    let _ = webview.emit("settings:changed", SettingChanged { key: "api_settings", origin: webview.label() });
    Ok(())
}
