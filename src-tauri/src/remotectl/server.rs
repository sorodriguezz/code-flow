//! The HTTP and WebSocket surface a paired device talks to.
//!
//! # Four routes, and nothing else
//!
//! | route | auth | what it is |
//! |---|---|---|
//! | `GET  /api/hello`  | none    | is this a CodeFlow, and is it accepting a pairing right now |
//! | `POST /api/pair`   | none    | redeem a six-digit code for a device token |
//! | `POST /api/rpc`    | bearer  | run one command from `dispatch.rs` |
//! | `GET  /api/events` | bearer  | the event stream, upgraded to a WebSocket |
//!
//! Everything else is the mobile bundle, served as static files.
//!
//! `/api/hello` and `/api/pair` are unauthenticated because they have to be — a device that has
//! never paired has nothing to present. What keeps that from being a hole is that neither one can
//! *read* anything: `hello` answers a fixed shape with no install detail in it, and `pair` is
//! bounded by the five-guess counter in `auth.rs`.
//!
//! # No CORS layer, deliberately
//!
//! The mobile client is served from this same origin, so same-origin requests need no header and
//! get none. The consequence is the useful one: a random web page the user visits **cannot** reach
//! these routes from their browser, because the browser will not let it. Adding a permissive layer
//! for the convenience of running the mobile UI from a separate Vite dev server would trade that
//! away — so the dev server proxies to this one instead (see `vite.mobile.config.ts`).

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use tower::ServiceBuilder;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use super::auth::{self, Verdict};
use super::{bridge, dispatch, RemoteCtl};
use crate::db::Db;

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
}

/// Binds the port and starts serving, returning once the listener is up.
///
/// Binding is awaited rather than spawned so that "the port is taken" reaches the settings screen
/// as an error on the button the user just pressed, instead of appearing as a server that claims to
/// be on and is not.
pub async fn start(app: &AppHandle, port: u16) -> Result<u16, String> {
    let state = app.state::<RemoteCtl>();
    // Whatever was bound before goes away first. Without this, flipping the toggle twice would
    // leak a listener holding the old port, and the rebind below would fail against ourselves.
    state.stop();

    // `0.0.0.0` and not `127.0.0.1`: reachable from the phone is the entire feature. This is the
    // one line that makes the difference, and it only ever runs because the user turned the
    // setting on — see `remotectl::autostart`.
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("no se pudo abrir el puerto {port}: {e}"))?;

    // The port that was *actually* bound, which is not always the one asked for: port 0 means "let
    // the OS pick", and everything downstream — the status the settings screen shows, the URL in
    // the QR code — has to name the real one or it names a door that does not exist.
    let port = listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(port);

    let ctx = Ctx { app: app.clone() };
    let router = with_static(
        Router::new()
            .route("/api/hello", get(hello))
            .route("/api/pair", post(pair))
            .route("/api/rpc", post(rpc))
            .route("/api/events", get(events)),
    )
    .with_state(ctx);

    let (tx, rx) = oneshot::channel::<()>();
    // Minted here so it belongs to *this* listener and to nothing else. Every socket this server
    // upgrades takes a clone; stopping or rebinding cancels it, and the server that replaces this
    // one gets a fresh token that the old one's cancellation cannot touch.
    let cancel = tokio_util::sync::CancellationToken::new();
    state.set_running(port, tx, cancel);

    tauri::async_runtime::spawn(async move {
        let served = axum::serve(listener, router)
            // Resolves when the sender is dropped — which is what `RemoteCtl::stop` does, and what
            // `set_running` does to a previous server. Either path ends this task.
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
        if let Err(e) = served {
            eprintln!("[remotectl] el servidor terminó con error: {e}");
        }
    });

    Ok(port)
}

// ---------------------------------------------------------------------------
// Static bundle
// ---------------------------------------------------------------------------

