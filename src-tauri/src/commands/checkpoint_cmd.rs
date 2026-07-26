//! Commands for the AI-run checkpoints — the "undo what the agent did" surface. Creation is
//! automatic (see `claude_cmd::checkpoint_before`); these three are what the UI needs to show the
//! list, put files back, and forget an entry.

use crate::git::checkpoint;

#[tauri::command]
pub fn list_ai_checkpoints(repo_path: String) -> Result<Vec<checkpoint::CheckpointInfo>, String> {
    checkpoint::list(&repo_path)
}

/// Puts every file that differs from the checkpoint back to its snapshotted content. Returns the
/// paths it touched, so the UI can report what it undid instead of a bare "done".
#[tauri::command]
pub fn restore_ai_checkpoint(repo_path: String, checkpoint_id: String) -> Result<Vec<String>, String> {
    checkpoint::restore(&repo_path, &checkpoint_id)
}

#[tauri::command]
pub fn delete_ai_checkpoint(repo_path: String, checkpoint_id: String) -> Result<(), String> {
    checkpoint::remove(&repo_path, &checkpoint_id)
}
