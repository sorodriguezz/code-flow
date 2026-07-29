import { invoke } from "@tauri-apps/api/core";
import type {
  ApiCollection,
  ApiCookie,
  ApiEnvironment,
  ApiFolder,
  ApiHistoryEntry,
  ApiRequestRow,
  ApiTree,
  GrpcCallRequest,
  GrpcDescribeRequest,
  GrpcResponse,
  GrpcServiceInfo,
  HttpResponse,
  HttpSendRequest,
  MqttConnectRequest,
  SocketIoConnectRequest,
  WsConnectRequest,
} from "../../types/api";
import type { ApiBackupPayload } from "../api/backup";

/**
 * IPC surface for the built-in API client.
 *
 * Kept out of `commands.ts` because it's a self-contained feature: nothing here touches git or
 * takes a repo path. What it does take is a `workspaceId`, on the calls that read or create a
 * collection, an environment, a history entry or a cookie — those belong to a workspace.
 * Anything addressed by its own id doesn't: the row already knows which workspace it is in.
 *
 * The split of responsibility is deliberate: **the backend is a transport, not a model.** It
 * never reads a collection, resolves a variable, or applies auth that could be expressed as a
 * header — the frontend interpolates `{{vars}}`, runs the pre-request script and builds the
 * final headers, then hands the backend a fully-resolved request. The exceptions are the two
 * things a webview genuinely can't do: schemes that need the server's challenge or a canonical
 * signing form (Digest, AWS SigV4), and raw sockets (WS/MQTT/gRPC).
 */

// ---------- tree: collections ----------

/**
 * One workspace's collections, folders and requests in one round trip; the UI nests them
 * client-side. Folders and requests come back scoped through their collection.
 */
export const apiLoadTree = (workspaceId: string) => invoke<ApiTree>("api_load_tree", { workspaceId });

export const apiCreateCollection = (workspaceId: string, name: string) =>
  invoke<ApiCollection>("api_create_collection", { workspaceId, name });

export const apiUpdateCollection = (collection: ApiCollection) =>
  invoke<void>("api_update_collection", { collection });

export const apiDeleteCollection = (id: string) => invoke<void>("api_delete_collection", { id });

/** Deep-copies a collection (folders + requests) under a new id. */
export const apiDuplicateCollection = (id: string) =>
  invoke<ApiCollection>("api_duplicate_collection", { id });

// ---------- tree: folders ----------

export const apiCreateFolder = (collectionId: string, parentId: string | null, name: string) =>
  invoke<ApiFolder>("api_create_folder", { collectionId, parentId, name });

export const apiUpdateFolder = (folder: ApiFolder) => invoke<void>("api_update_folder", { folder });

export const apiDeleteFolder = (id: string) => invoke<void>("api_delete_folder", { id });

// ---------- tree: requests ----------

export const apiCreateRequest = (
  collectionId: string,
  folderId: string | null,
  name: string,
  protocol: string,
  spec: string,
) => invoke<ApiRequestRow>("api_create_request", { collectionId, folderId, name, protocol, spec });

export const apiUpdateRequest = (request: ApiRequestRow) =>
  invoke<void>("api_update_request", { request });

export const apiDeleteRequest = (id: string) => invoke<void>("api_delete_request", { id });

export const apiDuplicateRequest = (id: string) =>
  invoke<ApiRequestRow>("api_duplicate_request", { id });

/**
 * Reparents/reorders one node after a drag. `kind` is `"folder"` or `"request"`; `parentId` is
 * the destination folder (`null` = collection root). The backend renumbers `sort_order` for the
 * destination's children so the list stays dense — the UI only supplies the target index.
 */
export const apiMoveNode = (
  kind: "folder" | "request",
  id: string,
  collectionId: string,
  parentId: string | null,
  index: number,
) => invoke<void>("api_move_node", { kind, id, collectionId, parentId, index });

/** Reorders whole collections in the sidebar. */
export const apiReorderCollections = (workspaceId: string, ids: string[]) =>
  invoke<void>("api_reorder_collections", { workspaceId, ids });

// ---------- environments ----------

export const apiListEnvironments = (workspaceId: string) =>
  invoke<ApiEnvironment[]>("api_list_environments", { workspaceId });