/// Where `pnpm build:mobile` puts the client, once Tauri has copied it next to the binary.
///
/// # Why a debug build looks somewhere else first
///
/// Tauri copies `resources/mobile` next to the binary *once*, when the app is compiled. In
/// `pnpm tauri dev` that is a snapshot taken at launch, so every later `vite build --watch` writes
/// into the source tree while the server keeps serving the snapshot — mobile edits reached the
/// phone only after a full restart, which reads as "the client is stale and I cannot tell why".
///
/// So a debug build prefers the source tree's own output directory, and `CODEFLOW_MOBILE_DIR`
/// overrides both for anyone building somewhere unusual. `ServeDir` opens the file per request, so
/// a rebuild lands on the next pull-to-refresh with nothing to restart on either side. Release
/// builds are unaffected: the snapshot is the only copy there, and it is the right one.
fn mobile_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        if let Some(dir) = std::env::var_os("CODEFLOW_MOBILE_DIR") {
            let dir = PathBuf::from(dir);
            if dir.join("index.html").is_file() {
                return Some(dir);
            }
        }
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/mobile");
        if source.join("index.html").is_file() {
            return Some(source);
        }
    }
    crate::paths::resource_dir().map(|dir| dir.join("mobile"))
}

/// A short digest of the entry document, as the client's "am I the build this server is serving"
/// check.
///
/// The entry is the right thing to hash rather than the whole directory: every chunk name inside it
/// is content-addressed by vite, so any change to any module changes a name in this file. Read per
/// call — `/api/hello` is asked on boot and on each socket reopen, not in a loop, and a 2 kB read
/// is cheaper than a cache that could answer with the previous build's id after a rebuild.
fn bundle_id() -> Option<String> {
    let index = mobile_dir()?.join("index.html");
    let bytes = std::fs::read(index).ok()?;
    Some(hex::encode(Sha256::digest(&bytes))[..16].to_string())
}

/// Hangs the mobile bundle off the router's fallback, so anything that is not an `/api` route is
/// served as a file — with `index.html` behind it, so the client's own routing survives a hard
/// refresh on a deep link.
///
/// When the bundle is missing — a dev build that has not run `pnpm build:mobile` yet — every path
/// answers one explanatory page instead of a bare 404. The API routes are registered before this
/// and are unaffected, so a half-built checkout still pairs and still answers RPC; only the UI is
/// absent, and it says so.
fn with_static(router: Router<Ctx>) -> Router<Ctx> {
    let Some(dir) = mobile_dir().filter(|dir| dir.join("index.html").is_file()) else {
        return router.fallback(missing_bundle);
    };
    let index = dir.join("index.html");

    router
        // `/assets` is mounted *before* the SPA fallback and without one of its own, so a hashed
        // chunk that is not on disk answers 404.
        //
        // That is the whole point. Under the single fallback this used to have, a request for a
        // stale `/assets/index-a1b2.js` — a phone holding an old `index.html` after a rebuild — was
        // answered with `index.html` itself, at **200, text/html**. The browser's module loader
        // rejects that on MIME type, React never mounts, and the phone shows a white screen with a
        // console error naming a syntax problem in a file that is really a different file entirely.
        // A 404 is what lets the client notice it is out of date and reload (see `bundle_id`).
        .nest_service(
            "/assets",
            ServiceBuilder::new()
                // Content-hashed names: a chunk that exists is the same bytes forever, so a phone
                // should never ask for it twice.
                .layer(SetResponseHeaderLayer::overriding(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                ))
                .service(ServeDir::new(dir.join("assets"))),
        )
        // Everything else is the shell — the entry document, the manifest, the icon — served with
        // the client's own routing behind it so a hard refresh on a deep link survives. Never
        // cached: this is the file that names the hashed chunks, and a cached copy of it is exactly
        // the stale pointer the 404 above exists to catch.
        .fallback_service(
            ServiceBuilder::new()
                .layer(SetResponseHeaderLayer::overriding(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("no-cache, must-revalidate"),
                ))
                .service(ServeDir::new(dir).fallback(ServeFile::new(index))),
        )
}

