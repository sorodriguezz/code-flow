//! Settings › Local intelligence › Memory — see `crate::ai_memory`.

use serde::Serialize;
use tauri::State;

use crate::ai_memory::{self, Filter, Kind, Memory, NewMemory, Page, Patch, Remembered, Revision};
use crate::db::Db;

/// One page of memories for the pane, filtered and paged in SQL — the pane used to load 500 rows of
/// every workspace and filter them itself, which both hid the 501st and cost a full table read on
/// every keystroke of its search.
#[tauri::command]
pub fn ai_memory_list(db: State<'_, Db>, filter: Option<Filter>) -> Result<Page, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::page(&conn, &filter.unwrap_or_default()).map_err(|e| e.to_string())
}

/// What a create did: the memory, and whether it is new, an existing proposal just approved, an
/// approved one whose body changed, or already there — so the pane can say which.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub memory: Memory,
    pub outcome: Remembered,
}

/// A memory written in the pane is approved (`input.approved`): the user's own word, through
/// `ai_memory::remember`. Anything else is a proposal, through `ai_memory::propose`.
#[tauri::command]
pub fn ai_memory_create(db: State<'_, Db>, input: NewMemory) -> Result<Created, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (memory, outcome) = if input.approved { ai_memory::remember(&conn, input)? } else { ai_memory::propose(&conn, input)? };
    Ok(Created { memory, outcome })
}

#[tauri::command]
pub fn ai_memory_edit(db: State<'_, Db>, id: String, patch: Patch) -> Result<Memory, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::edit(&conn, &id, patch)
}

/// `approved` | `revoked` | `candidate`. `kind`, with `approved`: what the user approves it as — an
/// agent's proposal arrives as a fact, and only the user makes it an always-on preference.
#[tauri::command]
pub fn ai_memory_set_status(db: State<'_, Db>, id: String, status: String, kind: Option<Kind>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if status == "approved" {
        ai_memory::approve(&conn, &id, kind)
    } else {
        ai_memory::set_status(&conn, &id, &status)
    }
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
/// Returns only the new proposals; the ones already there gain the new evidence.
#[tauri::command]
pub fn ai_memory_propose(db: State<'_, Db>, workspace_id: String) -> Result<Vec<Memory>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ai_memory::propose_from_experiences(&conn, &workspace_id)
}
