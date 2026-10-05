//! The network nodes beyond plain HTTP: GraphQL, WebSocket, Socket.IO, gRPC, MQTT, Server-Sent
//! Events, file downloads and email.
//!
//! **The API client's transports, not new ones.** GraphQL goes through `api::http::send` like the
//! HTTP node; WebSocket dials with `api::ws::dial` (its TLS, proxy and client-certificate policy);
//! Socket.IO and MQTT run one-shot exchanges that live beside the API tab's clients and reuse their
//! protocol code; gRPC calls `api::grpc::call`, `.proto` files and server reflection included. A
//! conversation is always bounded — a count of messages or a time limit — because a node has to
//! end: a connection that should stay open is a trigger ("Incoming message"), not a node.

use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio_tungstenite::tungstenite::protocol::Message;

use super::files::{describe, expand};
use super::http::{apply_credential, build_url, loggable};
use super::{flag, number, pairs, strings, text, NodeCtx, NodeError};
use crate::api::{GrpcCallRequest, HttpSendRequest, MqttConnectRequest, NetworkOptions, SocketIoConnectRequest};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};
use crate::flows::value::to_text;

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "net.graphql" => per_item(ctx, graphql).await,
        "net.websocket" => per_item(ctx, websocket).await,
        "net.socketio" => per_item(ctx, socketio).await,
        "net.grpc" => per_item(ctx, grpc).await,
        "net.mqtt" => per_item(ctx, mqtt).await,
        "net.sse" => per_item(ctx, sse).await,
        "net.download" => per_item(ctx, download).await,
        "net.email" => per_item(ctx, email).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

type Exchange = for<'a> fn(&'a NodeCtx, &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>>;

/// Runs `work` once per input item (or once with none), each answer paired to its item.
async fn per_item(ctx: &NodeCtx, work: Exchange) -> Result<Ports, NodeError> {
    let once = ctx.param_str("runFor") == "once";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let paired = !ctx.items().is_empty();
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        for json in work(ctx, params).await? {
            out.push(if paired { Item::paired(json, index) } else { Item::new(json) });
        }
    }
    Ok(vec![out])
}

fn options(params: &Value) -> NetworkOptions {
    NetworkOptions {
        timeout_ms: number(params, "timeoutMs").map(|n| n.max(0.0) as u64).filter(|n| *n > 0).unwrap_or(30_000),
        verify_ssl: params.get("verifySsl").is_none() || flag(params, "verifySsl"),
        max_response_bytes: 64 * 1024 * 1024,
        ..NetworkOptions::default()
    }
}

/// How long a conversation may last, from `timeoutSec` (default 10 s, at most an hour).
fn window(params: &Value) -> Duration {
    Duration::from_secs_f64(number(params, "timeoutSec").unwrap_or(10.0).clamp(0.1, 3600.0))
}

fn max_messages(params: &Value) -> usize {
    number(params, "maxMessages").unwrap_or(1.0).clamp(0.0, 10_000.0) as usize
}