async fn missing_bundle() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Html(
            "<!doctype html><meta charset=utf-8><title>CodeFlow</title>\
             <body style=\"font-family:system-ui;padding:2rem;line-height:1.5\">\
             <h1>Falta el bundle móvil</h1>\
             <p>El servidor está funcionando, pero la interfaz no está compilada.</p>\
             <p>Ejecuta <code>pnpm build:mobile</code> y vuelve a cargar.</p>",
        ),
    )
}

// ---------------------------------------------------------------------------
// Auth plumbing
// ---------------------------------------------------------------------------

/// Resolves the bearer on a request to a device id.
///
/// The database guard is taken and dropped entirely inside this function. That is not tidiness: an
/// `axum` handler's future must be `Send`, a `std::sync::MutexGuard` is not, and holding one across
/// the `.await` in [`rpc`] would fail to compile in a way whose error message points somewhere
/// else entirely.
fn device_from_bearer(ctx: &Ctx, token: &str) -> Option<(String, String)> {
    let db = ctx.app.state::<Db>();
    let state = ctx.app.state::<RemoteCtl>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => e.into_inner(),
    };
    match auth::verify(&conn, &state.pairing, token) {
        // The name travels with the id because the desktop's notification centre says *who* did
        // something — "iPhone de Sebastián · commit" rather than a UUID. Read on the same
        // connection the verification already holds, so it costs no extra lock.
        Verdict::Device(id) => {
            let name = auth::device_name(&conn, &id);
            Some((id, name))
        }
        Verdict::Rejected => None,
    }
}

/// The workspace a chain belongs to, for the invalidation the call is about to raise.
///
/// Synchronous for the same reason [`device_from_bearer`] is: the database guard is taken and
/// dropped entirely inside this call, so it can never be held across the `.await` in [`rpc`].
///
/// A chain whose row is gone answers `None` rather than an error — this is one field of a
/// notification, and a chain that was just deleted is a perfectly ordinary thing for a caller to
/// have named.
fn workspace_of_chain(ctx: &Ctx, chain_id: &str) -> Option<String> {
    let db = ctx.app.state::<Db>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => e.into_inner(),
    };
    crate::db::queries::workspace_of_chain(&conn, chain_id).ok().flatten()
}

fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .trim()
}

/// One shape for every refusal.
///
/// Says nothing about *why*. "No such command" and "not your token" are the same response to a
/// client that should not be asking either way, and telling a prober which of the two it hit is
/// free reconnaissance.
fn refused() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "ok": false, "error": "unauthorized" }))).into_response()
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Hello {
    app: &'static str,
    /// Whether a pairing code is on screen right now, so the phone can say "abre Ajustes →
    /// Control remoto" instead of showing a code box that cannot succeed.
    pairing: bool,
    /// Which build of the mobile client this server is serving. See [`bundle_id`].
    ///
    /// A digest of the entry document and not a version number: the thing that has to be detected
    /// is "the files on disk changed under a phone that is still running the old ones", which
    /// happens constantly in development and once per app update in the field, and neither bumps a
    /// version. `null` when the bundle is missing, which the client treats as "nothing to compare".
    bundle: Option<String>,
}

/// Deliberately carries no hostname, no workspace names and no device count. It exists to answer
/// "am I pointed at the right thing, and am I running the right client", and anything more would be
/// a detail handed to whoever scanned the port.
///
/// The bundle digest is not such a detail: it is derived from files this same server hands to
/// anybody who asks for `/`, so it tells an unauthenticated caller nothing they could not compute
/// themselves.
async fn hello(State(ctx): State<Ctx>) -> impl IntoResponse {
    let state = ctx.app.state::<RemoteCtl>();
    Json(Hello {
        app: "codeflow",
        pairing: state.pairing.is_open(),
        bundle: bundle_id(),
    })
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    #[serde(default)]
    name: String,
}

