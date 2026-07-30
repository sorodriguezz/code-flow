use git2::{BranchType, ConfigLevel, ErrorCode, ObjectType, Repository};
use serde::{Deserialize, Serialize};

use super::repo::open;

/// Marks the one checkout failure the UI can offer a way out of: uncommitted work that the
/// switch would clobber. The frontend keys off this prefix to propose stashing instead of
/// dead-ending on the error — sniffing libgit2's English text ("N conflicts prevent
/// checkout") would break on its singular form and on any upstream rewording.
pub const CHECKOUT_CONFLICT_PREFIX: &str = "CHECKOUT_CONFLICT: ";

fn checkout_error(e: git2::Error) -> String {
    if e.code() == ErrorCode::Conflict {
        format!("{}{}", CHECKOUT_CONFLICT_PREFIX, e.message())
    } else {
        e.message().to_string()
    }
}

/// Marks a refusal that came from a locked local branch rather than from git itself. The frontend
/// keys off this prefix to say "this branch is locked" instead of surfacing a bare error — same
/// contract as `CHECKOUT_CONFLICT_PREFIX` above.
pub const BRANCH_LOCKED_PREFIX: &str = "BRANCH_LOCKED: ";

/// A branch lock lives in the repository's own config, alongside the `branch.<name>.remote` and
/// `.merge` entries git keeps there itself. That, rather than a row in codeflow.db, because it
/// means the guards below can run inside the git layer — where a repo path is all that's known,
/// with no project id to look a lock up by — and because the lock then survives a wiped database
/// and follows the repo into any other workspace it's added to.
///
/// libgit2 splits a config key on its first and last dot, so the branch name lands in the
/// (case-sensitive) subsection intact even when it contains dots or slashes: `feature/a.b`
/// becomes section `branch`, subsection `feature/a.b`, name `codeflowlocked`.
fn lock_key(branch: &str) -> String {
    format!("branch.{branch}.codeflowLocked")
}

fn read_lock(config: &git2::Config, branch: &str) -> bool {
    config.get_bool(&lock_key(branch)).unwrap_or(false)
}

