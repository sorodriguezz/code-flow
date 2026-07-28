//! Socket.IO transport, framed by hand on top of a plain WebSocket.
//!
//! There is no Socket.IO client crate here on purpose: the two wire formats involved are a dozen
//! lines each, and pulling in a client would mean adopting its own reconnect/backoff/ack state
//! machine — none of which an API console wants, because the whole point is to show the user what
//! the socket actually did rather than paper over it.
//!
//! Two layers are stacked in every text frame:
//!
//! ```text
//! 4        2       /chat,   ["message",{"a":1}]
//! ^        ^       ^        ^
//! Engine.IO|       |        Socket.IO payload (event name first)
//!          Socket.IO type   namespace, omitted for the root one
//! ```
//!
//! Engine.IO types are `0` OPEN, `1` CLOSE, `2` PING, `3` PONG, `4` MESSAGE; Socket.IO types are
//! `0` CONNECT, `1` DISCONNECT, `2` EVENT, `3` ACK, `4` CONNECT_ERROR, `5`/`6` the binary variants.
//! The encode/decode half of that lives in pure functions at the bottom of the file, with tests —
//! it is the part most likely to be subtly wrong and the cheapest to pin down.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::Interval;
use tokio_tungstenite::tungstenite::protocol::Message;
use url::Url;

use super::ws::{self, WsStream};
use super::{
    with_connection, ApiRegistry, Connection, SocketIoConnectRequest, StreamMessage, WsCommand,
};

const CONNECT: u8 = 0;
const DISCONNECT: u8 = 1;
const EVENT: u8 = 2;
const ACK: u8 = 3;
const CONNECT_ERROR: u8 = 4;
const BINARY_EVENT: u8 = 5;
const BINARY_ACK: u8 = 6;

type Writer = SplitSink<WsStream, Message>;

/// The bits of the connect request the pump still needs once the socket is up.
struct Session {
    namespace: String,
    /// Socket.IO 3/4 (Engine.IO v4). `false` is Socket.IO 2, which differs in both the handshake
    /// auth payload and the direction of the heartbeat.
    v4: bool,
    auth_json: String,
}

pub async fn connect(
    app: AppHandle,
    id: String,
    req: SocketIoConnectRequest,
) -> Result<(), String> {
    let (tx, rx) = mpsc::unbounded_channel::<WsCommand>();
    // Registered before anything can fail, so an `emit` racing the handshake queues instead of
    // being told there is no such connection.
    app.state::<ApiRegistry>()
        .insert(id.clone(), Connection::SocketIo(tx));
    ws::emit_status(&app, &id, "connecting", req.url.clone());

    let session = Session {
        namespace: req.namespace.clone(),
        v4: req.version.trim() != "v3",
        auth_json: req.auth_json.clone(),
    };

    let stream = match open(&req, session.v4).await {
        Ok(stream) => stream,
        Err(e) => {
            ws::fail(&app, &id, &e);
            return Err(e);
        }
    };

    // No `open` status yet: the transport is up but the Socket.IO session is not, and an emit sent
    // before the server's CONNECT acknowledgement is dropped on the floor. `open` is emitted from
    // the pump when that acknowledgement lands.
    ws::emit_message(
        &app,
        StreamMessage::new(&id, "system", "", "websocket upgraded"),
    );
    tokio::spawn(pump(app, id, stream, rx, session));
    Ok(())
}

pub fn emit(
    registry: &ApiRegistry,
    id: &str,
    event: &str,
    payload_json: &str,
) -> Result<(), String> {
    let args = event_args(event, payload_json)?;
    let tx = with_connection(registry, id, |conn| match conn {
        Connection::SocketIo(tx) => Ok(tx.clone()),
        Connection::Ws(_) => Err(format!(
            "Connection {id} is a plain WebSocket — it has no Socket.IO events"
        )),
        Connection::Mqtt(_) => Err(format!("Connection {id} is an MQTT connection")),
    })?;
    // The channel carries only the argument array: the namespace lives in the pump task, so the
    // writer is what completes the `42{ns},` framing.
    tx.send(WsCommand::Text(args))
        .map_err(|_| format!("Connection {id} is closed"))
}

