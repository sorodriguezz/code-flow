//! MQTT transport for the API client.
//!
//! A live connection is two tasks, not one: the first owns rumqttc's `EventLoop` and turns broker
//! traffic into transcript events, the second drains the [`MqttCommand`] channel the registry
//! hands to the UI. They are split because `EventLoop::poll` is not cancel-safe — driving it from
//! a `select!` arm next to the command channel loses packets whenever the other arm wins a race.
//!
//! 3.1.1 and 5.0 are two unrelated clients in rumqttc (`rumqttc::*` vs `rumqttc::v5::*`), down to
//! separate `QoS`, `Packet` and `MqttOptions` types. Everything that can be shared between them
//! is; the two poll loops are the part that genuinely cannot.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use rumqttc::tokio_rustls::rustls;
use rumqttc::{Outgoing, TlsConfiguration, Transport};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::api::{
    ApiRegistry, Connection, MqttCommand, MqttConnectRequest, MqttSubscribe, StreamMessage,
    StreamStatusEvent, EVENT_STREAM_MESSAGE, EVENT_STREAM_STATUS,
};

/// Depth of rumqttc's internal request queue: deep enough that a burst of publishes from the UI
/// never stalls the pump, shallow enough that a wedged broker doesn't hoard megabytes.
const REQUEST_CAPACITY: usize = 64;

/// rumqttc caps packets at 10 KB in both directions by default, which quietly kills any realistic
/// payload — an oversized incoming publish surfaces as a state error and drops the connection.
const MAX_PACKET_BYTES: usize = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Opens a connection and registers it under `id`. Returns as soon as the socket work is handed
/// to the background tasks; success or failure of the actual CONNECT arrives on
/// [`EVENT_STREAM_STATUS`].
pub async fn connect(app: AppHandle, id: String, req: MqttConnectRequest) -> Result<(), String> {
    let endpoint = parse_endpoint(&req.url)?;
    let v5 = match req.version.trim() {
        "" | "3.1.1" => false,
        "5.0" => true,
        other => {
            return Err(format!(
                "Unsupported MQTT version '{other}' — this build speaks 3.1.1 and 5.0"
            ))
        }
    };

    // Everything fallible happens before the connection is registered, so a failed `connect`
    // never leaves a phantom id behind for the UI to disconnect.
    let transport = if endpoint.tls {
        Some(tls_transport(&req.options)?)
    } else {
        None
    };
    let client_id = resolve_client_id(&req.client_id);
    let conn_timeout_secs = (req.options.timeout_ms / 1000).clamp(1, 3600);

    let (tx, rx) = mpsc::unbounded_channel();
    let closing = Arc::new(AtomicBool::new(false));
    app.state::<ApiRegistry>()
        .insert(id.clone(), Connection::Mqtt(tx.clone()));

    emit_status(
        &app,
        &id,
        "connecting",
        format!("{}:{}", endpoint.host, endpoint.port),
    );
    note_ignored_options(&app, &id, &req.options);

    if v5 {
        let mut opts = rumqttc::v5::MqttOptions::new(client_id, endpoint.host, endpoint.port);
        // The v5 options assert on anything under five seconds instead of returning an error, so
        // a shorter (or disabled) keep-alive is raised to the floor rather than crashing.
        opts.set_keep_alive(Duration::from_secs(req.keep_alive_secs.max(5)))
            .set_clean_start(req.clean_session)
            .set_max_packet_size(Some(MAX_PACKET_BYTES as u32))
            .set_connection_timeout(conn_timeout_secs);
        if !req.username.is_empty() {
            opts.set_credentials(&req.username, &req.password);
        }
        if let Some(transport) = transport {
            opts.set_transport(transport);
        }
        if let Some(will) = last_will(&req) {
            opts.set_last_will(rumqttc::v5::mqttbytes::v5::LastWill::new(
                will.topic.as_str(),
                will.payload.as_bytes(),
                v5_qos(will.qos),
                will.retain,
                None,
            ));
        }

        let (client, eventloop) = rumqttc::v5::AsyncClient::new(opts, REQUEST_CAPACITY);
        let sink: Arc<dyn MqttSink> = Arc::new(client);
        tokio::spawn(pump(
            app.clone(),
            id.clone(),
            Arc::clone(&sink),
            rx,
            Arc::clone(&closing),
        ));
        tokio::spawn(run_v5(
            app,
            id,
            sink,
            eventloop,
            req.subscriptions,
            closing,
            tx,
        ));
    } else {
        let mut opts = rumqttc::MqttOptions::new(client_id, endpoint.host, endpoint.port);
        opts.set_keep_alive(Duration::from_secs(req.keep_alive_secs))
            .set_clean_session(req.clean_session)
            .set_max_packet_size(MAX_PACKET_BYTES, MAX_PACKET_BYTES);
        if !req.username.is_empty() {
            opts.set_credentials(&req.username, &req.password);
        }
        if let Some(transport) = transport {
            opts.set_transport(transport);
        }
        if let Some(will) = last_will(&req) {
            opts.set_last_will(rumqttc::LastWill::new(
                will.topic.as_str(),
                will.payload.as_bytes(),
                v4_qos(will.qos),
                will.retain,
            ));
        }

        let (client, mut eventloop) = rumqttc::AsyncClient::new(opts, REQUEST_CAPACITY);
        // v4 keeps the connect/flush timeout on the event loop instead of the options.
        let mut network = rumqttc::NetworkOptions::new();
        network.set_connection_timeout(conn_timeout_secs);
        eventloop.network_options = network;

        let sink: Arc<dyn MqttSink> = Arc::new(client);
        tokio::spawn(pump(
            app.clone(),
            id.clone(),
            Arc::clone(&sink),
            rx,
            Arc::clone(&closing),
        ));
        tokio::spawn(run_v4(
            app,
            id,
            sink,
            eventloop,
            req.subscriptions,
            closing,
            tx,
        ));
    }

    Ok(())
}

