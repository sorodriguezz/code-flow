use git2::{StashApplyOptions, StashFlags};
use serde::{Deserialize, Serialize};

use super::repo::open;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

pub fn list_stashes(path: &str) -> Result<Vec<StashInfo>, String> {
    let mut repo = open(path)?;
    let mut result = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        result.push(StashInfo {
            index,
            message: message.to_string(),
            oid: oid.to_string(),
        });
        true
    })
    .map_err(|e| e.message().to_string())?;
    Ok(result)
}

pub fn stash_save(path: &str, message: Option<String>, include_untracked: bool) -> Result<(), String> {
    let mut repo = open(path)?;
    let sig = repo.signature().map_err(|e| e.message().to_string())?;
    let mut flags = StashFlags::DEFAULT;
    if include_untracked {
        flags |= StashFlags::INCLUDE_UNTRACKED;
    }
    repo.stash_save(&sig, message.as_deref().unwrap_or("WIP"), Some(flags))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn stash_apply(path: &str, index: usize) -> Result<(), String> {
    let mut repo = open(path)?;
    repo.stash_apply(index, Some(&mut StashApplyOptions::new()))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn stash_pop(path: &str, index: usize) -> Result<(), String> {
    let mut repo = open(path)?;
    repo.stash_pop(index, Some(&mut StashApplyOptions::new()))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn stash_drop(path: &str, index: usize) -> Result<(), String> {
    let mut repo = open(path)?;
    repo.stash_drop(index).map_err(|e| e.message().to_string())?;
    Ok(())
}
