//! The Queue node: publish to, or take messages from, RabbitMQ (AMQP 0.9.1), Kafka or Amazon SQS —
//! the brokers a flow most often sits between, next to MQTT (its own node).
//!
//! **Taking is a read with a receipt.** A RabbitMQ message is acknowledged, an SQS one deleted, once
//! it is an item — unless the node is told to leave it, and then it goes back to the queue. Kafka
//! has no receipts: the node keeps its own offset per topic and partition in the flow's state, so a
//! scheduled flow continues where its last run stopped.
//!
//! **SQS speaks its JSON protocol**, signed with the app's one SigV4 (`crate::sigv4`); the queue's
//! URL says which region, and an `aws` credential holds the access key.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::{flag, number, pairs, text, NodeCtx, NodeError};
use crate::flows::engine::{Credential, LogStream};
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let once = ctx.param_str("runFor") == "once";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let credential = match ctx.param_str("credential") {
        id if id.trim().is_empty() => None,
        id => Some(ctx.credential(id.trim()).await?),
    };
    let work = async {
        match ctx.param_str("broker").as_str() {
            "kafka" => kafka(ctx, &resolved, credential.as_ref()).await,
            "sqs" => sqs(ctx, &resolved, credential.as_ref()).await,
            _ => rabbit(ctx, &resolved, credential.as_ref()).await,
        }
    };
    let answers = tokio::select! {
        answers = work => answers?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    let paired = !ctx.items().is_empty();
    Ok(vec![answers.into_iter().map(|(index, json)| if paired { Item::paired(json, index) } else { Item::new(json) }).collect()])
}

/// A message's text as an item reads it: JSON when it is JSON, the text otherwise.
pub fn body_of(bytes: &[u8]) -> Value {
    let text = String::from_utf8_lossy(bytes).into_owned();
    match serde_json::from_str::<Value>(&text) {
        Ok(value) if text.trim_start().starts_with(['{', '[']) => value,
        _ => Value::String(text),
    }
}

fn is_json(text: &str) -> bool {
    text.trim_start().starts_with(['{', '[']) && serde_json::from_str::<Value>(text).is_ok()
}

fn limit_of(params: &Value, fallback: usize) -> usize {
    number(params, "messageLimit").map(|n| n.max(1.0) as usize).unwrap_or(fallback)
}

fn user_and_password(credential: Option<&Credential>) -> Result<Option<(String, String)>, NodeError> {
    match credential {
        None => Ok(None),
        Some(c) if c.kind == "basic" => Ok(Some((c.meta.get("user").and_then(Value::as_str).unwrap_or_default().to_string(), c.secret.clone()))),
        Some(c) => Err(NodeError::failed(format!("This broker signs in with a user and password, not a {} credential", c.kind))),
    }
}

// --------------------------------------------------------------------------------------- RabbitMQ

/// The broker's address with the credential's user and password in it (never in the parameter).
pub fn amqp_uri(raw: &str, login: Option<&(String, String)>) -> Result<String, String> {
    let mut url = url::Url::parse(raw.trim()).map_err(|e| format!("\"{raw}\" is not an AMQP address: {e}"))?;
    if !matches!(url.scheme(), "amqp" | "amqps") {
        return Err(format!("\"{raw}\" is not an amqp:// or amqps:// address"));
    }
    if let Some((user, password)) = login {
        url.set_username(user).map_err(|_| "The user cannot go in that address".to_string())?;
        url.set_password(Some(password)).map_err(|_| "The password cannot go in that address".to_string())?;
    }
    Ok(url.to_string())
}

