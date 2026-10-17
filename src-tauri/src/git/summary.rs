//! A one-line answer per repository for the projects panel: the branch it is on, how many files
//! have changes, and how far it is from its upstream — for the repositories that are *not* open,
//! which `get_status` (the whole changeset, for the one that is) is far too heavy to run against
//! every few seconds.
//!
//! Untracked folders count as one entry each (`recurse_untracked_dirs(false)`), as `git status`
//! without `-uall` shows them: the number is "something to look at here", not a file count to the
//! last `node_modules` entry.

use git2::{Repository, StatusOptions};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
pub struct RepoSummary {
    pub path: String,
    /// `None` when detached or unreadable.
    pub branch: Option<String>,
    pub detached: bool,
    /// Files staged, modified or untracked — each counted once.
    pub changed: u32,
    pub conflicted: u32,
    /// Commits the branch has that its upstream does not, and the other way round. `None` without
    /// an upstream.
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// Why nothing else could be read — a folder gone, a repository broken.
    pub error: Option<String>,
}

pub fn summarize(path: &str) -> RepoSummary {
    match read(path) {
        Ok(summary) => summary,
        Err(error) => RepoSummary { path: path.to_string(), error: Some(error), ..Default::default() },
    }
}

fn read(path: &str) -> Result<RepoSummary, String> {
    let repo = Repository::open(path).map_err(|e| e.message().to_string())?;
    let mut summary = RepoSummary { path: path.to_string(), detached: repo.head_detached().unwrap_or(false), ..Default::default() };

    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(false).include_ignored(false);
    let statuses = repo.statuses(Some(&mut options)).map_err(|e| e.message().to_string())?;
    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_conflicted() {
            summary.conflicted += 1;
        } else if !status.is_empty() && !status.is_ignored() {
            summary.changed += 1;
        }
    }

    match repo.head() {
        Ok(head) => {
            if head.is_branch() {
                summary.branch = head.shorthand().map(str::to_string);
                if let (Some(local), Ok(upstream)) = (
                    head.target(),
                    repo.find_branch(head.shorthand().unwrap_or_default(), git2::BranchType::Local)
                        .and_then(|branch| branch.upstream()),
                ) {
                    if let Some(remote) = upstream.get().target() {
                        if let Ok((ahead, behind)) = repo.graph_ahead_behind(local, remote) {
                            summary.ahead = Some(ahead as u32);
                            summary.behind = Some(behind as u32);
                        }
                    }
                }
            }
        }
        Err(_) => summary.branch = super::repo::unborn_head_branch(&repo),
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_repository_counts_its_untracked_folder_once() {
        let dir = std::env::temp_dir().join(format!("cf-summary-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        let repo = Repository::init(&dir).unwrap();
        std::fs::write(dir.join("src/deep/a.txt"), "a").unwrap();
        std::fs::write(dir.join("src/deep/b.txt"), "b").unwrap();
        std::fs::write(dir.join("README"), "r").unwrap();
        drop(repo);
        let summary = summarize(dir.to_str().unwrap());
        assert_eq!(summary.error, None);
        assert_eq!(summary.changed, 2, "README and the src/ folder");
        assert_eq!(summary.ahead, None);
        assert!(summary.branch.is_some(), "the unborn branch is still named");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_folder_says_why() {
        let summary = summarize("/definitely/not/here/cf");
        assert!(summary.error.is_some());
    }
}
