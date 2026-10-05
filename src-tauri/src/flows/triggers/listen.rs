//! The "Incoming message" trigger: a WebSocket, Socket.IO, MQTT or Server-Sent Events connection
//! held open while the flow is active, and one run per message.
//!
//! **It reconnects.** A broker restarts, a laptop sleeps, a load balancer drops idle sockets: the
//! listener waits (1 s, doubling to a minute) and dials again, and the Schedule pane says why it is
//! not connected meanwhile. A connection that stayed up for a minute resets the wait.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_util::sync::CancellationToken;

use super::TriggerView;
use crate::api::NetworkOptions;
use crate::db::{flow_run_queries, Db};
use crate::flows::run::Item;

/// What a credential adds to a connection: headers, query pairs, or a broker's user and password.
#[derive(Default, Clone)]
struct Signed {
    headers: Vec<(String, String)>,
    query: Vec<(String, String)>,
    user: String,
    password: String,
}

fn sign(app: &AppHandle, credential_id: &str) -> Result<Signed, String> {
    let mut signed = Signed::default();
    if credential_id.trim().is_empty() {
        return Ok(signed);
    }
    let row = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_run_queries::get_credential(&conn, credential_id).map_err(|e| e.to_string())?.ok_or("The credential no longer exists")?
    };
    let secret = crate::secrets::get_secret(&crate::secrets::flow_credential_key(credential_id))?.ok_or("The credential has no secret stored")?;
    let meta = |key: &str| row.meta.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    match row.kind.as_str() {
        "bearer" => signed.headers.push(("Authorization".into(), format!("Bearer {secret}"))),
        "basic" => {
            use base64::Engine as _;
            signed.user = meta("user");
            signed.password = secret.clone();
            let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{secret}", meta("user")));
            signed.headers.push(("Authorization".into(), format!("Basic {token}")));
        }
        "header" => signed.headers.push((meta("name"), secret)),
        "query" => signed.query.push((meta("name"), secret)),
        other => return Err(format!("A {other} credential cannot sign this connection")),
    }
    Ok(signed)
}

fn text(params: &Value, name: &str) -> String {
    params.get(name).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn with_query(url: &str, query: &[(String, String)]) -> Result<String, String> {
    let mut parsed = url::Url::parse(url).map_err(|e| format!("{url} is not a URL: {e}"))?;
    if !query.is_empty() {
        let mut pairs = parsed.query_pairs_mut();
        for (name, value) in query {
            pairs.append_pair(name, value);
        }
    }
    Ok(parsed.to_string())
}

fn payload(text: &str) -> Value {
    serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

/// A trigger is listening for as long as it is armed; this stands in for "no end".
const FOREVER: Duration = Duration::from_secs(365 * 24 * 3600);

pub fn spawn(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    params: &Value,
    view: Arc<Mutex<TriggerView>>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let transport = text(params, "transport");
    let url = text(params, "url");
    if url.is_empty() {
        return Err("The URL is empty".into());
    }
    if transport == "mqtt" && text(params, "topic").is_empty() {
        return Err("Write the topic to listen to".into());
    }
    let reconnect = params.get("reconnect").and_then(Value::as_bool).unwrap_or(true);
    let (app, flow_id, node_id, params) = (app.clone(), flow_id.to_string(), node_id.to_string(), params.clone());
    tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(1);
        loop {
            if cancel.is_cancelled() {
                return;
            }
            let started = Instant::now();
            let fire = {
                let (app, flow_id, node_id, view) = (app.clone(), flow_id.clone(), node_id.clone(), view.clone());
                Arc::new(move |message: Value| {
                    super::note_problem(&view, None);
                    if let Err(error) = super::fire(&app, &flow_id, &node_id, vec![Item::new(message)]) {
                        super::note_problem(&view, Some(error));
                    }
                })
            };
            let opened = {
                let view = view.clone();
                Arc::new(move || super::note_problem(&view, None))
            };
            let outcome = match sign(&app, &text(&params, "credential")) {
                Err(error) => Err(error),
                Ok(signed) => match transport.as_str() {
                    "mqtt" => listen_mqtt(&params, &signed, fire, opened, cancel.clone()).await,
                    "socketio" => listen_socketio(&params, &signed, fire, opened, cancel.clone()).await,
                    "sse" => listen_sse(&params, &signed, fire, opened, cancel.clone()).await,
                    _ => listen_ws(&params, &signed, fire, opened, cancel.clone()).await,
                },
            };
            if cancel.is_cancelled() {
                return;
            }
            super::note_problem(
                &view,
                Some(match outcome {
                    Ok(()) => "The connection was closed — reconnecting".to_string(),
                    Err(error) => error,
                }),
            );
            if !reconnect {
                return;
            }
            if started.elapsed() > Duration::from_secs(60) {
                wait = Duration::from_secs(1);
            }
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => return,
            }
            wait = (wait * 2).min(Duration::from_secs(60));
        }
    });
    Ok(())
}

