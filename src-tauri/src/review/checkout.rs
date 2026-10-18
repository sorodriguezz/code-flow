//! The checkout a review's reviewers read from: the pull request's own head commit.
//!
//! Everything the pipeline reads itself — the outline, the bundles, the blast radius — comes out of
//! git's object database at the PR's head, so it was always right. What was not right is everything
//! the *model* read: the bundles tell it to open whatever else it needs, and it did, in the user's
//! working copy, on whatever branch happened to be checked out. Reviewing a colleague's PR from
//! `main` meant every file the reviewer opened beyond its bundle was `main`'s version — callers,
//! types, the rest of the very file under review.
//!
//! So the reviewers run in a checkout of the PR's head. When the user's own working copy is already
//! there, it is used as-is. Otherwise it is one linked worktree per project under the cache root,
//! **reused** across reviews: the first one pays a checkout of the repository, every later one only
//! rewrites the files that differ between two heads — usually a handful.
//!
//! Three things it must never do to the user's repository, each of which a plain `git worktree add`
//! would: run their hooks (a `post-checkout` that installs dependencies), download their LFS
//! objects, or leave a branch behind. It is detached, hook-less and LFS-pointer-only, and it lives in
//! the cache, so clearing the cache is the whole cleanup.

use std::path::{Path, PathBuf};

use crate::git::cli;

/// Where a project's review checkout lives.
pub fn dir_for(project_id: &str) -> PathBuf {
    let safe: String = project_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    crate::paths::cache_dir().join("review-trees").join(safe)
}

/// Settings that keep git from doing anything but write files: no hooks, no LFS downloads.
fn quiet_args(empty_hooks: &Path) -> Vec<String> {
    vec![
        "-c".into(),
        format!("core.hooksPath={}", empty_hooks.to_string_lossy()),
        "-c".into(),
        "advice.detachedHead=false".into(),
    ]
}

const QUIET_ENV: [(&str, &str); 1] = [("GIT_LFS_SKIP_SMUDGE", "1")];

fn head_of(path: &str) -> Option<String> {
    let repo = git2::Repository::open(path).ok()?;
    let oid = repo.head().ok()?.target()?;
    Some(oid.to_string())
}

/// Whether `dir` is a linked worktree of the repository at `repo_path`.
fn belongs_to(dir: &Path, repo_path: &str) -> bool {
    let (Ok(tree), Ok(main)) = (git2::Repository::open(dir), git2::Repository::open(repo_path)) else { return false };
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    tree.is_worktree() && canon(&crate::git::features::common_dir(&tree)) == canon(&crate::git::features::common_dir(&main))
}

fn git(cwd: &Path, args: Vec<String>) -> Result<(), String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = cli::run(cwd, &refs, &QUIET_ENV, cli::LOCAL_TIMEOUT)?;
    if out.success { Ok(()) } else { Err(out.detail()) }
}

/// A checkout of `sha` for the reviewers to read, and its path.
///
/// `Err` only when neither the user's working copy is at `sha` nor a checkout of it could be made —
/// the caller then reviews from the user's working copy as before, and says so in the bundle header,
/// rather than not reviewing at all.
pub fn prepare(repo_path: &str, project_id: &str, sha: &str) -> Result<String, String> {
    if sha.trim().is_empty() {
        return Err("no head commit to check out".into());
    }
    if head_of(repo_path).as_deref() == Some(sha) {
        return Ok(repo_path.to_string());
    }
    let dir = dir_for(project_id);
    let hooks = crate::paths::cache_dir().join("review-trees").join(".no-hooks");
    let _ = std::fs::create_dir_all(&hooks);

    if dir.exists() && belongs_to(&dir, repo_path) {
        let mut args = quiet_args(&hooks);
        args.extend(["checkout", "--detach", "--force", "-q", sha].map(String::from));
        if git(&dir, args).is_ok() {
            // Anything a previous run left untracked would read as part of the PR.
            let _ = git(&dir, ["clean", "-fdq"].map(String::from).to_vec());
            return Ok(dir.to_string_lossy().into_owned());
        }
    }

    // Stale, foreign or broken: start over. `prune` drops the registration of a folder the cache
    // clean-up deleted, which would otherwise make `add` refuse the path.
    let _ = std::fs::remove_dir_all(&dir);
    let _ = git(Path::new(repo_path), ["worktree", "prune"].map(String::from).to_vec());
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut args = quiet_args(&hooks);
    args.extend(["worktree".to_string(), "add".into(), "--detach".into(), "--force".into(), dir.to_string_lossy().into_owned(), sha.to_string()]);
    git(Path::new(repo_path), args)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Deletes review checkouts whose project is gone — one deleted while the app was closed, or one a
/// crash left behind. `discard` covers a project removed
/// from the app; this covers everything else.
pub fn sweep(project_ids: &[String]) {
    let root = crate::paths::cache_dir().join("review-trees");
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    let known: std::collections::HashSet<PathBuf> = project_ids.iter().map(|id| dir_for(id)).collect();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || entry.file_name().to_string_lossy().starts_with('.') || known.contains(&path) {
            continue;
        }
        // Its registration in the gone project's repository is left for git's own `gc` (or the
        // next `worktree prune` there): there is no project left to say which repository it was.
        let _ = std::fs::remove_dir_all(&path);
    }
}

/// Removes a project's review checkout, if it has one — for when the project goes away.
pub fn discard(repo_path: &str, project_id: &str) {
    let dir = dir_for(project_id);
    if !dir.exists() {
        return;
    }
    if belongs_to(&dir, repo_path) {
        let _ = git(Path::new(repo_path), vec!["worktree".into(), "remove".into(), "--force".into(), dir.to_string_lossy().into_owned()]);
    }
    let _ = std::fs::remove_dir_all(&dir);
    let _ = git(Path::new(repo_path), ["worktree", "prune"].map(String::from).to_vec());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir).output().expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// The reviewers read the PR's head, not whatever the user has checked out — and the user's
    /// checkout is left exactly as it was.
    #[test]
    fn a_review_checkout_holds_the_prs_head_and_leaves_the_users_alone() {
        let root = std::env::temp_dir().join(format!("codeflow-review-checkout-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@example.com"]);
        sh(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "main\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "main"]);
        sh(&repo, &["checkout", "-qb", "feature"]);
        std::fs::write(repo.join("a.txt"), "feature\n").unwrap();
        sh(&repo, &["commit", "-qam", "feature"]);
        let feature = sh(&repo, &["rev-parse", "HEAD"]);
        sh(&repo, &["checkout", "-q", "main"]);

        let id = format!("test-{}", uuid::Uuid::new_v4());
        let repo_str = repo.to_string_lossy().into_owned();
        let tree = prepare(&repo_str, &id, &feature).expect("a checkout");
        assert_ne!(tree, repo_str, "the user is on main, so not their checkout");
        assert_eq!(std::fs::read_to_string(Path::new(&tree).join("a.txt")).unwrap(), "feature\n");
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "main\n", "untouched");
        assert_eq!(sh(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");

        // Reused: a second head is a checkout in place, not a new tree.
        let main_sha = sh(&repo, &["rev-parse", "main"]);
        assert_eq!(prepare(&repo_str, &id, &main_sha).expect("reused"), repo_str, "the user's checkout is at that head");
        sh(&repo, &["checkout", "-q", "feature"]);
        assert_eq!(prepare(&repo_str, &id, &main_sha).expect("reused"), tree);
        assert_eq!(std::fs::read_to_string(Path::new(&tree).join("a.txt")).unwrap(), "main\n");

        discard(&repo_str, &id);
        assert!(!Path::new(&tree).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