async fn open(req: &SocketIoConnectRequest, v4: bool) -> Result<WsStream, String> {
    let url = handshake_url(&req.url, &req.path, if v4 { 4 } else { 3 }, &req.query)?;
    ws::dial(&url, &req.headers, &[], &req.options).await
}

/// What a handled frame decided about the connection's future.
enum Flow {
    Continue,
    Stop { status: &'static str, detail: String },
}

async fn pump(
    app: AppHandle,
    id: String,
    stream: WsStream,
    mut rx: UnboundedReceiver<WsCommand>,
    session: Session,
) {
    let (mut writer, mut reader) = stream.split();
    // Engine.IO v4 heartbeats are server-initiated, so this timer stays disarmed there. v3 pings
    // on a period the server only reveals in its OPEN packet, hence `None` until then.
    let mut ping: Option<Interval> = None;
    let mut status = "closed";
    let mut detail = String::new();

    loop {
        tokio::select! {
            command = rx.recv() => {
                let Some(command) = command else { break };
                match command {
                    WsCommand::Text(args) => {
                        let frame = message_frame(EVENT, &session.namespace, &args);
                        if let Err(e) = writer.send(Message::text(frame)).await {
                            status = "error";
                            detail = e.to_string();
                            error(&app, &id, detail.as_str());
                            break;
                        }
                        let (event, payload) = split_event(&args)
                            .unwrap_or_else(|_| (String::new(), args.clone()));
                        ws::emit_message(&app, StreamMessage::new(&id, "sent", &event, payload));
                    }
                    WsCommand::Binary(_) => {
                        error(&app, &id, "Socket.IO carries binary as attachments, not as raw frames");
                    }
                    WsCommand::Close => {
                        let leave = message_frame(DISCONNECT, &session.namespace, "");
                        let _ = writer.send(Message::text(leave)).await;
                        let _ = writer.send(Message::Close(None)).await;
                        detail = "Closed by client".to_string();
                        break;
                    }
                }
            }
            frame = reader.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        match on_frame(&app, &id, &session, &mut writer, &mut ping, text.as_str()).await {
                            Flow::Continue => {}
                            Flow::Stop { status: s, detail: d } => {
                                status = s;
                                detail = d;
                                break;
                            }
                        }
                    }
                    // A binary frame is an attachment for the `45`/`46` packet that preceded it.
                    // Reassembling it into the placeholder it belongs to is more than the console
                    // needs; showing it beats dropping it.
                    Some(Ok(Message::Binary(bytes))) => {
                        let mut message = StreamMessage::new(&id, "system", "", B64.encode(&bytes));
                        message.binary = true;
                        ws::emit_message(&app, message);
                    }
                    // WebSocket-level keepalive, distinct from the Engine.IO one and answered by
                    // tungstenite itself; surfacing it would only clutter the transcript.
                    Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        detail = frame
                            .map(|f| f.to_string())
                            .unwrap_or_else(|| "Closed by server".to_string());
                        break;
                    }
                    Some(Err(e)) => {
                        status = "error";
                        detail = e.to_string();
                        error(&app, &id, detail.as_str());
                        break;
                    }
                    None => {
                        detail = "Stream ended".to_string();
                        break;
                    }
                }
            }
            _ = ws::tick(&mut ping) => {
                if let Err(e) = writer.send(Message::text(engine_frame(ENGINE_PING))).await {
                    status = "error";
                    detail = e.to_string();
                    error(&app, &id, detail.as_str());
                    break;
                }
                system(&app, &id, "engine.io ping sent");
            }
        }
    }

    let _ = writer.close().await;
    ws::unregister(&app, &id);
    ws::emit_status(&app, &id, status, detail);
}

