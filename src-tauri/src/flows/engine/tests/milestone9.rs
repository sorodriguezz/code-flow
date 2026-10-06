//! Hito 9 — external integrations: OAuth 2 credentials, AI over APIs, embeddings and the vector
//! store, against loopback servers that answer like the providers; and the errors that name what a
//! Google or queue node is missing.
//!
//! The `#[ignore]`d tests at the end need real services, in containers on fixed ports:
//!
//! ```text
//! docker run -d --rm --name cf-greenmail -p 53143:3143 -p 53025:3025 \
//!   -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled' greenmail/standalone:2.1.3
//! docker run -d --rm --name cf-rabbit -p 55672:5672 -e RABBITMQ_DEFAULT_USER=flujos -e RABBITMQ_DEFAULT_PASS=flujos rabbitmq:4-alpine
//! docker run -d --rm --name cf-kafka -p 59092:9092 -e KAFKA_NODE_ID=1 -e KAFKA_PROCESS_ROLES=broker,controller \
//!   -e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093 -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:59092 \
//!   -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT \
//!   -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
//!   -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 apache/kafka:4.1.0
//! docker run -d --rm --name cf-sqs -p 59324:9324 softwaremill/elasticmq-native
//! docker run -d --rm --name cf-qdrant -p 56333:6333 qdrant/qdrant:v1.15.0
//! cargo test --lib flows::engine::tests::milestone9 -- --ignored
//! ```

use super::*;

/// One request as the loopback server saw it.
#[derive(Debug, Clone)]
struct Seen {
    target: String,
    headers: String,
    body: String,
}

/// A loopback server that reads each request whole (its body included) and answers with what
/// `answer` returns for it; every request is kept in `seen`.
async fn serve(answer: fn(&Seen) -> String) -> (u16, Arc<Mutex<Vec<Seen>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let log = log.clone();
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = vec![0u8; 16 * 1024];
                let (head, body_start, length) = loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buffer).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let head = text[..end].to_string();
                        let length = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        break (head, end + 4, length);
                    }
                };
                while buffer.len() < body_start + length {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                }
                let seen = Seen {
                    target: head.split_whitespace().nth(1).unwrap_or("/").to_string(),
                    headers: head.clone(),
                    body: String::from_utf8_lossy(&buffer[body_start..]).to_string(),
                };
                let body = answer(&seen);
                log.lock().unwrap().push(seen);
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (port, seen)
}

fn one(type_id: &str, params: Value) -> FlowSpec {
    flow(vec![node("start", "trigger.manual", json!({})), node("it", type_id, params)], vec![wire("start", 0, "it", 0)])
}

fn echo_headers(seen: &Seen) -> String {
    json!({"headers": seen.headers}).to_string()
}

#[tokio::test]
async fn an_oauth_credential_signs_a_request_with_a_fresh_token() {
    let (port, _) = serve(echo_headers).await;
    let ran = run(one("net.http", json!({"url": format!("http://127.0.0.1:{port}/me"), "credential": "oauth"}))).await;
    assert_eq!(ran.status("it"), NodeStatus::Success, "{:?}", ran.report("it").error);
    let headers = ran.output("it", 0)[0]["headers"].as_str().unwrap_or_default().to_ascii_lowercase();
    assert!(headers.contains("authorization: bearer ya29.fresh"), "{headers}");
}

