use tauri::AppHandle;

use crate::git::{branch, diff, graph, identity, merge, remotes, repo, stash};
use crate::remote;

#[tauri::command]
pub fn get_status(repo_path: String) -> Result<repo::RepoStatusInfo, String> {
    repo::get_status(&repo_path)
}

#[tauri::command]
pub fn list_commits(repo_path: String, all_refs: bool, limit: usize) -> Result<Vec<graph::CommitInfo>, String> {
    graph::list_commits(&repo_path, all_refs, limit)
}

#[tauri::command]
pub fn list_unpushed_commits(repo_path: String) -> Result<Vec<graph::CommitInfo>, String> {
    graph::list_unpushed_commits(&repo_path)
}

#[tauri::command]
pub fn list_branches(repo_path: String) -> Result<Vec<branch::BranchInfo>, String> {
    branch::list_branches(&repo_path)
}

#[tauri::command]
pub fn create_branch(repo_path: String, name: String, start_point: Option<String>) -> Result<(), String> {
    branch::create_branch(&repo_path, &name, start_point)
}

#[tauri::command]
pub fn delete_branch(repo_path: String, name: String, is_remote: bool) -> Result<(), String> {
    branch::delete_branch(&repo_path, &name, is_remote)
}

#[tauri::command]
pub fn checkout_local_branch(repo_path: String, name: String) -> Result<(), String> {
    branch::checkout_local_branch(&repo_path, &name)
}

#[tauri::command]
pub fn checkout_detached(repo_path: String, refname: String) -> Result<(), String> {
    branch::checkout_detached(&repo_path, &refname)
}

#[tauri::command]
pub fn checkout_remote_tracking(repo_path: String, remote_branch: String) -> Result<String, String> {
    branch::checkout_remote_tracking(&repo_path, &remote_branch)
}

#[tauri::command]
pub fn list_stashes(repo_path: String) -> Result<Vec<stash::StashInfo>, String> {
    stash::list_stashes(&repo_path)
}

#[tauri::command]
pub fn stash_save(repo_path: String, message: Option<String>, include_untracked: bool) -> Result<(), String> {
    stash::stash_save(&repo_path, message, include_untracked)
}

#[tauri::command]
pub fn stash_apply(repo_path: String, index: usize) -> Result<(), String> {
    stash::stash_apply(&repo_path, index)
}

#[tauri::command]
pub fn stash_pop(repo_path: String, index: usize) -> Result<(), String> {
    stash::stash_pop(&repo_path, index)
}

#[tauri::command]
pub fn stash_drop(repo_path: String, index: usize) -> Result<(), String> {
    stash::stash_drop(&repo_path, index)
}

#[tauri::command]
pub fn get_working_diff(repo_path: String) -> Result<Vec<diff::FileDiffInfo>, String> {
    diff::get_working_diff(&repo_path)
}

#[tauri::command]
pub fn get_staged_diff(repo_path: String) -> Result<Vec<diff::FileDiffInfo>, String> {
    diff::get_staged_diff(&repo_path)
}

#[tauri::command]
pub fn get_commit_diff(repo_path: String, oid: String) -> Result<Vec<diff::FileDiffInfo>, String> {
    diff::get_commit_diff(&repo_path, &oid)
}

#[tauri::command]
pub fn stage_file(repo_path: String, file_path: String) -> Result<(), String> {
    diff::stage_file(&repo_path, &file_path)
}

#[tauri::command]
pub fn stage_all(repo_path: String) -> Result<(), String> {
    diff::stage_all(&repo_path)
}

#[tauri::command]
pub fn unstage_file(repo_path: String, file_path: String) -> Result<(), String> {
    diff::unstage_file(&repo_path, &file_path)
}

#[tauri::command]
pub fn unstage_all(repo_path: String) -> Result<(), String> {
    diff::unstage_all(&repo_path)
}

#[tauri::command]
pub fn discard_file_changes(repo_path: String, file_path: String) -> Result<(), String> {
    diff::discard_file_changes(&repo_path, &file_path)
}

#[tauri::command]
pub fn commit(
    repo_path: String,
    message: String,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<String, String> {
    diff::commit(&repo_path, &message, author_name, author_email)
}

#[tauri::command]
pub fn reset_to_commit(repo_path: String, oid: String, mode: String) -> Result<(), String> {
    repo::reset_to_commit(&repo_path, &oid, &mode)
}

#[tauri::command]
pub fn list_remotes(repo_path: String) -> Result<Vec<remotes::RemoteInfo>, String> {
    remotes::list_remotes(&repo_path)
}

#[tauri::command]
pub fn set_remote_url(repo_path: String, name: String, url: String) -> Result<(), String> {
    remotes::set_remote_url(&repo_path, &name, &url)
}

#[tauri::command]
pub fn get_git_identity() -> Result<identity::GitIdentity, String> {
    identity::get_identity()
}

#[tauri::command]
pub fn set_git_identity(name: String, email: String) -> Result<(), String> {
    identity::set_identity(&name, &email)
}

#[tauri::command]
pub fn merge_branch(repo_path: String, branch_name: String) -> Result<merge::MergeOutcome, String> {
    merge::merge_branch(&repo_path, &branch_name)
}

#[tauri::command]
pub fn is_merging(repo_path: String) -> Result<bool, String> {
    merge::is_merging(&repo_path)
}

#[tauri::command]
pub fn list_conflicts(repo_path: String) -> Result<Vec<merge::ConflictFile>, String> {
    merge::list_conflicts(&repo_path)
}

#[tauri::command]
pub fn resolve_conflict_side(repo_path: String, rel_path: String, side: String) -> Result<(), String> {
    merge::resolve_conflict_side(&repo_path, &rel_path, &side)
}

#[tauri::command]
pub fn mark_conflict_resolved(repo_path: String, rel_path: String) -> Result<(), String> {
    merge::mark_conflict_resolved(&repo_path, &rel_path)
}

#[tauri::command]
pub fn complete_merge(repo_path: String, message: String) -> Result<String, String> {
    merge::complete_merge(&repo_path, &message)
}

#[tauri::command]
pub fn abort_merge(repo_path: String) -> Result<(), String> {
    merge::abort_merge(&repo_path)
}

#[tauri::command]
pub async fn git_clone(app: AppHandle, url: String, dest: String) -> Result<(), String> {
    remote::clone(app, url, dest).await
}

#[tauri::command]
pub async fn git_fetch(app: AppHandle, repo_path: String, remote_name: Option<String>) -> Result<(), String> {
    remote::fetch(app, repo_path, remote_name).await
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, repo_path: String) -> Result<(), String> {
    remote::pull(app, repo_path).await
}

#[tauri::command]
pub async fn git_push(app: AppHandle, repo_path: String, set_upstream: bool) -> Result<(), String> {
    remote::push(app, repo_path, set_upstream).await
}