async fn rabbit(ctx: &NodeCtx, resolved: &[Value], credential: Option<&Credential>) -> Result<Vec<(usize, Value)>, NodeError> {
    use lapin::options::{BasicAckOptions, BasicGetOptions, BasicNackOptions, BasicPublishOptions, ConfirmSelectOptions};
    use lapin::types::{AMQPValue, FieldTable, LongString, ShortString};
    use lapin::{BasicProperties, Confirmation, Connection, ConnectionProperties};

    let login = user_and_password(credential)?;
    let first = resolved.first().cloned().unwrap_or(Value::Null);
    let uri = amqp_uri(&text(&first, "amqpUrl"), login.as_ref()).map_err(NodeError::Failed)?;
    if let Some((_, password)) = &login {
        ctx.run.host.secret_used(password);
    }
    let connection = tokio::time::timeout(Duration::from_secs(20), Connection::connect(&uri, ConnectionProperties::default()))
        .await
        .map_err(|_| NodeError::failed("The broker did not answer in 20 s"))?
        .map_err(|e| NodeError::failed(format!("Could not connect to the broker: {e}")))?;
    let channel = connection.create_channel().await.map_err(|e| NodeError::failed(e.to_string()))?;
    let mut out = Vec::new();
    let result: Result<(), NodeError> = async {
        if ctx.param_str("queueOp") == "queueReceive" {
            for (index, params) in resolved.iter().enumerate() {
                let queue = text(params, "queueName");
                if queue.is_empty() {
                    return Err(NodeError::failed("Write the queue to take messages from"));
                }
                let keep = flag(params, "leaveInQueue");
                // Held until the end: a message handed back at once would be the next one read.
                let mut held = Vec::new();
                for _ in 0..limit_of(params, 10) {
                    let got = channel
                        .basic_get(ShortString::from(queue.as_str()), BasicGetOptions { no_ack: false })
                        .await
                        .map_err(|e| NodeError::failed(format!("{queue}: {e}")))?;
                    let Some(message) = got else { break };
                    let delivery = &message.delivery;
                    let mut headers = Map::new();
                    if let Some(table) = delivery.properties.headers() {
                        for (key, value) in table.inner() {
                            let shown = match value {
                                AMQPValue::LongString(s) => json!(String::from_utf8_lossy(s.as_bytes())),
                                AMQPValue::ShortString(s) => json!(s.as_str()),
                                other => json!(format!("{other:?}")),
                            };
                            headers.insert(key.to_string(), shown);
                        }
                    }
                    out.push((
                        index,
                        json!({
                            "broker": "rabbitmq",
                            "queue": queue,
                            "body": body_of(&delivery.data),
                            "routingKey": delivery.routing_key.as_str(),
                            "exchange": delivery.exchange.as_str(),
                            "redelivered": delivery.redelivered,
                            "headers": headers,
                            "remaining": message.message_count,
                        }),
                    ));
                    if keep {
                        held.push(message);
                    } else {
                        delivery.acker.ack(BasicAckOptions::default()).await.map_err(|e| NodeError::failed(e.to_string()))?;
                    }
                }
                for message in held {
                    message.delivery.acker.nack(BasicNackOptions { requeue: true, ..Default::default() }).await.map_err(|e| NodeError::failed(e.to_string()))?;
                }
            }
            return Ok(());
        }
        channel.confirm_select(ConfirmSelectOptions::default()).await.map_err(|e| NodeError::failed(e.to_string()))?;
        for (index, params) in resolved.iter().enumerate() {
            let exchange = text(params, "exchange");
            let routing_key = text(params, "routingKey");
            if exchange.is_empty() && routing_key.is_empty() {
                return Err(NodeError::failed("Write the queue (as the routing key) or the exchange to publish to"));
            }
            let message = params.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
            let mut properties = BasicProperties::default()
                .with_content_type(ShortString::from(if is_json(&message) { "application/json" } else { "text/plain" }))
                .with_delivery_mode(if flag(params, "persistent") { 2 } else { 1 });
            let headers = pairs(params, "messageHeaders");
            if !headers.is_empty() {
                let mut table = FieldTable::default();
                for (key, value) in headers {
                    table.insert(ShortString::from(key), AMQPValue::LongString(LongString::from(value)));
                }
                properties = properties.with_headers(table);
            }
            // Mandatory: a message no queue takes comes back, instead of vanishing.
            let options = BasicPublishOptions { mandatory: true, ..Default::default() };
            let confirm = channel
                .basic_publish(ShortString::from(exchange.as_str()), ShortString::from(routing_key.as_str()), options, message.as_bytes(), properties)
                .await
                .map_err(|e| NodeError::failed(format!("Publishing failed: {e}")))?
                .await
                .map_err(|e| NodeError::failed(format!("Publishing failed: {e}")))?;
            match confirm {
                Confirmation::Nack(_) => return Err(NodeError::failed("The broker refused the message (nack)")),
                Confirmation::Ack(Some(_)) => {
                    return Err(NodeError::failed(format!("No queue took the message — nothing is bound to \"{routing_key}\" on {}", if exchange.is_empty() { "the default exchange" } else { exchange.as_str() })))
                }
                _ => {}
            }
            out.push((index, json!({"broker": "rabbitmq", "published": true, "exchange": exchange, "routingKey": routing_key, "bytes": message.len()})));
        }
        Ok(())
    }
    .await;
    let _ = channel.close(200, ShortString::from("done")).await;
    let _ = connection.close(200, ShortString::from("done")).await;
    result?;
    ctx.log(LogStream::Info, &format!("RabbitMQ: {} message(s)", out.len()));
    Ok(out)
}

