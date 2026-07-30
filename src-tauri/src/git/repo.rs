use git2::{ObjectType, ResetType, Repository, StatusOptions};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatusEntry {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoStatusInfo {
    pub staged: Vec<FileStatusEntry>,
    pub unstaged: Vec<FileStatusEntry>,
    pub untracked: Vec<FileStatusEntry>,
    pub conflicted: Vec<FileStatusEntry>,
    pub current_branch: Option<String>,
    pub is_detached: bool,
    /// The commit HEAD points at, branch or not. The UI can't derive this from the branch list
    /// once HEAD is detached — no branch is head then — so it's reported here instead.
    pub head_oid: Option<String>,
}

pub fn open(path: &str) -> Result<Repository, String> {
    Repository::open(path).map_err(|e| e.message().to_string())
}

fn status_label(status: git2::Status) -> Option<(&'static str, &'static str)> {
    // returns (bucket, label) where bucket is one of staged/unstaged/untracked/conflicted
    if status.is_conflicted() {
        return Some(("conflicted", "conflicted"));
    }
    if status.is_index_new() {
        return Some(("staged", "added"));
    }
    if status.is_index_modified() {
        return Some(("staged", "modified"));
    }
    if status.is_index_deleted() {
        return Some(("staged", "deleted"));
    }
    if status.is_index_renamed() {
        return Some(("staged", "renamed"));
    }
    if status.is_index_typechange() {
        return Some(("staged", "typechange"));
    }
    if status.is_wt_new() {
        return Some(("untracked", "untracked"));
    }
    if status.is_wt_modified() {
        return Some(("unstaged", "modified"));
    }
    if status.is_wt_deleted() {
        return Some(("unstaged", "deleted"));
    }
    if status.is_wt_renamed() {
        return Some(("unstaged", "renamed"));
    }
    if status.is_wt_typechange() {
        return Some(("unstaged", "typechange"));
    }
    None
}

pub fn get_status(path: &str) -> Result<RepoStatusInfo, String> {
    let repo = open(path)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.message().to_string())?;

    let mut info = RepoStatusInfo {
        staged: vec![],
        unstaged: vec![],
        untracked: vec![],
        conflicted: vec![],
        current_branch: None,
        is_detached: repo.head_detached().unwrap_or(false),
        head_oid: None,
    };

    for entry in statuses.iter() {
        let Some(file_path) = entry.path() else { continue };
        let Some((bucket, label)) = status_label(entry.status()) else { continue };
        let item = FileStatusEntry {
            path: file_path.to_string(),
            status: label.to_string(),
        };
        match bucket {
            "staged" => info.staged.push(item),
            "unstaged" => info.unstaged.push(item),
            "untracked" => info.untracked.push(item),
            "conflicted" => info.conflicted.push(item),
            _ => {}
        }
    }

    if let Ok(head) = repo.head() {
        if head.is_branch() {
            info.current_branch = head.shorthand().map(|s| s.to_string());
        }
        info.head_oid = head.peel_to_commit().ok().map(|c| c.id().to_string());
    }

    Ok(info)
}

/// Moves HEAD (and the current branch) to `target_oid`. "mixed" (the safe default for an
/// "undo commit" action) unstages but keeps working-tree content; "soft" keeps the diff
/// staged; "hard" discards it entirely — callers should get explicit confirmation for that one.
pub fn reset_to_commit(path: &str, target_oid: &str, mode: &str) -> Result<(), String> {
    let repo = open(path)?;
    let oid = git2::Oid::from_str(target_oid).map_err(|e| e.message().to_string())?;
    let object = repo.find_object(oid, Some(ObjectType::Commit)).map_err(|e| e.message().to_string())?;

    let reset_type = match mode {
        "soft" => ResetType::Soft,
        "hard" => ResetType::Hard,
        _ => ResetType::Mixed,
    };

    repo.reset(&object, reset_type, None).map_err(|e| e.message().to_string())?;
    Ok(())
}
