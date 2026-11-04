//! The windows' side of `crate::chat_refs`: artifact lists and versions, the chats a composer can
//! cite, and the two answers a window gives to a `chat:delegate` request.

use tauri::State;

use crate::chat_refs::{artifacts, delegate, refs};
use crate::db::Db;

#[tauri::command]
pub fn chat_artifacts_list(db: State<'_, Db>, workspace_id: String, conversation_id: Option<String>) -> Result<Vec<artifacts::ArtifactSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    artifacts::list(&conn, &workspace_id, conversation_id.as_deref().filter(|c| !c.is_empty())).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_artifact_versions(db: State<'_, Db>, workspace_id: String, name: String) -> Result<Vec<artifacts::Artifact>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    artifacts::versions(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_artifact_delete(db: State<'_, Db>, workspace_id: String, name: String) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    artifacts::delete(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

/// The chats of a workspace, for the composers' `@chat:` menu.
#[tauri::command]
pub fn chat_refs_list(db: State<'_, Db>, workspace_id: String) -> Result<Vec<refs::ChatRef>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    refs::list_chats(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// A window takes a delegated turn. `false`: another window already did, or the request is gone.
#[tauri::command]
pub fn chat_delegate_accept(request_id: String) -> bool {
    delegate::accept(&request_id)
}

/// The delegated turn ended — its answer, or why it did not.
#[tauri::command]
pub fn chat_delegate_settle(request_id: String, reply: Option<String>, error: Option<String>) -> bool {
    let result = match (reply, error) {
        (_, Some(error)) if !error.trim().is_empty() => Err(error),
        (Some(reply), _) => Ok(reply),
        _ => Err("el chat no respondió".to_string()),
    };
    delegate::settle(&request_id, result)
}
