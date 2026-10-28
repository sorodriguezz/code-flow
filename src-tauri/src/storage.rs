//! Where the app's disk space goes, and what it is safe to give back.
//!
//! The app keeps a lot on disk — the database, downloaded models, cloned reference repositories, chat
//! files, a review tool's downloads — and nothing said how much, until a full disk did. This measures
//! each place and offers to clear **only what the app regenerates by itself**: the cache folder and old
//! log generations. Everything else is somebody's data or a download that costs time to fetch again, so
//! it is shown, sized and left alone: a button that deleted a database to "free space" is not a feature.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// One place the app keeps things.
#[derive(Debug, Clone, Serialize)]
pub struct Category {
    /// A stable key for the clients: `database`, `cache`, `logs`, `models`…
    pub id: &'static str,
    pub path: String,
    pub bytes: u64,
    pub files: u32,
    /// Whether [`clear`] will take it. Only what the app rebuilds on its own.
    pub clearable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Usage {
    pub categories: Vec<Category>,
    /// Free and total bytes of the disk the app's data is on; `0` when it could not be told.
    pub free_bytes: u64,
    pub total_bytes: u64,
}

/// The places, in the order they are listed.
fn places() -> Vec<(&'static str, PathBuf, bool)> {
    vec![
        ("database", crate::paths::db_path(), false),
        ("cache", crate::paths::cache_dir(), true),
        ("logs", crate::paths::logs_dir(), true),
        ("models", crate::paths::models_dir(), false),
        ("referenceRepos", crate::paths::reference_repos_dir(), false),
        ("reviewer", crate::paths::reviewer_dir(), false),
        ("chatFiles", crate::paths::chat_outputs_dir(), false),
        ("chatAttachments", crate::paths::chat_attachments_dir(), false),
        ("flowRuns", crate::paths::flow_runs_dir(), false),
        ("sandbox", crate::paths::sandbox_dir(), false),
        ("backups", crate::paths::backups_dir(), false),
        ("clones", crate::paths::clone_root(), false),
    ]
}

fn measure(path: &Path) -> (u64, u32) {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => (meta.len(), 1),
        Ok(_) => crate::npm::directory_size(path, 0),
        Err(_) => (0, 0),
    }
}

/// How much is used where, and how much is free. Blocking: it walks folders.
pub fn usage() -> Usage {
    let categories = places()
        .into_iter()
        .map(|(id, path, clearable)| {
            let (bytes, files) = measure(&path);
            Category { id, path: path.display().to_string(), bytes, files, clearable }
        })
        .collect();
    let (free_bytes, total_bytes) = free_space(&crate::paths::state_dir());
    Usage { categories, free_bytes, total_bytes }
}

/// The disk `path` is on: the mount whose point is its longest prefix.
fn free_space(path: &Path) -> (u64, u64) {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map_or((0, 0), |disk| (disk.available_space(), disk.total_space()))
}

/// Gives back what the app rebuilds by itself. `Err` for anything else: this is not a general delete.
///
/// - `cache` — everything inside the cache folder (the folder stays).
/// - `logs` — the rotated generations (`*.1`), never the file being written.
pub fn clear(id: &str) -> Result<u64, String> {
    match id {
        "cache" => Ok(remove_contents(&crate::paths::cache_dir(), |_| true)),
        "logs" => Ok(remove_contents(&crate::paths::logs_dir(), is_rotated_log)),
        other => Err(format!("{other} is not something the app can clear")),
    }
}

fn is_rotated_log(name: &str) -> bool {
    name.ends_with(".1") || name.ends_with(".old")
}

/// Removes the entries of `dir` whose name `take` accepts, and returns the bytes freed. A failure on one
/// entry (a file in use) leaves it and carries on: freeing most is better than stopping at the first.
fn remove_contents(dir: &Path, take: impl Fn(&str) -> bool) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut freed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !take(&name) {
            continue;
        }
        let path = entry.path();
        let (bytes, _) = measure(&path);
        let gone = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        if gone.is_ok() {
            freed += bytes;
        }
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-storage-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn clearing_takes_what_the_filter_accepts_and_reports_the_bytes() {
        let dir = temp("clear");
        std::fs::write(dir.join("a.bin"), vec![0u8; 1000]).unwrap();
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested/b.bin"), vec![0u8; 500]).unwrap();
        let freed = remove_contents(&dir, |_| true);
        assert_eq!(freed, 1500);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the folder stays, its contents go");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_log_generations_go_and_the_live_log_never_does() {
        let dir = temp("logs");
        std::fs::write(dir.join("codeflow.log"), "live").unwrap();
        std::fs::write(dir.join("codeflow.log.1"), "old").unwrap();
        let freed = remove_contents(&dir, is_rotated_log);
        assert_eq!(freed, 3);
        assert!(dir.join("codeflow.log").exists() && !dir.join("codeflow.log.1").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_frees_nothing_and_is_not_an_error() {
        assert_eq!(remove_contents(Path::new("/definitely/not/here"), |_| true), 0);
    }

    #[test]
    fn only_what_the_app_rebuilds_can_be_cleared() {
        for id in ["database", "models", "backups", "clones", "referenceRepos", "../etc", ""] {
            assert!(clear(id).is_err(), "{id} must not be clearable");
        }
        // And every place that says it can be is one `clear` really takes.
        for (id, _, clearable) in places() {
            if clearable {
                assert!(matches!(id, "cache" | "logs"), "{id} claims to be clearable");
            }
        }
    }

    #[test]
    fn a_file_is_measured_as_itself_and_a_missing_path_as_nothing() {
        let dir = temp("measure");
        std::fs::write(dir.join("f"), vec![1u8; 42]).unwrap();
        assert_eq!(measure(&dir.join("f")), (42, 1));
        assert_eq!(measure(&dir.join("nope")), (0, 0));
        assert_eq!(measure(&dir), (42, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_lists_every_place_once() {
        let report = usage();
        let mut ids: Vec<&str> = report.categories.iter().map(|c| c.id).collect();
        let total = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), total);
        assert!(report.categories.iter().any(|c| c.id == "database"));
    }
}
