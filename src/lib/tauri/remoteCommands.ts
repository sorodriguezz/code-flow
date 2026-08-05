import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveForward,
  ForwardSpec,
  ImportResult,
  ImportedHost,
  ParsedCommand,
  RemoteHostRow,
  RemoteHostSpec,
  RemoteSnippet,
  RemoteListing,
  RemoteWorkspaceTree,
  SshKey,
  ScreenLaunch,
} from "../../types/remote";

/**
 * IPC surface for the Remote workspace.
 *
 * Kept out of `commands.ts` for the same reason `dbCommands.ts` is: nothing here touches git or
 * takes a repo path. What it does take is a `workspaceId` on the calls that read or create a host
 * or a snippet — those belong to a workspace. Anything addressed by its own id doesn't.
 *
 * **There is no `remoteWriteSession` / `remoteCloseSession`.** A remote session *is* a terminal
 * session — `remoteOpenSession` returns an id for the same registry a local shell lives in — so it
 * is driven by `writeTerminal` / `resizeTerminal` / `closeTerminal` from `commands.ts`. Adding
 * parallel calls here would be two names for one thing, and the pty pane would need a branch to
 * pick between them.
 *
 * **`remoteGetPassword` exists, unlike its database counterpart.** The reason the database client
 * has no getter is that its password is only ever consumed by Rust at connect time, so a getter
 * would be pure exposure. Here the opposite is true: `ssh` deliberately refuses to accept a
 * password from any program, so the *only* way a saved one is useful is being shown to the person
 * typing it into the prompt. A vault the user copies from is the honest version of what every SSH
 * client that "saves passwords" without an agent is doing.
 */

// ---------- inventory ----------

export const remoteLoadTree = (workspaceId: string) =>
  invoke<RemoteWorkspaceTree>("remote_load_tree", { workspaceId });

export const remoteCreateHost = (
  workspaceId: string,
  name: string,
  groupName: string,
  spec: string,
  color: string,
) => invoke<RemoteHostRow>("remote_create_host", { workspaceId, name, groupName, spec, color });

export const remoteUpdateHost = (row: RemoteHostRow) => invoke<void>("remote_update_host", { row });

export const remoteDeleteHost = (id: string) => invoke<void>("remote_delete_host", { id });

export const remoteDuplicateHost = (id: string) =>
  invoke<RemoteHostRow>("remote_duplicate_host", { id });

export const remoteReorderHosts = (ids: string[]) => invoke<void>("remote_reorder_hosts", { ids });

export const remoteRenameGroup = (workspaceId: string, from: string, to: string) =>
  invoke<void>("remote_rename_group", { workspaceId, from, to });

// ---------- credentials ----------

/** An empty `password` clears the entry. */
export const remoteSetPassword = (id: string, password: string) =>
  invoke<void>("remote_set_password", { id, password });

export const remoteGetPassword = (id: string) =>
  invoke<string | null>("remote_get_password", { id });

// ---------- sessions ----------

/** Returns a *terminal* session id: drive it with `writeTerminal` / `resizeTerminal` /
 *  `closeTerminal`. */
export const remoteOpenSession = (id: string) => invoke<string>("remote_open_session", { id });

/** A session against an unsaved spec — the host editor's "Test connection". Takes the spec rather
 *  than an id so testing an edit tests the edit, not what is still on disk. */
export const remoteOpenDraftSession = (spec: RemoteHostSpec) =>
  invoke<string>("remote_open_draft_session", { spec });

// ---------- forwards ----------

export const remoteOpenForward = (hostId: string, forward: ForwardSpec) =>
  invoke<ActiveForward>("remote_open_forward", { hostId, forward });

export const remoteCloseForward = (id: string) => invoke<void>("remote_close_forward", { id });

export const remoteCloseHostForwards = (hostId: string) =>
  invoke<void>("remote_close_host_forwards", { hostId });

/** Polled rather than pushed: the interesting change — the far end dying — produces no event, and
 *  is noticed by the backend finding the child gone when something asks. */
export const remoteListForwards = () => invoke<ActiveForward[]>("remote_list_forwards");

// ---------- screen ----------

export const remoteOpenScreen = (id: string) => invoke<ScreenLaunch>("remote_open_screen", { id });

/** Closes the screen's tunnel. Not the viewer — that is the user's own window. */
export const remoteCloseScreen = (id: string) => invoke<void>("remote_close_screen", { id });

/** Parses an `ssh` command line. `null` when it names no destination — the normal state of a field
 *  being typed into, not an error. Lives in Rust because it is a parser and that is where the tests
 *  are; see `remotes::parse`. */
export const remoteParseSshCommand = (line: string) =>
  invoke<ParsedCommand | null>("remote_parse_ssh_command", { line });

// ---------- files (SFTP) ----------

/** Lists a directory on the far side. An empty `path` means the login directory. The transport is
 *  still the system `ssh` — see `remotes::sftp` for how. */
export const remoteListFiles = (hostId: string, path: string) =>
  invoke<RemoteListing>("remote_list_files", { hostId, path });

/** The local half of the dual pane. Takes no host: it is this machine. */
export const remoteListLocalFiles = (path: string) =>
  invoke<RemoteListing>("remote_list_local_files", { path });

export const remoteDownloadFile = (hostId: string, remotePath: string, localPath: string) =>
  invoke<void>("remote_download_file", { hostId, remotePath, localPath });

export const remoteUploadFile = (hostId: string, localPath: string, remotePath: string) =>
  invoke<void>("remote_upload_file", { hostId, localPath, remotePath });

export const remoteMakeDir = (hostId: string, path: string) =>
  invoke<void>("remote_make_dir", { hostId, path });

/** One file or one *empty* directory. Never recursive, on purpose — see `remotes::sftp::remove`. */
export const remoteRemoveFile = (hostId: string, path: string, isDir: boolean) =>
  invoke<void>("remote_remove_file", { hostId, path, isDir });

export const remoteRenameFile = (hostId: string, from: string, to: string) =>
  invoke<void>("remote_rename_file", { hostId, from, to });

export const remoteCloseFiles = (hostId: string) => invoke<void>("remote_close_files", { hostId });

// ---------- ~/.ssh/config ----------

/** The identities this machine already has. Read-only: CodeFlow owns no key store, so this is
 *  discovery of `~/.ssh` and the agent, never a vault of our own. See `remotes::keys`. */
export const remoteListKeys = () => invoke<SshKey[]>("remote_list_keys");

/** Spelled out rather than assumed: `~/.ssh/config` is not where it lives on Windows. */
export const remoteSshConfigPath = () => invoke<string>("remote_ssh_config_path");

export const remoteScanSshConfig = () => invoke<ImportedHost[]>("remote_scan_ssh_config");

export const remoteImportSshConfig = (workspaceId: string, names: string[], groupName: string) =>
  invoke<ImportResult>("remote_import_ssh_config", { workspaceId, names, groupName });

// ---------- snippets ----------

export const remoteCreateSnippet = (workspaceId: string, name: string, body: string) =>
  invoke<RemoteSnippet>("remote_create_snippet", { workspaceId, name, body });

export const remoteUpdateSnippet = (snippet: RemoteSnippet) =>
  invoke<void>("remote_update_snippet", { snippet });

export const remoteDeleteSnippet = (id: string) => invoke<void>("remote_delete_snippet", { id });
