use std::cell::RefCell;
use std::path::Path;

use git2::{Delta, Diff, DiffOptions, IndexAddOption, Signature};
use serde::{Deserialize, Serialize};

use super::repo::open;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffLine {
    pub origin: String,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffHunkInfo {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiffInfo {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub status: String,
    /// libgit2's own answer to "is either side of this delta binary".
    ///
    /// It exists because `status` cannot answer it: a changed PNG is `"modified"` exactly as a
    /// changed source file is, and both arrive with an empty `hunks` list. Without this flag the
    /// only honest thing a viewer could say about an empty diff was "there is no text to show",
    /// because naming the cause would have been a guess printed as a fact.
    pub binary: bool,
    pub hunks: Vec<DiffHunkInfo>,
}

/// `pub(super)` rather than private because `git::hunk` names the status it refuses in its
/// `HUNK_UNSUPPORTED` message, and it must be the *same* word the file lists already show for that
/// delta — two spellings of "typechange" would read as two different problems.
pub(super) fn diff_status_label(status: Delta) -> &'static str {
    match status {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Modified => "modified",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        Delta::Conflicted => "conflicted",
        Delta::Untracked => "untracked",
        Delta::Ignored => "ignored",
        _ => "unmodified",
    }
}

fn collect_diff(diff: &Diff) -> Result<Vec<FileDiffInfo>, String> {
    let files: RefCell<Vec<FileDiffInfo>> = RefCell::new(Vec::new());

    diff.foreach(
        &mut |delta, _progress| {
            files.borrow_mut().push(FileDiffInfo {
                old_path: delta.old_file().path().map(|p| p.display().to_string()),
                new_path: delta.new_file().path().map(|p| p.display().to_string()),
                status: diff_status_label(delta.status()).to_string(),
                binary: delta.flags().is_binary(),
                hunks: Vec::new(),
            });
            true
        },
        None,
        Some(&mut |_delta, hunk| {
            let header = String::from_utf8_lossy(hunk.header()).trim_end().to_string();
            if let Some(file) = files.borrow_mut().last_mut() {
                file.hunks.push(DiffHunkInfo { header, lines: Vec::new() });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            let content = String::from_utf8_lossy(line.content())
                .trim_end_matches('\n')
                .to_string();
            if let Some(file) = files.borrow_mut().last_mut() {
                if let Some(hunk) = file.hunks.last_mut() {
                    hunk.lines.push(DiffLine {
                        origin: (line.origin() as char).to_string(),
                        content,
                        old_lineno: line.old_lineno(),
                        new_lineno: line.new_lineno(),
                    });
                }
            }
            true
        }),
    )
    .map_err(|e| e.message().to_string())?;

    Ok(files.into_inner())
}

/// Large enough that every hunk effectively covers the whole file — the Changes tab
/// wants full-file context with the edited lines highlighted, not just the changed
/// lines with a few lines of context like a compact PR-review diff.
///
/// This is a **correctness** requirement, not a display preference: `src/lib/diffText.ts`
/// rebuilds both complete file texts out of the hunk list to feed Monaco's side-by-side
/// DiffEditor, and it can only do that because every context line of the file is in there.
/// Anything that shows a file split — the Changes screen's split mode, the editor's diff tab —
/// must be fed a diff produced at this context, or almost the whole file renders as deleted.
const FULL_FILE_CONTEXT_LINES: u32 = 1_000_000;

/// The working diff at a caller-chosen context. `None` means [`FULL_FILE_CONTEXT_LINES`].
///
/// The context is a parameter because full-file context is enormously expensive for a *list*: on
/// this repository 19 KB of real `git diff` expands to ~1.8 MB of JSON across ~16,700 line objects,
/// all of which cross the IPC boundary and are parsed, for a panel that only needs to know which
/// files changed and by how much. A caller that is going to render one file side-by-side asks for
/// full context — see [`get_file_diff`], which is the cheap way to get exactly that one file.
pub fn get_working_diff_with_context(
    path: &str,
    context_lines: Option<u32>,
) -> Result<Vec<FileDiffInfo>, String> {
    let repo = open(path)?;
    let mut opts = DiffOptions::new();
    // `include_untracked` alone only makes a new file *appear* in the diff as a bare
    // "untracked" delta with no hunks — `show_untracked_content` is what actually makes
    // libgit2 diff it against empty content so every line shows up as added, and
    // `recurse_untracked_dirs` does the same for a file sitting inside a brand-new untracked
    // directory (otherwise only the directory itself is reported, not the file in it).
    opts.include_untracked(true)
        .show_untracked_content(true)
        .recurse_untracked_dirs(true)
        .context_lines(context_lines.unwrap_or(FULL_FILE_CONTEXT_LINES));
    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    collect_diff(&diff)
}

/// The whole working diff at full file context — what every existing caller has always got.
pub fn get_working_diff(path: &str) -> Result<Vec<FileDiffInfo>, String> {
    get_working_diff_with_context(path, None)
}

/// The staged diff at a caller-chosen context. `None` means [`FULL_FILE_CONTEXT_LINES`].
pub fn get_staged_diff_with_context(
    path: &str,
    context_lines: Option<u32>,
) -> Result<Vec<FileDiffInfo>, String> {
    let repo = open(path)?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.context_lines(context_lines.unwrap_or(FULL_FILE_CONTEXT_LINES));
    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    collect_diff(&diff)
}

/// The whole staged diff at full file context — what every existing caller has always got.
pub fn get_staged_diff(path: &str) -> Result<Vec<FileDiffInfo>, String> {
    get_staged_diff_with_context(path, None)
}

/// One file's diff — the split view's and the editor diff tab's supply, and what an expanded row in
/// the Changes list asks for.
///
/// The point is that the *whole-file* context nobody can do without stays available without
/// paying for it across every changed file at once: libgit2 is told the pathspec up front, so it
/// never walks, reads or diffs the rest of the tree.
///
/// `context_lines` is `None` for [`FULL_FILE_CONTEXT_LINES`], which is what every desktop caller
/// wants and must keep getting: `src/lib/diffText.ts` rebuilds both complete file texts out of the
/// hunk list, and it can only do that when every context line is in there. A caller that renders a
/// *unified* diff and reconstructs nothing — the mobile client — passes a small number instead,
/// because at full context one file of a big repository is megabytes of JSON over wifi to draw a
/// screenful.
///
/// `Ok(None)` when that path has no diff on the requested side — the file was staged, discarded or
/// committed between the list being drawn and the row being opened, which is a race, not a failure.
pub fn get_file_diff(
    path: &str,
    file_path: &str,
    staged: bool,
    context_lines: Option<u32>,
) -> Result<Option<FileDiffInfo>, String> {
    let repo = open(path)?;
    let mut opts = DiffOptions::new();
    opts.context_lines(context_lines.unwrap_or(FULL_FILE_CONTEXT_LINES));
    opts.pathspec(file_path);

    let diff = if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
    } else {
        // Same three untracked flags as the full working diff, for the same reason: without them a
        // brand-new file opens as an empty delta with no lines at all.
        opts.include_untracked(true)
            .show_untracked_content(true)
            .recurse_untracked_dirs(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))
    }
    .map_err(|e| e.message().to_string())?;

    let files = collect_diff(&diff)?;
    // A pathspec can still match more than one delta (a rename reports both sides), so pick the one
    // that actually names the file rather than trusting the first entry. Falling back to index 0
    // covers a rename whose delta carries neither the old nor the new path verbatim; on an empty
    // result `nth(0)` is `None`, which is the "no diff on that side" answer.
    let wanted = files
        .iter()
        .position(|f| {
            f.new_path.as_deref() == Some(file_path) || f.old_path.as_deref() == Some(file_path)
        })
        .unwrap_or(0);
    Ok(files.into_iter().nth(wanted))
}

