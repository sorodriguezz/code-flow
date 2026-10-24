//! The API client's mock server: one small HTTP/1.1 listener per collection, answering from rules
//! the collection's «Mock» panel keeps (user, 2026-10-23: «Servidor de mocks: en API, dentro de
//! cada colección, con un botón «Levantar mock»»).
//!
//! **The routes arrive compiled.** Turning saved requests, saved examples and an OpenAPI document
//! into routes happens on the frontend, which already owns the importer and the example model; this
//! side only matches, picks a variant, renders a few placeholders and answers. So the config the
//! panel saves is exactly what is served, and a mock can start with no webview at all — from the
//! Services dock, or on a launch.
//!
//! **Its own little HTTP/1.1 reader instead of axum.** The panel offers "drop the connection" as a
//! failure to simulate, and a framework that owns the socket can only ever answer — the closest it
//! gets is a body that errors after the status line has gone out, which a client reports as a
//! different failure. A mock serves a developer's own calls, so keep-alive, `Content-Length` and
//! chunked request bodies are the whole of what it has to understand.
//!
//! **No orphan listeners.** Every server sits in [`REGISTRY`], keyed by collection; stopping one
//! cancels its accept loop and aborts every connection task, which drops the socket there and then.
//! [`shutdown`] is called from `shutdown.rs`, so a quit leaves nothing bound either.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

/// The event fired whenever a mock starts or stops; the payload is the collection id.
pub const CHANGED_EVENT: &str = "api-mock:changed";
/// One per request served; the payload is [`LogEvent`].
pub const LOG_EVENT: &str = "api-mock:log";

/// How many calls a mock remembers. A mock left running under a test suite answers thousands; the
/// log is for reading the last few, not for an audit.
pub const LOG_CAP: usize = 500;
const MAX_HEAD: usize = 64 * 1024;
const MAX_HEADERS: usize = 128;
const MAX_BODY: usize = 16 * 1024 * 1024;
/// What the log keeps of a request body — enough to read a JSON payload, not a file upload.
const LOG_BODY_CAP: usize = 64 * 1024;
const IDLE: Duration = Duration::from_secs(30);
const MAX_DELAY_MS: u64 = 60_000;

// ---------------------------------------------------------------------------
// Config — the JSON the panel saves (`api_mocks.config`), mirrored in `src/lib/api/mock.ts`
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MockConfig {
    /// `0` picks a free port on every start.
    pub port: u16,
    /// Bind `0.0.0.0` instead of loopback — opt-in, and the panel says what it means.
    pub expose_lan: bool,
    /// Answer preflights and add `Access-Control-Allow-Origin` to every response.
    pub cors: bool,
    /// Started along with the workspace's services (the Services dock's group start).
    pub with_services: bool,
    pub routes: Vec<MockRoute>,
}

