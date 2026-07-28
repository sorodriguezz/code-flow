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
    pub hunks: Vec<DiffHunkInfo>,
}

fn diff_status_label(status: Delta) -> &'static str {
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
const FULL_FILE_CONTEXT_LINES: u32 = 1_000_000;

pub fn get_working_diff(path: &str) -> Result<Vec<FileDiffInfo>, String> {
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
        .context_lines(FULL_FILE_CONTEXT_LINES);
    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    collect_diff(&diff)
}

pub fn get_staged_diff(path: &str) -> Result<Vec<FileDiffInfo>, String> {
    let repo = open(path)?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.context_lines(FULL_FILE_CONTEXT_LINES);
    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    collect_diff(&diff)
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
    for entry in statuses.iter() {
        let Some(file_path) = entry.path() else { continue };
        let status = entry.status();
        if status.is_conflicted() {
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
        let mut cb = git2::build::CheckoutBuilder::new();
        cb.force();
        for file_path in &tracked {
            cb.path(file_path);
        }
        repo.checkout_index(Some(&mut index), Some(&mut cb))
            .map_err(|e| e.message().to_string())?;
    }

    for file_path in &untracked {
        let full = workdir.join(file_path);
        match std::fs::remove_file(&full) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{file_path}: {e}")),
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
}