async fn on_frame(
    app: &AppHandle,
    id: &str,
    session: &Session,
    writer: &mut Writer,
    ping: &mut Option<Interval>,
    text: &str,
) -> Flow {
    let Some(packet) = decode_engine(text) else {
        system(app, id, "empty Engine.IO frame ignored");
        return Flow::Continue;
    };

    match packet {
        Engine::Open(body) => {
            let handshake: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let sid = handshake.get("sid").and_then(Value::as_str).unwrap_or("");
            let interval_ms = handshake
                .get("pingInterval")
                .and_then(Value::as_u64)
                .unwrap_or(25_000);
            system(
                app,
                id,
                format!("engine.io open — sid {sid}, ping interval {interval_ms}ms"),
            );
            if !session.v4 {
                *ping = ws::keepalive(interval_ms);
                if has_auth(&session.auth_json) {
                    system(
                        app,
                        id,
                        "Socket.IO v3 has no handshake auth packet — the auth JSON was not sent",
                    );
                }
            }
            let frame = message_frame(
                CONNECT,
                &session.namespace,
                &connect_body(&session.auth_json, session.v4),
            );
            if let Err(e) = writer.send(Message::text(frame.clone())).await {
                return Flow::Stop {
                    status: "error",
                    detail: e.to_string(),
                };
            }
            system(app, id, format!("sent {frame}"));
        }
        // v4's heartbeat is server-initiated: an unanswered ping is a dropped connection one
        // ping-timeout later.
        Engine::Ping(_) => {
            if let Err(e) = writer.send(Message::text(engine_frame(ENGINE_PONG))).await {
                return Flow::Stop {
                    status: "error",
                    detail: e.to_string(),
                };
            }
            system(app, id, "engine.io ping received — pong sent");
        }
        Engine::Pong(_) => system(app, id, "engine.io pong received"),
        Engine::Close => {
            return Flow::Stop {
                status: "closed",
                detail: "Server closed the Engine.IO session".to_string(),
            }
        }
        Engine::Message(body) => return on_message(app, id, &body),
        Engine::Other(kind, _) => system(app, id, format!("engine.io packet '{kind}' ignored")),
    }
    Flow::Continue
}

fn on_message(app: &AppHandle, id: &str, body: &str) -> Flow {
    let packet = match decode_packet(body) {
        Ok(packet) => packet,
        Err(e) => {
            error(app, id, e);
            return Flow::Continue;
        }
    };

    match packet.kind {
        CONNECT => {
            let sid = serde_json::from_str::<Value>(&packet.data)
                .ok()
                .and_then(|v| v.get("sid").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            let namespace = packet.namespace;
            ws::emit_status(app, id, "open", format!("namespace {namespace}"));
            system(app, id, format!("connected to {namespace} (sid {sid})"));
        }
        DISCONNECT => {
            return Flow::Stop {
                status: "closed",
                detail: format!("Server disconnected namespace {}", packet.namespace),
            }
        }
        EVENT => match split_event(&packet.data) {
            Ok((event, payload)) => {
                ws::emit_message(app, StreamMessage::new(id, "received", &event, payload));
            }
            Err(e) => error(app, id, format!("Malformed event packet: {e}")),
        },
        ACK => {
            let args = join_args(parse_args(&packet.data).unwrap_or_default());
            let ack = packet.ack_id.unwrap_or_default();
            system(app, id, format!("ack {ack} {args}"));
        }
        CONNECT_ERROR => {
            let reason = if packet.data.trim().is_empty() {
                "Server refused the connection".to_string()
            } else {
                packet.data.clone()
            };
            error(app, id, reason.as_str());
            return Flow::Stop {
                status: "error",
                detail: reason,
            };
        }
        BINARY_EVENT | BINARY_ACK => system(
            app,
            id,
            format!(
                "binary packet with {} attachment(s): {}",
                packet.attachments, packet.data
            ),
        ),
        other => system(app, id, format!("Socket.IO packet type {other} ignored")),
    }
    Flow::Continue
}

fn system(app: &AppHandle, id: &str, text: impl Into<String>) {
    ws::emit_message(app, StreamMessage::new(id, "system", "", text));
}

fn error(app: &AppHandle, id: &str, text: impl Into<String>) {
    ws::emit_message(app, StreamMessage::new(id, "error", "", text));
}

// ---------------------------------------------------------------------------
// Engine.IO / Socket.IO framing — pure, and therefore tested
// ---------------------------------------------------------------------------

const ENGINE_PING: char = '2';
const ENGINE_PONG: char = '3';

#[derive(Debug, Clone, PartialEq, Eq)]
enum Engine {
    Open(String),
    Close,
    Ping(String),
    Pong(String),
    Message(String),
    Other(char, String),
}

/// One Socket.IO packet: `<kind>[<attachments>-][<namespace>,][<ack id>]<data>`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Packet {
    kind: u8,
    /// Always absolute; `/` when the frame carried no namespace segment.
    namespace: String,
    ack_id: Option<u64>,
    attachments: u32,
    /// Raw JSON text, empty when the packet had no payload.
    data: String,
}