impl Default for MockConfig {
    fn default() -> Self {
        Self { port: 0, expose_lan: false, cors: true, with_services: false, routes: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MockRoute {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    /// An HTTP method, or `*` for any.
    pub method: String,
    /// `/users/:id`, `/users/{id}` and `/users/{{id}}` all name a segment; a final `*` takes the
    /// rest of the path. A full URL or a leading `{{baseUrl}}` is reduced to its path.
    pub path: String,
    /// `request` · `openapi` · `manual` · `log` — where the route came from, for the panel.
    pub source: String,
    pub request_id: Option<String>,
    pub delay_min_ms: u64,
    pub delay_max_ms: u64,
    /// `none` · `status` (answer `error_status`) · `drop` (close the connection, no answer).
    pub error_mode: String,
    pub error_status: u16,
    /// 0..=1.
    pub error_rate: f64,
    pub variants: Vec<MockVariant>,
}

impl Default for MockRoute {
    fn default() -> Self {
        Self {
            id: String::new(),
            enabled: true,
            name: String::new(),
            method: "GET".into(),
            path: "/".into(),
            source: "manual".into(),
            request_id: None,
            delay_min_ms: 0,
            delay_max_ms: 0,
            error_mode: "none".into(),
            error_status: 500,
            error_rate: 0.0,
            variants: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MockVariant {
    pub id: String,
    pub name: String,
    /// `always` · `query` · `header` · `body` (a dotted path into a JSON body).
    pub match_kind: String,
    pub match_key: String,
    pub match_value: String,
    pub status: u16,
    pub headers: Vec<MockHeader>,
    pub body: String,
}

impl Default for MockVariant {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            match_kind: "always".into(),
            match_key: String::new(),
            match_value: String::new(),
            status: 200,
            headers: Vec::new(),
            body: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MockHeader {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

impl Default for MockHeader {
    fn default() -> Self {
        Self { key: String::new(), value: String::new(), enabled: true }
    }
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub seq: u64,
    /// Unix milliseconds.
    pub at: i64,
    pub method: String,
    pub path: String,
    pub query: String,
    pub route_id: Option<String>,
    pub route_name: Option<String>,
    pub variant_name: Option<String>,
    /// `0` for a connection the route's failure dropped.
    pub status: u16,
    pub latency_ms: u64,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub body_truncated: bool,
    pub remote: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub collection_id: String,
    pub entry: LogEntry,
}

type Notify = Box<dyn Fn(&LogEntry) + Send + Sync>;

/// What a running server reads on every request. The config is swapped in place on save, so a
/// rule edited in the panel is served on the next call without a restart.
pub struct Shared {
    config: RwLock<MockConfig>,
    log: Mutex<VecDeque<LogEntry>>,
    seq: AtomicU64,
    notify: Option<Notify>,
}

impl Shared {
    pub fn new(config: MockConfig, notify: Option<Notify>) -> Arc<Self> {
        Arc::new(Self { config: RwLock::new(config), log: Mutex::new(VecDeque::new()), seq: AtomicU64::new(0), notify })
    }

    pub fn set_config(&self, config: MockConfig) {
        *self.config.write().unwrap_or_else(|p| p.into_inner()) = config;
    }

    fn config(&self) -> MockConfig {
        self.config.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn log(&self) -> Vec<LogEntry> {
        self.log.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect()
    }

    pub fn clear_log(&self) {
        self.log.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    fn record(&self, mut entry: LogEntry) {
        entry.seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(notify) = &self.notify {
            notify(&entry);
        }
        let mut log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        log.push_back(entry);
        while log.len() > LOG_CAP {
            log.pop_front();
        }
    }
}

/// A running mock, as the panel and the Services dock list it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockStatus {
    pub collection_id: String,
    pub workspace_id: String,
    pub name: String,
    pub port: u16,
    pub host: String,
    pub url: String,
    /// Unix milliseconds.
    pub started_at: i64,
}

struct Running {
    status: MockStatus,
    shared: Arc<Shared>,
    cancel: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
}

static REGISTRY: LazyLock<Mutex<HashMap<String, Running>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn registry() -> std::sync::MutexGuard<'static, HashMap<String, Running>> {
    REGISTRY.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Binds and starts the mock for `collection_id`. A second start of a running mock restarts it, so
/// a changed port or bind address takes effect.
pub async fn start(
    collection_id: &str,
    workspace_id: &str,
    name: &str,
    config: MockConfig,
    notify: Option<Notify>,
) -> Result<MockStatus, String> {
    stop(collection_id).await;
    let host = if config.expose_lan { "0.0.0.0" } else { "127.0.0.1" };
    let listener = TcpListener::bind((host, config.port))
        .await
        .map_err(|e| format!("could not listen on {host}:{}: {e}", config.port))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let shared = Shared::new(config, notify);
    let cancel = CancellationToken::new();
    let task = tauri::async_runtime::spawn(serve(listener, shared.clone(), cancel.clone()));
    // The URL a caller pastes: loopback even when the bind is every interface, since that is the
    // one that always works from this machine.
    let status = MockStatus {
        collection_id: collection_id.to_string(),
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        port,
        host: host.to_string(),
        url: format!("http://127.0.0.1:{port}"),
        started_at: epoch_ms(),
    };
    registry().insert(collection_id.to_string(), Running { status: status.clone(), shared, cancel, task });
    Ok(status)
}

/// Stops one mock and waits until its socket is closed. `false` when it was not running.
pub async fn stop(collection_id: &str) -> bool {
    let Some(running) = registry().remove(collection_id) else { return false };
    running.cancel.cancel();
    // The accept loop drops the listener and aborts its connections as soon as it sees the
    // cancel; the timeout only guards against a task that never got scheduled again.
    let mut task = running.task;
    if tokio::time::timeout(Duration::from_secs(2), &mut task).await.is_err() {
        task.abort();
    }
    true
}

/// Every running mock.
pub fn list() -> Vec<MockStatus> {
    let mut all: Vec<MockStatus> = registry().values().map(|r| r.status.clone()).collect();
    all.sort_by_key(|s| s.started_at);
    all
}

pub fn status(collection_id: &str) -> Option<MockStatus> {
    registry().get(collection_id).map(|r| r.status.clone())
}

/// The new rules for a running mock, served from the next request on. `false` when not running.
pub fn update_config(collection_id: &str, config: MockConfig) -> bool {
    match registry().get(collection_id) {
        Some(running) => {
            running.shared.set_config(config);
            true
        }
        None => false,
    }
}

pub fn log_of(collection_id: &str) -> Vec<LogEntry> {
    registry().get(collection_id).map(|r| r.shared.log()).unwrap_or_default()
}

pub fn clear_log(collection_id: &str) {
    if let Some(running) = registry().get(collection_id) {
        running.shared.clear_log();
    }
}

/// On the way out (`shutdown.rs`): every mock cancelled and its tasks aborted. Synchronous —
/// cancelling and aborting close the sockets on the runtime's next turn, and the process ending
/// closes whatever is left; nothing here needs awaiting to be safe.
pub fn shutdown() {
    let all: Vec<Running> = registry().drain().map(|(_, r)| r).collect();
    for running in all {
        running.cancel.cancel();
        running.task.abort();
    }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/// The accept loop. Returns once `cancel` fires, with the listener dropped and every connection
/// task aborted — which is what "stop frees the port" rests on.
pub async fn serve(listener: TcpListener, shared: Arc<Shared>, cancel: CancellationToken) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let shared = shared.clone();
                connections.spawn(async move { handle_connection(stream, peer, shared).await });
                while connections.try_join_next().is_some() {}
            }
        }
    }
    drop(listener);
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

/// One parsed request.
#[derive(Debug, Clone, Default)]
pub struct Incoming {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Incoming {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    fn query_param(&self, name: &str) -> Option<String> {
        self.query.split('&').filter(|p| !p.is_empty()).find_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_query(k) == name).then(|| decode_query(v))
        })
    }

    fn json_body(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

/// What the router decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Respond { status: u16, headers: Vec<(String, String)>, body: Vec<u8> },
    Drop,
}

async fn handle_connection(stream: TcpStream, peer: SocketAddr, shared: Arc<Shared>) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    loop {
        let request = match tokio::time::timeout(IDLE, read_request(&mut reader, &mut write)).await {
            Ok(Ok(Some(request))) => request,
            Ok(Err(status)) => {
                let _ = write_response(&mut write, status, &[], b"", false, false).await;
                return;
            }
            _ => return,
        };
        let started = Instant::now();
        let keep_alive = wants_keep_alive(&request.0, &request.1);
        let incoming = request.1;
        let config = shared.config();
        let decision = route(&config, &incoming);
        if decision.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(decision.delay_ms)).await;
        }
        let status = match &decision.outcome {
            Outcome::Respond { status, .. } => *status,
            Outcome::Drop => 0,
        };
        let (body_text, truncated) = log_body(&incoming.body);
        shared.record(LogEntry {
            seq: 0,
            at: epoch_ms(),
            method: incoming.method.clone(),
            path: incoming.path.clone(),
            query: incoming.query.clone(),
            route_id: decision.route_id.clone(),
            route_name: decision.route_name.clone(),
            variant_name: decision.variant_name.clone(),
            status,
            latency_ms: started.elapsed().as_millis() as u64,
            headers: incoming.headers.clone(),
            body: body_text,
            body_truncated: truncated,
            remote: peer.to_string(),
        });
        match decision.outcome {
            Outcome::Drop => return,
            Outcome::Respond { status, headers, body } => {
                let head_only = incoming.method.eq_ignore_ascii_case("HEAD");
                if write_response(&mut write, status, &headers, &body, keep_alive, head_only).await.is_err() || !keep_alive {
                    let _ = write.shutdown().await;
                    return;
                }
            }
        }
    }
}

fn log_body(body: &[u8]) -> (String, bool) {
    let truncated = body.len() > LOG_BODY_CAP;
    let slice = &body[..body.len().min(LOG_BODY_CAP)];
    (String::from_utf8_lossy(slice).into_owned(), truncated)
}

fn wants_keep_alive(version: &str, incoming: &Incoming) -> bool {
    let connection = incoming.header("connection").unwrap_or("").to_ascii_lowercase();
    if version == "HTTP/1.0" {
        connection.contains("keep-alive")
    } else {
        !connection.contains("close")
    }
}

/// Reads one request. `Ok(None)` is a clean end of the connection; `Err(status)` a request this
/// server will not read, answered with that status and the connection closed.
async fn read_request<R, W>(reader: &mut BufReader<R>, write: &mut W) -> Result<Option<(String, Incoming)>, u16>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut line = String::new();
    let mut head_bytes = 0usize;
    // Tolerate the stray CRLF some clients leave between keep-alive requests.
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await.map_err(|_| 400u16)?;
        if n == 0 {
            return Ok(None);
        }
        head_bytes += n;
        if !line.trim().is_empty() {
            break;
        }
        if head_bytes > MAX_HEAD {
            return Err(431);
        }
    }
    let mut parts = line.trim_end().splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let version = parts.next().unwrap_or("HTTP/1.1").to_string();
    if method.is_empty() || target.is_empty() {
        return Err(400);
    }

    let mut headers = Vec::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await.map_err(|_| 400u16)?;
        if n == 0 {
            return Err(400);
        }
        head_bytes += n;
        if head_bytes > MAX_HEAD || headers.len() > MAX_HEADERS {
            return Err(431);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }

    let mut incoming = Incoming { method, headers, ..Default::default() };
    // The target is normally origin-form (`/a?b`); a proxy-style absolute URL is reduced to it.
    let origin_form = match target.find("://") {
        Some(i) => target[i + 3..].find('/').map(|j| target[i + 3 + j..].to_string()).unwrap_or_else(|| "/".into()),
        None => target,
    };
    let (path, query) = origin_form.split_once('?').unwrap_or((origin_form.as_str(), ""));
    incoming.path = if path.is_empty() { "/".into() } else { path.to_string() };
    incoming.query = query.split('#').next().unwrap_or("").to_string();

    if incoming.header("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")) {
        let _ = write.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await;
    }
    let chunked = incoming.header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        incoming.body = read_chunked(reader).await?;
    } else if let Some(length) = incoming.header("content-length") {
        let length: usize = length.trim().parse().map_err(|_| 400u16)?;
        if length > MAX_BODY {
            return Err(413);
        }
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).await.map_err(|_| 400u16)?;
        incoming.body = body;
    }
    Ok(Some((version, incoming)))
}

