/**
 * Typed wrappers for the keyring's commands.
 *
 * Its own file rather than a section of `commands.ts` for the reason `diagramsCommands.ts` is:
 * nothing here takes a repository path. And note what is missing — there is no `getKey`, no
 * `getSecret(name)`, no way to ask for more than one entry's payload at a time. That is the shape
 * of the backend's surface, deliberately, so a bug in this layer cannot drain the vault in one
 * call. See `commands/keyvault_cmd.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  PasswordRecipe,
  TotpCode,
  VaultAuditRow,
  VaultBlobMeta,
  VaultFolderRow,
  VaultItemPlainRow,
  VaultItemRow,
  VaultSecret,
  VaultStatus,
  VaultTreeRows,
} from "../../types/vault";

// ---------- opening and closing ----------

export const keyvaultStatus = () => invoke<VaultStatus>("keyvault_status");

/** Creates the keyring and leaves it open. Refuses if one already exists. */
export const keyvaultInitialise = (password: string, remember: boolean) =>
  invoke<void>("keyvault_initialise", { password, remember });

export const keyvaultUnlock = (password: string, remember: boolean) =>
  invoke<void>("keyvault_unlock", { password, remember });

/** Opens it with the password this machine was asked to remember. `false` means there wasn't one
 *  (or it no longer works, in which case the stale entry is forgotten). */
export const keyvaultUnlockRemembered = () => invoke<boolean>("keyvault_unlock_remembered");

export const keyvaultLock = () => invoke<void>("keyvault_lock");

/** The idle heartbeat. Throttled by the caller — see `vaultStore`. */
export const keyvaultTouch = () => invoke<void>("keyvault_touch");

/** Re-wraps the data key. Nothing else is re-encrypted, so this cannot half-succeed. */
export const keyvaultChangePassword = (oldPassword: string, newPassword: string) =>
  invoke<void>("keyvault_change_password", { old: oldPassword, new: newPassword });

export const keyvaultSetAutolock = (minutes: number) =>
  invoke<void>("keyvault_set_autolock", { minutes });

export const keyvaultForgetPassword = () => invoke<void>("keyvault_forget_password");

/** **Destroys the keyring and everything in it**, and forgets the remembered password with it.
 *  The only way past a forgotten master password. */
export const keyvaultReset = () => invoke<void>("keyvault_reset");

// ---------- entries ----------

export const keyvaultLoadTree = (workspaceId: string) =>
  invoke<VaultTreeRows>("keyvault_load_tree", { workspaceId });

export const keyvaultListTrash = () => invoke<VaultItemRow[]>("keyvault_list_trash");

/** One entry, decrypted. The only call that returns a plaintext secret, and it returns exactly one. */
export const keyvaultGetItem = (id: string) =>
  invoke<VaultItemPlainRow | null>("keyvault_get_item", { id });

export const keyvaultCreateItem = (args: {
  folderId: string | null;
  kind: string;
  title: string;
  subtitle: string;
  site: string;
  tags: string;
  workspaceId: string;
  secret: VaultSecret;
}) => invoke<VaultItemRow>("keyvault_create_item", args);

export const keyvaultUpdateItem = (args: {
  id: string;
  title: string;
  subtitle: string;
  site: string;
  tags: string;
  secret: VaultSecret;
}) => invoke<VaultItemRow | null>("keyvault_update_item", args);

export const keyvaultMoveItem = (id: string, folderId: string | null) =>
  invoke<void>("keyvault_move_item", { id, folderId });

/** Files an entry under a workspace. `""` is everywhere. */
export const keyvaultSetItemWorkspace = (id: string, workspaceId: string) =>
  invoke<void>("keyvault_set_item_workspace", { id, workspaceId });

export const keyvaultSetFavorite = (id: string, favorite: boolean) =>
  invoke<void>("keyvault_set_favorite", { id, favorite });

/** Moves an entry to the trash. Recoverable — `keyvaultPurgeItem` is the one that is not. */
export const keyvaultDeleteItem = (id: string) => invoke<void>("keyvault_delete_item", { id });

export const keyvaultRestoreItem = (id: string) => invoke<void>("keyvault_restore_item", { id });

export const keyvaultPurgeItem = (id: string) => invoke<void>("keyvault_purge_item", { id });

export const keyvaultEmptyTrash = () => invoke<number>("keyvault_empty_trash");

// ---------- folders ----------

export const keyvaultCreateFolder = (
  parentId: string | null,
  name: string,
  workspaceId: string,
) => invoke<VaultFolderRow>("keyvault_create_folder", { parentId, name, workspaceId });

export const keyvaultRenameFolder = (id: string, name: string) =>
  invoke<void>("keyvault_rename_folder", { id, name });

export const keyvaultSetFolderColor = (id: string, color: string) =>
  invoke<void>("keyvault_set_folder_color", { id, color });

/** Files a folder — and its entries — under a workspace, or under none. */
export const keyvaultSetFolderWorkspace = (id: string, workspaceId: string) =>
  invoke<void>("keyvault_set_folder_workspace", { id, workspaceId });

/** `false` means the drop was refused: it would have put the folder inside its own subtree. */
export const keyvaultMoveFolder = (id: string, parentId: string | null) =>
  invoke<boolean>("keyvault_move_folder", { id, parentId });

/** Deletes a folder. Its entries survive, at the root. */
export const keyvaultDeleteFolder = (id: string) => invoke<void>("keyvault_delete_folder", { id });

// ---------- attachments ----------

export const keyvaultListBlobs = (itemId: string) =>
  invoke<VaultBlobMeta[]>("keyvault_list_blobs", { itemId });

export const keyvaultAddBlob = (itemId: string, name: string, mime: string, bytes: number[]) =>
  invoke<VaultBlobMeta>("keyvault_add_blob", { itemId, name, mime, bytes });

/** The bytes, base64, for a `data:` URI. This app has no asset protocol, so that is the only way
 *  an image reaches the screen without writing a decrypted copy to disk. */
export const keyvaultReadBlob = (id: string) => invoke<string>("keyvault_read_blob", { id });

export const keyvaultSaveBlob = (id: string, path: string) =>
  invoke<void>("keyvault_save_blob", { id, path });

export const keyvaultDeleteBlob = (id: string) => invoke<void>("keyvault_delete_blob", { id });

// ---------- tools ----------

/** From the OS random number generator, in Rust. Never `Math.random`. */
export const keyvaultGeneratePassword = (recipe: PasswordRecipe) =>
  invoke<string>("keyvault_generate_password", { recipe });

/** The current 2FA code — the *code*, never the secret, which stays in the backend. */
export const keyvaultTotpCode = (id: string) =>
  invoke<TotpCode | null>("keyvault_totp_code", { id });

export const keyvaultAudit = () => invoke<VaultAuditRow[]>("keyvault_audit");

/** Reads an export file for the import screen. Handles `.1pux` (a zip) as well as plain JSON/CSV,
 *  and caps the size — unlike `apiReadTextFile`, which has no cap. */
export const keyvaultReadImportFile = (path: string) =>
  invoke<string>("keyvault_read_import_file", { path });
