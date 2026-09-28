use tauri::AppHandle;

use crate::git::{
    bisect, blame, branch, conflict, diff, features, graph, history, hunk, identity, lines, merge, reflog, remotes, repo,
    stash, submodule, worktree,
};
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

/// Commits a local branch has that neither HEAD nor its upstream has — what deleting it would lose.
/// See `branch::unmerged_commit_count`.
#[tauri::command(async)]
pub fn branch_unmerged_count(repo_path: String, name: String) -> Result<usize, String> {
    branch::unmerged_commit_count(&repo_path, &name)
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

#[tauri::command]
pub fn track_remote_branch(repo_path: String, remote_branch: String) -> Result<String, String> {
    branch::track_remote_branch(&repo_path, &remote_branch)
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

/// The text the editor's gutter measures the buffer against — see [`diff::quick_diff_base`].
/// `None` when the file has no base (untracked, binary, not UTF-8).
#[tauri::command(async)]
pub fn quick_diff_base(repo_path: String, file_path: String, staged: bool) -> Result<Option<String>, String> {
    diff::quick_diff_base(&repo_path, &file_path, staged)
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

/// `(async)`, unlike the other writes — see the note at the top of this file for what that trades.
/// A repository with commit hooks or signing commits through `git commit` (see `git::features`), and a
/// `pre-commit` that runs a type check and a test suite takes a minute; on the UI thread that minute is
/// a frozen window. The race it opens is a benign one: the CLI holds `index.lock` for the whole commit,
/// so a stage clicked meanwhile fails with a lock error instead of interleaving, and the libgit2 commit
/// reads the index once, atomically, as it always has.
#[tauri::command(async)]
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

// ---------------------------------------------------------------------------
// History: paging, per-file log, and the three operations on an existing commit
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn list_commits_page(
    repo_path: String,
    all_refs: bool,
    skip: usize,
    limit: usize,
) -> Result<graph::CommitPage, String> {
    graph::list_commits_page(&repo_path, all_refs, skip, limit)
}

#[tauri::command(async)]
pub fn file_history(repo_path: String, rel_path: String, limit: usize) -> Result<Vec<graph::CommitInfo>, String> {
    graph::file_history(&repo_path, &rel_path, limit)
}

/// The message the amend dialog opens on — see `history::head_commit_message`.
#[tauri::command]
pub fn head_commit_message(repo_path: String) -> Result<String, String> {
    history::head_commit_message(&repo_path)
}

/// `(async)` for the reason [`commit`] gives: with hooks or signing it is `git commit --amend`.
#[tauri::command(async)]
pub fn amend_commit(
    repo_path: String,
    message: String,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<String, String> {
    history::amend_commit(&repo_path, &message, author_name, author_email)
}

#[tauri::command(async)]
pub fn revert_commit(
    repo_path: String,
    oid: String,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<String, String> {
    history::revert_commit(&repo_path, &oid, author_name, author_email)
}

#[tauri::command(async)]
pub fn cherry_pick_commit(
    repo_path: String,
    oid: String,
    commit_now: bool,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<String, String> {
    history::cherry_pick_commit(&repo_path, &oid, commit_now, author_name, author_email)
}

#[tauri::command(async)]
pub fn list_tags(repo_path: String) -> Result<Vec<history::TagInfo>, String> {
    history::list_tags(&repo_path)
}

#[tauri::command]
pub fn create_tag(
    repo_path: String,
    name: String,
    oid: String,
    message: String,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<(), String> {
    history::create_tag(&repo_path, &name, &oid, &message, author_name, author_email)
}

#[tauri::command]
pub fn delete_tag(repo_path: String, name: String) -> Result<(), String> {
    history::delete_tag(&repo_path, &name)
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
pub fn add_remote(repo_path: String, name: String, url: String) -> Result<(), String> {
    remotes::add_remote(&repo_path, &name, &url)
}

#[tauri::command]
pub fn remove_remote(repo_path: String, name: String) -> Result<(), String> {
    remotes::remove_remote(&repo_path, &name)
}

#[tauri::command]
pub fn get_git_identity() -> Result<identity::GitIdentity, String> {
    identity::get_identity()
}

#[tauri::command]
pub fn set_git_identity(name: String, email: String) -> Result<(), String> {
    identity::set_identity(&name, &email)
}

/// The "only this repository" answer to a commit that failed for want of a name and email — see
/// `identity::set_repo_identity`.
#[tauri::command]
pub fn set_repo_git_identity(repo_path: String, name: String, email: String) -> Result<(), String> {
    identity::set_repo_identity(&repo_path, &name, &email)
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

/// Which operation is half done, its unresolved paths (read whatever the state), and the message
/// git prepared for it — everything the conflicts banner draws from.
#[tauri::command(async)]
pub fn get_operation_state(repo_path: String) -> Result<merge::OperationState, String> {
    merge::operation_state(&repo_path)
}

/// The banner's Continue, whatever is in progress. A single merge, revert or cherry-pick is
/// committed here with `message` (or the one git prepared); a rebase or a multi-commit sequence is
/// git's own to walk, so that goes to `git <op> --continue` — see `merge::is_sequenced`.
#[tauri::command]
pub async fn continue_operation(app: AppHandle, repo_path: String, message: Option<String>) -> Result<(), String> {
    let state = merge::operation_state(&repo_path)?;
    let kind = state.kind.ok_or("nothing is in progress")?;
    if state.sequenced {
        return remote::sequencer(app, repo_path, kind, remote::SequencerAction::Continue).await;
    }
    // On a blocking thread: with hooks or signing this is `git commit`, and a hook can run for a
    // minute — too long to hold one of the async runtime's workers. See `git::features`.
    tauri::async_runtime::spawn_blocking(move || merge::continue_operation(&repo_path, message.as_deref()).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

/// The banner's Abort — the same split as [`continue_operation`]. The single-step undo touches only
/// the paths the operation wrote; see `merge::abort_operation`.
#[tauri::command]
pub async fn abort_operation(app: AppHandle, repo_path: String) -> Result<(), String> {
    let state = merge::operation_state(&repo_path)?;
    let kind = state.kind.ok_or("nothing is in progress")?;
    if state.sequenced {
        return remote::sequencer(app, repo_path, kind, remote::SequencerAction::Abort).await;
    }
    merge::abort_operation(&repo_path)
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

/// The answer to a pull refused because the branches diverged: merge, rebase or fast-forward only,
/// optionally remembered for the repository. A separate command rather than an argument to
/// `git_pull`, whose signature the phone's dispatcher calls as it is.
#[tauri::command]
pub async fn git_pull_with(
    app: AppHandle,
    repo_path: String,
    mode: remote::PullMode,
    remember: bool,
) -> Result<(), String> {
    remote::pull_with(app, repo_path, mode, remember).await
}

#[tauri::command]
pub async fn git_fetch_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    remote::fetch_branch(app, repo_path, branch).await
}

#[tauri::command]
pub async fn git_pull_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    remote::pull_branch(app, repo_path, branch).await
}

#[tauri::command]
pub async fn git_push(app: AppHandle, repo_path: String, set_upstream: bool) -> Result<(), String> {
    remote::push(app, repo_path, set_upstream).await
}

#[tauri::command]
pub async fn git_push_branch(app: AppHandle, repo_path: String, branch: String) -> Result<(), String> {
    remote::push_branch(app, repo_path, branch).await
}

/// Force push with lease, offered only after a push came back rejected — see
/// `remote::push_force_with_lease` for why it is never a bare `--force`.
#[tauri::command]
pub async fn git_push_force_with_lease(app: AppHandle, repo_path: String) -> Result<(), String> {
    remote::push_force_with_lease(app, repo_path).await
}

// ---------- lines — the Changes screen's gutter selection ----------
//
// The same three verbs as the per-hunk commands above, one level finer, and sync for the same reason:
// they write the index (or, for discard, take its lock through libgit2's apply). What crosses the wire
// is the drawn lines, never bytes to write — see `git::lines`.

/// Adds the selected lines to the index; the working tree is not touched.
#[tauri::command]
pub fn stage_lines(repo_path: String, selection: lines::LineSelection) -> Result<(), String> {
    lines::apply_lines(&repo_path, &selection, lines::LineOp::Stage)
}

/// Takes the selected lines back out of the index; the working tree is not touched.
#[tauri::command]
pub fn unstage_lines(repo_path: String, selection: lines::LineSelection) -> Result<(), String> {
    lines::apply_lines(&repo_path, &selection, lines::LineOp::Unstage)
}

/// Throws the selected lines of working-tree change away, back to the index copy. Not recoverable —
/// the caller confirms.
#[tauri::command]
pub fn discard_lines(repo_path: String, selection: lines::LineSelection) -> Result<(), String> {
    lines::apply_lines(&repo_path, &selection, lines::LineOp::Discard)
}

// ---------- hooks, signing, LFS ----------

/// What the repository has set up that decides the commit route — the Changes screen's indicator.
#[tauri::command(async)]
pub fn get_repo_features(repo_path: String) -> Result<features::RepoFeatures, String> {
    features::detect(&repo_path)
}

// ---------- the three-way conflict editor ----------

#[tauri::command(async)]
pub fn get_conflict_detail(repo_path: String, rel_path: String) -> Result<conflict::ConflictDetail, String> {
    conflict::detail(&repo_path, &rel_path)
}

/// The file re-merged from its stages with base sections — the editor's "start over".
#[tauri::command(async)]
pub fn get_conflict_merge_text(repo_path: String, rel_path: String) -> Result<String, String> {
    conflict::merged_text(&repo_path, &rel_path)
}

/// Writes the editor's result and stages it — "mark resolved".
#[tauri::command]
pub fn resolve_conflict_with_text(repo_path: String, rel_path: String, text: String) -> Result<(), String> {
    conflict::resolve_with_text(&repo_path, &rel_path, &text)
}

/// Resolves a modify/delete conflict as deleted — `git rm`.
#[tauri::command]
pub fn resolve_conflict_deleted(repo_path: String, rel_path: String) -> Result<(), String> {
    conflict::resolve_deleted(&repo_path, &rel_path)
}

// ---------- reflog and undo ----------

#[tauri::command(async)]
pub fn list_reflog(repo_path: String, limit: usize) -> Result<Vec<reflog::ReflogEntry>, String> {
    reflog::list(&repo_path, limit)
}

/// What "undo the last operation" would do, for the confirmation to describe. `null` when the last
/// entry is nothing this can undo.
#[tauri::command(async)]
pub fn get_undo_plan(repo_path: String) -> Result<Option<reflog::UndoPlan>, String> {
    reflog::undo_plan(&repo_path)
}

/// Carries out the plan, if HEAD is still `expected_head`. Returns the backup ref it wrote.
#[tauri::command]
pub fn undo_last_operation(repo_path: String, expected_head: String) -> Result<Option<String>, String> {
    reflog::undo(&repo_path, &expected_head)
}

/// "Restore to here" from the reflog view. Returns the backup ref it wrote first.
#[tauri::command]
pub fn restore_reflog_entry(repo_path: String, oid: String) -> Result<Option<String>, String> {
    reflog::restore(&repo_path, &oid)
}

// ---------- submodules ----------

#[tauri::command(async)]
pub fn list_submodules(repo_path: String) -> Result<Vec<submodule::SubmoduleInfo>, String> {
    submodule::list(&repo_path)
}

/// `git submodule update --init`, for one submodule or all of them. A network operation, so it runs
/// through `remote` with the same progress events and failure classification as a fetch.
#[tauri::command]
pub async fn git_submodule_update(
    app: AppHandle,
    repo_path: String,
    path: Option<String>,
    recursive: bool,
) -> Result<(), String> {
    remote::submodule_update(app, repo_path, path, recursive).await
}

// ---------- worktrees ----------
//
// Add and remove are `(async)`: they run `git worktree`, which checks out (or deletes) a whole tree —
// seconds on a large repository — and touch a *different* working tree from the one the UI thread's
// index writes are about.

#[tauri::command(async)]
pub fn list_worktrees(repo_path: String) -> Result<Vec<worktree::WorktreeInfo>, String> {
    worktree::list(&repo_path)
}

#[tauri::command(async)]
pub fn add_worktree(
    repo_path: String,
    target: String,
    branch: String,
    new_branch: bool,
    start_point: Option<String>,
) -> Result<(), String> {
    worktree::add(&repo_path, &target, &branch, new_branch, start_point.as_deref())
}

/// Refuses a worktree with local changes unless `force` — tagged `WORKTREE_DIRTY` so the UI can ask a
/// second time.
#[tauri::command(async)]
pub fn remove_worktree(repo_path: String, target: String, force: bool) -> Result<(), String> {
    worktree::remove(&repo_path, &target, force)
}

#[tauri::command(async)]
pub fn prune_worktrees(repo_path: String) -> Result<(), String> {
    worktree::prune(&repo_path)
}

// ---------- tags and branches on the remote ----------

#[tauri::command]
pub async fn git_push_tag(app: AppHandle, repo_path: String, remote_name: Option<String>, tag: String) -> Result<(), String> {
    remote::push_tag(app, repo_path, remote_name, tag).await
}

#[tauri::command]
pub async fn git_push_all_tags(app: AppHandle, repo_path: String, remote_name: Option<String>) -> Result<(), String> {
    remote::push_all_tags(app, repo_path, remote_name).await
}

#[tauri::command]
pub async fn git_delete_remote_tag(app: AppHandle, repo_path: String, remote_name: String, tag: String) -> Result<(), String> {
    remote::delete_remote_tag(app, repo_path, remote_name, tag).await
}

#[tauri::command]
pub async fn git_delete_remote_branch(app: AppHandle, repo_path: String, remote_branch: String) -> Result<(), String> {
    remote::delete_remote_branch(app, repo_path, remote_branch).await
}

// ---------- bisect ----------
//
// Through the CLI, and `(async)`: every verdict checks the next candidate out, which is a checkout of
// the whole tree and the same seconds a branch switch takes.

#[tauri::command(async)]
pub fn get_bisect_state(repo_path: String) -> Result<bisect::BisectState, String> {
    bisect::state(&repo_path)
}

/// Starts a bisect with its first verdict: `rev` is `bad` or `good` per `verdict`.
#[tauri::command(async)]
pub fn bisect_start(repo_path: String, verdict: String, rev: String) -> Result<bisect::BisectState, String> {
    bisect::start(&repo_path, &verdict, &rev)
}

/// `good`, `bad` or `skip` — for `rev`, or for the candidate when it is `null`.
#[tauri::command(async)]
pub fn bisect_mark(repo_path: String, verdict: String, rev: Option<String>) -> Result<bisect::BisectState, String> {
    bisect::mark(&repo_path, &verdict, rev.as_deref())
}

#[tauri::command(async)]
pub fn bisect_reset(repo_path: String) -> Result<(), String> {
    bisect::reset(&repo_path)
}
