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
pub fn list_review_contexts(db: State<Db>, project_id: String) -> Result<Vec<ReviewContext>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_review_contexts(&conn, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_review_context(
    db: State<Db>,
    id: Option<String>,
    project_id: String,
    name: String,
    content: String,
    enabled: bool,
) -> Result<ReviewContext, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_review_context(&conn, id, &project_id, &name, &content, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_review_context(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_review_context(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_installed_skills(db: State<Db>) -> Result<Vec<InstalledSkill>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_installed_skills(&conn).map_err(|e| e.to_string())
}
