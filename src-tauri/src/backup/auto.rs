//! The scheduled backup, and the one taken on the way out.
//!
//! Two things make this cheap enough to leave switched on:
//!
//! - **It is time-driven, not change-driven.** The panel it replaces rewrote the file ten seconds
//!   after any edit, which on a renamed request meant one full export per keystroke. This looks at
//!   the clock instead, so a busy hour costs the same as an idle one.
//! - **An unchanged configuration costs a hash.** The payload is built and digested under the
//!   database lock; if the digest matches the last run's, nothing is encrypted, written or
//!   uploaded. Argon2 is deliberately expensive, and skipping it is most of the saving.
//!
//! The lock is never held across the network. Build and digest under it, drop it, then seal and
//! upload — otherwise a slow Drive round trip would freeze every query in the app behind it.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::db::Db;

use super::{destination, BackupContents, BackupSettings};

/// How often the scheduler wakes to look at the clock. Not the backup interval — that is the
/// user's, and is measured in tens of minutes; this is just the resolution it is honoured at.
const TICK: Duration = Duration::from_secs(60);

/// A backup on the way out has to finish before the process does, but it must not be able to hold
/// a quit open. Local writes take milliseconds; the bound exists for the Drive upload.
const EXIT_BUDGET: Duration = Duration::from_secs(20);

/// The outcome of one run. `wrote = false` with no error is the good, common case: nothing had
/// changed, so nothing needed writing.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub wrote: bool,
    /// The file's path, or its name in Drive.
    pub path: String,
    pub at: String,
    pub contents: BackupContents,
    /// Set when the run was skipped rather than performed: `unchanged`, `disabled`,
    /// `no-destination`, `no-password`.
    pub skipped: String,
}

fn skipped(reason: &str) -> RunOutcome {
    RunOutcome { skipped: reason.to_string(), ..Default::default() }
}

/// Whether a destination is configured well enough to write to — what greys out the switch.
///
/// Each target is asked only about the piece it actually uses: a folder for the two that write to
/// one, and a client id for the two that sign in. Checking the wrong one is how a destination ends
/// up looking ready and failing on the first run.
pub fn destination_ready(
    settings: &BackupSettings,
    drive_client_id: &str,
    onedrive_client_id: &str,
) -> bool {
    match settings.target.as_str() {
        "gdrive" => !drive_client_id.trim().is_empty(),
        "onedrive" => !onedrive_client_id.trim().is_empty(),
        _ => !settings.folder.trim().is_empty(),
    }
}

/// Runs a backup to the configured destination.
///
/// `force` is the "Back up now" button: it writes even when nothing changed, because a user who
/// pressed a button and was told "nothing to do" has no way to tell that from a failure.
pub async fn run(app: &AppHandle, force: bool) -> Result<RunOutcome, String> {
    let version = app.package_info().version.to_string();

    // ---- under the lock: settings, credentials list, payload, digest ----
    let (mut settings, drive, onedrive, payload, passphrase) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let settings = super::load_settings(&conn);
        let drive = super::load_drive(&conn);
        let onedrive = super::load_onedrive(&conn);
        if !force && !settings.enabled {
            return Ok(skipped("disabled"));
        }
        if !destination_ready(&settings, &drive.client_id, &onedrive.client_id) {
            return Ok(skipped("no-destination"));
        }
        let Some(passphrase) = super::passphrase()? else {
            return Ok(skipped("no-password"));
        };
        let payload = super::build_payload(&conn)?;
        (settings, drive, onedrive, payload, passphrase)
    };

    if !force && payload.hash == settings.last_hash {
        return Ok(skipped("unchanged"));
    }

    let hash = payload.hash.clone();
    let (sealed, contents) = super::seal_payload(payload, &passphrase, &version)?;

    // ---- outside the lock: encrypt-and-send ----
    let at = chrono::Utc::now().to_rfc3339();
    let written = match settings.target.as_str() {
        "gdrive" => {
            let name = destination::current_file_name();
            // No id yet means either the first upload from this install or a second machine that
            // has just connected: ask Drive before creating anything, or each machine ends up
            // maintaining a backup of its own.
            let existing = match settings.drive_file_id.trim() {
                "" => crate::gdrive::find_file(drive.client_id.clone(), name.clone()).await?,
                id => Some(id.to_string()),
            };
            let id = crate::gdrive::upload_bytes(
                drive.client_id.clone(),
                existing,
                name.clone(),
                "application/octet-stream",
                sealed,
            )
            .await?;
            settings.drive_file_id = id;
            name
        }
        // No lookup step and no id to remember: the app folder is addressed by path, so the name
        // alone already means "the backup", on this machine and on the next one.
        "onedrive" => {
            let name = destination::current_file_name();
            crate::onedrive::upload_bytes(onedrive.client_id.clone(), name.clone(), sealed).await?;
            name
        }
        _ => {
            let folder = std::path::PathBuf::from(&settings.folder);
            destination::write_into_folder(&folder, &sealed, settings.keep_copies as usize)?
                .to_string_lossy()
                .into_owned()
        }
    };

    settings.last_backup_at = at.clone();
    settings.last_backup_path = written.clone();
    settings.last_error = String::new();
    settings.last_hash = hash;
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        super::save_settings(&conn, &settings)?;
    }

    Ok(RunOutcome { wrote: true, path: written, at, contents, skipped: String::new() })
}

