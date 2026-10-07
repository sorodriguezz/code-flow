//! The webhook trigger: a small HTTP server on 127.0.0.1, one route per armed webhook node.
//!
//! **Loopback only, on a port that does not move** (47811 unless Settings says otherwise — the
//! confirmed decision): a URL pasted once into the system that calls it keeps working across
//! restarts, and nothing outside this computer can reach it. Started by the first webhook armed,
//! it then stays up for the session.
//!
//! **Authentication is per webhook, and checked before anything runs.** A bearer token, a named
//! header, or an HMAC-SHA256 signature of the raw body (GitHub's and Stripe's habit) — the secret is a
//! flow credential, read from the keychain on each request so rotating it needs no re-arming.
//!
//! **Answering.** Straight away (`202` and the run's id), with the last node's output when the run
//! ends, or with whatever a Respond to webhook node sends — the last two waiting up to a minute.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;
use axum::Router;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use crate::db::{flow_run_queries, Db};
use crate::flows::engine::Reply;
use crate::flows::run::Item;
use crate::flows::spec::FlowNode;

pub const DEFAULT_PORT: u16 = 47811;
const PORT_KEY: &str = "flows_webhook_port";
const MAX_BODY: usize = 16 * 1024 * 1024;
const WAIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
struct Route {
    flow_id: String,
    node_id: String,
    auth: String,
    credential: String,
    signature_header: String,
    respond: String,
    /// Generic HMAC: `sha256` / `sha1` / `sha512`, and `hex` / `base64` for how the signature reads.
    hmac_algorithm: String,
    hmac_encoding: String,
    /// Stripe and Slack sign a timestamp too: a request older (or newer) than this is a replay.
    tolerance_secs: i64,
    /// A header naming each delivery (`X-GitHub-Delivery`, `Idempotency-Key`): a second request
    /// with an id already seen is answered and not run again.
    dedupe_header: String,
    /// The handshake the sender makes before it sends anything (`metaVerify`, `slackChallenge`,
    /// `graphValidation`) — answered here, never run — and Meta's verify token.
    verify: String,
    verify_token: String,
}

/// A «Formulario web» trigger: its page and what it does with a submission.
#[derive(Debug, Clone)]
struct FormRoute {
    flow_id: String,
    node_id: String,
    title: String,
    description: String,
    fields: Vec<crate::flows::form::FormField>,
    submit: String,
    respond: String,
    thanks: String,
    /// A password (a bearer credential's secret), asked by the browser — empty for an open form.
    credential: String,
}

static FORMS: LazyLock<Mutex<HashMap<String, FormRoute>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

static ROUTES: LazyLock<Mutex<HashMap<String, Route>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SERVER: LazyLock<Mutex<Option<(u16, CancellationToken)>>> = LazyLock::new(|| Mutex::new(None));

fn configured_port(app: &AppHandle) -> u16 {
    let stored = app
        .try_state::<Db>()
        .and_then(|db| db.0.lock().ok().and_then(|conn| crate::db::queries::get_setting(&conn, PORT_KEY).ok().flatten()));
    stored.and_then(|text| text.trim().parse::<u16>().ok()).filter(|p| *p >= 1024).unwrap_or(DEFAULT_PORT)
}

fn port_in_use() -> u16 {
    SERVER.lock().ok().and_then(|s| s.as_ref().map(|(port, _)| *port)).unwrap_or(DEFAULT_PORT)
}

pub fn base_url() -> String {
    format!("http://127.0.0.1:{}/hooks/", port_in_use())
}

/// Where a run's "wait for a call" node listens — `/resume/<run>`, plus `/<node name>` when the run
/// has more than one such node waiting at once.
pub fn resume_url(run_id: &str) -> String {
    format!("http://127.0.0.1:{}/resume/{run_id}", port_in_use())
}

fn param(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// The path a webhook listens on: its own, cleaned, or one made from the flow and the node.
fn path_of(flow_id: &str, node: &FlowNode, params: &Value) -> Result<String, String> {
    let raw = param(params, "hookPath");
    let raw = raw.trim_matches('/');
    if raw.is_empty() {
        return Ok(format!("{}/{}", flow_id, node.id));
    }
    if !raw.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/')) || raw.contains("//") {
        return Err(format!("\"{raw}\" is not a usable path: letters, digits, - _ . ~ and /"));
    }
    Ok(raw.to_string())
}

fn key_of(method: &str, path: &str) -> String {
    format!("{} /{}", method.to_uppercase(), path)
}

/// Whether a webhook node could be registered — its path free (or its own) and its auth complete.
pub fn check(flow_id: &str, node: &FlowNode, params: &Value) -> Result<(), String> {
    let path = path_of(flow_id, node, params)?;
    let method = param(params, "method");
    let method = if method.is_empty() { "POST".to_string() } else { method.to_uppercase() };
    let routes = ROUTES.lock().map_err(|e| e.to_string())?;
    for candidate in [key_of(&method, &path), key_of("ANY", &path)] {
        if let Some(route) = routes.get(&candidate) {
            if route.flow_id != flow_id {
                return Err(format!("/hooks/{path} is already taken by another flow"));
            }
        }
    }
    if method == "ANY" {
        for (key, route) in routes.iter() {
            if key.ends_with(&format!(" /{path}")) && route.flow_id != flow_id {
                return Err(format!("/hooks/{path} is already taken by another flow"));
            }
        }
    }
    let auth = param(params, "auth");
    if auth != "none" && !auth.is_empty() && param(params, "credential").is_empty() {
        return Err("choose the credential the caller has to present".into());
    }
    Ok(())
}

