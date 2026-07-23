use tauri::State;

use crate::db::{
    models::{ActivityLogEntry, ChatConversationSummary},
    queries, Db,
};

#[tauri::command]
pub fn list_chat_conversations(
    db: State<'_, Db>,
    project_id: String,
    search: Option<String>,
) -> Result<Vec<ChatConversationSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_chat_conversations(&conn, &project_id, search.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_chat_conversation(
    db: State<'_, Db>,
    project_id: String,
    session_id: String,
) -> Result<Vec<ActivityLogEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_conversation_messages(&conn, &project_id, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat_conversation(db: State<'_, Db>, project_id: String, session_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_chat_conversation(&conn, &project_id, &session_id).map_err(|e| e.to_string())
}
