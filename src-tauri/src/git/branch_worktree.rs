//! A checkout of one branch in a folder of its own, made if it is not there yet — what anything that
//! wants to *run* a branch next to the others needs: Contenedores' per-branch environments, an
//! agent's sandbox.
//!
//! [`super::worktree`] adds and removes worktrees as the user asks for them, one flag at a time.
//! This answers the question a feature asks instead — "give me `feature/payment` checked out
//! somewhere" — and picks the command from what the repository already has: the worktree that
//! already holds the branch (git refuses a second one, and the first one is the right answer
//! anyway), the local branch, a remote's branch of that name (tracked), or a new branch from a base.
//!
//! **What it made, it says.** [`BranchWorktree::created`] is `false` when an existing checkout was
//! reused — the main one included — and a caller must never offer to delete a checkout it did not
//! make.

use std::path::Path;

use serde::Serialize;

use super::cli;
use super::worktree;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchWorktree {
    pub path: String,
    pub branch: String,
    /// This call ran `git worktree add`; `false` when the branch was already checked out somewhere.
    pub created: bool,
    /// The branch itself was made by this call (from `base`, or from a remote's branch).
    pub new_branch: bool,
}

fn git(repo_path: &str, args: &[&str]) -> Result<cli::Output, String> {
    cli::run_in(repo_path, args, &[])
}

/// A branch name git accepts (`git check-ref-format --branch`), refused before it reaches a command
/// line where `-x` would read as a flag.
pub fn check_branch(repo_path: &str, branch: &str) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || branch.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("\"{branch}\" is not a branch name"));
    }
    let out = git(repo_path, &["check-ref-format", "--branch", branch])?;
    if out.success {
        Ok(())
    } else {
        Err(format!("\"{branch}\" is not a branch name"))
    }
}

fn ref_exists(repo_path: &str, reference: &str) -> bool {
    git(repo_path, &["rev-parse", "--verify", "--quiet", reference]).map(|o| o.success).unwrap_or(false)
}

/// `refs/remotes/<remote>/<branch>` for the first remote that has it, as `<remote>/<branch>`.
fn remote_branch(repo_path: &str, branch: &str) -> Option<String> {
    let out = git(repo_path, &["for-each-ref", "--format=%(refname:short)", &format!("refs/remotes/*/{branch}")]).ok()?;
    if !out.success {
        return None;
    }
    let mut found: Vec<String> = out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
    // `origin` first when several remotes have it: it is the one a clone tracks.
    found.sort_by_key(|r| (!r.starts_with("origin/"), r.clone()));
    found.into_iter().next()
}

