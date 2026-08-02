//! IPC surface for the built-in API client.
//!
//! Two kinds of command live here and nothing else: thin wrappers over `db::api_queries`, and
//! forwarders into the `api::*` transports. **Nothing here parses a request spec, resolves a
//! `{{variable}}` or applies an auth scheme** — the frontend does all of that and hands down a
//! fully-resolved request, which is what keeps a new protocol or auth mode a frontend-only change.

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::api::{
    ApiRegistry, GrpcCallRequest, GrpcDescribeRequest, GrpcResponse, GrpcServiceInfo, HttpResponse, HttpSendRequest,
    MqttConnectRequest, SocketIoConnectRequest, WsConnectRequest,
};
use crate::db::{api_queries, api_sync, models::*, Db};
use crate::gdrive;
use crate::supabase;

// ---------- tree: collections ----------

#[tauri::command]
pub fn api_load_tree(db: State<Db>, workspace_id: String) -> Result<ApiTree, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::load_tree(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_create_collection(db: State<Db>, workspace_id: String, name: String) -> Result<ApiCollection, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::create_collection(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_update_collection(db: State<Db>, collection: ApiCollection) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::update_collection(&conn, &collection).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_delete_collection(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::delete_collection(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_duplicate_collection(db: State<Db>, id: String) -> Result<ApiCollection, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::duplicate_collection(&conn, &id).map_err(|e| e.to_string())
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
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::update_folder(&conn, &folder).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_delete_folder(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::delete_folder(&conn, &id).map_err(|e| e.to_string())
}

// ---------- tree: requests ----------

#[tauri::command]
pub fn api_create_request(
    db: State<Db>,
    collection_id: String,
    folder_id: Option<String>,
    name: String,
    protocol: String,
    spec: String,
) -> Result<ApiRequestRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::create_request(&conn, &collection_id, folder_id.as_deref(), &name, &protocol, &spec)
        .map_err(|e| e.to_string())
}

/// Returns the new `updated_at`, so an open editor tab knows which version of the row its copy is.
#[tauri::command]
pub fn api_update_request(db: State<Db>, request: ApiRequestRow) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::update_request(&conn, &request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_delete_request(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::delete_request(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_duplicate_request(db: State<Db>, id: String) -> Result<ApiRequestRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::duplicate_request(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_move_node(
    db: State<Db>,
    kind: String,
    id: String,
    collection_id: String,
    parent_id: Option<String>,
    index: i64,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::move_node(&conn, &kind, &id, &collection_id, parent_id.as_deref(), index)
}

#[tauri::command]
pub fn api_reorder_collections(db: State<Db>, workspace_id: String, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::reorder_collections(&conn, &workspace_id, &ids).map_err(|e| e.to_string())
}

// ---------- environments ----------

#[tauri::command]
pub fn api_list_environments(db: State<Db>, workspace_id: String) -> Result<Vec<ApiEnvironment>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::list_environments(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_create_environment(db: State<Db>, workspace_id: String, name: String) -> Result<ApiEnvironment, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::create_environment(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_update_environment(db: State<Db>, environment: ApiEnvironment) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::update_environment(&conn, &environment).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_delete_environment(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::delete_environment(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_duplicate_environment(db: State<Db>, id: String) -> Result<ApiEnvironment, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::duplicate_environment(&conn, &id).map_err(|e| e.to_string())
}

// ---------- history ----------

#[tauri::command]
pub fn api_list_history(db: State<Db>, workspace_id: String, limit: i64) -> Result<Vec<ApiHistoryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::list_history(&conn, &workspace_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_add_history(db: State<Db>, entry: ApiHistoryEntry) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::add_history(&conn, &entry).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn api_list_cookies(db: State<Db>, workspace_id: String) -> Result<Vec<ApiCookie>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_queries::list_cookies(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn api_upsert_cookie(db: State<Db>, cookie: ApiCookie) -> Result<(), String> {
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

// ---------- HTTP / GraphQL ----------

#[tauri::command]
pub async fn api_send_http(request: HttpSendRequest) -> Result<HttpResponse, String> {
    crate::api::http::send(request, None).await
}

/// Same send, reachable by `api_cancel_http(id)` while it is in flight.
#[tauri::command]
pub async fn api_send_http_tracked(
    registry: State<'_, ApiRegistry>,
    id: String,
    request: HttpSendRequest,
) -> Result<HttpResponse, String> {
    let cancel = registry.register_cancel(id.clone());
    let result = crate::api::http::send(request, Some(cancel)).await;
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

#[tauri::command]
pub fn api_read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{path} is not valid UTF-8 text"))
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
#[tauri::command]
pub fn supabase_install_sql() -> &'static str {
    supabase::INSTALL_SQL
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

/// Is the project reachable, and has the schema been installed. About the *project*, not about any
/// one share — see `supabase_probe` for that.
#[tauri::command]
pub async fn supabase_check(url: String) -> Result<supabase::ConnectionCheck, String> {
    supabase::check(url).await
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

    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
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
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    api_sync::resolve(&mut conn, &collection_id, &kind, &id, keep).map_err(|e| e.to_string())
}