async fn pair(State(ctx): State<Ctx>, Json(body): Json<PairRequest>) -> Response {
    let db = ctx.app.state::<Db>();
    let state = ctx.app.state::<RemoteCtl>();
    let result = {
        let conn = match db.0.lock() {
            Ok(c) => c,
            Err(e) => e.into_inner(),
        };
        auth::pair(&conn, &state.pairing, &body.code, &body.name)
    };

    match result {
        Ok(paired) => Json(json!({
            "ok": true,
            "deviceId": paired.device_id,
            "token": paired.token,
        }))
        .into_response(),
        // A wrong code and an expired one are the same answer, for the same reason `refused` gives
        // one shape: a client walking the space learns nothing from the difference.
        Err(_) => refused(),
    }
}

#[derive(Deserialize)]
struct RpcRequest {
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn rpc(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<RpcRequest>) -> Response {
    let Some((device_id, device_name)) = device_from_bearer(&ctx, bearer(&headers)) else {
        return refused();
    };

    // Read straight off the request rather than threaded back out of the dispatcher: the argument
    // is right here, every command that has a project takes it under this one name, and the
    // alternative is a third return value on twenty arms that do not care.
    let arg = |camel: &str, snake: &str| {
        body.args
            .get(camel)
            .or_else(|| body.args.get(snake))
            .and_then(Value::as_str)
    };
    // One closure because both outcomes of the call emit now, and everything but the two arguments
    // below is identical between them.
    let announce = |inv, failed| {
        let chain = arg("chainId", "chain_id");
        // Looked up rather than read off the request, because no chain command takes a workspace: a
        // chain reaches one through its first repository. One indexed row, and only for the calls
        // that actually moved a chain — `get_chain_detail` is read-only and never gets here with
        // `Invalidate::Chains`.
        let workspace = match inv {
            dispatch::Invalidate::Chains => chain.and_then(|id| workspace_of_chain(&ctx, id)),
            _ => None,
        };
        bridge::emit_invalidation(
            &ctx.app,
            inv,
            dispatch::announce_for(&body.cmd),
            &device_id,
            &device_name,
            bridge::Subject {
                project: arg("projectId", "project_id"),
                job: arg("jobId", "job_id"),
                conversation: arg("conversationId", "conversation_id"),
                chain,
                workspace: workspace.as_deref(),
            },
            failed,
        )
    };

    match dispatch::dispatch(&ctx.app, &device_id, &body.cmd, &body.args).await {
        // After the command, never before: a failed commit must not tell the desktop to redraw as
        // though something changed — nor announce that it happened.
        Ok((value, inv)) => {
            announce(inv, false);
            Json(json!({ "ok": true, "value": value })).into_response()
        }
        // **403, and emphatically not the 401 `refused()` gives.**
        //
        // These used to be the same response, on the reasoning that a prober learns nothing from
        // the difference. The reasoning was right about the prober and wrong about everyone else:
        // the caller here has *already presented a valid device token*, so it is not a prober, and
        // the client cannot distinguish "this command is switched off" from "you have been
        // revoked". It resolved that the only way it could — by deleting its own token — so the
        // default configuration unpaired every phone at startup, because discovering whether
        // terminals are allowed meant calling a terminal command and being refused.
        //
        // The allowlist is compiled into the client this same server ships anyway. There is no map
        // here that a holder of a device token does not already have.
        Err(dispatch::DispatchError::NotAllowed) => (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": "not_allowed" })),
        )
            .into_response(),
        Err(dispatch::DispatchError::BadArgs(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": msg })),
        )
            .into_response(),
        // The only error text that travels: this is the same message the desktop would put in a
        // toast for the same action, so it is already something the user is meant to read.
        Err(dispatch::DispatchError::Failed { message, invalidate }) => {
            // **A failure can be as durable as a success**, and the emit used to live only in the
            // `Ok` arm above. `analyze_working_changes` and `review_pull_request` each write a
            // `job_history` row carrying the engine's error, so the desktop's history is stale
            // either way — and without this the phone reported a failure while the desk showed
            // nothing at all, which is indistinguishable from the request never having arrived.
            if !wrote_nothing(&message) {
                announce(invalidate, true);
            }
            Json(json!({ "ok": false, "error": message })).into_response()
        }
    }
}

/// Whether a failure message names one of the two outcomes that file no row.
///
/// Both are sentinel prefixes rather than real errors — the app's own way of saying "this did not
/// run" through a channel that only carries strings. A cancelled run is the user's own stop, and a
/// busy repository means the turn never started because somebody else holds the lease. Neither
/// writes to `job_history`, so announcing them would raise a notification whose target job does not
/// exist: a row in the notification centre that does nothing when tapped, which is the same "it
/// says it happened and nothing happens" this whole batch is about, in a smaller shape.
fn wrote_nothing(message: &str) -> bool {
    message.starts_with(crate::ai_runs::CANCELLED_MARKER)
        || message.starts_with(crate::ai_locks::BUSY_MARKER)
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    token: String,
}

/// The event stream.
///
/// # Why the token is in the query string
///
/// A browser's `WebSocket` constructor cannot set an `Authorization` header — the only channel it
/// offers is the subprotocol list, and threading a bearer through that means the server echoing
/// back a value derived from the secret. The query string is the ordinary alternative, and here it
/// costs nothing extra: the whole conversation is already plaintext HTTP on a local network, so a
/// token in the URL is exposed to precisely the same observer as a token in a header. The usual
/// objection — that URLs end up in proxy and server logs — does not apply to a server that keeps
/// none.
///
/// It is worth revisiting the day this grows TLS or a cloud relay, where the URL genuinely does
/// travel further than the body.
async fn events(
    State(ctx): State<Ctx>,
    Query(query): Query<EventsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    // The id is *kept* now, where this used to check `.is_none()` and throw it away. A stream with
    // no identity is one that cannot be revoked, cannot be counted, and cannot be told apart from
    // the phone in the next room — every symptom in this handler's history comes from that line.
    let Some((device_id, _)) = device_from_bearer(&ctx, query.token.trim()) else {
        return refused();
    };

    let state = ctx.app.state::<RemoteCtl>();
    // No listener bound means no cancellation handle to hand this socket, and a socket nobody can
    // sever is precisely what must not be created. Reachable in one narrow window — a request
    // already in flight on a connection the previous server accepted, arriving after `stop()`.
    //
    // **503 and emphatically not `refused()`**: 401 is the client's signal to delete its own token
    // (see `NotAllowed` in `transport.ts`), and "the server is off for a moment" is not a
    // revocation. A 503 leaves the pairing intact and the client's backoff in charge.
    let Some(cancel) = state.cancel_token() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false, "error": "stopped" })))
            .into_response();
    };
    let rx = state.events.subscribe();
    let control = state.control();
    let app = ctx.app.clone();
    ws.on_upgrade(move |socket| pump(app, device_id, socket, rx, control, cancel))
}

