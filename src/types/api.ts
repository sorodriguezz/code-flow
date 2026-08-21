/**
 * Types for the built-in API client ("API" tab) — a Postman-style workbench for HTTP/REST,
 * GraphQL, WebSocket, Socket.IO, gRPC and MQTT.
 *
 * Everything here belongs to a **workspace**, not to a project: collections, environments,
 * history and cookies carry a `workspace_id`, so the API client swaps with the workspace while
 * staying reachable with no repo (or none at all) open. Folders and requests carry no
 * `workspace_id` of their own — they reach it through their collection, which keeps exactly one
 * row per subtree able to be wrong about where it lives.
 *
 * Persistence shape: the DB rows carry the identity/ordering columns needed for tree queries
 * (`id`, `collection_id`, `folder_id`, `sort_order`, …) plus one `spec` JSON blob holding the
 * whole editable request. Keeping the body/headers/auth/scripts in JSON rather than in columns
 * is what lets a new protocol or a new auth scheme ship without a table migration.
 */

import type { RowScope } from "./domain";

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

export type ApiProtocol = "http" | "graphql" | "websocket" | "socketio" | "grpc" | "mqtt";

export const API_PROTOCOLS: ApiProtocol[] = ["http", "graphql", "websocket", "socketio", "grpc", "mqtt"];

/** Protocols whose transport is a long-lived connection rather than one request/response pair. */
export const STREAMING_PROTOCOLS: ApiProtocol[] = ["websocket", "socketio", "mqtt"];

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// ---------------------------------------------------------------------------
// Key/value rows — query params, headers, form fields, path variables
// ---------------------------------------------------------------------------

/** One editable row in any of the request tables. `id` is client-side only (React keys + drag). */
export interface KeyValue {
  id: string;
  key: string;
  value: string;
  description: string;
  enabled: boolean;
  /** form-data only: a `file` row uploads `src` instead of sending `value` as text. */
  type?: "text" | "file";
  /** Absolute path on disk, for `type: "file"` rows. */
  src?: string;
}