/// The checkout of `branch`, made at `target` when no worktree holds it yet.
///
/// In order: a worktree already on `branch` (returned as it is, `created: false`); the local branch;
/// `base` as the start of a new branch named `branch`; a remote's `branch`, tracked. `target` must not
/// exist, or be an empty folder.
pub fn ensure(repo_path: &str, target: &Path, branch: &str, base: Option<&str>) -> Result<BranchWorktree, String> {
    let branch = branch.trim();
    check_branch(repo_path, branch)?;
    let base = base.map(str::trim).filter(|b| !b.is_empty());
    if let Some(base) = base {
        if base.starts_with('-') || !ref_exists(repo_path, &format!("{base}^{{commit}}")) {
            return Err(format!("\"{base}\" is not a branch or commit of this repository"));
        }
    }

    if let Some(existing) = worktree::list(repo_path)?.into_iter().find(|w| !w.prunable && w.branch.as_deref() == Some(branch)) {
        return Ok(BranchWorktree { path: existing.path, branch: branch.to_string(), created: false, new_branch: false });
    }

    if target.exists() && std::fs::read_dir(target).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(format!("{} already exists and is not empty", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
    }
    let target_text = target.to_string_lossy().into_owned();

    let local = ref_exists(repo_path, &format!("refs/heads/{branch}"));
    let (new_branch, start) = if local {
        (false, None)
    } else if let Some(base) = base {
        (true, Some(base.to_string()))
    } else if let Some(remote) = remote_branch(repo_path, branch) {
        (true, Some(remote))
    } else {
        return Err(format!("there is no branch {branch} here or on a remote: choose the branch to start it from"));
    };
    worktree::add(repo_path, &target_text, branch, new_branch, start.as_deref())?;
    Ok(BranchWorktree { path: target_text, branch: branch.to_string(), created: true, new_branch })
}

/// Whether a checkout has anything `git worktree remove` would refuse to throw away: modified,
/// staged or untracked files (ignored ones — a copied `.env`, `node_modules` — do not count).
pub fn is_dirty(path: &str) -> Result<bool, String> {
    let out = git(path, &["status", "--porcelain", "--untracked-files=normal"])?;
    if !out.success {
        return Err(out.detail());
    }
    Ok(!out.stdout.trim().is_empty())
}

/// Removes a worktree this code made. Refused with [`worktree::WORKTREE_DIRTY_PREFIX`] when it holds
/// changes and `force` is not set — and always for the main checkout.
pub fn remove(repo_path: &str, path: &str, force: bool) -> Result<(), String> {
    let main = worktree::list(repo_path)?.into_iter().find(|w| w.is_main);
    if main.is_some_and(|m| same_path(&m.path, path)) {
        return Err("the repository's own checkout is never removed".into());
    }
    if !Path::new(path).exists() {
        return worktree::prune(repo_path);
    }
    if !force && is_dirty(path)? {
        return Err(format!("{}{path}", worktree::WORKTREE_DIRTY_PREFIX));
    }
    worktree::remove(repo_path, path, force)
}

fn same_path(a: &str, b: &str) -> bool {
    let canon = |p: &str| Path::new(p).canonicalize().unwrap_or_else(|_| Path::new(p).to_path_buf());
    canon(a) == canon(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn ok(dir: &Path, args: &[&str]) {
        let out = cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(out.success, "git {args:?}: {}", out.combined());
    }

    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("cf-branch-wt-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        fs::create_dir_all(&main).unwrap();
        ok(&main, &["init", "-q", "-b", "main"]);
        for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.hooksPath", "/dev/null")] {
            ok(&main, &["config", key, value]);
        }
        fs::write(main.join("a.txt"), "a\n").unwrap();
        ok(&main, &["add", "-A"]);
        ok(&main, &["commit", "-q", "-m", "first"]);
        ok(&main, &["branch", "feature/pay"]);
        (root, main)
    }

    #[test]
    fn a_branch_gets_one_checkout_and_reuses_it() {
        let (root, main) = fixture();
        let repo = main.to_str().unwrap();

        let first = ensure(repo, &root.join("pay"), "feature/pay", None).unwrap();
        assert!(first.created && !first.new_branch);
        assert!(root.join("pay").join("a.txt").is_file());
        let again = ensure(repo, &root.join("elsewhere"), "feature/pay", None).unwrap();
        assert!(!again.created, "the branch's worktree is reused");
        assert!(same_path(&again.path, root.join("pay").to_str().unwrap()));

        // The branch the main checkout holds is that checkout — never deleted by `remove`.
        let on_main = ensure(repo, &root.join("m"), "main", None).unwrap();
        assert!(!on_main.created);
        assert!(remove(repo, &on_main.path, true).is_err());

        let fresh = ensure(repo, &root.join("auth"), "fix/auth", Some("main")).unwrap();
        assert!(fresh.created && fresh.new_branch);
        assert!(ensure(repo, &root.join("nope"), "fix/none", None).unwrap_err().contains("start it from"));
        assert!(ensure(repo, &root.join("bad"), "-x", None).is_err());
        assert!(ensure(repo, &root.join("bad"), "x", Some("does-not-exist")).is_err());

        // Dirty is refused without force, removed with it.
        fs::write(root.join("auth").join("new.txt"), "x").unwrap();
        assert!(is_dirty(&fresh.path).unwrap());
        assert!(remove(repo, &fresh.path, false).unwrap_err().starts_with(worktree::WORKTREE_DIRTY_PREFIX));
        remove(repo, &fresh.path, true).unwrap();
        assert!(!root.join("auth").exists());
        remove(repo, &first.path, false).unwrap();
        let _ = fs::remove_dir_all(&root);
    }
}
