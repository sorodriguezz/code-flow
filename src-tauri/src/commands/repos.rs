use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::{models::*, queries, Db};
use crate::paths;

#[tauri::command]
pub fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

/// Where a "Clone repository" flow should default to: `C:\CodeFlow\repos\<name>` on
/// Windows (same root as the rest of the app's persisted state), OS app-data equivalent
/// elsewhere. The frontend appends the repo name itself.
#[tauri::command]
pub fn default_clone_dir() -> String {
    paths::clone_root().to_string_lossy().to_string()
}

#[tauri::command]
pub fn create_workspace(db: State<Db>, name: String, icon: String, color: String) -> Result<Workspace, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_workspace(&conn, &name, &icon, &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_workspaces(db: State<Db>) -> Result<Vec<Workspace>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspaces(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_workspace(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_workspace_color(db: State<Db>, id: String, color: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_workspace_color(&conn, &id, &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_project(db: State<Db>, input: NewProject) -> Result<Project, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_project(&conn, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_projects(db: State<Db>, workspace_id: String) -> Result<Vec<Project>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_projects(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_project(db: State<Db>, id: String) -> Result<Option<Project>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_project(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_project(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_project(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_project_to_workspace(db: State<Db>, id: String, workspace_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::move_project_to_workspace(&conn, &id, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_project_color(db: State<Db>, id: String, color: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_project_color(&conn, &id, &color).map_err(|e| e.to_string())
}