/// How often an idle socket is checked, in both directions.
///
/// 25 s is under the 30–60 s at which consumer NAT and mobile carriers drop an idle TCP flow, so
/// the tick doubles as the keepalive that stops the connection being reaped mid-nap.
const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(25);

/// Unanswered pings before the socket is treated as dead.
///
/// Two rather than one: a phone that missed a single tick has usually just had its radio parked,
/// and tearing the socket down for that would mean a reconnect (and a resync) every time somebody
/// puts their phone face-down on a table.
const MAX_MISSED_PONGS: u32 = 2;

/// The close code for "this device is no longer paired".
///
/// In the 4000–4999 range, which the WebSocket spec reserves for the application and which is the
/// only part of a close frame a browser reliably hands to `onclose`. The client keys on this exact
/// number to distinguish a revocation — stop, show the pairing screen — from an ordinary drop,
/// which must keep retrying. See `transport.ts`.
const CLOSE_REVOKED: u16 = 4401;

/// The heartbeat the *client* watches, sent alongside the protocol-level `Ping`.
///
/// Two keepalives rather than one, because they detect opposite failures and neither substitutes
/// for the other. `Ping`/`Pong` proves the phone is alive to this process. But a browser never
/// surfaces a pong to JavaScript — the WebSocket API has no such event — so the client cannot use
/// it to notice a *half-open* flow, where the desktop has gone away and nothing arrives while the
/// socket still reads `OPEN`. This frame is what it measures its silence against; a client that
/// does not know the event name ignores it, as it ignores any frame it has no arm for.
const HEARTBEAT: &str = r#"{"event":"state:heartbeat","payload":null}"#;