/// A message's payload as JSON when it is JSON, else as text.
fn payload_value(text: &str) -> Value {
    serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

fn transport_error(error: String) -> NodeError {
    if error.starts_with(crate::ai_runs::CANCELLED_MARKER) {
        NodeError::Cancelled
    } else {
        NodeError::Failed(error)
    }
}

// ---------------------------------------------------------------------------------------- GraphQL

const INTROSPECTION: &str = "query IntrospectionQuery { __schema { queryType { name } mutationType { name } \
    subscriptionType { name } types { kind name description fields(includeDeprecated: true) { name \
    type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }";

fn type_name(value: &Value) -> String {
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or_default();
    let inner = value.get("ofType").filter(|v| !v.is_null()).map(type_name).unwrap_or_default();
    match kind {
        "NON_NULL" => format!("{inner}!"),
        "LIST" => format!("[{inner}]"),
        _ => value.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
    }
}

fn graphql<'a>(ctx: &'a NodeCtx, params: &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>> {
    Box::pin(async move {
        let introspect = text(params, "operation") == "introspect";
        let mut headers = pairs(params, "headers");
        let mut query_params = Vec::new();
        apply_credential(ctx, &text(params, "credential"), &mut headers, &mut query_params)?;
        headers.push(("Content-Type".into(), "application/json".into()));
        headers.push(("Accept".into(), "application/json".into()));
        let url = build_url(&text(params, "url"), &query_params)?;
        let variables: Value = match params.get("variables") {
            Some(Value::String(raw)) if !raw.trim().is_empty() => {
                serde_json::from_str(raw).map_err(|e| NodeError::failed(format!("The variables are not JSON: {e}")))?
            }
            Some(Value::String(_)) | None | Some(Value::Null) => json!({}),
            Some(other) => other.clone(),
        };
        let mut body = Map::new();
        if introspect {
            body.insert("query".into(), json!(INTROSPECTION));
        } else {
            let query = text(params, "queryText");
            if query.trim().is_empty() {
                return Err(NodeError::failed("Write the query or mutation"));
            }
            body.insert("query".into(), json!(query));
            body.insert("variables".into(), variables);
            let name = text(params, "operationName");
            if !name.trim().is_empty() {
                body.insert("operationName".into(), json!(name.trim()));
            }
        }
        let request = HttpSendRequest {
            method: "POST".into(),
            url: url.to_string(),
            headers,
            body_text: Some(Value::Object(body).to_string()),
            body_base64: None,
            body_file: None,
            form_data: None,
            urlencoded: None,
            auth: None,
            options: options(params),
        };
        let response = tokio::select! {
            response = crate::api::http::send(request, None, None) => response.map_err(NodeError::failed)?,
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        ctx.log(LogStream::Info, &format!("POST {} → {} ({} ms)", loggable(&url), response.status, response.duration_ms));
        let answer: Value = serde_json::from_str(&response.body_text).map_err(|_| {
            NodeError::failed(format!(
                "{} answered {} with something that is not JSON: {}",
                loggable(&url),
                response.status,
                response.body_text.chars().take(300).collect::<String>()
            ))
        })?;
        let errors = answer.get("errors").filter(|e| e.as_array().is_some_and(|list| !list.is_empty())).cloned();
        let data = answer.get("data").cloned().unwrap_or(Value::Null);
        if let Some(errors) = &errors {
            if data.is_null() || flag(params, "failOnErrors") {
                let first = errors.get(0).and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("error");
                return Err(NodeError::failed(format!("GraphQL error: {first}")));
            }
        }
        if response.status >= 400 && errors.is_none() {
            return Err(NodeError::failed(format!("{} answered {} {}", loggable(&url), response.status, response.status_text)));
        }
        if introspect {
            let schema = data.get("__schema").cloned().unwrap_or(Value::Null);
            let types: Vec<Value> = schema
                .get("types")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|t| !t.get("name").and_then(Value::as_str).unwrap_or("__").starts_with("__"))
                .map(|t| {
                    json!({
                        "name": t.get("name"),
                        "kind": t.get("kind"),
                        "description": t.get("description"),
                        "fields": t.get("fields").and_then(Value::as_array).map(|fields| {
                            fields.iter().map(|f| json!({"name": f.get("name"), "type": f.get("type").map(type_name)})).collect::<Vec<_>>()
                        }),
                    })
                })
                .collect();
            return Ok(vec![json!({
                "queryType": schema.pointer("/queryType/name"),
                "mutationType": schema.pointer("/mutationType/name"),
                "subscriptionType": schema.pointer("/subscriptionType/name"),
                "types": types,
            })]);
        }
        let mut item = Map::new();
        item.insert("data".into(), data);
        if let Some(errors) = errors {
            item.insert("errors".into(), errors);
        }
        Ok(vec![Value::Object(item)])
    })
}

// -------------------------------------------------------------------------------------- WebSocket

fn websocket<'a>(ctx: &'a NodeCtx, params: &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>> {
    Box::pin(async move {
        let mut headers = pairs(params, "headers");
        let mut query = Vec::new();
        apply_credential(ctx, &text(params, "credential"), &mut headers, &mut query)?;
        let mut url = build_url(&crate::api::ws::normalize_scheme(&text(params, "url")), &query)?;
        if !matches!(url.scheme(), "ws" | "wss") {
            let secure = url.scheme() == "https";
            let _ = url.set_scheme(if secure { "wss" } else { "ws" });
        }
        let subprotocols = strings(params, "subprotocols");
        let network = options(params);
        let stream = tokio::select! {
            stream = crate::api::ws::dial(url.as_str(), &headers, &subprotocols, &network) => stream.map_err(NodeError::Failed)?,
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        ctx.log(LogStream::Info, &format!("WebSocket open: {}", loggable(&url)));
        let (mut writer, mut reader) = stream.split();
        for message in strings(params, "messages") {
            writer.send(Message::text(message)).await.map_err(|e| NodeError::failed(e.to_string()))?;
        }
        let max = max_messages(params);
        let until = text(params, "untilContains");
        let deadline = tokio::time::Instant::now() + window(params);
        let mut received = Vec::new();
        // No count (0) reads until the time limit.
        while max == 0 || received.len() < max {
            let frame = tokio::select! {
                _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
                _ = tokio::time::sleep_until(deadline) => break,
                frame = reader.next() => frame,
            };
            match frame {
                Some(Ok(Message::Text(text))) => {
                    let text = text.to_string();
                    let done = !until.is_empty() && text.contains(until.as_str());
                    received.push(json!({"data": payload_value(&text), "at": chrono::Utc::now().to_rfc3339()}));
                    if done {
                        break;
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    received.push(json!({"data": base64::engine::general_purpose::STANDARD.encode(&bytes), "binary": true, "at": chrono::Utc::now().to_rfc3339()}));
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(NodeError::failed(e.to_string())),
            }
        }
        let _ = writer.send(Message::Close(None)).await;
        if received.is_empty() && flag(params, "requireAnswer") {
            return Err(NodeError::failed("No message arrived before the time limit"));
        }
        Ok(received)
    })
}

// -------------------------------------------------------------------------------------- Socket.IO

fn socketio<'a>(ctx: &'a NodeCtx, params: &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>> {
    Box::pin(async move {
        let mut headers = pairs(params, "headers");
        let mut query = Vec::new();
        apply_credential(ctx, &text(params, "credential"), &mut headers, &mut query)?;
        let path = text(params, "socketPath");
        let request = SocketIoConnectRequest {
            url: text(params, "url"),
            path: if path.trim().is_empty() { "/socket.io".into() } else { path },
            namespace: text(params, "namespace"),
            version: text(params, "version"),
            headers,
            auth_json: text(params, "auth"),
            query,
            options: options(params),
        };
        let event = text(params, "event");
        let plan = crate::api::socketio::SocketIoExchange {
            emit: (!event.trim().is_empty()).then(|| (event.trim().to_string(), text(params, "payload"))),
            want_ack: flag(params, "waitAck"),
            listen: text(params, "listen"),
            max: max_messages(params),
            timeout: window(params),
            sink: None,
            opened: None,
        };
        crate::api::socketio::exchange(request, plan, ctx.cancel.clone()).await.map_err(transport_error)
    })
}

// ------------------------------------------------------------------------------------------- gRPC

fn grpc<'a>(ctx: &'a NodeCtx, params: &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>> {
    Box::pin(async move {
        let mut metadata = pairs(params, "metadata");
        let mut ignored = Vec::new();
        apply_credential(ctx, &text(params, "credential"), &mut metadata, &mut ignored)?;
        // gRPC metadata keys are lowercase on the wire.
        let metadata = metadata.into_iter().map(|(k, v)| (k.to_ascii_lowercase(), v)).collect();
        let message = text(params, "message");
        let request = GrpcCallRequest {
            source: if text(params, "source") == "proto" { "proto".into() } else { "reflection".into() },
            proto_path: expand(&text(params, "protoPath")).to_string_lossy().into_owned(),
            import_paths: strings(params, "importPaths"),
            endpoint: text(params, "endpoint"),
            service: text(params, "service"),
            method: text(params, "method"),
            message_json: if message.trim().is_empty() { "{}".into() } else { message },
            metadata,
            use_tls: flag(params, "tls"),
            authority: String::new(),
            options: options(params),
        };
        if request.service.trim().is_empty() || request.method.trim().is_empty() {
            return Err(NodeError::failed("Write the service and the method"));
        }
        let response = tokio::select! {
            response = crate::api::grpc::call(request) => response.map_err(NodeError::Failed)?,
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        ctx.log(LogStream::Info, &format!("gRPC → {} {} ({} ms)", response.status_code, response.status_message, response.duration_ms));
        if response.status_code != 0 {
            return Err(NodeError::failed(format!("gRPC status {}: {}", response.status_code, response.status_message)));
        }
        let parsed = payload_value(&response.message_json);
        Ok(match parsed {
            // A server stream: one item per message.
            Value::Array(messages) => messages.into_iter().map(|m| if m.is_object() { m } else { json!({"value": m}) }).collect(),
            Value::Object(map) => vec![Value::Object(map)],
            other => vec![json!({"value": other})],
        })
    })
}

// ------------------------------------------------------------------------------------------- MQTT

fn mqtt<'a>(ctx: &'a NodeCtx, params: &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>> {
    Box::pin(async move {
        let (mut username, mut password) = (String::new(), String::new());
        let credential = text(params, "credential");
        if !credential.trim().is_empty() {
            let credential = ctx.run.host.credential(credential.trim()).map_err(NodeError::Failed)?;
            username = credential.meta.get("user").and_then(Value::as_str).unwrap_or_default().to_string();
            password = credential.secret;
        }
        let request = MqttConnectRequest {
            url: text(params, "url"),
            client_id: text(params, "clientId"),
            username,
            password,
            keep_alive_secs: 30,
            clean_session: true,
            version: "3.1.1".into(),
            last_will: None,
            subscriptions: Vec::new(),
            options: options(params),
        };
        let qos = number(params, "qos").unwrap_or(0.0).clamp(0.0, 2.0) as u8;
        let topic = text(params, "topic");
        if topic.trim().is_empty() {
            return Err(NodeError::failed("Write the topic"));
        }
        let subscribe = text(params, "operation") == "subscribe";
        let plan = crate::api::mqtt::MqttExchange {
            publish: (!subscribe).then(|| {
                let payload = match params.get("payload") {
                    Some(Value::String(text)) => text.clone().into_bytes(),
                    Some(other) => other.to_string().into_bytes(),
                    None => Vec::new(),
                };
                (topic.trim().to_string(), payload, qos, flag(params, "retain"))
            }),
            subscribe: subscribe.then(|| (topic.trim().to_string(), qos)),
            max: if subscribe { max_messages(params) } else { 0 },
            timeout: window(params),
            sink: None,
            opened: None,
        };
        let received = crate::api::mqtt::exchange(&request, plan, ctx.cancel.clone()).await.map_err(transport_error)?;
        if subscribe {
            Ok(received)
        } else {
            ctx.log(LogStream::Info, &format!("MQTT published to {} (QoS {qos})", topic.trim()));
            Ok(vec![json!({"published": true, "topic": topic.trim(), "qos": qos})])
        }
    })
}

// -------------------------------------------------------------------------------------------- SSE

fn http_client(params: &Value) -> Result<reqwest::Client, NodeError> {
    let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).user_agent("CodeFlow-Flows");
    if params.get("verifySsl").is_some() && !flag(params, "verifySsl") {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().map_err(|e| NodeError::failed(e.to_string()))
}

fn header_map(headers: &[(String, String)]) -> Result<reqwest::header::HeaderMap, NodeError> {
    let mut map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        let name = reqwest::header::HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| NodeError::failed(format!("\"{name}\" is not a header name")))?;
        let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| NodeError::failed("A header value holds characters HTTP cannot carry"))?;
        map.append(name, value);
    }
    Ok(map)
}

fn sse<'a>(ctx: &'a NodeCtx, params: &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>> {
    Box::pin(async move {
        let mut headers = pairs(params, "headers");
        let mut query = Vec::new();
        apply_credential(ctx, &text(params, "credential"), &mut headers, &mut query)?;
        headers.push(("Accept".into(), "text/event-stream".into()));
        let url = build_url(&text(params, "url"), &query)?;
        let client = http_client(params)?;
        let deadline = tokio::time::Instant::now() + window(params);
        let send = client.get(url.clone()).headers(header_map(&headers)?).send();
        let mut response = tokio::select! {
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
            _ = tokio::time::sleep_until(deadline) => return Err(NodeError::failed("The stream did not answer before the time limit")),
            response = send => response.map_err(|e| NodeError::failed(format!("{}: {e}", loggable(&url))))?,
        };
        if !response.status().is_success() {
            return Err(NodeError::failed(format!("{} answered {}", loggable(&url), response.status())));
        }
        ctx.log(LogStream::Info, &format!("SSE open: {}", loggable(&url)));
        let max = max_messages(params);
        let only = text(params, "eventName");
        let until = text(params, "untilEvent");
        let mut decoder = crate::api::stream::Utf8Stream::default();
        let mut parser = crate::api::stream::SseParser::default();
        let mut received = Vec::new();
        'read: while max == 0 || received.len() < max {
            let chunk = tokio::select! {
                _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
                _ = tokio::time::sleep_until(deadline) => break,
                chunk = response.chunk() => chunk.map_err(|e| NodeError::failed(e.to_string()))?,
            };
            let Some(chunk) = chunk else { break };
            for event in parser.push(&decoder.push(&chunk)) {
                let name = if event.event.is_empty() { "message".to_string() } else { event.event.clone() };
                if !until.trim().is_empty() && name == until.trim() {
                    break 'read;
                }
                if !only.trim().is_empty() && name != only.trim() {
                    continue;
                }
                received.push(json!({"event": name, "data": payload_value(&event.data), "id": event.last_event_id}));
                if max > 0 && received.len() >= max {
                    break 'read;
                }
            }
        }
        Ok(received)
    })
}

// --------------------------------------------------------------------------------------- download

fn download<'a>(ctx: &'a NodeCtx, params: &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>> {
    Box::pin(async move {
        let mut headers = pairs(params, "headers");
        let mut query = Vec::new();
        apply_credential(ctx, &text(params, "credential"), &mut headers, &mut query)?;
        let url = build_url(&text(params, "url"), &query)?;
        let client = http_client(params)?;
        let send = client.get(url.clone()).headers(header_map(&headers)?).send();
        let mut response = tokio::select! {
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
            response = send => response.map_err(|e| NodeError::failed(format!("{}: {e}", loggable(&url))))?,
        };
        let status = response.status();
        if !status.is_success() {
            return Err(NodeError::failed(format!("{} answered {status}", loggable(&url))));
        }
        let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let disposition_name = response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split("filename=").nth(1))
            .map(|v| v.trim_matches(['"', '\'', ' ', ';']).to_string())
            .filter(|v| !v.is_empty() && !v.contains(['/', '\\']));
        let url_name = url.path_segments().and_then(|mut s| s.next_back()).filter(|s| !s.is_empty()).map(str::to_string);
        let chosen = text(params, "fileName");
        let name = if !chosen.trim().is_empty() {
            chosen.trim().to_string()
        } else {
            disposition_name.or(url_name).unwrap_or_else(|| "download".into())
        };
        if name.contains(['/', '\\']) || name == ".." {
            return Err(NodeError::failed("The file name must be a name, not a path"));
        }
        let folder = text(params, "folder");
        let folder = if folder.trim().is_empty() {
            let dir = ctx.run.host.work_dir().join(format!("downloads-{}", ctx.node.id));
            std::fs::create_dir_all(&dir).map_err(|e| NodeError::failed(e.to_string()))?;
            dir
        } else {
            expand(&folder)
        };
        std::fs::create_dir_all(&folder).map_err(|e| NodeError::failed(format!("Could not create {}: {e}", folder.display())))?;
        let target = folder.join(&name);
        if target.exists() && !flag(params, "overwrite") {
            return Err(NodeError::failed(format!("{} already exists (turn on «Overwrite»)", target.display())));
        }
        let temp = folder.join(format!(".{name}.cf-{}", uuid::Uuid::new_v4().simple()));
        let mut file = tokio::fs::File::create(&temp).await.map_err(|e| NodeError::failed(format!("Could not write {}: {e}", temp.display())))?;
        let mut size: u64 = 0;
        loop {
            let chunk = tokio::select! {
                _ = ctx.cancel.cancelled() => {
                    drop(file);
                    let _ = std::fs::remove_file(&temp);
                    return Err(NodeError::Cancelled);
                }
                chunk = response.chunk() => chunk,
            };
            match chunk {
                Ok(Some(bytes)) => {
                    size += bytes.len() as u64;
                    if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &bytes).await {
                        let _ = std::fs::remove_file(&temp);
                        return Err(NodeError::failed(format!("Could not write the download: {e}")));
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = std::fs::remove_file(&temp);
                    return Err(NodeError::failed(format!("The download broke off: {e}")));
                }
            }
        }
        let _ = tokio::io::AsyncWriteExt::flush(&mut file).await;
        drop(file);
        if target.exists() {
            let _ = trash::delete(&target);
        }
        std::fs::rename(&temp, &target).map_err(|e| NodeError::failed(format!("Could not save {}: {e}", target.display())))?;
        ctx.log(LogStream::Info, &format!("GET {} → {} ({size} bytes)", loggable(&url), target.display()));
        Ok(vec![json!({"file": describe(&target), "url": loggable(&url), "status": status.as_u16(), "contentType": content_type})])
    })
}

