use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where Tauri unpacked the app's bundled resources — today, the trimmed Java runtime and the
/// InterSystems JDBC driver the IRIS datasource needs.
///
/// Recorded at startup rather than resolved on demand because the layers that need it (the
/// `datasource` drivers) are deliberately free of Tauri types: they take a config and return rows,
/// and threading an `AppHandle` down to them just to find a directory would undo that.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Records that directory in its plain form — never Windows' verbatim `\\?\C:\…`.
///
/// Tauri resolves its resource directory from a *canonicalized* `current_exe`, and on Windows
/// `std::fs::canonicalize` always answers with the verbatim prefix. Rust reads that form happily,
/// and so does `CreateProcess`, so it survives every hop inside the app — and then breaks the one
/// consumer that isn't Rust. The JVM in [`crate::datasource::jvm`] parses a leading `\\` as a UNC
/// share, so `\\?\C:\…\iris-bridge.jar` on its classpath names a server called `?`: it opens
/// neither jar, silently drops both entries, and dies with `Could not find or load main class`,
/// which reaches the user as "the bridge stopped running" and names nothing anyone can fix.
///
/// Undone here rather than at that call site because the fault is in the path and not in the JVM:
/// the next resource handed to any program that isn't Rust would hit the same wall.
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(plain(&dir));
}

/// See [`set_resource_dir`]. Nothing at all off Windows, and on it nothing to a path that was
/// already plain.
///
/// `dunce` rather than stripping `\\?\` by hand because the prefix is not always removable: a
/// device path has no plain spelling and must be left alone, and `\\?\UNC\server\share` has one
/// that isn't a prefix strip (`\\server\share`). Getting either wrong would trade this bug for a
/// resource directory that names nothing.
fn plain(dir: &Path) -> PathBuf {
    dunce::simplified(dir).to_path_buf()
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

/// Where one chain's memory notes actually live.
///
/// Consolidated here rather than in a repository for the same reason the skills are: a repository
/// can be deleted, moved or renamed, and a chain's record of what it did should not go with it.
/// What each repository gets is a *mirror* — see `chain_memory`.
pub fn chain_memory_dir(chain_id: &str) -> PathBuf {
    base_dir().join("chain-memory").join(chain_id)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact directory Tauri hands back from a packaged Windows install, and the exact reason
    /// IRIS could not connect from one: the prefix rode along into every jar on the JVM's
    /// classpath, which cannot carry it.
    #[test]
    #[cfg(windows)]
    fn a_verbatim_resource_dir_is_recorded_plainly() {
        let recorded = plain(Path::new(r"\\?\C:\Users\someone\AppData\Local\CodeFlow"));
        assert_eq!(
            recorded,
            Path::new(r"C:\Users\someone\AppData\Local\CodeFlow")
        );
        // What the IRIS driver actually builds from it, which is where the prefix did its damage.
        let jar = recorded.join("iris").join("iris-bridge.jar");
        assert!(!jar.to_string_lossy().starts_with(r"\\?\"), "{}", jar.display());
    }

    /// A path that never had the prefix is handed back untouched — every macOS and Linux resource
    /// directory, and a Windows one that already arrived plain.
    #[test]
    fn a_plain_path_is_left_alone() {
        let untouched = base_dir().join("resources");
        assert_eq!(plain(&untouched), untouched);
    }
}
