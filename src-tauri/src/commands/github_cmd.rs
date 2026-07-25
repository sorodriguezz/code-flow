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

/// Validates the token saved for `host` and returns the login it belongs to — Settings calls
/// this right after saving so a bad token (or wrong Enterprise host) surfaces immediately, and
/// the connected account can be shown, instead of only failing later when PRs are listed.
#[tauri::command]
pub async fn github_authenticated_user(host: String) -> Result<String, String> {
    let token = secrets::get_secret(&secrets::github_token_key(&host))?
        .ok_or_else(|| "No GitHub token saved for this host".to_string())?;
    github::get_authenticated_user(&host, &token).await
}
