/**
 * The keyring's state.
 *
 * **This is the one store that must NOT follow the active workspace, and that is deliberate.**
 * Every other workspace-scoped store in this app carries a `useWorkspaceStore.subscribe(...)` at the
 * bottom of its file — see the note at the end of this one for why the keyring is different and why
 * adding one here would be a bug rather than a fix.
 *
 * Three things worth knowing before reading it:
 *
 * 1. **`items` holds no secrets.** It is metadata — title, account line, tags, counts — which is
 *    stored in the clear precisely so a *locked* keyring can still say what is in it. The secret of
 *    the open entry lives in `plain`, arrives one at a time, and is dropped on lock.
 *
 * 2. **Locking is a backend fact, not a UI state.** The store never decides the keyring is locked;
 *    it listens for `keyvault:locked` and clears what it is holding. The same clearing runs on the
 *    explicit lock action, through one shared helper, so a field cleared in one path cannot be
 *    forgotten in the other.
 *
 * 3. **The idle heartbeat is throttled here.** Real activity — a pointer down, a key press — pokes
 *    the backend at most once every 30 seconds. Without the throttle every keystroke would be an
 *    IPC round trip; without the heartbeat the vault would lock while being actively used.
 */

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  keyvaultAddBlob,
  keyvaultAudit,
  keyvaultChangePassword,
  keyvaultCreateFolder,
  keyvaultCreateItem,
  keyvaultDeleteBlob,
  keyvaultDeleteFolder,
  keyvaultDeleteItem,
  keyvaultEmptyTrash,
  keyvaultForgetPassword,
  keyvaultGeneratePassword,
  keyvaultGetItem,
  keyvaultInitialise,
  keyvaultListBlobs,
  keyvaultListTrash,
  keyvaultLoadTree,
  keyvaultLock,
  keyvaultMoveFolder,
  keyvaultMoveItem,
  keyvaultPurgeItem,
  keyvaultReadBlob,
  keyvaultRenameFolder,
  keyvaultReset,
  keyvaultRestoreItem,
  keyvaultSetAutolock,
  keyvaultSetFavorite,
  keyvaultSetFolderColor,
  keyvaultSetFolderWorkspace,
  keyvaultSetItemWorkspace,
  keyvaultStatus,
  keyvaultTotpCode,
  keyvaultTouch,
  keyvaultUnlock,
  keyvaultUnlockRemembered,
  keyvaultUpdateItem,
} from "../lib/tauri/keyvaultCommands";
import { parseTags, serializeTags } from "../lib/notes/tags";
import type { ImportResult } from "../lib/vault/import";
import { pushErrorToast, useToastStore } from "./toastStore";
import { translate } from "./languageStore";
import { confirmAction } from "./confirmStore";
import { vaultErrorKey } from "../lib/vault/errors";
import { useWorkspaceStore } from "./workspaceStore";
import {
  DEFAULT_RECIPE,
  deriveSubtitle,
  type PasswordRecipe,
  type TotpCode,
  type VaultAuditRow,
  type VaultBlobMeta,
  type VaultFolderRow,
  type VaultItem,
  type VaultItemKind,
  type VaultItemRow,
  type VaultSecret,
  type VaultSort,
} from "../types/vault";

/** How often real activity is allowed to poke the backend's idle clock. */
const TOUCH_THROTTLE_MS = 30_000;

/** How long a copied secret stays on the clipboard before it is overwritten.
 *
 *  **Named in the tour copy** (`tour.vault.reveal.body`) as a literal "30 seconds", because a tour
 *  body only substitutes `{key}` for a keyboard chord and has no way to take a parameter. Changing
 *  this number means changing that sentence in both languages. */
export const CLIPBOARD_CLEAR_SECONDS = 30;

/**
 * A backend error, in the user's language when it is one of the keyring's own.
 *
 * At the store boundary rather than in each component, so a failure reads the same wherever it is
 * shown — the lock screen, a toast, the settings panel.
 */
