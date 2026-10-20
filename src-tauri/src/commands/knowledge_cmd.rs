//! Settings › Local intelligence › Knowledge — see `crate::knowledge`.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::knowledge::{self, embed, index, Collection, Scope};
use crate::localai::{download, embedder, models, LocalAiRegistry};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedRow {
    pub id: String,
    pub label: String,
    pub params: String,
    pub licence: String,
    pub size_bytes: u64,
    pub installed: bool,
    pub partial_bytes: Option<u64>,
    pub dims: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoKnowledge {
    pub project_id: String,
    pub name: String,
    pub status: index::CollectionStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderKnowledge {
    pub collection: Collection,
    pub status: index::CollectionStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeOverview {
    /// May the workspace's cloud engines search it (through the map's MCP server)?
    pub cloud_allowed: bool,
    pub embed_models: Vec<EmbedRow>,
    /// The setting as stored: a catalogue id, `ollama:<model>`, or `None` for the default.
    pub embed_setting: Option<String>,
    /// The space vectors are made in now; `None` when no local embedding model is available.
    pub space: Option<String>,
    pub repos: Vec<RepoKnowledge>,
    pub folders: Vec<FolderKnowledge>,
}

fn workspace_scope(conn: &rusqlite::Connection, workspace_id: &str) -> Result<Scope, String> {
    let repos = crate::db::queries::list_projects(conn, workspace_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|p| !p.local_path.is_empty())
        .map(|p| (p.id, p.name, PathBuf::from(p.local_path)))
        .collect();
    let folders = knowledge::collections(conn, Some(workspace_id))
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.id, c.name, PathBuf::from(c.path)))
        .collect();
    Ok(Scope { workspace_id: Some(workspace_id.to_string()), repos, folders, notes: true })
}

fn space_of(conn: &rusqlite::Connection) -> (Option<String>, Option<embed::Space>) {
    let setting = crate::db::queries::get_setting(conn, embed::KEY_EMBED_MODEL).ok().flatten();
    let url = crate::db::queries::get_setting(conn, crate::hybrid::config::KEY_URL_OLLAMA).ok().flatten();
    let space = embed::Space::configured(setting.as_deref(), url.as_deref().unwrap_or("http://127.0.0.1:11434"));
    (setting, space)
}

#[tauri::command]
pub fn knowledge_overview(db: State<'_, Db>, workspace_id: String) -> Result<KnowledgeOverview, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let scope = workspace_scope(&conn, &workspace_id)?;
    let (embed_setting, space) = space_of(&conn);
    let cloud_allowed = !crate::db::queries::get_setting(&conn, &knowledge::cloud_key(&workspace_id))
        .ok()
        .flatten()
        .is_some_and(|v| v == "0" || v == "false");
    let all_folders = knowledge::collections(&conn, Some(&workspace_id)).map_err(|e| e.to_string())?;
    drop(conn);
    let index = index::global()?;
    let space_name = space.as_ref().map(|s| s.name.clone());
    let repos = scope
        .repos
        .iter()
        .map(|(id, name, _)| RepoKnowledge {
            project_id: id.clone(),
            name: name.clone(),
            status: index::status(&index, &knowledge::repo_key(id), space_name.as_deref()).unwrap_or(index::CollectionStatus {
                collection: knowledge::repo_key(id),
                files: 0,
                chunks: 0,
                vectors: 0,
                refreshed_at: None,
            }),
        })
        .collect();
    let folders = all_folders
        .into_iter()
        .map(|collection| {
            let key = knowledge::folder_key(&collection.id);
            let status = index::status(&index, &key, space_name.as_deref()).unwrap_or(index::CollectionStatus {
                collection: key,
                files: 0,
                chunks: 0,
                vectors: 0,
                refreshed_at: None,
            });
            FolderKnowledge { collection, status }
        })
        .collect();
    let embed_models = embedder::EMBED_CATALOGUE
        .iter()
        .map(|e| EmbedRow {
            id: e.spec.id.to_string(),
            label: e.spec.label.to_string(),
            params: e.spec.params.to_string(),
            licence: e.spec.licence.to_string(),
            size_bytes: e.spec.size_bytes,
            installed: models::is_installed(&e.spec),
            partial_bytes: models::partial_bytes(&e.spec),
            dims: e.dims,
        })
        .collect();
    Ok(KnowledgeOverview { cloud_allowed, embed_models, embed_setting, space: space_name, repos, folders })
}

#[tauri::command]
pub fn knowledge_add_folder(db: State<'_, Db>, workspace_id: String, path: String, name: Option<String>, local_only: Option<bool>) -> Result<Collection, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    knowledge::add_collection(&conn, Some(&workspace_id), name.as_deref().unwrap_or_default(), &path, local_only.unwrap_or(false))
}

#[tauri::command]
pub fn knowledge_update_folder(db: State<'_, Db>, id: String, local_only: Option<bool>, enabled: Option<bool>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    knowledge::update_collection(&conn, &id, local_only, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn knowledge_remove_folder(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    knowledge::remove_collection(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn knowledge_set_cloud(db: State<'_, Db>, workspace_id: String, allowed: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::db::queries::set_setting(&conn, &knowledge::cloud_key(&workspace_id), if allowed { "1" } else { "0" }).map_err(|e| e.to_string())
}

/// Chooses the embedding model (`None`: the default). Vectors of another model stay, unused, until
/// that model is chosen again.
#[tauri::command]
pub fn knowledge_set_embed_model(db: State<'_, Db>, model: Option<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match model.filter(|m| !m.trim().is_empty()) {
        Some(model) if model.starts_with("ollama:") && crate::hybrid::local_llm::is_cloud_name(model.trim_start_matches("ollama:")) => {
            Err("cloud-model".to_string())
        }
        Some(model) => crate::db::queries::set_setting(&conn, embed::KEY_EMBED_MODEL, &model).map_err(|e| e.to_string()),
        None => conn.execute("DELETE FROM app_settings WHERE key = ?1", [embed::KEY_EMBED_MODEL]).map(|_| ()).map_err(|e| e.to_string()),
    }
}

