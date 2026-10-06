//! «Mensaje en cola»: a flow run per message from RabbitMQ, Kafka or SQS, as it arrives.
//!
//! The Cola de mensajes node *takes* messages when a run reaches it; this trigger *waits* for them,
//! which is what a consumer is. Each broker in its own idiom:
//!
//! - **RabbitMQ** — `basic_consume` with a prefetch, so the broker pushes and a slow flow holds back
//!   the queue rather than draining it into memory.
//! - **Kafka** — the partition read from where the trigger last left it, the offset kept in the
//!   flow's state (`queue:<node>:<topic>:<partition>`); the first start begins at the end, so a
//!   flow switched on does not run once for every message of the topic's history.
//! - **SQS** — `ReceiveMessage` long-polled for 20 s, each message deleted once its run started.
//!
//! **Acknowledged when the run has started**, or — with «Confirmar al terminar bien» — only when it
//! finished well, a failure handing the message back. The second is one message at a time.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use super::TriggerView;
use crate::db::{flow_run_queries, Db};
use crate::flows::nodes::queue::{amqp_uri, body_of, sqs_region};
use crate::flows::run::Item;

fn text(params: &Value, name: &str) -> String {
    params.get(name).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// The trigger's credential: kind, `meta.user`, and the secret from the keychain.
fn credential(app: &AppHandle, params: &Value) -> Result<Option<(String, String, String)>, String> {
    let id = text(params, "credential");
    if id.is_empty() {
        return Ok(None);
    }
    let row = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_run_queries::get_credential(&conn, &id).map_err(|e| e.to_string())?.ok_or("The credential no longer exists")?
    };
    let secret = crate::secrets::get_secret(&crate::secrets::flow_credential_key(&id))?.ok_or("The credential has no secret stored")?;
    let user = row.meta.get("user").and_then(Value::as_str).unwrap_or_default().to_string();
    Ok(Some((row.kind, user, secret)))
}

/// Fires the flow for one message; with `wait`, until it finished, and whether it finished well.
async fn deliver(app: &AppHandle, flow_id: &str, node_id: &str, view: &Arc<Mutex<TriggerView>>, message: Value, wait: bool) -> bool {
    match super::fire_with(app, flow_id, node_id, vec![Item::new(message)], None, wait) {
        Ok(fired) => {
            super::note_problem(view, None);
            if fired.held {
                return false;
            }
            match (wait, fired.done) {
                (true, Some(done)) => matches!(done.await, Ok(finished) if finished.status == "success"),
                _ => true,
            }
        }
        Err(error) => {
            super::note_problem(view, Some(error));
            false
        }
    }
}