function vaultMessage(error: unknown): string {
  const key = vaultErrorKey(error);
  return key ? translate(key) : String(error);
}

function toItem(row: VaultItemRow): VaultItem {
  return { ...row, tags: parseTags(row.tags) };
}

interface VaultState {
  // ---- the vault itself
  /**
   * Whether a keyring exists on this machine — **`null` until the backend has said**.
   *
   * Three states rather than two, and the third is the whole point: `false` draws the *create a
   * keyring* form, and drawing that before the answer arrives showed a setup screen to people who
   * already had a vault. It is not a fast question either — `keyvault_status` reads the OS
   * credential store, which on macOS can put an authorization prompt in front of the answer and
   * block until it is answered. The form sat there the whole time.
   */
  initialised: boolean | null;
  unlocked: boolean;
  /**
   * The keyring is letting itself in — **and no door may be drawn while it is true**.
   *
   * The companion to `initialised`'s three states, and it exists because answering *is there a
   * vault?* is not the same as knowing *which screen the user should end up on*. Learning that a
   * locked vault exists used to be published on its own, so the unlock form appeared — fully typed
   * into, if you were quick — for the half second it then took the remembered password to open it.
   * The keyring flashed locked and unlocked itself in front of the user, which is alarming in a
   * password manager in a way it would not be anywhere else.
   *
   * So it is set in the *same* update as `initialised`, covers both ways a session resumes (the
   * remembered password, and a backend that was already open), and is only dropped once the tree is
   * loaded — the screen that follows it is the real one, with its contents already in it.
   */
  resuming: boolean;
  remembered: boolean;
  autolockMinutes: number;
  /** The unlock attempt is in flight — Argon2 takes ~100 ms and the button has to say so. */
  unlocking: boolean;
  loading: boolean;
  /** Set when an unlock failed, cleared on the next attempt. */
  unlockError: string | null;
  /**
   * Set when the status read itself failed — the one error that cannot be shown on a door, because
   * it is the reason we do not know which door to open. It used to be a toast over a spinner that
   * then span for ever; it is now the panel's own message, with the way to try again.
   */
  statusError: string | null;

  // ---- contents
  folders: VaultFolderRow[];
  items: VaultItem[];
  trash: VaultItem[];
  expanded: string[];

  // ---- what is open
  activeId: string | null;
  /** The open entry's decrypted payload. The only secret this store ever holds. */
  secret: VaultSecret | null;
  /** Which fields the user has chosen to reveal, per field name. Cleared with everything else. */
  revealed: Record<string, boolean>;
  /**
   * Whether the open entry is being edited.
   *
   * The panel has two modes and this is which one it is in. An always-editable panel was the reason
   * "did that save?" was a question at all: nothing announced a write, because a write could happen
   * at any keystroke. With an explicit mode, reading changes nothing and saving is a button.
   */
  editing: boolean;
  /** A save is in flight. The button says so. */
  saving: boolean;
  /**
   * The open form has changes that are not written yet.
   *
   * In the store rather than in the panel because it is not the panel's question: anything that
   * navigates away from the entry has to know, and the panel is the thing being navigated away
   * from. `openItem` is what reads it.
   */
  dirty: boolean;
  /** When the last save landed, so the panel can confirm it and then stop mentioning it. */
  savedAt: number | null;
  blobs: VaultBlobMeta[];
  totp: TotpCode | null;

  // ---- browsing
  query: string;
  folderFilter: string | null;
  tagFilter: string | null;
  sort: VaultSort;
  trashOpen: boolean;
  audit: VaultAuditRow[];

