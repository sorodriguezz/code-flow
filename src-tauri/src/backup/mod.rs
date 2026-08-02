//! The whole-install backup: one encrypted file that turns another computer into this one.
//!
//! What it is for, in the user's own words: import the file on a different machine and be able to
//! do everything again — including authenticate — without carrying across a record of what was done
//! on the first one. So this moves *configuration and credentials*, and deliberately not history
//! (see [`snapshot`] for the table-by-table reasoning).
//!
//! Four modules, one job each:
//!
//! - [`snapshot`] — what travels, and how it is copied out of and back into SQLite.
//! - [`vault`] — the credentials, reconstructed from a store that cannot be listed.
//! - [`envelope`] — Argon2id + AES-256-GCM over the compressed whole, and the file's frame.
//! - [`destination`] — a folder, iCloud Drive, or the user's own Google Drive or OneDrive, plus
//!   rotation.
//!
//! All of it runs in Rust rather than in the webview. The payload is every credential the user has
//! in one buffer; handing that to JavaScript to be encrypted would mean a JSON round trip, a base64
//! copy and a second copy of every secret living in the renderer's heap, in exchange for nothing.
//! Sealed here it is one pass: read, compress, encrypt, write — a few hundred milliseconds for a
//! configuration of any realistic size, which is what makes a scheduled backup unnoticeable.

pub mod auto;
pub mod destination;
pub mod envelope;
pub mod snapshot;
pub mod vault;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::db::queries;
use crate::secrets;

use snapshot::{RestoreMode, RestoreSummary, Snapshot};

/// Where the schedule, the destination and the last run's outcome live. Machine-local, and
/// excluded from the backup itself — see `snapshot::MACHINE_LOCAL_SETTINGS`.
const SETTINGS_KEY: &str = "backup_settings";

/// The half of the Google Drive setup that *is* portable: the id of the user's own OAuth client,
/// and the account it was granted by. Its own key so it rides along in the backup while the
/// destination and schedule stay behind.
const DRIVE_KEY: &str = "backup_drive";

/// The same for OneDrive, and for the same reason: the Entra application id is a one-time setup in
/// the Azure portal, and a restored machine should not have to repeat it.
const ONEDRIVE_KEY: &str = "backup_onedrive";

/// Below this a passphrase isn't protecting anything an offline attack couldn't walk through, and
/// this file is meant to sit in someone's cloud storage.
pub const MIN_PASSPHRASE_LENGTH: usize = 8;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupSettings {
    /// Whether the scheduled backup runs at all.
    pub enabled: bool,
    /// `folder` | `icloud` | `gdrive` | `onedrive`.
    pub target: String,
    /// The destination directory for `folder` and `icloud`. Empty means "not chosen yet", which is
    /// the only reason `enabled` can't be turned on.
    pub folder: String,
    /// How often the scheduler considers writing. Not how often it *writes* — an unchanged
    /// configuration is skipped, see [`run`].
    pub interval_minutes: u32,
    /// Also back up when the app is quit, so the last session's work is never the one missing.
    pub on_exit: bool,
    /// Dated copies kept beside the current file. The backup you need is often not the newest one.
    pub keep_copies: u32,
    /// The Drive file being kept up to date. Learned on the first upload, or found on a second
    /// machine — and machine-local, because it names a file this install has permission to write.
    ///
    /// Google Drive only. OneDrive has no counterpart because its app folder is addressed by path:
    /// the same file name resolves to the same file on every machine, so there is no id to learn.
    pub drive_file_id: String,
    pub last_backup_at: String,
    pub last_backup_path: String,
    /// The last failure, kept so an automatic backup that has been quietly failing for a week is
    /// visible in settings rather than only in a toast nobody was there to see.
    pub last_error: String,
    /// Digest of the last payload written. What makes a scheduled run cost nothing when nothing
    /// changed — no encryption, no write, no upload.
    pub last_hash: String,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            target: "folder".into(),
            folder: String::new(),
            // Half-hourly: often enough that losing work means losing minutes, rare enough that the
            // scheduled run is never something the user notices happening.
            interval_minutes: 30,
            on_exit: true,
            keep_copies: 5,
            drive_file_id: String::new(),
            last_backup_at: String::new(),
            last_backup_path: String::new(),
            last_error: String::new(),
            last_hash: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DriveSettings {
    pub client_id: String,
    pub account: String,
}

/// The portable half of the OneDrive setup. Same shape as [`DriveSettings`], one field short of it
/// in spirit: an Entra public client has no secret, so this really is the whole configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OneDriveSettings {
    /// The "Application (client) ID" from the app registration.
    pub client_id: String,
    pub account: String,
}