type Sink = Arc<dyn Fn(Value) + Send + Sync>;
type Opened = Arc<dyn Fn() + Send + Sync>;

async fn listen_ws(params: &Value, signed: &Signed, fire: Sink, opened: Opened, cancel: CancellationToken) -> Result<(), String> {
    let url = with_query(&crate::api::ws::normalize_scheme(&text(params, "url")), &signed.query)?;
    let network = NetworkOptions::default();
    let stream = tokio::select! {
        stream = crate::api::ws::dial(&url, &signed.headers, &[], &network) => stream?,
        _ = cancel.cancelled() => return Ok(()),
    };
    opened();
    let (mut writer, mut reader) = stream.split();
    // Some servers only start sending after a subscribe message.
    let hello = text(params, "subscribeMessage");
    if !hello.is_empty() {
        writer.send(Message::text(hello)).await.map_err(|e| e.to_string())?;
    }
    loop {
        let frame = tokio::select! {
            frame = reader.next() => frame,
            _ = cancel.cancelled() => {
                let _ = writer.send(Message::Close(None)).await;
                return Ok(());
            }
        };
        match frame {
            Some(Ok(Message::Text(text))) => fire(json!({"data": payload(text.as_str()), "at": chrono::Utc::now().to_rfc3339()})),
            Some(Ok(Message::Binary(bytes))) => {
                use base64::Engine as _;
                fire(json!({"data": base64::engine::general_purpose::STANDARD.encode(&bytes), "binary": true, "at": chrono::Utc::now().to_rfc3339()}));
            }
            Some(Ok(Message::Close(_))) | None => return Ok(()),
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(e.to_string()),
        }
    }
}

async fn listen_sse(params: &Value, signed: &Signed, fire: Sink, opened: Opened, cancel: CancellationToken) -> Result<(), String> {
    let url = with_query(&text(params, "url"), &signed.query)?;
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let mut request = client.get(&url).header("Accept", "text/event-stream");
    for (name, value) in &signed.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let mut response = tokio::select! {
        response = request.send() => response.map_err(|e| e.to_string())?,
        _ = cancel.cancelled() => return Ok(()),
    };
    if !response.status().is_success() {
        return Err(format!("The stream answered {}", response.status()));
    }
    opened();
    let only = text(params, "event");
    let mut decoder = crate::api::stream::Utf8Stream::default();
    let mut parser = crate::api::stream::SseParser::default();
    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
            _ = cancel.cancelled() => return Ok(()),
        };
        let Some(chunk) = chunk else { return Ok(()) };
        for event in parser.push(&decoder.push(&chunk)) {
            let name = if event.event.is_empty() { "message".to_string() } else { event.event.clone() };
            if !only.is_empty() && name != only {
                continue;
            }
            fire(json!({"event": name, "data": payload(&event.data), "id": event.last_event_id}));
        }
    }
}

async fn listen_mqtt(params: &Value, signed: &Signed, fire: Sink, opened: Opened, cancel: CancellationToken) -> Result<(), String> {
    let request = crate::api::MqttConnectRequest {
        url: text(params, "url"),
        client_id: text(params, "clientId"),
        username: signed.user.clone(),
        password: signed.password.clone(),
        keep_alive_secs: 30,
        clean_session: true,
        version: "3.1.1".into(),
        last_will: None,
        subscriptions: Vec::new(),
        options: NetworkOptions::default(),
    };
    let qos = params.get("qos").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 2.0) as u8;
    let plan = crate::api::mqtt::MqttExchange {
        publish: None,
        subscribe: Some((text(params, "topic"), qos)),
        max: 0,
        timeout: FOREVER,
        sink: Some(fire),
        opened: Some(opened),
    };
    match crate::api::mqtt::exchange(&request, plan, cancel).await {
        Err(error) if error.starts_with(crate::ai_runs::CANCELLED_MARKER) => Ok(()),
        other => other.map(|_| ()),
    }
}