async fn read_chunked<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<Vec<u8>, u16> {
    let mut body = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        reader.read_line(&mut line).await.map_err(|_| 400u16)?;
        let size_text = line.trim().split(';').next().unwrap_or("");
        let size = usize::from_str_radix(size_text, 16).map_err(|_| 400u16)?;
        if size == 0 {
            // Trailers, then the blank line that ends them.
            loop {
                line.clear();
                let n = reader.read_line(&mut line).await.map_err(|_| 400u16)?;
                if n == 0 || line.trim().is_empty() {
                    return Ok(body);
                }
            }
        }
        if body.len() + size > MAX_BODY {
            return Err(413);
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader.read_exact(&mut body[start..]).await.map_err(|_| 400u16)?;
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf).await.map_err(|_| 400u16)?;
    }
}

async fn write_response<W: tokio::io::AsyncWrite + Unpin>(
    write: &mut W,
    status: u16,
    headers: &[(String, String)],
    body: &[u8],
    keep_alive: bool,
    head_only: bool,
) -> std::io::Result<()> {
    let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (k, v) in headers {
        // Framing is this server's to state; a header copied from a saved response would lie.
        let lower = k.to_ascii_lowercase();
        if matches!(lower.as_str(), "content-length" | "transfer-encoding" | "connection" | "content-encoding") {
            continue;
        }
        // A header value cannot carry a line break; one would split the response.
        let v = v.replace(['\r', '\n'], " ");
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str(&format!("Content-Length: {}\r\n", body.len()));
    out.push_str(if keep_alive { "Connection: keep-alive\r\n" } else { "Connection: close\r\n" });
    out.push_str("\r\n");
    // One write for head and body, so a small answer leaves in one segment.
    let mut bytes = out.into_bytes();
    if !head_only {
        bytes.extend_from_slice(body);
    }
    write.write_all(&bytes).await?;
    write.flush().await
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// Routing — pure, so the tests can drive it without a socket
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub outcome: Outcome,
    pub delay_ms: u64,
    pub route_id: Option<String>,
    pub route_name: Option<String>,
    pub variant_name: Option<String>,
}

const PREFLIGHT_METHODS: &str = "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS";

pub fn route(config: &MockConfig, request: &Incoming) -> Decision {
    let origin = request.header("origin").map(str::to_string);
    let cors_headers = |headers: &mut Vec<(String, String)>| {
        if config.cors && !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("access-control-allow-origin")) {
            headers.push(("Access-Control-Allow-Origin".into(), origin.clone().unwrap_or_else(|| "*".into())));
            if origin.is_some() {
                headers.push(("Vary".into(), "Origin".into()));
            }
        }
    };

    if config.cors && request.method.eq_ignore_ascii_case("OPTIONS") && request.header("access-control-request-method").is_some() {
        let mut headers = vec![
            ("Access-Control-Allow-Methods".into(), PREFLIGHT_METHODS.into()),
            (
                "Access-Control-Allow-Headers".into(),
                request.header("access-control-request-headers").unwrap_or("*").to_string(),
            ),
            ("Access-Control-Allow-Credentials".into(), "true".into()),
            ("Access-Control-Max-Age".into(), "600".into()),
        ];
        cors_headers(&mut headers);
        return Decision {
            outcome: Outcome::Respond { status: 204, headers, body: Vec::new() },
            delay_ms: 0,
            route_id: None,
            route_name: None,
            // A marker, not copy: the panel names it in the user's language.
            variant_name: Some("cors-preflight".into()),
        };
    }

    let Some((route, params)) = find_route(config, &request.method, &request.path) else {
        let body = serde_json::json!({ "error": "no mock route", "method": request.method, "path": request.path });
        let mut headers = vec![("Content-Type".into(), "application/json".into())];
        cors_headers(&mut headers);
        return Decision {
            outcome: Outcome::Respond { status: 404, headers, body: body.to_string().into_bytes() },
            delay_ms: 0,
            route_id: None,
            route_name: None,
            variant_name: None,
        };
    };

    let delay_ms = pick_delay(route.delay_min_ms, route.delay_max_ms);
    let base = Decision {
        outcome: Outcome::Drop,
        delay_ms,
        route_id: Some(route.id.clone()),
        route_name: Some(if route.name.is_empty() { format!("{} {}", route.method, route.path) } else { route.name.clone() }),
        variant_name: None,
    };

    if route.error_mode != "none" && route.error_rate > 0.0 && rand::random::<f64>() < route.error_rate.min(1.0) {
        if route.error_mode == "drop" {
            return Decision { variant_name: Some("drop".into()), ..base };
        }
        let mut headers = vec![("Content-Type".into(), "application/json".into())];
        cors_headers(&mut headers);
        let status = if (100..=599).contains(&route.error_status) { route.error_status } else { 500 };
        return Decision {
            outcome: Outcome::Respond {
                status,
                headers,
                body: serde_json::json!({ "error": "simulated failure" }).to_string().into_bytes(),
            },
            variant_name: Some("error".into()),
            ..base
        };
    }

    let ctx = TemplateCtx { request, params: &params };
    let Some(variant) = pick_variant(&route.variants, request) else {
        let mut headers = Vec::new();
        cors_headers(&mut headers);
        return Decision { outcome: Outcome::Respond { status: 200, headers, body: Vec::new() }, ..base };
    };
    let body = render(&variant.body, &ctx);
    let mut headers: Vec<(String, String)> = variant
        .headers
        .iter()
        .filter(|h| h.enabled && !h.key.trim().is_empty())
        .map(|h| (h.key.trim().to_string(), render(&h.value, &ctx)))
        .collect();
    if !body.is_empty() && !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
        let trimmed = body.trim_start();
        let kind = if trimmed.starts_with('{') || trimmed.starts_with('[') { "application/json" } else { "text/plain; charset=utf-8" };
        headers.push(("Content-Type".into(), kind.into()));
    }
    cors_headers(&mut headers);
    let status = if (100..=599).contains(&variant.status) { variant.status } else { 200 };
    Decision {
        outcome: Outcome::Respond { status, headers, body: body.into_bytes() },
        variant_name: Some(if variant.name.is_empty() { variant.status.to_string() } else { variant.name.clone() }),
        ..base
    }
}