/// Whether a target writes into a directory on this machine.
///
/// `folder` and `icloud` do — iCloud Drive *is* a directory, which is the whole reason it needs no
/// credentials. `gdrive` and `onedrive` go over the network instead, and for them `folder` means
/// nothing and must not be the thing that decides whether a destination is usable.
pub fn writes_to_folder(target: &str) -> bool {
    !matches!(target, "gdrive" | "onedrive")
}

fn read_json<T: Default + serde::de::DeserializeOwned>(conn: &Connection, key: &str) -> T {
    queries::get_setting(conn, key)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(conn: &Connection, key: &str, value: &T) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    queries::set_setting(conn, key, &json).map_err(|e| e.to_string())
}

pub fn load_settings(conn: &Connection) -> BackupSettings {
    let mut settings: BackupSettings = read_json(conn, SETTINGS_KEY);
    // A destination has to have *some* answer before the first run, or "back up now" is a button
    // that reports success and leaves the file somewhere the user was never told about.
    if settings.folder.trim().is_empty() && writes_to_folder(&settings.target) {
        settings.folder = destination::default_folder().to_string_lossy().into_owned();
    }
    settings
}

pub fn save_settings(conn: &Connection, settings: &BackupSettings) -> Result<(), String> {
    write_json(conn, SETTINGS_KEY, settings)
}

/// The Drive client, carried forward from the API client's own backup settings the first time this
/// is read. The old panel stored it inside the `api_settings` blob; a user who had already set up
/// Drive there should not have to create a Google Cloud project a second time.
pub fn load_drive(conn: &Connection) -> DriveSettings {
    let drive: DriveSettings = read_json(conn, DRIVE_KEY);
    if !drive.client_id.trim().is_empty() {
        return drive;
    }
    let legacy: serde_json::Value = queries::get_setting(conn, "api_settings")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(serde_json::Value::Null);
    let field = |name: &str| {
        legacy
            .get(name)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    DriveSettings { client_id: field("driveClientId"), account: field("driveAccount") }
}

pub fn save_drive(conn: &Connection, drive: &DriveSettings) -> Result<(), String> {
    write_json(conn, DRIVE_KEY, drive)
}

/// The OneDrive client. No legacy fallback of its own — this destination never lived in the API
/// client's settings, so there is nothing to carry forward from.
pub fn load_onedrive(conn: &Connection) -> OneDriveSettings {
    read_json(conn, ONEDRIVE_KEY)
}

pub fn save_onedrive(conn: &Connection, onedrive: &OneDriveSettings) -> Result<(), String> {
    write_json(conn, ONEDRIVE_KEY, onedrive)
}

// ---------------------------------------------------------------------------
// The passphrase
// ---------------------------------------------------------------------------

/// The stored passphrase, migrating the API client's one across the first time it is asked for.
pub fn passphrase() -> Result<Option<String>, String> {
    if let Some(stored) = secrets::get_secret(&secrets::backup_passphrase_key())? {
        if !stored.is_empty() {
            return Ok(Some(stored));
        }
    }
    let Some(legacy) = secrets::get_secret(&secrets::api_backup_passphrase_key())? else {
        return Ok(None);
    };
    if legacy.is_empty() {
        return Ok(None);
    }
    // Copied, not moved: an install rolled back to the previous version would otherwise find its
    // API backups unreadable.
    secrets::set_secret(&secrets::backup_passphrase_key(), &legacy)?;
    Ok(Some(legacy))
}

pub fn set_passphrase(value: &str) -> Result<(), String> {
    if value.chars().count() < MIN_PASSPHRASE_LENGTH {
        return Err(format!(
            "the password must be at least {MIN_PASSPHRASE_LENGTH} characters"
        ));
    }
    secrets::set_secret(&secrets::backup_passphrase_key(), value)
}

pub fn clear_passphrase() -> Result<(), String> {
    secrets::delete_secret(&secrets::backup_passphrase_key())
}

// ---------------------------------------------------------------------------
// Building and opening
// ---------------------------------------------------------------------------

/// What went into a file, for the line the UI shows after writing one.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupContents {
    pub rows: i64,
    pub secrets: i64,
    pub tables: i64,
    /// Size of the sealed file, so "1.2 MB in Drive" is answerable without stat-ing it.
    pub bytes: u64,
}

