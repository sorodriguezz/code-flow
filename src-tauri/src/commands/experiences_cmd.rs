//! Experiences, for the panes that capture them (turn review, apply code) and the Learning pane
//! that reviews them — see `crate::experiences`.

use tauri::State;

use crate::db::Db;
use crate::experiences::{self, Experience, Filter, NewExperience};

fn conn<'a>(db: &'a State<'_, Db>) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    db.0.lock().map_err(|e| e.to_string())
}

/// Records an experience the frontend saw happen (a turn kept, code applied). `None`: the same
/// event was already recorded.
#[tauri::command]
pub fn ai_experience_record(db: State<'_, Db>, input: NewExperience) -> Result<Option<String>, String> {
    let conn = conn(&db)?;
    let mut input = input;
    if input.project_id.is_none() {
        if let Some((project, workspace)) = input.repo_path.as_deref().and_then(|path| experiences::project_for_path(&conn, path)) {
            input.project_id = Some(project);
            input.workspace_id = input.workspace_id.or(workspace);
        }
    }
    if input.workspace_id.is_none() {
        if let Some(project) = input.project_id.as_deref() {
            input.workspace_id = conn
                .query_row("SELECT workspace_id FROM projects WHERE id = ?1", [project], |row| row.get::<_, Option<String>>(0))
                .ok()
                .flatten();
        }
    }
    experiences::record(&conn, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_experiences_list(db: State<'_, Db>, filter: Option<Filter>) -> Result<Vec<Experience>, String> {
    experiences::list(&*conn(&db)?, &filter.unwrap_or_default()).map_err(|e| e.to_string())
}

/// One experience — the evidence behind a memory proposed from it.
#[tauri::command]
pub fn ai_experience_get(db: State<'_, Db>, id: String) -> Result<Option<Experience>, String> {
    experiences::get(&*conn(&db)?, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_experiences_counts(db: State<'_, Db>, workspace_id: Option<String>) -> Result<Vec<(String, i64)>, String> {
    experiences::counts(&*conn(&db)?, workspace_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_experience_set_quality(db: State<'_, Db>, id: String, quality: String) -> Result<(), String> {
    experiences::set_quality(&*conn(&db)?, &id, &quality).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_experience_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    experiences::delete(&*conn(&db)?, &id).map_err(|e| e.to_string())
}

/// Deletes a workspace's experiences (`None`: all of them). Returns how many went.
#[tauri::command]
pub fn ai_experiences_clear(db: State<'_, Db>, workspace_id: Option<String>) -> Result<usize, String> {
    experiences::clear(&*conn(&db)?, workspace_id.as_deref()).map_err(|e| e.to_string())
}

/// Writes the matching experiences, redacted, as JSON Lines to `path` (chosen in a save dialog).
#[tauri::command]
pub fn ai_experiences_export(db: State<'_, Db>, filter: Option<Filter>, path: String) -> Result<usize, String> {
    let jsonl = experiences::export_jsonl(&*conn(&db)?, &filter.unwrap_or_default()).map_err(|e| e.to_string())?;
    let lines = jsonl.lines().count();
    std::fs::write(&path, jsonl).map_err(|e| e.to_string())?;
    Ok(lines)
}

#[tauri::command]
pub fn ai_training_allowed(db: State<'_, Db>, workspace_id: String) -> Result<bool, String> {
    let conn = conn(&db)?;
    Ok(crate::db::queries::get_setting(&conn, &experiences::training_key(&workspace_id))
        .map_err(|e| e.to_string())?
        .is_some_and(|v| v == "1" || v == "true"))
}

/// Turns a workspace's "use for training" switch on or off — for its existing experiences too.
#[tauri::command]
pub fn ai_set_training_allowed(db: State<'_, Db>, workspace_id: String, allowed: bool) -> Result<(), String> {
    experiences::set_training_allowed(&*conn(&db)?, &workspace_id, allowed).map_err(|e| e.to_string())
}
