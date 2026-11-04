//! Tauri commands for the Agents view's own records — see `crate::crew`.
//!
//! Every write emits an event (`crew:library`, `crew:backlog`, `crew:roster`) to every window, so
//! the main window and an Agents island show the same thing without either polling.

use tauri::{AppHandle, Emitter, State};

use crate::crew::{self, BacklogItem, BacklogLink, DecisionRow, LibraryItem, TicketImport};
use crate::db::models::{AgentDraft, WorkspaceAgent};
use crate::db::{queries, Db};

fn lock(db: &Db) -> Result<crate::db::DbGuard<'_>, String> {
    db.0.lock().map_err(|e| e.to_string())
}

fn emit_backlog(app: &AppHandle, workspace_id: &str) {
    let _ = app.emit("crew:backlog", serde_json::json!({ "workspaceId": workspace_id }));
}

fn emit_roster(app: &AppHandle, workspace_id: &str) {
    let _ = app.emit("crew:roster", serde_json::json!({ "workspaceId": workspace_id }));
}

// ---------- roster ----------

#[tauri::command]
pub fn save_workspace_agent(app: AppHandle, db: State<Db>, draft: AgentDraft) -> Result<WorkspaceAgent, String> {
    if draft.name.trim().is_empty() {
        return Err("El agente necesita un nombre.".into());
    }
    let agent = {
        let conn = lock(&db)?;
        queries::save_workspace_agent(&conn, &draft).map_err(|e| e.to_string())?
    };
    emit_roster(&app, &agent.workspace_id);
    Ok(agent)
}

#[tauri::command]
pub fn reorder_workspace_agents(app: AppHandle, db: State<Db>, workspace_id: String, ids: Vec<String>) -> Result<(), String> {
    {
        let conn = lock(&db)?;
        queries::reorder_workspace_agents(&conn, &workspace_id, &ids).map_err(|e| e.to_string())?;
    }
    emit_roster(&app, &workspace_id);
    Ok(())
}

// ---------- library ----------

#[tauri::command]
pub fn library_list(db: State<Db>, kind: Option<String>) -> Result<Vec<LibraryItem>, String> {
    let conn = lock(&db)?;
    crew::library_list(&conn, kind.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_save(app: AppHandle, db: State<Db>, item: LibraryItem) -> Result<LibraryItem, String> {
    let saved = {
        let conn = lock(&db)?;
        crew::library_save(&conn, &item)?
    };
    let _ = app.emit("crew:library", serde_json::json!({ "id": saved.id }));
    Ok(saved)
}

#[tauri::command]
pub fn library_delete(app: AppHandle, db: State<Db>, id: String) -> Result<(), String> {
    {
        let conn = lock(&db)?;
        crew::library_delete(&conn, &id).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("crew:library", serde_json::json!({ "id": id }));
    Ok(())
}

// ---------- backlog ----------

#[tauri::command]
pub fn backlog_list(db: State<Db>, workspace_id: String) -> Result<Vec<BacklogItem>, String> {
    let conn = lock(&db)?;
    crew::backlog_list(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn backlog_save(app: AppHandle, db: State<Db>, item: BacklogItem) -> Result<BacklogItem, String> {
    let saved = {
        let conn = lock(&db)?;
        crew::backlog_save(&conn, &item)?
    };
    emit_backlog(&app, &saved.workspace_id);
    Ok(saved)
}

#[tauri::command]
pub fn backlog_move(app: AppHandle, db: State<Db>, id: String, status: String, rank: f64) -> Result<(), String> {
    let workspace = {
        let conn = lock(&db)?;
        crew::backlog_move(&conn, &id, &status, rank)?;
        crew::backlog_get(&conn, &id).map_err(|e| e.to_string())?.map(|c| c.workspace_id)
    };
    if let Some(ws) = workspace {
        emit_backlog(&app, &ws);
    }
    Ok(())
}

#[tauri::command]
pub fn backlog_delete(app: AppHandle, db: State<Db>, id: String) -> Result<(), String> {
    let workspace = {
        let conn = lock(&db)?;
        let ws = crew::backlog_get(&conn, &id).map_err(|e| e.to_string())?.map(|c| c.workspace_id);
        crew::backlog_delete(&conn, &id).map_err(|e| e.to_string())?;
        ws
    };
    if let Some(ws) = workspace {
        emit_backlog(&app, &ws);
    }
    Ok(())
}

#[tauri::command]
pub fn backlog_link(app: AppHandle, db: State<Db>, item_id: String, kind: String, ref_id: String) -> Result<BacklogLink, String> {
    let (link, workspace) = {
        let conn = lock(&db)?;
        let link = crew::backlog_link(&conn, &item_id, &kind, &ref_id)?;
        let ws = crew::backlog_get(&conn, &item_id).map_err(|e| e.to_string())?.map(|c| c.workspace_id);
        (link, ws)
    };
    if let Some(ws) = workspace {
        emit_backlog(&app, &ws);
    }
    Ok(link)
}

#[tauri::command]
pub fn backlog_unlink(db: State<Db>, link_id: String) -> Result<(), String> {
    let conn = lock(&db)?;
    crew::backlog_unlink(&conn, &link_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn backlog_import_tickets(app: AppHandle, db: State<Db>, workspace_id: String, tickets: Vec<TicketImport>) -> Result<Vec<BacklogItem>, String> {
    let cards = {
        let conn = lock(&db)?;
        crew::backlog_import_tickets(&conn, &workspace_id, &tickets)?
    };
    emit_backlog(&app, &workspace_id);
    Ok(cards)
}

// ---------- decisions ----------

#[tauri::command]
pub fn decisions_for_run(db: State<Db>, run_id: String, limit: Option<i64>) -> Result<Vec<DecisionRow>, String> {
    let conn = lock(&db)?;
    crew::decisions_for_run(&conn, &run_id, limit.unwrap_or(200)).map_err(|e| e.to_string())
}
