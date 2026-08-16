use git2::{BranchType, ConfigLevel, ErrorCode, ObjectType, Repository};
use serde::{Deserialize, Serialize};

use super::lock_rules;
use super::repo::{open, unborn_head_branch};

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

/// The branch's own entry, if it has one. Three states, not two:
///
/// * absent — the branch has never been decided on, so [`lock_rules`] answers for it;
/// * `true`  — locked here, whatever the rules say;
/// * `false` — deliberately *unlocked* here, whatever the rules say.
///
/// The third state is what keeps the global list from being a cage: a rule covering `release/*`
/// still leaves you able to open the one release branch you're actually cutting today, without
/// editing a setting that applies to every repository you own.
fn read_override(config: &git2::Config, branch: &str) -> Option<bool> {
    config.get_bool(&lock_key(branch)).ok()
}

/// Whether the branch is locked right now, and whether it's the rule list saying so rather than
/// an entry in this repository. The second half is only for the UI — a padlock that can say
/// "this one comes from your settings" is the difference between a lock you understand and a lock
/// that appeared on its own.
fn resolve_lock(config: &git2::Config, branch: &str) -> (bool, bool) {
    match read_override(config, branch) {
        Some(explicit) => (explicit, false),
        None => {
            let by_rule = lock_rules::matches(branch);
            (by_rule, by_rule)
        }
    }
}

/// Writes the branch's own entry without checking that the branch exists — `delete_branch` needs
/// to clear one for a branch that has just stopped existing.
///
/// `Some(v)` pins the branch at `v`; `None` drops the entry so the rules answer for it again.
fn write_override(repo: &Repository, branch: &str, value: Option<bool>) -> Result<(), String> {
    // Write to the repository's own config explicitly — the multi-level config a repo hands back
    // would otherwise be free to land this in ~/.gitconfig, where it would leak across repos.
    let mut config = repo
        .config()
        .and_then(|c| c.open_level(ConfigLevel::Local))
        .map_err(|e| e.message().to_string())?;

    match value {
        Some(v) => config.set_bool(&lock_key(branch), v).map_err(|e| e.message().to_string())?,
        None => {
            if let Err(e) = config.remove(&lock_key(branch)) {
                // Clearing something that was never written is the requested end state, not a
                // failure.
                if e.code() != ErrorCode::NotFound {
                    return Err(e.message().to_string());
                }
            }
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
    /// Tip commit time, Unix seconds UTC — what "newest branch" means, and what the sidebar orders on.
    /// `None` only when the ref cannot be peeled to a commit (symbolic or broken); every ordinary
    /// branch, local or remote, has one.
    pub tip_time: Option<i64>,
    /// Locked to keep merges and pushes off it, by whichever of the two routes got there first:
    /// this branch's own padlock, or the app-wide rule list. Always false for remote-tracking
    /// branches — the lock is a local guard rail, not a server-side protected branch.
    pub is_locked: bool,
    /// True only when `is_locked` comes from the rule list rather than from a padlock clicked on
    /// this branch. Lets the UI say where a lock came from, and offer "stop locking every branch
    /// like this one" next to "unlock just this one".
    pub locked_by_rule: bool,
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
        // One ODB read of the tip commit per ref — cheaper than what this loop already pays for
        // `graph_ahead_behind` below, and it is what the sort at the end orders on. Remote-tracking
        // refs peel identically, so they get it for free.
        let tip_time = branch.get().peel_to_commit().ok().map(|c| c.time().seconds());

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

        let (is_locked, locked_by_rule) = if is_remote {
            (false, false)
        } else {
            resolve_lock(&config, &name)
        };

        result.push(BranchInfo {
            is_locked,
            locked_by_rule,
            name,
            is_head: branch.is_head(),
            is_remote,
            upstream,
            ahead,
            behind,
            target,
            tip_time,
        });
    }

    // The branch HEAD is on before the first commit exists.
    //
    // The loop above cannot produce it: `repo.branches()` iterates `refs/heads/`, and until
    // something is committed there is no ref there to iterate — which is why `git branch` prints
    // nothing in a fresh repository either.
    //
    // Listed anyway, because this sidebar is not `git branch`. It sits under a status bar that
    // names that branch, and a list that omits the one branch you are on — and are about to make
    // the first commit to — reads as a bug rather than as fidelity to the CLI. The asymmetry the
    // CLI lives with is one a GUI has no reason to inherit.
    //
    // Nothing downstream needs a special case: merge and delete are already hidden on the head row,
    // and `target: None` is the existing marker for "this ref has no commit to act on".
    if repo.head().is_err() {
        if let Some(name) = unborn_head_branch(&repo) {
            let (is_locked, locked_by_rule) = resolve_lock(&config, &name);
            result.push(BranchInfo {
                is_locked,
                locked_by_rule,
                name,
                is_head: true,
                is_remote: false,
                // No commit, so: nothing to track, nothing to be ahead or behind of, and no tip to
                // date the row by. `tip_time: None` sorts last, but `is_head` sorts first and wins.
                upstream: None,
                ahead: 0,
                behind: 0,
                target: None,
                tip_time: None,
            });
        }
    }

    // Newest first, so a capped list in the sidebar shows the branches actually in play rather than
    // whichever ten libgit2's ref iterator happened to yield first.
    //
    // HEAD is pinned ahead of the date, and that is not cosmetic: it is the one row the sidebar draws
    // in the accent colour, the answer to "which branch am I on", and a fifty-branch repository must
    // not be able to hide it behind a "show more". A `None` tip time sorts last and then by name, so a
    // ref that cannot be peeled at least has a fixed place instead of moving between calls.
    //
    // One global sort even though the vec interleaves locals and remotes: the callers that split them
    // filter, which preserves relative order on both sides.
    result.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then(b.tip_time.cmp(&a.tip_time))
            .then(a.name.cmp(&b.name))
    });

    Ok(result)
}

