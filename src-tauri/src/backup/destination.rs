//! Where a backup goes, and how it gets there.
//!
//! Three destinations, and only one of them is an integration:
//!
//! - **A folder on this computer.** Also how OneDrive, Dropbox, Proton Drive and every other
//!   sync client is supported, because all of them are a folder: pointing the backup inside one is
//!   the whole configuration. Nothing to connect, nothing to authorise.
//! - **iCloud Drive**, which is the same trick with the folder found for the user. Apple offers no
//!   API for a third-party app to write into iCloud Drive as a *service*, but iCloud Drive is a
//!   real directory on both platforms — `~/Library/Mobile Documents/com~apple~CloudDocs` on macOS,
//!   `%USERPROFILE%\iCloudDrive` where iCloud for Windows is installed — and the sync daemon
//!   uploads whatever lands there. So this needs no credentials at all, and works on Windows and
//!   macOS alike, which is exactly what was asked for.
//! - **Google Drive**, which does need OAuth, and uses the user's own client (see `gdrive.rs`).
//!
//! Rotation lives here too. The destination always holds one file under a fixed name — that is what
//! the other machine looks for — and, when asked, a handful of dated copies beside it, because the
//! backup a user needs is often not the most recent one but the one from before whatever went
//! wrong.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::envelope::FILE_EXTENSION;

/// The name the current backup always has. Fixed and undated on purpose: it is how a second
/// machine recognises the first one's file, and how the cloud copy stays one file instead of a pile.
pub fn current_file_name() -> String {
    format!("codeflow-backup.{FILE_EXTENSION}")
}

/// `codeflow-backup-2026-08-01-1432.cfbackup` — a rotated copy, sortable by name.
fn dated_file_name(at: chrono::DateTime<chrono::Local>) -> String {
    format!("codeflow-backup-{}.{FILE_EXTENSION}", at.format("%Y-%m-%d-%H%M%S"))
}

/// The name offered in the "save as" dialog for a one-off manual export, dated because successive
/// manual exports are a series rather than one file kept current.
pub fn suggested_export_name() -> String {
    format!(
        "codeflow-backup-{}.{FILE_EXTENSION}",
        chrono::Local::now().format("%Y-%m-%d")
    )
}

// ---------------------------------------------------------------------------
// Finding the cloud folders
// ---------------------------------------------------------------------------

/// A synced folder found on this machine, offered as a one-click destination.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncFolder {
    /// `icloud` | `onedrive` | `dropbox` | `gdrive-desktop` — the UI picks the label and icon.
    pub kind: String,
    pub path: String,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| path.is_dir()).cloned()
}

/// iCloud Drive's directory, or `None` when iCloud isn't set up here.
///
/// macOS spells it `com~apple~CloudDocs` (the tildes are Apple's own escaping of the bundle id) and
/// the folder exists as soon as iCloud Drive is enabled. Windows only has it once iCloud for
/// Windows is installed, and that installer has used two spellings over the years — both are
/// checked rather than picking one and telling users with the other that iCloud isn't installed.
pub fn icloud_dir() -> Option<PathBuf> {
    let home = home()?;
    #[cfg(target_os = "macos")]
    let candidates = vec![home.join("Library/Mobile Documents/com~apple~CloudDocs")];
    #[cfg(target_os = "windows")]
    let candidates = vec![home.join("iCloudDrive"), home.join("iCloud Drive")];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let candidates: Vec<PathBuf> = {
        let _ = &home;
        Vec::new()
    };
    first_existing(&candidates)
}

/// Every synced folder worth offering as a shortcut. Detection only — nothing is written until the
/// user picks one.
pub fn sync_folders() -> Vec<SyncFolder> {
    let mut found = Vec::new();
    if let Some(path) = icloud_dir() {
        found.push(SyncFolder { kind: "icloud".into(), path: path.to_string_lossy().into_owned() });
    }
    let Some(home) = home() else { return found };

    // OneDrive names the folder after the tenant on a work account ("OneDrive - Contoso"), so the
    // personal path is checked first and the environment variable — which Windows sets to whichever
    // one is actually signed in — second.
    let onedrive = std::env::var_os("OneDrive")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| first_existing(&[home.join("OneDrive")]));
    if let Some(path) = onedrive {
        found.push(SyncFolder { kind: "onedrive".into(), path: path.to_string_lossy().into_owned() });
    }

    if let Some(path) = first_existing(&[home.join("Dropbox")]) {
        found.push(SyncFolder { kind: "dropbox".into(), path: path.to_string_lossy().into_owned() });
    }
    // Google Drive's desktop client, which is a different thing from the Drive *API* destination:
    // this one is just a folder, and needs no OAuth.
    if let Some(path) = first_existing(&[
        home.join("Google Drive"),
        home.join("My Drive"),
        PathBuf::from("G:\\My Drive"),
    ]) {
        found.push(SyncFolder {
            kind: "gdrive-desktop".into(),
            path: path.to_string_lossy().into_owned(),
        });
    }
    found
}

