//! WebSocket transport, and the pieces Socket.IO borrows from it.
//!
//! The reader/writer pump outlives the `connect` command that started it, which is why `connect`
//! takes an `AppHandle`: the task needs to reach the registry (and emit events) long after the
//! `State<'_>` borrow a command receives would have expired.
//!
//! Everything the UI shows about a live connection is rebuilt from the two events emitted here —
//! nothing is queryable after the fact — so every frame in either direction, and every keepalive,
//! becomes a [`StreamMessage`].

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::{interval_at, Instant, Interval};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::tungstenite::Bytes;
use tokio_tungstenite::{connect_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream};

use super::{
    with_connection, ApiRegistry, Connection, NetworkOptions, StreamMessage, StreamStatusEvent,
    WsCommand, WsConnectRequest, EVENT_STREAM_MESSAGE, EVENT_STREAM_STATUS,
};

pub(super) type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn connect(app: AppHandle, id: String, req: WsConnectRequest) -> Result<(), String> {
    let (tx, rx) = mpsc::unbounded_channel::<WsCommand>();
    // Registered before the socket is dialled, so a `send` issued the instant `connect` returns —
    // or even while the handshake is still running — queues in the channel instead of failing
    // with "no open connection".
    app.state::<ApiRegistry>().insert(id.clone(), Connection::Ws(tx));
    emit_status(&app, &id, "connecting", req.url.clone());

    let stream = match dial(&req.url, &req.headers, &req.subprotocols, &req.options).await {
        Ok(stream) => stream,
        Err(e) => {
            fail(&app, &id, &e);
            return Err(e);
        }
    };

    emit_status(&app, &id, "open", req.url.clone());
    tokio::spawn(pump(app, id, stream, rx, req.ping_interval_ms));
    Ok(())
}

pub fn send(registry: &ApiRegistry, id: &str, payload: String, binary: bool) -> Result<(), String> {
    let command = if binary {
        let bytes = B64
            .decode(payload.trim())
            .map_err(|e| format!("Payload is not valid base64: {e}"))?;
        WsCommand::Binary(bytes)
    } else {
        WsCommand::Text(payload)
    };
    let tx = with_connection(registry, id, |conn| match conn {
        Connection::Ws(tx) => Ok(tx.clone()),
        Connection::SocketIo(_) => Err(format!(
            "Connection {id} is a Socket.IO connection — raw frames would break its framing"
        )),
        Connection::Mqtt(_) => Err(format!("Connection {id} is an MQTT connection")),
    })?;
    tx.send(command)
        .map_err(|_| format!("Connection {id} is closed"))
}