fn engine_frame(kind: char) -> String {
    kind.to_string()
}

fn decode_engine(frame: &str) -> Option<Engine> {
    let mut chars = frame.chars();
    let kind = chars.next()?;
    let body = chars.as_str().to_string();
    Some(match kind {
        '0' => Engine::Open(body),
        '1' => Engine::Close,
        ENGINE_PING => Engine::Ping(body),
        ENGINE_PONG => Engine::Pong(body),
        '4' => Engine::Message(body),
        other => Engine::Other(other, body),
    })
}

fn decode_packet(body: &str) -> Result<Packet, String> {
    let kind = body
        .chars()
        .next()
        .and_then(|c| c.to_digit(10))
        .ok_or_else(|| format!("Unrecognised Socket.IO packet {body:?}"))? as u8;
    let mut rest = &body[1..];

    // `<n>-` only ever precedes a binary packet, and only ever holds digits — anything else that
    // happens to contain a dash is payload.
    let mut attachments = 0;
    if let Some(dash) = rest.find('-') {
        if dash > 0 && rest[..dash].bytes().all(|b| b.is_ascii_digit()) {
            attachments = rest[..dash].parse().unwrap_or(0);
            rest = &rest[dash + 1..];
        }
    }

    let namespace = if rest.starts_with('/') {
        match rest.find(',') {
            Some(comma) => {
                let namespace = rest[..comma].to_string();
                rest = &rest[comma + 1..];
                namespace
            }
            // `40/chat` — a namespace with no payload after it.
            None => {
                let namespace = rest.to_string();
                rest = "";
                namespace
            }
        }
    } else {
        "/".to_string()
    };

    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let ack_id = rest[..digits].parse::<u64>().ok();
    rest = &rest[digits..];

    Ok(Packet {
        kind,
        namespace,
        ack_id,
        attachments,
        data: rest.to_string(),
    })
}

/// `4<kind>[<ns>,]<body>`. The namespace segment is omitted for the root namespace, which is what
/// every server expects: `42[…]`, never `42/,[…]`.
fn message_frame(kind: u8, namespace: &str, body: &str) -> String {
    let namespace = namespace.trim();
    let mut frame = format!("4{kind}");
    if !namespace.is_empty() && namespace != "/" {
        if !namespace.starts_with('/') {
            frame.push('/');
        }
        frame.push_str(namespace);
        frame.push(',');
    }
    frame.push_str(body);
    frame
}

/// The `["name", payload]` array of an EVENT packet. `payload_json` is already a JSON *value*, so
/// it is spliced in verbatim — re-encoding it would turn an object into a quoted string.
fn event_args(event: &str, payload_json: &str) -> Result<String, String> {
    let name = serde_json::to_string(event).map_err(|e| e.to_string())?;
    let payload = payload_json.trim();
    if payload.is_empty() {
        return Ok(format!("[{name}]"));
    }
    serde_json::from_str::<Value>(payload)
        .map_err(|e| format!("Event payload is not valid JSON: {e}"))?;
    Ok(format!("[{name},{payload}]"))
}

/// The CONNECT packet's body. v3 has no auth payload at all, and an empty object is the frontend's
/// "nothing configured" default rather than something worth putting on the wire.
fn connect_body(auth_json: &str, v4: bool) -> String {
    if !v4 || !has_auth(auth_json) {
        return String::new();
    }
    auth_json.trim().to_string()
}