/// Where a backup goes when the user hasn't chosen anywhere: a `Backups` folder beside the
/// database, which is inside the directory the installer already knows to keep or wipe.
pub fn default_folder() -> PathBuf {
    crate::paths::base_dir().join("Backups")
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Writes the current backup into `folder`, rotating the previous one aside first.
///
/// The write goes to a temporary file and is then renamed over the target, which is what makes it
/// atomic: a crash, a full disk or a sync client reading mid-write leaves either the old complete
/// file or the new one, never a half-written backup that looks restorable and isn't.
pub fn write_into_folder(folder: &Path, bytes: &[u8], keep_copies: usize) -> Result<PathBuf, String> {
    std::fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let target = folder.join(current_file_name());

    if keep_copies > 0 && target.exists() {
        // Dated by *now* rather than by the old file's own header: reading the header back would
        // mean a decode on a path that must not be able to fail, and the difference only shows if
        // the clock moved between two backups.
        let rotated = folder.join(dated_file_name(chrono::Local::now()));
        // A failed rotation must not cost the user their new backup — worst case they keep one
        // fewer historical copy.
        let _ = std::fs::rename(&target, &rotated);
        prune(folder, keep_copies);
    }

    let temporary = folder.join(format!(".{}.part", current_file_name()));
    std::fs::write(&temporary, bytes).map_err(|e| format!("{}: {e}", temporary.display()))?;
    // Windows won't rename onto an existing file, so the old one goes first — by which point it has
    // either been rotated aside above or is one the user asked not to keep.
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&temporary, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(target)
}

/// Keeps the newest `keep` dated copies and deletes the rest. Names are timestamped and
/// zero-padded, so sorting them as strings sorts them by age.
fn prune(folder: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    let mut dated: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| {
                    name.starts_with("codeflow-backup-") && name.ends_with(FILE_EXTENSION)
                })
        })
        .collect();
    if dated.len() <= keep {
        return;
    }
    dated.sort();
    for stale in &dated[..dated.len() - keep] {
        let _ = std::fs::remove_file(stale);
    }
}

/// Every backup file in a folder: the current one and each dated copy kept beside it.
///
/// Unsorted — the caller has read the headers by then and can order them by what the files say
/// about themselves, which is the honest answer and not the same as sorting by name: the current
/// file has no date in its name at all, and a folder synced from two machines can hold copies whose
/// names and contents disagree about which is newer.
pub fn list_in_folder(folder: &Path) -> Vec<PathBuf> {
    let current = folder.join(current_file_name());
    let mut found: Vec<PathBuf> = std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| {
                        name.starts_with("codeflow-backup-") && name.ends_with(FILE_EXTENSION)
                    })
        })
        .collect();
    if current.is_file() {
        found.push(current);
    }
    found
}

/// The most recent backup in a folder — the current file if it is there, otherwise the newest
/// rotated copy. What "restore from my synced folder" resolves to without making the user browse.
pub fn newest_in_folder(folder: &Path) -> Option<PathBuf> {
    let current = folder.join(current_file_name());
    if current.is_file() {
        return Some(current);
    }
    let mut dated: Vec<PathBuf> = std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| {
                        name.starts_with("codeflow-backup-") && name.ends_with(FILE_EXTENSION)
                    })
        })
        .collect();
    dated.sort();
    dated.pop()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-backup-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_current_file_always_has_the_same_name() {
        let dir = scratch("stable-name");
        let first = write_into_folder(&dir, b"one", 0).unwrap();
        let second = write_into_folder(&dir, b"two", 0).unwrap();
        assert_eq!(first, second);
        assert_eq!(std::fs::read(&second).unwrap(), b"two");
        // With no copies kept, nothing accumulates.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn rotation_keeps_the_asked_for_number_of_copies() {
        let dir = scratch("rotate");
        for i in 0..6 {
            write_into_folder(&dir, format!("run {i}").as_bytes(), 2).unwrap();
            // The dated name has one-second resolution, and the test would otherwise overwrite
            // its own rotation.
            std::thread::sleep(std::time::Duration::from_millis(1100));
        }
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&current_file_name()));
        let rotated = names.iter().filter(|n| **n != current_file_name()).count();
        assert_eq!(rotated, 2, "expected two rotated copies, saw {names:?}");
    }

    #[test]
    fn the_newest_backup_is_the_current_one_when_it_exists() {
        let dir = scratch("newest");
        assert!(newest_in_folder(&dir).is_none());
        let written = write_into_folder(&dir, b"payload", 1).unwrap();
        assert_eq!(newest_in_folder(&dir), Some(written));
    }

    /// Half-written files must not be mistaken for a backup — restoring one would fail the magic
    /// check, but it must not even be offered.
    #[test]
    fn a_partial_write_is_not_left_behind() {
        let dir = scratch("atomic");
        write_into_folder(&dir, b"payload", 0).unwrap();
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_dated_name_sorts_by_age() {
        let older = dated_file_name(
            chrono::Local::now() - chrono::Duration::days(2),
        );
        let newer = dated_file_name(chrono::Local::now());
        assert!(older < newer, "{older} should sort before {newer}");
    }
}