/// The payload before it is sealed, plus the digest that lets an unchanged configuration skip the
/// whole rest of the pipeline.
///
/// Built and sealed in two steps rather than one so the scheduler can do the first under the
/// database lock and the second — Argon2, which is expensive by design — without it.
pub struct Payload {
    pub bytes: Vec<u8>,
    pub hash: String,
    pub contents: BackupContents,
}

pub fn build_payload(conn: &Connection) -> Result<Payload, String> {
    let tables = snapshot::export(conn).map_err(|e| e.to_string())?;
    let secrets = vault::collect(conn);
    let contents = BackupContents {
        rows: tables.iter().map(|t| t.rows.len() as i64).sum(),
        secrets: secrets.len() as i64,
        tables: tables.len() as i64,
        bytes: 0,
    };
    let snapshot = Snapshot { tables, secrets };
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    // Over the plaintext, not the file: two seals of identical data differ by design (fresh salt
    // and nonce every time), so hashing the file would make every run look like a change.
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok(Payload { bytes, hash, contents })
}

/// Seals an already-built payload. Split out so a caller holding the database lock can drop it
/// before paying for the key derivation.
pub fn seal_payload(
    payload: Payload,
    passphrase: &str,
    app_version: &str,
) -> Result<(Vec<u8>, BackupContents), String> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LENGTH {
        return Err(format!(
            "the password must be at least {MIN_PASSPHRASE_LENGTH} characters"
        ));
    }
    let mut contents = payload.contents;
    let sealed = envelope::seal(payload.bytes, passphrase, app_version)?;
    contents.bytes = sealed.len() as u64;
    Ok((sealed, contents))
}

/// Builds and seals a backup in one go. The returned bytes are the file, ready to be written or
/// uploaded; the string is the payload digest an unchanged next run compares against.
pub fn create(
    conn: &Connection,
    passphrase: &str,
    app_version: &str,
) -> Result<(Vec<u8>, BackupContents, String), String> {
    let payload = build_payload(conn)?;
    let hash = payload.hash.clone();
    let (sealed, contents) = seal_payload(payload, passphrase, app_version)?;
    Ok((sealed, contents, hash))
}

/// What a restore did, and what still needs a human afterwards.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub rows: i64,
    pub secrets: i64,
    pub tables: Vec<TableCount>,
    /// Projects whose folder isn't on this machine — the expected consequence of moving computers.
    pub missing_project_paths: Vec<String>,
    /// Credentials the OS store refused. On macOS this is usually a dismissed Keychain prompt.
    pub failed_secrets: Vec<String>,
    pub dangling_rows: i64,
    pub created_at: String,
    pub from_os: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCount {
    pub name: String,
    pub rows: i64,
}