/// Whether this device's row is still live, by id.
///
/// No token is presented and none is retained — the socket authenticated once, at upgrade, and the
/// only question left is whether the row it resolved to has since been revoked. That makes
/// revocation take effect on a stream that may not issue another RPC for hours, and it makes any
/// *future* revocation path (a script editing the database, a sync from somewhere else) work
/// without a restart, because nothing here is cached.
///
/// Not `async`, and that is load-bearing: the guard is taken and dropped inside one synchronous
/// call, so it is never held across an `.await`. See [`device_from_bearer`] for what that would
/// otherwise cost.
fn still_paired(app: &AppHandle, device_id: &str) -> bool {
    use rusqlite::OptionalExtension as _;
    let db = app.state::<Db>();
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => e.into_inner(),
    };
    // **Only a query that succeeded and found nothing may cut the socket.**
    //
    // `.unwrap_or(None)` collapsed "the read failed" into "this device is revoked", and the
    // consequence of that answer is not a retry: it closes with 4401, which the client is required
    // to treat as final, so it deletes its token. A `SQLITE_BUSY` on a machine where something else
    // touched the file, or a poisoned-then-recovered connection, would therefore permanently unpair
    // a device nobody revoked — the exact "se revoca en el teléfono pero en la app sigue vigente"
    // shape this whole feature was repaired to remove, rebuilt on a different path.
    //
    // A failed read simply skips this tick. Revocation is not on a deadline here: the next tick is
    // 25 seconds away, and `verify` refuses every RPC in the meantime regardless.
    match conn
        .query_row(
            "SELECT 1 FROM remote_devices WHERE id = ?1 AND revoked = 0",
            rusqlite::params![device_id],
            |_| Ok(()),
        )
        .optional()
    {
        Ok(found) => found.is_some(),
        Err(_) => true,
    }
}

/// Says why the stream is ending, in the one case the client must not answer with a retry.
async fn close_revoked(socket: &mut WebSocket) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: CLOSE_REVOKED,
            reason: Utf8Bytes::from_static("auth:revoked"),
        })))
        .await;
}

