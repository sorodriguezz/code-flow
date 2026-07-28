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
// Transport failure wording
// ---------------------------------------------------------------------------

/// The bottom of an error's `source()` chain.
///
/// Every client here wraps its real failure: reqwest's `Display` is "error sending request",
/// tonic's is "transport error", tungstenite's is "IO error". The sentence that says what
/// actually went wrong — certificate expired, connection refused, name not resolved — is at the
/// end of the chain, so that's what gets shown.
pub fn root_cause(err: &dyn std::error::Error) -> Option<String> {
    let mut deepest = None;
    let mut source = err.source();
    while let Some(current) = source {
        deepest = Some(current.to_string());
        source = current.source();
    }
    deepest
}

/// Rewrites the handful of transport failures users actually hit into a sentence that says what
/// to do about it, shared by every transport so HTTP, gRPC and WebSocket all explain an
/// unreachable host the same way.
///
/// Matching is on substrings of the OS/TLS-stack wording, which differs per platform for the same
/// underlying condition — hence several needles per case. Anything unrecognized returns `None` and
/// keeps its raw text: a message we can't diagnose is more useful in full than paraphrased badly.
pub fn explain_cause(host: &str, port: Option<u16>, cause: &str) -> Option<String> {
    let lower = cause.to_ascii_lowercase();
    let host = if host.is_empty() { "that host" } else { host };
    let matches = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));

    // macOS: "nodename nor servname provided, or not known". Linux: "Name or service not known" /
    // "Temporary failure in name resolution". Windows: "No such host is known. (os error 11001)".
    if matches(&[
        "failed to lookup address information",
        "nodename nor servname",
        "name or service not known",
        "no such host is known",
        "temporary failure in name resolution",
        "dns error",
    ]) {
        return Some(format!(
            "couldn't resolve \"{host}\". Check the URL for a typo, or whether reaching this host needs a VPN or proxy."
        ));
    }

    if matches(&["connection refused"]) {
        let port = port.map(|p| format!(":{p}")).unwrap_or_default();
        return Some(format!(
            "nothing is accepting connections on {host}{port}. Is the server running, and on that port?"
        ));
    }

    if matches(&["connection reset", "connection aborted", "broken pipe"]) {
        return Some(format!("\"{host}\" closed the connection before replying."));
    }

    if matches(&["network is unreachable", "no route to host"]) {
        return Some(format!("no network route to \"{host}\". Check your connection or VPN."));
    }

    // TLS is the one case where the raw cause still earns its place — "expired" and "self-signed"
    // call for different responses from the user, and only the original says which it was.
    if matches(&["certificate", "tls", "ssl", "handshake"]) {
        return Some(format!(
            "the TLS connection to \"{host}\" was rejected: {cause}. If this host uses a self-signed \
             certificate, turn off SSL verification in the request's Settings tab."
        ));
    }

    None
}

/// `explain_cause` applied to an error chain, formatted under `label` (typically `GET https://…`).
/// Falls back to the raw deepest cause, then to the error's own `Display`.
pub fn describe_transport_error(label: &str, host: &str, port: Option<u16>, err: &dyn std::error::Error) -> String {
    match root_cause(err) {
        Some(cause) => match explain_cause(host, port, &cause) {
            Some(explained) => format!("{label} — {explained}"),
            None => format!("{label} failed: {cause}"),
        },
        None => format!("{label} failed: {err}"),
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    /// The same unreachable host, reported four different ways by four operating systems — all of
    /// them have to come out as "couldn't resolve", because a user on any of them is looking at a
    /// typo'd URL or a host their network can't see, not at a bug in the app.
    #[test]
    fn dns_failures_are_explained_the_same_on_every_platform() {
        for raw in [
            "failed to lookup address information: nodename nor servname provided, or not known",
            "failed to lookup address information: Name or service not known",
            "No such host is known. (os error 11001)",
            "Temporary failure in name resolution",
        ] {
            let explained = explain_cause("ocularisd.cl", Some(80), raw)
                .unwrap_or_else(|| panic!("not recognized: {raw}"));
            assert!(explained.contains("couldn't resolve"), "got: {explained}");
            assert!(explained.contains("ocularisd.cl"), "should name the host, got: {explained}");
            assert!(
                !explained.contains("nodename") && !explained.contains("os error"),
                "raw OS wording should be gone, got: {explained}"
            );
        }
    }

    /// A refused connection is a different problem from an unresolvable name, and the port is the
    /// part worth checking — so it has to appear even when the URL never spelled it out.
    #[test]
    fn a_refused_connection_names_the_port() {
        let explained = explain_cause("localhost", Some(8080), "Connection refused (os error 61)").unwrap();
        assert!(explained.contains("localhost:8080"), "got: {explained}");
    }

    /// TLS keeps its original cause: "expired" and "self-signed" call for different responses from
    /// the user, and only the underlying message distinguishes them.
    #[test]
    fn tls_failures_keep_the_underlying_reason() {
        let explained = explain_cause("expired.example.com", Some(443), "certificate has expired").unwrap();
        assert!(explained.contains("certificate has expired"), "got: {explained}");
        assert!(explained.contains("Settings"), "should point at the SSL toggle, got: {explained}");
    }

    /// Anything without a better sentence must fall through, so callers keep printing it verbatim
    /// rather than swallowing a diagnosis we don't actually have.
    #[test]
    fn an_unrecognized_cause_is_left_alone() {
        assert!(explain_cause("example.com", Some(80), "something nobody has seen before").is_none());
    }

    /// The chain walk is the whole reason these messages are reachable: every client wraps the real
    /// failure behind a generic outer error.
    #[test]
    fn root_cause_reaches_the_bottom_of_the_chain() {
        #[derive(Debug)]
        struct Wrapper(Option<Box<Wrapper>>, &'static str);
        impl std::fmt::Display for Wrapper {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.1)
            }
        }
        impl std::error::Error for Wrapper {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.0.as_deref().map(|w| w as &(dyn std::error::Error + 'static))
            }
        }

        let deep = Wrapper(None, "Connection refused (os error 61)");
        let mid = Wrapper(Some(Box::new(deep)), "error trying to connect");
        let outer = Wrapper(Some(Box::new(mid)), "error sending request");
        assert_eq!(root_cause(&outer).as_deref(), Some("Connection refused (os error 61)"));

        let described = describe_transport_error("GET http://x/", "x", Some(80), &outer);
        assert!(described.contains("nothing is accepting connections on x:80"), "got: {described}");
    }
}
