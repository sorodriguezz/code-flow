use std::collections::HashSet;
use std::path::Path;

use git2::{BranchType, ObjectType, RepositoryState};
use serde::{Deserialize, Serialize};

use super::repo::open;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeOutcome {
    /// "up_to_date" | "fast_forward" | "merged" | "conflicts"
    pub status: String,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictFile {
    pub path: String,
}

fn conflict_paths(index: &git2::Index) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for conflict in index.conflicts().map_err(|e| e.message().to_string())? {
        let conflict = conflict.map_err(|e| e.message().to_string())?;
        let entry = conflict.our.or(conflict.their).or(conflict.ancestor);
        if let Some(entry) = entry {
            let path = String::from_utf8_lossy(&entry.path).to_string();
            if seen.insert(path.clone()) {
                result.push(path);
            }
        }
    }
    Ok(result)
}

pub fn merge_branch(path: &str, branch_name: &str) -> Result<MergeOutcome, String> {
    let repo = open(path)?;
    let their_branch = repo
        .find_branch(branch_name, BranchType::Local)
        .or_else(|_| repo.find_branch(branch_name, BranchType::Remote))
        .map_err(|e| e.message().to_string())?;
    let their_commit = their_branch
        .get()
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    let annotated = repo
        .find_annotated_commit(their_commit.id())
        .map_err(|e| e.message().to_string())?;

    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.message().to_string())?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome { status: "up_to_date".to_string(), conflicts: vec![] });
    }

    if analysis.is_fast_forward() {
        let refname = repo
            .head()
            .map_err(|e| e.message().to_string())?
            .name()
            .ok_or("invalid HEAD ref")?
            .to_string();
        let mut reference = repo.find_reference(&refname).map_err(|e| e.message().to_string())?;
        reference
            .set_target(their_commit.id(), "fast-forward merge")
            .map_err(|e| e.message().to_string())?;
        repo.set_head(&refname).map_err(|e| e.message().to_string())?;
        let mut cb = git2::build::CheckoutBuilder::new();
        cb.force();
        repo.checkout_head(Some(&mut cb)).map_err(|e| e.message().to_string())?;
        return Ok(MergeOutcome { status: "fast_forward".to_string(), conflicts: vec![] });
    }

    repo.merge(&[&annotated], None, None).map_err(|e| e.message().to_string())?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;

    if index.has_conflicts() {
        let conflicts = conflict_paths(&index)?;
        return Ok(MergeOutcome { status: "conflicts".to_string(), conflicts });
    }

    let sig = repo.signature().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;
    let head_commit = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    let message = format!("Merge branch '{branch_name}'");
    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&head_commit, &their_commit])
        .map_err(|e| e.message().to_string())?;
    repo.cleanup_state().map_err(|e| e.message().to_string())?;

    Ok(MergeOutcome { status: "merged".to_string(), conflicts: vec![] })
}

pub fn is_merging(path: &str) -> Result<bool, String> {
    let repo = open(path)?;
    Ok(repo.state() == RepositoryState::Merge)
}

pub fn list_conflicts(path: &str) -> Result<Vec<ConflictFile>, String> {
    let repo = open(path)?;
    let index = repo.index().map_err(|e| e.message().to_string())?;
    Ok(conflict_paths(&index)?.into_iter().map(|path| ConflictFile { path }).collect())
}

/// Resolves a conflicted file by taking one side wholesale ("ours" or "theirs"),
/// writing it to disk and staging it.
pub fn resolve_conflict_side(path: &str, rel_path: &str, side: &str) -> Result<(), String> {
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let conflict = index
        .conflicts()
        .map_err(|e| e.message().to_string())?
        .filter_map(|c| c.ok())
        .find(|c| {
            c.our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .is_some_and(|e| e.path == rel_path.as_bytes())
        })
        .ok_or("no conflict for this path")?;

    let entry = match side {
        "ours" => conflict.our,
        "theirs" => conflict.their,
        _ => return Err("side must be 'ours' or 'theirs'".to_string()),
    }
    .ok_or("that side has no content for this file (it was added/deleted)")?;

    let blob = repo.find_blob(entry.id).map_err(|e| e.message().to_string())?;
    let full_path = Path::new(path).join(rel_path);
    std::fs::write(&full_path, blob.content()).map_err(|e| e.to_string())?;

    index.add_path(Path::new(rel_path)).map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Stages whatever is currently on disk for this path as the resolution — used after
/// the user manually edits the conflicted file (e.g. in the embedded editor).
pub fn mark_conflict_resolved(path: &str, rel_path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index.add_path(Path::new(rel_path)).map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn complete_merge(path: &str, message: &str) -> Result<String, String> {
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    if index.has_conflicts() {
        return Err("There are still unresolved conflicts".to_string());
    }

    let sig = repo.signature().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;
    let head_commit = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;

    let merge_head = repo.find_reference("MERGE_HEAD").map_err(|e| e.message().to_string())?;
    let their_oid = merge_head.target().ok_or("MERGE_HEAD has no target")?;
    let their_commit = repo.find_commit(their_oid).map_err(|e| e.message().to_string())?;

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&head_commit, &their_commit])
        .map_err(|e| e.message().to_string())?;
    repo.cleanup_state().map_err(|e| e.message().to_string())?;

    Ok(oid.to_string())
}

pub fn abort_merge(path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let head_commit = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel(ObjectType::Commit)
        .map_err(|e| e.message().to_string())?;
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force();
    repo.checkout_tree(&head_commit, Some(&mut cb))
        .map_err(|e| e.message().to_string())?;
    repo.cleanup_state().map_err(|e| e.message().to_string())?;
    Ok(())
}
