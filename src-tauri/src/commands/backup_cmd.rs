//! The commands behind the Backup section of Settings.
//!
//! Everything heavy stays on this side of the bridge. The frontend asks for a backup and gets a
//! path and a row count back; the payload, the credentials and the sealed bytes never cross into
//! the webview at all — which is both faster (no JSON round trip, no base64) and narrower (the
//! renderer is never holding a buffer with every token in it).

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::backup::{self, auto, destination, snapshot::RestoreMode};
use crate::db::Db;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Everything the panel needs in one call, so opening it is one round trip rather than six.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupState {
    pub settings: backup::BackupSettings,
    pub drive: backup::DriveSettings,
    pub onedrive: backup::OneDriveSettings,
    /// Whether a password is stored. The password itself never leaves the backend.
    pub has_passphrase: bool,
    pub destination_ready: bool,
    /// iCloud Drive's folder on this machine, or empty when iCloud isn't set up — which is what
    /// turns the iCloud option into instructions instead of a dead end.
    pub icloud_folder: String,
    /// Every synced folder found, offered as one-click destinations.
    pub sync_folders: Vec<destination::SyncFolder>,
    pub default_folder: String,
    /// `windows` | `macos` | `linux`, so the guides show the right paths.
    pub platform: String,
    /// Whether a backup is being written right now. In the opening round trip as well as on the
    /// event, so a panel opened *during* a scheduled run shows it rather than waiting for the next
    /// change to find out.
    pub running: bool,
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[tauri::command]
pub fn backup_state(db: State<Db>) -> Result<BackupState, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let settings = backup::load_settings(&conn);
    let drive = backup::load_drive(&conn);
    let onedrive = backup::load_onedrive(&conn);
    // A missing password is a normal first-run state, and a credential-store error must not stop
    // the panel from rendering — it is where the user would go to fix it.
    let has_passphrase = backup::passphrase().ok().flatten().is_some();
    Ok(BackupState {
        destination_ready: auto::destination_ready(&settings, &drive.client_id, &onedrive.client_id),
        settings,
        drive,
        onedrive,
        has_passphrase,
        icloud_folder: destination::icloud_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        sync_folders: destination::sync_folders(),
        default_folder: destination::default_folder().to_string_lossy().into_owned(),
        platform: platform().to_string(),
        running: auto::is_running(),
    })
}

#[tauri::command]
pub fn backup_save_settings(db: State<Db>, settings: backup::BackupSettings) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    backup::save_settings(&conn, &settings)
}

/// Stops the scheduled backup and forgets what the step-by-step setup was told, so it asks again.
/// Nothing already written is touched — see [`backup::reset_auto`] for what survives and why.
#[tauri::command]
pub fn backup_reset_auto(db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    backup::reset_auto(&conn)
}

#[tauri::command]
pub fn backup_save_drive(db: State<Db>, drive: backup::DriveSettings) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    backup::save_drive(&conn, &drive)
}

#[tauri::command]
pub fn backup_save_onedrive(
    db: State<Db>,
    onedrive: backup::OneDriveSettings,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    backup::save_onedrive(&conn, &onedrive)
}

// ---------------------------------------------------------------------------
// OneDrive's connection
// ---------------------------------------------------------------------------
//
// Google Drive's equivalents live in `api_cmd` for historical reasons — that destination was part
// of the API client's settings before the backup covered the whole install. OneDrive was never
// anywhere else, so it starts where it belongs.

/// Whether this machine holds a OneDrive grant. One boolean rather than Drive's pair, because a
/// public client registration has no secret to have or not have.
#[tauri::command]
pub fn onedrive_status() -> Result<bool, String> {
    crate::onedrive::is_connected()
}

#[tauri::command]
pub async fn onedrive_connect(
    client_id: String,
) -> Result<crate::onedrive::OneDriveAccount, String> {
    crate::onedrive::connect(client_id).await
}

#[tauri::command]
pub fn onedrive_disconnect() -> Result<(), String> {
    crate::onedrive::disconnect()
}

/// Stores the password. Rejected below the minimum length rather than accepted and quietly weak.
#[tauri::command]
pub fn backup_set_passphrase(passphrase: String) -> Result<(), String> {
    backup::set_passphrase(&passphrase)
}

#[tauri::command]
pub fn backup_clear_passphrase() -> Result<(), String> {
    backup::clear_passphrase()
}