pub fn get_commit_diff(path: &str, oid: &str) -> Result<Vec<FileDiffInfo>, String> {
    let repo = open(path)?;
    let commit_oid = git2::Oid::from_str(oid).map_err(|e| e.message().to_string())?;
    let commit = repo.find_commit(commit_oid).map_err(|e| e.message().to_string())?;
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.message().to_string())?;
    collect_diff(&diff)
}

/// One file's change *in one commit*, against that commit's first parent, at full file context —
/// what clicking a blame annotation opens.
///
/// [`get_commit_diff`] cannot serve that view, for two separate reasons that are both fatal rather
/// than merely wasteful. It has no pathspec, so it walks and returns every file the commit touched
/// in order to show one; and it passes `None` for `DiffOptions`, which means libgit2's default three
/// lines of context — and anything rendered side by side must be produced at
/// [`FULL_FILE_CONTEXT_LINES`] or `src/lib/diffText.ts`'s `reconstructSides` rebuilds the left-hand
/// side out of context lines it never received and shows almost the whole file as deleted.
///
/// The commit's first parent, like [`get_commit_diff`] and like `git show`: a merge commit is
/// therefore reported as what it changed relative to the branch it was merged *into*. For a root
/// commit `parent(0)` fails, `parent_tree` is `None`, and `diff_tree_to_tree` reports the whole file
/// as added — which is the correct reading of "this file was created here", so there is no special
/// case for it.
///
/// `Ok(None)` means that commit didn't touch this path — the same contract as [`get_file_diff`], but
/// unlike there it is not a race and is barely reachable at all from the one caller: blame attributes a
/// line to a commit that changed the file *at this path* (no `track_copies_*`, no rename following), so
/// a commit named by a blame annotation has a delta here by construction, root commits and merges
/// included. What it is **not** is a case the editor has a rendering for: `EditorPane` keeps `viewMode`
/// at `diff` while `OpenTab.compare` is set, so a `None` leaves the pane on its loading state until the
/// user presses the diff toggle. Anything that widens the ways a caller can reach this — following
/// renames in the blame, or a second call site that passes a commit it did not get from one — has to
/// give that pane an empty state first.
pub fn get_commit_file_diff(
    path: &str,
    oid: &str,
    file_path: &str,
) -> Result<Option<FileDiffInfo>, String> {
    let repo = open(path)?;
    let commit_oid = git2::Oid::from_str(oid).map_err(|e| e.message().to_string())?;
    let commit = repo.find_commit(commit_oid).map_err(|e| e.message().to_string())?;
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

    let mut opts = DiffOptions::new();
    opts.context_lines(FULL_FILE_CONTEXT_LINES);
    opts.pathspec(file_path);

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    // Same rename-aware pick as `get_file_diff`: a pathspec can match both sides of a rename, so
    // choose the delta that actually names the path and fall back to the first one for a rename that
    // carries neither name verbatim. On an empty result `nth(0)` is `None`.
    let files = collect_diff(&diff)?;
    let wanted = files
        .iter()
        .position(|f| {
            f.new_path.as_deref() == Some(file_path) || f.old_path.as_deref() == Some(file_path)
        })
        .unwrap_or(0);
    Ok(files.into_iter().nth(wanted))
}

