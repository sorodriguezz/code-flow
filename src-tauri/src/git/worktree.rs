//! Worktrees: the other checkouts of this repository.
//!
//! Listing is libgit2's. Adding and removing go through `git worktree`, because the CLI is what the
//! user's own tooling expects to have made them — it runs `post-checkout`, honours sparse checkout and
//! LFS on the new tree, and its refusals ("already checked out at…", "contains modified or untracked
//! files") are the ones worth showing as they are.

use std::path::{Path, PathBuf};

use git2::{Repository, WorktreeLockStatus};
use serde::{Deserialize, Serialize};

use super::cli;
use super::features::common_dir;
use super::repo::open;

/// `git worktree remove` refused because the tree has modified or untracked files. The UI asks a
/// second, louder time before forcing it.
pub const WORKTREE_DIRTY_PREFIX: &str = "WORKTREE_DIRTY: ";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    /// git's name for a linked worktree (its folder under `.git/worktrees/`); `None` for the main one.
    pub name: Option<String>,
    pub path: String,
    /// The branch checked out there; `None` when detached (or unreadable).
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub is_main: bool,
    /// The one this app has open.
    pub is_current: bool,
    pub locked: bool,
    /// Its folder is gone — `git worktree prune` would drop it.
    pub prunable: bool,
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

fn head_of(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(repo) = Repository::open(path) else { return (None, None) };
    let Ok(head) = repo.head() else {
        return (super::repo::unborn_head_branch(&repo), None);
    };
    let branch = head.is_branch().then(|| head.shorthand().map(str::to_string)).flatten();
    (branch, head.target().map(|id| id.to_string()))
}

pub fn list(path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let repo = open(path)?;
    let current = repo.workdir().map(Path::to_path_buf);
    let common = common_dir(&repo);
    let mut out = Vec::new();

    // The main worktree is the folder the common `.git` directory sits in. A bare repository has
    // none, and lists only its linked ones.
    if common.file_name().is_some_and(|n| n == ".git") {
        if let Some(main) = common.parent() {
            let (branch, head_oid) = head_of(main);
            out.push(WorktreeInfo {
                name: None,
                path: main.to_string_lossy().into_owned(),
                branch,
                head_oid,
                is_main: true,
                is_current: current.as_deref().is_some_and(|c| same_dir(c, main)),
                locked: false,
                prunable: false,
            });
        }
    }

    let names = repo.worktrees().map_err(|e| e.message().to_string())?;
    for name in names.iter().flatten() {
        let Ok(wt) = repo.find_worktree(name) else { continue };
        let wt_path: PathBuf = wt.path().to_path_buf();
        let prunable = wt.validate().is_err() || !wt_path.exists();
        let (branch, head_oid) = if prunable { (None, None) } else { head_of(&wt_path) };
        out.push(WorktreeInfo {
            name: Some(name.to_string()),
            path: wt_path.to_string_lossy().into_owned(),
            branch,
            head_oid,
            is_main: false,
            is_current: current.as_deref().is_some_and(|c| same_dir(c, &wt_path)),
            locked: matches!(wt.is_locked(), Ok(WorktreeLockStatus::Locked(_))),
            prunable,
        });
    }
    Ok(out)
}

/// The command line for a new worktree: on an existing branch, or on a new one (optionally from a
/// start point).
pub fn add_args(target: &str, branch: &str, new_branch: bool, start: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if new_branch {
        args.extend(["-b".into(), branch.to_string(), target.to_string()]);
        if let Some(start) = start.filter(|s| !s.trim().is_empty()) {
            args.push(start.to_string());
        }
    } else {
        args.extend([target.to_string(), branch.to_string()]);
    }
    args
}

fn run_checked(repo_path: &str, args: &[String]) -> Result<cli::Output, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    cli::run_in(repo_path, &refs, &[])
}

pub fn add(repo_path: &str, target: &str, branch: &str, new_branch: bool, start: Option<&str>) -> Result<(), String> {
    if branch.trim().is_empty() || target.trim().is_empty() {
        return Err("a worktree needs a folder and a branch".to_string());
    }
    let out = run_checked(repo_path, &add_args(target, branch.trim(), new_branch, start))?;
    if out.success {
        Ok(())
    } else {
        Err(out.detail())
    }
}

