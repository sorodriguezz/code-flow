use git2::{BranchType, ObjectType};
use serde::{Deserialize, Serialize};

use super::repo::open;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub target: Option<String>,
}

pub fn list_branches(path: &str) -> Result<Vec<BranchInfo>, String> {
    let repo = open(path)?;
    let mut result = Vec::new();

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
    repo.checkout_tree(&object, None).map_err(|e| e.message().to_string())?;
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
    repo.checkout_tree(&commit, None).map_err(|e| e.message().to_string())?;
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