/// Writes the lock entry without checking that the branch exists — `delete_branch` needs to clear
/// a lock for a branch that has just stopped existing.
fn write_lock(repo: &Repository, branch: &str, locked: bool) -> Result<(), String> {
    // Write to the repository's own config explicitly — the multi-level config a repo hands back
    // would otherwise be free to land this in ~/.gitconfig, where it would leak across repos.
    let mut config = repo
        .config()
        .and_then(|c| c.open_level(ConfigLevel::Local))
        .map_err(|e| e.message().to_string())?;

    if locked {
        config.set_bool(&lock_key(branch), true).map_err(|e| e.message().to_string())?;
    } else if let Err(e) = config.remove(&lock_key(branch)) {
        // Unlocking something that was never locked is the requested end state, not a failure.
        if e.code() != ErrorCode::NotFound {
            return Err(e.message().to_string());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub target: Option<String>,
    /// Locked by the user to keep merges and pushes off it. Always false for remote-tracking
    /// branches — the lock is a local guard rail, not a server-side protected branch.
    pub is_locked: bool,
}

pub fn list_branches(path: &str) -> Result<Vec<BranchInfo>, String> {
    let repo = open(path)?;
    let mut result = Vec::new();
    let config = repo.config().map_err(|e| e.message().to_string())?;

    let branches = repo.branches(None).map_err(|e| e.message().to_string())?;
    for item in branches {
        let (branch, kind) = item.map_err(|e| e.message().to_string())?;
        let Some(name) = branch.name().map_err(|e| e.message().to_string())?.map(|s| s.to_string()) else {
            continue;
        };

        let is_remote = kind == BranchType::Remote;
        let target = branch.get().target().map(|oid| oid.to_string());

        let (mut ahead, mut behind) = (0, 0);
        let mut upstream = None;
        if !is_remote {
            if let Ok(up) = branch.upstream() {
                upstream = up.name().ok().flatten().map(|s| s.to_string());
                if let (Some(local_oid), Some(up_oid)) = (branch.get().target(), up.get().target()) {
                    if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, up_oid) {
                        ahead = a;
                        behind = b;
                    }
                }
            }
        }

        result.push(BranchInfo {
            is_locked: !is_remote && read_lock(&config, &name),
            name,
            is_head: branch.is_head(),
            is_remote,
            upstream,
            ahead,
            behind,
            target,
        });
    }

    Ok(result)
}

/// Locks or unlocks a local branch. Unlocking drops the config entry rather than writing `false`,
/// so an unlocked branch leaves nothing behind in `.git/config`.
pub fn set_branch_locked(path: &str, name: &str, locked: bool) -> Result<(), String> {
    let repo = open(path)?;
    // Refuse a name that isn't a local branch: the key would sit in the config forever with
    // nothing to apply to, and `list_branches` would never surface it again.
    repo.find_branch(name, BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    write_lock(&repo, name, locked)
}

/// The checked-out branch's name if it's locked. `None` on a detached HEAD or an unborn branch —
/// there's no branch there to protect.
pub fn locked_head_branch(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let name = head.shorthand()?;
    let config = repo.config().ok()?;
    read_lock(&config, name).then(|| name.to_string())
}

/// Gate for anything that would move or publish the current branch. Lives here, in the git layer,
/// so every route to a merge or a push goes through it — a disabled button in the sidebar only
/// covers the one the user can see.
pub fn guard_head_unlocked(repo: &Repository) -> Result<(), String> {
    match locked_head_branch(repo) {
        Some(name) => Err(format!("{BRANCH_LOCKED_PREFIX}{name}")),
        None => Ok(()),
    }
}

/// Same guard for the callers that only hold a path (the async remote operations).
pub fn guard_head_unlocked_at(path: &str) -> Result<(), String> {
    guard_head_unlocked(&open(path)?)
}

pub fn create_branch(path: &str, name: &str, start_point: Option<String>) -> Result<(), String> {
    let repo = open(path)?;
    let target = match start_point {
        Some(refname) => repo
            .revparse_single(&refname)
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?,
        None => repo
            .head()
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?,
    };
    repo.branch(name, &target, false).map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn delete_branch(path: &str, name: &str, is_remote: bool) -> Result<(), String> {
    let repo = open(path)?;
    let kind = if is_remote { BranchType::Remote } else { BranchType::Local };
    let mut branch = repo
        .find_branch(name, kind)
        .map_err(|e| e.message().to_string())?;
    branch.delete().map_err(|e| e.message().to_string())?;
    // Take any lock down with the branch, so re-creating the name later doesn't come back locked
    // by a config entry nothing on screen accounts for.
    if !is_remote {
        write_lock(&repo, name, false)?;
    }
    Ok(())
}

/// Checks out an existing local branch (fast-forward-free "switch").
pub fn checkout_local_branch(path: &str, name: &str) -> Result<(), String> {
    let repo = open(path)?;
    let branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    let refname = branch
        .get()
        .name()
        .ok_or("branch has no ref name")?
        .to_string();

    let object = repo
        .revparse_single(&refname)
        .map_err(|e| e.message().to_string())?;
    repo.checkout_tree(&object, None).map_err(checkout_error)?;
    repo.set_head(&refname).map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Detached checkout at any ref/commit (local branch, remote branch, tag, or raw SHA) —
/// mirrors `git checkout --detach <ref>`, never moves a branch pointer.
pub fn checkout_detached(path: &str, refname: &str) -> Result<(), String> {
    let repo = open(path)?;
    let object = repo
        .revparse_single(refname)
        .map_err(|e| e.message().to_string())?;
    let commit = object.peel(ObjectType::Commit).map_err(|e| e.message().to_string())?;
    repo.checkout_tree(&commit, None).map_err(checkout_error)?;
    repo.set_head_detached(commit.id()).map_err(|e| e.message().to_string())?;
    Ok(())
}

/// "Connect" to a remote branch like VS Code does: creates a local branch tracking it
/// (or reuses one that already exists) and switches to it. Returns the local branch name.
pub fn checkout_remote_tracking(path: &str, remote_branch: &str) -> Result<String, String> {
    let (_remote_name, short_name) = remote_branch
        .split_once('/')
        .ok_or("expected a name like 'origin/feature-x'")?;

    let already_local = {
        let repo = open(path)?;
        let found = repo.find_branch(short_name, BranchType::Local).is_ok();
        found
    };

    if !already_local {
        let repo = open(path)?;
        let remote_ref = repo
            .find_branch(remote_branch, BranchType::Remote)
            .map_err(|e| e.message().to_string())?;
        let commit = remote_ref
            .get()
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?;
        let mut local_branch = repo
            .branch(short_name, &commit, false)
            .map_err(|e| e.message().to_string())?;
        local_branch
            .set_upstream(Some(remote_branch))
            .map_err(|e| e.message().to_string())?;
    }

    checkout_local_branch(path, short_name)?;
    Ok(short_name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    /// A repo on `base` with one committed file, plus a `feature` branch that changed it —
    /// so switching between them touches the same path and can conflict with local edits.
    fn fixture() -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("cf-branch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        // Keep checked-out content byte-identical to what was committed, whatever
        // core.autocrlf the machine running the tests happens to have set globally.
        config.set_bool("core.autocrlf", false).unwrap();

        let commit = |content: &str, message: &str| {
            fs::write(dir.join("a.txt"), content).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = repo.signature().unwrap();
            let parents = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            let parents: Vec<_> = parents.iter().collect();
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap();
        };

        commit("one\n", "initial");
        let base = repo.head().unwrap().shorthand().unwrap().to_string();
        let path = dir.to_str().unwrap();

        create_branch(path, "feature", None).unwrap();
        checkout_local_branch(path, "feature").unwrap();
        commit("feature\n", "feature edit");
        checkout_local_branch(path, &base).unwrap();

        (dir, base)
    }

    /// Detaching has to do three things at once — move the working tree, leave HEAD unattached, and
    /// leave no branch claiming to be head — and the sidebar/graph read all three back. Pinned
    /// together because a detach that only did two of them looked, on screen, like nothing happened.
    #[test]
    fn detaching_moves_the_tree_and_leaves_head_unattached() {
        let (dir, base) = fixture();
        let path = dir.to_str().unwrap();

        checkout_detached(path, "feature").unwrap();

        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "feature\n");
        let repo = git2::Repository::open(path).unwrap();
        assert!(repo.head_detached().unwrap());
        // Nothing shows as modified: the index moved with the tree.
        assert_eq!(repo.statuses(None).unwrap().len(), 0);
        drop(repo);

        let listed = list_branches(path).unwrap();
        assert!(listed.iter().all(|b| !b.is_head), "no branch is head while detached");
        // `get_status` is what tells the UI where the detached HEAD landed.
        let status = super::super::repo::get_status(path).unwrap();
        assert!(status.is_detached);
        assert_eq!(status.current_branch, None);
        assert!(status.head_oid.is_some());

        // And re-attaching to a branch puts everything back.
        checkout_local_branch(path, &base).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        let status = super::super::repo::get_status(path).unwrap();
        assert!(!status.is_detached);
        assert_eq!(status.current_branch.as_deref(), Some(base.as_str()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_lock_blocks_merging_into_the_locked_branch_but_not_out_of_it() {
        let (dir, base) = fixture();
        let path = dir.to_str().unwrap();

        set_branch_locked(path, &base, true).unwrap();
        assert!(list_branches(path)
            .unwrap()
            .iter()
            .any(|b| b.name == base && b.is_locked));

        // On the locked branch: merging anything in is refused, and tagged for the UI.
        let err = super::super::merge::merge_branch(path, "feature").unwrap_err();
        assert!(err.starts_with(BRANCH_LOCKED_PREFIX), "unexpected error: {err}");

        // From an unlocked branch, merging *from* the locked one is fine — it doesn't move it.
        checkout_local_branch(path, "feature").unwrap();
        super::super::merge::merge_branch(path, &base).unwrap();

        // Unlocking clears the entry rather than storing `false`.
        set_branch_locked(path, &base, false).unwrap();
        assert!(list_branches(path).unwrap().iter().all(|b| !b.is_locked));
        checkout_local_branch(path, &base).unwrap();
        super::super::merge::merge_branch(path, "feature").unwrap();

        fs::remove_dir_all(&dir).ok();
    }

    /// Branch names carrying slashes and dots are exactly where a config key built by string
    /// formatting goes wrong, so the round-trip is pinned on one.
    #[test]
    fn a_lock_survives_a_branch_name_with_dots_and_slashes() {
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        let name = "release/1.2.x";

        create_branch(path, name, None).unwrap();
        set_branch_locked(path, name, true).unwrap();
        assert!(list_branches(path).unwrap().iter().any(|b| b.name == name && b.is_locked));

        // Deleting the branch takes its lock with it, so re-creating the name comes back unlocked.
        delete_branch(path, name, false).unwrap();
        create_branch(path, name, None).unwrap();
        assert!(list_branches(path).unwrap().iter().any(|b| b.name == name && !b.is_locked));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkout_blocked_by_local_changes_is_tagged_for_the_ui() {
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();

        fs::write(dir.join("a.txt"), "uncommitted work\n").unwrap();
        let err = checkout_local_branch(path, "feature").unwrap_err();

        // The frontend keys off this prefix to offer stashing instead of just reporting
        // the failure — if libgit2 ever stops reporting a conflict code here, that
        // recovery path silently disappears, so pin it.
        assert!(err.starts_with(CHECKOUT_CONFLICT_PREFIX), "unexpected error: {err}");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stashing_the_local_changes_unblocks_the_same_checkout() {
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();

        fs::write(dir.join("a.txt"), "uncommitted work\n").unwrap();
        assert!(checkout_local_branch(path, "feature").is_err());

        super::super::stash::stash_save(path, Some("auto stash".into()), true).unwrap();
        checkout_local_branch(path, "feature").unwrap();

        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "feature\n");
        assert_eq!(super::super::stash::list_stashes(path).unwrap().len(), 1);

        fs::remove_dir_all(&dir).ok();
    }
}
