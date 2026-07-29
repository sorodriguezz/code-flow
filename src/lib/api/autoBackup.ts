import { useApiStore } from "../../state/apiStore";
import {
  apiExportAll,
  apiGetBackupPassphrase,
  apiWriteTextFile,
  gdriveFindFile,
  gdriveUpload,
} from "../tauri/apiCommands";
import { buildBackupFile, DRIVE_BACKUP_NAME } from "./backup";

/**
 * Keeps the backup file on disk in step with the API client, so "I changed machine" doesn't depend
 * on having remembered to export.
 *
 * Deliberately debounced rather than immediate: renaming a request writes on every keystroke, and
 * a full export of every workspace per keystroke would be absurd. Ten seconds after the last change
 * is soon enough for a file whose job is to be no more than a session out of date.
 *
 * The watcher only ever reads `collections` / `folders` / `requests` / `environments`. Settings are
 * excluded on purpose — a backup writes `lastBackupAt` back into them, and reacting to that would
 * be a loop that never settles.
 */

const DEBOUNCE_MS = 10_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
/** One backup at a time: a slow disk shouldn't let two writers interleave into the same file. */
let writing = false;

/** Whether a destination is configured at all — what disables the button and skips the timer. */
export function backupDestinationReady(): boolean {
  const { settings } = useApiStore.getState();
  return settings.backupTarget === "drive"
    ? settings.driveClientId.trim() !== ""
    : settings.backupPath.trim() !== "";
}

/**
 * Writes the backup now, whatever the auto setting says — the "Back up now" button and the timer
 * share it. Returns a label for where it went, or `null` when no destination is configured.
 */
export async function runBackup(): Promise<string | null> {
  const { settings } = useApiStore.getState();
  if (!backupDestinationReady()) return null;
  if (writing) return null;

  writing = true;
  try {
    const payload = await apiExportAll();
    const passphrase = settings.backupEncrypt ? ((await apiGetBackupPassphrase()) ?? "") : "";
    // An encrypted backup with no passphrase would silently fall back to the stripped plaintext
    // form — the user would have a file that looks like a backup and can't restore a credential.
    if (settings.backupEncrypt && passphrase === "") {
      throw new Error("no passphrase is set for the encrypted backup");
    }
    const text = await buildBackupFile(payload, passphrase);
    const at = new Date().toISOString();

    if (settings.backupTarget === "drive") {
      // No id yet means either the first ever upload or a second machine that has just connected:
      // ask Drive before creating anything, or the two machines end up with a backup each.
      const fileId =
        settings.driveFileId ||
        (await gdriveFindFile(settings.driveClientId, DRIVE_BACKUP_NAME)) ||
        null;
      const id = await gdriveUpload(settings.driveClientId, fileId, DRIVE_BACKUP_NAME, text);
      await useApiStore.getState().updateSettings({ driveFileId: id, lastBackupAt: at });
      return DRIVE_BACKUP_NAME;
    }

    await apiWriteTextFile(settings.backupPath, text);
    await useApiStore.getState().updateSettings({ lastBackupAt: at });
    return settings.backupPath;
  } finally {
    writing = false;
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (!useApiStore.getState().settings.autoBackup || !backupDestinationReady()) return;
    // A failed automatic backup stays quiet: it runs unattended, and a toast every ten seconds
    // because a synced folder went offline would be worse than the missed write. The stale
    // `lastBackupAt` in settings is what shows something is wrong.
    void runBackup().catch(() => {});
  }, DEBOUNCE_MS);
}

/** Idempotent — called from `ensureApiStoreLoaded`, which several entry points race into. */
export function startAutoBackupWatcher() {
  if (started) return;
  started = true;
  useApiStore.subscribe((state, prev) => {
    if (
      state.collections === prev.collections &&
      state.folders === prev.folders &&
      state.requests === prev.requests &&
      state.environments === prev.environments
    ) {
      return;
    }
    if (!useApiStore.getState().settings.autoBackup) return;
    schedule();
  });
}