pub fn spawn(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    params: &Value,
    view: Arc<Mutex<TriggerView>>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let broker = text(params, "broker");
    match broker.as_str() {
        "kafka" if text(params, "brokers").is_empty() || text(params, "topic").is_empty() => return Err("write the brokers and the topic".into()),
        "sqs" if text(params, "queueUrl").is_empty() => return Err("write the queue's URL".into()),
        "rabbitmq" | "" if text(params, "amqpUrl").is_empty() || text(params, "queueName").is_empty() => {
            return Err("write the broker's address and the queue".into())
        }
        _ => {}
    }
    let (app, flow_id, node_id, params) = (app.clone(), flow_id.to_string(), node_id.to_string(), params.clone());
    tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(1);
        loop {
            if cancel.is_cancelled() {
                return;
            }
            let started = Instant::now();
            let outcome = match broker.as_str() {
                "kafka" => kafka(&app, &flow_id, &node_id, &params, &view, cancel.clone()).await,
                "sqs" => sqs(&app, &flow_id, &node_id, &params, &view, cancel.clone()).await,
                _ => rabbit(&app, &flow_id, &node_id, &params, &view, cancel.clone()).await,
            };
            if cancel.is_cancelled() {
                return;
            }
            super::note_problem(&view, Some(outcome.err().unwrap_or_else(|| "The connection was closed — reconnecting".to_string())));
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

fn ack_on_success(params: &Value) -> bool {
    params.get("ackOnSuccess").and_then(Value::as_bool).unwrap_or(false)
}

async fn rabbit(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: &Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    use lapin::options::{BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicQosOptions};
    use lapin::types::{FieldTable, ShortString};
    use lapin::{Connection, ConnectionProperties};

    let login = credential(app, params)?.map(|(_, user, secret)| (user, secret));
    let uri = amqp_uri(&text(params, "amqpUrl"), login.as_ref())?;
    let connection = tokio::time::timeout(Duration::from_secs(20), Connection::connect(&uri, ConnectionProperties::default()))
        .await
        .map_err(|_| "The broker did not answer in 20 s".to_string())?
        .map_err(|e| format!("Could not connect to the broker: {e}"))?;
    let channel = connection.create_channel().await.map_err(|e| e.to_string())?;
    let wait = ack_on_success(params);
    channel.basic_qos(if wait { 1 } else { 10 }, BasicQosOptions::default()).await.map_err(|e| e.to_string())?;
    let queue = text(params, "queueName");
    let mut consumer = channel
        .basic_consume(ShortString::from(queue.as_str()), ShortString::from(format!("codeflow-{node_id}")), BasicConsumeOptions::default(), FieldTable::default())
        .await
        .map_err(|e| format!("{queue}: {e}"))?;
    super::note_problem(view, None);
    loop {
        let next = tokio::select! {
            next = consumer.next() => next,
            _ = cancel.cancelled() => {
                let _ = connection.close(200, ShortString::from("bye")).await;
                return Ok(());
            }
        };
        let Some(delivery) = next else { return Ok(()) };
        let delivery = delivery.map_err(|e| format!("{queue}: {e}"))?;
        let message = json!({
            "broker": "rabbitmq",
            "queue": queue,
            "body": body_of(&delivery.data),
            "routingKey": delivery.routing_key.as_str(),
            "exchange": delivery.exchange.as_str(),
            "redelivered": delivery.redelivered,
        });
        if deliver(app, flow_id, node_id, view, message, wait).await {
            delivery.acker.ack(BasicAckOptions::default()).await.map_err(|e| e.to_string())?;
        } else {
            // Back on the queue for another try — after a pause, so a flow failing on it does not spin.
            tokio::time::sleep(Duration::from_secs(2)).await;
            delivery.acker.nack(BasicNackOptions { requeue: true, ..Default::default() }).await.map_err(|e| e.to_string())?;
        }
    }
}

async fn kafka(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: &Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    use rskafka::client::partition::{OffsetAt, UnknownTopicHandling};
    use rskafka::client::{ClientBuilder, Credentials, SaslConfig};

    let brokers: Vec<String> = text(params, "brokers").split(',').map(|b| b.trim().to_string()).filter(|b| !b.is_empty()).collect();
    let mut builder = ClientBuilder::new(brokers).client_id("codeflow-flujos");
    if params.get("tls").and_then(Value::as_bool).unwrap_or(false) {
        let mut roots = rustls::RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        builder = builder.tls_config(Arc::new(config));
    }
    if let Some((_, user, password)) = credential(app, params)? {
        let login = Credentials::new(user, password);
        builder = builder.sasl_config(match text(params, "saslMechanism").as_str() {
            "scramSha256" => SaslConfig::ScramSha256(login),
            "scramSha512" => SaslConfig::ScramSha512(login),
            _ => SaslConfig::Plain(login),
        });
    }
    let client = tokio::time::timeout(Duration::from_secs(20), builder.build())
        .await
        .map_err(|_| "Kafka did not answer in 20 s".to_string())?
        .map_err(|e| format!("Could not connect to Kafka: {e}"))?;
    let topic = text(params, "topic");
    let partition = params.get("partition").and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as i32;
    let reader = client.partition_client(topic.clone(), partition, UnknownTopicHandling::Error).await.map_err(|e| format!("{topic}/{partition}: {e}"))?;
    let key = format!("queue:{node_id}:{topic}:{partition}");
    let load = || {
        let db = app.state::<Db>();
        let conn = db.0.lock().ok()?;
        flow_run_queries::state_get(&conn, flow_id, &key).ok().flatten().and_then(|v| v.as_i64())
    };
    let save = |offset: i64| {
        let db = app.state::<Db>();
        let conn = db.0.lock();
        if let Ok(conn) = conn {
            let _ = flow_run_queries::state_set(&conn, flow_id, &key, &json!(offset), &crate::flows::engine::now_text());
        }
    };
    let mut offset = match load() {
        Some(offset) => offset,
        None => {
            let at = if text(params, "startFrom") == "earliest" { OffsetAt::Earliest } else { OffsetAt::Latest };
            let start = reader.get_offset(at).await.map_err(|e| e.to_string())?;
            save(start);
            start
        }
    };
    super::note_problem(view, None);
    let wait = ack_on_success(params);
    loop {
        let fetched = tokio::select! {
            fetched = reader.fetch_records(offset, 1..1_000_000, 5_000) => fetched,
            _ = cancel.cancelled() => return Ok(()),
        };
        let (records, _high) = fetched.map_err(|e| format!("{topic}/{partition}: {e}"))?;
        for record in records {
            let value = record.record.value.as_deref().map(body_of).unwrap_or(Value::Null);
            let message = json!({
                "broker": "kafka",
                "topic": topic,
                "partition": partition,
                "offset": record.offset,
                "key": record.record.key.as_deref().map(|k| String::from_utf8_lossy(k).into_owned()),
                "body": value,
                "timestamp": record.record.timestamp.to_rfc3339(),
            });
            if !deliver(app, flow_id, node_id, view, message, wait).await && wait {
                // Not committed: read again after a pause.
                tokio::time::sleep(Duration::from_secs(2)).await;
                break;
            }
            offset = record.offset + 1;
            save(offset);
        }
    }
}

async fn sqs(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: &Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let Some((kind, access_key, secret)) = credential(app, params)? else { return Err("choose the AWS credential".into()) };
    if kind != "aws" {
        return Err("SQS signs in with an AWS credential".into());
    }
    let queue_url = text(params, "queueUrl");
    let region = sqs_region(&queue_url).ok_or("The queue URL does not say its region")?;
    let call = |action: &'static str, body: Value| {
        let (queue_url, region, access_key, secret) = (queue_url.clone(), region.clone(), access_key.clone(), secret.clone());
        async move {
            let queue = url::Url::parse(&queue_url).map_err(|e| e.to_string())?;
            let mut endpoint = queue.clone();
            endpoint.set_path("/");
            endpoint.set_query(None);
            let payload = body.to_string();
            let headers = vec![("content-type".to_string(), "application/x-amz-json-1.0".to_string()), ("x-amz-target".to_string(), format!("AmazonSQS.{action}"))];
            let signed = crate::sigv4::sigv4_headers(
                "POST",
                &endpoint,
                &headers,
                &crate::sigv4::hex_sha256(payload.as_bytes()),
                &access_key,
                &secret,
                "",
                &region,
                "sqs",
                &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
            )?;
            let mut request = reqwest::Client::new().post(endpoint.as_str()).timeout(Duration::from_secs(40)).body(payload);
            for (name, value) in headers.into_iter().chain(signed) {
                request = request.header(name, value);
            }
            let response = request.send().await.map_err(|e| format!("SQS could not be reached: {e}"))?;
            let status = response.status();
            let text = response.text().await.map_err(|e| e.to_string())?;
            let answer: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if !status.is_success() {
                return Err(format!("SQS answered {}: {}", status.as_u16(), answer.get("message").or_else(|| answer.get("Message")).and_then(Value::as_str).unwrap_or(&text)));
            }
            Ok::<Value, String>(answer)
        }
    };
    super::note_problem(view, None);
    let wait = ack_on_success(params);
    loop {
        let received = tokio::select! {
            received = call("ReceiveMessage", json!({"QueueUrl": queue_url, "MaxNumberOfMessages": 10, "WaitTimeSeconds": 20, "MessageAttributeNames": ["All"]})) => received?,
            _ = cancel.cancelled() => return Ok(()),
        };
        for message in received.get("Messages").and_then(Value::as_array).cloned().unwrap_or_default() {
            let receipt = message.get("ReceiptHandle").and_then(Value::as_str).unwrap_or_default().to_string();
            let item = json!({
                "broker": "sqs",
                "queue": queue_url,
                "messageId": message.get("MessageId"),
                "body": body_of(message.get("Body").and_then(Value::as_str).unwrap_or_default().as_bytes()),
                "attributes": message.get("MessageAttributes").cloned().unwrap_or(Value::Null),
            });
            if deliver(app, flow_id, node_id, view, item, wait).await {
                call("DeleteMessage", json!({"QueueUrl": queue_url, "ReceiptHandle": receipt})).await?;
            }
            // Not deleted: SQS hands it out again when its visibility timeout runs out.
        }
    }
}
