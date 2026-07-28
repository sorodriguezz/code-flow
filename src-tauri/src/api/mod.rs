//! Transport layer for the built-in API client.
//!
//! **This module is a transport, not a model.** It never reads the database, never resolves a
//! `{{variable}}`, and never decides what a request should contain — the frontend interpolates
//! variables, runs the pre-request script, applies every auth scheme it can express as a header
//! and hands down a fully-resolved [`HttpSendRequest`]. What lives here is only what a webview
//! genuinely cannot do:
//!
//! - **Raw sockets** — WebSocket, Socket.IO, MQTT and gRPC (`ws`, `socketio`, `mqtt`, `grpc`).
//! - **Auth that needs the wire** — Digest (a challenge/response round trip) and AWS SigV4 (a
//!   canonical form built from the request as it will actually be sent), both in `http`.
//! - **Transport knobs the fetch API doesn't expose** — per-request TLS verification, client
//!   certificates, proxies, redirect policy, streaming file bodies, real timings.
//!
//! Every type below is mirrored one-for-one in `src/types/api.ts`; the field names are the
//! serde wire names, so renaming one here is a breaking change on both sides.

pub mod grpc;
pub mod http;
pub mod mqtt;
pub mod socketio;
pub mod ws;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// Shared network options
// ---------------------------------------------------------------------------

/// Per-send transport configuration. The frontend has already merged the global settings with
/// the request's own overrides, so this is the final word — nothing here falls back to a default
/// held on the Rust side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkOptions {
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub max_redirects: usize,
    pub verify_ssl: bool,
    /// Whether `Authorization` survives a redirect that changes host. Off by default because
    /// forwarding a bearer token to whatever host a 302 names is a credential leak.
    pub keep_auth_on_redirect: bool,
    /// `""` = direct connection.
    pub proxy_url: String,
    /// PKCS#12 (`.p12`/`.pfx`) or a PEM bundle, for mTLS.
    pub client_cert_path: String,
    pub client_cert_password: String,
    /// Extra PEM CA bundle to trust on top of the system roots.
    pub ca_cert_path: String,
    /// Cookies the caller already matched against this URL, as `(name, value)`.
    pub cookies: Vec<(String, String)>,
    /// Hard cap on how much of a response body is buffered; 0 = unlimited.
    pub max_response_bytes: u64,
}

impl Default for NetworkOptions {
    fn default() -> Self {
        Self {
            timeout_ms: 30_000,
            follow_redirects: true,
            max_redirects: 10,
            verify_ssl: true,
            keep_auth_on_redirect: false,
            proxy_url: String::new(),
            client_cert_path: String::new(),
            client_cert_password: String::new(),
            ca_cert_path: String::new(),
            cookies: Vec::new(),
            max_response_bytes: 50 * 1024 * 1024,
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP request / response
// ---------------------------------------------------------------------------

/// One multipart field. A part is a file when `file_path` is set, otherwise plain text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormPart {
    pub name: String,
    pub value: Option<String>,
    pub file_path: Option<String>,
    pub content_type: Option<String>,
}

/// Auth the frontend can't perform on its own.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendAuth {
    /// RFC 7616: send unauthenticated, read `WWW-Authenticate`, re-send with the digest.
    Digest { username: String, password: String },
    /// SigV4 signs a canonical request derived from the final method/URL/headers/body.
    Awsv4 {
        access_key: String,
        secret_key: String,
        session_token: String,
        region: String,
        service: String,
    },
}

/// A fully-resolved HTTP request. Exactly one body representation is populated (or none).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpSendRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body_text: Option<String>,
    /// Base64 — used for binary payloads assembled in the webview.
    pub body_base64: Option<String>,
    /// Absolute path streamed from disk, so a multi-GB upload never enters the webview heap.
    pub body_file: Option<String>,
    pub form_data: Option<Vec<FormPart>>,
    pub urlencoded: Option<Vec<(String, String)>>,
    pub auth: Option<BackendAuth>,
    pub options: NetworkOptions,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResponseTimings {
    pub dns_ms: i64,
    pub connect_ms: i64,
    pub tls_ms: i64,
    pub first_byte_ms: i64,
    pub download_ms: i64,
    pub total_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub expires: Option<String>,
    pub secure: bool,
    pub http_only: bool,
}

/// What actually went on the wire, including headers the transport added on its own
/// (`Host`, `Content-Length`, `Accept-Encoding`…). This is what makes the console honest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SentRequestSummary {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub http_version: String,
    pub headers: Vec<(String, String)>,
    /// UTF-8 body; empty when the payload isn't valid UTF-8 (see `body_base64`).
    pub body_text: String,
    pub body_base64: Option<String>,
    pub size_bytes: u64,
    pub duration_ms: i64,
    pub timings: ResponseTimings,
    /// Every hop when redirects were followed; the final URL is last.
    pub redirects: Vec<String>,
    pub set_cookies: Vec<ParsedCookie>,
    pub sent: SentRequestSummary,
}

