use std::collections::HashMap;

use git2::{Oid, Repository, Sort};
use serde::{Deserialize, Serialize};

use super::repo::open;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since epoch, UTC.
    pub timestamp: i64,
    pub parent_ids: Vec<String>,
    /// Branch/tag names pointing at this commit (e.g. "main", "origin/main", "v1.0").
    pub refs: Vec<String>,
}

fn build_ref_map(repo: &Repository) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            if !(r.is_remote() || r.is_branch() || r.is_tag()) {
                continue;
            }
            let Some(name) = r.shorthand() else { continue };
            // Annotated tags point at a tag object, not a commit; peel to the commit.
            let commit_id = r
                .peel_to_commit()
                .map(|c| c.id())
                .ok()
                .or_else(|| r.target());
            let Some(commit_id) = commit_id else { continue };
            map.entry(commit_id.to_string()).or_default().push(name.to_string());
        }
    }
    map
}

fn build_commit_info(repo: &Repository, oid: Oid, ref_map: &HashMap<String, Vec<String>>) -> Result<CommitInfo, String> {
    let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
    let author = commit.author();
    let id_str = oid.to_string();

    Ok(CommitInfo {
        short_id: id_str[..7.min(id_str.len())].to_string(),
        summary: commit.summary().unwrap_or("").to_string(),
        author_name: author.name().unwrap_or("").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        timestamp: commit.time().seconds(),
        parent_ids: commit.parent_ids().map(|p| p.to_string()).collect(),
        refs: ref_map.get(&id_str).cloned().unwrap_or_default(),
        id: id_str,
    })
}

/// Returns commits in topological + chronological order (like `git log --graph --all`),
/// with raw parent links and ref names. Lane/layout computation for the graph view
/// happens on the frontend, which keeps this call cheap to re-run and easy to animate.
pub fn list_commits(path: &str, all_refs: bool, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = open(path)?;
    let ref_map = build_ref_map(&repo);

    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.message().to_string())?;

    if all_refs {
        walk.push_glob("refs/heads/*").map_err(|e| e.message().to_string())?;
        walk.push_glob("refs/remotes/*").map_err(|e| e.message().to_string())?;
    } else {
        walk.push_head().map_err(|e| e.message().to_string())?;
    }

    let mut commits = Vec::with_capacity(limit.min(1024));
    for oid in walk.take(limit) {
        let oid = oid.map_err(|e| e.message().to_string())?;
        commits.push(build_commit_info(&repo, oid, &ref_map)?);
    }

    Ok(commits)
}

/// Commits reachable from HEAD but not yet on its upstream — i.e. what `git push` would
/// send. Empty if the current branch has no upstream configured (nothing to compare against).
pub fn list_unpushed_commits(path: &str) -> Result<Vec<CommitInfo>, String> {
    let repo = open(path)?;
    let head = repo.head().map_err(|e| e.message().to_string())?;
    if !head.is_branch() {
        return Ok(vec![]);
    }
    let head_oid = head.target().ok_or("HEAD has no target")?;
    let branch_name = head.shorthand().ok_or("invalid branch name")?;

    let branch = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    let Ok(upstream) = branch.upstream() else {
        return Ok(vec![]);
    };
    let Some(upstream_oid) = upstream.get().target() else {
        return Ok(vec![]);
    };

    let ref_map = build_ref_map(&repo);
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.message().to_string())?;
    walk.push(head_oid).map_err(|e| e.message().to_string())?;
    walk.hide(upstream_oid).map_err(|e| e.message().to_string())?;

    let mut commits = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| e.message().to_string())?;
        commits.push(build_commit_info(&repo, oid, &ref_map)?);
    }

    Ok(commits)
}
