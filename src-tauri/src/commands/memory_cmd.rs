//! Settings › Local intelligence › Memory — see `crate::ai_memory`.

use tauri::State;

use crate::ai_memory::{self, Filter, Memory, NewMemory, Patch, Revision};
use crate::db::Db;

#[tauri::command]
pub fn ai_memory_list(db: State<'_, Db>, filter: Option<Filter>) -> Result<Vec<Memory>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::list(&conn, &filter.unwrap_or_default()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_memory_create(db: State<'_, Db>, input: NewMemory) -> Result<Memory, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::create(&conn, input)
}

#[tauri::command]
pub fn ai_memory_edit(db: State<'_, Db>, id: String, patch: Patch) -> Result<Memory, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::edit(&conn, &id, patch)
}

/// `approved` | `revoked` | `candidate`.
#[tauri::command]
pub fn ai_memory_set_status(db: State<'_, Db>, id: String, status: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::set_status(&conn, &id, &status)
}

#[tauri::command]
pub fn ai_memory_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::delete(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_memory_revisions(db: State<'_, Db>, id: String) -> Result<Vec<Revision>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::revisions(&conn, &id).map_err(|e| e.to_string())
}

/// Looks at the workspace's recent experiences and proposes candidates from them (repeated reverts).
#[tauri::command]
pub fn ai_memory_propose(db: State<'_, Db>, workspace_id: String) -> Result<Vec<Memory>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::propose_from_experiences(&conn, &workspace_id)
}
