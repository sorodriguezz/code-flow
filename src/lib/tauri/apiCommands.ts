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