/// Resolves a PR's base/head to a commit. Since those are branch names as they exist on the
/// remote, the remote-tracking ref (`origin/<name>`) is preferred over a same-named local
/// branch that may be stale — a stale local branch is exactly what makes an up-to-date PR diff
/// come back empty. A caller may also pass a full ref path (e.g. a freshly-fetched
/// `refs/pull/<n>/head` PR ref), which is used verbatim.
fn resolve_branch_commit<'a>(repo: &'a git2::Repository, name: &str) -> Result<git2::Commit<'a>, String> {
    let candidates: Vec<String> = if name.starts_with("refs/") {
        vec![name.to_string()]
    } else {
        vec![format!("origin/{name}"), format!("refs/remotes/origin/{name}"), name.to_string()]
    };
    for candidate in candidates {
        if let Ok(obj) = repo.revparse_single(&candidate) {
            if let Ok(commit) = obj.peel_to_commit() {
                return Ok(commit);
            }
        }
    }
    Err(format!(
        "Could not find branch '{name}' locally or on origin — try fetching this repository first."
    ))
}

/// Diffs from the merge-base of `base`/`head` to `head`'s tip — the same "what would this
/// PR bring in" comparison Azure DevOps itself shows, computed locally via the repo's own
/// git data instead of Azure DevOps' diff/iterations API.
pub fn get_branch_diff(path: &str, base: &str, head: &str) -> Result<Vec<FileDiffInfo>, String> {
    let repo = open(path)?;
    let base_commit = resolve_branch_commit(&repo, base)?;
    let head_commit = resolve_branch_commit(&repo, head)?;
    let merge_base_oid = repo
        .merge_base(base_commit.id(), head_commit.id())
        .map_err(|e| e.message().to_string())?;
    let merge_base_commit = repo.find_commit(merge_base_oid).map_err(|e| e.message().to_string())?;
    let base_tree = merge_base_commit.tree().map_err(|e| e.message().to_string())?;
    let head_tree = head_commit.tree().map_err(|e| e.message().to_string())?;
    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)
        .map_err(|e| e.message().to_string())?;
    collect_diff(&diff)
}