// ---------------------------------------------------------------------------
// Streaming protocols
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsConnectRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub subprotocols: Vec<String>,
    /// 0 = no automatic pings.
    pub ping_interval_ms: u64,
    pub options: NetworkOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketIoConnectRequest {
    pub url: String,
    pub path: String,
    pub namespace: String,
    /// `"v4"` (Socket.IO 3/4) or `"v3"` (Socket.IO 2).
    pub version: String,
    pub headers: Vec<(String, String)>,
    pub auth_json: String,
    pub query: Vec<(String, String)>,
    pub options: NetworkOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttLastWill {
    pub topic: String,
    pub payload: String,
    pub qos: u8,
    pub retain: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttSubscribe {
    pub topic: String,
    pub qos: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttConnectRequest {
    pub url: String,
    pub client_id: String,
    pub username: String,
    pub password: String,
    pub keep_alive_secs: u64,
    pub clean_session: bool,
    /// `"3.1.1"` or `"5.0"`.
    pub version: String,
    pub last_will: Option<MqttLastWill>,
    pub subscriptions: Vec<MqttSubscribe>,
    pub options: NetworkOptions,
}

/// One line of a live connection's transcript, emitted on the `api:stream-message` event.
#[derive(Debug, Clone, Serialize)]
pub struct StreamMessage {
    pub connection_id: String,
    /// `sent` | `received` | `system` | `error`.
    pub direction: String,
    /// Socket.IO event name, MQTT topic, or `""`.
    pub channel: String,
    pub payload: String,
    /// `payload` is base64 of a binary frame.
    pub binary: bool,
    /// Unix milliseconds.
    pub at: i64,
    pub qos: Option<u8>,
    pub retain: Option<bool>,
}

impl StreamMessage {
    pub fn new(connection_id: &str, direction: &str, channel: &str, payload: impl Into<String>) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            direction: direction.to_string(),
            channel: channel.to_string(),
            payload: payload.into(),
            binary: false,
            at: chrono::Utc::now().timestamp_millis(),
            qos: None,
            retain: None,
        }
    }
}

/// Lifecycle transitions, emitted on the `api:stream-status` event.
#[derive(Debug, Clone, Serialize)]
pub struct StreamStatusEvent {
    pub connection_id: String,
    /// `connecting` | `open` | `closed` | `error`.
    pub status: String,
    pub detail: String,
}

impl StreamStatusEvent {
    pub fn new(connection_id: &str, status: &str, detail: impl Into<String>) -> Self {
        Self {
            connection_id: connection_id.to_string(),
            status: status.to_string(),
            detail: detail.into(),
        }
    }
}

pub const EVENT_STREAM_MESSAGE: &str = "api:stream-message";
pub const EVENT_STREAM_STATUS: &str = "api:stream-status";

// ---------------------------------------------------------------------------
// gRPC
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrpcMethodInfo {
    pub name: String,
    pub full_name: String,
    pub client_streaming: bool,
    pub server_streaming: bool,
    /// JSON skeleton of the input message, for the "generate example" action.
    pub input_example: String,
    pub input_type: String,
    pub output_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrpcServiceInfo {
    pub name: String,
    pub methods: Vec<GrpcMethodInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrpcDescribeRequest {
    /// `"proto"` | `"reflection"`.
    pub source: String,
    pub proto_path: String,
    pub import_paths: Vec<String>,
    /// Only used for reflection.
    pub endpoint: String,
    pub use_tls: bool,
    pub metadata: Vec<(String, String)>,
    pub options: NetworkOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrpcCallRequest {
    pub source: String,
    pub proto_path: String,
    pub import_paths: Vec<String>,
    pub endpoint: String,
    pub service: String,
    pub method: String,
    /// A JSON object, or a JSON array for client-streaming calls.
    pub message_json: String,
    pub metadata: Vec<(String, String)>,
    pub use_tls: bool,
    pub authority: String,
    pub options: NetworkOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrpcResponse {
    /// JSON of the response message; a JSON array for server-streaming calls.
    pub message_json: String,
    pub status_code: i32,
    pub status_message: String,
    pub headers: Vec<(String, String)>,
    pub trailers: Vec<(String, String)>,
    pub duration_ms: i64,
}

// ---------------------------------------------------------------------------
// Live connection registry
// ---------------------------------------------------------------------------

/// A handle to something the UI can still talk to after `connect` returned.
pub enum Connection {
    /// Text/binary frames the writer task forwards onto the socket. `bool` = is-binary.
    Ws(tokio::sync::mpsc::UnboundedSender<WsCommand>),
    /// Socket.IO shares the WebSocket writer but frames payloads as Engine.IO packets.
    SocketIo(tokio::sync::mpsc::UnboundedSender<WsCommand>),
    Mqtt(tokio::sync::mpsc::UnboundedSender<MqttCommand>),
}

#[derive(Debug)]
pub enum WsCommand {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

#[derive(Debug)]
pub enum MqttCommand {
    Publish {
        topic: String,
        payload: String,
        qos: u8,
        retain: bool,
    },
    Subscribe {
        topic: String,
        qos: u8,
    },
    Unsubscribe {
        topic: String,
    },
    Close,
}

/// Every open WebSocket/Socket.IO/MQTT connection, plus the cancel channels for in-flight HTTP
/// and gRPC calls. Managed by Tauri (`app.manage`) so commands can reach it by `State`.
#[derive(Default)]
pub struct ApiRegistry {
    pub connections: Mutex<HashMap<String, Connection>>,
    /// Firing the sender aborts the matching in-flight request.
    pub cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl ApiRegistry {
    pub fn insert(&self, id: String, conn: Connection) {
        if let Ok(mut map) = self.connections.lock() {
            map.insert(id, conn);
        }
    }

    /// Sends `Close` and forgets the handle. Safe on an id that was never registered — a
    /// disconnect can legitimately race a connection that already died on its own.
    pub fn close(&self, id: &str) {
        let Ok(mut map) = self.connections.lock() else { return };
        if let Some(conn) = map.remove(id) {
            match conn {
                Connection::Ws(tx) | Connection::SocketIo(tx) => {
                    let _ = tx.send(WsCommand::Close);
                }
                Connection::Mqtt(tx) => {
                    let _ = tx.send(MqttCommand::Close);
                }
            }
        }
        if let Ok(mut cancels) = self.cancels.lock() {
            if let Some(tx) = cancels.remove(id) {
                let _ = tx.send(());
            }
        }
    }

    pub fn register_cancel(&self, id: String) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(id, tx);
        }
        rx
    }

    pub fn take_cancel(&self, id: &str) -> Option<oneshot::Sender<()>> {
        self.cancels.lock().ok()?.remove(id)
    }

    pub fn clear_cancel(&self, id: &str) {
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(id);
        }
    }
}

/// The MQTT/WS/Socket.IO senders are cloned out under the lock so the send itself never happens
/// while holding it (a full channel would otherwise deadlock the whole registry).
pub fn with_connection<T>(
    registry: &ApiRegistry,
    id: &str,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let map = registry.connections.lock().map_err(|e| e.to_string())?;
    let conn = map.get(id).ok_or_else(|| format!("No open connection with id {id}"))?;
    f(conn)
}
