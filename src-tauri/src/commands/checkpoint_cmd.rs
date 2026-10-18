//! Commands for the AI-run checkpoints — the "undo what the agent did" surface. Creation is
//! automatic (see `claude_cmd::checkpoint_before`); these are what the UI needs to show the
//! list, see what one entry would put back, put files back, and forget an entry.

use crate::git::checkpoint;

/// `(async)` because this is a *read*, and an expensive one: it walks the working tree once per
/// checkpoint, up to twenty times. Left on the UI thread it was a visible freeze every time the
/// checkpoints modal opened on a large repo. The same rule `git_ops` follows — reads run off the
/// main thread, writes stay on it as an implicit lock over the index — so `restore` and `delete`
/// below deliberately do not get it.
///
/// The modal already draws a spinner until this resolves, so nothing about the UX changes.
#[tauri::command(async)]
pub fn list_ai_checkpoints(repo_path: String) -> Result<Vec<checkpoint::CheckpointInfo>, String> {
    checkpoint::list(&repo_path)
}

/// The paths one checkpoint would put back — the per-row half of [`list_ai_checkpoints`].
///
/// Same data, one row's worth: `list_ai_checkpoints` computes this for every checkpoint eagerly,
/// which is where its cost lives. A UI that fetches paths for the row the user actually looked at
/// pays one working-tree walk instead of twenty. A read, so `(async)` for the same reason as above.
#[tauri::command(async)]
pub fn ai_checkpoint_changed_paths(repo_path: String, checkpoint_id: String) -> Result<Vec<String>, String> {
    checkpoint::changed_paths(&repo_path, &checkpoint_id)
}

/// Puts every file that differs from the checkpoint back to its snapshotted content. Returns the
/// paths it touched, so the UI can report what it undid instead of a bare "done".
#[tauri::command(async)]
pub fn restore_ai_checkpoint(repo_path: String, checkpoint_id: String) -> Result<Vec<String>, String> {
    let _write = crate::git::write_lock();
    checkpoint::restore(&repo_path, &checkpoint_id)
}

#[tauri::command(async)]
pub fn delete_ai_checkpoint(repo_path: String, checkpoint_id: String) -> Result<(), String> {
    let _write = crate::git::write_lock();
    checkpoint::remove(&repo_path, &checkpoint_id)
}

/// One file of a turn, before and now: the checkpoint's copy and the one on disk, as text — for the
/// chat's per-turn review. `binary` when either side is not UTF-8 text (the review then offers the
/// whole file back, not its hunks).
#[derive(serde::Serialize)]
pub struct TurnFile {
    pub before: Option<String>,
    pub after: Option<String>,
    pub binary: bool,
}

#[tauri::command(async)]
pub fn ai_checkpoint_file(repo_path: String, checkpoint_id: String, path: String) -> Result<TurnFile, String> {
    let before = checkpoint::file_at(&repo_path, &checkpoint_id, &path)?;
    let after = crate::fsops::read_bytes_in_repo(&repo_path, &path)?;
    let text = |bytes: Option<Vec<u8>>| match bytes {
        None => Ok(None),
        Some(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| ()),
    };
    match (text(before), text(after)) {
        (Ok(before), Ok(after)) => Ok(TurnFile { before, after, binary: false }),
        _ => Ok(TurnFile { before: None, after: None, binary: true }),
    }
}

/// Puts the named files back as the checkpoint has them — "discard" on a file of the per-turn
/// review. Sync, like [`restore_ai_checkpoint`]: a write.
#[tauri::command(async)]
pub fn restore_ai_checkpoint_paths(repo_path: String, checkpoint_id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    let _write = crate::git::write_lock();
    checkpoint::restore_paths(&repo_path, &checkpoint_id, &paths)
}