/// Locks or unlocks one local branch, overriding whatever the rule list says about it.
///
/// Asking for the state the rules already produce drops the entry instead of writing it, so the
/// branch goes back to following the list: unlocking a `release/*` branch that nothing else covers
/// leaves nothing behind in `.git/config`, and re-locking a rule-locked `main` doesn't pin it
/// against a rule the user might later remove.
pub fn set_branch_locked(path: &str, name: &str, locked: bool) -> Result<(), String> {
    let repo = open(path)?;
    // Refuse a name that isn't a local branch: the key would sit in the config forever with
    // nothing to apply to, and `list_branches` would never surface it again.
    repo.find_branch(name, BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    let value = if locked == lock_rules::matches(name) { None } else { Some(locked) };
    write_override(&repo, name, value)
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
    resolve_lock(&config, name).0.then(|| name.to_string())
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
    // Take the branch's own entry down with it, so re-creating the name later doesn't come back
    // pinned by a config entry nothing on screen accounts for. A rule still applies to the
    // re-created branch, which is the point of a rule — that isn't leftover state.
    if !is_remote {
        write_override(&repo, name, None)?;
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
        // `base` is whatever `git init` called it — `main` or `master`, both of which the shipped
        // rules cover. Pin an empty list so this test is about the padlock alone; the rules get
        // their own tests below.
        let _pinned = lock_rules::pin_for_test(&[]);
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
        let _pinned = lock_rules::pin_for_test(&[]);
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

    /// The app-wide list locks branches nobody has ever clicked a padlock on, in a repository that
    /// has never been opened before — which is the entire point of it existing.
    #[test]
    fn a_rule_locks_a_branch_with_no_entry_of_its_own() {
        let _pinned = lock_rules::pin_for_test(&["develop", "release/*"]);
        let (dir, base) = fixture();
        let path = dir.to_str().unwrap();

        create_branch(path, "develop", None).unwrap();
        create_branch(path, "release/1.2", None).unwrap();

        let listed = list_branches(path).unwrap();
        let of = |n: &str| listed.iter().find(|b| b.name == n).unwrap().clone();
        // Locked, and reported as the rules' doing so the UI can say so.
        assert!(of("develop").is_locked && of("develop").locked_by_rule);
        assert!(of("release/1.2").is_locked && of("release/1.2").locked_by_rule);
        // Nothing else is touched, `base` included — it isn't in the pinned list.
        assert!(!of("feature").is_locked && !of("feature").locked_by_rule);
        assert!(!of(&base).is_locked);

        // And the guard honours it: merging into a rule-locked branch is refused exactly like
        // merging into a hand-locked one.
        checkout_local_branch(path, "develop").unwrap();
        let err = super::super::merge::merge_branch(path, "feature").unwrap_err();
        assert!(err.starts_with(BRANCH_LOCKED_PREFIX), "unexpected error: {err}");

        fs::remove_dir_all(&dir).ok();
    }

    /// The per-branch padlock still wins, in both directions — that's what keeps a list that
    /// applies to every repository from being something you have to edit to get work done.
    #[test]
    fn a_branchs_own_padlock_overrides_the_rules_both_ways() {
        let _pinned = lock_rules::pin_for_test(&["develop"]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        create_branch(path, "develop", None).unwrap();

        let locked_state = |name: &str| {
            let listed = list_branches(path).unwrap();
            let b = listed.iter().find(|b| b.name == name).unwrap();
            (b.is_locked, b.locked_by_rule)
        };

        // Unlocking a rule-locked branch pins it open, and the merge that was refused goes through.
        set_branch_locked(path, "develop", false).unwrap();
        assert_eq!(locked_state("develop"), (false, false));
        checkout_local_branch(path, "develop").unwrap();
        super::super::merge::merge_branch(path, "feature").unwrap();

        // Locking a branch no rule covers pins it shut, and isn't attributed to the rules.
        set_branch_locked(path, "feature", true).unwrap();
        assert_eq!(locked_state("feature"), (true, false));

        // Asking for the state the rules already give drops the entry rather than pinning it, so
        // the branch follows the list again afterwards.
        set_branch_locked(path, "develop", true).unwrap();
        assert_eq!(locked_state("develop"), (true, true));
        set_branch_locked(path, "feature", false).unwrap();
        assert_eq!(locked_state("feature"), (false, false));
        let config = git2::Repository::open(path).unwrap().config().unwrap();
        assert!(config.get_bool("branch.develop.codeflowLocked").is_err());
        assert!(config.get_bool("branch.feature.codeflowLocked").is_err());

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

    /// The branch a fresh repository is on, before anything has been committed.
    ///
    /// `repo.branches()` cannot yield it — there is no `refs/heads/` entry until the first commit —
    /// so without the explicit pass in `list_branches` the sidebar showed an empty branch list, or
    /// one holding only somebody else's leftover branch, while the status bar named a branch that
    /// appeared nowhere in it.
    #[test]
    fn the_unborn_branch_is_listed_and_is_head() {
        let dir = std::env::temp_dir().join(format!("cf-branch-unborn-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        // Whatever `init.defaultBranch` this machine has, pin the one the assertion names.
        repo.set_head("refs/heads/master").unwrap();
        drop(repo);
        let path = dir.to_str().unwrap();

        let listed = list_branches(path).unwrap();
        assert_eq!(listed.len(), 1);
        let head = &listed[0];
        assert_eq!(head.name, "master");
        assert!(head.is_head);
        assert!(!head.is_remote);
        // No commit: nothing to peel to, nothing to compare against.
        assert_eq!(head.target, None);
        assert_eq!(head.tip_time, None);
        assert_eq!(head.upstream, None);
        assert_eq!((head.ahead, head.behind), (0, 0));

        // And it agrees with what the status bar is told, which is the whole point.
        let status = super::super::repo::get_status(path).unwrap();
        assert_eq!(status.current_branch.as_deref(), Some("master"));

        fs::remove_dir_all(&dir).ok();
    }
}
