//! Settings › Repositorios de referencia — see `crate::refrepos`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::Db;
use crate::knowledge::{embed, index};
use crate::refrepos::{self, NewRef, Op, Patch, RefRepo, RemoteBranches};

/// One row of the pane: the repository, what it is doing now and what its index holds.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefRepoView {
    #[serde(flatten)]
    pub repo: RefRepo,
    /// `cloning` · `pulling` · `switching` · `indexing`, while one runs.
    pub busy: Option<&'static str>,
    pub cloned: bool,
    /// Files, passages and vectors in its knowledge collection; `None` before its first index.
    pub index: Option<index::CollectionStatus>,
}

fn changed(app: &AppHandle, id: &str) {
    let _ = app.emit(refrepos::CHANGED_EVENT, id);
}

#[tauri::command]
pub async fn reference_repos_list(db: State<'_, Db>) -> Result<Vec<RefRepoView>, String> {
    let (repos, setting, ollama_url) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (
            refrepos::list(&conn).map_err(|e| e.to_string())?,
            crate::db::queries::get_setting(&conn, embed::KEY_EMBED_MODEL).ok().flatten(),
            crate::db::queries::get_setting(&conn, crate::hybrid::config::KEY_URL_OLLAMA)
                .ok()
                .flatten()
                .unwrap_or_else(|| "http://127.0.0.1:11434".to_string()),
        )
    };
    let space = embed::Space::resolve(setting.as_deref(), &ollama_url).await.map(|s| s.name);
    tokio::task::spawn_blocking(move || {
        let index = index::global().ok();
        repos
            .into_iter()
            .map(|repo| {
                let key = crate::knowledge::repo_key(&repo.knowledge_id());
                let status = index.as_ref().and_then(|index| index::status(index, &key, space.as_deref()).ok()).filter(|s| s.files > 0);
                RefRepoView { busy: refrepos::busy_with(&repo.id), cloned: repo.cloned(), index: status, repo }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// The branches of a remote, before adding it — asked with the connected account its URL belongs to.
#[tauri::command]
pub async fn reference_repos_branches(db: State<'_, Db>, url: String) -> Result<RemoteBranches, String> {
    let auth = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        refrepos::auth_for(&conn, &url)
    };
    tokio::task::spawn_blocking(move || refrepos::remote_branches(&url, &auth)).await.map_err(|e| e.to_string())?
}

/// Adds a repository and starts cloning it; the row reports the clone's progress through
/// [`refrepos::CHANGED_EVENT`].
#[tauri::command]
pub fn reference_repo_add(app: AppHandle, db: State<'_, Db>, input: NewRef) -> Result<RefRepo, String> {
    let repo = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let auth = refrepos::auth_for(&conn, &input.url);
        refrepos::insert(&conn, &input, &auth)?
    };
    refrepos::start(&app, &repo.id, Op::Clone);
    changed(&app, &repo.id);
    Ok(repo)
}

#[tauri::command]
pub fn reference_repo_update(app: AppHandle, db: State<'_, Db>, id: String, patch: Patch) -> Result<RefRepo, String> {
    let repo = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        refrepos::update(&conn, &id, &patch)?
    };
    changed(&app, &id);
    Ok(repo)
}

/// Updates the clone — or clones it, when this machine has none yet (a restore).
#[tauri::command]
pub fn reference_repo_pull(app: AppHandle, db: State<'_, Db>, id: String) -> Result<(), String> {
    let cloned = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        refrepos::get(&conn, &id).map_err(|e| e.to_string())?.ok_or("Ese repositorio de referencia ya no existe")?.cloned()
    };
    started(refrepos::start(&app, &id, if cloned { Op::Pull } else { Op::Clone }))
}

#[tauri::command]
pub fn reference_repo_set_branch(app: AppHandle, id: String, branch: String) -> Result<(), String> {
    started(refrepos::start(&app, &id, Op::Branch(branch)))
}

#[tauri::command]
pub fn reference_repo_reindex(app: AppHandle, id: String) -> Result<(), String> {
    started(refrepos::start(&app, &id, Op::Reindex))
}

fn started(ok: bool) -> Result<(), String> {
    if ok { Ok(()) } else { Err("Ese repositorio ya está ocupado: espera a que termine".into()) }
}

/// Removes a repository, its clone and — off this thread — its index.
#[tauri::command]
pub fn reference_repo_remove(app: AppHandle, db: State<'_, Db>, id: String) -> Result<(), String> {
    if refrepos::busy_with(&id).is_some() {
        return Err("Ese repositorio está ocupado: espera a que termine para quitarlo".into());
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        refrepos::remove(&conn, &id)?;
    }
    crate::knowledge::prune_in_background();
    changed(&app, &id);
    Ok(())
}

/// The reference repositories switched on for a workspace — the local view, local-only ones
/// included — for the workspace's summary and for Codi naming one.
#[tauri::command]
pub fn reference_repos_for_workspace(db: State<'_, Db>, workspace_id: String) -> Result<Vec<RefRepo>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(refrepos::list(&conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| r.applies_to(&workspace_id))
        .collect())
}
