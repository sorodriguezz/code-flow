use tauri::State;

use crate::bitbucket::{self, BitbucketAuth, CredentialCheck};
use crate::db::{queries, Db};
use crate::secrets;

/// Links a project to a Bitbucket repository by workspace and slug — the manual fallback for a
/// repository whose remote isn't on bitbucket.org (a mirror, an `origin` pointing elsewhere).
///
/// Accepts the pair as typed, or a pasted `workspace/repo`, and stores both lower-case: that is how
/// Bitbucket issues slugs, and the credential is keyed by the lower-case workspace.
#[tauri::command]
pub fn link_project_bitbucket(
    db: State<Db>,
    id: String,
    workspace: String,
    repo: String,
) -> Result<(), String> {
    let workspace = bitbucket::normalize_workspace(&workspace);
    let repo = repo.trim().trim_matches('/').trim_end_matches(".git").to_ascii_lowercase();
    if workspace.is_empty() || repo.is_empty() || workspace.contains('/') || repo.contains('/') {
        return Err("A Bitbucket repository is a workspace and a repository slug, like example-workspace and example-repo".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // A project holds at most one host's columns and the dispatcher picks by precedence, so
    // re-linking clears whatever was there first — the same rule `link_project_gitlab` follows.
    queries::unlink_project(&conn, &id).map_err(|e| e.to_string())?;
    queries::link_project_bitbucket(&conn, &id, &workspace, &repo).map_err(|e| e.to_string())
}

/// Checks a credential against a workspace **before** it is saved, and reports who it is and which
/// scopes it is missing — see `bitbucket::verify_credential`. Nothing is stored here: saving first
/// would let a bad token overwrite a good one.
#[tauri::command]
pub async fn bitbucket_verify_credential(workspace: String, credential: BitbucketAuth) -> Result<CredentialCheck, String> {
    bitbucket::verify_credential(&workspace, &credential.trimmed()).await
}

/// The same check for a workspace whose credential is already saved — "is this connection still
/// good, and can it do everything?" without pasting the token again. API tokens expire within a
/// year, and scopes can't be edited after creation, so a row that worked can stop working.
#[tauri::command]
pub async fn bitbucket_check_workspace(workspace: String) -> Result<CredentialCheck, String> {
    let auth = crate::commands::ado_cmd::bitbucket_auth(&bitbucket::normalize_workspace(&workspace))?;
    bitbucket::verify_credential(&workspace, &auth).await
}

/// Stores a workspace's credential in the keychain.
///
/// Write and delete only — there is deliberately no getter, for the reason `set_jira_token` gives:
/// every Bitbucket call is made from Rust, so handing the token back would only put a plaintext
/// credential inside the webview.
#[tauri::command]
pub fn set_bitbucket_credential(workspace: String, credential: BitbucketAuth) -> Result<(), String> {
    let workspace = bitbucket::normalize_workspace(&workspace);
    let credential = credential.trimmed();
    if workspace.is_empty() || !credential.is_complete() {
        return Err("A Bitbucket connection needs a workspace and a complete credential".to_string());
    }
    secrets::set_secret(&secrets::bitbucket_token_key(&workspace), &credential.to_secret())
}

#[tauri::command]
pub fn delete_bitbucket_credential(workspace: String) -> Result<(), String> {
    secrets::delete_secret(&secrets::bitbucket_token_key(&bitbucket::normalize_workspace(&workspace)))
}
