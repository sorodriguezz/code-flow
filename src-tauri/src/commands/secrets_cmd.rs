use crate::secrets;

#[tauri::command]
pub fn set_ado_pat(org: String, pat: String) -> Result<(), String> {
    secrets::set_secret(&secrets::ado_pat_key(&org), &pat)
}

#[tauri::command]
pub fn get_ado_pat(org: String) -> Result<Option<String>, String> {
    secrets::get_secret(&secrets::ado_pat_key(&org))
}

#[tauri::command]
pub fn delete_ado_pat(org: String) -> Result<(), String> {
    secrets::delete_secret(&secrets::ado_pat_key(&org))
}

// GitHub tokens are keyed per host so github.com and one or more GitHub Enterprise Servers can
// be connected side by side.
#[tauri::command]
pub fn set_github_token(host: String, token: String) -> Result<(), String> {
    secrets::set_secret(&secrets::github_token_key(&host), &token)
}

#[tauri::command]
pub fn get_github_token(host: String) -> Result<Option<String>, String> {
    secrets::get_secret(&secrets::github_token_key(&host))
}

#[tauri::command]
pub fn delete_github_token(host: String) -> Result<(), String> {
    secrets::delete_secret(&secrets::github_token_key(&host))
}

// GitLab tokens are keyed per host for the same reason as GitHub's: gitlab.com and one or more
// self-managed instances are a normal thing to be connected to at once, and a personal access
// token is only ever valid against the instance that issued it.
#[tauri::command]
pub fn set_gitlab_token(host: String, token: String) -> Result<(), String> {
    secrets::set_secret(&secrets::gitlab_token_key(&host), &token)
}

#[tauri::command]
pub fn get_gitlab_token(host: String) -> Result<Option<String>, String> {
    secrets::get_secret(&secrets::gitlab_token_key(&host))
}

#[tauri::command]
pub fn delete_gitlab_token(host: String) -> Result<(), String> {
    secrets::delete_secret(&secrets::gitlab_token_key(&host))
}

// AI provider API keys. Deliberately no "get" command: the key is only ever read backend-side when
// building a request, so it never travels to the frontend — Settings just asks whether one is set.
#[tauri::command]
pub fn set_ai_api_key(provider: String, key: String) -> Result<(), String> {
    secrets::set_secret(&secrets::ai_api_key(&provider), &key)
}

#[tauri::command]
pub fn has_ai_api_key(provider: String) -> Result<bool, String> {
    Ok(secrets::get_secret(&secrets::ai_api_key(&provider))?
        .filter(|k| !k.trim().is_empty())
        .is_some())
}

#[tauri::command]
pub fn delete_ai_api_key(provider: String) -> Result<(), String> {
    secrets::delete_secret(&secrets::ai_api_key(&provider))
}