fn chat_answer(seen: &Seen) -> String {
    let asked: Value = serde_json::from_str(&seen.body).unwrap_or(Value::Null);
    assert_eq!(asked["model"], "modelo-x");
    json!({
        "model": "modelo-x-2026",
        "choices": [{"message": {"content": "{\"total\": 3, \"sobra\": true}"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 4}
    })
    .to_string()
}

#[tokio::test]
async fn the_api_chat_node_asks_a_compatible_server_and_holds_the_answer_to_its_schema() {
    let (port, seen) = serve(chat_answer).await;
    let ran = run(one(
        "ai.api",
        json!({
            "apiProvider": "compatible",
            "baseUrl": format!("http://127.0.0.1:{port}/v1"),
            "credential": "token",
            "apiModel": "modelo-x",
            "prompt": "Cuenta los pedidos",
            "output": "json",
            "schemaFields": [{"name": "total", "type": "number", "description": "", "required": true}],
            "maxTokens": 64,
        }),
    ))
    .await;
    assert_eq!(ran.status("it"), NodeStatus::Success, "{:?}", ran.report("it").error);
    let out = &ran.output("it", 0)[0];
    // Pruned to the schema: what it did not ask for is gone.
    assert_eq!(out["data"], json!({"total": 3}));
    assert_eq!((out["model"].as_str(), out["usage"]["inputTokens"].as_u64()), (Some("modelo-x-2026"), Some(12)));
    let request = seen.lock().unwrap()[0].clone();
    assert_eq!(request.target, "/v1/chat/completions");
    assert!(request.headers.to_ascii_lowercase().contains("authorization: bearer s3cret"));
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body["max_tokens"], 64);
    assert!(body["messages"][0]["content"].as_str().unwrap().contains("JSON Schema"));
}

/// Embeddings that put "gato" texts and "perro" texts on different axes.
fn embeddings(seen: &Seen) -> String {
    let asked: Value = serde_json::from_str(&seen.body).unwrap_or(Value::Null);
    let data: Vec<Value> = asked["input"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, text)| {
            let text = text.as_str().unwrap_or_default().to_lowercase();
            let vector = [if text.contains("gato") { 1.0 } else { 0.0 }, if text.contains("perro") { 1.0 } else { 0.0 }, 0.1];
            json!({"index": index, "embedding": vector})
        })
        .collect();
    json!({"data": data}).to_string()
}

#[tokio::test]
async fn documents_are_stored_and_found_by_meaning_in_the_local_store() {
    let (port, _) = serve(embeddings).await;
    let embedder = json!({"embedProvider": "compatible", "embedUrl": format!("http://127.0.0.1:{port}/v1"), "credential": "token", "embedModel": "e"});
    let mut store = embedder.clone();
    store.as_object_mut().unwrap().extend(
        json!({"vectorStore": "local", "vectorOp": "vectorUpsert", "collection": "docs", "docText": "={{ $json.text }}", "docId": "={{ $json.path }}", "chunkSize": 0})
            .as_object()
            .unwrap()
            .clone(),
    );
    let mut ask = embedder.clone();
    ask.as_object_mut()
        .unwrap()
        .extend(json!({"vectorStore": "local", "vectorOp": "vectorQuery", "collection": "docs", "queryText": "¿Qué hace el gato?", "topK": 1}).as_object().unwrap().clone());
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("docs", "transform.set", json!({})),
            node("store", "ai.vectors", store),
            node("ask", "ai.vectors", ask),
        ],
        vec![wire("start", 0, "docs", 0), wire("docs", 0, "store", 0), wire("store", 0, "ask", 0)],
    );
    let pins = HashMap::from([(
        "docs".to_string(),
        vec![vec![Item::new(json!({"text": "El gato duerme al sol", "path": "a.md"})), Item::new(json!({"text": "El perro ladra de noche", "path": "b.md"}))]],
    )]);
    let ran = run_with(spec, RunMode::Full, pins, CancellationToken::new()).await;
    assert_eq!(ran.status("store"), NodeStatus::Success, "{:?}", ran.report("store").error);
    let stored = ran.output("store", 0);
    assert_eq!((stored.len(), stored[0]["ids"][0].as_str(), stored[1]["ids"][0].as_str()), (2, Some("a.md"), Some("b.md")));
    assert_eq!(ran.status("ask"), NodeStatus::Success, "{:?}", ran.report("ask").error);
    let found = &ran.output("ask", 0)[0];
    assert_eq!(found["matches"][0]["id"], "a.md");
    assert_eq!(found["matches"][0]["metadata"]["path"], "a.md");
    assert_eq!(found["context"], "El gato duerme al sol");
}

#[tokio::test]
async fn google_and_queue_nodes_say_which_credential_they_need() {
    let ran = run(one("net.google", json!({"credential": "token", "service": "gmail", "gmailOp": "gmailSearch"}))).await;
    assert!(ran.report("it").error.unwrap_or_default().contains("not a Google OAuth 2"));
    let ran = run(one("net.google", json!({"service": "drive"}))).await;
    assert!(ran.report("it").error.unwrap_or_default().contains("Pick the Google credential"));
    let ran = run(one("net.queue", json!({"broker": "sqs", "queueOp": "queuePublish", "credential": "token", "queueUrl": "https://sqs.us-east-1.amazonaws.com/1/q"}))).await;
    assert!(ran.report("it").error.unwrap_or_default().contains("AWS credential"));
    let ran = run(one("net.queue", json!({"broker": "rabbitmq", "queueOp": "queuePublish", "credential": "token", "amqpUrl": "amqp://127.0.0.1:9/%2f"}))).await;
    assert!(ran.report("it").error.unwrap_or_default().contains("user and password"));
    let ran = run(one("net.imap", json!({"credential": "basic"}))).await;
    assert!(ran.report("it").error.unwrap_or_default().contains("not an IMAP account"));
}