fn pick_delay(min: u64, max: u64) -> u64 {
    let min = min.min(MAX_DELAY_MS);
    let max = max.min(MAX_DELAY_MS);
    if max > min {
        rand::random_range(min..=max)
    } else {
        min
    }
}

/// First variant whose condition holds; the last one when none does — the panel puts the default
/// at the bottom.
fn pick_variant<'a>(variants: &'a [MockVariant], request: &Incoming) -> Option<&'a MockVariant> {
    let body = std::cell::OnceCell::new();
    variants
        .iter()
        .find(|v| match v.match_kind.as_str() {
            "query" => request.query_param(v.match_key.trim()).is_some_and(|q| q == v.match_value),
            "header" => request.header(v.match_key.trim()).is_some_and(|h| h == v.match_value),
            "body" => body
                .get_or_init(|| request.json_body())
                .as_ref()
                .and_then(|json| json_at(json, v.match_key.trim()))
                .is_some_and(|found| value_text(found) == v.match_value),
            _ => true,
        })
        .or_else(|| variants.last())
}

fn json_at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let path = path.trim_start_matches("$.").trim_start_matches('$');
    path.split('.').filter(|s| !s.is_empty()).try_fold(value, |current, key| match current {
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)),
        Value::Object(map) => map.get(key),
        _ => None,
    })
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// One path template, reduced to segments.
#[derive(Debug, PartialEq)]
enum Segment {
    Literal(String),
    Param(String),
    Rest,
}