/// Records a failed automatic run so it is visible in settings rather than only in a toast that
/// nobody was there to see.
fn remember_error(app: &AppHandle, message: &str) {
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return };
    let mut settings = super::load_settings(&conn);
    settings.last_error = message.to_string();
    let _ = super::save_settings(&conn, &settings);
}

/// Whether enough time has passed since the last successful run.
fn due(settings: &BackupSettings) -> bool {
    if !settings.enabled {
        return false;
    }
    if settings.last_backup_at.is_empty() {
        return true;
    }
    let Ok(last) = chrono::DateTime::parse_from_rfc3339(&settings.last_backup_at) else {
        // An unparseable timestamp means the setting was hand-edited or written by a build that
        // spelled it differently; backing up now is the safe reading of "we don't know".
        return true;
    };
    let minutes = settings.interval_minutes.max(1) as i64;
    chrono::Utc::now().signed_duration_since(last.with_timezone(&chrono::Utc))
        >= chrono::Duration::minutes(minutes)
}

/// Starts the ticker. Idempotent in practice — called once from `setup`.
pub fn spawn(app: AppHandle) {
    // One-off, at startup: persist the Drive client under the backup's own key before anything can
    // rewrite the `api_settings` blob it was read out of. `load_drive` falls back to that blob, but
    // the fallback only survives until the API settings are next saved — by which point the user
    // would have silently lost a client id they created a Google Cloud project for.
    if let Some(db) = app.try_state::<Db>() {
        if let Ok(conn) = db.0.lock() {
            let drive = super::load_drive(&conn);
            if !drive.client_id.trim().is_empty() {
                let _ = super::save_drive(&conn, &drive);
            }
        }
    }

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            let is_due = {
                let Some(db) = app.try_state::<Db>() else { continue };
                let Ok(conn) = db.0.lock() else { continue };
                due(&super::load_settings(&conn))
            };
            if !is_due {
                continue;
            }
            // A failed scheduled backup stays quiet in the interface: it runs unattended, and a
            // toast every half hour because a synced folder went offline would be worse than the
            // missed write. `last_error` in settings is what makes it visible.
            if let Err(message) = run(&app, false).await {
                remember_error(&app, &message);
            }
        }
    });
}

/// The backup taken as the app quits, from the three places that actually terminate the process.
///
/// Synchronous by necessity — the tray and menu handlers that call it are — and bounded, so a
/// destination that has stopped answering delays the quit by seconds rather than preventing it.
pub fn flush_on_exit(app: &AppHandle) {
    let wanted = {
        let Some(db) = app.try_state::<Db>() else { return };
        let Ok(conn) = db.0.lock() else { return };
        let settings = super::load_settings(&conn);
        settings.enabled && settings.on_exit
    };
    if !wanted {
        return;
    }
    let app = app.clone();
    let _ = tauri::async_runtime::block_on(async move {
        tokio::time::timeout(EXIT_BUDGET, run(&app, false)).await
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes_ago: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::minutes(minutes_ago)).to_rfc3339()
    }

    #[test]
    fn a_disabled_backup_is_never_due() {
        let settings = BackupSettings { enabled: false, ..Default::default() };
        assert!(!due(&settings));
    }

    #[test]
    fn the_first_run_is_due_immediately() {
        let settings = BackupSettings { enabled: true, ..Default::default() };
        assert!(due(&settings));
    }

    #[test]
    fn the_interval_is_honoured() {
        let recent = BackupSettings {
            enabled: true,
            interval_minutes: 30,
            last_backup_at: at(5),
            ..Default::default()
        };
        assert!(!due(&recent));

        let stale = BackupSettings { last_backup_at: at(31), ..recent.clone() };
        assert!(due(&stale));
    }

    /// A timestamp nothing can parse must not wedge the scheduler into never running again.
    #[test]
    fn an_unreadable_timestamp_means_back_up_now() {
        let settings = BackupSettings {
            enabled: true,
            last_backup_at: "last tuesday".into(),
            ..Default::default()
        };
        assert!(due(&settings));
    }

    #[test]
    fn a_destination_needs_the_piece_its_target_actually_uses() {
        const GOOGLE: &str = "1234.apps.googleusercontent.com";
        const ENTRA: &str = "8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";

        let folder = BackupSettings { target: "folder".into(), folder: "D:/b".into(), ..Default::default() };
        assert!(destination_ready(&folder, "", ""));

        let no_folder = BackupSettings { target: "icloud".into(), folder: String::new(), ..Default::default() };
        assert!(!destination_ready(&no_folder, GOOGLE, ENTRA));

        let drive = BackupSettings { target: "gdrive".into(), folder: String::new(), ..Default::default() };
        assert!(!destination_ready(&drive, "", ""));
        assert!(destination_ready(&drive, GOOGLE, ""));

        let onedrive = BackupSettings { target: "onedrive".into(), folder: String::new(), ..Default::default() };
        assert!(!destination_ready(&onedrive, "", ""));
        assert!(destination_ready(&onedrive, "", ENTRA));
        // Neither cloud may be satisfied by the other one's credential.
        assert!(!destination_ready(&onedrive, GOOGLE, ""));
        assert!(!destination_ready(&drive, "", ENTRA));
    }
}
