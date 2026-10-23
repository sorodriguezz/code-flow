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

/// One kind of source that is not a folder — notes, meetings, generated docs, story drafts, review
/// findings, commit messages — summed over its collections in the workspace.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceKnowledge {
    /// `note` | `meeting` | `doc` | `story` | `review` | `commit`.
    pub kind: String,
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
    pub sources: Vec<SourceKnowledge>,
}

fn workspace_scope(conn: &rusqlite::Connection, workspace_id: &str) -> Result<Scope, String> {
    let mut repos: Vec<(String, String, PathBuf)> = crate::db::queries::list_projects(conn, workspace_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|p| !p.local_path.is_empty())
        .map(|p| (p.id, p.name, PathBuf::from(p.local_path)))
        .collect();
    // The reference repositories switched on for the workspace — the local view, so the ones kept for
    // the local model are listed too.
    repos.extend(crate::refrepos::scope_entries(conn, workspace_id, false));
    let folders = knowledge::collections(conn, Some(workspace_id))
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.id, c.name, PathBuf::from(c.path)))
        .collect();
    // The pane's view is the local one: every folder and note, the local-only ones included.
    Ok(Scope { workspace_id: Some(workspace_id.to_string()), repos, folders, notes: true, cloud: false, sources: Default::default(), via_main_checkout: None })
}

/// The embedding setting and the Ollama URL, read under the lock; the space is resolved after it is
/// released ([`embed::Space::resolve`] may ask Ollama for the model's digest).
fn embed_settings(conn: &rusqlite::Connection) -> (Option<String>, String) {
    let setting = crate::db::queries::get_setting(conn, embed::KEY_EMBED_MODEL).ok().flatten();
    let url = crate::db::queries::get_setting(conn, crate::hybrid::config::KEY_URL_OLLAMA).ok().flatten().unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
    (setting, url)
}

/// `statuses` summed: what the pane shows for a kind spread over several collections (a workspace's
/// notes and the global ones).
fn summed(kind: &str, statuses: Vec<index::CollectionStatus>) -> index::CollectionStatus {
    let mut total = index::CollectionStatus::empty(kind);
    for status in statuses {
        total.files += status.files;
        total.chunks += status.chunks;
        total.vectors += status.vectors;
        total.refreshed_at = total.refreshed_at.max(status.refreshed_at);
    }
    total
}

#[tauri::command]
pub async fn knowledge_overview(db: State<'_, Db>, workspace_id: String) -> Result<KnowledgeOverview, String> {
    let (scope, (embed_setting, ollama_url), cloud_allowed, all_folders) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let cloud_allowed = !crate::db::queries::get_setting(&conn, &knowledge::cloud_key(&workspace_id))
            .ok()
            .flatten()
            .is_some_and(|v| v == "0" || v == "false");
        (
            workspace_scope(&conn, &workspace_id)?,
            embed_settings(&conn),
            cloud_allowed,
            knowledge::collections(&conn, Some(&workspace_id)).map_err(|e| e.to_string())?,
        )
    };
    let space = embed::Space::resolve(embed_setting.as_deref(), &ollama_url).await;
    let space_name = space.as_ref().map(|s| s.name.clone());
    let (repos, folders, sources) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let index = index::global()?;
        let status_of = |key: &str| index::status(&index, key, space_name.as_deref()).unwrap_or_else(|_| index::CollectionStatus::empty(key));
        let repos: Vec<RepoKnowledge> =
            scope.repos.iter().map(|(id, name, _)| RepoKnowledge { project_id: id.clone(), name: name.clone(), status: status_of(&knowledge::repo_key(id)) }).collect();
        let folders: Vec<FolderKnowledge> = all_folders
            .into_iter()
            .map(|collection| {
                let status = status_of(&knowledge::folder_key(&collection.id));
                FolderKnowledge { collection, status }
            })
            .collect();
        let keys = scope.keys();
        let sources: Vec<SourceKnowledge> = [("note", "notes:"), ("meeting", "meetings:"), ("doc", "docs:"), ("story", "stories:"), ("review", "reviews:"), ("commit", "commits:")]
            .into_iter()
            .map(|(kind, prefix)| SourceKnowledge {
                kind: kind.to_string(),
                status: summed(kind, keys.iter().filter(|k| k.starts_with(prefix)).map(|k| status_of(k)).collect()),
            })
            .collect();
        Ok((repos, folders, sources))
    })
    .await
    .map_err(|e| e.to_string())??;
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
    Ok(KnowledgeOverview { cloud_allowed, embed_models, embed_setting, space: space.map(|s| s.name), repos, folders, sources })
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

/// Empties the workspace's part of the index (and whatever nothing points at), giving the space
/// back to the disk; the next search rebuilds it. Returns how many collections went.
#[tauri::command]
pub async fn knowledge_clear(db: State<'_, Db>, workspace_id: String) -> Result<usize, String> {
    let (scope, alive) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (workspace_scope(&conn, &workspace_id)?, knowledge::alive_ids(&conn).map_err(|e| e.to_string())?)
    };
    tokio::task::spawn_blocking(move || {
        let index = index::global()?;
        knowledge::clear(&index, &scope, &alive).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
        // The same door every local model passes: no Ollama cloud model, and no server off this
        // machine and the user's own network — the knowledge is embedded where it lives.
        Some(model)
            if model.starts_with("ollama:")
                && crate::hybrid::local_llm::cloud_refusal(&embed_settings(&conn).1, model.trim_start_matches("ollama:")).is_some() =>
        {
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
    let (scope, (setting, ollama_url)) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (workspace_scope(&conn, &workspace_id)?, embed_settings(&conn))
    };
    let space = embed::Space::resolve(setting.as_deref(), &ollama_url).await;
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
    // Its vectors go with it: nothing can compare a question against them any more.
    let id = model_id.clone();
    let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let index = index::global()?;
        if index::remove_space(&index, &format!("{id}@")).map_err(|e| e.to_string())? > 0 {
            index::compact(&index).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await;
    Ok(())
}
