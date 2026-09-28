//! Tags and branches *on the remote*: publishing tags, and deleting a tag or a branch there.
//!
//! The command lines are built here and run by `crate::remote`, which owns the network runner — its
//! batch-mode ssh, its deadline, and the classification that turns "Permission denied (publickey)"
//! into a sentence. Built here so they can be tested against a real (local) remote without a Tauri
//! app to run them in.
//!
//! Every ref is spelled out in full (`refs/tags/v1`, `refs/heads/feature`). `git push origin v1`
//! resolves `v1` against the local refs first and pushes whatever it finds — a branch that happens
//! to share a tag's name goes instead — and `--delete v1` on the remote is just as ambiguous there.

use git2::Repository;

use super::repo::open;

pub fn push_tag_args(remote: &str, tag: &str) -> Vec<String> {
    vec!["push".into(), remote.into(), format!("refs/tags/{tag}")]
}

pub fn push_all_tags_args(remote: &str) -> Vec<String> {
    vec!["push".into(), remote.into(), "--tags".into()]
}

pub fn delete_remote_tag_args(remote: &str, tag: &str) -> Vec<String> {
    vec!["push".into(), remote.into(), "--delete".into(), format!("refs/tags/{tag}")]
}

pub fn delete_remote_branch_args(remote: &str, branch: &str) -> Vec<String> {
    vec!["push".into(), remote.into(), "--delete".into(), format!("refs/heads/{branch}")]
}

/// `origin/feature/x` → `("origin", "feature/x")`, by the remote names this repository actually has —
/// the longest that matches, so a remote called `team/origin` is not read as `team`.
pub fn split_remote_branch(repo: &Repository, remote_branch: &str) -> Option<(String, String)> {
    let remotes = repo.remotes().ok()?;
    let mut best: Option<(String, String)> = None;
    for name in remotes.iter().flatten() {
        if let Some(rest) = remote_branch.strip_prefix(&format!("{name}/")) {
            if !rest.is_empty() && best.as_ref().map_or(true, |(b, _)| name.len() > b.len()) {
                best = Some((name.to_string(), rest.to_string()));
            }
        }
    }
    best
}

pub fn split_remote_branch_at(path: &str, remote_branch: &str) -> Result<(String, String), String> {
    let repo = open(path)?;
    split_remote_branch(&repo, remote_branch)
        .ok_or_else(|| format!("'{remote_branch}' does not name a branch of a known remote"))
}

/// The remote a tag action aims at: the one named, or the repository's default one.
pub fn remote_or_default(path: &str, remote: Option<String>) -> Result<String, String> {
    match remote.filter(|r| !r.trim().is_empty()) {
        Some(remote) => Ok(remote),
        None => super::remotes::default_remote(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(out.success, "git {args:?}: {}", out.combined());
        out.stdout
    }

    fn run(dir: &Path, args: &[String]) {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git(dir, &refs);
    }

    /// A clone of a local bare repository, so every push is real and nothing leaves the machine.
    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("cf-remote-refs-{}", uuid::Uuid::new_v4()));
        let bare = root.join("remote.git");
        let work = root.join("work");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
        git(&root, &["clone", "-q", bare.to_str().unwrap(), work.to_str().unwrap()]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            git(&work, &["config", key, value]);
        }
        fs::write(work.join("a.txt"), "a\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-q", "-m", "first"]);
        git(&work, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
        (root, bare, work)
    }

    fn remote_refs(bare: &Path) -> String {
        git(bare, &["for-each-ref", "--format=%(refname)"])
    }

    #[test]
    fn tags_are_pushed_one_or_all_and_deleted() {
        let (root, bare, work) = fixture();
        git(&work, &["tag", "v1"]);
        git(&work, &["tag", "-a", "v2", "-m", "release 2"]);
        // A branch with a tag's name: the full refname is what keeps it from being pushed instead.
        git(&work, &["branch", "v1"]);

        run(&work, &push_tag_args("origin", "v1"));
        let refs = remote_refs(&bare);
        assert!(refs.contains("refs/tags/v1"), "{refs}");
        assert!(!refs.contains("refs/heads/v1"), "the same-named branch went instead: {refs}");

        run(&work, &push_all_tags_args("origin"));
        assert!(remote_refs(&bare).contains("refs/tags/v2"));

        run(&work, &delete_remote_tag_args("origin", "v1"));
        let refs = remote_refs(&bare);
        assert!(!refs.contains("refs/tags/v1") && refs.contains("refs/tags/v2"), "{refs}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_remote_branch_is_deleted_there_and_here() {
        let (root, bare, work) = fixture();
        git(&work, &["push", "-q", "origin", "HEAD:refs/heads/feature/x"]);
        git(&work, &["fetch", "-q", "origin"]);
        let repo = Repository::open(&work).unwrap();
        let (remote, branch) = split_remote_branch(&repo, "origin/feature/x").unwrap();
        assert_eq!((remote.as_str(), branch.as_str()), ("origin", "feature/x"));

        run(&work, &delete_remote_branch_args(&remote, &branch));
        assert!(!remote_refs(&bare).contains("refs/heads/feature/x"));
        // git drops the remote-tracking ref along with it.
        assert!(repo.find_branch("origin/feature/x", git2::BranchType::Remote).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_longest_remote_name_wins() {
        let (root, _bare, work) = fixture();
        // The git CLI refuses a remote name that nests under another one ("is a subset of existing
        // remote"), but a hand-edited config — or libgit2 — does not.
        let repo = Repository::open(&work).unwrap();
        repo.remote("origin/mirror", "https://example.com/r.git").unwrap();
        assert_eq!(
            split_remote_branch(&repo, "origin/mirror/main"),
            Some(("origin/mirror".to_string(), "main".to_string()))
        );
        assert_eq!(split_remote_branch(&repo, "origin/main"), Some(("origin".to_string(), "main".to_string())));
        assert_eq!(split_remote_branch(&repo, "unknown/main"), None);
        assert_eq!(split_remote_branch(&repo, "origin/"), None);
        fs::remove_dir_all(&root).ok();
    }
}