async fn pump(
    app: AppHandle,
    id: String,
    stream: WsStream,
    mut rx: UnboundedReceiver<WsCommand>,
    ping_interval_ms: u64,
) {
    let (mut writer, mut reader) = stream.split();
    let mut ping = keepalive(ping_interval_ms);
    let mut status = "closed";
    let mut detail = String::new();

    loop {
        tokio::select! {
            command = rx.recv() => {
                // `None` means the registry dropped the handle without a `Close` — treat it the
                // same as a client-side close rather than spinning on a dead channel.
                let Some(command) = command else { break };
                match command {
                    WsCommand::Text(text) => {
                        if let Err(e) = writer.send(Message::text(text.clone())).await {
                            status = "error";
                            detail = e.to_string();
                            emit_message(&app, StreamMessage::new(&id, "error", "", detail.as_str()));
                            break;
                        }
                        emit_message(&app, StreamMessage::new(&id, "sent", "", text));
                    }
                    WsCommand::Binary(bytes) => {
                        let encoded = B64.encode(&bytes);
                        if let Err(e) = writer.send(Message::binary(bytes)).await {
                            status = "error";
                            detail = e.to_string();
                            emit_message(&app, StreamMessage::new(&id, "error", "", detail.as_str()));
                            break;
                        }
                        let mut message = StreamMessage::new(&id, "sent", "", encoded);
                        message.binary = true;
                        emit_message(&app, message);
                    }
                    WsCommand::Close => {
                        let _ = writer.send(Message::Close(None)).await;
                        detail = "Closed by client".to_string();
                        break;
                    }
                }
            }
            frame = reader.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        emit_message(&app, StreamMessage::new(&id, "received", "", text.as_str()));
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let mut message = StreamMessage::new(&id, "received", "", B64.encode(&bytes));
                        message.binary = true;
                        emit_message(&app, message);
                    }
                    // tungstenite queues the matching Pong itself and flushes it on the next read;
                    // a manual reply here would *replace* that queued frame, not add to it.
                    Some(Ok(Message::Ping(_))) => {
                        emit_message(&app, StreamMessage::new(&id, "system", "", "ping received — pong sent"));
                    }
                    Some(Ok(Message::Pong(_))) => {
                        emit_message(&app, StreamMessage::new(&id, "system", "", "pong received"));
                    }
                    Some(Ok(Message::Close(frame))) => {
                        detail = frame
                            .map(|f| f.to_string())
                            .unwrap_or_else(|| "Closed by server".to_string());
                        break;
                    }
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Err(e)) => {
                        status = "error";
                        detail = e.to_string();
                        emit_message(&app, StreamMessage::new(&id, "error", "", detail.as_str()));
                        break;
                    }
                    None => {
                        detail = "Stream ended".to_string();
                        break;
                    }
                }
            }
            _ = tick(&mut ping) => {
                if let Err(e) = writer.send(Message::Ping(Bytes::new())).await {
                    status = "error";
                    detail = e.to_string();
                    emit_message(&app, StreamMessage::new(&id, "error", "", detail.as_str()));
                    break;
                }
                emit_message(&app, StreamMessage::new(&id, "system", "", "ping sent"));
            }
        }
    }

    let _ = writer.close().await;
    unregister(&app, &id);
    emit_status(&app, &id, status, detail);
}

// ---------------------------------------------------------------------------
// Shared with socketio.rs
// ---------------------------------------------------------------------------

/// Opens the socket, applying the caller's headers, subprotocols, TLS policy and handshake
/// timeout. Socket.IO reuses this with an empty subprotocol list.
pub(super) async fn dial(
    url: &str,
    headers: &[(String, String)],
    subprotocols: &[String],
    options: &NetworkOptions,
) -> Result<WsStream, String> {
    let request = upgrade_request(url, headers, subprotocols)?;
    // Read off the normalized request before the handshake consumes it — `url` is still the raw
    // string the caller passed, which may not carry an explicit port.
    let (host, port) = {
        let uri = request.uri();
        let default = if uri.scheme_str() == Some("wss") { 443 } else { 80 };
        (uri.host().unwrap_or("").to_string(), Some(uri.port_u16().unwrap_or(default)))
    };
    let connector = tls_connector(options.verify_ssl)?;
    let handshake = connect_async_tls_with_config(request, None, false, connector);

    // tungstenite reports a failed connect as a bare "IO error"; the OS's sentence is one level
    // down, and an unreachable host should read the same way here as it does over HTTP.
    let describe = |e: &dyn std::error::Error| {
        crate::api::describe_transport_error(&format!("WebSocket to {url}"), &host, port, e)
    };

    let (stream, _response) = if options.timeout_ms == 0 {
        handshake.await.map_err(|e| describe(&e))?
    } else {
        tokio::time::timeout(Duration::from_millis(options.timeout_ms), handshake)
            .await
            .map_err(|_| format!("Handshake timed out after {}ms", options.timeout_ms))?
            .map_err(|e| describe(&e))?
    };
    Ok(stream)
}

pub(super) fn emit_message(app: &AppHandle, message: StreamMessage) {
    let _ = app.emit(EVENT_STREAM_MESSAGE, message);
}

pub(super) fn emit_status(app: &AppHandle, id: &str, status: &str, detail: impl Into<String>) {
    let _ = app.emit(EVENT_STREAM_STATUS, StreamStatusEvent::new(id, status, detail));
}

/// The one way a connection attempt is allowed to end badly: say it on the transcript, say it on
/// the status channel, and drop the handle so the id can be reused.
pub(super) fn fail(app: &AppHandle, id: &str, error: &str) {
    emit_message(app, StreamMessage::new(id, "error", "", error));
    emit_status(app, id, "error", error);
    unregister(app, id);
}