async fn listen_socketio(params: &Value, signed: &Signed, fire: Sink, opened: Opened, cancel: CancellationToken) -> Result<(), String> {
    let path = text(params, "socketPath");
    let request = crate::api::SocketIoConnectRequest {
        url: text(params, "url"),
        path: if path.is_empty() { "/socket.io".into() } else { path },
        namespace: text(params, "namespace"),
        version: text(params, "version"),
        headers: signed.headers.clone(),
        auth_json: text(params, "auth"),
        query: signed.query.clone(),
        options: NetworkOptions::default(),
    };
    let plan = crate::api::socketio::SocketIoExchange {
        emit: None,
        want_ack: false,
        listen: text(params, "event"),
        max: 0,
        timeout: FOREVER,
        sink: Some(fire),
        opened: Some(opened),
    };
    match crate::api::socketio::exchange(request, plan, cancel).await {
        Err(error) if error.starts_with(crate::ai_runs::CANCELLED_MARKER) => Ok(()),
        other => other.map(|_| ()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn collector() -> (Sink, Arc<StdMutex<Vec<Value>>>) {
        let got = Arc::new(StdMutex::new(Vec::new()));
        let into = got.clone();
        (Arc::new(move |message: Value| into.lock().unwrap().push(message)), got)
    }

    fn quiet() -> Opened {
        Arc::new(|| {})
    }

    #[tokio::test]
    async fn a_websocket_listener_subscribes_and_hands_over_each_message() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let hello = ws.next().await;
            assert!(matches!(hello, Some(Ok(Message::Text(ref text))) if text.as_str() == "suscribir"), "{hello:?}");
            ws.send(Message::text("{\"n\":1}")).await.unwrap();
            ws.send(Message::text("hola")).await.unwrap();
            ws.close(None).await.unwrap();
        });
        let (fire, got) = collector();
        let params = json!({"url": format!("ws://127.0.0.1:{port}"), "subscribeMessage": "suscribir"});
        // The server closing is an ordinary end: the caller reconnects.
        listen_ws(&params, &Signed::default(), fire, quiet(), CancellationToken::new()).await.unwrap();
        let got = got.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["data"], json!({"n": 1}));
        assert_eq!(got[1]["data"], "hola");
    }

    #[tokio::test]
    async fn an_sse_listener_keeps_the_named_event_and_signs_the_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(StdMutex::new(String::new()));
        let request = seen.clone();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 8192];
            let n = socket.read(&mut buffer).await.unwrap();
            *request.lock().unwrap() = String::from_utf8_lossy(&buffer[..n]).to_string();
            let stream = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
                          event: tick\ndata: {\"n\":1}\n\nevent: otro\ndata: x\n\nevent: tick\ndata: {\"n\":2}\n\n";
            socket.write_all(stream.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let (fire, got) = collector();
        let signed = Signed { headers: vec![("Authorization".into(), "Bearer s3cret".into())], query: vec![("canal".into(), "a b".into())], ..Signed::default() };
        let params = json!({"url": format!("http://127.0.0.1:{port}/eventos"), "event": "tick"});
        listen_sse(&params, &signed, fire, quiet(), CancellationToken::new()).await.unwrap();
        let got = got.lock().unwrap();
        assert_eq!(got.iter().map(|m| m["data"]["n"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(2)]);
        let request = seen.lock().unwrap();
        assert!(request.starts_with("GET /eventos?canal=a+b HTTP/1.1"), "{request}");
        assert!(request.to_ascii_lowercase().contains("authorization: bearer s3cret"), "{request}");
    }

    #[tokio::test]
    #[ignore = "needs the MQTT broker container (see flows::engine::tests::milestone4)"]
    async fn an_mqtt_listener_hears_every_message_until_cancelled() {
        let (fire, got) = collector();
        let cancel = CancellationToken::new();
        let topic = format!("flujos/escucha/{}", uuid::Uuid::new_v4().simple());
        let params = json!({"url": "mqtt://127.0.0.1:51883", "topic": topic, "qos": 1});
        let opened = Arc::new(tokio::sync::Notify::new());
        let task = {
            let (cancel, opened) = (cancel.clone(), opened.clone());
            tokio::spawn(async move { listen_mqtt(&params, &Signed::default(), fire, Arc::new(move || opened.notify_one()), cancel).await })
        };
        tokio::time::timeout(Duration::from_secs(5), opened.notified()).await.expect("the broker accepted the listener");
        tokio::time::sleep(Duration::from_millis(300)).await;
        for n in 1..=3 {
            let request = crate::api::MqttConnectRequest {
                url: "mqtt://127.0.0.1:51883".into(),
                client_id: String::new(),
                username: String::new(),
                password: String::new(),
                keep_alive_secs: 30,
                clean_session: true,
                version: "3.1.1".into(),
                last_will: None,
                subscriptions: Vec::new(),
                options: NetworkOptions::default(),
            };
            let plan = crate::api::mqtt::MqttExchange {
                publish: Some((topic.clone(), format!("{{\"n\":{n}}}").into_bytes(), 1, false)),
                subscribe: None,
                max: 0,
                timeout: Duration::from_secs(5),
                sink: None,
                opened: None,
            };
            crate::api::mqtt::exchange(&request, plan, CancellationToken::new()).await.unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while got.lock().unwrap().len() < 3 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        cancel.cancel();
        assert_eq!(task.await.unwrap(), Ok(()), "a cancelled listener ends quietly");
        let got = got.lock().unwrap();
        assert_eq!(got.iter().map(|m| m["data"]["n"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(2), json!(3)]);
    }
}
