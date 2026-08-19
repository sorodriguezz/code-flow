//! Tauri commands for language servers. The sessions themselves live in [`crate::lsp`]; these are
//! the calls the editor's providers make.
//!
//! There is no `lsp_completion`, no `lsp_hover`, no `lsp_rename`. The pair below —
//! [`lsp_request`] and [`lsp_notify`] — is the whole surface, because the backend is transport:
//! every one of those methods is a name and a JSON blob whose shape belongs to Monaco, and the
//! conversion happens in `src/lib/lsp/protocol.ts` where the Monaco types actually exist. Adding
//! `textDocument/inlayHint` later is a frontend change and nothing else.

use serde_json::Value;
use tauri::AppHandle;

/// Launches a language server for one project and returns its `capabilities`.
///
/// `session_id` is the frontend's to choose and is expected to be `{projectId}:{serverId}`;
/// [`lsp_stop_project`] relies on that prefix. Starting an id that is already running replaces it,
/// which is what a restart is.
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    session_id: String,
    root: String,
    command: String,
    args: Vec<String>,
    initialization_options: Value,
    settings: Value,
) -> Result<Value, String> {
    crate::lsp::start(app, &session_id, &root, &command, &args, initialization_options, settings).await
}

#[tauri::command]
pub async fn lsp_stop(session_id: String) -> Result<(), String> {
    crate::lsp::stop(&session_id).await;
    Ok(())
}

/// Every server this project started — what closing the repo calls.
#[tauri::command]
pub async fn lsp_stop_project(project_id: String) -> Result<(), String> {
    crate::lsp::stop_prefix(&format!("{project_id}:")).await;
    Ok(())
}

/// A request that wants an answer: completion, hover, definition, rename, formatting.
#[tauri::command]
pub async fn lsp_request(session_id: String, method: String, params: Value) -> Result<Value, String> {
    crate::lsp::request(&session_id, &method, params).await
}

/// A notification, which by definition has no reply: the document-sync calls, and configuration.
///
/// Deliberately not `async`. `didChange` fires on every keystroke, and awaiting a round trip to
/// the backend for a message with nothing to wait for would put the IPC hop in the typing path.
#[tauri::command]
pub fn lsp_notify(session_id: String, method: String, params: Value) -> Result<(), String> {
    crate::lsp::notify(&session_id, &method, params)
}

#[tauri::command]
pub fn lsp_running(session_id: String) -> bool {
    crate::lsp::is_running(&session_id)
}

/// Is this server on `PATH`, and which version? Powers the found/not-found badge in Settings —
/// the same treatment the AI engines get, and for the same reason: a language with no server
/// installed is a feature that is not there, not an error.
#[tauri::command]
pub async fn lsp_probe(command: String, args: Vec<String>) -> Result<String, String> {
    crate::lsp::probe(&command, &args).await
}