pub fn publish(
    registry: &ApiRegistry,
    id: &str,
    topic: &str,
    payload: &str,
    qos: u8,
    retain: bool,
) -> Result<(), String> {
    send(
        registry,
        id,
        MqttCommand::Publish {
            topic: topic.to_string(),
            payload: payload.to_string(),
            qos,
            retain,
        },
    )
}

pub fn subscribe(registry: &ApiRegistry, id: &str, topic: &str, qos: u8) -> Result<(), String> {
    send(
        registry,
        id,
        MqttCommand::Subscribe {
            topic: topic.to_string(),
            qos,
        },
    )
}

pub fn unsubscribe(registry: &ApiRegistry, id: &str, topic: &str) -> Result<(), String> {
    send(
        registry,
        id,
        MqttCommand::Unsubscribe {
            topic: topic.to_string(),
        },
    )
}

fn send(registry: &ApiRegistry, id: &str, command: MqttCommand) -> Result<(), String> {
    let tx = crate::api::with_connection(registry, id, |conn| match conn {
        Connection::Mqtt(tx) => Ok(tx.clone()),
        _ => Err(format!("Connection {id} is not an MQTT connection")),
    })?;
    tx.send(command)
        .map_err(|_| format!("MQTT connection {id} is no longer open"))
}

// ---------------------------------------------------------------------------
// URL, credentials and TLS
// ---------------------------------------------------------------------------

struct Endpoint {
    host: String,
    port: u16,
    tls: bool,
}