// ------------------------------------------------------------------------------------------ Kafka

/// The node's offset for a topic's partition, in the flow's state.
fn offset_key(node: &str, topic: &str, partition: i32) -> String {
    format!("kafka:{node}:{topic}:{partition}")
}

async fn kafka(ctx: &NodeCtx, resolved: &[Value], credential: Option<&Credential>) -> Result<Vec<(usize, Value)>, NodeError> {
    use rskafka::client::partition::{Compression, OffsetAt, UnknownTopicHandling};
    use rskafka::client::{ClientBuilder, Credentials, SaslConfig};
    use rskafka::record::Record;

    let first = resolved.first().cloned().unwrap_or(Value::Null);
    let brokers: Vec<String> = text(&first, "brokers").split(',').map(|b| b.trim().to_string()).filter(|b| !b.is_empty()).collect();
    if brokers.is_empty() {
        return Err(NodeError::failed("Write the Kafka brokers, like kafka.example.com:9092"));
    }
    let mut builder = ClientBuilder::new(brokers).client_id("codeflow-flujos");
    if flag(&first, "tls") {
        let mut roots = rustls::RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| NodeError::failed(e.to_string()))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        builder = builder.tls_config(Arc::new(config));
    }
    if let Some((user, password)) = user_and_password(credential)? {
        ctx.run.host.secret_used(&password);
        let login = Credentials::new(user, password);
        builder = builder.sasl_config(match text(&first, "saslMechanism").as_str() {
            "scramSha256" => SaslConfig::ScramSha256(login),
            "scramSha512" => SaslConfig::ScramSha512(login),
            _ => SaslConfig::Plain(login),
        });
    }
    let client = tokio::time::timeout(Duration::from_secs(20), builder.build())
        .await
        .map_err(|_| NodeError::failed("Kafka did not answer in 20 s"))?
        .map_err(|e| NodeError::failed(format!("Could not connect to Kafka: {e}")))?;
    let topic = text(&first, "topic");
    if topic.is_empty() {
        return Err(NodeError::failed("Write the topic"));
    }
    let partition = number(&first, "partition").unwrap_or(0.0).max(0.0) as i32;
    let partition_client = client
        .partition_client(topic.clone(), partition, UnknownTopicHandling::Error)
        .await
        .map_err(|e| NodeError::failed(format!("{topic}/{partition}: {e}")))?;

    let mut out = Vec::new();
    if ctx.param_str("queueOp") == "queueReceive" {
        let continue_from_last = text(&first, "startFrom") != "earliest";
        let key = offset_key(&ctx.node.id, &topic, partition);
        let stored = if continue_from_last { ctx.run.host.state_get(&key).map_err(NodeError::Failed)?.and_then(|v| v.as_i64()) } else { None };
        let mut offset = match stored {
            Some(offset) => offset,
            None => partition_client.get_offset(OffsetAt::Earliest).await.map_err(|e| NodeError::failed(e.to_string()))?,
        };
        let limit = limit_of(&first, 10);
        while out.len() < limit {
            let (records, high_watermark) = partition_client
                .fetch_records(offset, 1..5_000_000, 1_000)
                .await
                .map_err(|e| NodeError::failed(format!("Reading {topic} failed: {e}")))?;
            if records.is_empty() {
                break;
            }
            for record in records {
                if out.len() >= limit {
                    break;
                }
                offset = record.offset + 1;
                let headers: Map<String, Value> =
                    record.record.headers.iter().map(|(k, v)| (k.clone(), json!(String::from_utf8_lossy(v)))).collect();
                out.push((
                    0,
                    json!({
                        "broker": "kafka",
                        "topic": topic,
                        "partition": partition,
                        "offset": record.offset,
                        "key": record.record.key.as_deref().map(|k| String::from_utf8_lossy(k).into_owned()),
                        "body": record.record.value.as_deref().map(body_of).unwrap_or(Value::Null),
                        "headers": headers,
                        "timestamp": record.record.timestamp.to_rfc3339(),
                    }),
                ));
            }
            if offset >= high_watermark {
                break;
            }
        }
        if continue_from_last {
            ctx.run.host.state_set(&key, Some(&json!(offset))).map_err(NodeError::Failed)?;
        }
        ctx.log(LogStream::Info, &format!("Kafka {topic}/{partition}: {} record(s), next offset {offset}", out.len()));
        return Ok(out);
    }

    let mut records = Vec::new();
    for params in resolved {
        let message = params.get("message").and_then(Value::as_str).unwrap_or_default();
        let key = text(params, "messageKey");
        let headers: BTreeMap<String, Vec<u8>> = pairs(params, "messageHeaders").into_iter().map(|(k, v)| (k, v.into_bytes())).collect();
        records.push(Record {
            key: (!key.is_empty()).then(|| key.into_bytes()),
            value: Some(message.as_bytes().to_vec()),
            headers,
            timestamp: rskafka::chrono::Utc::now(),
        });
    }
    let offsets = partition_client.produce(records, Compression::NoCompression).await.map_err(|e| NodeError::failed(format!("Publishing to {topic} failed: {e}")))?;
    for (index, offset) in offsets.into_iter().enumerate() {
        out.push((index, json!({"broker": "kafka", "published": true, "topic": topic, "partition": partition, "offset": offset})));
    }
    ctx.log(LogStream::Info, &format!("Kafka {topic}/{partition}: {} record(s) published", out.len()));
    Ok(out)
}