// ----------------------------------------------------------------------- live: needs the containers

#[tokio::test]
#[ignore = "needs the GreenMail container (see the module docs)"]
async fn live_imap_reads_marks_read_and_moves() {
    use lettre::message::{header::ContentType, Attachment, MultiPart, SinglePart};
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
    let subject = format!("Factura {}", uuid::Uuid::new_v4().simple());
    let message = Message::builder()
        .from("Proveedor <facturas@example.com>".parse().unwrap())
        .to("ana@example.com".parse().unwrap())
        .subject(&subject)
        .multipart(
            MultiPart::mixed()
                .singlepart(SinglePart::plain("Adjunto la factura.".to_string()))
                .singlepart(Attachment::new("factura.pdf".into()).body(b"%PDF-1.4\n".to_vec(), ContentType::parse("application/pdf").unwrap())),
        )
        .unwrap();
    AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1").port(53025).build().send(message).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let folder = std::env::temp_dir().join(format!("cf-imap-{}", uuid::Uuid::new_v4()));
    let criteria = format!("UNSEEN SUBJECT \"{subject}\"");
    let read = run(one("net.imap", json!({"credential": "greenmail", "imapCriteria": criteria, "attachmentsFolder": folder.to_string_lossy()}))).await;
    assert_eq!(read.status("it"), NodeStatus::Success, "{:?}", read.report("it").error);
    let mail = read.output("it", 0);
    assert_eq!(mail.len(), 1, "{mail:?}");
    assert_eq!((mail[0]["subject"].as_str(), mail[0]["from"].as_str(), mail[0]["unread"].as_bool()), (Some(subject.as_str()), Some("facturas@example.com"), Some(true)));
    let saved = mail[0]["attachments"][0]["path"].as_str().unwrap().to_string();
    assert_eq!(std::fs::read(&saved).unwrap(), b"%PDF-1.4\n");
    let uid = mail[0]["uid"].as_u64().unwrap();

    // Reading peeked: still unread, until it is marked.
    let again = run(one("net.imap", json!({"credential": "greenmail", "imapCriteria": criteria}))).await;
    assert_eq!(again.output("it", 0).len(), 1);
    let marked = run(one("net.imap", json!({"credential": "greenmail", "imapOp": "imapMarkRead", "uids": uid.to_string()}))).await;
    assert_eq!(marked.status("it"), NodeStatus::Success, "{:?}", marked.report("it").error);
    let after = run(one("net.imap", json!({"credential": "greenmail", "imapCriteria": criteria}))).await;
    assert!(after.output("it", 0).is_empty());
    let seen = run(one("net.imap", json!({"credential": "greenmail", "imapCriteria": format!("SUBJECT \"{subject}\"")}))).await;
    assert_eq!(seen.output("it", 0)[0]["unread"], false);

    // Moved to a folder that does not exist yet: it is made.
    let archive = format!("Archivo{}", uuid::Uuid::new_v4().simple());
    let moved = run(one("net.imap", json!({"credential": "greenmail", "imapOp": "imapMove", "uids": uid.to_string(), "targetMailbox": archive}))).await;
    assert_eq!(moved.status("it"), NodeStatus::Success, "{:?}", moved.report("it").error);
    let left = run(one("net.imap", json!({"credential": "greenmail", "imapCriteria": format!("SUBJECT \"{subject}\"")}))).await;
    assert!(left.output("it", 0).is_empty());
    let there = run(one("net.imap", json!({"credential": "greenmail", "mailbox": archive, "imapCriteria": format!("SUBJECT \"{subject}\"")}))).await;
    assert_eq!(there.output("it", 0).len(), 1, "{:?}", there.report("it").error);
    let _ = std::fs::remove_dir_all(&folder);
}

