import { invoke } from "@tauri-apps/api/core";

/**
 * IPC surface for the whole-install backup.
 *
 * Thin on purpose. Everything of substance — reading the configuration, gathering the credentials
 * out of the OS store, compressing, deriving the key, sealing, rotating, uploading — happens in
 * Rust (`src-tauri/src/backup/`). Nothing here ever holds the payload, and nothing here ever holds
 * the stored password: the panel asks whether one is set, and types a new one in when changing it.
 *
 * That is a performance decision as much as a security one. The alternative — exporting to JSON,
 * shipping it across the bridge, encrypting it with WebCrypto — costs two serialisations and a
 * base64 copy of every byte, and would put a buffer containing every token the user owns into the
 * renderer's heap for the garbage collector to keep as long as it likes.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * Where the backup goes.
 *
 * `folder` covers Dropbox, Proton Drive and anything else that is a directory a sync client
 * watches; `icloud` is the same trick with the folder found for the user, because Apple publishes
 * no service API for iCloud Drive at all. The last two sign in instead, and reach the account
 * directly — so they work whether or not a desktop sync client is installed.
 */
export type BackupTarget = "folder" | "icloud" | "gdrive" | "onedrive";

/** Whether a target writes into a directory on this machine rather than over the network. */
export const writesToFolder = (target: BackupTarget) =>
  target !== "gdrive" && target !== "onedrive";

/**
 * Whether the chosen destination has the one piece it actually needs.
 *
 * Each target is asked only about its own: a folder for the two that write to one, a client id for
 * the two that sign in. Mirrors `destination_ready` in `backup/auto.rs` — the backend is what
 * decides, and this is so the panel can say so before a run has to prove it.
 */
export function destinationReady(
  settings: Pick<BackupSettings, "target" | "folder">,
  driveClientId: string,
  onedriveClientId: string,
): boolean {
  if (settings.target === "gdrive") return driveClientId.trim() !== "";
  if (settings.target === "onedrive") return onedriveClientId.trim() !== "";
  return settings.folder.trim() !== "";
}

/**
 * What goes into the file, group by group. Mirrors `snapshot::Selection` in Rust, and the keys
 * double as translation keys (`backup.include.<key>` / `.hint`).
 *
 * The setup itself — workspaces, repositories, prompts, agents, MCP servers and every setting — has
 * no switch: everything below hangs off it, and a backup without it restores into nothing.
 */
export interface BackupInclude {
  /** Every token, key and password from the OS credential store. */
  credentials: boolean;
  apiClient: boolean;
  databases: boolean;
  /** SSH hosts and snippets. Their passwords ride with `credentials`, not with this. */
  remote: boolean;
  authored: boolean;
  /** Markdown notes, their folders and their templates. Separate from `authored` — see the group's
   *  comment in `snapshot.rs` for why the notebook gets its own switch. */
  notes: boolean;
  requestHistory: boolean;
  conversations: boolean;
  reviews: boolean;
  agentWork: boolean;
  cookies: boolean;
}

/** The order the panel lists the switches in — matches `GROUPS` in `snapshot.rs`. */
export const INCLUDE_KEYS: readonly (keyof BackupInclude)[] = [
  "credentials",
  "apiClient",
  "databases",
  "remote",
  "authored",
  "notes",
  "requestHistory",
  "conversations",
  "reviews",
  "agentWork",
  "cookies",
];

export interface BackupSettings {
  enabled: boolean;
  target: BackupTarget;
  folder: string;
  /** How often the scheduler *considers* writing; an unchanged configuration is skipped. */
  intervalMinutes: number;
  onExit: boolean;
  /** Dated copies kept beside the current file. */
  keepCopies: number;
  driveFileId: string;
  lastBackupAt: string;
  lastBackupPath: string;
  /** The last automatic failure, so a silently broken backup is visible here rather than nowhere. */
  lastError: string;
  /** What the file holds. A preference, so it travels with the backup like the schedule does. */
  include: BackupInclude;
  lastHash: string;
  /** Whether the step-by-step setup has been finished — what shows the summary instead of the
   * wizard. Stored rather than inferred: the backend fills in a default folder, so "has somewhere
   * to write" is true before anything has been asked. */
  setupDone: boolean;
}

/** The portable half of the Google Drive setup — it rides along inside the backup. */
export interface DriveSettings {
  clientId: string;
  account: string;
}

/**
 * The OneDrive setup, which is portable in its entirety: an Entra public client has no secret, so
 * the application id is the whole of it. A restored machine is one press of Connect from backing
 * itself up again.
 */
export interface OneDriveSettings {
  clientId: string;
  account: string;
}

/** A synced folder found on this machine, offered as a one-click destination. */
export interface SyncFolder {
  kind: "icloud" | "onedrive" | "dropbox" | "gdrive-desktop";
  path: string;
}

export interface BackupState {
  settings: BackupSettings;
  drive: DriveSettings;
  onedrive: OneDriveSettings;
  hasPassphrase: boolean;
  destinationReady: boolean;
  /** Empty when iCloud Drive isn't set up here — which turns that option into instructions. */
  icloudFolder: string;
  syncFolders: SyncFolder[];
  defaultFolder: string;
  platform: "windows" | "macos" | "linux";
  /** Whether a backup is being written right now — by the scheduler as much as by the button. */
  running: boolean;
}

/** What went into a file, for the line shown after writing one. */
export interface BackupContents {
  rows: number;
  secrets: number;
  tables: number;
  bytes: number;
}

/** What a file says about itself, read without the password. */
export interface BackupInfo {
  createdAt: string;
  appVersion: string;
  os: string;
  bytes: number;
  /** The path it was read from, or `"Google Drive"` / `"OneDrive"`. */
  path: string;
}