/// Registers a webhook node and returns its URL. Starts the server if it is not up.
pub fn register(app: &AppHandle, flow_id: &str, node: &FlowNode, params: &Value) -> Result<String, String> {
    check(flow_id, node, params)?;
    ensure_server(app)?;
    let path = path_of(flow_id, node, params)?;
    let method = param(params, "method");
    let method = if method.is_empty() { "POST".to_string() } else { method.to_uppercase() };
    let route = Route {
        flow_id: flow_id.to_string(),
        node_id: node.id.clone(),
        auth: param(params, "auth"),
        credential: param(params, "credential"),
        signature_header: {
            let header = param(params, "signatureHeader");
            if header.is_empty() { "X-Signature-256".to_string() } else { header }
        },
        respond: param(params, "respond"),
        hmac_algorithm: param(params, "hmacAlgorithm"),
        hmac_encoding: param(params, "hmacEncoding"),
        tolerance_secs: params.get("toleranceSec").and_then(Value::as_i64).filter(|n| *n > 0).unwrap_or(300),
        dedupe_header: param(params, "dedupeHeader"),
        verify: param(params, "verify"),
        verify_token: param(params, "verifyToken"),
    };
    ROUTES.lock().map_err(|e| e.to_string())?.insert(key_of(&method, &path), route);
    Ok(format!("{}{}", base_url(), path))
}

pub fn forget_flow(flow_id: &str) {
    if let Ok(mut routes) = ROUTES.lock() {
        routes.retain(|_, route| route.flow_id != flow_id);
    }
    if let Ok(mut forms) = FORMS.lock() {
        forms.retain(|_, form| form.flow_id != flow_id);
    }
}

/// A form's path, cleaned like a webhook's: letters, digits, `-`, `_` and `/`.
fn form_path(params: &Value, node: &FlowNode) -> Result<String, String> {
    let raw = param(params, "formPath");
    let raw = if raw.is_empty() { node.id.clone() } else { raw };
    let cleaned = raw.trim().trim_matches('/').to_string();
    if cleaned.is_empty() || !cleaned.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/')) {
        return Err(format!("\"{raw}\" is not a form path: use letters, digits, - and /"));
    }
    Ok(cleaned)
}

pub fn check_form(flow_id: &str, node: &FlowNode, params: &Value) -> Result<(), String> {
    let path = form_path(params, node)?;
    if let Some(other) = FORMS.lock().map_err(|e| e.to_string())?.get(&path) {
        if other.flow_id != flow_id {
            return Err(format!("/forms/{path} is already another flow's form"));
        }
    }
    if crate::flows::form::fields_of(params).is_empty() {
        return Err("add at least one field to the form".into());
    }
    if param(params, "formAccess") == "formPassword" && param(params, "credential").is_empty() {
        return Err("choose the credential that holds the form's password".into());
    }
    Ok(())
}

/// Registers a «Formulario web» trigger and returns its URL.
pub fn register_form(app: &AppHandle, flow_id: &str, node: &FlowNode, params: &Value) -> Result<String, String> {
    check_form(flow_id, node, params)?;
    ensure_server(app)?;
    let path = form_path(params, node)?;
    let form = FormRoute {
        flow_id: flow_id.to_string(),
        node_id: node.id.clone(),
        title: { let t = param(params, "formTitle"); if t.is_empty() { node.name.clone() } else { t } },
        description: param(params, "formDescription"),
        fields: crate::flows::form::fields_of(params),
        submit: param(params, "submitLabel"),
        respond: param(params, "respond"),
        thanks: param(params, "thanksMessage"),
        credential: if param(params, "formAccess") == "formPassword" { param(params, "credential") } else { String::new() },
    };
    FORMS.lock().map_err(|e| e.to_string())?.insert(path.clone(), form);
    Ok(form_url(&path))
}

/// A form's address on this computer.
pub fn form_url(path: &str) -> String {
    format!("http://127.0.0.1:{}/forms/{path}", port_in_use())
}

/// Where an approval's buttons are — `/approve/<run>/<node name>`.
pub fn approval_url(run_id: &str, node_name: &str) -> String {
    let encoded: String = percent_encoding::utf8_percent_encode(node_name, percent_encoding::NON_ALPHANUMERIC).to_string();
    format!("http://127.0.0.1:{}/approve/{run_id}/{encoded}", port_in_use())
}

/// The same address through the tunnel, when one is up — what to send to someone elsewhere.
pub fn public_or_local(local: &str) -> String {
    let path = local.splitn(4, '/').nth(3).unwrap_or_default();
    crate::flows::tunnel::public_url(path).unwrap_or_else(|| local.to_string())
}