#[tokio::test]
#[ignore = "needs the RabbitMQ container (see the module docs)"]
async fn live_rabbitmq_publishes_takes_and_refuses_what_no_queue_takes() {
    use lapin::options::QueueDeclareOptions;
    use lapin::types::{FieldTable, ShortString};
    let queue = format!("flujos-{}", uuid::Uuid::new_v4().simple());
    let connection = lapin::Connection::connect("amqp://flujos:flujos@127.0.0.1:55672/%2f", lapin::ConnectionProperties::default()).await.unwrap();
    let channel = connection.create_channel().await.unwrap();
    // Durable: RabbitMQ 4 refuses transient queues that are not exclusive.
    let options = QueueDeclareOptions { durable: true, ..Default::default() };
    channel.queue_declare(ShortString::from(queue.as_str()), options, FieldTable::default()).await.unwrap();

    let url = "amqp://127.0.0.1:55672/%2f";
    let publish = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("data", "code.js", json!({"code": "return [{id: 1}, {id: 2}];"})),
            node("it", "net.queue", json!({"broker": "rabbitmq", "credential": "rabbit", "amqpUrl": url, "routingKey": queue})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "it", 0)],
    );
    let ran = run(publish).await;
    assert_eq!(ran.status("it"), NodeStatus::Success, "{:?}", ran.report("it").error);
    assert_eq!(ran.output("it", 0).len(), 2);

    let peek = run(one("net.queue", json!({"broker": "rabbitmq", "credential": "rabbit", "amqpUrl": url, "queueOp": "queueReceive", "queueName": queue, "leaveInQueue": true, "runFor": "once"}))).await;
    assert_eq!(peek.output("it", 0).len(), 2, "{:?}", peek.report("it").error);
    let took = run(one("net.queue", json!({"broker": "rabbitmq", "credential": "rabbit", "amqpUrl": url, "queueOp": "queueReceive", "queueName": queue, "runFor": "once"}))).await;
    let bodies: Vec<Value> = took.output("it", 0).iter().map(|m| m["body"].clone()).collect();
    assert_eq!(bodies, vec![json!({"id": 1}), json!({"id": 2})]);
    let empty = run(one("net.queue", json!({"broker": "rabbitmq", "credential": "rabbit", "amqpUrl": url, "queueOp": "queueReceive", "queueName": queue, "runFor": "once"}))).await;
    assert!(empty.output("it", 0).is_empty());

    let lost = run(one("net.queue", json!({"broker": "rabbitmq", "credential": "rabbit", "amqpUrl": url, "routingKey": "no-existe", "message": "hola"}))).await;
    assert!(lost.report("it").error.unwrap_or_default().contains("No queue took the message"));
    let _ = channel.queue_delete(ShortString::from(queue.as_str()), Default::default()).await;
}

#[tokio::test]
#[ignore = "needs the Kafka container (see the module docs)"]
async fn live_kafka_publishes_and_continues_where_the_last_run_stopped() {
    let topic = format!("flujos-{}", uuid::Uuid::new_v4().simple());
    let client = rskafka::client::ClientBuilder::new(vec!["127.0.0.1:59092".into()]).build().await.unwrap();
    client.controller_client().unwrap().create_topic(&topic, 1, 1, 5_000).await.unwrap();

    let kafka = json!({"broker": "kafka", "brokers": "127.0.0.1:59092", "topic": topic});
    let mut publish = kafka.clone();
    publish["messageKey"] = json!("={{ $json.id }}");
    let ran = run(flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("data", "code.js", json!({"code": "return [{id: 'a'}, {id: 'b'}, {id: 'c'}];"})),
            node("it", "net.queue", publish),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "it", 0)],
    ))
    .await;
    assert_eq!(ran.status("it"), NodeStatus::Success, "{:?}", ran.report("it").error);
    assert_eq!(ran.output("it", 0).iter().map(|r| r["offset"].as_i64().unwrap()).collect::<Vec<_>>(), vec![0, 1, 2]);

    let mut take = kafka.clone();
    take["queueOp"] = json!("queueReceive");
    take["messageLimit"] = json!(2);
    take["runFor"] = json!("once");
    let take_flow = || one("net.queue", take.clone());
    let first = run_scripted(take_flow(), RunMode::Full, HashMap::new(), CancellationToken::new(), Arc::new(Script::default()), Memory::default(), "flow-9", 0).await;
    let keys: Vec<Value> = first.output("it", 0).iter().map(|r| r["key"].clone()).collect();
    assert_eq!(keys, vec![json!("a"), json!("b")], "{:?}", first.report("it").error);
    let remembered = first.memory.state.lock().unwrap().clone();
    let memory = Memory::default();
    *memory.state.lock().unwrap() = remembered;
    let second = run_scripted(take_flow(), RunMode::Full, HashMap::new(), CancellationToken::new(), Arc::new(Script::default()), memory, "flow-9", 0).await;
    let rest = second.output("it", 0);
    assert_eq!((rest.len(), rest[0]["key"].as_str(), rest[0]["body"]["id"].as_str()), (1, Some("c"), Some("c")));
}

