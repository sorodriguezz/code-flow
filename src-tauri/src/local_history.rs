//! The editor's local history: a copy of a file at every save, kept by the app and not by git — the
//! "Timeline" VS Code keeps. A file a model or a slip of the hand rewrote, before anyone committed it,
//! has nothing in git to come back from; this is that something.
//!
//! Stored under the state root, never in the repository: one folder per repository (named by a hash
//! of its path), one folder per file inside it (a hash of the repo-relative path, with `path.txt`
//! saying which file it is), one `<unix millis>.txt` per version.
//!
//! Bounded on every side, because it writes on every ⌘S: a file past [`MAX_BYTES`] is not kept, a
//! version identical to the newest one is not kept again, and past [`MAX_VERSIONS`] the oldest go.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// Larger than this, a save is not copied: the history is for source files, and a generated bundle
/// saved fifty times would be fifty copies of something nobody wants back.
const MAX_BYTES: usize = 2 * 1024 * 1024;
/// Versions kept per file. The newest are what anyone goes back to.
const MAX_VERSIONS: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVersion {
    /// The version's file name without its extension — also when it was saved, in unix millis.
    pub id: String,
    pub saved_at: i64,
    pub bytes: u64,
}

fn short_hash(text: &str) -> String {
    hex::encode(&Sha256::digest(text.as_bytes())[..8])
}

fn file_dir(repo_path: &str, rel_path: &str) -> PathBuf {
    let rel = rel_path.replace('\\', "/");
    crate::paths::state_dir()
        .join("local-history")
        .join(short_hash(repo_path))
        .join(short_hash(&rel))
}

/// The versions on disk, newest first.
fn versions_in(dir: &Path) -> Vec<(i64, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(i64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_stem()?.to_str()?.to_string();
            (path.extension()? == "txt").then_some(())?;
            Some((stem.parse::<i64>().ok()?, path))
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

fn write_version(dir: &Path, content: &[u8]) -> Result<(), String> {
    if content.len() > MAX_BYTES {
        return Ok(());
    }
    let versions = versions_in(dir);
    if let Some((_, newest)) = versions.first() {
        if std::fs::read(newest).is_ok_and(|bytes| bytes == content) {
            return Ok(());
        }
    }
    let mut at = chrono::Utc::now().timestamp_millis();
    // Two saves in the same millisecond still keep both.
    if versions.first().is_some_and(|(newest, _)| *newest >= at) {
        at = versions[0].0 + 1;
    }
    std::fs::write(dir.join(format!("{at}.txt")), content).map_err(|e| e.to_string())?;
    for (_, old) in versions_in(dir).into_iter().skip(MAX_VERSIONS) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

/// Keeps `content` as a version of `rel_path` — called by the editor's save, with what it is about
/// to write. The first time a file is seen, what is on disk before the save is kept too, so the
/// very first save already has something to go back to.
///
/// Best effort by design: a history that could not be written is never a reason to fail the save
/// the user asked for, so the caller ignores the error.
pub fn record(repo_path: &str, rel_path: &str, previous: Option<&[u8]>, content: &[u8]) -> Result<(), String> {
    let dir = file_dir(repo_path, rel_path);
    let fresh = !dir.exists();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if fresh {
        let _ = std::fs::write(dir.join("path.txt"), rel_path.replace('\\', "/"));
        if let Some(previous) = previous.filter(|bytes| *bytes != content) {
            write_version(&dir, previous)?;
        }
    }
    write_version(&dir, content)
}

pub fn list(repo_path: &str, rel_path: &str) -> Vec<LocalVersion> {
    versions_in(&file_dir(repo_path, rel_path))
        .into_iter()
        .map(|(at, path)| LocalVersion {
            id: at.to_string(),
            saved_at: at,
            bytes: std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
        })
        .collect()
}

pub fn read(repo_path: &str, rel_path: &str, id: &str) -> Result<String, String> {
    // The id names a file in the folder, so it must be nothing but the number it is.
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid version".to_string());
    }
    let bytes = std::fs::read(file_dir(repo_path, rel_path).join(format!("{id}.txt"))).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_distinct_versions_newest_first_and_skips_repeats() {
        let dir = std::env::temp_dir().join(format!("cf-lh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        write_version(&dir, b"one").unwrap();
        write_version(&dir, b"one").unwrap();
        write_version(&dir, b"two").unwrap();
        let versions = versions_in(&dir);
        assert_eq!(versions.len(), 2);
        assert_eq!(std::fs::read(&versions[0].1).unwrap(), b"two");
        for i in 0..(MAX_VERSIONS + 5) {
            write_version(&dir, format!("v{i}").as_bytes()).unwrap();
        }
        assert_eq!(versions_in(&dir).len(), MAX_VERSIONS);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