/// Resolves a ref (branch, remote branch, tag, or raw SHA) to its full commit SHA. Used to record
/// which head commit a review ran against, so a re-review can tell whether anything changed.
pub fn resolve_sha(path: &str, refname: &str) -> Result<String, String> {
    let repo = open(path)?;
    let commit = resolve_branch_commit(&repo, refname)?;
    Ok(commit.id().to_string())
}

/// The files that changed between two refs (`from`..`to`), by path — the set a re-review needs so
/// findings on untouched files auto-persist instead of looking resolved.
pub fn changed_files_between(path: &str, from: &str, to: &str) -> Result<Vec<String>, String> {
    let files = get_branch_diff(path, from, to)?;
    Ok(files
        .iter()
        .filter_map(|f| f.new_path.clone().or_else(|| f.old_path.clone()))
        .collect())
}

/// One file's full content as of `refname` — the new side of a reviewed change, read straight out
/// of the object database.
///
/// The review's reading bundles need the whole method around a change, and a diff only carries its
/// three lines of context. Reading from the tree rather than from the working directory is what
/// makes that safe: the checkout is on whatever branch the user happens to have out, while the
/// review is about the pull request's head.
///
/// `Err` for anything that isn't text at that ref — a deletion, a binary blob, a path that does not
/// exist there. Callers treat that as "no content to show", never as a failed review.
pub fn file_at_ref(path: &str, refname: &str, file_path: &str) -> Result<String, String> {
    let repo = open(path)?;
    let commit = resolve_branch_commit(&repo, refname)?;
    let tree = commit.tree().map_err(|e| e.message().to_string())?;
    let entry = tree
        .get_path(Path::new(file_path))
        .map_err(|e| e.message().to_string())?;
    let object = entry.to_object(&repo).map_err(|e| e.message().to_string())?;
    let blob = object.as_blob().ok_or_else(|| format!("'{file_path}' is not a file at {refname}"))?;
    if blob.is_binary() {
        return Err(format!("'{file_path}' is binary"));
    }
    Ok(String::from_utf8_lossy(blob.content()).into_owned())
}

/// Every file path under `refname`, repository-relative with forward slashes.
///
/// From the commit's tree rather than from `search::list_files`, which walks the working directory:
/// the review's blast radius is about the pull request's target branch, and the checkout is on
/// whatever the user happens to have out.
pub fn list_tree(path: &str, refname: &str) -> Result<Vec<String>, String> {
    let repo = open(path)?;
    let commit = resolve_branch_commit(&repo, refname)?;
    let tree = commit.tree().map_err(|e| e.message().to_string())?;

    let mut out = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            if let Some(name) = entry.name() {
                out.push(format!("{dir}{name}").replace('\\', "/"));
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| e.message().to_string())?;
    Ok(out)
}

/// Flattens file diffs into plain unified-diff-ish text suitable for a Claude prompt.
pub fn render_diff_for_prompt(files: &[FileDiffInfo]) -> String {
    let mut out = String::new();
    for file in files {
        let path = file.new_path.as_deref().or(file.old_path.as_deref()).unwrap_or("?");
        out.push_str(&format!("--- {path} ({})\n", file.status));
        for hunk in &file.hunks {
            out.push_str(&hunk.header);
            out.push('\n');
            for line in &hunk.lines {
                out.push_str(&line.origin);
                out.push_str(&line.content);
                out.push('\n');
            }
        }
        out.push('\n');
    }
    out
}