/// The path part of whatever the route was given: a full URL loses its origin, a leading
/// `{{baseUrl}}` loses itself, and the query string goes.
pub fn normalize_path(raw: &str) -> String {
    let mut s = raw.trim();
    if let Some(i) = s.find("://") {
        s = s[i + 3..].find('/').map(|j| &s[i + 3 + j..]).unwrap_or("/");
    } else if s.starts_with("{{") {
        if let Some(end) = s.find("}}") {
            let rest = &s[end + 2..];
            if rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') {
                s = rest;
            }
        }
    }
    let s = s.split(['?', '#']).next().unwrap_or("");
    let s = s.trim_end_matches('/');
    if s.is_empty() {
        "/".into()
    } else if s.starts_with('/') {
        s.to_string()
    } else {
        format!("/{s}")
    }
}

fn compile(path: &str) -> Vec<Segment> {
    normalize_path(path)
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|seg| {
            if seg == "*" || seg == "**" {
                Segment::Rest
            } else if let Some(name) = seg.strip_prefix(':') {
                Segment::Param(name.to_string())
            } else if seg.starts_with("{{") && seg.ends_with("}}") && seg.len() > 4 {
                Segment::Param(seg[2..seg.len() - 2].trim().to_string())
            } else if seg.starts_with('{') && seg.ends_with('}') && seg.len() > 2 {
                Segment::Param(seg[1..seg.len() - 1].trim().to_string())
            } else {
                Segment::Literal(decode(seg))
            }
        })
        .collect()
}

