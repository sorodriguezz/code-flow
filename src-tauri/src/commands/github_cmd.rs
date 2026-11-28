use tauri::State;

use crate::db::{queries, Db};
use crate::github;
use crate::secrets;

/// Manually links a project to a specific `host/owner/repo` — the fallback for when
/// auto-detection from the git remote didn't resolve it (a repo with no GitHub remote, or an
/// unusual URL). `github_host` is "github.com" or a GitHub Enterprise hostname.
#[tauri::command]
pub fn link_project_github(
    db: State<Db>,
    id: String,
    github_owner: String,
    github_repo: String,
    github_host: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::link_project_github(&conn, &id, &github_owner, &github_repo, &github_host).map_err(|e| e.to_string())
}

/// Validates a candidate or saved GitHub token and returns its login.
#[tauri::command]
pub async fn github_authenticated_user(host: String, candidate: Option<String>) -> Result<String, String> {
    let token = match candidate {
        Some(token) => token,
        None => secrets::get_secret(&secrets::github_token_key(&host))?
            .ok_or_else(|| "No GitHub token saved for this host".to_string())?,
    };
    github::get_authenticated_user(&host, &token).await
}