export function emptyKeyValue(id: string): KeyValue {
  return { id, key: "", value: "", description: "", enabled: true, type: "text" };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthType =
  | "inherit"
  | "none"
  | "basic"
  | "bearer"
  | "apikey"
  | "digest"
  | "oauth2"
  | "jwt"
  | "awsv4";

export interface BasicAuth {
  username: string;
  password: string;
}

export interface BearerAuth {
  token: string;
}

export interface ApiKeyAuth {
  key: string;
  value: string;
  addTo: "header" | "query";
}

export interface DigestAuth {
  username: string;
  password: string;
}

/** The HS algorithms sign with the raw `secret`; RS and ES sign with a PEM private key in it. */
export type JwtAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "RS384" | "RS512" | "ES256" | "ES384";

export interface JwtAuth {
  algorithm: JwtAlgorithm;
  /** HMAC secret, or a PEM private key for the RS/ES algorithms. */
  secret: string;
  /** Treat `secret` as base64 (HMAC only). */
  secretBase64: boolean;
  /** JSON object merged into the JWT header. */
  headerJson: string;
  /** JSON object used as the JWT payload (claims). */
  payloadJson: string;
  addTo: "header" | "query";
  headerPrefix: string;
  queryParamName: string;
}

export interface AwsV4Auth {
  accessKey: string;
  secretKey: string;
  sessionToken: string;
  region: string;
  service: string;
}

export type OAuth2GrantType =
  | "authorization_code"
  | "authorization_code_pkce"
  | "client_credentials"
  | "password"
  | "implicit";

export interface OAuth2Auth {
  grantType: OAuth2GrantType;
  authUrl: string;
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  state: string;
  username: string;
  password: string;
  redirectUri: string;
  audience: string;
  resource: string;
  /** Where the client credentials go on the token call. */
  clientAuth: "header" | "body";
  /** Populated after a successful token exchange; this is what actually gets sent. */
  accessToken: string;
  refreshToken: string;
  /** Unix seconds; 0 = unknown. */
  expiresAt: number;
  headerPrefix: string;
  addTo: "header" | "query";
}

export interface AuthConfig {
  type: AuthType;
  basic: BasicAuth;
  bearer: BearerAuth;
  apikey: ApiKeyAuth;
  digest: DigestAuth;
  jwt: JwtAuth;
  awsv4: AwsV4Auth;
  oauth2: OAuth2Auth;
}

export function defaultAuth(type: AuthType = "inherit"): AuthConfig {
  return {
    type,
    basic: { username: "", password: "" },
    bearer: { token: "" },
    apikey: { key: "", value: "", addTo: "header" },
    digest: { username: "", password: "" },
    jwt: {
      algorithm: "HS256",
      secret: "",
      secretBase64: false,
      headerJson: "{}",
      payloadJson: "{}",
      addTo: "header",
      headerPrefix: "Bearer",
      queryParamName: "token",
    },
    awsv4: { accessKey: "", secretKey: "", sessionToken: "", region: "", service: "" },
    oauth2: {
      grantType: "client_credentials",
      authUrl: "",
      accessTokenUrl: "",
      clientId: "",
      clientSecret: "",
      scope: "",
      state: "",
      username: "",
      password: "",
      redirectUri: "http://localhost:8976/callback",
      audience: "",
      resource: "",
      clientAuth: "header",
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      headerPrefix: "Bearer",
      addTo: "header",
    },
  };
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

export type BodyMode = "none" | "raw" | "formdata" | "urlencoded" | "binary" | "graphql";
export type RawLanguage = "json" | "xml" | "text" | "javascript" | "html";

export interface RequestBody {
  mode: BodyMode;
  raw: string;
  rawLanguage: RawLanguage;
  formdata: KeyValue[];
  urlencoded: KeyValue[];
  /** Absolute path of the file streamed as the whole body. */
  binaryPath: string;
  graphql: GraphqlBody;
}

export interface GraphqlBody {
  query: string;
  /** JSON object as text — kept as text so an in-progress edit isn't destroyed by a parse error. */
  variables: string;
  operationName: string;
}

export function defaultBody(): RequestBody {
  return {
    mode: "none",
    raw: "",
    rawLanguage: "json",
    formdata: [],
    urlencoded: [],
    binaryPath: "",
    graphql: { query: "", variables: "{}", operationName: "" },
  };
}

// ---------------------------------------------------------------------------
// Protocol-specific settings
// ---------------------------------------------------------------------------

export interface WebsocketSettings {
  /** Sec-WebSocket-Protocol values. */
  subprotocols: string;
  /** Milliseconds between automatic pings; 0 = off. */
  pingIntervalMs: number;
  /** What the message composer sends. */
  messageFormat: "text" | "json" | "binary";
  /** Draft kept with the request so a saved socket remembers its last payload. */
  draftMessage: string;
}

export interface SocketIoSettings {
  /** Engine.IO path, default `/socket.io`. */
  path: string;
  /** Namespace, default `/`. */
  namespace: string;
  /** Engine.IO protocol version — v4 is Socket.IO 3/4, v3 is Socket.IO 2. */
  version: "v4" | "v3";
  /** Handshake auth payload as JSON text. */
  authJson: string;
  /** Events the client subscribes to (an empty list listens to everything). */
  listeners: string[];
  draftEvent: string;
  draftPayload: string;
}

export interface MqttSettings {
  clientId: string;
  username: string;
  password: string;
  /** Seconds. */
  keepAlive: number;
  cleanSession: boolean;
  /** MQTT protocol level. */
  version: "3.1.1" | "5.0";
  /** Topics subscribed on connect. */
  subscriptions: MqttSubscription[];
  lastWill: {
    topic: string;
    payload: string;
    qos: 0 | 1 | 2;
    retain: boolean;
  };
  publishTopic: string;
  publishPayload: string;
  publishQos: 0 | 1 | 2;
  publishRetain: boolean;
}

export interface MqttSubscription {
  id: string;
  topic: string;
  qos: 0 | 1 | 2;
  enabled: boolean;
}

export type GrpcCallKind = "unary" | "client_stream" | "server_stream" | "bidi_stream";

export interface GrpcSettings {
  /** How the service descriptor is obtained. */
  source: "proto" | "reflection";
  /** Absolute path of the entry `.proto` file when `source === "proto"`. */
  protoPath: string;
  /** Extra `-I` import roots for proto resolution. */
  importPaths: string[];
  /** Fully-qualified service name, e.g. `helloworld.Greeter`. */
  service: string;
  method: string;
  /** Filled in from the descriptor once known; drives which panel the UI shows. */
  callKind: GrpcCallKind;
  /** Request message as JSON text (one JSON object; for client-streaming, a JSON array). */
  messageJson: string;
  /** gRPC metadata (headers). */
  metadata: KeyValue[];
  useTls: boolean;
  /** Override the TLS SNI / authority header. */
  authority: string;
}

// ---------------------------------------------------------------------------
// Per-request overrides of the global network settings
// ---------------------------------------------------------------------------

export interface RequestSettings {
  /** `null` inherits the app-level setting. */
  followRedirects: boolean | null;
  maxRedirects: number | null;
  verifySsl: boolean | null;
  timeoutMs: number | null;
  /** Send the cookie jar for this request. */
  sendCookies: boolean | null;
  /** Keep `Authorization` when a redirect crosses hosts. */
  keepAuthOnRedirect: boolean | null;
  /** Encode the URL before sending (off = send exactly what was typed). */
  encodeUrl: boolean | null;
}

export function defaultRequestSettings(): RequestSettings {
  return {
    followRedirects: null,
    maxRedirects: null,
    verifySsl: null,
    timeoutMs: null,
    sendCookies: null,
    keepAuthOnRedirect: null,
    encodeUrl: null,
  };
}

// ---------------------------------------------------------------------------
// The request spec — the JSON blob stored in `api_requests.spec`
// ---------------------------------------------------------------------------

export interface ApiRequestSpec {
  protocol: ApiProtocol;
  method: string;
  url: string;
  params: KeyValue[];
  /** Detected from `:name` segments in the URL; values are supplied here. */
  pathVars: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: AuthConfig;
  preScript: string;
  postScript: string;
  settings: RequestSettings;
  description: string;
  websocket: WebsocketSettings;
  socketio: SocketIoSettings;
  mqtt: MqttSettings;
  grpc: GrpcSettings;
  /** Saved example responses — the seed for docs and (future) mocking. */
  examples: SavedExample[];
}

export interface SavedExample {
  id: string;
  name: string;
  status: number;
  statusText: string;
  headers: KeyValue[];
  body: string;
}

export function defaultRequestSpec(protocol: ApiProtocol = "http"): ApiRequestSpec {
  return {
    protocol,
    method: protocol === "graphql" ? "POST" : "GET",
    url: "",
    params: [],
    pathVars: [],
    headers: [],
    body: protocol === "graphql" ? { ...defaultBody(), mode: "graphql" } : defaultBody(),
    auth: defaultAuth("inherit"),
    preScript: "",
    postScript: "",
    settings: defaultRequestSettings(),
    description: "",
    websocket: {
      subprotocols: "",
      pingIntervalMs: 0,
      messageFormat: "text",
      draftMessage: "",
    },
    socketio: {
      path: "/socket.io",
      namespace: "/",
      version: "v4",
      authJson: "{}",
      listeners: [],
      draftEvent: "message",
      draftPayload: "{}",
    },
    mqtt: {
      clientId: "",
      username: "",
      password: "",
      keepAlive: 60,
      cleanSession: true,
      version: "3.1.1",
      subscriptions: [],
      lastWill: { topic: "", payload: "", qos: 0, retain: false },
      publishTopic: "",
      publishPayload: "",
      publishQos: 0,
      publishRetain: false,
    },
    grpc: {
      source: "reflection",
      protoPath: "",
      importPaths: [],
      service: "",
      method: "",
      callKind: "unary",
      messageJson: "{}",
      metadata: [],
      useTls: false,
      authority: "",
    },
    examples: [],
  };
}

// ---------------------------------------------------------------------------
// Tree entities (mirror the `api_*` DB rows)
// ---------------------------------------------------------------------------

export interface ApiCollection {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  /** JSON `AuthConfig`; empty string means "none configured". */
  auth: string;
  pre_script: string;
  post_script: string;
  /** JSON `ApiVariable[]` — collection-scoped variables. */
  variables: string;
  sort_order: number;
  /** Sorts above the unpinned ones in the explorer, ahead of `sort_order`. */
  pinned: boolean;
  created_at: string;
  updated_at: string;
  /** Whether this row is on one workspace's shelf or on every one of them. */
  scope: RowScope;
}

export interface ApiFolder {
  id: string;
  collection_id: string;
  /** `null` = directly under the collection. */
  parent_id: string | null;
  name: string;
  description: string;
  auth: string;
  pre_script: string;
  post_script: string;
  sort_order: number;
  created_at: string;
  /** Bumped on every edit, so a restore and a shared-workspace pull can resolve last-write-wins. */
  updated_at: string;
}

export interface ApiRequestRow {
  id: string;
  collection_id: string;
  /** `null` = directly under the collection. */
  folder_id: string | null;
  name: string;
  protocol: ApiProtocol;
  method: string;
  url: string;
  /** JSON `ApiRequestSpec`. */
  spec: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Everything the tree needs, fetched in one round trip. */
export interface ApiTree {
  collections: ApiCollection[];
  folders: ApiFolder[];
  requests: ApiRequestRow[];
}

// ---------------------------------------------------------------------------
// Variables & environments
// ---------------------------------------------------------------------------

export interface ApiVariable {
  id: string;
  key: string;
  /** The value committed to disk / shared on export. */
  initialValue: string;
  /** The value actually used when sending; scripts write here. */
  currentValue: string;
  /** Masked in the UI and omitted from exports. */
  secret: boolean;
  enabled: boolean;
  description: string;
}

export interface ApiEnvironment {
  id: string;
  workspace_id: string;
  name: string;
  /** JSON `ApiVariable[]`. */
  variables: string;
  /** Exactly one row per workspace is the Globals pseudo-environment. */
  is_global: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Precedence, most specific first — matches Postman's resolution order. */
export type VariableScope = "local" | "data" | "environment" | "collection" | "global";

export const VARIABLE_SCOPE_ORDER: VariableScope[] = [
  "local",
  "data",
  "environment",
  "collection",
  "global",
];

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface ApiHistoryEntry {
  id: string;
  workspace_id: string;
  request_id: string | null;
  name: string;
  protocol: ApiProtocol;
  method: string;
  url: string;
  status: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
  /** JSON `{ request: ApiRequestSpec; response: ApiResponse | null }`. */
  snapshot: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export interface ApiCookie {
  id: string;
  workspace_id: string;
  domain: string;
  path: string;
  name: string;
  value: string;
  secure: boolean;
  http_only: boolean;
  /** RFC3339, or `null` for a session cookie. */
  expires: string | null;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Wire types — what the Rust side receives and returns
// ---------------------------------------------------------------------------

/** A fully-resolved HTTP request: variables already interpolated, auth already applied where it
 * can be done in the UI. The backend does not read the DB — the frontend hands it everything. */
export interface HttpSendRequest {
  method: string;
  url: string;
  headers: [string, string][];
  /** Exactly one of these is set (or none, for a bodiless request). */
  body_text: string | null;
  body_base64: string | null;
  body_file: string | null;
  form_data: FormPart[] | null;
  /** `application/x-www-form-urlencoded` pairs. */
  urlencoded: [string, string][] | null;
  /** Auth that only the backend can perform (digest challenge/response, AWS SigV4). */
  auth: BackendAuth | null;
  options: NetworkOptions;
}

export interface FormPart {
  name: string;
  /** Text value, when `file_path` is null. */
  value: string | null;
  /** Absolute path; streamed as a file part. */
  file_path: string | null;
  content_type: string | null;
}

export type BackendAuth =
  | { kind: "digest"; username: string; password: string }
  | {
      kind: "awsv4";
      access_key: string;
      secret_key: string;
      session_token: string;
      region: string;
      service: string;
    };

export interface NetworkOptions {
  timeout_ms: number;
  follow_redirects: boolean;
  max_redirects: number;
  verify_ssl: boolean;
  keep_auth_on_redirect: boolean;
  /** `""` = no proxy, otherwise a proxy URL. */
  proxy_url: string;
  /** PEM/PKCS#12 client certificate for mTLS, matched by host in the caller. */
  client_cert_path: string;
  client_cert_password: string;
  /** Extra CA bundle (PEM). */
  ca_cert_path: string;
  /** Cookies to send, already matched to the URL by the caller. */
  cookies: [string, string][];
  max_response_bytes: number;
}

export interface HttpResponse {
  status: number;
  status_text: string;
  http_version: string;
  headers: [string, string][];
  /** UTF-8 decoded body when the payload is text; empty for binary. */
  body_text: string;
  /** Set instead of `body_text` when the payload isn't valid UTF-8. */
  body_base64: string | null;
  /** Uncompressed byte length actually received. */
  size_bytes: number;
  duration_ms: number;
  /** Per-phase timings in milliseconds; -1 where unavailable. */
  timings: ResponseTimings;
  /** Every hop when redirects were followed, the final URL last. */
  redirects: string[];
  /** `Set-Cookie` values parsed out of the response. */
  set_cookies: ParsedCookie[];
  /** The request as it actually went on the wire, for the console. */
  sent: SentRequestSummary;
}

export interface ResponseTimings {
  dns_ms: number;
  connect_ms: number;
  tls_ms: number;
  first_byte_ms: number;
  download_ms: number;
  total_ms: number;
}

export interface ParsedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string | null;
  secure: boolean;
  http_only: boolean;
}

export interface SentRequestSummary {
  method: string;
  url: string;
  headers: [string, string][];
  body_preview: string;
}

/** The full response as the UI holds it (backend payload + client-side extras). */
export interface ApiResponse extends HttpResponse {
  /** Assertion results from the post-response script. */
  tests: TestResult[];
  /** Anything the script logged. */
  consoleLines: ConsoleLine[];
  /** `pm.visualizer.set()` output, when the script called it. */
  visualizer: { template: string; data: unknown } | null;
  /** Set when the request failed before a response arrived. */
  error: string | null;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error: string | null;
  duration_ms: number;
}

export interface ConsoleLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
  at: number;
}

// ---------------------------------------------------------------------------
// The resolved request — the keystone type
// ---------------------------------------------------------------------------

/**
 * An `ApiRequestSpec` after variables are interpolated, path variables substituted, query
 * params folded into the URL and auth applied.
 *
 * This is deliberately the *single* input to both the transport call and every code-snippet
 * generator: it's what makes "the cURL snippet is exactly what Send would do" true by
 * construction rather than by two implementations agreeing. Anything a snippet can't express
 * (a backend-signed scheme) travels in `backendAuth` so the generator can say so out loud
 * instead of silently emitting an unauthenticated request.
 */
export interface ResolvedRequest {
  protocol: ApiProtocol;
  method: string;
  /** Absolute, including the final query string. */
  url: string;
  headers: [string, string][];
  body: ResolvedBody;
  /** Non-null when signing has to happen on the wire (Digest, AWS SigV4). */
  backendAuth: BackendAuth | null;
  options: NetworkOptions;
}

export type ResolvedBody =
  | { kind: "none" }
  | { kind: "text"; text: string; contentType: string }
  | { kind: "formdata"; parts: FormPart[] }
  | { kind: "urlencoded"; pairs: [string, string][] }
  | { kind: "file"; path: string; contentType: string };

// ---------------------------------------------------------------------------
// Streaming protocols — connection handles and events
// ---------------------------------------------------------------------------

export type StreamKind = "websocket" | "socketio" | "mqtt" | "grpc";

export interface WsConnectRequest {
  url: string;
  headers: [string, string][];
  subprotocols: string[];
  /** 0 = no automatic pings. */
  ping_interval_ms: number;
  options: NetworkOptions;
}

export interface SocketIoConnectRequest {
  url: string;
  path: string;
  namespace: string;
  /** `"v4"` (Socket.IO 3/4) or `"v3"` (Socket.IO 2). */
  version: string;
  headers: [string, string][];
  /** JSON object sent in the CONNECT packet. */
  auth_json: string;
  query: [string, string][];
  options: NetworkOptions;
}

export interface MqttConnectRequest {
  url: string;
  client_id: string;
  username: string;
  password: string;
  keep_alive_secs: number;
  clean_session: boolean;
  version: string;
  last_will: { topic: string; payload: string; qos: number; retain: boolean } | null;
  subscriptions: { topic: string; qos: number }[];
  options: NetworkOptions;
}

/** One entry in a live connection's transcript. */
export interface StreamMessage {
  connection_id: string;
  /** `sent` | `received` | `system` | `error`. */
  direction: "sent" | "received" | "system" | "error";
  /** Socket.IO event name, MQTT topic, or `""`. */
  channel: string;
  payload: string;
  /** True when `payload` is base64 of a binary frame. */
  binary: boolean;
  /** Unix milliseconds. */
  at: number;
  /** MQTT only. */
  qos?: number;
  retain?: boolean;
}

export interface StreamStatusEvent {
  connection_id: string;
  status: "connecting" | "open" | "closed" | "error";
  detail: string;
}

// ---------------------------------------------------------------------------
// gRPC
// ---------------------------------------------------------------------------

export interface GrpcServiceInfo {
  name: string;
  methods: GrpcMethodInfo[];
}

export interface GrpcMethodInfo {
  name: string;
  full_name: string;
  client_streaming: boolean;
  server_streaming: boolean;
  /** A JSON skeleton of the input message, for the "generate example" action. */
  input_example: string;
  input_type: string;
  output_type: string;
}

export interface GrpcDescribeRequest {
  /** `proto` | `reflection`. */
  source: string;
  proto_path: string;
  import_paths: string[];
  /** Only for reflection. */
  endpoint: string;
  use_tls: boolean;
  metadata: [string, string][];
  options: NetworkOptions;
}

export interface GrpcCallRequest {
  source: string;
  proto_path: string;
  import_paths: string[];
  endpoint: string;
  service: string;
  method: string;
  /** JSON object, or a JSON array for client-streaming calls. */
  message_json: string;
  metadata: [string, string][];
  use_tls: boolean;
  authority: string;
  options: NetworkOptions;
}

export interface GrpcResponse {
  /** JSON of the response message; for server-streaming, a JSON array of messages. */
  message_json: string;
  /** gRPC status code (0 = OK). */
  status_code: number;
  status_message: string;
  headers: [string, string][];
  trailers: [string, string][];
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Global network / app settings for the API client
// ---------------------------------------------------------------------------

export interface ApiSettings {
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifySsl: boolean;
  keepAuthOnRedirect: boolean;
  sendCookies: boolean;
  proxyEnabled: boolean;
  proxyUrl: string;
  maxResponseBytes: number;
  /** Per-host client certificates for mTLS. */
  clientCerts: ClientCert[];
  caCertPath: string;
  /** Pretty-print JSON responses by default. */
  prettyPrint: boolean;
  /** Save every send into `api_history`. */
  saveHistory: boolean;
  historyLimit: number;
  /**
   * The Supabase projects this machine hosts shared collections on. The anon key of each and every
   * share token live in the OS credential store; only the URL and the last verdict are settings.
   */
  supabaseProjects: SupabaseProject[];
  /** Keep shared collections in step in the background as well as on demand. */
  syncAuto: boolean;
}

/**
 * One Supabase project, as the collaboration panel knows it.
 *
 * A list rather than the single `supabaseUrl` this replaced. The backend was always plural — an
 * anon key is filed per project host, and every share carries the project it lives on — so the one
 * field was never the truth, only the *last* project set up. Changing it left every collection
 * created before it syncing happily against a project the settings pane no longer named, which is
 * exactly the state nothing on screen could describe.
 */
export interface SupabaseProject {
  url: string;
  /**
   * The last connection test succeeded — the project answered and the schema is installed.
   *
   * Persisted rather than held in the panel, because a check that only lives in component state is
   * lost the moment the modal closes: reopening it would say "not tested yet" about a project that
   * has been syncing all along, and the only way back to "connected" is pressing a button that
   * changes nothing. The panel re-verifies in the background on every open; this is what it shows
   * while that is in flight.
   */
  ready: boolean;
  /** When that check last passed, so the panel can say how fresh "connected" is. */
  checkedAt: string;
}

/*
 * Backup used to live here — `backupTarget`, `backupPath`, `autoBackup`, `drive*`, `backupEncrypt`,
 * `lastBackupAt`. It moved out when it stopped being about the API client: what travels now is the
 * whole install, credentials included, so its settings belong to the app rather than to one of its
 * views. See `state/backup_settings` in the database and `components/settings/BackupSettings.tsx`.
 *
 * The Google client id is the one field that was worth rescuing rather than dropping — a user who
 * had already created a Google Cloud project should not have to do it twice — and it is carried
 * across on the first launch after upgrading (see `backup::auto::spawn`).
 */

export interface ClientCert {
  id: string;
  host: string;
  /** PKCS#12 (.p12/.pfx) or PEM bundle. */
  certPath: string;
  keyPath: string;
  passphrase: string;
}

export function defaultApiSettings(): ApiSettings {
  return {
    timeoutMs: 30_000,
    followRedirects: true,
    maxRedirects: 10,
    verifySsl: true,
    keepAuthOnRedirect: false,
    sendCookies: true,
    proxyEnabled: false,
    proxyUrl: "",
    maxResponseBytes: 50 * 1024 * 1024,
    clientCerts: [],
    caCertPath: "",
    prettyPrint: true,
    saveHistory: true,
    historyLimit: 500,
    supabaseProjects: [],
    syncAuto: true,
  };
}

// ---------------------------------------------------------------------------
// Collection Runner
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  /** Collection or folder the run starts from. */
  collectionId: string;
  folderId: string | null;
  /** Request ids in run order, with the unchecked ones already removed. */
  requestIds: string[];
  iterations: number;
  delayMs: number;
  /** Rows parsed from a CSV/JSON data file; one iteration per row. */
  data: Record<string, string>[];
  /** Keep variable writes after the run finishes. */
  persistVariables: boolean;
  stopOnError: boolean;
}

/**
 * What one runner row keeps of the exchange it performed, so the results view can show the
 * response side by side with the assertions instead of only their verdicts.
 *
 * It is capped rather than complete, and that's the whole point of the type existing separately:
 * a 2000-request run against an API that answers in megabytes would otherwise hold every byte of
 * the run's traffic in memory at once, while the pane only ever shows one row. `bodyNotice` names
 * why a body is short or missing — an empty pane with no explanation reads as "the server sent
 * nothing", which is a different and wrong story.
 */
export interface RunnerCapture {
  statusText: string;
  requestHeaders: [string, string][];
  requestBody: string;
  responseHeaders: [string, string][];
  responseBody: string;
  bodyNotice: "truncated" | "dropped" | "binary" | null;
}

export interface RunnerResultItem {
  iteration: number;
  requestId: string;
  name: string;
  /** Enclosing folder names from the run root down, outermost first — the row's breadcrumb. */
  folderPath: string[];
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  sizeBytes: number;
  tests: TestResult[];
  error: string | null;
  /** The exchange itself, once the request resolved and while the run still had capture budget. */
  capture: RunnerCapture | null;
}

export interface RunnerReport {
  startedAt: number;
  finishedAt: number;
  /** Iterations the run was configured for — a run stopped early never reaches all of them. */
  iterations: number;
  /** Environment selected when the run started; null when none was. */
  environmentName: string | null;
  items: RunnerResultItem[];
  totalRequests: number;
  totalAssertions: number;
  failedAssertions: number;
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export type ImportFormat = "postman" | "openapi" | "curl" | "har" | "insomnia" | "codeflow";

export interface ImportResult {
  format: ImportFormat;
  collections: ImportedCollection[];
  environments: { name: string; variables: ApiVariable[] }[];
  warnings: string[];
}

/** A collection tree in memory, before it is written to the DB. */
export interface ImportedCollection {
  name: string;
  description: string;
  auth: AuthConfig | null;
  variables: ApiVariable[];
  preScript: string;
  postScript: string;
  items: ImportedItem[];
}

export type ImportedItem =
  | {
      kind: "folder";
      name: string;
      description: string;
      auth: AuthConfig | null;
      preScript: string;
      postScript: string;
      items: ImportedItem[];
    }
  | { kind: "request"; name: string; spec: ApiRequestSpec };

export interface ImportOptions {
  /**
   * Map an OpenAPI document's documented responses to saved examples. On by default; off is for
   * the user who wants the requests and not the several hundred example rows that come with them.
   */
  includeExamples?: boolean;
  /**
   * Where the document was fetched from, when it was fetched rather than pasted or opened.
   *
   * An API description routinely does not say what host it describes — NestJS emits no `servers`
   * unless the app calls `addServer`, and OpenAPI positively encourages `servers: [{ url: "/v1" }]`,
   * which is *defined* as relative to wherever the document is served. Swagger UI gets away with
   * both because it knows the URL it loaded the document from; this is that URL.
   */
  sourceUrl?: string;
}

// ---------------------------------------------------------------------------
// Code snippets
// ---------------------------------------------------------------------------

export interface SnippetTarget {
  id: string;
  /** Label shown in the picker, e.g. `NodeJs - Axios`. */
  label: string;
  /** Monaco language id used to highlight the generated code. */
  language: string;
  /** Grouping in the picker (`JavaScript`, `Python`, `Shell`, …). */
  group: string;
}

export interface SnippetOptions {
  /** Wrap long command lines (cURL/wget). */
  multiline: boolean;
  indentWith: "  " | "    " | "\t";
  /** Emit a trailing "print the response" line where the language needs one. */
  includeBoilerplate: boolean;
}