pub fn shutdown() {
    crate::flows::tunnel::stop();
    if let Ok(mut server) = SERVER.lock() {
        if let Some((_, cancel)) = server.take() {
            cancel.cancel();
        }
    }
}

/// The port the webhook server listens on — what a tunnel forwards to.
pub fn port() -> u16 {
    port_in_use()
}


pub(crate) fn ensure_server(app: &AppHandle) -> Result<(), String> {
    let mut server = SERVER.lock().map_err(|e| e.to_string())?;
    if server.is_some() {
        return Ok(());
    }
    let port = configured_port(app);
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("port {port} for webhooks is not free: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let router = Router::new()
        .fallback(handle)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(app.clone());
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
        let _ = axum::serve(listener, router).with_graceful_shutdown(async move { stop.cancelled().await }).await;
    });
    *server = Some((port, cancel));
    crate::applog::info(&format!("flows: webhooks listening on 127.0.0.1:{port}"));
    drop(server);
    // A tunnel the user turned on comes back with the server it forwards to.
    crate::flows::tunnel::resume(app);
    Ok(())
}

fn html_response(status: StatusCode, html: String) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        // Nothing here is meant to be framed or cached: a decision page seen twice is the same decision.
        .header("cache-control", "no-store")
        .header("x-frame-options", "DENY")
        .body(Body::from(html))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn text_response(status: StatusCode, text: String) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Body::from(text))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// A password-protected form's check: HTTP Basic, any user name, the credential's secret as password.
fn basic_ok(app: &AppHandle, credential: &str, headers: &HeaderMap) -> bool {
    let Ok(Some(secret)) = crate::secrets::get_secret(&crate::secrets::flow_credential_key(credential)) else { return false };
    let given = header_text(headers, "authorization");
    let Some(encoded) = given.strip_prefix("Basic ") else { return false };
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(encoded.trim()) else { return false };
    let text = String::from_utf8_lossy(&decoded).into_owned();
    let password = text.split_once(':').map(|(_, p)| p).unwrap_or_default();
    let _ = app;
    same(password.as_bytes(), secret.as_bytes())
}