fn report(summary: RestoreSummary, header: &envelope::BackupHeader) -> RestoreReport {
    RestoreReport {
        rows: summary.rows,
        secrets: 0,
        tables: summary
            .tables
            .into_iter()
            .map(|(name, rows)| TableCount { name, rows })
            .collect(),
        missing_project_paths: summary.missing_project_paths,
        failed_secrets: Vec::new(),
        dangling_rows: summary.dangling_rows,
        created_at: header.created_at.clone(),
        from_os: header.os.clone(),
        app_version: header.app_version.clone(),
    }
}

/// Opens a backup and applies it: tables first, then credentials.
///
/// That order is deliberate. The tables are what a failure can be diagnosed from, and writing the
/// credentials first would leave a machine holding tokens for repositories it has no rows for.
pub fn restore(
    conn: &mut Connection,
    file: &[u8],
    passphrase: &str,
    mode: RestoreMode,
) -> Result<RestoreReport, String> {
    let header = envelope::read_header(file)?;
    let plain = envelope::open(file, passphrase)?;
    let snapshot: Snapshot =
        serde_json::from_slice(&plain).map_err(|_| "the backup's contents could not be read")?;

    let summary = snapshot::apply(conn, &snapshot.tables, mode).map_err(|e| e.to_string())?;
    let mut report = report(summary, &header);

    let (written, failed) = vault::restore(&snapshot.secrets);
    report.secrets = written;
    report.failed_secrets = failed;
    Ok(report)
}

/// What a file says about itself before anyone types a password.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub created_at: String,
    pub app_version: String,
    pub os: String,
    pub bytes: u64,
    pub path: String,
}

