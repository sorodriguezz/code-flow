use crate::git::diff;
use crate::secret_scan::{scan_diff, SecretHit};

/// Scans the repository's staged diff for hardcoded credentials. Returns an empty list when the
/// staged changes look clean. Errors only propagate from opening the repo / reading the diff —
/// the scan itself never fails.
#[tauri::command]
pub fn scan_staged_secrets(repo_path: String) -> Result<Vec<SecretHit>, String> {
    let files = diff::get_staged_diff(&repo_path)?;
    Ok(scan_diff(&files))
}