fn parse_endpoint(url: &str) -> Result<Endpoint, String> {
    let raw = url.trim();
    if raw.is_empty() {
        return Err("MQTT broker URL is empty".to_string());
    }

    let (scheme, rest) = match raw.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => (String::new(), raw),
    };
    let tls = match scheme.as_str() {
        "" | "mqtt" | "tcp" => false,
        "mqtts" | "ssl" | "tls" => true,
        // MQTT-over-WebSocket lives behind rumqttc's `websocket` feature, which isn't enabled
        // here. Falling back to plain TCP would dial port 80 of a broker that only speaks the WS
        // endpoint and look like a hang, so say so instead.
        "ws" | "wss" => {
            return Err(format!(
                "MQTT over WebSocket ({scheme}://) is not supported by this build — \
                 use mqtt:// or mqtts://"
            ))
        }
        other => return Err(format!("Unsupported MQTT URL scheme '{other}://'")),
    };

    // A trailing path or query has no MQTT meaning, and credentials come from the request's own
    // fields rather than the URL, but tolerating both keeps a pasted URL from failing outright.
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);

    let (host, port) = match authority.strip_prefix('[') {
        Some(after_bracket) => {
            let (host, tail) = after_bracket
                .split_once(']')
                .ok_or_else(|| format!("Unterminated IPv6 host in MQTT URL '{url}'"))?;
            (host, tail.strip_prefix(':').filter(|p| !p.is_empty()))
        }
        None => match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    if host.is_empty() {
        return Err(format!("No broker host in MQTT URL '{url}'"));
    }

    let port = match port {
        Some(port) => port
            .parse::<u16>()
            .map_err(|_| format!("Invalid port '{port}' in MQTT URL '{url}'"))?,
        None if tls => 8883,
        None => 1883,
    };

    Ok(Endpoint {
        host: host.to_string(),
        port,
        tls,
    })
}

/// Brokers routinely reject an empty client id outright (it is only valid alongside a clean
/// session, and even then many implementations refuse it), so generate one when the user hasn't.
fn resolve_client_id(requested: &str) -> String {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        format!("codeflow-{:08x}", rand::random::<u32>())
    } else {
        trimmed.to_string()
    }
}

fn last_will(req: &MqttConnectRequest) -> Option<&crate::api::MqttLastWill> {
    req.last_will.as_ref().filter(|w| !w.topic.is_empty())
}

fn tls_transport(options: &crate::api::NetworkOptions) -> Result<Transport, String> {
    if !options.verify_ssl {
        let provider = rustls::crypto::ring::default_provider();
        let verifier = AcceptAnyServerCert {
            schemes: provider
                .signature_verification_algorithms
                .supported_schemes(),
        };
        let config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        return Ok(Transport::tls_with_config(TlsConfiguration::Rustls(
            Arc::new(config),
        )));
    }

    if !options.ca_cert_path.is_empty() {
        let ca = std::fs::read(&options.ca_cert_path)
            .map_err(|e| format!("Cannot read CA bundle {}: {e}", options.ca_cert_path))?;
        // Unlike the HTTP transport this *replaces* the system roots rather than adding to them:
        // rumqttc's rustls stack isn't re-exported far enough to build a merged root store here.
        return Ok(Transport::tls_with_config(TlsConfiguration::Simple {
            ca,
            alpn: None,
            client_auth: None,
        }));
    }

    Ok(Transport::tls_with_default_config())
}

/// Options the HTTP transport honours that have no equivalent here. Reported into the transcript
/// instead of ignored silently, so a connection that bypasses a configured proxy says so.
fn note_ignored_options(app: &AppHandle, id: &str, options: &crate::api::NetworkOptions) {
    if !options.proxy_url.is_empty() {
        emit_message(
            app,
            StreamMessage::new(
                id,
                "system",
                "",
                "Proxy is not supported for MQTT — connecting directly",
            ),
        );
    }
    if !options.client_cert_path.is_empty() {
        emit_message(
            app,
            StreamMessage::new(
                id,
                "system",
                "",
                "Client certificates are not supported for MQTT — connecting without one",
            ),
        );
    }
}

#[derive(Debug)]
struct AcceptAnyServerCert {
    schemes: Vec<rustls::SignatureScheme>,
}

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
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.schemes.clone()
    }
}

// ---------------------------------------------------------------------------
// Version-agnostic client handle
// ---------------------------------------------------------------------------

type SinkFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// Lets the command pump and the initial-subscribe step talk to either protocol version. Boxed
/// futures rather than `async fn` in trait, so the pump stays `Send` and therefore spawnable.
trait MqttSink: Send + Sync + 'static {
    fn publish(&self, topic: String, payload: Vec<u8>, qos: u8, retain: bool) -> SinkFuture<'_>;
    fn subscribe(&self, topic: String, qos: u8) -> SinkFuture<'_>;
    fn unsubscribe(&self, topic: String) -> SinkFuture<'_>;
    fn disconnect(&self) -> SinkFuture<'_>;
}

impl MqttSink for rumqttc::AsyncClient {
    fn publish(&self, topic: String, payload: Vec<u8>, qos: u8, retain: bool) -> SinkFuture<'_> {
        Box::pin(async move {
            rumqttc::AsyncClient::publish(self, topic, v4_qos(qos), retain, payload)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn subscribe(&self, topic: String, qos: u8) -> SinkFuture<'_> {
        Box::pin(async move {
            rumqttc::AsyncClient::subscribe(self, topic, v4_qos(qos))
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn unsubscribe(&self, topic: String) -> SinkFuture<'_> {
        Box::pin(async move {
            rumqttc::AsyncClient::unsubscribe(self, topic)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn disconnect(&self) -> SinkFuture<'_> {
        Box::pin(async move {
            rumqttc::AsyncClient::disconnect(self)
                .await
                .map_err(|e| e.to_string())
        })
    }
}

impl MqttSink for rumqttc::v5::AsyncClient {
    fn publish(&self, topic: String, payload: Vec<u8>, qos: u8, retain: bool) -> SinkFuture<'_> {
        Box::pin(async move {
            rumqttc::v5::AsyncClient::publish(self, topic, v5_qos(qos), retain, payload)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn subscribe(&self, topic: String, qos: u8) -> SinkFuture<'_> {
        Box::pin(async move {
            rumqttc::v5::AsyncClient::subscribe(self, topic, v5_qos(qos))
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn unsubscribe(&self, topic: String) -> SinkFuture<'_> {
        Box::pin(async move {
            rumqttc::v5::AsyncClient::unsubscribe(self, topic)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn disconnect(&self) -> SinkFuture<'_> {
        Box::pin(async move {
            rumqttc::v5::AsyncClient::disconnect(self)
                .await
                .map_err(|e| e.to_string())
        })
    }
}

/// An out-of-range QoS is clamped instead of rejected: the value reaches us from a stored request
/// and a bad one should degrade to "at most once", not kill the publish.
fn clamp_qos(qos: u8) -> u8 {
    if qos > 2 {
        0
    } else {
        qos
    }
}

fn v4_qos(qos: u8) -> rumqttc::QoS {
    match clamp_qos(qos) {
        1 => rumqttc::QoS::AtLeastOnce,
        2 => rumqttc::QoS::ExactlyOnce,
        _ => rumqttc::QoS::AtMostOnce,
    }
}

fn v5_qos(qos: u8) -> rumqttc::v5::mqttbytes::QoS {
    match clamp_qos(qos) {
        1 => rumqttc::v5::mqttbytes::QoS::AtLeastOnce,
        2 => rumqttc::v5::mqttbytes::QoS::ExactlyOnce,
        _ => rumqttc::v5::mqttbytes::QoS::AtMostOnce,
    }
}

// ---------------------------------------------------------------------------
// Command pump
// ---------------------------------------------------------------------------

async fn pump(
    app: AppHandle,
    id: String,
    sink: Arc<dyn MqttSink>,
    mut rx: UnboundedReceiver<MqttCommand>,
    closing: Arc<AtomicBool>,
) {
    while let Some(command) = rx.recv().await {
        match command {
            MqttCommand::Publish {
                topic,
                payload,
                qos,
                retain,
            } => {
                let bytes = payload.as_bytes().to_vec();
                match sink.publish(topic.clone(), bytes, qos, retain).await {
                    Ok(()) => {
                        let mut message = StreamMessage::new(&id, "sent", &topic, payload);
                        message.qos = Some(clamp_qos(qos));
                        message.retain = Some(retain);
                        emit_message(&app, message);
                    }
                    Err(e) => emit_message(
                        &app,
                        StreamMessage::new(&id, "error", &topic, format!("Publish failed: {e}")),
                    ),
                }
            }
            MqttCommand::Subscribe { topic, qos } => {
                request_subscribe(&app, &id, sink.as_ref(), &topic, qos).await
            }
            MqttCommand::Unsubscribe { topic } => {
                match sink.unsubscribe(topic.clone()).await {
                    Ok(()) => emit_message(
                        &app,
                        StreamMessage::new(&id, "system", &topic, format!("Unsubscribing {topic}")),
                    ),
                    Err(e) => emit_message(
                        &app,
                        StreamMessage::new(
                            &id,
                            "error",
                            &topic,
                            format!("Unsubscribe failed: {e}"),
                        ),
                    ),
                }
            }
            MqttCommand::Close => break,
        }
    }

    // Either an explicit Close or the registry dropping our sender; both are a deliberate
    // shutdown, so the poll loop must report the socket going away as `closed`, not `error`.
    closing.store(true, Ordering::SeqCst);
    let _ = sink.disconnect().await;
}

/// SUBACK only carries a packet id, so without this line the transcript can't say which topic an
/// ack belongs to.
async fn request_subscribe(
    app: &AppHandle,
    id: &str,
    sink: &dyn MqttSink,
    topic: &str,
    qos: u8,
) {
    match sink.subscribe(topic.to_string(), qos).await {
        Ok(()) => emit_message(
            app,
            StreamMessage::new(
                id,
                "system",
                topic,
                format!("Subscribing {topic} at QoS {}", clamp_qos(qos)),
            ),
        ),
        Err(e) => emit_message(
            app,
            StreamMessage::new(id, "error", topic, format!("Subscribe failed: {e}")),
        ),
    }
}

/// Runs off the poll task on purpose: `subscribe` waits for room in rumqttc's request queue, and
/// the only thing that drains that queue is the event loop we would be blocking.
fn subscribe_initial(
    app: &AppHandle,
    id: &str,
    sink: &Arc<dyn MqttSink>,
    subscriptions: Vec<MqttSubscribe>,
) {
    let (app, id, sink) = (app.clone(), id.to_string(), Arc::clone(sink));
    tokio::spawn(async move {
        for subscription in subscriptions {
            if subscription.topic.trim().is_empty() {
                continue;
            }
            request_subscribe(&app, &id, sink.as_ref(), &subscription.topic, subscription.qos)
                .await;
        }
    });
}

// ---------------------------------------------------------------------------
// Event loops
// ---------------------------------------------------------------------------

async fn run_v4(
    app: AppHandle,
    id: String,
    sink: Arc<dyn MqttSink>,
    mut eventloop: rumqttc::EventLoop,
    mut subscriptions: Vec<MqttSubscribe>,
    closing: Arc<AtomicBool>,
    tx: UnboundedSender<MqttCommand>,
) {
    use rumqttc::{Event, Packet};

    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                emit_status(
                    &app,
                    &id,
                    "open",
                    if ack.session_present {
                        "Connected, session resumed"
                    } else {
                        "Connected"
                    },
                );
                subscribe_initial(&app, &id, &sink, std::mem::take(&mut subscriptions));
            }
            Ok(Event::Incoming(Packet::Publish(publish))) => emit_message(
                &app,
                received(
                    &id,
                    &publish.topic,
                    &publish.payload,
                    publish.qos as u8,
                    publish.retain,
                ),
            ),
            Ok(Event::Incoming(Packet::SubAck(ack))) => {
                let codes: Vec<String> = ack
                    .return_codes
                    .iter()
                    .map(|code| match code {
                        rumqttc::SubscribeReasonCode::Success(qos) => {
                            format!("granted QoS {}", *qos as u8)
                        }
                        rumqttc::SubscribeReasonCode::Failure => "rejected".to_string(),
                    })
                    .collect();
                emit_message(
                    &app,
                    system(&id, format!("SUBACK #{}: {}", ack.pkid, codes.join(", "))),
                );
            }
            Ok(Event::Incoming(Packet::UnsubAck(ack))) => {
                emit_message(&app, system(&id, format!("UNSUBACK #{}", ack.pkid)))
            }
            Ok(Event::Incoming(Packet::PingResp)) => {
                emit_message(&app, system(&id, "PINGRESP"))
            }
            Ok(Event::Incoming(Packet::Disconnect)) => {
                emit_message(&app, system(&id, "Broker sent DISCONNECT"))
            }
            Ok(Event::Incoming(_)) => {}
            // The DISCONNECT we asked for has hit the wire; anything the socket does next is
            // teardown noise, not a failure.
            Ok(Event::Outgoing(Outgoing::Disconnect)) => break,
            Ok(Event::Outgoing(_)) => {}
            Err(e) => {
                report_error(&app, &id, &closing, &e.to_string());
                break;
            }
        }
    }

    finish(&app, &id, &tx);
}

async fn run_v5(
    app: AppHandle,
    id: String,
    sink: Arc<dyn MqttSink>,
    mut eventloop: rumqttc::v5::EventLoop,
    mut subscriptions: Vec<MqttSubscribe>,
    closing: Arc<AtomicBool>,
    tx: UnboundedSender<MqttCommand>,
) {
    use rumqttc::v5::mqttbytes::v5::Packet;
    use rumqttc::v5::Event;

    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                emit_status(
                    &app,
                    &id,
                    "open",
                    if ack.session_present {
                        "Connected, session resumed"
                    } else {
                        "Connected"
                    },
                );
                subscribe_initial(&app, &id, &sink, std::mem::take(&mut subscriptions));
            }
            Ok(Event::Incoming(Packet::Publish(publish))) => {
                // v5 carries the topic as raw bytes; the spec says UTF-8, but a broker that
                // disagrees shouldn't cost us the payload.
                let topic = String::from_utf8_lossy(&publish.topic).into_owned();
                emit_message(
                    &app,
                    received(
                        &id,
                        &topic,
                        &publish.payload,
                        publish.qos as u8,
                        publish.retain,
                    ),
                );
            }
            Ok(Event::Incoming(Packet::SubAck(ack))) => {
                let codes: Vec<String> = ack
                    .return_codes
                    .iter()
                    .map(|code| format!("{code:?}"))
                    .collect();
                emit_message(
                    &app,
                    system(&id, format!("SUBACK #{}: {}", ack.pkid, codes.join(", "))),
                );
            }
            Ok(Event::Incoming(Packet::UnsubAck(ack))) => {
                let reasons: Vec<String> = ack
                    .reasons
                    .iter()
                    .map(|reason| format!("{reason:?}"))
                    .collect();
                emit_message(
                    &app,
                    system(&id, format!("UNSUBACK #{}: {}", ack.pkid, reasons.join(", "))),
                );
            }
            Ok(Event::Incoming(Packet::PingResp(_))) => {
                emit_message(&app, system(&id, "PINGRESP"))
            }
            Ok(Event::Incoming(Packet::Disconnect(disconnect))) => emit_message(
                &app,
                system(
                    &id,
                    format!("Broker sent DISCONNECT: {:?}", disconnect.reason_code),
                ),
            ),
            Ok(Event::Incoming(_)) => {}
            Ok(Event::Outgoing(Outgoing::Disconnect)) => break,
            Ok(Event::Outgoing(_)) => {}
            Err(e) => {
                report_error(&app, &id, &closing, &e.to_string());
                break;
            }
        }
    }

    finish(&app, &id, &tx);
}

fn report_error(app: &AppHandle, id: &str, closing: &AtomicBool, detail: &str) {
    if closing.load(Ordering::SeqCst) {
        return;
    }
    emit_message(app, StreamMessage::new(id, "error", "", detail.to_string()));
    emit_status(app, id, "error", detail.to_string());
}

/// Announces the close and drops the registry entry, which in turn drops the command sender and
/// lets the pump task fall out of its loop.
fn finish(app: &AppHandle, id: &str, tx: &UnboundedSender<MqttCommand>) {
    emit_status(app, id, "closed", "");

    let registry = app.state::<ApiRegistry>();
    let Ok(mut connections) = registry.connections.lock() else {
        return;
    };
    // Only remove the entry if it is still ours: a reconnect under the same id may already have
    // replaced it, and killing that one would leave the UI holding a connection nothing drives.
    let ours = matches!(
        connections.get(id),
        Some(Connection::Mqtt(current)) if current.same_channel(tx)
    );
    if ours {
        connections.remove(id);
    }
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

fn received(id: &str, topic: &str, payload: &[u8], qos: u8, retain: bool) -> StreamMessage {
    let mut message = match std::str::from_utf8(payload) {
        Ok(text) => StreamMessage::new(id, "received", topic, text),
        Err(_) => {
            let mut binary = StreamMessage::new(
                id,
                "received",
                topic,
                base64::engine::general_purpose::STANDARD.encode(payload),
            );
            binary.binary = true;
            binary
        }
    };
    message.qos = Some(clamp_qos(qos));
    message.retain = Some(retain);
    message
}

fn system(id: &str, detail: impl Into<String>) -> StreamMessage {
    StreamMessage::new(id, "system", "", detail)
}

fn emit_message(app: &AppHandle, message: StreamMessage) {
    let _ = app.emit(EVENT_STREAM_MESSAGE, message);
}

fn emit_status(app: &AppHandle, id: &str, status: &str, detail: impl Into<String>) {
    let _ = app.emit(EVENT_STREAM_STATUS, StreamStatusEvent::new(id, status, detail));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_schemes_and_default_ports() {
        let plain = parse_endpoint("mqtt://broker.example.com").unwrap();
        assert_eq!(
            (plain.host.as_str(), plain.port, plain.tls),
            ("broker.example.com", 1883, false)
        );

        let secure = parse_endpoint("mqtts://broker.example.com").unwrap();
        assert_eq!(
            (secure.host.as_str(), secure.port, secure.tls),
            ("broker.example.com", 8883, true)
        );

        let bare = parse_endpoint("broker.example.com:1884").unwrap();
        assert_eq!((bare.host.as_str(), bare.port, bare.tls), ("broker.example.com", 1884, false));

        let ipv6 = parse_endpoint("mqtt://[::1]:1885").unwrap();
        assert_eq!((ipv6.host.as_str(), ipv6.port), ("::1", 1885));

        let with_path = parse_endpoint("ssl://broker.example.com:8884/mqtt").unwrap();
        assert_eq!((with_path.port, with_path.tls), (8884, true));
    }

    #[test]
    fn rejects_what_it_cannot_do() {
        assert!(parse_endpoint("ws://broker.example.com:8083/mqtt").is_err());
        assert!(parse_endpoint("wss://broker.example.com/mqtt").is_err());
        assert!(parse_endpoint("http://broker.example.com").is_err());
        assert!(parse_endpoint("mqtt://broker.example.com:not-a-port").is_err());
        assert!(parse_endpoint("   ").is_err());
    }

    #[test]
    fn generates_a_client_id_only_when_missing() {
        assert_eq!(resolve_client_id(" device-7 "), "device-7");
        let generated = resolve_client_id("");
        assert!(generated.starts_with("codeflow-"));
        assert_eq!(generated.len(), "codeflow-".len() + 8);
    }

    #[test]
    fn clamps_out_of_range_qos() {
        assert_eq!(clamp_qos(0), 0);
        assert_eq!(clamp_qos(2), 2);
        assert_eq!(clamp_qos(9), 0);
        assert_eq!(v4_qos(9), rumqttc::QoS::AtMostOnce);
        assert_eq!(v5_qos(1), rumqttc::v5::mqttbytes::QoS::AtLeastOnce);
    }
}
