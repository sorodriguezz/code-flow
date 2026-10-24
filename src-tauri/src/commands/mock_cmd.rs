//! The API client's mock server commands (`api::mock`): the collection's rules in and out of
//! `api_mocks`, and start / stop / log for the listener itself.
//!
//! Every command that touches a socket is `async` and runs on the Tokio runtime, so binding a port
//! or waiting for a stop never holds the UI thread.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::api::mock::{self, LogEntry, LogEvent, MockConfig, MockStatus};
use crate::db::{mock_queries, Db};

fn read_config(conn: &rusqlite::Connection, collection_id: &str) -> Result<MockConfig, String> {
    let raw = mock_queries::get(conn, collection_id).map_err(|e| e.to_string())?;
    // A config written by a newer build, or damaged by hand, falls back to the defaults rather
    // than leaving the panel unable to open.
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default())
}

fn notify(app: &AppHandle, collection_id: &str) {
    let _ = app.emit(mock::CHANGED_EVENT, collection_id.to_string());
}

async fn start_one(app: &AppHandle, collection_id: &str) -> Result<MockStatus, String> {
    let (config, name, workspace_id) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (name, workspace_id) = mock_queries::collection_meta(&conn, collection_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "collection not found".to_string())?;
        (read_config(&conn, collection_id)?, name, workspace_id)
    };
    let emitter = app.clone();
    let owner = collection_id.to_string();
    let on_log = Box::new(move |entry: &LogEntry| {
        let _ = emitter.emit(mock::LOG_EVENT, LogEvent { collection_id: owner.clone(), entry: entry.clone() });
    });
    let status = mock::start(collection_id, &workspace_id, &name, config, Some(on_log)).await;
    notify(app, collection_id);
    status
}

#[tauri::command]
pub fn api_mock_get_config(db: State<Db>, collection_id: String) -> Result<MockConfig, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_config(&conn, &collection_id)
}

/// Saves the rules. A running mock serves them from the next request; one whose port or bind
/// address changed is restarted on the new one, since a listener cannot move.
#[tauri::command]
pub async fn api_mock_save_config(
    app: AppHandle,
    collection_id: String,
    config: MockConfig,
) -> Result<Option<MockStatus>, String> {
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
        mock_queries::save(&conn, &collection_id, &json).map_err(|e| e.to_string())?;
    }
    let Some(current) = mock::status(&collection_id) else { return Ok(None) };
    let wanted_host = if config.expose_lan { "0.0.0.0" } else { "127.0.0.1" };
    let moved = current.host != wanted_host || (config.port != 0 && config.port != current.port);
    if moved {
        return start_one(&app, &collection_id).await.map(Some);
    }
    mock::update_config(&collection_id, config);
    Ok(Some(current))
}

#[tauri::command]
pub async fn api_mock_start(app: AppHandle, collection_id: String) -> Result<MockStatus, String> {
    start_one(&app, &collection_id).await
}

#[tauri::command]
pub async fn api_mock_stop(app: AppHandle, collection_id: String) -> Result<(), String> {
    if mock::stop(&collection_id).await {
        notify(&app, &collection_id);
    }
    Ok(())
}

/// Every running mock, in any workspace.
#[tauri::command]
pub fn api_mock_list() -> Vec<MockStatus> {
    mock::list()
}

#[tauri::command]
pub fn api_mock_log(collection_id: String) -> Vec<LogEntry> {
    mock::log_of(&collection_id)
}

#[tauri::command]
pub fn api_mock_clear_log(collection_id: String) {
    mock::clear_log(&collection_id);
}

/// One configured mock of a workspace, for the Services dock.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockSummary {
    pub collection_id: String,
    pub name: String,
    pub routes: usize,
    pub with_services: bool,
    pub running: Option<MockStatus>,
}

/// The mocks a workspace has set up — the ones with at least one route, or running.
#[tauri::command]
pub fn api_mock_workspace(db: State<Db>, workspace_id: String) -> Result<Vec<MockSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let rows = mock_queries::list_for_workspace(&conn, &workspace_id).map_err(|e| e.to_string())?;
    // A mock whose collection was deleted while it ran has no row to join any more; it is listed
    // anyway, so there is always somewhere to stop it from.
    let orphans: Vec<MockSummary> = mock::list()
        .into_iter()
        .filter(|s| s.workspace_id == workspace_id && !rows.iter().any(|(id, _, _)| *id == s.collection_id))
        .map(|s| MockSummary {
            collection_id: s.collection_id.clone(),
            name: s.name.clone(),
            routes: 0,
            with_services: false,
            running: Some(s),
        })
        .collect();
    Ok(rows
        .into_iter()
        .filter_map(|(collection_id, name, raw)| {
            let config: MockConfig = serde_json::from_str(&raw).unwrap_or_default();
            let running = mock::status(&collection_id);
            (!config.routes.is_empty() || running.is_some()).then(|| MockSummary {
                routes: config.routes.len(),
                with_services: config.with_services,
                running,
                collection_id,
                name,
            })
        })
        .chain(orphans)
        .collect())
}

/// Starts the workspace's mocks marked «Arrancar con los servicios» that are not up yet — called
/// when the Services dock starts a group (user, 2026-10-23: «aparece en Servicios, para arrancarlo
/// junto con el resto del proyecto»). Failures are returned per mock rather than failing the rest.
#[tauri::command]
pub async fn api_mock_start_with_services(app: AppHandle, workspace_id: String) -> Result<Vec<String>, String> {
    let wanted: Vec<String> = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        mock_queries::list_for_workspace(&conn, &workspace_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|(id, _, raw)| {
                let config: MockConfig = serde_json::from_str(raw).unwrap_or_default();
                config.with_services && !config.routes.is_empty() && mock::status(id).is_none()
            })
            .map(|(id, _, _)| id)
            .collect()
    };
    let mut errors = Vec::new();
    for id in wanted {
        if let Err(e) = start_one(&app, &id).await {
            errors.push(e);
        }
    }
    Ok(errors)
}
