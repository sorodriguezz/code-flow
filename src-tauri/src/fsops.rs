use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    /// Repo-relative path, forward-slash normalized.
    pub path: String,
    pub is_dir: bool,
}

/// Resolves `rel_path` against `repo_path` and rejects anything that would escape it
/// (e.g. a crafted "../.." segment) — this app only ever reads/writes files the user
/// themselves picked from the tree, but it's a cheap guard to keep in place regardless.
///
/// Links are followed: this is what reading and saving go through, and a link to a file reads and
/// saves as that file — so it is where a link *leads* that has to be inside the repository. A path
/// with nothing at it yet, like the file a save is about to create, leads nowhere, and is the entry
/// itself as [`resolve_entry`] places it. Except a link to nothing, which is refused: the write
/// would follow it to wherever it points, and no check here has seen that.
fn resolve_within_repo(repo_path: &str, rel_path: &str) -> Result<PathBuf, String> {
    let entry = resolve_entry(repo_path, rel_path)?;
    let Ok(resolved) = entry.canonicalize() else {
        if std::fs::symlink_metadata(&entry).is_ok() {
            return Err(format!("{rel_path} is a broken link"));
        }
        return Ok(entry);
    };
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    if !resolved.starts_with(&base) {
        return Err("path escapes the repository root".to_string());
    }
    Ok(resolved)
}

/// Resolves the entry `rel_path` names **itself**, for the operations that act on an entry rather
/// than on what it holds: trashing, moving and renaming it.
///
/// Only the folder it sits in is canonicalized — links on the way there followed, and that folder
/// required to be inside the repository — and the last name is joined on as it is. So a link is the
/// link: trashing one leaves what it points at alone, wherever that is, and moving or renaming one
/// moves the link. Canonicalizing the whole path acted on the target instead: it trashed a whole
/// folder through a link to it, refused outright to touch a link leading out of the repository, and
/// moved or renamed the file out from under a link, leaving it dangling.
///
/// **`..` is refused, not resolved** — and so are a root and a drive prefix — before anything is
/// looked up. No path the tree hands over has one, and a path with nothing at it yet cannot be
/// canonicalized to find out where the `..` goes, while `Path::starts_with` compares components
/// without resolving them: `/repo/../escaped.txt` "starts with" `/repo`. That is how a save could
/// once create a file outside the repository.
fn resolve_entry(repo_path: &str, rel_path: &str) -> Result<PathBuf, String> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    let mut rel = PathBuf::new();
    for component in Path::new(rel_path).components() {
        match component {
            Component::Normal(name) => rel.push(name),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("path escapes the repository root".to_string());
            }
        }
    }
    // `""` is the root itself, which each caller that must refuse it refuses in its own words.
    let (Some(parent), Some(name)) = (rel.parent(), rel.file_name()) else {
        return Ok(base);
    };
    let parent = base
        .join(parent)
        .canonicalize()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("{rel_path} no longer exists"),
            _ => e.to_string(),
        })?;
    if !parent.starts_with(&base) {
        return Err("path escapes the repository root".to_string());
    }
    Ok(parent.join(name))
}

pub fn list_dir(repo_path: &str, sub_path: Option<String>) -> Result<Vec<FileEntry>, String> {
    let target = match &sub_path {
        Some(p) => resolve_within_repo(repo_path, p)?,
        None => Path::new(repo_path)
            .canonicalize()
            .map_err(|e| format!("invalid repo path: {e}"))?,
    };

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let is_dir = entry.file_type().map_err(|e| e.to_string())?.is_dir();
        let rel = match &sub_path {
            Some(p) => format!("{p}/{name}"),
            None => name.clone(),
        };
        entries.push(FileEntry {
            name,
            path: rel.replace('\\', "/"),
            is_dir,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// One line of a generated tree — see [`dir_tree`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeRow {
    /// Folders between this entry and the one the tree was generated on: `0` for its own contents.
    pub depth: usize,
    pub name: String,
    pub is_dir: bool,
    /// The last of its siblings — what draws `┗` rather than `┣` in front of it.
    pub last: bool,
}

/// A folder's structure, as the rows the explorer's "Generate Tree" prints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirTree {
    /// The folder's own name, or the repository's when the tree is of the root.
    pub name: String,
    /// Depth-first, each level in the order the explorer lists it: folders first, then files.
    pub rows: Vec<TreeRow>,
    /// The walk stopped at its entry cap, so the rows end before the folder does.
    pub truncated: bool,
}

/// How many levels a generated tree opens before it lists a folder without walking into it. Far
/// past any tree someone puts in a README; what it is actually for is a pathological chain of
/// nested folders, which would otherwise decide how deep this function recurses.
const TREE_MAX_DEPTH: usize = 64;

/// Walks `rel_dir` (repo-relative; `""` is the root) for the explorer's "Generate Tree": the text the
/// VS Code extension `file-tree-generator` prints, which the frontend renders from these rows.
///
/// It says what the explorer says, by construction. Every level is read with [`list_dir`], so `.git`
/// is skipped and the order is the tree's own, and `hidden` is the explorer's hidden-entries list
/// (`hiddenFilesStore`), taken out the way the tree takes them out. The extension does none of that —
/// it prints everything `readdirSync` returns, `.git` included — and the order is where the difference
/// would show: it lists folders first and then files, as this does, but each in `readdirSync`'s order,
/// which on macOS and Linux is byte order (`README.md` before `app.ts`), while the explorer sorts
/// without regard to case. A tree generated from a folder should read like the folder it came from.
///
/// **A folder git ignores is listed but not walked into.** `node_modules`, `target`, `dist` and a
/// virtualenv are in most repositories, hold more entries than the source does, and are never what a
/// tree of the project is meant to show — yet leaving them out altogether would draw a project that
/// does not match the explorer beside it. Asking git rather than keeping a list of names is what makes
/// this right for every ecosystem at once, the same way `search::walk` prunes. The folder the tree is
/// generated *on* is always walked, ignored or not — right-clicking `node_modules` is asking what is
/// in it — and since everything below it is ignored too, that tree is one level deep.
///
/// Flat rows rather than nested nodes: a nested structure is serialised by recursing once per level,
/// and so is every reader of it; a list of rows carries the same information at a constant depth.
pub fn dir_tree(
    repo_path: &str,
    rel_dir: &str,
    hidden: &[String],
    max_entries: usize,
) -> Result<DirTree, String> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    let rel = rel_dir.trim().trim_end_matches('/');
    let root = if rel.is_empty() {
        base.clone()
    } else {
        resolve_within_repo(repo_path, rel)?
    };
    if !root.is_dir() {
        return Err(format!("{rel_dir} is not a folder"));
    }
    // The name as the tree shows it: the path's last segment, or the checkout's folder for the root.
    let name = match rel.rsplit('/').next() {
        Some(last) if !last.is_empty() => last.to_string(),
        _ => root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
    };

    let mut walk = TreeWalk {
        repo_path,
        // Not a repository at all (or one this cannot open) is not a failure: nothing is ignored then,
        // and the entry cap is what keeps the walk bounded.
        git: git2::Repository::open(repo_path).ok(),
        hidden: hidden.iter().map(String::as_str).collect(),
        max_entries,
        rows: Vec::new(),
        truncated: false,
    };
    // The root's own listing is the one failure that is reported: without it there is no tree.
    walk.walk(rel, 0)?;
    Ok(DirTree {
        name,
        rows: walk.rows,
        truncated: walk.truncated,
    })
}