/// Re-indexes every repository and folder of the workspace now, then embeds what is new in the
/// background.
#[tauri::command]
pub async fn knowledge_reindex(db: State<'_, Db>, workspace_id: String) -> Result<Vec<(String, index::Refreshed)>, String> {
    let (scope, space) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (workspace_scope(&conn, &workspace_id)?, space_of(&conn).1)
    };
    let refresh_scope = scope.clone();
    let done = tokio::task::spawn_blocking(move || knowledge::refresh_blocking(&refresh_scope, true)).await.map_err(|e| e.to_string())??;
    if let Some(space) = space {
        knowledge::vectorize_in_background(scope, space);
    }
    Ok(done)
}

/// What the knowledge engine finds for `query` in the workspace — the pane's test box, with the
/// local view (every folder).
#[tauri::command]
pub async fn knowledge_search(db: State<'_, Db>, workspace_id: String, query: String, limit: Option<usize>) -> Result<Vec<knowledge::Found>, String> {
    let scope = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        workspace_scope(&conn, &workspace_id)?
    };
    knowledge::search(&scope, &query, limit.unwrap_or(knowledge::DEFAULT_LIMIT).clamp(1, 30)).await
}

#[tauri::command]
pub async fn knowledge_download_model(app: AppHandle, registry: State<'_, LocalAiRegistry>, model_id: String) -> Result<(), String> {
    let entry = embedder::find(&model_id).ok_or_else(|| format!("Unknown model: {model_id}"))?;
    let cancel = registry.register_download(model_id.clone())?;
    let result = download::fetch(&app, &entry.spec, &models::dir(), cancel).await;
    registry.clear_download(&model_id);
    result.map(|_| ())
}

#[tauri::command]
pub fn knowledge_cancel_download(registry: State<LocalAiRegistry>, model_id: String) {
    registry.cancel_download(&model_id);
}

#[tauri::command]
pub async fn knowledge_delete_model(registry: State<'_, LocalAiRegistry>, model_id: String) -> Result<(), String> {
    let entry = embedder::find(&model_id).ok_or_else(|| format!("Unknown model: {model_id}"))?;
    registry.cancel_download(&model_id);
    embedder::shutdown().await;
    let path = models::path_of(&entry.spec);
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