/// Deliberately not [`ApiRegistry::close`]: that posts another `Close` into a channel whose
/// reader is already unwinding.
pub(super) fn unregister(app: &AppHandle, id: &str) {
    if let Ok(mut connections) = app.state::<ApiRegistry>().connections.lock() {
        connections.remove(id);
    }
}

pub(super) fn keepalive(interval_ms: u64) -> Option<Interval> {
    (interval_ms > 0).then(|| {
        let period = Duration::from_millis(interval_ms);
        // `interval` fires its first tick immediately; pinging in the same millisecond as the
        // handshake is pure noise, so the schedule starts one period out.
        interval_at(Instant::now() + period, period)
    })
}

/// A `select!` arm that simply never completes when the keepalive is disabled.
pub(super) async fn tick(interval: &mut Option<Interval>) {
    match interval {
        Some(interval) => {
            interval.tick().await;
        }
        None => std::future::pending::<()>().await,
    }
}

fn upgrade_request(
    url: &str,
    headers: &[(String, String)],
    subprotocols: &[String],
) -> Result<Request, String> {
    let mut request = normalize_scheme(url)
        .into_client_request()
        .map_err(|e| format!("Invalid WebSocket URL: {e}"))?;

    let mut seen: HashSet<HeaderName> = HashSet::new();
    for (key, value) in headers {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|e| format!("Invalid header name {key}: {e}"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|e| format!("Invalid value for header {key}: {e}"))?;
        // The first row for a name replaces whatever the handshake generated (Host, Origin…);
        // repeats of the same name are extra values, because a header the user typed twice was
        // typed twice on purpose.
        if seen.insert(name.clone()) {
            request.headers_mut().insert(name, value);
        } else {
            request.headers_mut().append(name, value);
        }
    }

    let protocols: Vec<&str> = subprotocols
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if !protocols.is_empty() {
        let joined = protocols.join(", ");
        let value = HeaderValue::from_str(&joined)
            .map_err(|e| format!("Invalid subprotocol list {joined}: {e}"))?;
        request.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, value);
    }

    Ok(request)
}

/// Every WebSocket doc page writes the URL with the HTTP scheme it upgrades from, so rejecting
/// `https://` would only ever be a papercut.
pub(super) fn normalize_scheme(url: &str) -> String {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://") {
        format!("wss://{}", &trimmed[trimmed.len() - rest.len()..])
    } else if let Some(rest) = lower.strip_prefix("http://") {
        format!("ws://{}", &trimmed[trimmed.len() - rest.len()..])
    } else {
        trimmed.to_string()
    }
}

/// `None` keeps tokio-tungstenite's default connector (system roots).
fn tls_connector(verify_ssl: bool) -> Result<Option<Connector>, String> {
    if verify_ssl {
        return Ok(None);
    }
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
        .with_no_client_auth();
    Ok(Some(Connector::Rustls(Arc::new(config))))
}

/// Reachable only when the request explicitly turned verification off — the point of that toggle
/// is talking to a staging box with a self-signed certificate. Signature checking stays intact so
/// the handshake still fails on a genuinely broken peer rather than on a name mismatch alone.
#[derive(Debug)]
struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_http_schemes_preserving_case_of_the_rest() {
        assert_eq!(normalize_scheme("https://Example.com/Chat"), "wss://Example.com/Chat");
        assert_eq!(normalize_scheme("HTTP://example.com"), "ws://example.com");
        assert_eq!(normalize_scheme(" wss://example.com "), "wss://example.com");
    }

    #[test]
    fn first_header_row_replaces_the_generated_one_and_repeats_append() {
        let headers = vec![
            ("Origin".to_string(), "https://a.test".to_string()),
            ("X-Tag".to_string(), "one".to_string()),
            ("X-Tag".to_string(), "two".to_string()),
        ];
        let request = upgrade_request("wss://example.com", &headers, &["chat".to_string()]).unwrap();
        assert_eq!(request.headers().get_all("Origin").iter().count(), 1);
        let tags: Vec<_> = request
            .headers()
            .get_all("X-Tag")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(tags, vec!["one", "two"]);
        assert_eq!(request.headers()[SEC_WEBSOCKET_PROTOCOL], "chat");
    }
}