struct TreeWalk<'a> {
    repo_path: &'a str,
    git: Option<git2::Repository>,
    hidden: HashSet<&'a str>,
    max_entries: usize,
    rows: Vec<TreeRow>,
    truncated: bool,
}

impl TreeWalk<'_> {
    /// Whether git ignores the directory at `rel`. The trailing slash is what lets a directory-only
    /// rule (`build/`) match at all — the same probe `search::walk` makes.
    fn ignored_dir(&self, rel: &str) -> bool {
        self.git.as_ref().is_some_and(|repo| {
            repo.is_path_ignored(Path::new(&format!("{rel}/")))
                .unwrap_or(false)
        })
    }

    fn walk(&mut self, rel: &str, depth: usize) -> Result<(), String> {
        let sub = (!rel.is_empty()).then(|| rel.to_string());
        let entries: Vec<FileEntry> = list_dir(self.repo_path, sub)?
            .into_iter()
            .filter(|entry| !self.hidden.contains(entry.path.as_str()))
            .collect();
        let count = entries.len();
        for (at, entry) in entries.into_iter().enumerate() {
            if self.rows.len() >= self.max_entries {
                self.truncated = true;
                return Ok(());
            }
            let open = entry.is_dir && depth + 1 < TREE_MAX_DEPTH && !self.ignored_dir(&entry.path);
            let path = entry.path;
            self.rows.push(TreeRow {
                depth,
                name: entry.name,
                is_dir: entry.is_dir,
                last: at + 1 == count,
            });
            if open {
                // A folder that cannot be read — permissions, or gone since its parent was listed —
                // is drawn empty rather than failing the whole tree over one branch.
                let _ = self.walk(&path, depth + 1);
                if self.truncated {
                    return Ok(());
                }
            }
        }
        Ok(())
    }
}

pub fn read_file_text(repo_path: &str, rel_path: &str) -> Result<String, String> {
    let full = resolve_within_repo(repo_path, rel_path)?;
    // Checked explicitly so a folder reaching this by mistake says so, instead of surfacing the
    // OS's "Is a directory (os error 21)" as the file's contents.
    if full.is_dir() {
        return Err(format!("{rel_path} is a folder, not a file"));
    }
    std::fs::read_to_string(&full).map_err(|e| e.to_string())
}

pub fn write_file_text(repo_path: &str, rel_path: &str, content: &str) -> Result<(), String> {
    let full = resolve_within_repo(repo_path, rel_path)?;
    std::fs::write(&full, content).map_err(|e| e.to_string())
}

/// Writes raw bytes to an **absolute** path chosen by the user in a native save dialog.
///
/// Deliberately not scoped to a repo like the rest of this module: the whole point of an export
/// is that it lands wherever the user pointed the dialog — Desktop, Downloads, a scratch folder.
/// The dialog *is* the authorisation here, which is why this takes a path rather than a
/// directory-plus-name the caller could have assembled from something else.
pub fn write_file_bytes(path: &str, contents: &[u8]) -> Result<(), String> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(format!("expected an absolute path, got: {path}"));
    }
    if let Some(parent) = target.parent() {
        if !parent.is_dir() {
            return Err(format!("no such folder: {}", parent.display()));
        }
    }
    std::fs::write(target, contents).map_err(|e| e.to_string())
}

