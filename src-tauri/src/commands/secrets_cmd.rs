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
