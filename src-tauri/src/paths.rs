use std::path::PathBuf;

/// Root directory where CodeFlow keeps its database and local config.
/// Windows: literally `C:\CodeFlow` (explicit product requirement, not `%LOCALAPPDATA%`).
/// macOS/Linux: there is no `C:` drive, so we fall back to the OS-standard app-data
/// directory with a `CodeFlow` subfolder (e.g. `~/Library/Application Support/CodeFlow`).
pub fn base_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\CodeFlow")
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs::data_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
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

pub fn ensure_dirs() -> std::io::Result<()> {
    std::fs::create_dir_all(base_dir())?;
    std::fs::create_dir_all(logs_dir())?;
    std::fs::create_dir_all(clone_root())?;
    Ok(())
}