/// The params a template captured from `path`, or `None` when it does not match. The score counts
/// literal segments, so `/users/me` beats `/users/:id` whatever their order in the list.
fn match_path(template: &[Segment], path: &str) -> Option<(usize, HashMap<String, String>)> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let mut params = HashMap::new();
    let mut score = 0;
    for (i, part) in template.iter().enumerate() {
        match part {
            Segment::Rest => return Some((score, params)),
            Segment::Literal(lit) => {
                if segments.get(i).map(|s| decode(s)) != Some(lit.clone()) {
                    return None;
                }
                score += 2;
            }
            Segment::Param(name) => {
                let value = segments.get(i)?;
                params.insert(name.clone(), decode(value));
                score += 1;
            }
        }
    }
    (segments.len() == template.len()).then_some((score, params))
}

fn find_route<'a>(config: &'a MockConfig, method: &str, path: &str) -> Option<(&'a MockRoute, HashMap<String, String>)> {
    let mut best: Option<(usize, &MockRoute, HashMap<String, String>)> = None;
    for route in config.routes.iter().filter(|r| r.enabled) {
        let any = route.method.trim() == "*" || route.method.trim().is_empty();
        if !any && !route.method.trim().eq_ignore_ascii_case(method) {
            // A HEAD is answered by the GET route, headers only.
            if !(method.eq_ignore_ascii_case("HEAD") && route.method.trim().eq_ignore_ascii_case("GET")) {
                continue;
            }
        }
        let Some((score, params)) = match_path(&compile(&route.path), path) else { continue };
        // An exact method outranks `*` on the same path.
        let score = score * 2 + usize::from(!any);
        if best.as_ref().is_none_or(|(s, _, _)| score > *s) {
            best = Some((score, route, params));
        }
    }
    best.map(|(_, route, params)| (route, params))
}

fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

/// A query component, where `+` is a space (form encoding) as well as `%20`.
fn decode_query(s: &str) -> String {
    decode(&s.replace('+', " "))
}

// ---------------------------------------------------------------------------
// Templating — kept to the handful the panel's hint lists
// ---------------------------------------------------------------------------

struct TemplateCtx<'a> {
    request: &'a Incoming,
    params: &'a HashMap<String, String>,
}

