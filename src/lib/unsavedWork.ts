import { broadcast, onWindowMessage } from "./windowBus";
import { WINDOW } from "./windowIdentity";
import { setWindowUnsaved } from "./tauri/windows";

/**
 * The app's one answer to "is anything unsaved?" — asked before a quit ends the process (see
 * `quit_guard.rs` and `lib/quitGuard.ts`).
 *
 * # Registering
 *
 * A feature that holds work the disk (or the database) does not have yet registers a provider, and
 * keeps the returned function as its teardown:
 *
 * ```ts
 * useEffect(() => registerUnsavedProvider({ id: "notes", unsaved, saveAll, discard }), []);
 * ```
 *
 * The editor does today — its dirty tabs, including the ones parked in a project the window has
 * since left. Notes and diagrams are the obvious next ones: each is a buffer typed into ahead of its
 * store. The contract is small on purpose:
 *
 * - **`unsaved()`** is synchronous and cheap. It is asked while a quit is waiting on the answer.
 * - **`saveAll()`** saves what `unsaved()` listed and resolves to the labels it could *not* save.
 *   It must not ask the user anything: it runs from inside the quit question, and a second dialog
 *   there would replace the first. A file that changed on disk is a failure to report, not a
 *   question to raise. Leave it out and the provider's work can only be kept or discarded.
 * - **`discard()`** runs when the user chose to lose it. A provider with a crash journal clears the
 *   journal here, so the next launch does not offer back what was just thrown away.
 *
 * Call [`notifyUnsavedChanged`] when the *set* of unsaved things changes (a file became dirty or
 * clean — not every keystroke). In the main window that costs nothing; in a satellite it is what
 * tells the main window, which is the one that asks, that this window has work to lose.
 *
 * # Per window
 *
 * Each webview has its own registry. A satellite reports its list over the window bus as it changes
 * and saves or discards when the main window asks it to — see [`installSatelliteReporting`].
 */

export interface UnsavedItem {
  /** What the question lists: a file's name, a note's title. */
  label: string;
  /** Where it lives — a folder, a project, another window — shown dimmed beside the label. */
  detail?: string;
}

export interface UnsavedProvider {
  /** Which feature this is. Registering an id again replaces the earlier registration. */
  id: string;
  unsaved: () => UnsavedItem[];
  saveAll?: () => Promise<string[]>;
  discard?: () => Promise<void> | void;
}

const providers = new Map<string, UnsavedProvider>();

/** Whether this (satellite) window is reporting to the main one — see `installSatelliteReporting`. */
let reporting = false;

export function registerUnsavedProvider(provider: UnsavedProvider): () => void {
  providers.set(provider.id, provider);
  if (!WINDOW.main) installSatelliteReporting();
  notifyUnsavedChanged();
  return () => {
    // Only its own registration: a remount can register the replacement before the old one's
    // cleanup runs, and that cleanup must not take the new one out.
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
    notifyUnsavedChanged();
  };
}

/**
 * Everything this window has unsaved. A provider that throws is listed under its id rather than
 * skipped: "could not tell" must never read as "nothing to lose".
 */
export function collectUnsaved(): UnsavedItem[] {
  const items: UnsavedItem[] = [];
  for (const provider of providers.values()) {
    try {
      items.push(...provider.unsaved());
    } catch {
      items.push({ label: provider.id });
    }
  }
  return items;
}

/** Saves everything this window has unsaved, one provider after another; resolves to the labels
 *  that could not be saved — empty when all of it was. */
export async function saveAllUnsaved(): Promise<string[]> {
  const failed: string[] = [];
  for (const provider of providers.values()) {
    let items: UnsavedItem[];
    try {
      items = provider.unsaved();
    } catch {
      failed.push(provider.id);
      continue;
    }
    if (items.length === 0) continue;
    if (!provider.saveAll) {
      failed.push(...items.map((item) => item.label));
      continue;
    }
    try {
      failed.push(...(await provider.saveAll()));
    } catch {
      failed.push(...items.map((item) => item.label));
    }
  }
  return failed;
}

/** The user chose to lose it: every provider forgets what it was keeping. */
export async function discardAllUnsaved(): Promise<void> {
  for (const provider of providers.values()) {
    try {
      await provider.discard?.();
    } catch {
      // Discarding is the last thing before the process ends; one provider failing to tidy its
      // journal is not a reason to keep the app open.
    }
  }
}

/** What this satellite last told the backend — so the IPC goes out when the answer flips, not on
 *  every change to the list. `null` until the first report, which therefore always goes out: a page
 *  that reloaded must correct whatever the page before it left the backend believing. */
let toldBackend: boolean | null = null;

/** Says the set of unsaved things may have changed. See the module note. */
export function notifyUnsavedChanged(): void {
  if (WINDOW.main || !reporting) return;
  const items = collectUnsaved();
  broadcast({ kind: "unsaved-state", items });
  // The backend's copy of the same fact, as a yes/no: putting the app in the tray hides a window
  // that holds unsaved work instead of closing it — and closing is what used to lose these buffers
  // without a word (see `close_all` in `windows.rs`). Told directly rather than through the main
  // window, which may be the one that is not answering.
  const unsaved = items.length > 0;
  if (unsaved !== toldBackend) {
    toldBackend = unsaved;
    void setWindowUnsaved(unsaved).catch(() => {});
  }
}

/**
 * A satellite's half of the protocol, installed with its first provider: report the list when it
 * changes (and again when the main window asks, after a reload of its own), save or discard when
 * told to. Addressed messages carry `to`, because only the window that holds the work can act on it.
 */
function installSatelliteReporting(): void {
  if (reporting) return;
  reporting = true;
  onWindowMessage((message) => {
    switch (message.kind) {
      case "unsaved-refresh":
        notifyUnsavedChanged();
        break;
      case "unsaved-save":
        if (message.to !== WINDOW.label) return;
        void saveAllUnsaved().then((failed) => {
          broadcast({ kind: "unsaved-done", requestId: message.requestId, failed });
          notifyUnsavedChanged();
        });
        break;
      case "unsaved-discard":
        if (message.to !== WINDOW.label) return;
        void discardAllUnsaved().then(() => {
          broadcast({ kind: "unsaved-done", requestId: message.requestId, failed: [] });
        });
        break;
    }
  });
}