/// `/forms/<path>`: the form (GET), or a submission (POST) that runs the flow.
async fn handle_form(app: &AppHandle, path: &str, method: &Method, headers: &HeaderMap, body: &[u8]) -> Response {
    let form = FORMS.lock().ok().and_then(|forms| forms.get(path).cloned());
    let Some(form) = form else {
        return html_response(StatusCode::NOT_FOUND, crate::flows::formpage::gone("Este formulario no está activo"));
    };
    // The webhooks' rule (see `handle`): one with no password was made for this machine, and the
    // tunnel must not make it everybody's.
    if form.credential.is_empty() && through_tunnel(headers) {
        return html_response(StatusCode::UNAUTHORIZED, crate::flows::formpage::gone("Este formulario no tiene contraseña, así que no se abre por el túnel"));
    }
    if !form.credential.is_empty() && !basic_ok(app, &form.credential, headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("www-authenticate", "Basic realm=\"Flujos\", charset=\"UTF-8\"")
            .body(Body::from("Se necesita la contraseña del formulario"))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    if *method != Method::POST {
        return html_response(StatusCode::OK, crate::flows::formpage::form(&form.title, &form.description, &form.fields, &form.submit, None, &Map::new()));
    }
    let values = crate::flows::formpage::submitted(&form.fields, body);
    let typed = match crate::flows::form::coerce(&form.fields, &Value::Object(values.clone())) {
        Ok(typed) => typed,
        Err(problem) => {
            return html_response(StatusCode::BAD_REQUEST, crate::flows::formpage::form(&form.title, &form.description, &form.fields, &form.submit, Some(&problem), &values));
        }
    };
    let mut item = typed;
    if let Value::Object(map) = &mut item {
        map.insert("submittedAt".into(), json!(chrono::Utc::now().to_rfc3339()));
        map.insert("form".into(), json!(path));
    }
    let thanks = || {
        let message = if form.thanks.trim().is_empty() { "Recibimos tus datos.".to_string() } else { form.thanks.clone() };
        html_response(StatusCode::OK, crate::flows::formpage::done("¡Gracias!", &message))
    };
    match form.respond.as_str() {
        "respondNode" => {
            let (tx, rx) = tokio::sync::oneshot::channel::<Reply>();
            match super::fire_with(app, &form.flow_id, &form.node_id, vec![Item::new(item)], Some(tx), false) {
                Ok(fired) if fired.held => html_response(StatusCode::TOO_MANY_REQUESTS, crate::flows::formpage::gone("Hay otro envío en curso: inténtalo en un momento")),
                Ok(_) => match tokio::time::timeout(WAIT, rx).await {
                    Ok(Ok(reply)) => Response::builder()
                        .status(StatusCode::from_u16(reply.status).unwrap_or(StatusCode::OK))
                        .header("content-type", reply.content_type.as_str())
                        .body(Body::from(reply.body))
                        .unwrap_or_else(|_| Response::new(Body::empty())),
                    _ => thanks(),
                },
                Err(error) => html_response(StatusCode::INTERNAL_SERVER_ERROR, crate::flows::formpage::gone(&error)),
            }
        }
        "lastNode" => match super::fire_with(app, &form.flow_id, &form.node_id, vec![Item::new(item)], None, true) {
            Ok(fired) if fired.held => html_response(StatusCode::TOO_MANY_REQUESTS, crate::flows::formpage::gone("Hay otro envío en curso: inténtalo en un momento")),
            Ok(fired) => match fired.done {
                Some(done) => match tokio::time::timeout(WAIT, done).await {
                    Ok(Ok(finished)) if finished.status == "success" => {
                        // The last node's `message` (or `text`) is what the person reads.
                        let said = finished
                            .last_output
                            .first()
                            .and_then(|i| ["message", "text", "answer"].iter().find_map(|k| i.json.get(*k).and_then(Value::as_str).map(str::to_string)));
                        match said {
                            Some(message) => html_response(StatusCode::OK, crate::flows::formpage::done("Listo", &message)),
                            None => thanks(),
                        }
                    }
                    Ok(Ok(finished)) => html_response(StatusCode::INTERNAL_SERVER_ERROR, crate::flows::formpage::gone(&format!("No se pudo procesar: {}", finished.error))),
                    _ => thanks(),
                },
                None => thanks(),
            },
            Err(error) => html_response(StatusCode::INTERNAL_SERVER_ERROR, crate::flows::formpage::gone(&error)),
        },
        // Thanks only for what will run: a submission skipped because the flow was busy is lost,
        // and saying it arrived would be the one lie this page can tell.
        _ => match super::fire(app, &form.flow_id, &form.node_id, vec![Item::new(item)]) {
            Ok(fired) if fired.dropped => html_response(StatusCode::TOO_MANY_REQUESTS, crate::flows::formpage::gone("Hay otro envío en curso: inténtalo en un momento")),
            Ok(_) => thanks(),
            Err(error) => html_response(StatusCode::INTERNAL_SERVER_ERROR, crate::flows::formpage::gone(&error)),
        },
    }
}

/// `/approve/<run>/<node>` and `/form/<run>[/<node>]`: a waiting run's page, and its decision.
fn handle_wait_page(app: &AppHandle, kind: &str, rest: &str, method: &Method, uri: &Uri, body: &[u8]) -> Response {
    let wait = match crate::flows::waits::open_wait_at(app, rest, kind) {
        Ok(wait) => wait,
        Err(_) => {
            return html_response(
                StatusCode::NOT_FOUND,
                crate::flows::formpage::gone(if kind == "approval" { "Esta aprobación ya se decidió o ya no espera" } else { "Este formulario ya se envió o ya no espera" }),
            );
        }
    };
    if kind == "approval" {
        if *method != Method::POST {
            let preselect = uri.query().and_then(|q| url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "d").map(|(_, v)| v.into_owned()));
            return html_response(StatusCode::OK, crate::flows::formpage::approval(&wait.flow_name, &wait.message, preselect.as_deref()));
        }
        let fields: HashMap<String, String> = url::form_urlencoded::parse(body).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let decision = if fields.get("decision").map(String::as_str) == Some("reject") { "rejected" } else { "approved" };
        let comment = fields.get("comment").cloned().unwrap_or_default();
        return match crate::flows::waits::decide(app, &wait.id, decision, "link", Value::String(comment)) {
            Ok(_) => html_response(
                StatusCode::OK,
                crate::flows::formpage::done(if decision == "approved" { "Aprobado" } else { "Rechazado" }, &format!("«{}» sigue con tu respuesta.", wait.flow_name)),
            ),
            Err(error) => html_response(StatusCode::CONFLICT, crate::flows::formpage::gone(&error)),
        };
    }
    // A form: what the wait asked for was kept as its message (`{title, description, fields}`).
    let spec: Value = serde_json::from_str(&wait.message).unwrap_or(Value::Null);
    let fields = crate::flows::form::fields_of(&spec);
    let title = spec.get("title").and_then(Value::as_str).filter(|t| !t.trim().is_empty()).unwrap_or(&wait.flow_name).to_string();
    let description = spec.get("description").and_then(Value::as_str).unwrap_or_default().to_string();
    if *method != Method::POST {
        return html_response(StatusCode::OK, crate::flows::formpage::form(&title, &description, &fields, "Enviar", None, &Map::new()));
    }
    let values = crate::flows::formpage::submitted(&fields, body);
    let typed = match crate::flows::form::coerce(&fields, &Value::Object(values.clone())) {
        Ok(typed) => typed,
        Err(problem) => return html_response(StatusCode::BAD_REQUEST, crate::flows::formpage::form(&title, &description, &fields, "Enviar", Some(&problem), &values)),
    };
    match crate::flows::waits::decide(app, &wait.id, "resumed", "form", typed) {
        Ok(_) => html_response(StatusCode::OK, crate::flows::formpage::done("¡Gracias!", &format!("«{}» sigue con tus datos.", wait.flow_name))),
        Err(error) => html_response(StatusCode::CONFLICT, crate::flows::formpage::gone(&error)),
    }
}