/// `git worktree remove [--force]`. Without `force`, a tree with local changes is refused with
/// [`WORKTREE_DIRTY_PREFIX`] — the one refusal the UI answers with a second confirmation.
pub fn remove(repo_path: &str, target: &str, force: bool) -> Result<(), String> {
    let mut args: Vec<String> = vec!["worktree".into(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.push(target.to_string());
    let out = run_checked(repo_path, &args)?;
    if out.success {
        return Ok(());
    }
    let detail = out.detail();
    if detail.contains("contains modified or untracked files") {
        return Err(format!("{WORKTREE_DIRTY_PREFIX}{target}"));
    }
    Err(detail)
}

/// `git worktree prune` — forgets worktrees whose folders were deleted by hand.
pub fn prune(repo_path: &str) -> Result<(), String> {
    let out = cli::run_in(repo_path, &["worktree", "prune"], &[])?;
    if out.success {
        Ok(())
    } else {
        Err(out.detail())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn ok(dir: &Path, args: &[&str]) {
        let out = cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(out.success, "git {args:?}: {}", out.combined());
    }

    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("cf-worktree-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        fs::create_dir_all(&main).unwrap();
        ok(&main, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            ok(&main, &["config", key, value]);
        }
        fs::write(main.join("a.txt"), "a\n").unwrap();
        ok(&main, &["add", "-A"]);
        ok(&main, &["commit", "-q", "-m", "first"]);
        ok(&main, &["branch", "existing"]);
        (root, main)
    }

    #[test]
    fn worktrees_are_added_listed_and_removed() {
        let (root, main) = fixture();
        let repo_path = main.to_str().unwrap();
        let fresh = root.join("fresh");
        let other = root.join("other");
        add(repo_path, fresh.to_str().unwrap(), "feature", true, None).unwrap();
        add(repo_path, other.to_str().unwrap(), "existing", false, None).unwrap();

        let listed = list(repo_path).unwrap();
        assert_eq!(listed.len(), 3);
        assert!(listed[0].is_main && listed[0].is_current);
        assert_eq!(listed[0].branch.as_deref(), Some("main"));
        let find = |branch: &str| listed.iter().find(|w| w.branch.as_deref() == Some(branch)).unwrap();
        assert!(!find("feature").is_main && !find("feature").is_current);
        assert!(same_dir(Path::new(&find("existing").path), &other));

        // Clean: removed on the first ask.
        remove(repo_path, other.to_str().unwrap(), false).unwrap();
        assert!(!other.exists());

        // Dirty: refused by name, then removed when forced.
        fs::write(fresh.join("scratch.txt"), "local work\n").unwrap();
        let err = remove(repo_path, fresh.to_str().unwrap(), false).unwrap_err();
        assert!(err.starts_with(WORKTREE_DIRTY_PREFIX), "{err}");
        assert!(fresh.exists());
        remove(repo_path, fresh.to_str().unwrap(), true).unwrap();
        assert!(!fresh.exists());
        assert_eq!(list(repo_path).unwrap().len(), 1);
        fs::remove_dir_all(&root).ok();
    }

    /// Opened from a linked worktree, the list still starts with the main one and marks where we are.
    #[test]
    fn the_list_is_the_same_from_a_linked_worktree() {
        let (root, main) = fixture();
        let linked = root.join("linked");
        add(main.to_str().unwrap(), linked.to_str().unwrap(), "linked-branch", true, None).unwrap();
        let listed = list(linked.to_str().unwrap()).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].is_main && !listed[0].is_current);
        assert!(listed[1].is_current);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_branch_checked_out_elsewhere_is_refused_with_gits_words() {
        let (root, main) = fixture();
        let err = add(main.to_str().unwrap(), root.join("dup").to_str().unwrap(), "main", false, None).unwrap_err();
        assert!(err.contains("main"), "{err}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn add_args_cover_both_shapes() {
        assert_eq!(add_args("/w/x", "feat", false, None), vec!["worktree", "add", "/w/x", "feat"]);
        assert_eq!(add_args("/w/x", "feat", true, Some("main")), vec!["worktree", "add", "-b", "feat", "/w/x", "main"]);
        assert_eq!(add_args("/w/x", "feat", true, Some(" ")), vec!["worktree", "add", "-b", "feat", "/w/x"]);
    }
}
