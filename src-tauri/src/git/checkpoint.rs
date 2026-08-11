//! Undo for AI runs.
//!
//! Before an AI action that can write to the working tree, the app snapshots that tree into a
//! commit parked under `refs/codeflow/checkpoints/`, so "undo what the agent just did" is a real
//! operation rather than a hope. Two properties drive the design:
//!
//! - **It must not disturb git's own state.** The snapshot is built in an in-memory index, so the
//!   user's staging area is untouched, nothing lands on a branch, and `git status` reads exactly
//!   the same before and after. The refs live outside `refs/heads`, so no branch list shows them.
//! - **Restoring is per file.** Rolling the whole tree back to the snapshot would also discard
//!   whatever the *user* typed while the agent worked. Instead the caller sees which paths differ
//!   and restores those, so a checkpoint is a precise "put these files back" and never a
//!   time machine that eats your own edits.
//!
//! Checkpoints are ordinary git objects: they survive restarts, are inspectable with plain git,
//! and need no table of their own.

use std::collections::HashSet;
use std::path::Path;

use git2::{DiffOptions, Repository};
use serde::{Deserialize, Serialize};

use super::repo::open;

const REF_PREFIX: &str = "refs/codeflow/checkpoints/";

/// How many checkpoints a repo keeps. Snapshots are cheap (git dedupes every unchanged blob), but
/// they're refs that would otherwise pile up forever and keep their objects from ever being
/// collected — and nobody undoes the fortieth-most-recent AI run.
const MAX_CHECKPOINTS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointInfo {
    /// Ref-safe id, also the last segment of the ref name.
    pub id: String,
    /// Which action the checkpoint was taken for — a stable key (`chat`, `fix-finding`, …), not
    /// a sentence: the UI is bilingual, so the wording belongs in the frontend's translations
    /// and only this key crosses the boundary.
    pub kind: String,
    /// Unix seconds.
    pub created_at: i64,
    /// Working-tree paths that differ from the snapshot *right now* — i.e. what restoring would
    /// put back. Empty means the run changed nothing (or its changes were already undone).
    pub changed_paths: Vec<String>,
}

fn checkpoint_ref(id: &str) -> String {
    format!("{REF_PREFIX}{id}")
}

/// Snapshot signature. The repo's own identity when it has one, so `git log` on the checkpoint ref
/// reads sensibly, but a repo with no configured `user.name` must not fail to be protected — hence
/// the fallback.
fn signature(repo: &Repository) -> Result<git2::Signature<'static>, String> {
    match repo.signature() {
        Ok(sig) => Ok(sig.to_owned()),
        Err(_) => git2::Signature::now("CodeFlow", "codeflow@local").map_err(|e| e.message().to_string()),
    }
}

/// Builds an in-memory index holding the current working tree: HEAD's tree as the base, then every
/// path git reports as changed (staged, unstaged or untracked) overwritten with what's on disk.
/// Ignored files are absent, since `statuses` never reports them here.
fn snapshot_tree(repo: &Repository) -> Result<git2::Oid, String> {
    let mut index = git2::Index::new().map_err(|e| e.message().to_string())?;
    // `add_path` reads through the repo's workdir, which an unattached in-memory index doesn't
    // have. Setting it here swaps the index for *this* `Repository` handle only, in memory — the
    // on-disk `.git/index` is never written, so the user's staging area is unaffected.
    repo.set_index(&mut index).map_err(|e| e.message().to_string())?;

    if let Ok(head) = repo.head() {
        if let Ok(tree) = head.peel_to_tree() {
            index.read_tree(&tree).map_err(|e| e.message().to_string())?;
        }
    }

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.message().to_string())?;

    let workdir = repo.workdir().ok_or_else(|| "bare repository".to_string())?.to_path_buf();
    for entry in statuses.iter() {
        let Some(path) = entry.path() else { continue };
        if workdir.join(path).is_file() {
            index.add_path(Path::new(path)).map_err(|e| e.message().to_string())?;
        } else {
            // Deleted (or turned into a directory) — the snapshot must record its absence, or
            // restoring would resurrect a file the user themselves removed.
            let _ = index.remove_path(Path::new(path));
        }
    }

    index.write_tree_to(repo).map_err(|e| e.message().to_string())
}

/// Takes a checkpoint of `path`'s working tree. Returns the new checkpoint's id.
pub fn create(path: &str, kind: &str) -> Result<String, String> {
    let repo = open(path)?;
    let tree_oid = snapshot_tree(&repo)?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;
    let sig = signature(&repo)?;

    // Parented on HEAD when there is one so the checkpoint reads as a commit on top of the
    // current state; a repo with no commits yet gets a parentless one rather than no protection.
    let parents: Vec<git2::Commit> = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .into_iter()
        .collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    let id = format!("{}-{}", chrono::Utc::now().timestamp(), &uuid::Uuid::new_v4().to_string()[..8]);
    repo.commit(Some(&checkpoint_ref(&id)), &sig, &sig, kind, &tree, &parent_refs)
        .map_err(|e| e.message().to_string())?;
    prune(&repo);
    Ok(id)
}