export const apiCreateEnvironment = (workspaceId: string, name: string) =>
  invoke<ApiEnvironment>("api_create_environment", { workspaceId, name });

export const apiUpdateEnvironment = (environment: ApiEnvironment) =>
  invoke<void>("api_update_environment", { environment });

/** No-op on a Globals row — it's always in scope for its workspace and can't be removed. */
export const apiDeleteEnvironment = (id: string) => invoke<void>("api_delete_environment", { id });

export const apiDuplicateEnvironment = (id: string) =>
  invoke<ApiEnvironment>("api_duplicate_environment", { id });

// ---------- history ----------

export const apiListHistory = (workspaceId: string, limit: number) =>
  invoke<ApiHistoryEntry[]>("api_list_history", { workspaceId, limit });

/** The workspace comes from the entry itself, and is what the trim-to-limit is counted within. */
export const apiAddHistory = (entry: ApiHistoryEntry) => invoke<void>("api_add_history", { entry });

export const apiDeleteHistory = (id: string) => invoke<void>("api_delete_history", { id });

export const apiClearHistory = (workspaceId: string) =>
  invoke<void>("api_clear_history", { workspaceId });

// ---------- cookies ----------

export const apiListCookies = (workspaceId: string) =>
  invoke<ApiCookie[]>("api_list_cookies", { workspaceId });

/** Upserts on `(workspace_id, domain, path, name)` — the same cookie in two workspaces is two rows. */
export const apiUpsertCookie = (cookie: ApiCookie) => invoke<void>("api_upsert_cookie", { cookie });

export const apiDeleteCookie = (id: string) => invoke<void>("api_delete_cookie", { id });

export const apiClearCookies = (workspaceId: string) =>
  invoke<void>("api_clear_cookies", { workspaceId });

// ---------- HTTP / GraphQL ----------

/** Sends one fully-resolved request. Rejects with a human-readable string on transport failure. */
export const apiSendHttp = (request: HttpSendRequest) =>
  invoke<HttpResponse>("api_send_http", { request });

/** Cancels an in-flight send. `id` is the token passed alongside the request. */
export const apiCancelHttp = (id: string) => invoke<void>("api_cancel_http", { id });

/** Same as `apiSendHttp` but registered under a cancellation token. */
export const apiSendHttpTracked = (id: string, request: HttpSendRequest) =>
  invoke<HttpResponse>("api_send_http_tracked", { id, request });

/** Reads a file for `binary` bodies and file form-parts, returning base64 + a guessed MIME type. */
export const apiReadFileBase64 = (path: string) =>
  invoke<{ base64: string; mime: string; size: number }>("api_read_file_base64", { path });

// ---------- WebSocket / Socket.IO ----------

/** Opens a connection and returns its id; frames arrive on the `api:stream-message` event. */
export const apiWsConnect = (id: string, request: WsConnectRequest) =>
  invoke<void>("api_ws_connect", { id, request });

export const apiWsSend = (id: string, payload: string, binary: boolean) =>
  invoke<void>("api_ws_send", { id, payload, binary });

export const apiSocketioConnect = (id: string, request: SocketIoConnectRequest) =>
  invoke<void>("api_socketio_connect", { id, request });

/** Emits a Socket.IO event. `payloadJson` must be a JSON value (object, array or scalar). */
export const apiSocketioEmit = (id: string, event: string, payloadJson: string) =>
  invoke<void>("api_socketio_emit", { id, event, payloadJson });

// ---------- MQTT ----------

export const apiMqttConnect = (id: string, request: MqttConnectRequest) =>
  invoke<void>("api_mqtt_connect", { id, request });

export const apiMqttPublish = (
  id: string,
  topic: string,
  payload: string,
  qos: number,
  retain: boolean,
) => invoke<void>("api_mqtt_publish", { id, topic, payload, qos, retain });

export const apiMqttSubscribe = (id: string, topic: string, qos: number) =>
  invoke<void>("api_mqtt_subscribe", { id, topic, qos });

export const apiMqttUnsubscribe = (id: string, topic: string) =>
  invoke<void>("api_mqtt_unsubscribe", { id, topic });

// ---------- shared: closing any live connection ----------

/** Closes a WebSocket, Socket.IO or MQTT connection. Safe to call on an unknown id. */
export const apiStreamDisconnect = (id: string) => invoke<void>("api_stream_disconnect", { id });