// -------------------------------------------------------------------------------------------- SQS

/// The region in an SQS queue URL (`https://sqs.<region>.amazonaws.com/<account>/<queue>`).
pub fn sqs_region(queue_url: &str) -> Option<String> {
    let host = url::Url::parse(queue_url).ok()?.host_str()?.to_string();
    let mut labels = host.split('.');
    match (labels.next(), labels.next()) {
        (Some("sqs"), Some(region)) if region != "amazonaws" => Some(region.to_string()),
        (Some(region), Some("queue")) => Some(region.to_string()),
        _ => None,
    }
}

async fn sqs_call(ctx: &NodeCtx, credential: &Credential, region: &str, queue_url: &str, action: &str, body: Value) -> Result<Value, NodeError> {
    let queue = url::Url::parse(queue_url).map_err(|e| NodeError::failed(format!("\"{queue_url}\" is not a queue URL: {e}")))?;
    let mut endpoint = queue.clone();
    endpoint.set_path("/");
    endpoint.set_query(None);
    let payload = body.to_string();
    let headers = vec![("content-type".to_string(), "application/x-amz-json-1.0".to_string()), ("x-amz-target".to_string(), format!("AmazonSQS.{action}"))];
    let access_key = credential.meta.get("user").and_then(Value::as_str).unwrap_or_default();
    let signed = crate::sigv4::sigv4_headers(
        "POST",
        &endpoint,
        &headers,
        &crate::sigv4::hex_sha256(payload.as_bytes()),
        access_key,
        &credential.secret,
        "",
        region,
        "sqs",
        &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
    )
    .map_err(NodeError::Failed)?;
    let mut request = reqwest::Client::new().post(endpoint.as_str()).timeout(Duration::from_secs(40)).body(payload);
    for (name, value) in headers.into_iter().chain(signed) {
        request = request.header(name, value);
    }
    let started = std::time::Instant::now();
    let response = request.send().await.map_err(|e| NodeError::failed(format!("SQS could not be reached: {e}")))?;
    let status = response.status();
    ctx.log(LogStream::Info, &format!("SQS {action} → {} ({} ms)", status.as_u16(), started.elapsed().as_millis()));
    let text = response.text().await.map_err(|e| NodeError::failed(e.to_string()))?;
    let answer: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let kind = answer.get("__type").and_then(Value::as_str).unwrap_or_default().rsplit('#').next().unwrap_or_default().to_string();
        let message = answer.get("message").or_else(|| answer.get("Message")).and_then(Value::as_str).unwrap_or(text.as_str()).to_string();
        return Err(NodeError::failed(format!("SQS answered {}: {kind} {message}", status.as_u16()).trim().to_string()));
    }
    Ok(answer)
}