/// Drops the oldest checkpoints past [`MAX_CHECKPOINTS`]. Best-effort: failing to prune is never
/// a reason to fail the snapshot the user is actually protected by.
fn prune(repo: &Repository) {
    let Ok(refs) = repo.references_glob(&format!("{REF_PREFIX}*")) else { return };
    let mut dated: Vec<(i64, String)> = refs
        .flatten()
        .filter_map(|reference| {
            let name = reference.name()?.to_string();
            Some((reference.peel_to_commit().ok()?.time().seconds(), name))
        })
        .collect();
    if dated.len() <= MAX_CHECKPOINTS {
        return;
    }
    dated.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, name) in dated.into_iter().skip(MAX_CHECKPOINTS) {
        if let Ok(mut reference) = repo.find_reference(&name) {
            let _ = reference.delete();
        }
    }
}

fn read_checkpoint<'r>(repo: &'r Repository, id: &str) -> Result<git2::Commit<'r>, String> {
    let reference = repo
        .find_reference(&checkpoint_ref(id))
        .map_err(|_| format!("checkpoint '{id}' no longer exists"))?;
    reference.peel_to_commit().map_err(|e| e.message().to_string())
}

/// Paths whose current on-disk content differs from the checkpoint's — what [`restore`] would
/// touch. Includes files created since (they'd be deleted) and files deleted since (restored).
fn diff_paths(repo: &Repository, commit: &git2::Commit) -> Result<Vec<String>, String> {
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_typechange(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    // Deduplicated through a set rather than `paths.contains(&path)`: a typechange or a
    // rename reports the same path from more than one delta, and the linear scan made this
    // quadratic in the number of changed files — a run that touched a few hundred paths spent
    // more time in `contains` than in the walk itself. The `Vec` is still what's returned, so
    // callers (and the ordering below) are unaffected.
    let mut seen: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::new();
    for delta in diff.deltas() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        if let Some(path) = path {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
    }
    paths.sort();
    Ok(paths)
}

/// The changed paths of a *single* checkpoint, for a caller that wants one row's detail without
/// paying for every other row's working-tree walk.
///
/// Exists because [`list`] computes this for all [`MAX_CHECKPOINTS`] entries eagerly, and each one
/// is a full `diff_tree_to_workdir_with_index` with recursive untracked scanning — up to twenty
/// walks of the whole working tree in a single call. On a large repo that is the slowest thing the
/// checkpoints modal does. Splitting it out lets the frontend fetch the paths per row instead;
/// [`list`] keeps filling `changed_paths` until it does, so nothing is lost in the meantime.
pub fn changed_paths(path: &str, id: &str) -> Result<Vec<String>, String> {
    let repo = open(path)?;
    let commit = read_checkpoint(&repo, id)?;
    diff_paths(&repo, &commit)
}

/// Every checkpoint of this repo, newest first.
///
/// `changed_paths` is filled eagerly for every entry, which costs one full working-tree walk per
/// checkpoint — up to [`MAX_CHECKPOINTS`] of them in one call. That is deliberate *for now*: the
/// modal renders each row's paths inline, with no expand affordance to hang a lazy fetch off, and
/// the count is what the restore confirmation asks about. [`changed_paths`] is the per-row
/// equivalent the UI should move to; until it does, dropping the field here would silently delete
/// what the modal draws.
pub fn list(path: &str) -> Result<Vec<CheckpointInfo>, String> {
    let repo = open(path)?;
    let refs = match repo.references_glob(&format!("{REF_PREFIX}*")) {
        Ok(refs) => refs,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out: Vec<CheckpointInfo> = Vec::new();
    for reference in refs.flatten() {
        let Some(name) = reference.name().and_then(|n| n.strip_prefix(REF_PREFIX)) else { continue };
        let Ok(commit) = reference.peel_to_commit() else { continue };
        let changed_paths = diff_paths(&repo, &commit).unwrap_or_default();
        out.push(CheckpointInfo {
            id: name.to_string(),
            kind: commit.summary().unwrap_or("").to_string(),
            created_at: commit.time().seconds(),
            changed_paths,
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// Restores every path that differs from the checkpoint back to its snapshotted content, and
/// deletes the files that didn't exist then. Returns the paths it touched.
///
/// Writes blobs to the working tree directly instead of `checkout_tree`, so the staging area and
/// HEAD are left exactly as they are — this is an "undo these edits" button, not a `git reset`.
pub fn restore(path: &str, id: &str) -> Result<Vec<String>, String> {
    let repo = open(path)?;
    let commit = read_checkpoint(&repo, id)?;
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let workdir = repo.workdir().ok_or_else(|| "bare repository".to_string())?.to_path_buf();

    let paths = diff_paths(&repo, &commit)?;
    for rel in &paths {
        let target = workdir.join(rel);
        match tree.get_path(Path::new(rel)) {
            Ok(entry) => {
                let blob = repo
                    .find_blob(entry.id())
                    .map_err(|e| format!("{rel}: {}", e.message()))?;
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("{rel}: {e}"))?;
                }
                std::fs::write(&target, blob.content()).map_err(|e| format!("{rel}: {e}"))?;
            }
            // Not in the snapshot: the run created it, so undoing means removing it again.
            Err(_) => {
                let _ = std::fs::remove_file(&target);
            }
        }
    }
    Ok(paths)
}

/// Forgets a checkpoint. Its objects stay in the odb until git's own gc reaps them.
pub fn remove(path: &str, id: &str) -> Result<(), String> {
    let repo = open(path)?;
    if let Ok(mut reference) = repo.find_reference(&checkpoint_ref(id)) {
        reference.delete().map_err(|e| e.message().to_string())?;
    }
    Ok(())
}

/// Deletes a checkpoint only if nothing differs from it — i.e. the run it protected turned out to
/// change no files. Keeps the list free of entries that would restore nothing.
pub fn remove_if_unchanged(path: &str, id: &str) -> Result<bool, String> {
    let repo = open(path)?;
    let commit = read_checkpoint(&repo, id)?;
    if diff_paths(&repo, &commit)?.is_empty() {
        remove(path, id)?;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A repo with one committed file, in a throwaway directory.
    fn fixture() -> (std::path::PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!("cf-checkpoint-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        fs::write(dir.join("tracked.txt"), "original\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("tracked.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = git2::Signature::now("Test", "test@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();
        }
        (dir, repo)
    }

    #[test]
    fn restores_edited_files_and_deletes_the_ones_the_run_created() {
        let (dir, _repo) = fixture();
        let path = dir.to_str().unwrap();

        let id = create(path, "fix-finding").unwrap();

        // What an agent run does: rewrite a tracked file and add a new one.
        fs::write(dir.join("tracked.txt"), "rewritten by the agent\n").unwrap();
        fs::write(dir.join("new.txt"), "created by the agent\n").unwrap();

        let listed = list(path).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, "fix-finding");
        assert_eq!(listed[0].changed_paths, vec!["new.txt", "tracked.txt"]);

        // The per-row command has to answer exactly what the list embeds, or moving the UI onto it
        // would quietly change what the modal shows and what the restore confirmation counts.
        assert_eq!(changed_paths(path, &id).unwrap(), listed[0].changed_paths);

        let restored = restore(path, &id).unwrap();
        assert_eq!(restored, vec!["new.txt", "tracked.txt"]);
        assert_eq!(fs::read_to_string(dir.join("tracked.txt")).unwrap(), "original\n");
        assert!(!dir.join("new.txt").exists());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshots_uncommitted_work_and_leaves_the_index_alone() {
        let (dir, repo) = fixture();
        let path = dir.to_str().unwrap();

        // Uncommitted state at snapshot time: one staged file, one untracked file.
        fs::write(dir.join("staged.txt"), "staged content\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("staged.txt")).unwrap();
            index.write().unwrap();
        }
        fs::write(dir.join("untracked.txt"), "untracked content\n").unwrap();

        let id = create(path, "chat").unwrap();

        // Taking a checkpoint must not stage, unstage or otherwise touch the user's index.
        let staged_after: Vec<String> = repo
            .index()
            .unwrap()
            .iter()
            .map(|e| String::from_utf8_lossy(&e.path).into_owned())
            .collect();
        assert_eq!(staged_after, vec!["staged.txt", "tracked.txt"]);

        // Both uncommitted files are part of the snapshot, so wiping them is undoable.
        fs::remove_file(dir.join("untracked.txt")).unwrap();
        fs::write(dir.join("staged.txt"), "clobbered\n").unwrap();
        restore(path, &id).unwrap();
        assert_eq!(fs::read_to_string(dir.join("untracked.txt")).unwrap(), "untracked content\n");
        assert_eq!(fs::read_to_string(dir.join("staged.txt")).unwrap(), "staged content\n");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_run_that_changed_nothing_drops_its_checkpoint() {
        let (dir, _repo) = fixture();
        let path = dir.to_str().unwrap();

        let id = create(path, "chat").unwrap();
        assert!(remove_if_unchanged(path, &id).unwrap());
        assert!(list(path).unwrap().is_empty());

        fs::remove_dir_all(&dir).ok();
    }
}