pub fn inspect(bytes: &[u8], path: &str) -> Result<BackupInfo, String> {
    let header = envelope::read_header(bytes)?;
    Ok(BackupInfo {
        created_at: header.created_at,
        app_version: header.app_version,
        os: header.os,
        bytes: bytes.len() as u64,
        path: path.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            r#"
            DELETE FROM workspaces;
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Flow', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                VALUES ('c1', 'w1', 'My API', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();
        conn
    }

    /// The end-to-end promise: seal here, open there, and the second machine has the first one's
    /// configuration.
    #[test]
    fn a_backup_moves_a_configuration_between_two_databases() {
        let source = seeded();
        let (file, contents, _) = create(&source, "a-long-enough-password", "1.10.2").unwrap();
        assert!(contents.rows > 0);
        assert!(contents.bytes > 0);

        let mut target = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&target).unwrap();
        target.execute_batch("DELETE FROM workspaces;").unwrap();

        let report = restore(&mut target, &file, "a-long-enough-password", RestoreMode::Replace).unwrap();
        assert!(report.rows > 0);
        assert_eq!(report.app_version, "1.10.2");
        let count: i64 = target
            .query_row("SELECT COUNT(*) FROM api_collections WHERE id = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn a_short_password_is_refused_before_anything_is_written() {
        assert!(create(&seeded(), "short", "1.0.0").is_err());
        assert!(set_passphrase("short").is_err());
    }

    /// The digest is over the data, so an unchanged configuration produces the same one twice —
    /// which is what lets the scheduler skip a run entirely.
    #[test]
    fn an_unchanged_configuration_hashes_the_same() {
        let conn = seeded();
        let (_, _, first) = create(&conn, "a-long-enough-password", "1.0.0").unwrap();
        let (_, _, second) = create(&conn, "a-long-enough-password", "1.0.0").unwrap();
        assert_eq!(first, second);

        conn.execute(
            "INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
             VALUES ('c2', 'w1', 'Another', '2026-02-01T00:00:00+00:00', '2026-02-01T00:00:00+00:00')",
            [],
        )
        .unwrap();
        let (_, _, third) = create(&conn, "a-long-enough-password", "1.0.0").unwrap();
        assert_ne!(first, third);
    }

    #[test]
    fn the_header_is_readable_before_the_password_is() {
        let (file, _, _) = create(&seeded(), "a-long-enough-password", "9.9.9").unwrap();
        let info = inspect(&file, "C:/tmp/x.cfbackup").unwrap();
        assert_eq!(info.app_version, "9.9.9");
        assert_eq!(info.bytes, file.len() as u64);
        assert!(!info.created_at.is_empty());
    }

    #[test]
    fn a_wrong_password_restores_nothing() {
        let (file, _, _) = create(&seeded(), "a-long-enough-password", "1.0.0").unwrap();
        let mut target = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&target).unwrap();
        target.execute_batch("DELETE FROM workspaces;").unwrap();

        assert!(restore(&mut target, &file, "the-wrong-password", RestoreMode::Replace).is_err());
        let count: i64 = target
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "a failed restore must not have touched the database");
    }

    /// The settings that describe *this* machine must survive a restore of another machine's
    /// backup — the destination folder in particular, which does not exist over there.
    #[test]
    fn the_destination_is_not_overwritten_by_someone_elses() {
        let source = seeded();
        save_settings(
            &source,
            &BackupSettings { folder: "/from/the/other/mac".into(), ..Default::default() },
        )
        .unwrap();
        let (file, _, _) = create(&source, "a-long-enough-password", "1.0.0").unwrap();

        let mut target = seeded();
        save_settings(
            &target,
            &BackupSettings { folder: "D:/mine".into(), ..Default::default() },
        )
        .unwrap();
        restore(&mut target, &file, "a-long-enough-password", RestoreMode::Replace).unwrap();

        assert_eq!(load_settings(&target).folder, "D:/mine");
    }

    /// The Drive client id, by contrast, is exactly the sort of thing that should travel.
    #[test]
    fn the_drive_client_travels_with_the_backup() {
        let source = seeded();
        save_drive(
            &source,
            &DriveSettings { client_id: "1234.apps.googleusercontent.com".into(), account: "me@example.com".into() },
        )
        .unwrap();
        let (file, _, _) = create(&source, "a-long-enough-password", "1.0.0").unwrap();

        let mut target = seeded();
        restore(&mut target, &file, "a-long-enough-password", RestoreMode::Replace).unwrap();
        assert_eq!(load_drive(&target).client_id, "1234.apps.googleusercontent.com");
    }

    /// And so does the OneDrive one — which is the entire setup for that destination, so a restored
    /// machine is one press of Connect away from backing itself up again.
    #[test]
    fn the_onedrive_client_travels_with_the_backup() {
        let source = seeded();
        save_onedrive(
            &source,
            &OneDriveSettings {
                client_id: "8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8".into(),
                account: "me@outlook.com".into(),
            },
        )
        .unwrap();
        let (file, _, _) = create(&source, "a-long-enough-password", "1.0.0").unwrap();

        let mut target = seeded();
        restore(&mut target, &file, "a-long-enough-password", RestoreMode::Replace).unwrap();
        let restored = load_onedrive(&target);
        assert_eq!(restored.client_id, "8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8");
        assert_eq!(restored.account, "me@outlook.com");
    }

    /// The two network destinations must not be waiting on a folder that means nothing to them —
    /// and the two that *are* folders must still get one filled in.
    #[test]
    fn only_the_folder_targets_are_given_a_default_folder() {
        for target in ["folder", "icloud"] {
            let conn = seeded();
            save_settings(&conn, &BackupSettings { target: target.into(), ..Default::default() })
                .unwrap();
            assert!(!load_settings(&conn).folder.is_empty(), "{target} needs a folder");
        }
        for target in ["gdrive", "onedrive"] {
            let conn = seeded();
            save_settings(&conn, &BackupSettings { target: target.into(), ..Default::default() })
                .unwrap();
            assert!(load_settings(&conn).folder.is_empty(), "{target} has no folder to default");
        }
    }
}