/// A sender's handshake, answered before anything runs: Meta's `hub.challenge` (GET), Slack's
/// `url_verification` (POST, signed like its events) and Microsoft Graph's `validationToken`.
fn verification(route: &Route, method: &Method, uri: &Uri, body: &[u8]) -> Option<Response> {
    let query: HashMap<String, String> = uri.query().map(|q| url::form_urlencoded::parse(q.as_bytes()).into_owned().collect()).unwrap_or_default();
    match route.verify.as_str() {
        "metaVerify" if *method == Method::GET && query.get("hub.mode").map(String::as_str) == Some("subscribe") => {
            let token = query.get("hub.verify_token").cloned().unwrap_or_default();
            if route.verify_token.is_empty() || !same(token.as_bytes(), route.verify_token.as_bytes()) {
                return Some(text_response(StatusCode::FORBIDDEN, "verify token mismatch".into()));
            }
            Some(text_response(StatusCode::OK, query.get("hub.challenge").cloned().unwrap_or_default()))
        }
        "graphValidation" if query.contains_key("validationToken") => Some(text_response(StatusCode::OK, query.get("validationToken").cloned().unwrap_or_default())),
        "slackChallenge" => {
            let doc: Value = serde_json::from_slice(body).ok()?;
            (doc.get("type").and_then(Value::as_str) == Some("url_verification"))
                .then(|| text_response(StatusCode::OK, doc.get("challenge").and_then(Value::as_str).unwrap_or_default().to_string()))
        }
        _ => None,
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Byte comparison whose time does not depend on where the first difference is.
fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default()
}

/// Checks the caller against the route's credential. `Err` is the message the 401 carries.
fn authorise(app: &AppHandle, route: &Route, headers: &HeaderMap, body: &[u8]) -> Result<(), &'static str> {
    if route.auth.is_empty() || route.auth == "none" {
        return Ok(());
    }
    let meta = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|_| "unavailable")?;
        flow_run_queries::get_credential(&conn, &route.credential).ok().flatten().ok_or("misconfigured")?
    };
    let secret = crate::secrets::get_secret(&crate::secrets::flow_credential_key(&route.credential))
        .ok()
        .flatten()
        .ok_or("misconfigured")?;
    match route.auth.as_str() {
        "bearer" => {
            let presented = header_text(headers, "authorization");
            let expected = format!("Bearer {secret}");
            if same(presented.as_bytes(), expected.as_bytes()) { Ok(()) } else { Err("unauthorized") }
        }
        "header" => {
            let name = meta.meta.get("name").and_then(Value::as_str).unwrap_or("X-Webhook-Token");
            if same(header_text(headers, name).as_bytes(), secret.as_bytes()) { Ok(()) } else { Err("unauthorized") }
        }
        "hmac" => {
            let presented = header_text(headers, &route.signature_header).trim();
            // `sha256=…`, `sha1=…`: the prefix some senders put before the digest.
            let presented = presented.split_once('=').filter(|(algo, _)| algo.starts_with("sha")).map_or(presented, |(_, digest)| digest);
            let raw = mac_bytes(&route.hmac_algorithm, secret.as_bytes(), body)?;
            let ok = if route.hmac_encoding == "base64" {
                same(presented.as_bytes(), base64::engine::general_purpose::STANDARD.encode(&raw).as_bytes())
            } else {
                same(presented.to_ascii_lowercase().as_bytes(), hex(&raw).as_bytes())
            };
            if ok { Ok(()) } else { Err("bad signature") }
        }
        // GitHub: `X-Hub-Signature-256: sha256=<hex>` over the body.
        "githubSig" => {
            let presented = header_text(headers, "x-hub-signature-256").trim();
            let presented = presented.strip_prefix("sha256=").unwrap_or(presented).to_ascii_lowercase();
            let expected = hex(&mac_bytes("sha256", secret.as_bytes(), body)?);
            if same(presented.as_bytes(), expected.as_bytes()) { Ok(()) } else { Err("bad signature") }
        }
        // Stripe: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]` over `<t>.<body>`, within the tolerance.
        "stripeSig" => {
            let header = header_text(headers, "stripe-signature");
            let mut stamp: Option<i64> = None;
            let mut signatures = Vec::new();
            for part in header.split(',') {
                match part.trim().split_once('=') {
                    Some(("t", value)) => stamp = value.parse().ok(),
                    Some(("v1", value)) => signatures.push(value.to_ascii_lowercase()),
                    _ => {}
                }
            }
            let stamp = stamp.ok_or("bad signature")?;
            fresh(stamp, route.tolerance_secs)?;
            let mut signed = format!("{stamp}.").into_bytes();
            signed.extend_from_slice(body);
            let expected = hex(&mac_bytes("sha256", secret.as_bytes(), &signed)?);
            if signatures.iter().any(|candidate| same(candidate.as_bytes(), expected.as_bytes())) { Ok(()) } else { Err("bad signature") }
        }
        // Slack: `X-Slack-Signature: v0=<hex>` over `v0:<X-Slack-Request-Timestamp>:<body>`.
        "slackSig" => {
            let stamp: i64 = header_text(headers, "x-slack-request-timestamp").trim().parse().map_err(|_| "bad signature")?;
            fresh(stamp, route.tolerance_secs)?;
            let mut signed = format!("v0:{stamp}:").into_bytes();
            signed.extend_from_slice(body);
            let expected = format!("v0={}", hex(&mac_bytes("sha256", secret.as_bytes(), &signed)?));
            let presented = header_text(headers, "x-slack-signature").trim().to_ascii_lowercase();
            if same(presented.as_bytes(), expected.as_bytes()) { Ok(()) } else { Err("bad signature") }
        }
        // Shopify: `X-Shopify-Hmac-Sha256: <base64>` over the body.
        "shopifySig" => {
            let presented = header_text(headers, "x-shopify-hmac-sha256").trim();
            let expected = base64::engine::general_purpose::STANDARD.encode(mac_bytes("sha256", secret.as_bytes(), body)?);
            if same(presented.as_bytes(), expected.as_bytes()) { Ok(()) } else { Err("bad signature") }
        }
        _ => Err("misconfigured"),
    }
}

