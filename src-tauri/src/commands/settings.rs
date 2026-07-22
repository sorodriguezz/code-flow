use tauri::State;

use crate::db::{models::*, queries, Db};

#[tauri::command]
pub fn get_setting(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_setting(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_review_contexts(db: State<Db>, workspace_id: String) -> Result<Vec<ReviewContext>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_review_context(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    name: String,
    content: String,
    enabled: bool,
) -> Result<ReviewContext, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_review_context(&conn, id, &workspace_id, &name, &content, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_review_context(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_review_context(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_workspace_md_files(db: State<Db>, workspace_id: String) -> Result<Vec<WorkspaceMdFile>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspace_md_files(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_workspace_md_file(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    filename: String,
    content: String,
    enabled: bool,
) -> Result<WorkspaceMdFile, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_workspace_md_file(&conn, id, &workspace_id, &filename, &content, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace_md_file(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_workspace_md_file(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_workspace_mcps(db: State<Db>, workspace_id: String) -> Result<Vec<WorkspaceMcp>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn upsert_workspace_mcp(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    name: String,
    command: String,
    args: String,
    env: String,
    enabled: bool,
) -> Result<WorkspaceMcp, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_workspace_mcp(&conn, id, &workspace_id, &name, &command, &args, &env, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace_mcp(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_workspace_mcp(&conn, &id).map_err(|e| e.to_string())
}