pub fn stage_file(path: &str, file_path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let abs = Path::new(path).join(file_path);
    if abs.exists() {
        index.add_path(Path::new(file_path)).map_err(|e| e.message().to_string())?;
    } else {
        index.remove_path(Path::new(file_path)).map_err(|e| e.message().to_string())?;
    }
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn stage_all(path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn unstage_file(path: &str, file_path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let head = repo.head().map_err(|e| e.message().to_string())?;
    let head_commit = head.peel_to_commit().map_err(|e| e.message().to_string())?;
    repo.reset_default(Some(head_commit.as_object()), [file_path])
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn unstage_all(path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let head_tree = repo.head().map_err(|e| e.message().to_string())?.peel_to_tree().map_err(|e| e.message().to_string())?;
    index.read_tree(&head_tree).map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Discards unstaged working-directory changes for a file, restoring it to match the index.
pub fn discard_file_changes(path: &str, file_path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force().path(file_path);
    repo.checkout_index(Some(&mut index), Some(&mut cb))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Discards everything the "Changes" section lists: tracked files go back to what the index holds,
/// untracked files are deleted from disk. Staged content is deliberately left alone — this clears
/// exactly what that section shows, so a file staged *and* edited afterwards keeps its staged part.
/// Conflicted paths are skipped too: resolving a merge is the conflict banner's job, not this one.
pub fn discard_all_changes(path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repository".to_string())?
        .to_path_buf();

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.message().to_string())?;

    let mut tracked: Vec<String> = vec![];
    let mut untracked: Vec<String> = vec![];
    let mut conflicted = false;
    for entry in statuses.iter() {
        let Some(file_path) = entry.path() else { continue };
        let status = entry.status();
        if status.is_conflicted() {
            conflicted = true;
            continue;
        }
        if status.is_wt_new() {
            untracked.push(file_path.to_string());
        } else if status.is_wt_modified()
            || status.is_wt_deleted()
            || status.is_wt_renamed()
            || status.is_wt_typechange()
        {
            tracked.push(file_path.to_string());
        }
    }

    if !tracked.is_empty() {
        let mut index = repo.index().map_err(|e| e.message().to_string())?;

        // No pathspec, and that is the whole point: a *many-path* checkout is what breaks on
        // Windows.
        //
        // `checkout_action_wd_only` (libgit2 checkout.c:373-381) answers a working-directory
        // directory that matches no pathspec by calling `git_iterator_advance_into` on it, with no
        // ignore check in front — it cannot prove that nothing underneath will match, so it
        // descends into every non-matching directory, `node_modules` included. Each frame it
        // pushes then length-validates the *absolute* path of every dirent it reads
        // (iterator.c:1410) before any filtering, and on Windows that is a flat 260-character
        // count (fs_path.c:1657-1666). One pnpm path is over it and the whole discard dies with
        // "path too long".
        //
        // With no pathspec the match is vacuously true (pathspec.c:213-214), so the same walk goes
        // through `git_iterator_advance_over` instead (checkout.c:430) — and that one consults
        // `git_ignore__lookup` first and steps *over* an ignored directory without entering it.
        // Ignored trees are never opened, so the long path is never built; it is also dramatically
        // faster on a repo with a real `node_modules`.
        //
        // Nothing about what gets written changes: restoring "every tracked path whose working
        // tree differs from the index" is by definition the set `tracked` already holds, which is
        // still what decides whether there is anything to do at all. And FORCE on its own never
        // touches untracked or ignored files — removing those needs `REMOVE_UNTRACKED` /
        // `REMOVE_IGNORED` (checkout.c:437-442), which is exactly why the loop below deletes the
        // untracked ones by hand and stays confined to what the panel listed.
        if conflicted {
            // A merge is in progress, and a pathspec-free FORCE checkout would find each
            // conflicted path in the index at stages 1/2/3, delete the working file
            // (checkout.c:390-396) and rewrite it from those stages with fresh conflict markers —
            // throwing away whatever the user had already resolved by hand. That is the one
            // promise in this function's doc comment that an empty pathspec would break.
            //
            // So keep the paths here, but issue them *one at a time*. A single-path checkout makes
            // that path the pathspec's common prefix (`git_pathspec_prefix`, pathspec.c:21-45),
            // which libgit2 installs as the workdir iterator's start *and* end bound
            // (checkout.c:2584-2585); `node_modules` then sorts outside the range and is rejected
            // at the root frame (iterator.c:1201-1224) rather than descended. Batching the paths
            // is what collapses that prefix to nothing and removes the bound — which is the bug.
            //
            // Not `skip_unmerged(true)`: that disables only the *recreate* half (checkout.c:1228)
            // while the queued removal still fires, so it would delete the conflicted file outright.
            for file_path in &tracked {
                let mut cb = git2::build::CheckoutBuilder::new();
                cb.force().path(file_path);
                repo.checkout_index(Some(&mut index), Some(&mut cb))
                    .map_err(|e| format!("{file_path}: {}", e.message()))?;
            }
        } else {
            let mut cb = git2::build::CheckoutBuilder::new();
            cb.force();
            repo.checkout_index(Some(&mut index), Some(&mut cb))
                .map_err(|e| e.message().to_string())?;
        }
    }

    // Collected rather than returned on the first failure: a "discard everything" that stops at the
    // first file Windows has locked leaves the panel in a state nobody can reason about — some rows
    // gone, some not, and one error naming only the file it gave up on.
    let mut failures: Vec<String> = vec![];
    for file_path in &untracked {
        let full = workdir.join(file_path);
        match std::fs::remove_file(&full) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                failures.push(format!("{file_path}: {e}"));
                // The file is still there, so the empty-parent walk below has nothing to do.
                continue;
            }
        }
        // The directory a deleted untracked file lived in is often untracked itself (git records no
        // empty directories), so leaving it behind would show up as a stray empty folder in the
        // file tree. `remove_dir` only ever succeeds on an already-empty directory, so walking up
        // until it fails can't take anything with it.
        let mut parent = full.parent().map(|p| p.to_path_buf());
        while let Some(dir) = parent {
            if dir == workdir || std::fs::remove_dir(&dir).is_err() {
                break;
            }
            parent = dir.parent().map(|p| p.to_path_buf());
        }
    }

    if !failures.is_empty() {
        return Err(failures.join("; "));
    }

    Ok(())
}

pub fn commit(
    path: &str,
    message: &str,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<String, String> {
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;

    let sig = match (author_name, author_email) {
        (Some(name), Some(email)) => {
            Signature::now(&name, &email).map_err(|e| e.message().to_string())?
        }
        _ => repo.signature().map_err(|e| e.message().to_string())?,
    };

    let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| e.message().to_string())?;

    Ok(oid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::fs;

    /// A repo with one committed file, in a throwaway directory.
    fn fixture() -> (std::path::PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!("cf-diff-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        fs::write(dir.join("tracked.txt"), "original\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("tracked.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = Signature::now("Test", "test@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[]).unwrap();
        }
        (dir, repo)
    }

    /// The invariant `src/lib/diffText.ts` leans on. `reconstructSides` rebuilds both complete file
    /// texts out of the hunk list for Monaco's side-by-side DiffEditor, which only works while the
    /// diff carries every context line of the file. The *list* is allowed to be narrow — that is
    /// what `context_lines` is for, and it is where the JSON bloat lives — but the single-file
    /// command that feeds the split view must never be. Lowering it there would not read as a
    /// performance trade-off, it would render almost the whole file as deleted.
    #[test]
    fn one_file_comes_back_whole_even_when_the_list_is_narrow() {
        let (dir, repo) = fixture();
        let path = dir.to_str().unwrap();

        let mut lines: Vec<String> = (1..=30).map(|n| format!("line {n}")).collect();
        fs::write(dir.join("wide.txt"), format!("{}\n", lines.join("\n"))).unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("wide.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = Signature::now("Test", "test@example.com").unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "wide", &tree, &[&parent]).unwrap();
        }

        // One line changed in the middle of thirty.
        lines[14] = "line 15 edited".to_string();
        fs::write(dir.join("wide.txt"), format!("{}\n", lines.join("\n"))).unwrap();

        let narrow = get_working_diff_with_context(path, Some(3)).unwrap();
        let narrow_lines: usize =
            narrow.iter().flat_map(|f| f.hunks.iter()).map(|h| h.lines.len()).sum();
        assert!(narrow_lines < 20, "a narrow list diff must not carry the whole file, got {narrow_lines}");

        let whole = get_file_diff(path, "wide.txt", false, None).unwrap().expect("the edited file");
        // Exactly what `reconstructSides` does for the left-hand side.
        let original: Vec<&str> = whole
            .hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .filter(|l| l.origin != "+")
            .map(|l| l.content.as_str())
            .collect();
        assert_eq!(original.len(), 30, "the original side must be the whole file");
        assert_eq!(original[0], "line 1");
        assert_eq!(original[14], "line 15");

        fs::remove_dir_all(&dir).ok();
    }

    /// The same whole-file invariant as above, on the commit-vs-parent path — which is the reason
    /// `get_commit_file_diff` exists rather than the caller filtering `get_commit_diff`'s result:
    /// that one is produced at libgit2's default three lines of context, so the side-by-side view
    /// would render the rest of the file as deleted.
    #[test]
    fn one_file_in_one_commit_comes_back_whole_and_against_its_parent() {
        let (dir, repo) = fixture();
        let path = dir.to_str().unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();

        let lines: Vec<String> = (1..=30).map(|n| format!("line {n}")).collect();
        let commit_all = |message: &str| {
            let mut index = repo.index().unwrap();
            index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent]).unwrap()
        };

        fs::write(dir.join("wide.txt"), format!("{}\n", lines.join("\n"))).unwrap();
        // A second file in the same commit: the pathspec is what keeps it out of the answer.
        fs::write(dir.join("other.txt"), "unrelated\n").unwrap();
        commit_all("add wide and other");

        let mut edited = lines.clone();
        edited[14] = "line 15 edited".to_string();
        fs::write(dir.join("wide.txt"), format!("{}\n", edited.join("\n"))).unwrap();
        let second = commit_all("edit the middle of wide");

        let file = get_commit_file_diff(path, &second.to_string(), "wide.txt")
            .unwrap()
            .expect("wide.txt changed in that commit");
        assert_eq!(file.new_path.as_deref(), Some("wide.txt"));
        // Exactly what `reconstructSides` does for the left-hand side: the parent's whole file.
        let original: Vec<&str> = file
            .hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .filter(|l| l.origin != "+")
            .map(|l| l.content.as_str())
            .collect();
        assert_eq!(original.len(), 30, "the parent side must be the whole file");
        assert_eq!(original[14], "line 15");

        // A path the commit didn't touch is `None`, not an error and not the wrong file.
        assert!(get_commit_file_diff(path, &second.to_string(), "other.txt").unwrap().is_none());

        fs::remove_dir_all(&dir).ok();
    }

    /// A root commit has no parent to diff against, and the honest answer is "created here" — the
    /// whole file as added. No special case in the code, so this pins that `parent_tree: None` keeps
    /// behaving that way.
    #[test]
    fn a_file_created_in_the_first_commit_is_all_additions() {
        let (dir, repo) = fixture();
        let path = dir.to_str().unwrap();
        let root = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();

        let file = get_commit_file_diff(path, &root, "tracked.txt").unwrap().expect("added there");
        assert_eq!(file.status, "added");
        let lines: Vec<&str> = file.hunks.iter().flat_map(|h| h.lines.iter()).map(|l| l.origin.as_str()).collect();
        assert!(!lines.is_empty());
        assert!(lines.iter().all(|origin| *origin == "+"), "every line is an addition");

        fs::remove_dir_all(&dir).ok();
    }

    /// A path with nothing to show on the requested side is a race, not an error — the row was
    /// opened just after the file was staged.
    #[test]
    fn a_file_with_no_diff_on_that_side_is_none() {
        let (dir, _repo) = fixture();
        let path = dir.to_str().unwrap();
        assert!(get_file_diff(path, "tracked.txt", false, None).unwrap().is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discard_all_reverts_tracked_edits_and_removes_untracked_files() {
        let (dir, _repo) = fixture();
        let path = dir.to_str().unwrap();

        fs::write(dir.join("tracked.txt"), "edited\n").unwrap();
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("nested/new.txt"), "brand new\n").unwrap();

        discard_all_changes(path).unwrap();

        assert_eq!(fs::read_to_string(dir.join("tracked.txt")).unwrap(), "original\n");
        assert!(!dir.join("nested/new.txt").exists());
        assert!(!dir.join("nested").exists(), "the emptied untracked directory should go too");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discard_all_keeps_staged_content() {
        let (dir, repo) = fixture();
        let path = dir.to_str().unwrap();

        // Staged edit, then a further unstaged edit on top of it: discarding must roll back only
        // the second one, leaving the index exactly as the user staged it.
        fs::write(dir.join("tracked.txt"), "staged version\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("tracked.txt")).unwrap();
            index.write().unwrap();
        }
        fs::write(dir.join("tracked.txt"), "unstaged version\n").unwrap();

        discard_all_changes(path).unwrap();

        assert_eq!(fs::read_to_string(dir.join("tracked.txt")).unwrap(), "staged version\n");
        let status = repo.status_file(Path::new("tracked.txt")).unwrap();
        assert!(status.is_index_modified(), "the staged change must survive");
        assert!(!status.is_wt_modified(), "nothing unstaged should be left");

        fs::remove_dir_all(&dir).ok();
    }

    /// The reason `discard_all_changes` still issues a path per file while a merge is unresolved.
    ///
    /// The bulk path dropped its pathspec to stop libgit2 descending into ignored trees on Windows
    /// (see the comment there). A pathspec-free FORCE checkout would find a conflicted path at
    /// index stages 1/2/3, delete the working file and rewrite it from those stages with fresh
    /// conflict markers — silently destroying a resolution the user had already typed. This pins
    /// that the conflicted file is left exactly as it was found while the rest of the discard still
    /// happens.
    ///
    /// Platform-independent: the long-path failure itself is Windows-only and cannot be reproduced
    /// here, so what this test guards is the *contract* the fix had to preserve, not the crash.
    #[test]
    fn discard_all_leaves_a_conflicted_path_alone() {
        let (dir, repo) = fixture();
        let path = dir.to_str().unwrap();

        // A conflict, built by hand: the same path at all three merge stages.
        let base = repo.blob(b"base\n").unwrap();
        let ours = repo.blob(b"ours\n").unwrap();
        let theirs = repo.blob(b"theirs\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.remove_path(Path::new("tracked.txt")).unwrap();
            for (stage, oid) in [(1u16, base), (2, ours), (3, theirs)] {
                let entry = git2::IndexEntry {
                    ctime: git2::IndexTime::new(0, 0),
                    mtime: git2::IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: 0o100644,
                    uid: 0,
                    gid: 0,
                    file_size: 0,
                    id: oid,
                    // Stage lives in bits 12-13 of `flags`; anything else there is not a stage.
                    flags: stage << 12,
                    flags_extended: 0,
                    path: b"tracked.txt".to_vec(),
                };
                index.add(&entry).unwrap();
            }
            index.write().unwrap();
        }
        // What the user has typed while resolving. Nothing here may overwrite it.
        fs::write(dir.join("tracked.txt"), "my careful resolution\n").unwrap();
        fs::write(dir.join("other.txt"), "untracked\n").unwrap();

        discard_all_changes(path).unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("tracked.txt")).unwrap(),
            "my careful resolution\n",
            "a conflicted path is the conflict banner's business, not this button's",
        );
        assert!(!dir.join("other.txt").exists(), "the rest of the discard still has to happen");

        fs::remove_dir_all(&dir).ok();
    }
}
