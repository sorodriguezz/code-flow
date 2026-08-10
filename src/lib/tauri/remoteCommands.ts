import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveForward,
  ForwardSpec,
  ImportResult,
  ImportedHost,
  ParsedAzureConnection,
  ParsedCommand,
  RemoteGroupRow,
  RemoteHostRow,
  RemoteHostSpec,
  RemoteSnippet,
  RemoteListing,
  RemoteLogEntry,
  RemoteWorkspaceTree,
  SshKey,
  ScreenLaunch,
  QueueMessage,
  QueueSummary,
  TablePage,
  TableSummary,
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

// ---------- groups ----------

/** Creates an empty folder. Idempotent — the row it returns is the group that now exists, whether
 *  this call made it or found one already carrying the name. */
export const remoteCreateGroup = (workspaceId: string, name: string) =>
  invoke<RemoteGroupRow>("remote_create_group", { workspaceId, name });

/** Renames a group and everything in it. Renaming onto an existing name merges the two. */
export const remoteRenameGroup = (workspaceId: string, from: string, to: string) =>
  invoke<void>("remote_rename_group", { workspaceId, from, to });

/** Deletes the folder. Its hosts move to ungrouped — a folder and the machines in it are not the
 *  same thing, and this never removes the second. */
export const remoteDeleteGroup = (workspaceId: string, name: string) =>
  invoke<void>("remote_delete_group", { workspaceId, name });

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

// ---------------------------------------------------------------------------
// Azure Queue and Table storage
// ---------------------------------------------------------------------------
//
// Neither is a file, so neither goes through `remoteListFiles` — these are the two services whose
// content the dual-pane browser has no shape for. See `remotes::cloud::queue` and `::table`.

export const remoteQueues = (id: string) => invoke<QueueSummary[]>("remote_queues", { id });

/** Reads the front of a queue **without consuming anything**. The default, and the safe one. */
export const remoteQueuePeek = (id: string, queue: string, count: number) =>
  invoke<QueueMessage[]>("remote_queue_peek", { id, queue, count });

/** The destructive read: hides the messages for `visibility` seconds and hands back the pop
 *  receipts that `remoteQueueDeleteMessage` needs. */
export const remoteQueueReceive = (id: string, queue: string, count: number, visibility: number) =>
  invoke<QueueMessage[]>("remote_queue_receive", { id, queue, count, visibility });

export const remoteQueuePut = (id: string, queue: string, text: string) =>
  invoke<void>("remote_queue_put", { id, queue, text });

export const remoteQueueDeleteMessage = (
  id: string,
  queue: string,
  messageId: string,
  popReceipt: string,
) => invoke<void>("remote_queue_delete_message", { id, queue, messageId, popReceipt });

export const remoteQueueClear = (id: string, queue: string) =>
  invoke<void>("remote_queue_clear", { id, queue });

export const remoteQueueCreate = (id: string, queue: string) =>
  invoke<void>("remote_queue_create", { id, queue });

export const remoteQueueRemove = (id: string, queue: string) =>
  invoke<void>("remote_queue_remove", { id, queue });

export const remoteTables = (id: string) => invoke<TableSummary[]>("remote_tables", { id });

export const remoteTableQuery = (
  id: string,
  table: string,
  filter: string,
  select: string,
  fromPartition: string,
  fromRow: string,
) => invoke<TablePage>("remote_table_query", { id, table, filter, select, fromPartition, fromRow });

export const remoteTableUpsert = (id: string, table: string, entity: Record<string, unknown>) =>
  invoke<void>("remote_table_upsert", { id, table, entity });

export const remoteTableDeleteEntity = (
  id: string,
  table: string,
  partition: string,
  rowKey: string,
) => invoke<void>("remote_table_delete_entity", { id, table, partition, rowKey });

export const remoteTableCreate = (id: string, table: string) =>
  invoke<void>("remote_table_create", { id, table });

export const remoteTableRemove = (id: string, table: string) =>
  invoke<void>("remote_table_remove", { id, table });

/** Closes the screen's tunnel. Not the viewer — that is the user's own window. */
export const remoteCloseScreen = (id: string) => invoke<void>("remote_close_screen", { id });

/** Parses an `ssh` command line. `null` when it names no destination — the normal state of a field
 *  being typed into, not an error. Lives in Rust because it is a parser and that is where the tests
 *  are; see `remotes::parse`. */
export const remoteParseSshCommand = (line: string) =>
  invoke<ParsedCommand | null>("remote_parse_ssh_command", { line });

/**
 * Reads one pasted Azure Storage connection string.
 *
 * The three shapes the portal hands out — `AccountName=…;AccountKey=…`, a SAS string with
 * per-service endpoints, and a SAS URL — all come back as the same account. `null` when the text
 * names no account, which is the normal state of a field being typed into.
 *
 * The secret arrives beside the spec rather than inside it: the spec is stored as JSON in the
 * workspace database, so the key goes to the keychain with `remoteSetPassword` instead.
 */
export const remoteParseAzureConnection = (text: string) =>
  invoke<ParsedAzureConnection | null>("remote_parse_azure_connection", { text });

/** Round-trip time to the host's SSH port, or `null` when there is no direct route — a jump-hosted
 *  machine has none from here, and reporting the bastion's number instead would be a lie. */
export const remotePing = (id: string) => invoke<number | null>("remote_ping", { id });

// ---------- log ----------

/** What was opened against which host, newest first. */
export const remoteListLogs = (workspaceId: string, limit: number) =>
  invoke<RemoteLogEntry[]>("remote_list_logs", { workspaceId, limit });

export const remoteClearLogs = (workspaceId: string) =>
  invoke<void>("remote_clear_logs", { workspaceId });

// ---------- files (SFTP) ----------

/** Lists a directory on the far side. An empty `path` means the login directory. The transport is
 *  still the system `ssh` — see `remotes::sftp` for how. */
export const remoteListFiles = (hostId: string, path: string) =>
  invoke<RemoteListing>("remote_list_files", { hostId, path });

/** The local half of the dual pane. Takes no host: it is this machine. */
export const remoteListLocalFiles = (path: string) =>
  invoke<RemoteListing>("remote_list_local_files", { path });

/** Downloads a file, or a whole directory. `id` comes back on `remote:transfer` events, so a
 *  progress bar can tell its own from a previous transfer's arriving late. */
export const remoteDownloadFile = (
  id: string,
  hostId: string,
  remotePath: string,
  localPath: string,
) => invoke<void>("remote_download_file", { id, hostId, remotePath, localPath });

/** Uploads a file, or a whole directory. */
export const remoteUploadFile = (
  id: string,
  hostId: string,
  localPath: string,
  remotePath: string,
) => invoke<void>("remote_upload_file", { id, hostId, localPath, remotePath });

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