/// An HMAC of `body` with `secret`, in the named algorithm (SHA-256 unless told otherwise).
fn mac_bytes(algorithm: &str, secret: &[u8], body: &[u8]) -> Result<Vec<u8>, &'static str> {
    Ok(match algorithm {
        "sha1" => {
            let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret).map_err(|_| "misconfigured")?;
            mac.update(body);
            mac.finalize().into_bytes().to_vec()
        }
        "sha512" => {
            let mut mac = Hmac::<sha2::Sha512>::new_from_slice(secret).map_err(|_| "misconfigured")?;
            mac.update(body);
            mac.finalize().into_bytes().to_vec()
        }
        _ => {
            let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| "misconfigured")?;
            mac.update(body);
            mac.finalize().into_bytes().to_vec()
        }
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A signed timestamp close enough to now — what stops a captured request being sent again later.
fn fresh(stamp: i64, tolerance: i64) -> Result<(), &'static str> {
    let now = chrono::Utc::now().timestamp();
    if (now - stamp).abs() <= tolerance { Ok(()) } else { Err("request too old") }
}

/// Whether a delivery id was seen before on this webhook — remembered in the flow's state (the last
/// 500), so a sender retrying after a restart is still recognised. Records it when it was not.
fn seen_before(app: &AppHandle, route: &Route, id: &str) -> bool {
    const KEEP: usize = 500;
    let db = app.state::<Db>();
    let Ok(conn) = db.0.lock() else { return false };
    let key = format!("hook:{}:delivered", route.node_id);
    let mut list: Vec<Value> = flow_run_queries::state_get(&conn, &route.flow_id, &key).ok().flatten().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    if list.iter().any(|v| v.as_str() == Some(id)) {
        return true;
    }
    list.push(json!(id));
    if list.len() > KEEP {
        let cut = list.len() - KEEP;
        list.drain(..cut);
    }
    let _ = flow_run_queries::state_set(&conn, &route.flow_id, &key, &Value::Array(list), &crate::flows::engine::now_text());
    false
}

/// A request that came in from the internet, through the tunnel — `cloudflared` stamps
/// `Cf-Connecting-Ip` on everything it forwards, Tailscale Funnel `Tailscale-Funnel-Request`.
fn through_tunnel(headers: &HeaderMap) -> bool {
    headers.contains_key("cf-connecting-ip") || headers.contains_key("tailscale-funnel-request")
}

/// The request as the trigger's item.
fn item_of(method: &Method, uri: &Uri, headers: &HeaderMap, body: &Bytes) -> Value {
    let mut header_map = Map::new();
    for (name, value) in headers {
        if let Ok(text) = value.to_str() {
            header_map.insert(name.as_str().to_string(), Value::String(text.to_string()));
        }
    }
    let query: Map<String, Value> = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
        .collect();
    let content_type = header_text(headers, "content-type").to_ascii_lowercase();
    let parsed_body = if body.is_empty() {
        Value::Null
    } else if content_type.contains("json") || matches!(body.first(), Some(b'{') | Some(b'[')) {
        serde_json::from_slice(body).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(body).into_owned()))
    } else if content_type.contains("x-www-form-urlencoded") {
        Value::Object(
            url::form_urlencoded::parse(body)
                .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
                .collect(),
        )
    } else if content_type.contains("multipart/form-data") {
        // An upload form: its fields as text, its files kept as file references.
        let dir = crate::flows::nodes::binary::incoming_dir();
        crate::flows::nodes::binary::prune(&dir, std::time::Duration::from_secs(7 * 24 * 3600));
        match crate::flows::nodes::binary::multipart(body, &content_type, &dir) {
            Some(fields) => Value::Object(fields),
            None => Value::String(String::from_utf8_lossy(body).into_owned()),
        }
    } else {
        match std::str::from_utf8(body) {
            Ok(text) => Value::String(text.to_string()),
            // Bytes: kept as a file for the run to read, not carried as base64.
            Err(_) => {
                let dir = crate::flows::nodes::binary::incoming_dir();
                crate::flows::nodes::binary::prune(&dir, std::time::Duration::from_secs(7 * 24 * 3600));
                let name = crate::flows::nodes::binary::name_for(&header_text(headers, "content-disposition"), "", &content_type);
                match crate::flows::nodes::binary::keep(&dir, body, &name, &content_type) {
                    Ok(file) => json!({"binary": true, "file": file, "mimeType": content_type, "size": body.len()}),
                    Err(_) => json!({"binary": true, "data": base64::engine::general_purpose::STANDARD.encode(body), "mimeType": content_type}),
                }
            }
        }
    };
    json!({
        "method": method.as_str(),
        "path": uri.path(),
        "headers": header_map,
        "query": query,
        "body": parsed_body,
        "receivedAt": chrono::Utc::now().to_rfc3339(),
    })
}