// ---------- gRPC ----------

/** Lists services+methods from a `.proto` file or from server reflection. */
export const apiGrpcDescribe = (request: GrpcDescribeRequest) =>
  invoke<GrpcServiceInfo[]>("api_grpc_describe", { request });

/** Unary and server-streaming calls; streaming responses come back as a JSON array. */
export const apiGrpcCall = (id: string, request: GrpcCallRequest) =>
  invoke<GrpcResponse>("api_grpc_call", { id, request });

// ---------- misc ----------

/** Native "open file" dialog filtered to one set of extensions, for proto/cert/data pickers. */
export const apiPickFile = (extensions: string[]) =>
  invoke<string | null>("api_pick_file", { extensions });

/** Native "save file" dialog; writes `contents` and returns the chosen path. */
export const apiSaveFile = (defaultName: string, contents: string) =>
  invoke<string | null>("api_save_file", { defaultName, contents });

/** Reads a text file the user picked (collection import, CSV/JSON runner data). */
export const apiReadTextFile = (path: string) => invoke<string>("api_read_text_file", { path });

/** Writes to a path already chosen — the automatic backup can't open a dialog on a timer. */
export const apiWriteTextFile = (path: string, contents: string) =>
  invoke<void>("api_write_text_file", { path, contents });

// ---------- backup ----------

/**
 * Every workspace's collections, folders, requests and environments. History and cookies are
 * deliberately absent: one is a log, the other holds live sessions.
 */
export const apiExportAll = () => invoke<ApiBackupPayload>("api_export_all");

/**
 * `replace = false` merges — newest `updated_at` wins and nothing is deleted; `replace = true`
 * empties the workspaces named in the backup first.
 */
export const apiImportAll = (backup: ApiBackupPayload, replace: boolean) =>
  invoke<ApiImportSummary>("api_import_all", { backup, replace });

export interface ApiImportSummary {
  workspaces: number;
  collections: number;
  folders: number;
  requests: number;
  environments: number;
}

// ---------- backup passphrase (OS credential store) ----------

export const apiSetBackupPassphrase = (passphrase: string) =>
  invoke<void>("set_api_backup_passphrase", { passphrase });

export const apiGetBackupPassphrase = () => invoke<string | null>("get_api_backup_passphrase");

export const apiDeleteBackupPassphrase = () => invoke<void>("delete_api_backup_passphrase");

// ---------- backup destination: the user's own Google Drive ----------

export interface DriveStatus {
  /** The OAuth client secret is stored. */
  has_secret: boolean;
  /** Consent was granted and a refresh token is held. */
  connected: boolean;
}

export const gdriveStatus = () => invoke<DriveStatus>("gdrive_status");

export const gdriveSetClientSecret = (secret: string) =>
  invoke<void>("gdrive_set_client_secret", { secret });

/** Opens the browser for consent. Resolves with the account that granted it. */
export const gdriveConnect = (clientId: string) =>
  invoke<{ email: string }>("gdrive_connect", { clientId });

export const gdriveDisconnect = () => invoke<void>("gdrive_disconnect");

/** The backup this OAuth client already has in Drive, if another machine wrote one. */
export const gdriveFindFile = (clientId: string, name: string) =>
  invoke<string | null>("gdrive_find_file", { clientId, name });

/** Creates or overwrites the backup file; returns its id. */
export const gdriveUpload = (
  clientId: string,
  fileId: string | null,
  name: string,
  contents: string,
) => invoke<string>("gdrive_upload", { clientId, fileId, name, contents });

export const gdriveDownload = (clientId: string, fileId: string) =>
  invoke<string>("gdrive_download", { clientId, fileId });

// ---------- shared collections on the user's own Supabase project ----------

/**
 * Collaboration is per **collection**, not per workspace. A share and the collection it publishes
 * carry the same id, which is what lets someone accept an invitation into a workspace they already
 * have instead of adopting the host's entire sidebar.
 */

export interface SupabaseCheck {
  /** The project answered — URL and anon key are right. */
  reachable: boolean;
  /** `cf_ping` exists, so the schema script has been run. */
  schema_installed: boolean;
}

export interface SharedCollection {
  id: string;
  name: string;
  share_token: string;
}