/// Whether the typed password matches the stored one — what the "change password" form checks
/// before overwriting, so a typo can't lock the user out of their own scheduled backups.
#[tauri::command]
pub fn backup_passphrase_matches(passphrase: String) -> Result<bool, String> {
    Ok(backup::passphrase()?.is_some_and(|stored| stored == passphrase))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Writes a one-off backup wherever the user points the save dialog. Returns `None` when the
/// dialog was dismissed — nothing is built until a real path comes back.
///
/// Sealed with the *stored* password rather than one typed into the panel. The app already holds
/// it — the scheduled run writes with nothing else — so asking again only invited a second password
/// for a file that is opened by the same "Restore" as every other one, and a file whose password
/// was a typo is one nobody finds out about until the day they need it.
///
/// Read before the save dialog so a missing password is an error instead of something discovered
/// after choosing where to put the file.
#[tauri::command]
pub async fn backup_export_to_file(app: AppHandle) -> Result<Option<ExportResult>, String> {
    let Some(passphrase) = backup::passphrase()? else {
        return Err("set a backup password first".into());
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(destination::suggested_export_name().as_str())
        .add_filter("CodeFlow backup", &[backup::envelope::FILE_EXTENSION])
        .save_file(move |file| {
            let _ = tx.send(file.map(|p| p.to_string()));
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };

    let version = app.package_info().version.to_string();
    let (sealed, contents, _) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        backup::create(&conn, &passphrase, &version)?
    };
    std::fs::write(&path, &sealed).map_err(|e| format!("{path}: {e}"))?;
    Ok(Some(ExportResult { path, contents }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub contents: backup::BackupContents,
}

/// "Back up now" — writes to the configured destination whether or not anything changed.
#[tauri::command]
pub async fn backup_run_now(app: AppHandle) -> Result<auto::RunOutcome, String> {
    auto::run(&app, true).await
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Opens the picker and reports what the chosen file says about itself — no password involved, so
/// the prompt that follows is about a file the user has already recognised.
///
/// The filter is asked for *and* enforced, because they are two different promises. The filter is a
/// request to the platform's own panel, and how strictly it is honoured is the platform's business:
/// a dialog can offer an "all files" escape, a path can be typed rather than clicked, and on macOS
/// an extension nobody has registered a type for resolves to a dynamic one the panel treats
/// loosely. The check below is what makes "only `.cfbackup`" true rather than merely requested —
/// and it turns picking the wrong file into a sentence about the extension instead of whatever the
/// envelope parser makes of a JPEG.
#[tauri::command]
pub async fn backup_pick_and_inspect(app: AppHandle) -> Result<Option<backup::BackupInfo>, String> {
    let extension = backup::envelope::FILE_EXTENSION;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("CodeFlow backup", &[extension])
        .pick_file(move |file| {
            let _ = tx.send(file.map(|p| p.to_string()));
        });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };

    // Case-insensitively: the file may have come from a Windows machine, or through a sync client
    // that took its own view of the name.
    let matches = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(extension));
    if !matches {
        return Err(format!("that is not a .{extension} file"));
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    backup::inspect(&bytes, &path).map(Some)
}

/// The newest backup already sitting in the configured folder, so restoring from a synced folder
/// on a fresh machine doesn't start with browsing for a file whose name nobody remembers.
#[tauri::command]
pub fn backup_inspect_configured(db: State<Db>) -> Result<Option<backup::BackupInfo>, String> {
    let folder = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        backup::load_settings(&conn).folder
    };
    if folder.trim().is_empty() {
        return Ok(None);
    }
    let Some(path) = destination::newest_in_folder(std::path::Path::new(&folder)) else {
        return Ok(None);
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    backup::inspect(&bytes, &path.to_string_lossy()).map(Some)
}

/// Every backup at the configured destination, newest first — what the restore pane lists so the
/// choice of *which* one is the user's.
///
/// The dated copies exist precisely because the newest backup is often not the one you want: the
/// reason to restore is usually something that went wrong recently, and "the most recent file" is
/// the copy most likely to have it in. Offering only that one made the retention setting above pay
/// for copies nothing could reach.
///
/// Ordered by what each file's own header says, not by name: the current file carries no date in
/// its name, and a folder synced from two machines can hold copies whose names and contents
/// disagree. Unreadable files are skipped rather than failing the listing — one truncated copy
/// mid-sync must not hide the nine good ones beside it.
#[tauri::command]
pub async fn backup_list_at_destination(app: AppHandle) -> Result<Vec<backup::BackupInfo>, String> {
    let (target, folder) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let settings = backup::load_settings(&conn);
        (settings.target, settings.folder)
    };

    if !backup::writes_to_folder(&target) {
        // One file each, kept up to date in place — there is nothing to choose between, so the
        // list is however many of it there is.
        let one = if target == "onedrive" {
            backup_inspect_onedrive(app).await?
        } else {
            backup_inspect_drive(app).await?
        };
        return Ok(one.into_iter().collect());
    }

    if folder.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut found: Vec<backup::BackupInfo> = destination::list_in_folder(std::path::Path::new(&folder))
        .into_iter()
        .filter_map(|path| {
            let bytes = std::fs::read(&path).ok()?;
            backup::inspect(&bytes, &path.to_string_lossy()).ok()
        })
        .collect();
    found.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(found)
}

/// The backup in the connected Drive account, if there is one.
#[tauri::command]
pub async fn backup_inspect_drive(app: AppHandle) -> Result<Option<backup::BackupInfo>, String> {
    let (client_id, known_id) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (
            backup::load_drive(&conn).client_id,
            backup::load_settings(&conn).drive_file_id,
        )
    };
    if client_id.trim().is_empty() {
        return Ok(None);
    }
    let name = destination::current_file_name();
    let file_id = match known_id.trim() {
        "" => crate::gdrive::find_file(client_id.clone(), name).await?,
        id => Some(id.to_string()),
    };
    let Some(file_id) = file_id else { return Ok(None) };
    let bytes = crate::gdrive::download_bytes(client_id, file_id).await?;
    backup::inspect(&bytes, "Google Drive").map(Some)
}

/// The backup in the connected OneDrive account, if there is one.
///
/// One request, not two: the app folder is addressed by path, so there is nothing to look up first
/// and a missing file comes back as `None` from the download itself.
#[tauri::command]
pub async fn backup_inspect_onedrive(app: AppHandle) -> Result<Option<backup::BackupInfo>, String> {
    let client_id = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        backup::load_onedrive(&conn).client_id
    };
    if client_id.trim().is_empty() {
        return Ok(None);
    }
    let Some(bytes) =
        crate::onedrive::download_bytes(client_id, destination::current_file_name()).await?
    else {
        return Ok(None);
    };
    backup::inspect(&bytes, "OneDrive").map(Some)
}

fn mode_of(replace: bool) -> RestoreMode {
    if replace {
        RestoreMode::Replace
    } else {
        RestoreMode::Merge
    }
}

/// Restores from a file on disk. `replace` is the clean restore; without it the backup is merged
/// over whatever is here.
#[tauri::command]
pub fn backup_restore_file(
    db: State<Db>,
    path: String,
    passphrase: String,
    replace: bool,
) -> Result<backup::RestoreReport, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    backup::restore(&mut conn, &bytes, &passphrase, mode_of(replace))
}

