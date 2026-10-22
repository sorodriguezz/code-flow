//! The external editor's commands: what the menus and Settings list, and the one that opens a
//! repository. The choices themselves are plain settings the frontend writes (`set_setting`) — see
//! `external_editor` for the keys and the rule that picks among them.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::external_editor::{self as editors, DEFAULT_KEY, EDITORS, PROJECT_PREFIX, WORKSPACE_PREFIX};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorRow {
    id: &'static str,
    label: &'static str,
    installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditorState {
    /// Every editor CodeFlow knows, installed or not, in «automatic»'s order.
    editors: Vec<EditorRow>,
    /// The app's choice; `""` is automatic.
    default: String,
    /// What «automatic» opens on this machine.
    auto: &'static str,
    /// Workspace id → its choice, only where one was made.
    workspaces: HashMap<String, String>,
    /// Repository id → its choice, only where one was made.
    projects: HashMap<String, String>,
}

/// The installed editors' ids, in [`EDITORS`]' order.
fn installed() -> Vec<&'static str> {
    EDITORS.iter().filter(|editor| editors::locate(editor).is_some()).map(|editor| editor.id).collect()
}

/// Every choice stored, by key.
fn choices(app: &AppHandle) -> HashMap<String, String> {
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return HashMap::new() };
    let Ok(mut statement) = conn.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'external_editor%'") else { return HashMap::new() };
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)));
    rows.map(|rows| rows.flatten().filter(|(_, value)| !value.trim().is_empty()).collect()).unwrap_or_default()
}

#[tauri::command]
pub fn external_editor_state(app: AppHandle) -> ExternalEditorState {
    let installed = installed();
    let stored = choices(&app);
    let scoped = |prefix: &str| stored.iter().filter_map(|(key, value)| key.strip_prefix(prefix).map(|id| (id.to_string(), value.clone()))).collect();
    ExternalEditorState {
        editors: EDITORS.iter().map(|editor| EditorRow { id: editor.id, label: editor.label, installed: installed.contains(&editor.id) }).collect(),
        default: stored.get(DEFAULT_KEY).cloned().unwrap_or_default(),
        auto: editors::resolve(None, None, None, &installed).id,
        workspaces: scoped(WORKSPACE_PREFIX),
        projects: scoped(PROJECT_PREFIX),
    }
}

/// Opens `path` in `editor` when one is named («Abrir con»), else in the one chosen for the
/// repository and its workspace. Returns the editor's name.
#[tauri::command]
pub fn open_in_external_editor(app: AppHandle, path: String, project_id: Option<String>, workspace_id: Option<String>, editor: Option<String>) -> Result<String, String> {
    let chosen = match editor.as_deref().and_then(editors::find) {
        Some(named) => named,
        None => {
            let stored = choices(&app);
            let scoped = |prefix: &str, id: &Option<String>| id.as_ref().and_then(|id| stored.get(&format!("{prefix}{id}")).cloned());
            editors::resolve(
                scoped(PROJECT_PREFIX, &project_id).as_deref(),
                scoped(WORKSPACE_PREFIX, &workspace_id).as_deref(),
                stored.get(DEFAULT_KEY).map(String::as_str),
                &installed(),
            )
        }
    };
    editors::open(chosen, std::path::Path::new(&path))?;
    Ok(chosen.label.to_string())
}
