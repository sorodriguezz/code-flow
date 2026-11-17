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
    let _write = crate::git::write_lock(&repo_path);
    let restored = checkpoint::restore(&repo_path, &checkpoint_id)?;
    record_revert(&repo_path, &checkpoint_id, &restored);
    Ok(restored)
}

/// An AI change undone is the plainest "that answer was wrong" there is: kept as an experience
/// (`crate::experiences`), pointing at the turn by its checkpoint.
fn record_revert(repo_path: &str, checkpoint_id: &str, paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    crate::experiences::capture_at(
        repo_path,
        crate::experiences::Source::CheckpointRestore,
        crate::experiences::Signal::Reverted,
        Some(format!("checkpoint:{checkpoint_id}")),
        serde_json::json!({ "checkpoint": checkpoint_id, "paths": paths }),
    );
}

#[tauri::command(async)]
pub fn delete_ai_checkpoint(repo_path: String, checkpoint_id: String) -> Result<(), String> {
    let _write = crate::git::write_lock(&repo_path);
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
    pub revision: String,
}

#[tauri::command(async)]
pub fn ai_checkpoint_file(repo_path: String, checkpoint_id: String, path: String) -> Result<TurnFile, String> {
    let before = checkpoint::file_at(&repo_path, &checkpoint_id, &path)?;
    let after = crate::fsops::read_bytes_in_repo(&repo_path, &path)?;
    let revision = checkpoint::file_revision(after.as_deref());
    let text = |bytes: Option<Vec<u8>>| match bytes {
        None => Ok(None),
        Some(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| ()),
    };
    match (text(before), text(after)) {
        (Ok(before), Ok(after)) => Ok(TurnFile { before, after, binary: false, revision }),
        _ => Ok(TurnFile { before: None, after: None, binary: true, revision }),
    }
}

/// One repository's part of a turn, as the workspace chat's review lists it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPart {
    pub repo_path: String,
    pub checkpoint_id: String,
    pub paths: Vec<String>,
}

/// «Deshacer el turno»: every file a workspace-chat turn changed, in every repository, put back as
/// it was before the turn — one action where there used to be one per repository.
///
/// All or nothing as far as it can be: every repository's write lock is taken and every checkpoint
/// is read for every file **before** any file is written, so a rotated restore point (or an
/// unreadable file) in the third repository refuses the whole undo instead of leaving the first
/// two reverted. Like the review's «Descartar todo», it reverts what was written after the turn in
/// those files as well — which is why the panel asks first.
#[tauri::command(async)]
pub fn restore_ai_turn(parts: Vec<TurnPart>) -> Result<Vec<String>, String> {
    let guards = crate::git::write_locks(parts.iter().map(|part| part.repo_path.as_str()));
    let mut prepared: Vec<(&TurnPart, Vec<checkpoint::ReviewedEdit>)> = Vec::new();
    for part in &parts {
        let mut edits = Vec::new();
        for rel in &part.paths {
            // Read now so a missing checkpoint fails here, before anything is written anywhere.
            checkpoint::file_at(&part.repo_path, &part.checkpoint_id, rel)?;
            let current = crate::fsops::read_bytes_in_repo(&part.repo_path, rel)?;
            edits.push(checkpoint::ReviewedEdit {
                path: rel.clone(),
                expected_revision: checkpoint::file_revision(current.as_deref()),
                content: None,
            });
        }
        prepared.push((part, edits));
    }
    let mut restored = Vec::new();
    for (part, edits) in prepared {
        let done = checkpoint::restore_reviewed(&part.repo_path, &part.checkpoint_id, &edits)?;
        record_revert(&part.repo_path, &part.checkpoint_id, &done);
        restored.extend(done.into_iter().map(|path| format!("{}/{path}", part.repo_path.trim_end_matches('/'))));
    }
    drop(guards);
    Ok(restored)
}

/// Puts the named files back as the checkpoint has them — "discard" on a file of the per-turn
/// review. Sync, like [`restore_ai_checkpoint`]: a write.
#[tauri::command(async)]
pub fn restore_ai_checkpoint_paths(repo_path: String, checkpoint_id: String, edits: Vec<checkpoint::ReviewedEdit>) -> Result<Vec<String>, String> {
    let _write = crate::git::write_lock(&repo_path);
    let restored = checkpoint::restore_reviewed(&repo_path, &checkpoint_id, &edits)?;
    record_revert(&repo_path, &checkpoint_id, &restored);
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo_with(file: &str, text: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-turn-undo-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        fs::write(dir.join(file), text).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new(file)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        dir
    }

    /// Two repositories changed by one turn come back together; a missing restore point in either
    /// refuses the undo before anything is written.
    #[test]
    fn a_turn_is_undone_in_every_repository_or_in_none() {
        let a = repo_with("a.txt", "before a\n");
        let b = repo_with("b.txt", "before b\n");
        let (pa, pb) = (a.to_str().unwrap().to_string(), b.to_str().unwrap().to_string());
        let ca = checkpoint::create(&pa, "chat").unwrap();
        let cb = checkpoint::create(&pb, "chat").unwrap();
        fs::write(a.join("a.txt"), "after a\n").unwrap();
        fs::write(b.join("b.txt"), "after b\n").unwrap();

        let broken = vec![
            TurnPart { repo_path: pa.clone(), checkpoint_id: ca.clone(), paths: vec!["a.txt".into()] },
            TurnPart { repo_path: pb.clone(), checkpoint_id: "gone".into(), paths: vec!["b.txt".into()] },
        ];
        assert!(restore_ai_turn(broken).is_err());
        assert_eq!(fs::read_to_string(a.join("a.txt")).unwrap(), "after a\n", "nothing was written");

        let parts = vec![
            TurnPart { repo_path: pa.clone(), checkpoint_id: ca, paths: vec!["a.txt".into()] },
            TurnPart { repo_path: pb.clone(), checkpoint_id: cb, paths: vec!["b.txt".into()] },
        ];
        assert_eq!(restore_ai_turn(parts).unwrap().len(), 2);
        assert_eq!(fs::read_to_string(a.join("a.txt")).unwrap(), "before a\n");
        assert_eq!(fs::read_to_string(b.join("b.txt")).unwrap(), "before b\n");
        let _ = (fs::remove_dir_all(&a), fs::remove_dir_all(&b));
    }

    /// Two paths on one stripe are locked once, not twice (which would wait forever).
    #[test]
    fn several_write_locks_never_take_one_stripe_twice() {
        let guards = crate::git::write_locks(["/x/repo", "/x/repo/", "/X/REPO"]);
        assert_eq!(guards.len(), 1);
    }
}