export interface RestoreReport {
  rows: number;
  secrets: number;
  tables: { name: string; rows: number }[];
  /** Projects whose folder isn't on this machine — expected after moving computers. */
  missingProjectPaths: string[];
  /** Credentials the OS store refused; on macOS, usually a dismissed Keychain prompt. */
  failedSecrets: string[];
  danglingRows: number;
  createdAt: string;
  fromOs: string;
  appVersion: string;
}

/** Why a run wrote nothing. `unchanged` is the good case, not a failure. */
export type BackupSkip =
  | ""
  | "unchanged"
  | "disabled"
  | "no-destination"
  | "no-password"
  /** Another run — the scheduler's, usually — already had the flag. */
  | "busy";

export interface RunOutcome {
  wrote: boolean;
  path: string;
  at: string;
  contents: BackupContents;
  skipped: BackupSkip;
}

export interface ExportResult {
  path: string;
  contents: BackupContents;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Everything the panel needs, in one round trip. */
export const backupState = () => invoke<BackupState>("backup_state");

export const backupSaveSettings = (settings: BackupSettings) =>
  invoke<void>("backup_save_settings", { settings });

/** Stops the schedule and forgets what the step-by-step setup was told, so it asks again. The
 * backups already written are left where they are; the Drive and OneDrive connections are not —
 * they are signed out and forgotten along with the rest of the setup. */
export const backupResetAuto = () => invoke<void>("backup_reset_auto");

export const backupSaveDrive = (drive: DriveSettings) =>
  invoke<void>("backup_save_drive", { drive });

export const backupSaveOneDrive = (onedrive: OneDriveSettings) =>
  invoke<void>("backup_save_onedrive", { onedrive });

// ---------------------------------------------------------------------------
// OneDrive's connection
// ---------------------------------------------------------------------------
//
// Google Drive's equivalents live in `apiCommands` for historical reasons — that destination was
// part of the API client's settings before the backup covered the whole install.

/** Whether this machine holds a OneDrive grant. One boolean, because a public client has no
 * secret to have or not have. */
export const onedriveStatus = () => invoke<boolean>("onedrive_status");

/** Opens the browser for consent and resolves with the account that granted it. */
export const onedriveConnect = (clientId: string) =>
  invoke<{ email: string }>("onedrive_connect", { clientId });

export const onedriveDisconnect = () => invoke<void>("onedrive_disconnect");

/** Rejected below the minimum length rather than accepted and quietly weak. */
export const backupSetPassphrase = (passphrase: string) =>
  invoke<void>("backup_set_passphrase", { passphrase });

export const backupClearPassphrase = () => invoke<void>("backup_clear_passphrase");

/** Checks a typed password against the stored one, so a typo can't lock the user out. */
export const backupPassphraseMatches = (passphrase: string) =>
  invoke<boolean>("backup_passphrase_matches", { passphrase });

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Save-as export, sealed with the stored password. `null` when the dialog was dismissed — nothing
 * is built until a path exists. */
export const backupExportToFile = () => invoke<ExportResult | null>("backup_export_to_file");

/** "Back up now": writes to the configured destination even when nothing changed. */
export const backupRunNow = () => invoke<RunOutcome>("backup_run_now");

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Opens the picker and reports what the chosen file is, before any password is asked for. */
export const backupPickAndInspect = () =>
  invoke<BackupInfo | null>("backup_pick_and_inspect");

/** The newest backup already in the configured folder — the fresh-machine path. */
export const backupInspectConfigured = () =>
  invoke<BackupInfo | null>("backup_inspect_configured");

/**
 * Every backup at the configured destination, newest first, each read without its password.
 *
 * A list rather than "the latest one", because the reason to restore is usually something that went
 * wrong recently — which makes the newest copy the one most likely to have it in.
 */
export const backupListAtDestination = () =>
  invoke<BackupInfo[]>("backup_list_at_destination");

export const backupInspectDrive = () => invoke<BackupInfo | null>("backup_inspect_drive");

export const backupInspectOneDrive = () => invoke<BackupInfo | null>("backup_inspect_onedrive");

export const backupRestoreFile = (path: string, passphrase: string, replace: boolean) =>
  invoke<RestoreReport>("backup_restore_file", { path, passphrase, replace });

export const backupRestoreDrive = (passphrase: string, replace: boolean) =>
  invoke<RestoreReport>("backup_restore_drive", { passphrase, replace });

export const backupRestoreOneDrive = (passphrase: string, replace: boolean) =>
  invoke<RestoreReport>("backup_restore_onedrive", { passphrase, replace });

export const backupPickFolder = () => invoke<string | null>("backup_pick_folder");

/** Opens the destination in Explorer/Finder — how every cloud guide here ends. */
export const backupRevealFolder = (path: string) =>
  invoke<void>("backup_reveal_folder", { path });

// ---------------------------------------------------------------------------
// Helpers the panel shares with nothing else
// ---------------------------------------------------------------------------

/** `1.2 MB`. Sizes here span four orders of magnitude, and bytes are unreadable at the top end. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A coarse strength reading for the one password that has to survive an offline attack on a file
 * sitting in someone's cloud storage.
 *
 * Length dominates deliberately: for a passphrase fed to Argon2id it is worth far more than
 * character-class variety, and a meter that rewards `P@ss1!` over `caballo de batalla correcto`
 * teaches the wrong lesson.
 */
export function passphraseStrength(value: string): 0 | 1 | 2 | 3 {
  const length = value.length;
  if (length < 8) return 0;
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[^\w\s]/.test(value)) +
    // A space is the mark of a passphrase rather than a password, and passphrases win.
    Number(/\s/.test(value));
  if (length >= 20 || (length >= 14 && classes >= 3)) return 3;
  if (length >= 12 || classes >= 3) return 2;
  return 1;
}