#[tauri::command]
pub async fn backup_restore_drive(
    app: AppHandle,
    passphrase: String,
    replace: bool,
) -> Result<backup::RestoreReport, String> {
    let (client_id, known_id) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (
            backup::load_drive(&conn).client_id,
            backup::load_settings(&conn).drive_file_id,
        )
    };
    let name = destination::current_file_name();
    let file_id = match known_id.trim() {
        "" => crate::gdrive::find_file(client_id.clone(), name).await?,
        id => Some(id.to_string()),
    }
    .ok_or("there is no backup in this Drive account yet")?;
    let bytes = crate::gdrive::download_bytes(client_id, file_id).await?;

    let db = app.state::<Db>();
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    backup::restore(&mut conn, &bytes, &passphrase, mode_of(replace))
}

#[tauri::command]
pub async fn backup_restore_onedrive(
    app: AppHandle,
    passphrase: String,
    replace: bool,
) -> Result<backup::RestoreReport, String> {
    let client_id = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        backup::load_onedrive(&conn).client_id
    };
    // Downloaded before the lock is taken: the restore itself holds the database, and holding it
    // across a network round trip would freeze every query in the app behind it.
    let bytes = crate::onedrive::download_bytes(client_id, destination::current_file_name())
        .await?
        .ok_or("there is no backup in this OneDrive account yet")?;

    let db = app.state::<Db>();
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    backup::restore(&mut conn, &bytes, &passphrase, mode_of(replace))
}

/// Lets the user point the destination at a folder. Its own picker rather than the file one
/// because the backup keeps several files there — the current one and its rotated copies.
#[tauri::command]
pub async fn backup_pick_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|p| p.to_string()));
    });
    rx.await.ok().flatten()
}

/// Opens the destination in Explorer/Finder — the fastest way to answer "is my backup actually
/// there?", and the step every cloud guide ends with.
#[tauri::command]
pub fn backup_reveal_folder(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    let folder = if target.is_dir() {
        target
    } else {
        target.parent().map(std::path::Path::to_path_buf).unwrap_or(target)
    };
    std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    open::that(&folder).map_err(|e| e.to_string())
}
