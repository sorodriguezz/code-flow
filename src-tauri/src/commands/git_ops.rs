use tauri::AppHandle;

use crate::git::{blame, branch, diff, graph, hunk, identity, merge, remotes, repo, stash};
use crate::remote;

// ---------- why the read commands carry `(async)` and the write ones don't ----------
//
// A plain `#[tauri::command]` on a sync function runs **inline on the UI thread** — tauri's macro
// dispatches it through `body_blocking`, which executes inside the IPC handler. A repository with
// a lot of history makes `list_commits` or `get_working_diff` take long enough for the window to
// stop painting, and the OS to put "Not Responding" in the title bar. `(async)` on the *same sync
// function* makes the macro emit `body_async` instead, which spawns the unchanged body onto
// tauri's async runtime rather than running it in the IPC handler. The body stays sync
// deliberately: git2's handles are not `Send`, so an `async fn` holding one across an `.await`
// would not compile — the attribute is the mechanism that gets the work off this thread without
// touching the code that does it.
//
// Only reads get it, and that limit is load-bearing rather than cautious. Today the UI thread is
// an implicit global lock over the index: stage, unstage, discard and commit each open the
// repository themselves and cannot currently interleave with each other or with the watcher's
// `refreshStatus`. Moving those off the UI thread would make them genuinely concurrent and expose
// real races on `index.write()`. Reads are safe to run concurrently because libgit2 reads take
// their own snapshot — a read racing a write returns stale data or an error, never corruption.

/// Creates a repository in a folder that has stopped being one.
///
/// The repair half of `commands::repos::project_path_health` — the other half being removing the
/// project from the list. A write, so no `(async)`: see the note above.
#[tauri::command]
pub fn init_repository(repo_path: String) -> Result<(), String> {
    repo::init(&repo_path)
}

#[tauri::command(async)]
pub fn get_status(repo_path: String) -> Result<repo::RepoStatusInfo, String> {
    repo::get_status(&repo_path)
}

#[tauri::command(async)]
pub fn list_commits(repo_path: String, all_refs: bool, limit: usize) -> Result<Vec<graph::CommitInfo>, String> {
    graph::list_commits(&repo_path, all_refs, limit)
}

#[tauri::command(async)]
pub fn list_unpushed_commits(repo_path: String) -> Result<Vec<graph::CommitInfo>, String> {
    graph::list_unpushed_commits(&repo_path)
}