/// Moves a file or directory into `dest_dir` (repo-relative; `""` is the repo root), keeping its
/// name. Returns the new repo-relative path.
///
/// This is what the explorer's drag-and-drop calls, so the guards matter more than usual — a
/// dragged row is a much easier thing to get wrong than a typed command:
/// - both ends are resolved inside the repo, so a drag can never write outside it;
/// - a link is moved as the link, never as the file or folder it points at — see `resolve_entry`;
/// - moving a directory into itself (or into its own descendant) is rejected, which the
///   filesystem would otherwise turn into a lost subtree;
/// - an existing name at the destination is refused rather than overwritten.
pub fn move_path(repo_path: &str, from_rel: &str, dest_dir: &str) -> Result<String, String> {
    let source = resolve_entry(repo_path, from_rel)?;
    let name = source
        .file_name()
        .ok_or_else(|| format!("cannot move {from_rel}"))?
        .to_owned();

    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    let dest = if dest_dir.trim().is_empty() {
        base.clone()
    } else {
        resolve_within_repo(repo_path, dest_dir)?
    };
    if !dest.is_dir() {
        return Err(format!("{dest_dir} is not a folder"));
    }

    // Comparing canonical paths, so a symlinked route into the subtree is caught too. A link to a
    // folder never matches — no canonical path runs through a link — so it may go anywhere, into
    // that folder included: only the link moves.
    if source.is_dir() && dest.starts_with(&source) {
        return Err("cannot move a folder into itself".to_string());
    }
    let target = dest.join(&name);
    if target == source {
        // Dropped back where it already lives — not an error, just nothing to do.
        return Ok(from_rel.to_string());
    }
    // `symlink_metadata` rather than `exists`, which asks about a link's target: a link to nothing
    // still holds its name, and `rename` would replace it without a word.
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!("{} already exists here", name.to_string_lossy()));
    }

    std::fs::rename(&source, &target).map_err(|e| e.to_string())?;
    Ok(target
        .strip_prefix(&base)
        .map_err(|_| "moved outside the repository".to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// What a drop from the file manager actually did.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportOutcome {
    /// Repo-relative paths of everything that landed, in the order it was dropped.
    pub copied: Vec<String>,
    /// The names left alone because the destination already had one. Reported rather than
    /// overwritten, and rather than failing the other twenty files dropped alongside them.
    pub skipped: Vec<String>,
}

/// Copies files and folders **into** the repo from anywhere on disk — dragging a selection out of
/// Finder or Explorer and dropping it on the editor.
///
/// The sources are absolute paths handed over by the platform's own drag, and that drag is the
/// authorisation, the same way the save dialog is for `write_file_bytes`: nothing gets read that
/// the user didn't pick up themselves. The *destination* is this app's to guard, and it is:
/// - resolved inside the repo, so no drop can write outside the project;
/// - never overwritten — a name already taken is skipped and reported back, because a drop is one
///   flick of the wrist away from being the wrong folder and a replaced file has no trash to come
///   back from;
/// - never a folder's own descendant, which would copy the folder into itself until the disk
///   filled up.
pub fn copy_into(
    repo_path: &str,
    dest_dir: &str,
    sources: &[String],
) -> Result<ImportOutcome, String> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    let dest = if dest_dir.trim().is_empty() {
        base.clone()
    } else {
        resolve_within_repo(repo_path, dest_dir)?
    };
    if !dest.is_dir() {
        return Err(format!("{dest_dir} is not a folder"));
    }

    let mut outcome = ImportOutcome {
        copied: Vec::new(),
        skipped: Vec::new(),
    };
    for source in sources {
        let source = Path::new(source)
            .canonicalize()
            .map_err(|e| format!("{source}: {e}"))?;
        let name = source
            .file_name()
            .ok_or_else(|| format!("cannot copy {}", source.display()))?
            .to_owned();
        // Canonical at both ends, so a symlinked route into the subtree is caught too.
        if source.is_dir() && dest.starts_with(&source) {
            return Err(format!(
                "cannot copy {} into itself",
                name.to_string_lossy()
            ));
        }
        let target = dest.join(&name);
        if target.exists() {
            outcome.skipped.push(name.to_string_lossy().to_string());
            continue;
        }
        if source.is_dir() {
            copy_tree(&source, &target)?;
        } else {
            std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
        }
        outcome.copied.push(
            target
                .strip_prefix(&base)
                .map_err(|_| "copied outside the repository".to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
        );
    }
    Ok(outcome)
}

/// Recursive copy of a directory, for `copy_into`.
///
/// Links are not followed as links. `file_type` reports what the entry *is* rather than what it
/// points at, so a link to a file is copied as the file it names — which is what dropping that
/// file directly would have done — and a link to a directory is left behind, since following one
/// can walk a cycle straight back into the folder being copied.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&source, &target)?;
        } else if kind.is_file() || source.is_file() {
            std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copies a file or folder that is already in the repo into `dest_dir` (repo-relative; `""` is the
/// root) — the explorer's Copy then Paste. Returns the new repo-relative path.
///
/// **A name that is taken is never overwritten.** The copy lands under the next free name in VS
/// Code's own sequence — `a.ts`, `a copy.ts`, `a copy 2.ts` — which is also what makes pasting a file
/// back into its own folder a duplicate rather than an error. See [`next_copy_name`].
///
/// The rest of the guards are `copy_into`'s: both ends are resolved inside the repo, and a folder is
/// refused as its own destination, directly or through a descendant, which would otherwise copy it
/// into itself until the disk filled up.
pub fn copy_path(repo_path: &str, from_rel: &str, dest_dir: &str) -> Result<String, String> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    let source = resolve_within_repo(repo_path, from_rel)?;
    if source == base {
        return Err("cannot copy the repository root".to_string());
    }
    if !source.exists() {
        return Err(format!("{from_rel} no longer exists"));
    }
    // The name the tree shows, i.e. the path's own last segment — not `source`'s, which has been
    // canonicalized and so, for a symlink, is its target's name.
    let name = Path::new(from_rel.trim_end_matches('/'))
        .file_name()
        .ok_or_else(|| format!("cannot copy {from_rel}"))?
        .to_string_lossy()
        .into_owned();

    let dest = if dest_dir.trim().is_empty() {
        base.clone()
    } else {
        resolve_within_repo(repo_path, dest_dir)?
    };
    if !dest.is_dir() {
        return Err(format!("{dest_dir} is not a folder"));
    }
    let is_dir = source.is_dir();
    // Canonical at both ends, so a symlinked route into the subtree is caught too.
    if is_dir && dest.starts_with(&source) {
        return Err(format!("cannot copy {name} into itself"));
    }

    let target = reserve_copy_target(&dest, &name, is_dir)?;
    let copied = if is_dir {
        copy_tree(&source, &target)
    } else {
        // Over the empty placeholder `reserve_copy_target` created, which this call owns.
        std::fs::copy(&source, &target)
            .map(|_| ())
            .map_err(|e| e.to_string())
    };
    if let Err(e) = copied {
        // What was reserved is taken back: a half-copied folder, or an empty file with a real name,
        // is litter that looks like a result. It is only ever this call's own new entry.
        let _ = if is_dir {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        return Err(e);
    }
    Ok(target
        .strip_prefix(&base)
        .map_err(|_| "copied outside the repository".to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// A ceiling on the names `reserve_copy_target` tries — only a folder already holding thousands of
/// copies of one file could reach it, and it keeps a filesystem that misreports "exists" from
/// turning the loop into a hang.
const MAX_COPY_NAME_TRIES: usize = 10_000;

/// Claims the first free name for a copy of `name` inside `dest`, by creating it.
///
/// Created rather than merely checked: `create_dir` and `create_new` fail when anything already
/// holds the name — a file, a folder, even a dangling symlink — so the name is taken atomically and
/// the copy can never land on something that appeared between a check and a write.
fn reserve_copy_target(dest: &Path, name: &str, is_dir: bool) -> Result<PathBuf, String> {
    let mut candidate = name.to_string();
    for _ in 0..MAX_COPY_NAME_TRIES {
        let target = dest.join(&candidate);
        let reserved = if is_dir {
            std::fs::create_dir(&target)
        } else {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map(|_| ())
        };
        match reserved {
            Ok(()) => return Ok(target),
            // The second test is for the platforms that report a taken name as something other than
            // `AlreadyExists` — creating a file over a folder on Windows answers "access denied".
            Err(e)
                if e.kind() == std::io::ErrorKind::AlreadyExists
                    || std::fs::symlink_metadata(&target).is_ok() =>
            {
                candidate = next_copy_name(&candidate, is_dir);
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!("no free name left for a copy of {name}"))
}

/// The name after `name` in VS Code's "simple" incremental naming (`explorer.incrementalNaming`), so a
/// copy pasted here is called what the same paste in VS Code would call it:
///
/// `a.ts` → `a copy.ts` → `a copy 2.ts` → `a copy 3.ts`, and `src` → `src copy` → `src copy 2`.
///
/// The counter goes before the extension, where people look for it. A folder has no extension —
/// `v1.2` becomes `v1.2 copy` — and neither does a dotfile: `.env` becomes `.env copy`, the way
/// Node's `extname` (which VS Code uses) reads a leading dot as part of the name.
pub fn next_copy_name(name: &str, is_dir: bool) -> String {
    let (stem, ext) = if is_dir { (name, "") } else { split_extension(name) };
    // `/^(.+ copy)( \d+)?$/` in VS Code, taken apart by hand: first `… copy`, then `… copy N`.
    if stem.strip_suffix(" copy").is_some_and(|before| !before.is_empty()) {
        return format!("{stem} 2{ext}");
    }
    if let Some((head, number)) = stem.rsplit_once(' ') {
        let counted = !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit());
        if counted && head.strip_suffix(" copy").is_some_and(|before| !before.is_empty()) {
            // VS Code's two corner cases, kept: `copy 0` steps back to plain `copy`, and a counter too
            // large to add one to starts a fresh ` copy` rather than overflowing.
            return match number.parse::<u64>() {
                Ok(0) => format!("{head}{ext}"),
                Ok(n) if n < (1 << 30) => format!("{head} {}{ext}", n + 1),
                _ => format!("{stem} copy{ext}"),
            };
        }
    }
    format!("{stem} copy{ext}")
}

/// `name` split before its extension, the way Node's `path.extname` splits it: at the last dot,
/// unless that dot is the first character.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        None | Some(0) => (name, ""),
        Some(dot) => name.split_at(dot),
    }
}

/// Resolves the target of a *creation*, which by definition doesn't exist yet — nor, for a nested
/// name, do the folders it goes in, so there may be no parent to canonicalize the way
/// [`resolve_entry`] does. Requiring every component to be a plain name is the guard against `..`
/// here, and it also rejects the empty/whitespace names the explorer's inline input can produce.
///
/// **The folders on the way that are there are resolved, though.** `create_dir_all` and
/// `create_new` follow a link among them wherever it leads, so with `out` a link to a folder outside
/// the repository, `out/new.txt` joined on as it is was created in that folder. The deepest folder
/// on the way that is there is canonicalized instead, and has to be inside the repository; the names
/// below it are joined onto where it leads, and none of them is there yet, so none is a link. A link
/// counts as there even when it leads nowhere, and is refused: passed over as a folder to create, it
/// would be followed the moment what it points at appeared.
///
/// The last name is joined on as it is, as in `resolve_entry`: whatever already holds it — a link
/// too, wherever it leads — makes it taken, and neither creation writes through a link there.
fn resolve_new_path(repo_path: &str, rel_path: &str) -> Result<PathBuf, String> {
    let rel = rel_path.trim();
    if rel.is_empty() {
        return Err("name cannot be empty".to_string());
    }
    let candidate = Path::new(rel);
    let plain = candidate
        .components()
        .all(|c| matches!(c, Component::Normal(_)));
    if candidate.is_absolute() || !plain {
        return Err(format!("invalid path: {rel_path}"));
    }
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    let target = base.join(candidate);
    // The folders the name goes in, innermost first, up to the repository root: that one is always
    // there, and nothing above it is looked at. `symlink_metadata`, so a link is there whatever it
    // leads to.
    let existing = target
        .ancestors()
        .skip(1)
        .find(|folder| *folder == base || std::fs::symlink_metadata(folder).is_ok())
        .unwrap_or(&base);
    let resolved = existing.canonicalize().map_err(|e| {
        if existing.is_symlink() {
            let name = existing.strip_prefix(&base).unwrap_or(existing);
            format!("{} is a broken link", name.display())
        } else {
            e.to_string()
        }
    })?;
    let rest = match target.strip_prefix(existing) {
        Ok(rest) if resolved.starts_with(&base) => rest,
        _ => return Err("path escapes the repository root".to_string()),
    };
    let mut full = resolved.join(rest);
    // `strip_prefix` drops a trailing slash — the one thing that makes `new.txt/` a folder's name,
    // which `create_new` refuses. Put back, so it still refuses it.
    if rel.ends_with(std::path::is_separator) {
        full.as_mut_os_string().push(std::path::MAIN_SEPARATOR_STR);
    }
    Ok(full)
}

/// Creates a directory (and any missing parents, so `a/b/c` works in one go, like typing a
/// nested name into VS Code's explorer).
pub fn create_dir(repo_path: &str, rel_path: &str) -> Result<(), String> {
    let full = resolve_new_path(repo_path, rel_path)?;
    if full.exists() {
        return Err(format!("{} already exists", rel_path.trim()));
    }
    std::fs::create_dir_all(&full).map_err(|e| e.to_string())
}

/// Creates an empty file, plus any missing parent directories. `create_new` so an existing
/// file is reported back instead of being silently truncated.
pub fn create_file(repo_path: &str, rel_path: &str) -> Result<(), String> {
    let full = resolve_new_path(repo_path, rel_path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&full)
        .map(|_| ())
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("{} already exists", rel_path.trim()),
            _ => e.to_string(),
        })
}

/// Renames a file or directory in place, keeping it in the same parent. Returns the new
/// repo-relative path.
///
/// The new name must be a single plain name: renaming is for *naming*, and a slash typed into that
/// box would quietly turn it into a move, with the folder it lands in created on the way. Moving is
/// already a drag in the tree, where you can see the destination.
///
/// A link is renamed as the link, never as the file it points at — see `resolve_entry`.
pub fn rename_path(repo_path: &str, from_rel: &str, new_name: &str) -> Result<String, String> {
    let name = new_name.trim();
    if name.is_empty() {
        return Err("name cannot be empty".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("a name cannot contain a path separator".to_string());
    }
    if name == "." || name == ".." {
        return Err(format!("invalid name: {name}"));
    }

    let source = resolve_entry(repo_path, from_rel)?;
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    if source == base {
        return Err("cannot rename the repository root".to_string());
    }
    let parent = source
        .parent()
        .ok_or_else(|| format!("cannot rename {from_rel}"))?;
    let target = parent.join(name);
    if target == source {
        // Confirmed without changing anything — not an error, just nothing to do.
        return Ok(from_rel.to_string());
    }
    // Case-only renames on a case-insensitive filesystem (`readme.md` → `README.md`) land here with
    // the new name already answering, for what is the *same* entry, so `rename` handles them rather
    // than being refused. Anything else keeping that name is a real collision — a link to nothing
    // included, which `exists()` would miss and `rename` would replace.
    if std::fs::symlink_metadata(&target).is_ok() && !same_entry(&target, &source) {
        return Err(format!("{name} already exists"));
    }

    std::fs::rename(&source, &target).map_err(|e| e.to_string())?;
    Ok(target
        .strip_prefix(&base)
        .map_err(|_| "renamed outside the repository".to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// Whether two paths name the same entry on disk, which is how a case-only rename is told apart
/// from a collision on a case-insensitive filesystem.
///
/// A link is compared as itself, never by where it leads: a link and the file it names canonicalize
/// to one path, and taking them for one entry let a rename of either onto the other replace it. On
/// Unix a link has an inode of its own to compare; elsewhere nothing stable identifies one, so a
/// link never matches there, and a case-only rename of one is refused like a collision. Everything
/// else is still compared by canonical path, which — unlike an inode — keeps two hard links to one
/// file apart: `rename` between those succeeds by doing nothing.
fn same_entry(a: &Path, b: &Path) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (a.symlink_metadata(), b.symlink_metadata()) else {
        return false;
    };
    if meta_a.file_type().is_symlink() || meta_b.file_type().is_symlink() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            return meta_a.dev() == meta_b.dev() && meta_a.ino() == meta_b.ino();
        }
        #[cfg(not(unix))]
        return false;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Moves a file or directory to the OS trash.
///
/// Not `remove_dir_all`: this is reached by right-clicking a row in a tree, which is a much easier
/// thing to do by accident than typing `rm -rf`, and a folder of uncommitted work has nothing to
/// restore it from. The trash is the undo, and it is the one users already know how to open.
///
/// A link is trashed as the link, and what it points at stays where it is — see `trash_target`.
pub fn delete_path(repo_path: &str, rel_path: &str) -> Result<(), String> {
    trash::delete(trash_target(repo_path, rel_path)?).map_err(|e| e.to_string())
}

/// What [`delete_path`] hands the trash: the entry `rel_path` names, a link as the link. The
/// `trash` crate keeps it that way — it canonicalizes only the parent, and documents that a link is
/// removed and its target left intact. Split out so tests can check what would be trashed without
/// putting anything in the real trash.
fn trash_target(repo_path: &str, rel_path: &str) -> Result<PathBuf, String> {
    let target = resolve_entry(repo_path, rel_path)?;
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    if target == base {
        return Err("cannot delete the repository root".to_string());
    }
    // `symlink_metadata` rather than `exists`, which asks about a link's target: a link to nothing
    // is still a row in the tree, and still something to trash.
    if std::fs::symlink_metadata(&target).is_err() {
        return Err(format!("{rel_path} no longer exists"));
    }
    Ok(target)
}

/// Opens a repo-relative file with the OS's default application. Implemented directly
/// with the `open` crate (rather than the opener plugin's JS API) so path joining goes
/// through `Path::join` instead of naive string concatenation on the frontend, which was
/// producing mixed-separator paths on Windows that the plugin's scope check rejected.
pub fn open_in_default_app(repo_path: &str, rel_path: &str) -> Result<(), String> {
    let full = resolve_within_repo(repo_path, rel_path)?;
    open::that(full).map_err(|e| e.to_string())
}

/// Opens a directory in the OS's file manager (Explorer on Windows, Finder on macOS) —
/// `open::that` on a directory launches the platform's default handler for it, which is
/// the file manager rather than an "open with" prompt.
pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    open::that(path).map_err(|e| e.to_string())
}

/// Opens a directory in VS Code via the `code` CLI. `code` is a `.cmd` shim on Windows —
/// spawning it directly (rather than through `cmd /C`) fails to launch, the same issue as
/// `npx` in `skills_cmd.rs`.
pub fn open_in_vscode(path: &str) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut cmd = crate::proc::std_command("cmd");
        cmd.args(["/C", "code"]);
        cmd
    } else {
        crate::proc::std_command("code")
    };
    cmd.arg(path)
        .spawn()
        .map_err(|e| format!("failed to launch VS Code (is `code` on PATH?): {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-fsops-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A repository one level down in a folder of its own, as `(folder, repo)` — so what may appear
    /// *beside* the repository is a question about a directory the test owns, not the shared temp dir.
    fn repo_in_own_folder() -> (PathBuf, PathBuf) {
        let folder = temp_repo();
        let repo = folder.join("repo");
        std::fs::create_dir(&repo).unwrap();
        (folder, repo)
    }

    /// The names in `dir`, sorted: what a test compares to say nothing else appeared there.
    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Whether `path` is a link itself, whatever it points at.
    #[cfg(unix)]
    fn is_link(path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
    }

    #[test]
    fn creates_nested_file_and_dir() {
        let repo = temp_repo();
        let root = repo.to_string_lossy().to_string();

        create_dir(&root, "src/nested").unwrap();
        assert!(repo.join("src/nested").is_dir());

        create_file(&root, "src/nested/new.ts").unwrap();
        assert_eq!(read_file_text(&root, "src/nested/new.ts").unwrap(), "");

        std::fs::remove_dir_all(&repo).ok();
    }

    /// The explorer's drag-and-drop calls this, so the guards are the test: a mis-aimed drop must
    /// fail loudly rather than overwrite a file or swallow a directory into itself.
    #[test]
    fn moves_within_the_repo_and_refuses_the_destructive_cases() {
        let repo = temp_repo();
        let root = repo.to_string_lossy().to_string();
        create_dir(&root, "src/nested").unwrap();
        create_dir(&root, "other").unwrap();
        create_file(&root, "src/a.ts").unwrap();
        create_file(&root, "other/a.ts").unwrap();

        // Into a sibling folder, then back out to the repo root.
        assert_eq!(move_path(&root, "src/a.ts", "src/nested").unwrap(), "src/nested/a.ts");
        assert!(repo.join("src/nested/a.ts").is_file());
        assert_eq!(move_path(&root, "src/nested/a.ts", "").unwrap(), "a.ts");
        assert!(repo.join("a.ts").is_file());

        // A name already taken at the destination is refused, not overwritten.
        assert!(move_path(&root, "other/a.ts", "").is_err());
        assert!(repo.join("other/a.ts").is_file());

        // A folder cannot swallow itself, directly or through a descendant.
        assert!(move_path(&root, "src", "src").is_err());
        assert!(move_path(&root, "src", "src/nested").is_err());
        assert!(repo.join("src/nested").is_dir());

        // Dropped back where it already lives: a no-op, not a failure.
        assert_eq!(move_path(&root, "other/a.ts", "other").unwrap(), "other/a.ts");

        // And nothing may leave the repository.
        assert!(move_path(&root, "a.ts", "..").is_err());

        std::fs::remove_dir_all(&repo).ok();
    }

    /// The editor's external drop. Same shape of risk as a move — one gesture, a whole folder —
    /// so the test is again mostly about what it refuses to do.
    #[test]
    fn copies_dropped_paths_in_and_never_overwrites() {
        let repo = temp_repo();
        let root = repo.to_string_lossy().to_string();
        create_dir(&root, "assets").unwrap();
        create_file(&root, "taken.txt").unwrap();

        // A folder of loose files, somewhere else entirely — what Finder hands over.
        let outside = temp_repo();
        std::fs::create_dir_all(outside.join("icons/svg")).unwrap();
        std::fs::write(outside.join("icons/logo.png"), b"png").unwrap();
        std::fs::write(outside.join("icons/svg/mark.svg"), b"svg").unwrap();
        std::fs::write(outside.join("taken.txt"), b"newer").unwrap();
        let dropped = |name: &str| outside.join(name).to_string_lossy().to_string();

        // A whole tree into a subfolder, contents and all.
        let outcome = copy_into(&root, "assets", &[dropped("icons")]).unwrap();
        assert_eq!(outcome.copied, vec!["assets/icons"]);
        assert!(outcome.skipped.is_empty());
        assert!(repo.join("assets/icons/logo.png").is_file());
        assert_eq!(read_file_text(&root, "assets/icons/svg/mark.svg").unwrap(), "svg");

        // A name already taken at the root is reported, not replaced — and the rest of the same
        // drop still lands.
        let outcome = copy_into(&root, "", &[dropped("taken.txt"), dropped("icons/logo.png")]).unwrap();
        assert_eq!(outcome.copied, vec!["logo.png"]);
        assert_eq!(outcome.skipped, vec!["taken.txt"]);
        assert_eq!(read_file_text(&root, "taken.txt").unwrap(), "");

        // Dropping a folder onto itself, or into something inside it, would recurse forever.
        let inside = repo.join("assets").to_string_lossy().to_string();
        assert!(copy_into(&root, "assets/icons", &[inside]).is_err());
        // And nothing may land outside the repository.
        assert!(copy_into(&root, "..", &[dropped("icons/logo.png")]).is_err());
        assert!(!repo.parent().unwrap().join("logo.png").exists());

        std::fs::remove_dir_all(&repo).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// Renaming is deliberately narrower than moving, so the test is mostly about what it refuses.
    #[test]
    fn renames_in_place_and_refuses_to_move() {
        let repo = temp_repo();
        let root = repo.to_string_lossy().to_string();
        create_dir(&root, "src").unwrap();
        create_file(&root, "src/old.ts").unwrap();
        create_file(&root, "src/taken.ts").unwrap();

        assert_eq!(rename_path(&root, "src/old.ts", "new.ts").unwrap(), "src/new.ts");
        assert!(repo.join("src/new.ts").is_file());
        assert!(!repo.join("src/old.ts").exists());

        // A folder renames the same way.
        assert_eq!(rename_path(&root, "src", "lib").unwrap(), "lib");
        assert!(repo.join("lib/new.ts").is_file());

        // The name is a name, not a path: a separator would make this a move with folders created
        // on the way, which is what dragging is for.
        assert!(rename_path(&root, "lib/new.ts", "nested/new.ts").is_err());
        assert!(rename_path(&root, "lib/new.ts", "  ").is_err());
        assert!(rename_path(&root, "lib/new.ts", "..").is_err());
        // And an existing sibling is refused rather than clobbered.
        assert!(rename_path(&root, "lib/new.ts", "taken.ts").is_err());
        assert!(repo.join("lib/taken.ts").is_file());
        // Confirming the name unchanged is a no-op, not a collision with itself.
        assert_eq!(rename_path(&root, "lib/new.ts", "new.ts").unwrap(), "lib/new.ts");
        // The root itself is not a thing you can rename from inside the tree.
        assert!(rename_path(&root, "", "whatever").is_err());

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn rejects_duplicates_empty_names_and_traversal() {
        let repo = temp_repo();
        let root = repo.to_string_lossy().to_string();

        create_file(&root, "dup.txt").unwrap();
        assert!(create_file(&root, "dup.txt").is_err());
        create_dir(&root, "dir").unwrap();
        assert!(create_dir(&root, "dir").is_err());
        assert!(create_file(&root, "   ").is_err());
        assert!(create_file(&root, "../escaped.txt").is_err());
        assert!(create_dir(&root, "../escaped").is_err());
        assert!(!repo.parent().unwrap().join("escaped.txt").exists());

        std::fs::remove_dir_all(&repo).ok();
    }

    /// A save lands where the path says or nowhere. `..` is refused before anything is resolved: a
    /// path with nothing at it yet cannot be canonicalized, and `Path::starts_with` does not resolve
    /// what it compares — `/repo/../escaped.txt` starts with `/repo` — which is how the first write
    /// here used to create a file beside the repository.
    #[test]
    fn never_writes_outside_the_repo_through_dot_dot() {
        let (folder, repo) = repo_in_own_folder();
        let root = repo.to_string_lossy().to_string();
        create_dir(&root, "src").unwrap();

        assert!(write_file_text(&root, "../escaped.txt", "x").is_err());
        assert!(write_file_text(&root, "src/../../escaped.txt", "x").is_err());
        let absolute = folder.join("escaped.txt").to_string_lossy().to_string();
        assert!(write_file_text(&root, &absolute, "x").is_err());
        assert_eq!(names_in(&folder), ["repo"]);

        // Refused even where it would land inside: no path the tree hands over has a `..` in it.
        assert!(write_file_text(&root, "src/../inside.txt", "x").is_err());
        assert_eq!(names_in(&repo), ["src"]);
        // What a save does create — a file new to a folder that exists — still lands.
        write_file_text(&root, "src/new.txt", "x").unwrap();
        assert_eq!(read_file_text(&root, "src/new.txt").unwrap(), "x");

        std::fs::remove_dir_all(&folder).ok();
    }

    /// VS Code's own sequence, so a paste here is named what the same paste there would be.
    #[test]
    fn names_copies_the_way_vs_code_does() {
        assert_eq!(next_copy_name("a.ts", false), "a copy.ts");
        assert_eq!(next_copy_name("a copy.ts", false), "a copy 2.ts");
        assert_eq!(next_copy_name("a copy 2.ts", false), "a copy 3.ts");
        assert_eq!(next_copy_name("a copy 9.ts", false), "a copy 10.ts");
        // Before the last extension only.
        assert_eq!(next_copy_name("archive.tar.gz", false), "archive.tar copy.gz");
        // No extension, a dotfile, and a folder with a dot in its name: the suffix goes at the end.
        assert_eq!(next_copy_name("Makefile", false), "Makefile copy");
        assert_eq!(next_copy_name(".env", false), ".env copy");
        assert_eq!(next_copy_name(".env copy", false), ".env copy 2");
        assert_eq!(next_copy_name("src", true), "src copy");
        assert_eq!(next_copy_name("src copy", true), "src copy 2");
        assert_eq!(next_copy_name("v1.2", true), "v1.2 copy");
        // " copy" needs a name in front of it to be the suffix; `copy 5` is just what the file is called.
        assert_eq!(next_copy_name("copy 5.txt", false), "copy 5 copy.txt");
        // VS Code's two corner cases.
        assert_eq!(next_copy_name("a copy 0.ts", false), "a copy.ts");
        assert_eq!(
            next_copy_name("a copy 99999999999999999999999.ts", false),
            "a copy 99999999999999999999999 copy.ts"
        );
    }

    /// The explorer's Copy/Paste. A paste is one keystroke, so the test is mostly about the one thing
    /// it must never do — replace something — and the places it must never write.
    #[test]
    fn copies_within_the_repo_under_a_free_name() {
        let repo = temp_repo();
        let root = repo.to_string_lossy().to_string();
        create_dir(&root, "src/nested").unwrap();
        create_dir(&root, "lib").unwrap();
        std::fs::write(repo.join("src/a.ts"), "a").unwrap();
        std::fs::write(repo.join("src/nested/b.ts"), "b").unwrap();

        // Where the name is free, the copy keeps it.
        assert_eq!(copy_path(&root, "src/a.ts", "lib").unwrap(), "lib/a.ts");
        assert_eq!(read_file_text(&root, "lib/a.ts").unwrap(), "a");
        // Back into its own folder it is a duplicate, and every paste takes the next name.
        assert_eq!(copy_path(&root, "src/a.ts", "src").unwrap(), "src/a copy.ts");
        assert_eq!(copy_path(&root, "src/a.ts", "src").unwrap(), "src/a copy 2.ts");
        assert_eq!(read_file_text(&root, "src/a copy 2.ts").unwrap(), "a");
        // A file already holding the name is left exactly as it was.
        std::fs::write(repo.join("lib/a.ts"), "edited").unwrap();
        assert_eq!(copy_path(&root, "src/a.ts", "lib").unwrap(), "lib/a copy.ts");
        assert_eq!(read_file_text(&root, "lib/a.ts").unwrap(), "edited");

        // A folder copies whole — beside itself as `src copy`, elsewhere under its own name.
        assert_eq!(copy_path(&root, "src", "").unwrap(), "src copy");
        assert_eq!(read_file_text(&root, "src copy/nested/b.ts").unwrap(), "b");
        assert_eq!(read_file_text(&root, "src/nested/b.ts").unwrap(), "b");
        assert_eq!(copy_path(&root, "src/nested", "lib").unwrap(), "lib/nested");

        // Into itself, directly or through a descendant, is refused before anything is created.
        assert!(copy_path(&root, "src", "src").is_err());
        assert!(copy_path(&root, "src", "src/nested").is_err());
        assert!(!repo.join("src/src").exists());
        assert!(!repo.join("src/nested/src").exists());

        // Neither end may leave the repository, and the root is not a thing to copy.
        let outside = repo
            .parent()
            .unwrap()
            .join(format!("cf-fsops-outside-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&outside, "outside").unwrap();
        let outside_rel = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        assert!(copy_path(&root, &outside_rel, "lib").is_err());
        assert!(copy_path(&root, "src/a.ts", "..").is_err());
        assert!(copy_path(&root, "", "lib").is_err());
        assert!(copy_path(&root, "src/missing.ts", "lib").is_err());
        assert!(copy_path(&root, "src/a.ts", "src/a.ts").is_err());

        std::fs::remove_file(&outside).ok();
        std::fs::remove_dir_all(&repo).ok();
    }

    /// A symlink is copied as the file it names but keeps the name the tree shows, and a dangling one
    /// holding a name is a taken name — never a route for the copy to write through.
    #[cfg(unix)]
    #[test]
    fn copies_links_by_their_own_name_and_never_writes_through_one() {
        let repo = temp_repo();
        let root = repo.to_string_lossy().to_string();
        create_dir(&root, "lib").unwrap();
        std::fs::write(repo.join("real.ts"), "real").unwrap();
        std::os::unix::fs::symlink(repo.join("real.ts"), repo.join("link.ts")).unwrap();

        assert_eq!(copy_path(&root, "link.ts", "lib").unwrap(), "lib/link.ts");
        assert_eq!(read_file_text(&root, "lib/link.ts").unwrap(), "real");

        std::fs::write(repo.join("dangling.ts"), "mine").unwrap();
        std::os::unix::fs::symlink(repo.join("nowhere.ts"), repo.join("lib/dangling.ts")).unwrap();
        assert_eq!(copy_path(&root, "dangling.ts", "lib").unwrap(), "lib/dangling copy.ts");
        assert!(!repo.join("nowhere.ts").exists());

        std::fs::remove_dir_all(&repo).ok();
    }

    /// Reading and saving go through a link to the file it names — as long as that file is inside
    /// the repository. A link out of it is refused, so is a new file under a link to a folder out of
    /// it, and so is a link to nothing, which a save would follow to wherever it points.
    #[cfg(unix)]
    #[test]
    fn reads_and_writes_through_a_link_but_never_out_of_the_repo() {
        use std::os::unix::fs::symlink;
        let (folder, repo) = repo_in_own_folder();
        let root = repo.to_string_lossy().to_string();
        let outside = folder.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        std::fs::write(repo.join("real.ts"), "real").unwrap();
        symlink(repo.join("real.ts"), repo.join("link.ts")).unwrap();
        symlink(outside.join("secret.txt"), repo.join("out.txt")).unwrap();
        symlink(&outside, repo.join("out")).unwrap();
        symlink(outside.join("nowhere.txt"), repo.join("dangling.txt")).unwrap();

        assert_eq!(read_file_text(&root, "link.ts").unwrap(), "real");
        write_file_text(&root, "link.ts", "saved").unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("real.ts")).unwrap(), "saved");
        assert!(is_link(&repo.join("link.ts")));

        assert!(read_file_text(&root, "out.txt").is_err());
        assert!(write_file_text(&root, "out.txt", "x").is_err());
        assert!(write_file_text(&root, "out/new.txt", "x").is_err());
        assert!(write_file_text(&root, "dangling.txt", "x").is_err());
        assert_eq!(names_in(&outside), ["secret.txt"]);
        assert_eq!(std::fs::read_to_string(outside.join("secret.txt")).unwrap(), "outside");

        std::fs::remove_dir_all(&folder).ok();
    }

    /// New File and New Folder go through a link to a folder inside the repository, nested names and
    /// all — but never through one out of it, however deep the name goes, nor through a link to
    /// nothing. The folders on the way used to be joined on unresolved, and `create_dir_all` and
    /// `create_new` follow a link wherever it leads: `out/new.txt` was created beside the repository.
    #[cfg(unix)]
    #[test]
    fn creates_through_a_link_but_never_out_of_the_repo() {
        use std::os::unix::fs::symlink;
        let (folder, repo) = repo_in_own_folder();
        let root = repo.to_string_lossy().to_string();
        let outside = folder.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        create_dir(&root, "lib").unwrap();
        symlink(&outside, repo.join("out")).unwrap();
        symlink(repo.join("lib"), repo.join("lib-link")).unwrap();
        symlink(folder.join("nowhere"), repo.join("dangling")).unwrap();

        assert!(create_file(&root, "out/new.txt").is_err());
        assert!(create_dir(&root, "out/newdir").is_err());
        assert!(create_file(&root, "out/deeper/new.txt").is_err());
        assert!(create_dir(&root, "out/deeper/newdir").is_err());
        assert_eq!(names_in(&outside), ["secret.txt"]);
        // A link to nothing is not created as the folder it names, either.
        assert!(create_file(&root, "dangling/new.txt").is_err());
        assert!(create_dir(&root, "dangling/newdir").is_err());
        assert_eq!(names_in(&folder), ["outside", "repo"]);
        assert_eq!(names_in(&repo), ["dangling", "lib", "lib-link", "out"]);

        // Into the folder a link inside the repository names, with the folders on the way created
        // there — and the link left a link.
        create_file(&root, "lib-link/nested/new.ts").unwrap();
        create_dir(&root, "lib-link/nested/dir").unwrap();
        assert!(repo.join("lib/nested/new.ts").is_file());
        assert!(repo.join("lib/nested/dir").is_dir());
        assert!(is_link(&repo.join("lib-link")));
        // A name ending in a slash is still a folder's, not a file's, where the path is rebuilt too.
        assert!(create_file(&root, "lib-link/file.txt/").is_err());
        assert!(!repo.join("lib/file.txt").exists());

        std::fs::remove_dir_all(&folder).ok();
    }

    /// Trashing, moving and renaming act on a link itself, never on what it points at — which stays
    /// where it was, inside the repository or out of it, even when it is a folder. And a link is not
    /// the file it names: renaming either onto the other is a collision, though both canonicalize to
    /// one path.
    #[cfg(unix)]
    #[test]
    fn trashes_moves_and_renames_a_link_not_what_it_points_at() {
        use std::os::unix::fs::symlink;
        let (folder, repo) = repo_in_own_folder();
        let root = repo.to_string_lossy().to_string();
        let outside = folder.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        create_dir(&root, "lib").unwrap();
        std::fs::write(repo.join("real.ts"), "real").unwrap();
        symlink(repo.join("real.ts"), repo.join("link.ts")).unwrap();
        symlink(repo.join("lib"), repo.join("lib-link")).unwrap();
        symlink(outside.join("secret.txt"), repo.join("out.txt")).unwrap();
        symlink(&outside, repo.join("out")).unwrap();
        symlink(outside.join("nowhere.txt"), repo.join("dangling.txt")).unwrap();

        // The trash is handed the link — to a folder, out of the repository, to nothing — and never
        // anything reached through a link out of it.
        let base = repo.canonicalize().unwrap();
        for name in ["link.ts", "lib-link", "out.txt", "out", "dangling.txt"] {
            assert_eq!(trash_target(&root, name).unwrap(), base.join(name));
        }
        assert!(trash_target(&root, "out/secret.txt").is_err());
        assert!(trash_target(&root, "missing.txt").is_err());
        assert!(trash_target(&root, "").is_err());

        // Renamed, it is the link that takes the new name — one leading out of the repository too.
        assert_eq!(rename_path(&root, "link.ts", "alias.ts").unwrap(), "alias.ts");
        assert!(is_link(&repo.join("alias.ts")));
        assert_eq!(read_file_text(&root, "alias.ts").unwrap(), "real");
        assert_eq!(rename_path(&root, "out.txt", "secret.txt").unwrap(), "secret.txt");
        // Two entries, whichever is renamed onto the other; and a link to nothing holds its name.
        assert!(rename_path(&root, "alias.ts", "real.ts").is_err());
        assert!(rename_path(&root, "real.ts", "alias.ts").is_err());
        assert!(rename_path(&root, "real.ts", "dangling.txt").is_err());
        // A change of case alone still renames the link, on a case-insensitive disk too.
        assert_eq!(rename_path(&root, "alias.ts", "Alias.ts").unwrap(), "Alias.ts");
        assert!(names_in(&repo).iter().any(|name| name == "Alias.ts"));

        // Moved, it is the link that goes — a link to a folder into that very folder included — and
        // a link to nothing at the destination is a name taken, not one to replace.
        assert_eq!(move_path(&root, "Alias.ts", "lib").unwrap(), "lib/Alias.ts");
        assert_eq!(move_path(&root, "lib-link", "lib").unwrap(), "lib/lib-link");
        assert!(is_link(&repo.join("lib/Alias.ts")) && is_link(&repo.join("lib/lib-link")));
        std::fs::write(repo.join("taken.txt"), "mine").unwrap();
        symlink(outside.join("nowhere.txt"), repo.join("lib/taken.txt")).unwrap();
        assert!(move_path(&root, "taken.txt", "lib").is_err());
        assert!(is_link(&repo.join("lib/taken.txt")));

        // And nothing a link pointed at went anywhere.
        assert_eq!(
            names_in(&repo),
            ["dangling.txt", "lib", "out", "real.ts", "secret.txt", "taken.txt"]
        );
        assert_eq!(std::fs::read_to_string(repo.join("real.ts")).unwrap(), "real");
        assert_eq!(names_in(&outside), ["secret.txt"]);

        std::fs::remove_dir_all(&folder).ok();
    }

    /// "Generate Tree": the explorer's order, its hidden entries, folders git ignores drawn but not
    /// opened, and a cap that says when it was hit.
    #[test]
    fn walks_a_folder_the_way_the_explorer_lists_it() {
        let repo = temp_repo();
        let root = repo.to_string_lossy().to_string();
        git2::Repository::init(&repo).unwrap();
        std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        create_dir(&root, "src/components").unwrap();
        create_file(&root, "src/components/App.tsx").unwrap();
        create_file(&root, "src/components/index.ts").unwrap();
        create_file(&root, "src/main.tsx").unwrap();
        create_file(&root, "src/Zeta.ts").unwrap();
        create_file(&root, "node_modules/react/index.js").unwrap();
        create_file(&root, "README.md").unwrap();
        create_file(&root, "notes.txt").unwrap();

        let rows = |tree: &DirTree| -> Vec<(usize, String, bool, bool)> {
            tree.rows
                .iter()
                .map(|row| (row.depth, row.name.clone(), row.is_dir, row.last))
                .collect()
        };
        let row = |depth: usize, name: &str, is_dir: bool, last: bool| (depth, name.to_string(), is_dir, last);

        // Folders first, then files, each without regard to case — the tree's own order.
        let tree = dir_tree(&root, "src", &[], 100).unwrap();
        assert_eq!(tree.name, "src");
        assert!(!tree.truncated);
        assert_eq!(
            rows(&tree),
            vec![
                row(0, "components", true, false),
                row(1, "App.tsx", false, false),
                row(1, "index.ts", false, true),
                row(0, "main.tsx", false, false),
                row(0, "Zeta.ts", false, true),
            ]
        );

        // The root: `.git` never appears, the ignored folder is listed and not opened, and an entry
        // hidden in the explorer is not in the tree either.
        let tree = dir_tree(&root, "", &["notes.txt".to_string()], 100).unwrap();
        assert_eq!(tree.name, repo.file_name().unwrap().to_string_lossy());
        assert_eq!(
            rows(&tree),
            vec![
                row(0, "node_modules", true, false),
                row(0, "src", true, false),
                row(1, "components", true, false),
                row(2, "App.tsx", false, false),
                row(2, "index.ts", false, true),
                row(1, "main.tsx", false, false),
                row(1, "Zeta.ts", false, true),
                row(0, ".gitignore", false, false),
                row(0, "README.md", false, true),
            ]
        );

        // Asked for directly, an ignored folder is walked — that is the question being asked — and one
        // level deep, since every folder below it is ignored too.
        let tree = dir_tree(&root, "node_modules", &[], 100).unwrap();
        assert_eq!(rows(&tree), vec![row(0, "react", true, true)]);

        // The cap stops the walk and says so; the last row kept is not drawn as the last one.
        let tree = dir_tree(&root, "src", &[], 2).unwrap();
        assert!(tree.truncated);
        assert_eq!(rows(&tree), vec![row(0, "components", true, false), row(1, "App.tsx", false, false)]);

        // A file is not a folder, and nothing outside the repository is walked.
        assert!(dir_tree(&root, "README.md", &[], 100).is_err());
        assert!(dir_tree(&root, "..", &[], 100).is_err());

        std::fs::remove_dir_all(&repo).ok();
    }
}