/// Forwards broadcast frames to one socket until either end goes away — or until this device is
/// revoked, the server stops, or the phone stops answering.
///
/// # Why this task needs an identity and a way out
///
/// It used to hold nothing but a `broadcast::Receiver`, spawned detached inside `on_upgrade`, and
/// every consequence followed from that. Revoking a device left its stream running, because nothing
/// here knew which device it was. Turning the server off left it running too, because
/// `with_graceful_shutdown` ends a *listener* and this connection was already upgraded past it — the
/// panel said `Detenido` while frames kept arriving. And a NAT that quietly dropped the flow left
/// both ends believing in a socket that no longer existed, so the phone showed `connected` over
/// frozen data indefinitely.
///
/// A phone that fell behind (screen locked mid-run) is still told so rather than silently handed a
/// hole in the stream: `state:resync` is the client's cue to refetch the screen it is on, which is
/// the only honest recovery — the frames it missed are gone.
async fn pump(
    app: AppHandle,
    device_id: String,
    mut socket: WebSocket,
    mut rx: tokio::sync::broadcast::Receiver<super::Fanout>,
    mut control: tokio::sync::broadcast::Receiver<super::Control>,
    cancel: tokio_util::sync::CancellationToken,
) {
    // Held for the life of the task, so every `return` below — and the task being dropped outright
    // at shutdown — releases the desktop's "this phone is connected" count.
    let _live = super::DeviceConnection::open(&app, &device_id);

    let mut ping = tokio::time::interval(PING_INTERVAL);
    // A tick missed while the machine was asleep must not turn into a burst of pings against a
    // socket that has one thing to prove.
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // `interval` fires its first tick immediately; consumed here so a freshly opened socket is not
    // pinged before it has drawn anything.
    ping.tick().await;
    let mut missed: u32 = 0;

    loop {
        tokio::select! {
            frame = rx.recv() => match frame {
                Ok(super::Fanout { text, only }) => {
                    // Somebody else's frame. The fan-out is one channel every socket reads, so a
                    // frame that belongs to a single device — a pty's output — reaches this task too
                    // and is dropped here. Filtering at the socket rather than at the client because
                    // the client is exactly the party that must not be handed the bytes: see
                    // `Fanout`.
                    if only.is_some_and(|id| id != device_id) {
                        continue;
                    }
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let notice = r#"{"event":"state:resync","payload":null}"#;
                    if socket.send(Message::Text(notice.into())).await.is_err() {
                        return;
                    }
                }
                // The sender lives as long as the process, so this is unreachable in practice —
                // but treating it as "stop" is the only sane reading if it ever happens.
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            },
            // The server going away, or moving to another port. Told to the phone as a revocation
            // close code would be *wrong* here — this is not about the credential — so the socket
            // simply closes and the client's backoff takes over.
            () = cancel.cancelled() => return,
            order = control.recv() => match order {
                Ok(super::Control::RevokedAll) => {
                    close_revoked(&mut socket).await;
                    return;
                }
                // Somebody else's revocation. Ignored, deliberately: cutting every phone off
                // because one was revoked is the bug the id in this arm exists to prevent.
                Ok(super::Control::Revoked(id)) => {
                    if id == device_id {
                        close_revoked(&mut socket).await;
                        return;
                    }
                }
                // A notice was dropped while this task was busy sending. The channel cannot say
                // which, so the database is asked instead — the same question, from the source.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if !still_paired(&app, &device_id) {
                        close_revoked(&mut socket).await;
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            },
            _ = ping.tick() => {
                // Two ticks with nothing coming back. The flow is gone even though the socket still
                // looks open on this side, which is exactly the state that used to persist until
                // the process exited.
                if missed >= MAX_MISSED_PONGS {
                    return;
                }
                if !still_paired(&app, &device_id) {
                    close_revoked(&mut socket).await;
                    return;
                }
                missed += 1;
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    return;
                }
                if socket.send(Message::Text(HEARTBEAT.into())).await.is_err() {
                    return;
                }
            }
            // Reading is what ends the task promptly on a close frame instead of on the next event,
            // which could be minutes away on an idle install — and it is also the only place a
            // `Pong` can be observed, which is the whole liveness check above.
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(Message::Pong(_))) => missed = 0,
                // Nothing else the client sends is acted on: this is a one-way stream.
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two failures that leave nothing behind, and the many that do.
    ///
    /// Getting this wrong is not cosmetic in either direction: announcing a cancelled run raises a
    /// notification whose target job was never written, and *not* announcing a real engine error
    /// leaves the desktop showing no trace of a review the phone reported as failed.
    #[test]
    fn only_the_two_outcomes_that_write_nothing_are_suppressed() {
        assert!(wrote_nothing(&format!("{}run-1", crate::ai_runs::CANCELLED_MARKER)));
        assert!(wrote_nothing(&format!("{}mi-repo", crate::ai_locks::BUSY_MARKER)));

        assert!(!wrote_nothing("no se pudo abrir el repositorio"));
        // A message that merely *mentions* a marker is a real failure whose text happens to quote
        // one — the check is on the prefix for that reason.
        assert!(!wrote_nothing(&format!(
            "el motor falló: {}",
            crate::ai_runs::CANCELLED_MARKER
        )));
    }
}
