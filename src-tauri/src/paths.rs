use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where Tauri unpacked the app's bundled resources — today, the trimmed Java runtime and the
/// InterSystems JDBC driver the IRIS datasource needs.
///
/// Recorded at startup rather than resolved on demand because the layers that need it (the
/// `datasource` drivers) are deliberately free of Tauri types: they take a config and return rows,
/// and threading an `AppHandle` down to them just to find a directory would undo that.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

/// `None` outside a packaged app — a `cargo test` has no Tauri runtime to have set it. Callers
/// treat that as "look for a source checkout instead", not as an error.
pub fn resource_dir() -> Option<&'static Path> {
    RESOURCE_DIR.get().map(PathBuf::as_path)
}

/// Root directory where CodeFlow keeps its database and local config.
/// Windows: literally `C:\CodeFlow` (explicit product requirement, not `%LOCALAPPDATA%`).
/// macOS/Linux: the user's home root, i.e. `~/CodeFlow` — same rationale as Windows (a
/// fixed, predictable location the installer's keep/wipe prompt can target) and one that
/// never needs elevated permissions, unlike writing under `/Applications` or `/Library`.
pub fn base_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\CodeFlow")
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("CodeFlow")
    }
}

pub fn db_path() -> PathBuf {
    base_dir().join("codeflow.db")
}

pub fn logs_dir() -> PathBuf {
    base_dir().join("logs")
}

/// Default destination root for repos cloned from within CodeFlow — same base
/// directory as everything else the app persists (`C:\CodeFlow\repos` on Windows).
pub fn clone_root() -> PathBuf {
    base_dir().join("repos")
}

/// Where a workspace's skills (installed via `npx skills add`) live before being synced
/// into whichever project is actually being reviewed — the canonical, workspace-scoped copy.
pub fn workspace_skills_dir(workspace_id: &str) -> PathBuf {
    base_dir().join("workspaces").join(workspace_id).join("skills")
}

pub fn ensure_dirs() -> std::io::Result<()> {
    std::fs::create_dir_all(base_dir())?;
    std::fs::create_dir_all(logs_dir())?;
    std::fs::create_dir_all(clone_root())?;
    Ok(())
}

/// A "please wipe everything" request has to be handled on the *next* launch, before the
/// database is opened — deleting `codeflow.db` out from under this process's own open SQLite
/// connection would fail on Windows (can't remove a file that's still locked open). Requesting
/// a reset just drops this marker and quits; `run()` checks for it first thing on startup, when
/// nothing has touched the directory yet, and deletes it then.
pub fn reset_marker_path() -> PathBuf {
    base_dir().join(".reset-pending")
}
