use tauri::State;

use crate::db::{queries, Db};
use crate::gitlab;
use crate::secrets;

/// Links a project to a GitLab project by its **full path** — the manual fallback for when
/// auto-detection can't recognise the remote (a self-managed instance the user hasn't connected
/// yet, or a repository whose `origin` points somewhere else entirely).
///
/// The path is what GitLab's own API addresses a project by, groups and all, so it is stored
/// exactly as typed rather than split into an owner and a name the way GitHub's is.
#[tauri::command]
pub fn link_project_gitlab(
    db: State<Db>,
    id: String,
    gitlab_project: String,
    gitlab_host: String,
) -> Result<(), String> {
    let path = gitlab_project.trim().trim_matches('/');
    if path.split('/').filter(|s| !s.is_empty()).count() < 2 {
        return Err("A GitLab project path needs at least a group and a project, like acme/widget".to_string());
    }
    let host = gitlab_host.trim().to_ascii_lowercase();
    let host = if host.is_empty() { gitlab::GITLAB_COM.to_string() } else { host };

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // A project holds at most one host's columns, and the dispatcher picks by precedence rather
    // than by "the most recently set" — so re-linking has to clear whatever was there first.
    queries::unlink_project(&conn, &id).map_err(|e| e.to_string())?;
    queries::link_project_gitlab(&conn, &id, path, &host).map_err(|e| e.to_string())
}

/// Validates a candidate or saved GitLab token and returns its username.
#[tauri::command]
pub async fn gitlab_authenticated_user(host: String, candidate: Option<String>) -> Result<String, String> {
    let host = host.trim().to_ascii_lowercase();
    let token = match candidate {
        Some(token) => token,
        None => secrets::get_secret(&secrets::gitlab_token_key(&host))?
            .ok_or_else(|| format!("No GitLab token saved for \"{host}\""))?,
    };
    gitlab::get_authenticated_user(&host, &token).await
}
