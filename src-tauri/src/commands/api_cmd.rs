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
use crate::db::api_backup::{self, ApiBackup, ImportOptions, ImportSummary};
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

#[tauri::command]
pub fn api_update_request(db: State<Db>, request: ApiRequestRow) -> Result<(), String> {
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

// ---------- backup ----------

/// Every workspace's collections, folders, requests and environments in one payload. The frontend
/// is what turns this into a file — encrypting it first when the user supplied a passphrase.
#[tauri::command]
pub fn api_export_all(db: State<Db>) -> Result<ApiBackup, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    api_backup::export_all(&conn).map_err(|e| e.to_string())
}

/// `replace = false` merges (newest `updated_at` wins, nothing is ever deleted); `replace = true`
/// empties the workspaces named in the backup first, for a clean restore.
#[tauri::command]
pub fn api_import_all(db: State<Db>, backup: ApiBackup, replace: bool) -> Result<ImportSummary, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    api_backup::import_all(
        &mut conn,
        &backup,
        // A backup is the same person's other machine, so a workspace they re-created by hand
        // there is theirs to merge into rather than a second copy to create.
        ImportOptions { replace, match_by_name: true },
    )
    .map_err(|e| e.to_string())
}

/// Writes a file at a path the user already chose — no dialog. Backing up on a timer can't open
/// one, and the destination is a setting by then.
#[tauri::command]
pub fn api_write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

// ---------- backup destination: the user's own Google Drive ----------

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

/// The id of a backup this OAuth client already has in Drive — how a second machine adopts the
/// first one's file instead of starting a rival copy.
#[tauri::command]
pub async fn gdrive_find_file(client_id: String, name: String) -> Result<Option<String>, String> {
    gdrive::find_file(client_id, name).await
}

#[tauri::command]
pub async fn gdrive_upload(
    client_id: String,
    file_id: Option<String>,
    name: String,
    contents: String,
) -> Result<String, String> {
    gdrive::upload(client_id, file_id, name, contents).await
}

#[tauri::command]
pub async fn gdrive_download(client_id: String, file_id: String) -> Result<String, String> {
    gdrive::download(client_id, file_id).await
}

// ---------- shared workspaces on the user's own Supabase project ----------

/// The SQL the host runs once in their project's editor. Served from the backend so the "copy"
/// button and the schema the code expects can never be two different things.
#[tauri::command]
pub fn supabase_install_sql() -> &'static str {
    supabase::INSTALL_SQL
}

#[tauri::command]
pub fn supabase_set_anon_key(anon_key: String) -> Result<(), String> {
    supabase::set_credentials(&anon_key)
}

#[tauri::command]
pub fn supabase_has_key() -> Result<bool, String> {
    supabase::has_credentials()
}

/// Whether this workspace is shared here, and under which token — the token is what the host hands
/// out, so the UI has to be able to show it.
#[tauri::command]
pub fn supabase_share_token(workspace_id: String) -> Result<Option<String>, String> {
    supabase::share_token(&workspace_id)
}

#[tauri::command]
pub async fn supabase_check(url: String, workspace_id: String) -> Result<supabase::ConnectionCheck, String> {
    supabase::check(url, workspace_id).await
}

#[tauri::command]
pub async fn supabase_share(
    url: String,
    workspace_id: String,
    name: String,
) -> Result<supabase::SharedWorkspace, String> {
    supabase::share(url, workspace_id, name).await
}

#[tauri::command]
pub async fn supabase_join(url: String, token: String) -> Result<supabase::SharedWorkspace, String> {
    supabase::join(url, token).await
}

#[tauri::command]
pub async fn supabase_rotate(url: String, workspace_id: String) -> Result<String, String> {
    supabase::rotate(url, workspace_id).await
}

#[tauri::command]
pub fn supabase_leave(workspace_id: String) -> Result<(), String> {
    supabase::leave(&workspace_id)
}

/// Sends this workspace up. Returns how many records were written.
#[tauri::command]
pub async fn supabase_push(db: State<'_, Db>, url: String, workspace_id: String) -> Result<usize, String> {
    let items = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        api_sync::local_items(&conn, &workspace_id).map_err(|e| e.to_string())?
    };
    supabase::push(url, workspace_id, items).await
}

/// Brings everyone else's changes down and applies them. `since` is the cursor from the last pull;
/// empty asks for everything.
#[tauri::command]
pub async fn supabase_pull(
    db: State<'_, Db>,
    url: String,
    workspace_id: String,
    workspace_name: String,
    since: String,
) -> Result<api_sync::SyncResult, String> {
    let items = supabase::pull(url, workspace_id.clone(), since).await?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    api_sync::apply_items(&mut conn, &workspace_id, &workspace_name, items).map_err(|e| e.to_string())
}