/** One shared collection as this machine knows it. Never carries the share token. */
export interface SharedCollectionRow {
  collection_id: string;
  workspace_id: string;
  /** The local collection's name; empty when the collection has been deleted here. */
  name: string;
  remote_name: string;
  role: "owner" | "member";
  cursor: string;
  watermark: string;
  last_sync_at: string;
  last_error: string;
  conflicts: number;
}

export interface SyncResult {
  applied: ApiImportSummary;
  deleted: number;
  /** Records frozen this round, waiting for someone to pick a side. */
  conflicts: number;
  /** Newest server clock seen — the cursor for the next pull. */
  cursor: string;
}

/** One record frozen by a three-way merge, with both sides attached. */
export interface SyncConflict {
  collection_id: string;
  collection_name: string;
  kind: "collection" | "folder" | "request";
  id: string;
  name: string;
  remote_name: string;
  /** JSON of the incoming record — `"{}"` when the incoming change is a deletion. */
  remote_payload: string;
  /** JSON of the local record — `"{}"` when it was deleted here. */
  local_payload: string;
  remote_updated_at: string;
  local_updated_at: string;
  remote_deleted: boolean;
  local_deleted: boolean;
  detected_at: string;
}

/** The SQL the host runs once in their project's editor. */
export const supabaseInstallSql = () => invoke<string>("supabase_install_sql");

export const supabaseSetAnonKey = (anonKey: string) =>
  invoke<void>("supabase_set_anon_key", { anonKey });

export const supabaseHasKey = () => invoke<boolean>("supabase_has_key");

export const supabaseShareToken = (collectionId: string) =>
  invoke<string | null>("supabase_share_token", { collectionId });

/** Is the project reachable and installed. About the project, not about any one share. */
export const supabaseCheck = (url: string) => invoke<SupabaseCheck>("supabase_check", { url });

/** The name the remote has for this share, or `null` if the token no longer resolves. */
export const supabaseProbe = (url: string, collectionId: string) =>
  invoke<string | null>("supabase_probe", { url, collectionId });

/** Every collection shared on this machine, across every workspace. */
export const apiSharedCollections = () =>
  invoke<SharedCollectionRow[]>("api_shared_collections");

/** Starts sharing one collection and returns the invitation material. */
export const supabaseShare = (
  url: string,
  collectionId: string,
  workspaceId: string,
  name: string,
) => invoke<SharedCollection>("supabase_share", { url, collectionId, workspaceId, name });

/** Keeps the remote's display name in step with a local rename. */
export const supabaseRenameShare = (url: string, collectionId: string, name: string) =>
  invoke<void>("supabase_rename_share", { url, collectionId, name });

/** Accepts an invitation, filing the collection under the workspace the user picked. */
export const supabaseJoin = (url: string, token: string, workspaceId: string) =>
  invoke<SharedCollection>("supabase_join", { url, token, workspaceId });

/** Replaces the token — everyone still holding the old one loses access. */
export const supabaseRotate = (url: string, collectionId: string) =>
  invoke<string>("supabase_rotate", { url, collectionId });

/** Stops syncing here. Local only: the remote copy is the host's to end, by rotating. */
export const supabaseLeave = (collectionId: string) =>
  invoke<void>("supabase_leave", { collectionId });

/**
 * The newest change the server holds for this share. One indexed row and no payload — this is what
 * makes a three-second poll affordable, and a full sync only follows when it has moved.
 */
export const supabaseWatermark = (url: string, collectionId: string) =>
  invoke<string>("supabase_watermark", { url, collectionId });

/** One full round for one share: push what changed here, then apply what changed elsewhere. */
export const supabaseSync = (url: string, collectionId: string) =>
  invoke<SyncResult>("supabase_sync", { url, collectionId });

export const apiSyncConflicts = (workspaceId: string) =>
  invoke<SyncConflict[]>("api_sync_conflicts", { workspaceId });

/** Settles one frozen record. */
export const apiResolveConflict = (
  collectionId: string,
  kind: string,
  id: string,
  keep: "mine" | "theirs",
) => invoke<void>("api_resolve_conflict", { collectionId, kind, id, keep });

/** The stored anon key, so an invitation can be built without re-typing it. Public by design. */
export const supabaseAnonKey = () => invoke<string | null>("supabase_anon_key");