/// Replaces `{{request.path.x}}`, `{{request.query.x}}`, `{{request.header.x}}`,
/// `{{request.body.a.b}}`, `{{request.method}}`, `{{uuid}}`, `{{now}}`, `{{timestamp}}` and
/// `{{randomInt a b}}`. Anything else is left exactly as written, so a body that happens to hold
/// `{{` (a template of the caller's own) is served untouched.
fn render(text: &str, ctx: &TemplateCtx) -> String {
    if !text.contains("{{") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let expr = after[..end].trim();
        match eval(expr, ctx) {
            Some(value) => out.push_str(&value),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn eval(expr: &str, ctx: &TemplateCtx) -> Option<String> {
    let mut words = expr.split_whitespace();
    let head = words.next()?;
    match head {
        "uuid" => Some(uuid::Uuid::new_v4().to_string()),
        "now" => Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        "timestamp" => Some(epoch_ms().to_string()),
        "randomInt" => {
            let a: i64 = words.next().and_then(|w| w.parse().ok()).unwrap_or(0);
            let b: i64 = words.next().and_then(|w| w.parse().ok()).unwrap_or(100);
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            Some(rand::random_range(lo..=hi).to_string())
        }
        "request.method" => Some(ctx.request.method.clone()),
        "request.path" => Some(ctx.request.path.clone()),
        _ => {
            if let Some(name) = head.strip_prefix("request.path.") {
                return Some(ctx.params.get(name).cloned().unwrap_or_default());
            }
            if let Some(name) = head.strip_prefix("request.query.") {
                return Some(ctx.request.query_param(name).unwrap_or_default());
            }
            if let Some(name) = head.strip_prefix("request.header.") {
                return Some(ctx.request.header(name).unwrap_or("").to_string());
            }
            if let Some(path) = head.strip_prefix("request.body.") {
                return Some(ctx.request.json_body().as_ref().and_then(|j| json_at(j, path)).map(value_text).unwrap_or_default());
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variant(name: &str, kind: &str, key: &str, value: &str, status: u16, body: &str) -> MockVariant {
        MockVariant {
            id: name.into(),
            name: name.into(),
            match_kind: kind.into(),
            match_key: key.into(),
            match_value: value.into(),
            status,
            headers: vec![],
            body: body.into(),
        }
    }

    fn sample_config() -> MockConfig {
        MockConfig {
            routes: vec![
                MockRoute {
                    id: "r-user".into(),
                    name: "User".into(),
                    method: "GET".into(),
                    path: "{{baseUrl}}/users/:id".into(),
                    variants: vec![
                        variant("admin", "query", "role", "admin", 200, r#"{"id":"{{request.path.id}}","role":"admin"}"#),
                        variant("missing", "header", "Prefer", "code=404", 404, r#"{"error":"nope"}"#),
                        variant("default", "always", "", "", 200, r#"{"id":"{{request.path.id}}","q":"{{request.query.x}}","h":"{{request.header.x-trace}}"}"#),
                    ],
                    ..Default::default()
                },
                MockRoute {
                    id: "r-me".into(),
                    method: "GET".into(),
                    path: "/users/me".into(),
                    variants: vec![variant("me", "always", "", "", 200, "me")],
                    ..Default::default()
                },
                MockRoute {
                    id: "r-post".into(),
                    method: "POST".into(),
                    path: "https://api.example.com/orders/{orderId}".into(),
                    variants: vec![
                        variant("express", "body", "shipping.kind", "express", 201, r#"{"n":{{randomInt 5 5}},"u":"{{uuid}}"}"#),
                        variant("default", "always", "", "", 202, "queued"),
                    ],
                    ..Default::default()
                },
                MockRoute {
                    id: "r-off".into(),
                    enabled: false,
                    method: "*".into(),
                    path: "/off".into(),
                    ..Default::default()
                },
                MockRoute {
                    id: "r-drop".into(),
                    method: "GET".into(),
                    path: "/flaky".into(),
                    error_mode: "drop".into(),
                    error_rate: 1.0,
                    ..Default::default()
                },
                MockRoute {
                    id: "r-fail".into(),
                    method: "GET".into(),
                    path: "/broken".into(),
                    error_mode: "status".into(),
                    error_status: 503,
                    error_rate: 1.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    fn req(method: &str, path: &str, query: &str) -> Incoming {
        Incoming { method: method.into(), path: path.into(), query: query.into(), ..Default::default() }
    }

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize_path("{{baseUrl}}/a/b?x=1"), "/a/b");
        assert_eq!(normalize_path("https://h.example.com:8080/v1/x/"), "/v1/x");
        assert_eq!(normalize_path("https://h.example.com"), "/");
        assert_eq!(normalize_path("users/:id"), "/users/:id");
        assert_eq!(normalize_path("{{host}}"), "/");
    }

    #[test]
    fn matches_templates_and_prefers_literals() {
        let config = sample_config();
        let (route, params) = find_route(&config, "GET", "/users/42").unwrap();
        assert_eq!(route.id, "r-user");
        assert_eq!(params["id"], "42");
        assert_eq!(find_route(&config, "GET", "/users/me").unwrap().0.id, "r-me");
        assert_eq!(find_route(&config, "POST", "/orders/7").unwrap().0.id, "r-post");
        assert!(find_route(&config, "DELETE", "/users/42").is_none());
        assert!(find_route(&config, "GET", "/off").is_none(), "disabled routes are skipped");
        assert_eq!(find_route(&config, "HEAD", "/users/1").unwrap().0.id, "r-user");
        let rest = compile("/files/*");
        assert!(match_path(&rest, "/files/a/b/c").is_some());
    }

    #[test]
    fn renders_placeholders_and_leaves_unknown_ones() {
        let mut request = req("GET", "/u", "x=a%20b");
        request.headers.push(("X-Trace".into(), "t1".into()));
        request.body = br#"{"a":{"b":[1,2]}}"#.to_vec();
        let params = HashMap::from([("id".to_string(), "9".to_string())]);
        let ctx = TemplateCtx { request: &request, params: &params };
        assert_eq!(render("{{request.path.id}}-{{request.query.x}}-{{request.header.x-trace}}", &ctx), "9-a b-t1");
        assert_eq!(render("{{request.body.a.b.1}}", &ctx), "2");
        assert_eq!(render("{{ randomInt 3 3 }}", &ctx), "3");
        assert_eq!(render("{{unknown}} {{", &ctx), "{{unknown}} {{");
        assert_eq!(render("{{uuid}}", &ctx).len(), 36);
        assert!(render("{{now}}", &ctx).ends_with('Z'));
    }

    #[test]
    fn config_reads_with_missing_fields() {
        let config: MockConfig = serde_json::from_str(r#"{"routes":[{"path":"/x"}]}"#).unwrap();
        assert!(config.cors);
        assert_eq!(config.routes[0].method, "GET");
        assert!(config.routes[0].enabled);
    }

    /// Sends raw bytes and reads until the server closes or `Content-Length` is satisfied.
    async fn send(port: u16, raw: &str) -> Option<(u16, String, String)> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.ok()?.ok()?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                    .unwrap_or(0);
                if body.len() >= length {
                    break;
                }
            }
        }
        if buf.is_empty() {
            return None;
        }
        let text = String::from_utf8_lossy(&buf).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let status = head.split(' ').nth(1).unwrap().parse().unwrap();
        Some((status, head.to_string(), body.to_string()))
    }

    #[tokio::test]
    async fn serves_over_tcp_and_frees_the_port_on_stop() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared = Shared::new(sample_config(), None);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(serve(listener, shared.clone(), cancel.clone()));

        // Route matching + templating (path, query, header).
        let (status, head, body) =
            send(port, "GET /users/42?x=hi HTTP/1.1\r\nHost: x\r\nX-Trace: abc\r\nConnection: close\r\n\r\n").await.unwrap();
        assert_eq!(status, 200);
        assert!(head.contains("Content-Type: application/json"), "{head}");
        assert_eq!(body, r#"{"id":"42","q":"hi","h":"abc"}"#);

        // Conditional variants: query, header.
        let (_, _, body) = send(port, "GET /users/7?role=admin HTTP/1.1\r\nConnection: close\r\n\r\n").await.unwrap();
        assert_eq!(body, r#"{"id":"7","role":"admin"}"#);
        let (status, _, _) = send(port, "GET /users/7 HTTP/1.1\r\nPrefer: code=404\r\nConnection: close\r\n\r\n").await.unwrap();
        assert_eq!(status, 404);

        // JSON body field, sent chunked; and the fallback to the last variant.
        let json = r#"{"shipping":{"kind":"express"}}"#;
        let chunked = format!(
            "POST /orders/1 HTTP/1.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{json}\r\n0\r\n\r\n",
            json.len()
        );
        let (status, _, body) = send(port, &chunked).await.unwrap();
        assert_eq!(status, 201);
        assert!(body.starts_with(r#"{"n":5,"u":""#), "{body}");
        let (status, _, body) =
            send(port, "POST /orders/1 HTTP/1.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        assert_eq!((status, body.as_str()), (202, "queued"));

        // CORS preflight.
        let (status, head, _) = send(
            port,
            "OPTIONS /users/1 HTTP/1.1\r\nOrigin: http://localhost:5173\r\nAccess-Control-Request-Method: PUT\r\nAccess-Control-Request-Headers: content-type\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        assert_eq!(status, 204);
        assert!(head.contains("Access-Control-Allow-Origin: http://localhost:5173"), "{head}");
        assert!(head.contains("Access-Control-Allow-Headers: content-type"), "{head}");

        // No route → 404 JSON naming the call.
        let (status, _, body) = send(port, "DELETE /nowhere HTTP/1.1\r\nConnection: close\r\n\r\n").await.unwrap();
        assert_eq!(status, 404);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["error"], "no mock route");
        assert_eq!(parsed["method"], "DELETE");
        assert_eq!(parsed["path"], "/nowhere");

        // Simulated failures: a status, and a dropped connection.
        assert_eq!(send(port, "GET /broken HTTP/1.1\r\nConnection: close\r\n\r\n").await.unwrap().0, 503);
        assert!(send(port, "GET /flaky HTTP/1.1\r\n\r\n").await.is_none(), "dropped without a byte");

        // Keep-alive: two requests on one connection.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(b"GET /users/me HTTP/1.1\r\n\r\nGET /users/me HTTP/1.1\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut all = String::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut all)).await.unwrap().unwrap();
        assert_eq!(all.matches("HTTP/1.1 200 OK").count(), 2, "{all}");

        // The log saw every call, newest last, with the route it matched.
        let log = shared.log();
        assert_eq!(log.len(), 11);
        assert_eq!(log[0].route_id.as_deref(), Some("r-user"));
        assert_eq!(log[6].route_id, None);
        assert_eq!(log[6].status, 404);
        assert_eq!(log[8].status, 0);

        // Stop: the accept loop ends and the port can be bound again.
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
        let again = TcpListener::bind(("127.0.0.1", port)).await;
        assert!(again.is_ok(), "port {port} still held after stop");
    }

    #[tokio::test]
    async fn stop_closes_an_idle_keep_alive_connection() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = CancellationToken::new();
        let task = tokio::spawn(serve(listener, Shared::new(sample_config(), None), cancel.clone()));
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(b"GET /users/me HTTP/1.1\r\n\r\n").await.unwrap();
        let mut chunk = [0u8; 1024];
        let mut seen = Vec::new();
        while !seen.ends_with(b"\r\n\r\nme") {
            let n = stream.read(&mut chunk).await.unwrap();
            assert!(n > 0, "closed before the answer");
            seen.extend_from_slice(&chunk[..n]);
        }
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
        // The connection task was aborted, so the client sees the end of the stream.
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.unwrap().unwrap_or(0);
        assert_eq!(n, 0);
        // Through Tokio, as `start` binds: it sets SO_REUSEADDR on Unix, so the aborted connection's
        // TIME_WAIT does not hold the port the way a bare `std` bind would see it.
        assert!(TcpListener::bind(("127.0.0.1", port)).await.is_ok());
    }

    #[test]
    fn log_is_capped() {
        let shared = Shared::new(MockConfig::default(), None);
        for _ in 0..(LOG_CAP + 20) {
            shared.record(LogEntry {
                seq: 0,
                at: 0,
                method: "GET".into(),
                path: "/".into(),
                query: String::new(),
                route_id: None,
                route_name: None,
                variant_name: None,
                status: 404,
                latency_ms: 0,
                headers: vec![],
                body: String::new(),
                body_truncated: false,
                remote: String::new(),
            });
        }
        let log = shared.log();
        assert_eq!(log.len(), LOG_CAP);
        assert_eq!(log[0].seq, 21);
    }
}