#[tauri::command(async)]
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
pub fn set_branch_locked(repo_path: String, name: String, locked: bool) -> Result<(), String> {
    branch::set_branch_locked(&repo_path, &name, locked)
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

#[tauri::command(async)]
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
pub fn rename_stash(repo_path: String, index: usize, new_message: String) -> Result<(), String> {
    stash::rename_stash(&repo_path, index, &new_message)
}

/// `context_lines` is optional and defaults to full-file context, so a caller that doesn't pass it
/// gets byte-for-byte what it always got. A caller that only needs the *list* of changed files
/// should pass a small number: at full context this command turns tens of kilobytes of real diff
/// into megabytes of JSON to cross the IPC boundary. Anything that renders a file side-by-side
/// must **not** lower it — see `git::diff::FULL_FILE_CONTEXT_LINES` and `src/lib/diffText.ts` —
/// and should ask for that one file through [`get_file_diff`] instead.
#[tauri::command(async)]
pub fn get_working_diff(
    repo_path: String,
    context_lines: Option<u32>,
) -> Result<Vec<diff::FileDiffInfo>, String> {
    diff::get_working_diff_with_context(&repo_path, context_lines)
}

/// Same contract as [`get_working_diff`]: absent `context_lines` means full-file context.
#[tauri::command(async)]
pub fn get_staged_diff(
    repo_path: String,
    context_lines: Option<u32>,
) -> Result<Vec<diff::FileDiffInfo>, String> {
    diff::get_staged_diff_with_context(&repo_path, context_lines)
}

/// One file's diff. Same contract as [`get_working_diff`]: absent `context_lines` means full-file
/// context, which is what the views that reconstruct both sides of the file need — the Changes
/// screen's split mode, the editor's diff tab, an expanded row. Every desktop caller omits it and
/// so gets byte-for-byte what it always got.
///
/// A caller that only *reads* a unified diff may pass a small number. That is not a shortcut for
/// the split views: lowering it there renders almost the whole file as deleted, see
/// `git::diff::FULL_FILE_CONTEXT_LINES`.
///
/// `null` when the path no longer has a diff on that side — the file was staged, discarded or
/// committed between the list being drawn and the row being opened.
#[tauri::command(async)]
pub fn get_file_diff(
    repo_path: String,
    path: String,
    staged: bool,
    context_lines: Option<u32>,
) -> Result<Option<diff::FileDiffInfo>, String> {
    diff::get_file_diff(&repo_path, &path, staged, context_lines)
}

#[tauri::command]
pub fn get_commit_diff(repo_path: String, oid: String) -> Result<Vec<diff::FileDiffInfo>, String> {
    diff::get_commit_diff(&repo_path, &oid)
}

/// One file's change in one commit, against that commit's first parent, at full file context — the
/// side-by-side counterpart to [`get_commit_diff`]'s whole-changeset list. `null` when that commit
/// didn't touch the path.
///
/// `(async)` where the neighbouring [`get_commit_diff`] doesn't have it: this one sits on a click
/// path in the editor, and full-file context over a large file is exactly the kind of work that
/// stops the window painting if it runs in the IPC handler. (That `get_commit_diff` lacks it is an
/// existing inconsistency, left alone here.)
#[tauri::command(async)]
pub fn get_commit_file_diff(
    repo_path: String,
    oid: String,
    path: String,
) -> Result<Option<diff::FileDiffInfo>, String> {
    diff::get_commit_file_diff(&repo_path, &oid, &path)
}

/// Who last changed each line of one file, as runs of lines rather than one object per line — see
/// `git::blame::BlameHunkInfo` for why that shape is the load-bearing part.
///
/// `contents` is `git blame`'s `--contents -`: pass the editor's unsaved buffer and lines the user
/// has just typed come back marked uncommitted instead of inheriting the attribution of whatever was
/// at that line number. Pass `null` to blame the file as committed, which is the cacheable case —
/// and the result carries the `head_oid` it was computed against so the caller can key on it.
#[tauri::command(async)]
pub fn get_file_blame(
    repo_path: String,
    path: String,
    contents: Option<String>,
) -> Result<blame::FileBlame, String> {
    blame::blame_file(&repo_path, &path, contents.as_deref())
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

// `(async)` runs this sync body on a worker instead of the main thread. Both discards open the
// repository and, for the whole-panel one, walk the working tree with untracked recursion — on a
// repo with a real `node_modules` that is seconds, and on the main thread those are seconds the
// window does not repaint, which is exactly what "the app freezes" looks like.
#[tauri::command(async)]
pub fn discard_file_changes(repo_path: String, file_path: String) -> Result<(), String> {
    diff::discard_file_changes(&repo_path, &file_path)
}

#[tauri::command(async)]
pub fn discard_all_changes(repo_path: String) -> Result<(), String> {
    diff::discard_all_changes(&repo_path)
}

// ---------- one hunk at a time — the editor's inline change peek ----------
//
// Three commands rather than one carrying an `op` string, for two reasons. It mirrors the
// `stage_file`/`unstage_file`/`discard_file_changes` triple above, so the whole-file and per-hunk
// verbs read the same way from TypeScript; and a destructive operation should be named destructively
// at its call site, where a reviewer sees it, rather than hidden behind a variable.
//
// Sync, no `(async)`, deliberately — see the header comment at the top of this file. All three take
// the index lock (`git_indexwriter_init`, `apply.c:860-864`), and the UI thread being an implicit
// global lock over the index is the only thing currently keeping them from interleaving with each
// other, with the whole-file variants, and with the watcher's `refreshStatus`.
//
// `context_lines` must be the context the caller *read the hunk at* — hunk boundaries are a function
// of it, so a mismatch makes every fingerprint fail. It crosses the wire instead of being a constant
// duplicated here so there is exactly one number to change: `LIST_DIFF_CONTEXT_LINES` in
// `src/state/repoStore.ts`.

/// Adds one hunk to the index and leaves the working tree alone — `git add -p`.
#[tauri::command]
pub fn stage_hunk(repo_path: String, hunk: hunk::HunkRef, context_lines: u32) -> Result<(), String> {
    hunk::apply_hunk(&repo_path, &hunk, hunk::HunkOp::Stage, context_lines)
}

/// Removes one hunk from the index and leaves the working tree alone — `git reset -p`.
#[tauri::command]
pub fn unstage_hunk(repo_path: String, hunk: hunk::HunkRef, context_lines: u32) -> Result<(), String> {
    hunk::apply_hunk(&repo_path, &hunk, hunk::HunkOp::Unstage, context_lines)
}

/// Throws one hunk of working-tree change away, restoring that region from the **index** — the same
/// contract as [`discard_file_changes`], so a file that is staged and then edited keeps its staged
/// part. Nothing here is recoverable: no reflog, no stash, no restore point. The caller confirms.
#[tauri::command]
pub fn discard_hunk(repo_path: String, hunk: hunk::HunkRef, context_lines: u32) -> Result<(), String> {
    hunk::apply_hunk(&repo_path, &hunk, hunk::HunkOp::Discard, context_lines)
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn is_merging(repo_path: String) -> Result<bool, String> {
    merge::is_merging(&repo_path)
}

#[tauri::command(async)]
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