fn reply_of(items: &[Item]) -> Response {
    let value = match items.len() {
        0 => json!({}),
        1 => items[0].json.clone(),
        _ => Value::Array(items.iter().map(|item| item.json.clone()).collect()),
    };
    json_response(StatusCode::OK, value)
}

/// A browser's request from a page that is not on this machine. Any web page the user visits can
/// send a form-encoded POST to 127.0.0.1 — a cross-site request that would run a flow (or submit
/// a form) meant for this machine. A browser always says where such a request comes from; local
/// pages (127.0.0.1, localhost, a `*.localhost` dev server, the app's own webview) are let through,
/// and so is anything without an `Origin`, which is every non-browser sender.
fn foreign_origin(headers: &HeaderMap) -> bool {
    let origin = header_text(headers, "origin").trim();
    if origin.is_empty() {
        return false;
    }
    let host = url::Url::parse(origin).ok().and_then(|url| url.host_str().map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase()));
    !matches!(host.as_deref(), Some(h) if h == "127.0.0.1" || h == "::1" || h == "localhost" || h.ends_with(".localhost"))
}

async fn handle(State(app): State<AppHandle>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    if !through_tunnel(&headers) && foreign_origin(&headers) {
        return json_response(StatusCode::FORBIDDEN, json!({"error": "requests from other sites are not accepted here"}));
    }
    // Flows as tools for AI agents — see `flows::mcp`. Its own bearer token, through a tunnel too.
    if uri.path().trim_end_matches('/') == "/mcp" {
        return crate::flows::mcp::handle(&app, &method, &headers, &body).await;
    }
    if let Some(rest) = uri.path().strip_prefix("/forms/") {
        let path = rest.trim_end_matches('/').to_string();
        return handle_form(&app, &path, &method, &headers, &body).await;
    }
    if let Some(rest) = uri.path().strip_prefix("/approve/") {
        return handle_wait_page(&app, "approval", rest.trim_end_matches('/'), &method, &uri, &body);
    }
    if let Some(rest) = uri.path().strip_prefix("/form/") {
        return handle_wait_page(&app, "form", rest.trim_end_matches('/'), &method, &uri, &body);
    }
    if let Some(rest) = uri.path().strip_prefix("/resume/") {
        let call = item_of(&method, &uri, &headers, &body);
        return match crate::flows::waits::resume_by_call(&app, rest.trim_end_matches('/'), call) {
            Ok(run_id) => json_response(StatusCode::OK, json!({"resumed": true, "runId": run_id})),
            Err(error) if error == "not-waiting" => json_response(StatusCode::NOT_FOUND, json!({"error": "nothing waits for a call here"})),
            Err(error) => json_response(StatusCode::CONFLICT, json!({"error": error})),
        };
    }
    let Some(path) = uri.path().strip_prefix("/hooks/").map(|p| p.trim_end_matches('/').to_string()) else {
        return json_response(StatusCode::NOT_FOUND, json!({"error": "not found"}));
    };
    let route = {
        let routes = ROUTES.lock();
        routes.ok().and_then(|routes| {
            routes
                .get(&key_of(method.as_str(), &path))
                .or_else(|| routes.get(&key_of("ANY", &path)))
                // Meta verifies a POST webhook with a GET: the handshake finds the route anyway.
                .or_else(|| if method == Method::GET { routes.get(&key_of("POST", &path)).filter(|r| r.verify == "metaVerify") } else { None })
                .cloned()
        })
    };
    let Some(route) = route else {
        return json_response(StatusCode::NOT_FOUND, json!({"error": "no active flow listens here"}));
    };
    // Meta's and Graph's handshakes carry no signature; Slack's does, so it waits for the check below.
    if route.verify != "slackChallenge" {
        if let Some(answer) = verification(&route, &method, &uri, &body) {
            return answer;
        }
    } else if method == Method::GET {
        return json_response(StatusCode::METHOD_NOT_ALLOWED, json!({"error": "POST only"}));
    }
    // Open to the internet only with a credential: a webhook that takes none was set up for this
    // machine, and the tunnel must not make it everybody's.
    if through_tunnel(&headers) && (route.auth.is_empty() || route.auth == "none") {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({"error": "this webhook takes no credential, so it is not open through the tunnel"}),
        );
    }
    if let Err(reason) = authorise(&app, &route, &headers, &body) {
        let status = if reason == "misconfigured" || reason == "unavailable" { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::UNAUTHORIZED };
        return json_response(status, json!({"error": reason}));
    }
    if route.verify == "slackChallenge" {
        if let Some(answer) = verification(&route, &method, &uri, &body) {
            return answer;
        }
    }
    if !route.dedupe_header.is_empty() {
        let id = header_text(&headers, &route.dedupe_header.to_ascii_lowercase()).trim().to_string();
        if !id.is_empty() && seen_before(&app, &route, &id) {
            return json_response(StatusCode::OK, json!({"duplicate": true, "id": id}));
        }
    }
    let item = Item::new(item_of(&method, &uri, &headers, &body));
    match route.respond.as_str() {
        "respondNode" => {
            let (tx, rx) = tokio::sync::oneshot::channel::<Reply>();
            match super::fire_with(&app, &route.flow_id, &route.node_id, vec![item], Some(tx), false) {
                Ok(fired) if fired.held => json_response(StatusCode::TOO_MANY_REQUESTS, json!({"error": "busy"})),
                Ok(_) => match tokio::time::timeout(WAIT, rx).await {
                    Ok(Ok(reply)) => {
                        let mut builder = Response::builder()
                            .status(StatusCode::from_u16(reply.status).unwrap_or(StatusCode::OK))
                            .header("content-type", reply.content_type.as_str());
                        for (name, value) in &reply.headers {
                            if let Ok(value) = HeaderValue::from_str(value) {
                                builder = builder.header(name.as_str(), value);
                            }
                        }
                        builder.body(Body::from(reply.body)).unwrap_or_else(|_| Response::new(Body::empty()))
                    }
                    Ok(Err(_)) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": "the flow ended without answering"})),
                    Err(_) => json_response(StatusCode::GATEWAY_TIMEOUT, json!({"error": "the flow did not answer in time"})),
                },
                Err(error) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error})),
            }
        }
        "lastNode" => match super::fire_with(&app, &route.flow_id, &route.node_id, vec![item], None, true) {
            Ok(fired) if fired.held => json_response(StatusCode::TOO_MANY_REQUESTS, json!({"error": "busy"})),
            Ok(fired) => match fired.done {
                Some(done) => match tokio::time::timeout(WAIT, done).await {
                    Ok(Ok(finished)) if finished.status == "success" => reply_of(&finished.last_output),
                    Ok(Ok(finished)) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": finished.error, "status": finished.status})),
                    Ok(Err(_)) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": "the run vanished"})),
                    Err(_) => json_response(StatusCode::GATEWAY_TIMEOUT, json!({"error": "the flow did not finish in time"})),
                },
                None => json_response(StatusCode::ACCEPTED, json!({})),
            },
            Err(error) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error})),
        },
        _ => match super::fire(&app, &route.flow_id, &route.node_id, vec![item]) {
            // Skipped, not queued: the sender should try again rather than count it delivered.
            Ok(fired) if fired.dropped => json_response(StatusCode::TOO_MANY_REQUESTS, json!({"error": "busy"})),
            Ok(fired) if fired.held => json_response(StatusCode::ACCEPTED, json!({"queued": true})),
            Ok(fired) => json_response(StatusCode::ACCEPTED, json!({"runId": fired.run.map(|r| r.id)})),
            Err(error) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error})),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pages_on_this_machine_may_call_from_a_browser() {
        let with = |origin: &str| {
            let mut headers = HeaderMap::new();
            headers.insert("origin", HeaderValue::from_str(origin).unwrap());
            headers
        };
        assert!(!foreign_origin(&HeaderMap::new()), "curl, a server, a CLI: no Origin");
        assert!(!foreign_origin(&with("http://127.0.0.1:47811")));
        assert!(!foreign_origin(&with("http://localhost:3000")));
        assert!(!foreign_origin(&with("http://app.localhost:5173")));
        assert!(!foreign_origin(&with("http://[::1]:8080")));
        assert!(!foreign_origin(&with("tauri://localhost")));
        assert!(foreign_origin(&with("https://example.com")));
        assert!(foreign_origin(&with("http://127.0.0.1.example.com")));
        assert!(foreign_origin(&with("null")), "a sandboxed frame or a file says null");
    }

    #[test]
    fn comparison_is_exact() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"abcd"));
    }

    #[test]
    fn requests_become_items() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        let uri: Uri = "/hooks/pagos?source=test".parse().unwrap();
        let item = item_of(&Method::POST, &uri, &headers, &Bytes::from_static(br#"{"amount": 10}"#));
        assert_eq!(item["body"]["amount"], 10);
        assert_eq!(item["query"]["source"], "test");
        assert_eq!(item["method"], "POST");
    }

    #[test]
    fn paths_are_cleaned_or_refused() {
        let node = FlowNode {
            id: "n1".into(),
            type_id: "trigger.webhook".into(),
            name: "Hook".into(),
            pos: [0.0, 0.0],
            params: json!({}),
            settings: json!({}),
            disabled: false,
        };
        assert_eq!(path_of("f1", &node, &json!({"hookPath": "/pagos/alerta/"})).unwrap(), "pagos/alerta");
        assert_eq!(path_of("f1", &node, &json!({"hookPath": ""})).unwrap(), "f1/n1");
        assert!(path_of("f1", &node, &json!({"hookPath": "a b"})).is_err());
    }
}