fn has_auth(auth_json: &str) -> bool {
    matches!(
        serde_json::from_str::<Value>(auth_json.trim()),
        Ok(Value::Object(map)) if !map.is_empty()
    )
}

/// `["name", args…]` → (name, JSON of the args). A lone argument keeps its own shape, so
/// `["msg","hi"]` reads as `"hi"` rather than `["hi"]`; several arguments become an array.
fn split_event(data: &str) -> Result<(String, String), String> {
    let mut args = parse_args(data)?;
    if args.is_empty() {
        return Err("event packet carried no name".to_string());
    }
    let name = match args.remove(0) {
        Value::String(name) => name,
        other => other.to_string(),
    };
    Ok((name, join_args(args)))
}

fn parse_args(data: &str) -> Result<Vec<Value>, String> {
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Value>(data).map_err(|e| e.to_string())? {
        Value::Array(args) => Ok(args),
        single => Ok(vec![single]),
    }
}

fn join_args(mut args: Vec<Value>) -> String {
    match args.len() {
        0 => String::new(),
        1 => args.remove(0).to_string(),
        _ => Value::Array(args).to_string(),
    }
}

/// `{scheme}://{host}{path}/?EIO={n}&transport=websocket`, with the caller's query pairs appended.
/// The Engine.IO path is absolute (it is a mount point, not a suffix), so whatever path the URL
/// carried is replaced — same rule socket.io-client follows.
fn handshake_url(
    url: &str,
    path: &str,
    eio: u8,
    query: &[(String, String)],
) -> Result<String, String> {
    let parsed = Url::parse(url.trim()).map_err(|e| format!("Invalid URL {url}: {e}"))?;
    let scheme = match parsed.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        other => return Err(format!("Unsupported scheme {other} for Socket.IO")),
    };
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("URL {url} has no host"))?;
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();

    let mut path = path.trim().trim_end_matches('/').to_string();
    if path.is_empty() {
        path = "/socket.io".to_string();
    }
    if !path.starts_with('/') {
        path.insert(0, '/');
    }

    let mut qs = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in parsed.query_pairs() {
        qs.append_pair(&key, &value);
    }
    qs.append_pair("EIO", &eio.to_string());
    qs.append_pair("transport", "websocket");
    for (key, value) in query {
        if !key.trim().is_empty() {
            qs.append_pair(key, value);
        }
    }

    Ok(format!("{scheme}://{host}{port}{path}/?{}", qs.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_namespace_has_no_namespace_segment() {
        assert_eq!(message_frame(CONNECT, "/", ""), "40");
        assert_eq!(message_frame(CONNECT, "", ""), "40");
        assert_eq!(message_frame(EVENT, "/", r#"["ping"]"#), r#"42["ping"]"#);
    }

    #[test]
    fn named_namespace_is_comma_terminated() {
        assert_eq!(message_frame(CONNECT, "/chat", ""), "40/chat,");
        assert_eq!(message_frame(DISCONNECT, "/chat", ""), "41/chat,");
        assert_eq!(
            message_frame(EVENT, "chat", r#"["ping"]"#),
            r#"42/chat,["ping"]"#
        );
    }

    #[test]
    fn connect_carries_auth_only_on_v4_and_only_when_it_says_something() {
        let auth = r#"{"token":"abc"}"#;
        assert_eq!(
            message_frame(CONNECT, "/", &connect_body(auth, true)),
            r#"40{"token":"abc"}"#
        );
        assert_eq!(
            message_frame(CONNECT, "/chat", &connect_body(auth, true)),
            r#"40/chat,{"token":"abc"}"#
        );
        assert_eq!(message_frame(CONNECT, "/", &connect_body(auth, false)), "40");
        assert_eq!(message_frame(CONNECT, "/", &connect_body("{}", true)), "40");
        assert_eq!(message_frame(CONNECT, "/", &connect_body("", true)), "40");
    }

    #[test]
    fn event_with_one_argument_keeps_that_argument_shape() {
        let frame = message_frame(EVENT, "/", &event_args("message", r#"{"a":1}"#).unwrap());
        assert_eq!(frame, r#"42["message",{"a":1}]"#);

        let packet = decode_packet(&frame[1..]).unwrap();
        assert_eq!(packet.kind, EVENT);
        assert_eq!(packet.namespace, "/");
        assert_eq!(
            split_event(&packet.data).unwrap(),
            ("message".to_string(), r#"{"a":1}"#.to_string())
        );
    }

    #[test]
    fn event_with_several_arguments_becomes_an_array() {
        let packet = decode_packet(r#"2/chat,["joined","ana",42]"#).unwrap();
        assert_eq!(packet.namespace, "/chat");
        assert_eq!(
            split_event(&packet.data).unwrap(),
            ("joined".to_string(), r#"["ana",42]"#.to_string())
        );
    }

    #[test]
    fn event_with_a_bare_string_payload_stays_json() {
        assert_eq!(
            event_args("message", r#""hello""#).unwrap(),
            r#"["message","hello"]"#
        );
        assert_eq!(
            split_event(r#"["message","hello"]"#).unwrap(),
            ("message".to_string(), r#""hello""#.to_string())
        );
    }

    #[test]
    fn event_with_no_payload_sends_only_the_name() {
        assert_eq!(event_args("tick", "  ").unwrap(), r#"["tick"]"#);
        assert_eq!(
            split_event(r#"["tick"]"#).unwrap(),
            ("tick".to_string(), String::new())
        );
    }

    #[test]
    fn event_payload_must_be_json() {
        assert!(event_args("message", "{not json}").is_err());
    }

    #[test]
    fn engine_opcodes_map_to_their_packets() {
        assert_eq!(decode_engine("2"), Some(Engine::Ping(String::new())));
        assert_eq!(decode_engine("3"), Some(Engine::Pong(String::new())));
        assert_eq!(decode_engine("1"), Some(Engine::Close));
        assert_eq!(
            decode_engine(r#"0{"sid":"a"}"#),
            Some(Engine::Open(r#"{"sid":"a"}"#.to_string()))
        );
        assert_eq!(
            decode_engine(r#"42["a"]"#),
            Some(Engine::Message(r#"2["a"]"#.to_string()))
        );
        assert_eq!(decode_engine(""), None);
        assert_eq!(engine_frame(ENGINE_PONG), "3");
    }

    #[test]
    fn ack_and_binary_packets_keep_their_metadata() {
        let ack = decode_packet(r#"312["ok"]"#).unwrap();
        assert_eq!(ack.kind, ACK);
        assert_eq!(ack.ack_id, Some(12));
        assert_eq!(ack.data, r#"["ok"]"#);

        let binary = decode_packet(r#"52-/chat,7["file",{"_placeholder":true}]"#).unwrap();
        assert_eq!(binary.kind, BINARY_EVENT);
        assert_eq!(binary.attachments, 2);
        assert_eq!(binary.namespace, "/chat");
        assert_eq!(binary.ack_id, Some(7));
    }

    #[test]
    fn namespace_without_payload_is_still_a_namespace() {
        let packet = decode_packet("0/chat").unwrap();
        assert_eq!(packet.kind, CONNECT);
        assert_eq!(packet.namespace, "/chat");
        assert_eq!(packet.data, "");
    }

    #[test]
    fn handshake_url_upgrades_the_scheme_and_keeps_existing_query() {
        assert_eq!(
            handshake_url("https://example.com/ignored", "/socket.io", 4, &[]).unwrap(),
            "wss://example.com/socket.io/?EIO=4&transport=websocket"
        );
        assert_eq!(
            handshake_url("http://localhost:3000?a=1", "socket.io/", 3, &[]).unwrap(),
            "ws://localhost:3000/socket.io/?a=1&EIO=3&transport=websocket"
        );
        assert_eq!(
            handshake_url(
                "ws://localhost:3000",
                "",
                4,
                &[("token".to_string(), "a b".to_string())]
            )
            .unwrap(),
            "ws://localhost:3000/socket.io/?EIO=4&transport=websocket&token=a+b"
        );
        assert!(handshake_url("ftp://example.com", "/socket.io", 4, &[]).is_err());
    }
}