// ------------------------------------------------------------------------------------------ email

fn mailboxes(raw: &str) -> Result<Vec<lettre::message::Mailbox>, NodeError> {
    raw.split([',', ';'])
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .map(|address| address.parse::<lettre::message::Mailbox>().map_err(|e| NodeError::failed(format!("\"{address}\" is not an email address: {e}"))))
        .collect()
}

fn email<'a>(ctx: &'a NodeCtx, params: &'a Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>, NodeError>> + Send + 'a>> {
    Box::pin(async move {
        use lettre::message::{header::ContentType, Attachment, MultiPart, SinglePart};
        use lettre::transport::smtp::authentication::Credentials;
        use lettre::{AsyncSmtpTransport, AsyncTransport, Message as Mail, Tokio1Executor};

        let credential_id = text(params, "credential");
        if credential_id.trim().is_empty() {
            return Err(NodeError::failed("Pick the SMTP credential to send with"));
        }
        let credential = ctx.run.host.credential(credential_id.trim()).map_err(NodeError::Failed)?;
        if credential.kind != "smtp" {
            return Err(NodeError::failed("The credential is not an SMTP account"));
        }
        let meta = |key: &str| credential.meta.get(key).map(to_text).unwrap_or_default();
        let host = meta("host");
        if host.trim().is_empty() {
            return Err(NodeError::failed("The SMTP credential has no server"));
        }
        let from_text = {
            let written = text(params, "from");
            if written.trim().is_empty() { meta("from") } else { written }
        };
        let from = from_text.trim().parse::<lettre::message::Mailbox>().map_err(|e| NodeError::failed(format!("\"{from_text}\" is not a sender address: {e}")))?;
        let to = mailboxes(&text(params, "to"))?;
        if to.is_empty() {
            return Err(NodeError::failed("Write who the email goes to"));
        }
        let mut builder = Mail::builder().from(from).subject(text(params, "subject"));
        for mailbox in to.iter().cloned() {
            builder = builder.to(mailbox);
        }
        for mailbox in mailboxes(&text(params, "cc"))? {
            builder = builder.cc(mailbox);
        }
        for mailbox in mailboxes(&text(params, "bcc"))? {
            builder = builder.bcc(mailbox);
        }
        let reply_to = text(params, "replyTo");
        if !reply_to.trim().is_empty() {
            builder = builder.reply_to(reply_to.trim().parse().map_err(|e| NodeError::failed(format!("\"{reply_to}\" is not an address: {e}")))?);
        }
        let body = text(params, "body");
        let html = flag(params, "html");
        let body_part = if html { SinglePart::html(body.clone()) } else { SinglePart::plain(body.clone()) };
        let attachments = strings(params, "attachments");
        let message = if attachments.is_empty() {
            builder.singlepart(body_part)
        } else {
            let mut multipart = MultiPart::mixed().singlepart(body_part);
            for path in &attachments {
                let path = expand(path);
                let bytes = tokio::fs::read(&path).await.map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "attachment".into());
                let kind = ContentType::parse("application/octet-stream").expect("a valid content type");
                multipart = multipart.singlepart(Attachment::new(name).body(bytes, kind));
            }
            builder.multipart(multipart)
        }
        .map_err(|e| NodeError::failed(format!("The email could not be built: {e}")))?;

        let port = meta("port").trim().parse::<u16>().ok();
        let security = meta("security");
        let mut transport = match security.as_str() {
            "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(host.trim()),
            "none" => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host.trim())),
            _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host.trim()),
        }
        .map_err(|e| NodeError::failed(format!("Could not reach {host}: {e}")))?;
        if let Some(port) = port {
            transport = transport.port(port);
        }
        let user = meta("user");
        if !user.trim().is_empty() {
            transport = transport.credentials(Credentials::new(user.trim().to_string(), credential.secret.clone()));
        }
        let mailer = transport.timeout(Some(Duration::from_secs(30))).build();
        let sent = tokio::select! {
            sent = mailer.send(message) => sent.map_err(|e| NodeError::failed(format!("The SMTP server refused the email: {e}")))?,
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        let recipients: Vec<String> = to.iter().map(|m| m.email.to_string()).collect();
        ctx.log(LogStream::Info, &format!("Email sent to {}", recipients.join(", ")));
        Ok(vec![json!({"sent": true, "to": recipients, "response": sent.message().collect::<Vec<_>>().join(" ")})])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphql_types_read_as_written() {
        let non_null_list = json!({"kind": "NON_NULL", "ofType": {"kind": "LIST", "ofType": {"kind": "OBJECT", "name": "User"}}});
        assert_eq!(type_name(&non_null_list), "[User]!");
        assert_eq!(type_name(&json!({"kind": "SCALAR", "name": "Int"})), "Int");
        assert_eq!(payload_value("{\"a\":1}"), json!({"a": 1}));
        assert_eq!(payload_value("hola"), json!("hola"));
        assert!(mailboxes("Ana <ana@example.com>, bruno@example.com").unwrap().len() == 2);
        assert!(mailboxes("no es un correo").is_err());
    }
}