  // ---- actions
  refreshStatus: () => Promise<void>;
  initialise: (password: string, remember: boolean) => Promise<boolean>;
  unlock: (password: string, remember: boolean) => Promise<boolean>;
  /** Opens the vault with the password this machine remembers.
   *
   *  **Called once per app session, from `refreshStatus`, and nowhere else.** Locking is meant to
   *  lock: a caller that ran this when the lock screen appeared would undo every lock the moment it
   *  happened, manual or idle. It runs under `resuming`, which is what keeps the lock screen from
   *  being drawn for the moment this takes. */
  tryRemembered: () => Promise<boolean>;
  lock: () => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
  setAutolock: (minutes: number) => Promise<void>;
  forgetPassword: () => Promise<void>;
  /** Destroys the keyring and everything in it. The way out of a forgotten master password, and the
   *  only one there is. */
  reset: () => Promise<boolean>;
  touch: () => void;

  refresh: () => Promise<void>;
  openItem: (id: string) => Promise<void>;
  closeItem: () => void;
  reveal: (field: string, on: boolean) => void;
  setEditing: (editing: boolean) => void;
  setDirty: (dirty: boolean) => void;
  createItem: (kind: VaultItemKind, title: string, folderId: string | null) => Promise<string | null>;
  /** No `subtitle`: it is derived from the payload — see `deriveSubtitle`. */
  saveItem: (args: {
    id: string;
    title: string;
    site: string;
    tags: string[];
    secret: VaultSecret;
  }) => Promise<void>;
  moveItem: (id: string, folderId: string | null) => Promise<void>;
  setItemWorkspace: (id: string, workspaceId: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  restoreItem: (id: string) => Promise<void>;
  purgeItem: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  loadTrash: () => Promise<void>;

  createFolder: (parentId: string | null, name: string) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  setFolderColor: (id: string, color: string) => Promise<void>;
  setFolderWorkspace: (id: string, workspaceId: string) => Promise<void>;
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  toggleFolder: (id: string) => void;

  loadBlobs: (itemId: string) => Promise<void>;
  addBlob: (itemId: string, file: File) => Promise<void>;
  readBlob: (id: string) => Promise<string | null>;
  deleteBlob: (id: string) => Promise<void>;

  /** Writes an already-parsed export into the keyring. Returns how many entries were created. */
  runImport: (result: ImportResult) => Promise<number>;
  refreshTotp: () => Promise<void>;
  generatePassword: (recipe?: PasswordRecipe) => Promise<string | null>;
  copySecret: (value: string) => Promise<void>;
  loadAudit: () => Promise<void>;

  setQuery: (query: string) => void;
  setFolderFilter: (id: string | null) => void;
  setTagFilter: (tag: string | null) => void;
  setSort: (sort: VaultSort) => void;
  setTrashOpen: (open: boolean) => void;
}

/**
 * Everything that must not survive a lock, in one place.
 *
 * Used by both the explicit lock action and the `keyvault:locked` listener. Two copies of this list
 * would be two chances for a revealed password to stay on screen after the vault closed.
 */
function clearedOnLock() {
  return {
    unlocked: false,
    // A lock ends any resume. Without this a vault that locked mid-boot would leave the gate down
    // and the app on a spinner with nothing left to wait for.
    resuming: false,
    folders: [] as VaultFolderRow[],
    items: [] as VaultItem[],
    trash: [] as VaultItem[],
    activeId: null,
    secret: null,
    revealed: {},
    editing: false,
    saving: false,
    dirty: false,
    savedAt: null,
    blobs: [] as VaultBlobMeta[],
    totp: null,
    audit: [] as VaultAuditRow[],
    query: "",
    trashOpen: false,
  };
}

let lastTouch = 0;

export const useVaultStore = create<VaultState>((set, get) => ({
  initialised: null,
  unlocked: false,
  resuming: false,
  remembered: false,
  autolockMinutes: 15,
  unlocking: false,
  loading: false,
  unlockError: null,
  statusError: null,

  folders: [],
  items: [],
  trash: [],
  expanded: [],

  activeId: null,
  secret: null,
  revealed: {},
  editing: false,
  saving: false,
  dirty: false,
  savedAt: null,
  blobs: [],
  totp: null,

  query: "",
  folderFilter: null,
  tagFilter: null,
  sort: "recent",
  trashOpen: false,
  audit: [],

  // ---------- the vault itself ----------

  refreshStatus: async () => {
    set({ statusError: null });
    try {
      const status = await keyvaultStatus();
      // Both branches below end with the keyring open, so neither may let a screen be drawn while
      // it is still working: `resuming` goes out in the *same* update as `initialised`, and the two
      // are read together. Publishing "there is a vault and it is locked" on its own is what put an
      // unlock form on screen a moment before the remembered password opened it.
      const resuming = status.unlocked || (status.initialised && status.remembered);
      set({
        initialised: status.initialised,
        unlocked: status.unlocked,
        autolockMinutes: status.autolock_minutes,
        remembered: status.remembered,
        resuming,
      });
      if (!resuming) return;
      try {
        if (status.unlocked) {
          await get().refresh();
        } else {
          // The one place the remembered password is used. Here rather than on the lock screen's
          // mount, because that screen appears every time the vault *locks* — see the comment there.
          await get().tryRemembered();
        }
      } finally {
        // Dropped only now, with the tree already loaded: the explorer arrives with its entries in
        // it rather than empty and then filling.
        set({ resuming: false });
      }
    } catch (error) {
      // Shown in the panel rather than as a toast over a spinner that never stops. `initialised`
      // stays `null` on purpose — a failed read is not evidence that there is no keyring, and
      // guessing `false` here is what drew a *create a keyring* form to people who had one.
      set({ statusError: String(error), resuming: false });
    }
  },

  initialise: async (password, remember) => {
    set({ unlocking: true, unlockError: null });
    try {
      await keyvaultInitialise(password, remember);
      set({ initialised: true, unlocked: true, remembered: remember });
      await get().refresh();
      return true;
    } catch (error) {
      set({ unlockError: vaultMessage(error) });
      return false;
    } finally {
      set({ unlocking: false });
    }
  },

  unlock: async (password, remember) => {
    set({ unlocking: true, unlockError: null });
    try {
      await keyvaultUnlock(password, remember);
      set({ unlocked: true, remembered: remember });
      await get().refresh();
      return true;
    } catch (error) {
      // Shown on the lock screen rather than as a toast: a wrong password is an answer to what the
      // user just typed, and it belongs next to the box they typed it in.
      set({ unlockError: vaultMessage(error) });
      return false;
    } finally {
      set({ unlocking: false });
    }
  },

  tryRemembered: async () => {
    try {
      const opened = await keyvaultUnlockRemembered();
      if (opened) {
        set({ unlocked: true });
        await get().refresh();
      } else {
        // `false` also covers "the stored password no longer opens this vault" — changed on another
        // machine — in which case the backend has just forgotten the stale entry. Saying so keeps
        // the "remember on this machine" box from claiming something that is no longer true.
        set({ remembered: false });
      }
      return opened;
    } catch {
      // Never a toast: this runs once at startup, and a machine that simply has nothing remembered
      // is the ordinary case rather than a failure worth interrupting anyone about.
      return false;
    }
  },

  lock: async () => {
    set(clearedOnLock());
    try {
      await keyvaultLock();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  changePassword: async (oldPassword, newPassword) => {
    try {
      await keyvaultChangePassword(oldPassword, newPassword);
      return true;
    } catch (error) {
      pushErrorToast(vaultMessage(error));
      return false;
    }
  },

  setAutolock: async (minutes) => {
    const previous = get().autolockMinutes;
    set({ autolockMinutes: minutes });
    try {
      await keyvaultSetAutolock(minutes);
    } catch (error) {
      set({ autolockMinutes: previous });
      pushErrorToast(String(error));
    }
  },

  forgetPassword: async () => {
    try {
      await keyvaultForgetPassword();
      set({ remembered: false });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  touch: () => {
    if (!get().unlocked) return;
    const now = Date.now();
    if (now - lastTouch < TOUCH_THROTTLE_MS) return;
    lastTouch = now;
    void keyvaultTouch().catch(() => {});
  },

  // ---------- contents ----------

  refresh: async () => {
    // The workspace narrows the *list*, never the vault: entries filed under this workspace plus
    // the global ones. Read at call time rather than held, because this store does not follow the
    // workspace — see the note at the bottom of the file.
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? "";
    set({ loading: true });
    try {
      const tree = await keyvaultLoadTree(workspaceId);
      set({ folders: tree.folders, items: tree.items.map(toItem) });
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      set({ loading: false });
    }
  },

  openItem: async (id) => {
    if (id === get().activeId) return;
    // Unsaved work is only ever lost on purpose. Every route to another entry comes through here,
    // which is why the check lives here rather than on the row that was clicked.
    if (get().editing && get().dirty) {
      const discard = await confirmAction(
        translate("vault.discardChanges"),
        true,
        translate("vault.discard"),
      );
      if (!discard) return;
    }
    // Cleared first: if the fetch fails, the panel must not still be showing the previous entry's
    // password under the new entry's title.
    set({
      activeId: id,
      secret: null,
      revealed: {},
      editing: false,
      dirty: false,
      savedAt: null,
      blobs: [],
      totp: null,
    });
    try {
      const opened = await keyvaultGetItem(id);
      if (!opened || get().activeId !== id) return;
      set({ secret: opened.secret });
      await get().loadBlobs(id);
      await get().refreshTotp();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  closeItem: () =>
    set({
      activeId: null,
      secret: null,
      revealed: {},
      editing: false,
      dirty: false,
      savedAt: null,
      blobs: [],
      totp: null,
    }),

  reveal: (field, on) => set((s) => ({ revealed: { ...s.revealed, [field]: on } })),

  setDirty: (dirty) => set({ dirty }),

  setEditing: (editing) =>
    // Leaving edit mode also drops every reveal: the fields were uncovered to be *changed*, and
    // leaving them uncovered afterwards is a password sitting on screen for no reason.
    set(editing ? { editing } : { editing, dirty: false, revealed: {}, savedAt: null }),

  createItem: async (kind, title, folderId) => {
    const workspaceId = "";
    try {
      const created = await keyvaultCreateItem({
        folderId,
        kind,
        title,
        subtitle: "",
        site: "",
        tags: "[]",
        // New entries are global. Filing one under a workspace is a deliberate act from the row's
        // menu, never a default — the opposite would quietly hide a password from the workspace the
        // user next switches to.
        workspaceId,
        secret: {},
      });
      set((s) => ({ items: [toItem(created), ...s.items] }));
      return created.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  saveItem: async ({ id, title, site, tags, secret }) => {
    set({ saving: true });
    try {
      const kind = get().items.find((item) => item.id === id)?.kind ?? "login";
      const saved = await keyvaultUpdateItem({
        id,
        title,
        // Derived here rather than in the panel so every future caller gets it too. It is the one
        // piece of an entry that is stored in the clear and not typed by anyone.
        subtitle: deriveSubtitle(kind, secret),
        site,
        tags: serializeTags(tags),
        secret,
      });
      if (saved) {
        set((s) => ({
          items: s.items.map((item) => (item.id === id ? toItem(saved) : item)),
          secret,
        }));
      }
      await get().refreshTotp();
      set({ savedAt: Date.now(), editing: false, dirty: false, revealed: {} });
    } catch (error) {
      // Left in edit mode on purpose: what was typed is still in the form, which is the only place
      // it exists now. Dropping to the read view would show the *stored* entry and quietly lose it.
      pushErrorToast(vaultMessage(error));
    } finally {
      set({ saving: false });
    }
  },

  moveItem: async (id, folderId) => {
    const previous = get().items;
    set({ items: previous.map((item) => (item.id === id ? { ...item, folder_id: folderId } : item)) });
    try {
      await keyvaultMoveItem(id, folderId);
    } catch (error) {
      set({ items: previous });
      pushErrorToast(String(error));
    }
  },

  setItemWorkspace: async (id, workspaceId) => {
    try {
      await keyvaultSetItemWorkspace(id, workspaceId);
      // The entry may have just left the visible set, so only a reload is truthful.
      await get().refresh();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  toggleFavorite: async (id) => {
    const previous = get().items;
    const next = !previous.find((item) => item.id === id)?.favorite;
    set({ items: previous.map((item) => (item.id === id ? { ...item, favorite: next } : item)) });
    try {
      await keyvaultSetFavorite(id, next);
    } catch (error) {
      set({ items: previous });
      pushErrorToast(String(error));
    }
  },

  deleteItem: async (id) => {
    const previous = get().items;
    set({
      items: previous.filter((item) => item.id !== id),
      ...(get().activeId === id ? { activeId: null, secret: null, revealed: {}, totp: null } : {}),
    });
    try {
      await keyvaultDeleteItem(id);
      // Said out loud, because "delete" here is recoverable and a user who does not know that will
      // not go looking in the trash.
      useToastStore.getState().pushToast(translate("vault.movedToTrash"), "info");
    } catch (error) {
      set({ items: previous });
      pushErrorToast(String(error));
    }
  },

  restoreItem: async (id) => {
    try {
      await keyvaultRestoreItem(id);
      await Promise.all([get().refresh(), get().loadTrash()]);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  purgeItem: async (id) => {
    try {
      await keyvaultPurgeItem(id);
      await get().loadTrash();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  emptyTrash: async () => {
    try {
      await keyvaultEmptyTrash();
      set({ trash: [] });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  loadTrash: async () => {
    try {
      const rows = await keyvaultListTrash();
      set({ trash: rows.map(toItem) });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  // ---------- folders ----------

  createFolder: async (parentId, name) => {
    try {
      const created = await keyvaultCreateFolder(parentId, name, "");
      set((s) => ({
        folders: [...s.folders, created],
        expanded: parentId && !s.expanded.includes(parentId) ? [...s.expanded, parentId] : s.expanded,
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  renameFolder: async (id, name) => {
    const previous = get().folders;
    set({ folders: previous.map((f) => (f.id === id ? { ...f, name } : f)) });
    try {
      await keyvaultRenameFolder(id, name);
    } catch (error) {
      set({ folders: previous });
      pushErrorToast(String(error));
    }
  },

  setFolderColor: async (id, color) => {
    const previous = get().folders;
    set({ folders: previous.map((f) => (f.id === id ? { ...f, color } : f)) });
    try {
      await keyvaultSetFolderColor(id, color);
    } catch (error) {
      set({ folders: previous });
      pushErrorToast(String(error));
    }
  },

  setFolderWorkspace: async (id, workspaceId) => {
    try {
      await keyvaultSetFolderWorkspace(id, workspaceId);
      await get().refresh();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  moveFolder: async (id, parentId) => {
    try {
      const moved = await keyvaultMoveFolder(id, parentId);
      // `false` is the backend refusing to put a folder inside its own subtree. Silent: a rejected
      // drop simply doesn't land, which is what one looks like everywhere else in the app.
      if (!moved) return;
      set((s) => ({
        folders: s.folders.map((f) => (f.id === id ? { ...f, parent_id: parentId } : f)),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  deleteFolder: async (id) => {
    try {
      await keyvaultDeleteFolder(id);
      // The entries survive at the root, so the list changes too.
      await get().refresh();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  toggleFolder: (id) =>
    set((s) => ({
      expanded: s.expanded.includes(id)
        ? s.expanded.filter((entry) => entry !== id)
        : [...s.expanded, id],
    })),

  // ---------- attachments ----------

  loadBlobs: async (itemId) => {
    try {
      const blobs = await keyvaultListBlobs(itemId);
      if (get().activeId === itemId) set({ blobs });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  addBlob: async (itemId, file) => {
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const stored = await keyvaultAddBlob(
        itemId,
        file.name,
        file.type || "application/octet-stream",
        bytes,
      );
      set((s) => ({
        blobs: [...s.blobs, stored],
        items: s.items.map((item) =>
          item.id === itemId ? { ...item, attachments: item.attachments + 1 } : item,
        ),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  readBlob: async (id) => {
    try {
      return await keyvaultReadBlob(id);
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  deleteBlob: async (id) => {
    const itemId = get().activeId;
    try {
      await keyvaultDeleteBlob(id);
      set((s) => ({
        blobs: s.blobs.filter((blob) => blob.id !== id),
        items: s.items.map((item) =>
          item.id === itemId ? { ...item, attachments: Math.max(0, item.attachments - 1) } : item,
        ),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  // ---------- tools ----------

  reset: async () => {
    try {
      await keyvaultReset();
      // Back to the state a machine that never had one is in, so the next screen is the setup form
      // rather than a lock screen for a vault that is gone.
      set({ ...clearedOnLock(), initialised: false, remembered: false, unlockError: null });
      return true;
    } catch (error) {
      pushErrorToast(String(error));
      return false;
    }
  },

  runImport: async (result) => {
    // Folders first, by name, so an entry can be filed as it is created. An import that made the
    // folders afterwards would have to move every entry a second time.
    const created = new Map<string, string>();
    for (const name of result.folders) {
      const existing = get().folders.find((folder) => folder.name === name);
      if (existing) {
        created.set(name, existing.id);
        continue;
      }
      try {
        const folder = await keyvaultCreateFolder(null, name, "");
        created.set(name, folder.id);
      } catch (error) {
        // A folder that could not be made is not a reason to lose the entries in it — they land at
        // the root instead, and the toast at the end still counts them.
        pushErrorToast(String(error));
      }
    }

    let imported = 0;
    for (const item of result.items) {
      try {
        const made = await keyvaultCreateItem({
          folderId: item.folder ? (created.get(item.folder) ?? null) : null,
          kind: item.kind,
          title: item.title,
          subtitle: item.subtitle,
          site: item.site,
          tags: serializeTags(item.tags),
          // Imported entries are global, like every new one. Filing them under a workspace is a
          // decision per entry, and guessing it for four hundred of them would be worse than not
          // guessing at all.
          workspaceId: "",
          secret: item.secret,
        });
        imported += 1;
        // Set afterwards rather than through `createItem`, which takes no favourite argument. Its
        // own try/catch: an entry that arrived but did not get its star is a far better outcome
        // than one that was counted as failed and shows up nowhere.
        if (item.favorite) {
          try {
            await keyvaultSetFavorite(made.id, true);
          } catch {
            /* the entry is in; the star is cosmetic */
          }
        }
      } catch (error) {
        pushErrorToast(String(error));
      }
    }

    await get().refresh();
    return imported;
  },

  refreshTotp: async () => {
    const id = get().activeId;
    if (!id) return;
    try {
      const code = await keyvaultTotpCode(id);
      if (get().activeId === id) set({ totp: code });
    } catch {
      // A malformed secret is reported by the editor when it is saved; the countdown going quiet is
      // the right amount of noise here.
      set({ totp: null });
    }
  },

  generatePassword: async (recipe) => {
    try {
      return await keyvaultGeneratePassword(recipe ?? DEFAULT_RECIPE);
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  /**
   * Copies a secret and takes it back off the clipboard.
   *
   * The clipboard is readable by every app on the machine and survives the vault locking, so a
   * password copied and forgotten is a password sitting in plain text for the rest of the day. The
   * toast says the clear is coming, because a clipboard that empties itself without warning is its
   * own kind of surprise.
   */
  copySecret: async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      useToastStore
        .getState()
        .pushToast(translate("vault.copiedClears", { seconds: CLIPBOARD_CLEAR_SECONDS }), "info");
      window.setTimeout(() => {
        // Only if it is still ours: overwriting something the user copied since would be worse than
        // leaving the password there.
        void navigator.clipboard
          .readText()
          .then((current) => (current === value ? navigator.clipboard.writeText("") : undefined))
          .catch(() => {});
      }, CLIPBOARD_CLEAR_SECONDS * 1000);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  loadAudit: async () => {
    try {
      set({ audit: await keyvaultAudit() });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  // ---------- browsing ----------

  setQuery: (query) => set({ query }),
  setFolderFilter: (folderFilter) => set({ folderFilter }),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  setSort: (sort) => set({ sort }),
  setTrashOpen: (trashOpen) => {
    set({ trashOpen });
    if (trashOpen) void useVaultStore.getState().loadTrash();
  },
}));

/**
 * The entries the list should show, given the search box and the filters.
 *
 * Synchronous and outside the store for the same reason `filterNotes` is: the whole metadata list
 * is already in memory, so there is nothing to wait for, and keeping it out of the store means a
 * keystroke re-renders the list without writing to state.
 *
 * Searching matches the title, the account line and the site — never a secret, which is not in
 * memory to match against and would be the wrong thing to match against anyway.
 */
export function filterVaultItems(
  items: VaultItem[],
  query: string,
  folderFilter: string | null,
  tagFilter: string | null,
  sort: VaultSort,
): VaultItem[] {
  const needle = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (folderFilter && item.folder_id !== folderFilter) return false;
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
    if (!needle) return true;
    return (
      item.title.toLowerCase().includes(needle) ||
      item.subtitle.toLowerCase().includes(needle) ||
      item.site.toLowerCase().includes(needle) ||
      item.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  });

  const ordered = [...filtered];
  ordered.sort((a, b) => {
    // Favourites first whatever the sort: a pinned entry is the one you keep coming back to, and
    // burying it under an alphabetical order defeats the pin.
    if (a.favorite !== b.favorite) return Number(b.favorite) - Number(a.favorite);
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "created") return b.created_at.localeCompare(a.created_at);
    return b.updated_at.localeCompare(a.updated_at);
  });
  return ordered;
}

/**
 * Hydrates the store the first time anything needs it — and, if this machine remembers the master
 * password, opens the vault. Once per session: the guard below is what makes "remembered" a
 * convenience at startup rather than something that defeats the lock button.
 *
 * **Called by every entry point into the keyring, not just the keyring app.** `VaultView` was the
 * only caller once, which meant `initialised` stayed `null` — and anything rendering off it stayed
 * on "Checking…" — for anyone who reached the vault another way. `VaultPicker` is the other door.
 *
 * Not called at app startup on purpose: the status read asks the OS credential store a question,
 * and on macOS the first one pops a permission dialog. That belongs to the moment the user asks for
 * the keyring, not to every launch.
 */
let loaded = false;
export function ensureVaultStoreLoaded(): void {
  if (loaded) return;
  loaded = true;
  void useVaultStore
    .getState()
    .refreshStatus()
    .then(() => {
      // A read that *failed* has told us nothing, so it must not count as the one attempt this
      // session gets — the next door to open tries again. This cannot defeat a lock: reaching the
      // remembered password requires the status read to have succeeded, and then `statusError` is
      // null and this flag stays set for good.
      if (useVaultStore.getState().statusError) loaded = false;
    });
}

// The backend locked the vault — because the idle window passed, or because another window asked
// it to. Told rather than polled, so every view drops what it is showing at the same moment.
void listen("keyvault:locked", () => {
  useVaultStore.setState(clearedOnLock());
});

// ---------------------------------------------------------------------------
// There is deliberately NO `useWorkspaceStore.subscribe(...)` here.
//
// Every other workspace-scoped store in this app carries one at exactly this spot, and leaving it
// out is a decision rather than an omission: the keyring is **not** scoped to a workspace. Its
// tables carry no foreign key to `workspaces` (see the `vault_*` block in `migrations.rs`), for the
// same reason `ai_usage` and `remote_devices` don't — and a subscription here would lock or clear a
// vault on a switch that changed nothing about it.
//
// What *is* per workspace is which entries the list shows, and `refresh` reads the active workspace
// at call time to narrow it. That is the whole of the relationship. If a future reader comes here
// to "fix" the missing subscription, this comment is the answer.
// ---------------------------------------------------------------------------