#[tokio::test]
#[ignore = "needs the ElasticMQ container (see the module docs)"]
async fn live_sqs_sends_receives_and_deletes() {
    let name = format!("flujos-{}", uuid::Uuid::new_v4().simple());
    reqwest::Client::new()
        .post("http://127.0.0.1:59324/")
        .header("content-type", "application/x-amz-json-1.0")
        .header("x-amz-target", "AmazonSQS.CreateQueue")
        .body(json!({"QueueName": name}).to_string())
        .send()
        .await
        .unwrap();
    let url = format!("http://127.0.0.1:59324/000000000000/{name}");
    let sent = run(one("net.queue", json!({"broker": "sqs", "credential": "aws", "queueUrl": url, "message": "{\"pedido\": 42}", "messageHeaders": [{"name": "origen", "value": "flujos"}]}))).await;
    assert_eq!(sent.status("it"), NodeStatus::Success, "{:?}", sent.report("it").error);
    assert!(sent.output("it", 0)[0]["messageId"].is_string());
    let took = run(one("net.queue", json!({"broker": "sqs", "credential": "aws", "queueUrl": url, "queueOp": "queueReceive", "waitSeconds": 2, "runFor": "once"}))).await;
    assert_eq!(took.status("it"), NodeStatus::Success, "{:?}", took.report("it").error);
    let message = &took.output("it", 0)[0];
    assert_eq!((message["body"]["pedido"].as_i64(), message["attributes"]["origen"].as_str()), (Some(42), Some("flujos")));
    let empty = run(one("net.queue", json!({"broker": "sqs", "credential": "aws", "queueUrl": url, "queueOp": "queueReceive", "waitSeconds": 1, "runFor": "once"}))).await;
    assert!(empty.output("it", 0).is_empty(), "the message was deleted once taken");
}

#[tokio::test]
#[ignore = "needs the Qdrant container (see the module docs)"]
async fn live_qdrant_stores_finds_and_clears() {
    let (port, _) = serve(embeddings).await;
    let collection = format!("flujos_{}", uuid::Uuid::new_v4().simple());
    let base = json!({"vectorStore": "qdrant", "qdrantUrl": "http://127.0.0.1:56333", "collection": collection, "embedProvider": "compatible", "embedUrl": format!("http://127.0.0.1:{port}/v1"), "credential": "token", "embedModel": "e"});
    let with = |extra: Value| {
        let mut params = base.clone();
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        params
    };
    let stored = run(flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("data", "code.js", json!({"code": "return [{text: 'El gato duerme', path: 'a.md'}, {text: 'El perro ladra', path: 'b.md'}];"})),
            node("it", "ai.vectors", with(json!({"docText": "={{ $json.text }}", "docId": "={{ $json.path }}", "chunkSize": 0}))),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "it", 0)],
    ))
    .await;
    assert_eq!(stored.status("it"), NodeStatus::Success, "{:?}", stored.report("it").error);
    let asked = run(one("ai.vectors", with(json!({"vectorOp": "vectorQuery", "queryText": "un gato", "topK": 1})))).await;
    assert_eq!(asked.status("it"), NodeStatus::Success, "{:?}", asked.report("it").error);
    assert_eq!(asked.output("it", 0)[0]["matches"][0]["id"], "a.md");
    let cleared = run(one("ai.vectors", with(json!({"vectorOp": "vectorDelete", "docIds": "*"})))).await;
    assert_eq!(cleared.status("it"), NodeStatus::Success, "{:?}", cleared.report("it").error);
    let none = run(one("ai.vectors", with(json!({"vectorOp": "vectorQuery", "queryText": "un gato"})))).await;
    assert_eq!(none.output("it", 0)[0]["matches"], json!([]));
    let _ = reqwest::Client::new().delete(format!("http://127.0.0.1:56333/collections/{collection}")).send().await;
}
