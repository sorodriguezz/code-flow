use std::path::{Path, PathBuf};

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
    std::fs::read_to_string(&full).map_err(|e| e.to_string())
}

pub fn write_file_text(repo_path: &str, rel_path: &str, content: &str) -> Result<(), String> {
    let full = resolve_within_repo(repo_path, rel_path)?;
    std::fs::write(&full, content).map_err(|e| e.to_string())
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
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "code"]);
        cmd
    } else {
        std::process::Command::new("code")
    };
    cmd.arg(path)
        .spawn()
        .map_err(|e| format!("failed to launch VS Code (is `code` on PATH?): {e}"))?;
    Ok(())
}