async fn sqs(ctx: &NodeCtx, resolved: &[Value], credential: Option<&Credential>) -> Result<Vec<(usize, Value)>, NodeError> {
    let credential = match credential {
        Some(c) if c.kind == "aws" => c,
        Some(c) => return Err(NodeError::failed(format!("SQS signs with an AWS credential, not a {} one", c.kind))),
        None => return Err(NodeError::failed("Pick the AWS credential")),
    };
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let queue_url = text(params, "queueUrl");
        if queue_url.is_empty() {
            return Err(NodeError::failed("Write the queue's URL"));
        }
        let region = sqs_region(&queue_url)
            .or_else(|| credential.meta.get("region").and_then(Value::as_str).filter(|r| !r.is_empty()).map(str::to_string))
            .unwrap_or_else(|| "us-east-1".into());
        if ctx.param_str("queueOp") == "queueReceive" {
            let wait = number(params, "waitSeconds").unwrap_or(0.0).clamp(0.0, 20.0) as u64;
            let answer = sqs_call(
                ctx,
                credential,
                &region,
                &queue_url,
                "ReceiveMessage",
                json!({"QueueUrl": queue_url, "MaxNumberOfMessages": limit_of(params, 10).min(10), "WaitTimeSeconds": wait, "MessageAttributeNames": ["All"], "MessageSystemAttributeNames": ["All"]}),
            )
            .await?;
            let keep = flag(params, "leaveInQueue");
            for message in answer.get("Messages").and_then(Value::as_array).cloned().unwrap_or_default() {
                let receipt = message.get("ReceiptHandle").and_then(Value::as_str).unwrap_or_default().to_string();
                let attributes: Map<String, Value> = message
                    .get("MessageAttributes")
                    .and_then(Value::as_object)
                    .map(|map| map.iter().map(|(k, v)| (k.clone(), v.get("StringValue").cloned().unwrap_or(Value::Null))).collect())
                    .unwrap_or_default();
                out.push((
                    index,
                    json!({
                        "broker": "sqs",
                        "messageId": message.get("MessageId"),
                        "body": body_of(message.get("Body").and_then(Value::as_str).unwrap_or_default().as_bytes()),
                        "attributes": attributes,
                        "system": message.get("Attributes"),
                        "receiptHandle": receipt,
                    }),
                ));
                if !keep {
                    sqs_call(ctx, credential, &region, &queue_url, "DeleteMessage", json!({"QueueUrl": queue_url, "ReceiptHandle": receipt})).await?;
                }
            }
            continue;
        }
        let message = params.get("message").and_then(Value::as_str).unwrap_or_default();
        let mut body = json!({"QueueUrl": queue_url, "MessageBody": message});
        let group = text(params, "messageGroupId");
        if !group.is_empty() {
            body["MessageGroupId"] = json!(group);
            // FIFO queues want a deduplication id unless content-based deduplication is on.
            body["MessageDeduplicationId"] = json!(uuid::Uuid::new_v4().to_string());
        }
        let attributes: Map<String, Value> = pairs(params, "messageHeaders").into_iter().map(|(k, v)| (k, json!({"DataType": "String", "StringValue": v}))).collect();
        if !attributes.is_empty() {
            body["MessageAttributes"] = Value::Object(attributes);
        }
        let answer = sqs_call(ctx, credential, &region, &queue_url, "SendMessage", body).await?;
        out.push((index, json!({"broker": "sqs", "published": true, "messageId": answer.get("MessageId"), "sequenceNumber": answer.get("SequenceNumber")})));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_read_as_json_only_when_they_are() {
        assert_eq!(body_of(br#"{"id": 3}"#), json!({"id": 3}));
        assert_eq!(body_of(b"42"), json!("42"));
        assert_eq!(body_of(b"hola"), json!("hola"));
    }

    #[test]
    fn the_amqp_address_takes_the_credential_and_nothing_else() {
        let uri = amqp_uri("amqp://rabbit.example.com:5672/%2f", Some(&("ana".into(), "p@ss/word".into()))).unwrap();
        assert_eq!(uri, "amqp://ana:p%40ss%2Fword@rabbit.example.com:5672/%2f");
        assert!(amqp_uri("http://rabbit.example.com", None).is_err());
    }

    #[test]
    fn the_region_is_read_from_the_queue_url() {
        assert_eq!(sqs_region("https://sqs.sa-east-1.amazonaws.com/123456789012/pedidos").as_deref(), Some("sa-east-1"));
        assert_eq!(sqs_region("https://eu-west-1.queue.amazonaws.com/1/q").as_deref(), Some("eu-west-1"));
        assert_eq!(sqs_region("http://localhost:4566/000000000000/q"), None);
        assert_eq!(offset_key("n1", "pedidos", 0), "kafka:n1:pedidos:0");
    }
}
