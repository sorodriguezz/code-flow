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
fn resolve_within_repo(repo_path: &str, rel_path: &str) -> Result<PathBuf, String> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    let candidate = base.join(rel_path);
    let resolved = candidate.canonicalize().unwrap_or(candidate);
    if !resolved.starts_with(&base) {
        return Err("path escapes the repository root".to_string());
    }
    Ok(resolved)
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
/// - moving a directory into itself (or into its own descendant) is rejected, which the
///   filesystem would otherwise turn into a lost subtree;
/// - an existing name at the destination is refused rather than overwritten.
pub fn move_path(repo_path: &str, from_rel: &str, dest_dir: &str) -> Result<String, String> {
    let source = resolve_within_repo(repo_path, from_rel)?;
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

    // Comparing canonical paths, so a symlinked route into the subtree is caught too.
    if source.is_dir() && dest.starts_with(&source) {
        return Err("cannot move a folder into itself".to_string());
    }
    let target = dest.join(&name);
    if target == source {
        // Dropped back where it already lives — not an error, just nothing to do.
        return Ok(from_rel.to_string());
    }
    if target.exists() {
        return Err(format!("{} already exists here", name.to_string_lossy()));
    }

    std::fs::rename(&source, &target).map_err(|e| e.to_string())?;
    Ok(target
        .strip_prefix(&base)
        .map_err(|_| "moved outside the repository".to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// Resolves the target of a *creation*, which by definition doesn't exist yet — so
/// `resolve_within_repo`'s canonicalize-based containment check can't see through a `..`
/// segment. Requiring every component to be a plain name is the equivalent guard here, and
/// it also rejects the empty/whitespace names the explorer's inline input can produce.
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
    Ok(base.join(candidate))
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

    let source = resolve_within_repo(repo_path, from_rel)?;
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
    // `exists()` true for what is the *same* file, so `rename` handles them rather than being
    // refused. Anything else keeping that name is a real collision.
    if target.exists() && !same_file(&target, &source) {
        return Err(format!("{name} already exists"));
    }

    std::fs::rename(&source, &target).map_err(|e| e.to_string())?;
    Ok(target
        .strip_prefix(&base)
        .map_err(|_| "renamed outside the repository".to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// Whether two paths name the same file on disk, which is how a case-only rename is told apart
/// from a collision on a case-insensitive filesystem.
fn same_file(a: &Path, b: &Path) -> bool {
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
pub fn delete_path(repo_path: &str, rel_path: &str) -> Result<(), String> {
    let target = resolve_within_repo(repo_path, rel_path)?;
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("invalid repo path: {e}"))?;
    if target == base {
        return Err("cannot delete the repository root".to_string());
    }
    if !target.exists() {
        return Err(format!("{rel_path} no longer exists"));
    }
    trash::delete(&target).map_err(|e| e.to_string())
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
}
