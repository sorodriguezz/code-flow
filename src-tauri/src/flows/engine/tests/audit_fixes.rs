//! The defects found auditing every node of Flujos (October 2026), each pinned by the run that showed it.

use super::*;

fn start() -> FlowNode {
    node("start", "trigger.manual", json!({}))
}

fn when_equal(id: &str, left: &str, right: &str) -> FlowNode {
    node(id, "logic.if", json!({"conditions": {"combinator": "and", "conditions": [{"left": left, "op": "equals", "right": right}]}}))
}

#[tokio::test]
async fn texts_compare_as_texts_and_numbers_only_against_numbers() {
    let spec = flow(
        vec![
            start(),
            code("data", "return [{a: '12345678901234567890', b: '12345678901234567891', z1: '007', z2: '7', n: 7, same: '12345678901234567890'}];"),
            when_equal("ids", "={{ $json.a }}", "={{ $json.b }}"),
            when_equal("zeros", "={{ $json.z1 }}", "={{ $json.z2 }}"),
            when_equal("number", "={{ $json.z2 }}", "={{ $json.n }}"),
            when_equal("twin", "={{ $json.a }}", "={{ $json.same }}"),
            node("older", "logic.if", json!({"conditions": {"combinator": "and", "conditions": [{"left": "={{ $json.b }}", "op": "gt", "right": "={{ $json.a }}"}]}})),
        ],
        vec![
            wire("start", 0, "data", 0),
            wire("data", 0, "ids", 0),
            wire("data", 0, "zeros", 0),
            wire("data", 0, "number", 0),
            wire("data", 0, "twin", 0),
            wire("data", 0, "older", 0),
        ],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("ids", 0).len(), 0, "two ids that differ in the last digit are two ids");
    assert_eq!(ran.output("zeros", 0).len(), 0, "\"007\" is not \"7\"");
    assert_eq!(ran.output("number", 0).len(), 1, "a text against a number still reads as the number");
    assert_eq!(ran.output("twin", 0).len(), 1);
    assert_eq!(ran.output("older", 0).len(), 1, "ordering long integers is exact");
}

#[tokio::test]
async fn a_date_that_is_empty_is_an_error_and_digits_are_a_date() {
    let spec = flow(
        vec![
            start(),
            node("blank", "transform.date", json!({"operation": "format", "value": "", "zone": "UTC", "format": "iso", "target": "d"})),
        ],
        vec![wire("start", 0, "blank", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.unwrap_or_default().contains("The date is empty"));

    let spec = flow(
        vec![
            start(),
            node("compact", "transform.date", json!({"operation": "format", "value": "20240315", "zone": "UTC", "format": "date", "target": "d"})),
            node("epoch", "transform.date", json!({"operation": "format", "value": "1710460800", "zone": "UTC", "format": "date", "target": "e"})),
            node("number", "transform.date", json!({"operation": "format", "value": "={{ 20240315 }}", "zone": "UTC", "format": "date", "target": "f"})),
            node("age", "transform.date", json!({"operation": "diff", "value": "2020-01-01T00:00:00Z", "other": "", "unit": "years", "zone": "UTC", "target": "years"})),
        ],
        vec![wire("start", 0, "compact", 0), wire("compact", 0, "epoch", 0), wire("epoch", 0, "number", 0), wire("number", 0, "age", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let item = &ran.output("age", 0)[0];
    assert_eq!((item["d"].as_str(), item["e"].as_str(), item["f"].as_str()), (Some("2024-03-15"), Some("2024-03-15"), Some("2024-03-15")), "{item}");
    // The first date minus the second, which is now: 2020 is six years behind.
    assert!(item["years"].as_f64().unwrap_or(0.0) <= -5.0, "a blank second date is now: {item}");
}

#[tokio::test]
async fn a_number_written_the_local_way_is_read_that_way() {
    let spec = flow(
        vec![
            start(),
            node("n", "transform.number", json!({"numberOp": "numParse", "value": "1.234", "numLocale": "es-CL"})),
            node("decimal", "transform.number", json!({"numberOp": "numParse", "value": "12,5", "numLocale": "es-CL"})),
            node("exponent", "transform.number", json!({"numberOp": "numParse", "value": "1e3", "numLocale": "es-CL"})),
        ],
        vec![wire("start", 0, "n", 0), wire("start", 0, "decimal", 0), wire("start", 0, "exponent", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("n", 0)[0]["number"], json!(1234));
    assert_eq!(ran.output("decimal", 0)[0]["number"], json!(12.5));
    assert_eq!(ran.output("exponent", 0)[0]["number"], json!(1000));
}

#[tokio::test]
async fn a_node_switched_off_hands_on_every_item_even_with_execute_once() {
    let mut off = node("p", "transform.set", json!({}));
    off.disabled = true;
    off.settings = json!({"executeOnce": true});
    let spec = flow(vec![start(), code("data", "return [{n:1},{n:2},{n:3}];"), off], vec![wire("start", 0, "data", 0), wire("data", 0, "p", 0)]);
    let ran = run(spec).await;
    assert_eq!(ran.output("p", 0).len(), 3);
}

#[tokio::test]
async fn a_loop_starts_while_another_branch_is_still_running() {
    let spec = flow(
        vec![
            start(),
            node("slow", "logic.wait", json!({"mode": "duration", "amount": 1.5, "unit": "seconds"})),
            code("list", "return [{n:1},{n:2}];"),
            node("L", "logic.loop", json!({"batchSize": 1})),
            code("body", "return items;"),
        ],
        vec![wire("start", 0, "slow", 0), wire("start", 0, "list", 0), wire("list", 0, "L", 0), wire("L", 0, "body", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let first_batch = ran.reports_of("body").first().and_then(|r| r.started_at.clone()).expect("the body ran");
    let slow_done = ran.report("slow").finished_at.expect("the wait finished");
    assert!(first_batch < slow_done, "the loop's body ({first_batch}) waited for the slow branch ({slow_done})");
}

#[test]
fn a_node_that_waits_for_a_loop_and_its_own_body_is_refused() {
    let wired = |connections: Vec<Connection>| {
        let spec = FlowSpec {
            schema: 1,
            nodes: vec![
                start(),
                code("list", "return [{n:1}];"),
                node("L", "logic.loop", json!({"batchSize": 1})),
                node("A", "transform.set", json!({})),
                node("M", "logic.merge", json!({"mode": "append"})),
                node("X", "transform.set", json!({})),
            ],
            connections,
            notes: vec![],
            settings: json!({}),
        };
        crate::flows::spec::validate(&spec)
    };
    // The body feeds the merge, and so does «done»: neither can come first.
    let error = wired(vec![wire("start", 0, "list", 0), wire("list", 0, "L", 0), wire("L", 0, "A", 0), wire("A", 0, "M", 0), wire("L", 1, "M", 1)]).unwrap_err();
    assert!(error.contains("done"), "{error}");
    // Something that only «done» leads to cannot feed the loop.
    let error = wired(vec![wire("start", 0, "list", 0), wire("list", 0, "L", 0), wire("L", 1, "X", 0), wire("X", 0, "L", 0)]).unwrap_err();
    assert!(error.contains("done"), "{error}");
    // The usual shapes stay valid.
    assert!(wired(vec![wire("start", 0, "list", 0), wire("list", 0, "L", 0), wire("L", 0, "A", 0), wire("A", 0, "L", 0), wire("L", 1, "X", 0)]).is_ok());
    assert!(wired(vec![wire("start", 0, "list", 0), wire("list", 0, "L", 0), wire("L", 0, "A", 0), wire("L", 1, "X", 0), wire("A", 0, "M", 0), wire("X", 0, "M", 1)]).is_err());
}

#[tokio::test]
async fn sorting_descending_keeps_the_missing_last() {
    let spec = flow(
        vec![
            start(),
            code("data", "return [{k: 1}, {}, {k: 3}, {k: 'b'}, {k: 2}];"),
            node("s", "transform.sort", json!({"mode": "fields", "keys": [{"field": "k", "order": "desc"}]})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "s", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let order: Vec<Value> = ran.output("s", 0).iter().map(|item| item.get("k").cloned().unwrap_or(Value::Null)).collect();
    // The values in descending order — text above numbers, as numbers sit above text going up — and
    // what has no value stays last either way.
    assert_eq!(order, vec![json!("b"), json!(3), json!(2), json!(1), Value::Null]);
}

#[tokio::test]
async fn an_iban_with_a_multibyte_letter_fails_the_rule_not_the_run() {
    let spec = flow(
        vec![
            start(),
            code("data", "return [{ iban: 'ES9é1 2100 0418 4502 0005 1332' }];"),
            node("v", "transform.validate", json!({"validationRules": [{"field": "iban", "check": "isIban", "arg": ""}], "normalize": [], "errorsField": "_errors"})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "v", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
}

#[tokio::test]
async fn validate_cleans_the_fields_its_rules_name_and_leaves_the_rest() {
    let spec = flow(
        vec![
            start(),
            code("data", "return [{ note: '  keep my padding  ', customer: { email: '  ANA@Example.COM ' }, when: '2026-10-13T08:30:00' }];"),
            node("v", "transform.validate", json!({
                "validationRules": [
                    {"field": "customer.email", "check": "isEmail", "arg": ""},
                    {"field": "when", "check": "isDate", "arg": ""}
                ],
                "normalize": ["normTrim", "normLowerEmail"],
                "errorsField": "_errors"
            })),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "v", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let valid = ran.output("v", 0);
    assert_eq!(valid.len(), 1, "an ISO datetime without an offset is a date: {:?}", ran.output("v", 1));
    // The padded, upper-cased email — found by its dotted path — comes back clean...
    assert_eq!(valid[0].pointer("/customer/email"), Some(&json!("ana@example.com")));
    // ...and a string no rule asked about is not touched.
    assert_eq!(valid[0].get("note"), Some(&json!("  keep my padding  ")));
}

/// A loopback server that answers every request with the raw HTTP `answer` gives for it (the head it
/// read), and keeps each request's head.
async fn raw_server(answer: fn(&str) -> String) -> (u16, Arc<Mutex<Vec<String>>>) {
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
                let mut chunk = vec![0u8; 8 * 1024];
                loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                    if String::from_utf8_lossy(&buffer).contains("\r\n\r\n") {
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&buffer).to_string();
                let response = answer(&head);
                log.lock().unwrap().push(head);
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (port, seen)
}

fn ok_json() -> String {
    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_string()
}

static LANDING: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

#[tokio::test]
async fn a_redirect_to_another_server_leaves_the_credential_headers_behind() {
    let (landing, landed) = raw_server(|_| ok_json()).await;
    LANDING.store(landing, std::sync::atomic::Ordering::SeqCst);
    // `localhost` is another host than `127.0.0.1`, as far as a credential is concerned.
    let (origin, first) = raw_server(|_| {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: http://localhost:{}/landed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            LANDING.load(std::sync::atomic::Ordering::SeqCst)
        )
    })
    .await;
    let spec = flow(
        vec![
            start(),
            node("call", "net.http", json!({"url": format!("http://127.0.0.1:{origin}/start"), "credential": "apikey", "headers": [{"name": "X-Trace", "value": "t-1"}]})),
        ],
        vec![wire("start", 0, "call", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let asked = first.lock().unwrap()[0].to_lowercase();
    assert!(asked.contains("x-api-key: k-123") && asked.contains("x-trace: t-1"), "{asked}");
    let arrived = landed.lock().unwrap();
    assert_eq!(arrived.len(), 1, "the redirect was followed");
    let carried = arrived[0].to_lowercase();
    assert!(!carried.contains("x-api-key") && !carried.contains("k-123") && !carried.contains("x-trace"), "the key went to the other server: {carried}");
}

#[tokio::test]
async fn a_redirect_within_the_same_server_keeps_them() {
    let (origin, seen) = raw_server(|head| {
        if head.starts_with("GET /start") {
            "HTTP/1.1 302 Found\r\nLocation: /landed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
        } else {
            ok_json()
        }
    })
    .await;
    let spec = flow(
        vec![start(), node("call", "net.http", json!({"url": format!("http://127.0.0.1:{origin}/start"), "credential": "apikey"}))],
        vec![wire("start", 0, "call", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert!(seen[1].to_lowercase().contains("x-api-key: k-123"), "{}", seen[1]);
}

#[cfg(unix)]
#[tokio::test]
async fn a_script_that_leaves_something_running_does_not_hold_the_node() {
    // `sleep 6 &` inherits the pipe the node reads: before, the node waited for it to close.
    let spec = flow(
        vec![start(), node("go", "code.shell", json!({"shell": "sh", "script": "sleep 6 & echo started", "output": "text"}))],
        vec![wire("start", 0, "go", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert!(ran.elapsed < Duration::from_secs(5), "the node waited {:?} for a process it does not own", ran.elapsed);
    let item = &ran.output("go", 0)[0];
    assert!(item.to_string().contains("started"), "what the script said before leaving is kept: {item}");
}

#[tokio::test]
async fn a_query_that_never_ends_is_stopped_by_the_nodes_time_limit() {
    let mut sql = node("q", "transform.sql", json!({"itemsQuery": "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c"}));
    sql.settings = json!({"timeoutSec": 1});
    let spec = flow(vec![start(), code("data", "return [{a: 1}];"), sql], vec![wire("start", 0, "data", 0), wire("data", 0, "q", 0)]);
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.elapsed < Duration::from_secs(8), "the query held the run for {:?}", ran.elapsed);
}

#[tokio::test]
async fn renaming_a_file_to_its_own_name_leaves_it_where_it_is() {
    let dir = std::env::temp_dir().join(format!("cf-rename-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("same.txt");
    std::fs::write(&path, "hola").unwrap();
    let spec = flow(
        vec![start(), node("r", "files.move", json!({"operation": "rename", "source": path.to_string_lossy(), "newName": "same.txt", "overwrite": true}))],
        vec![wire("start", 0, "r", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hola", "the file is still there — not in the trash");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_flow_saved_with_a_broker_this_version_lacks_says_so() {
    let spec = flow(
        vec![start(), node("q", "net.queue", json!({"broker": "nats", "queueOp": "queuePublish", "message": "hola"}))],
        vec![wire("start", 0, "q", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    let error = ran.outcome.error.unwrap_or_default();
    assert!(error.contains("nats") && error.contains("not a broker"), "not an AMQP address: {error}");
}

#[tokio::test]
async fn a_retry_does_not_send_again_what_already_went_out() {
    let (port, seen) = raw_server(|head| {
        if head.starts_with("POST /ok") {
            ok_json()
        } else {
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4\r\nConnection: close\r\n\r\nboom".to_string()
        }
    })
    .await;
    let mut post = node(
        "post",
        "net.http",
        json!({"method": "POST", "url": "", "body": "json", "bodyJson": "={}"}),
    );
    post.params["url"] = json!(format!("=http://127.0.0.1:{port}/{{{{ $json.path }}}}"));
    post.settings = json!({"retryOnFail": true, "maxTries": 3, "waitBetweenTries": 0});
    let spec = flow(vec![start(), code("data", "return [{path: 'ok'}, {path: 'down'}];"), post], vec![wire("start", 0, "data", 0), wire("data", 0, "post", 0)]);
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    let error = ran.outcome.error.unwrap_or_default();
    assert!(error.contains("1 item had already gone out"), "{error}");
    // The first item once, the second once: no second attempt.
    assert_eq!(seen.lock().unwrap().len(), 2, "the first item was sent again by the retry");
}

#[tokio::test]
async fn a_node_that_sent_nothing_is_still_retried() {
    let (port, seen) = raw_server(|_| "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4\r\nConnection: close\r\n\r\nboom".to_string()).await;
    let mut get = node("get", "net.http", json!({"method": "GET", "url": format!("http://127.0.0.1:{port}/x")}));
    get.settings = json!({"retryOnFail": true, "maxTries": 3, "waitBetweenTries": 0});
    let spec = flow(vec![start(), get], vec![wire("start", 0, "get", 0)]);
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert_eq!(seen.lock().unwrap().len(), 3);
}

fn three_asks(settings: Value) -> FlowSpec {
    let mut agent = node("agent", "ai.agent", json!({"prompt": "=Item {{ $json.n }}"}));
    agent.settings = settings;
    flow(
        vec![start(), code("data", "return [{n: 1}, {n: 2}, {n: 3}];"), agent],
        vec![wire("start", 0, "data", 0), wire("data", 0, "agent", 0)],
    )
}

fn texts(items: &[Value]) -> Vec<String> {
    items.iter().map(|item| item["text"].as_str().unwrap_or_default().to_string()).collect()
}

#[tokio::test]
async fn one_item_the_model_cannot_answer_does_not_take_the_batch_with_it() {
    let script = Script::answering(vec![Ok("uno"), Err("boom"), Ok("tres")]);
    let ran = run_scripted(three_asks(json!({"onError": "continue"})), RunMode::Full, HashMap::new(), CancellationToken::new(), script.clone(), Memory::default(), "flow-1", 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("agent", 0);
    assert_eq!(out.len(), 3, "{out:?}");
    assert_eq!(texts(&out[..2]), vec!["uno", "tres"], "the two answers it did get are kept");
    assert!(out[2]["error"].as_str().unwrap_or_default().contains("boom"), "the third went on with its error: {}", out[2]);
    assert_eq!(out[2]["n"], json!(2), "and with what it came in with");
    assert_eq!(script.calls.lock().unwrap().len(), 3, "the item after the failed one was asked");
}

#[tokio::test]
async fn failed_items_can_have_an_output_of_their_own() {
    let script = Script::answering(vec![Ok("uno"), Err("boom"), Ok("tres")]);
    let ran = run_scripted(three_asks(json!({"onError": "errorOutput"})), RunMode::Full, HashMap::new(), CancellationToken::new(), script, Memory::default(), "flow-1", 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(texts(&ran.output("agent", 0)), vec!["uno", "tres"]);
    let errors = ran.output("agent", 1);
    assert_eq!(errors.len(), 1);
    assert!(errors[0]["error"].as_str().unwrap_or_default().contains("boom"));
}

#[tokio::test]
async fn a_node_that_stops_on_error_still_stops_but_a_retry_asks_only_what_is_left() {
    // Stop (the default): the run ends at the failure — as before.
    let script = Script::answering(vec![Ok("uno"), Err("boom"), Ok("tres")]);
    let ran = run_scripted(three_asks(json!({})), RunMode::Full, HashMap::new(), CancellationToken::new(), script, Memory::default(), "flow-1", 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);

    // With a retry, the first item is not paid for twice: four calls for three items, not five.
    let script = Script::answering(vec![Ok("uno"), Err("boom"), Ok("dos"), Ok("tres")]);
    let ran = run_scripted(
        three_asks(json!({"retryOnFail": true, "maxTries": 2, "waitBetweenTries": 0})),
        RunMode::Full,
        HashMap::new(),
        CancellationToken::new(),
        script.clone(),
        Memory::default(),
        "flow-1",
        0,
    )
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(texts(&ran.output("agent", 0)), vec!["uno", "dos", "tres"]);
    assert_eq!(script.calls.lock().unwrap().len(), 4, "the answer to item 1 was reused");
}

#[tokio::test]
async fn a_read_only_node_on_an_engine_that_only_asks_gets_a_restore_point() {
    for (engine, expects_point) in [("opencode", true), ("claude", false)] {
        let (dir, root) = repo_with_one_file();
        let spec = flow(
            vec![
                start(),
                node(
                    "agent",
                    "ai.agent",
                    json!({"prompt": "Mira a.txt", "workIn": "project", "project": "p1", "access": "read", "engine": {"provider": engine, "model": "", "account": ""}}),
                ),
            ],
            vec![wire("start", 0, "agent", 0)],
        );
        let script = Script::answering(vec![Ok("visto")]);
        script.projects.lock().unwrap().insert("p1".into(), root.clone());
        let ran = run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script.clone(), Memory::default(), "flow-1", 0).await;
        assert_eq!(ran.outcome.status, RunStatus::Success, "{engine}: {:?}", ran.outcome.error);
        assert_eq!(!script.edits.lock().unwrap().is_empty(), expects_point, "{engine}");
        if expects_point {
            crate::git::checkpoint::remove_flow_baseline(&root, "run-1");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tokio::test]
async fn categories_written_twice_are_one_port_and_too_many_are_refused() {
    let params = json!({"categories": [{"name": "a"}, {"name": " a "}, {"name": "b"}, {"name": ""}], "routing": "routeBranch", "allowOther": true});
    assert_eq!(crate::flows::catalog::category_names(&params), vec!["a", "b"]);
    assert_eq!(crate::flows::catalog::output_count("ai.classify", &params), 3, "a, b and other");

    let many: Vec<Value> = (0..21).map(|n| json!({"name": format!("c{n}")})).collect();
    let spec = flow(
        vec![start(), code("data", "return [{t: 'x'}];"), node("kind", "ai.classify", json!({"categories": many, "routing": "routeBranch", "text": "x"}))],
        vec![wire("start", 0, "data", 0), wire("data", 0, "kind", 0)],
    );
    let ran = run_ai(spec, Script::answering(vec![])).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.unwrap_or_default().contains("at most 20 categories"));
}

#[tokio::test]
async fn a_model_is_not_handed_a_file_that_is_not_an_image() {
    let dir = std::env::temp_dir().join(format!("cf-vision-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let secret = dir.join("id_rsa");
    std::fs::write(&secret, "-----BEGIN PRIVATE KEY-----").unwrap();
    let spec = flow(
        vec![start(), node("look", "ai.vision", json!({"imagePath": secret.to_string_lossy(), "visionEngine": "visionCli"}))],
        vec![wire("start", 0, "look", 0)],
    );
    let script = Script::answering(vec![Ok("nada")]);
    let ran = run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script.clone(), Memory::default(), "flow-1", 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.unwrap_or_default().contains("not an image or a PDF"));
    assert_eq!(script.calls.lock().unwrap().len(), 0, "the model was never asked to open it");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_guard_that_cannot_judge_holds_the_text_back() {
    let spec = flow(
        vec![
            start(),
            code("data", "return [{t: 'hola, ¿cómo estás?'}];"),
            node("guard", "ai.guard", json!({"guardChecks": ["guardInjection"], "useAi": true, "text": "={{ $json.t }}"})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "guard", 0)],
    );
    let script = Script::answering(vec![Err("the model is down")]);
    let ran = run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script.clone(), Memory::default(), "flow-1", 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("guard", 0).len(), 0, "nothing passed");
    let held = ran.output("guard", 1);
    assert_eq!(held.len(), 1);
    assert_eq!(held[0]["guard"]["passed"], json!(false));
    assert_eq!(held[0]["guard"]["violations"][0]["by"], json!("error"));
    // The text the model was shown is fenced by marks that are new for it.
    let calls = script.calls.lock().unwrap();
    assert!(calls[0].data.starts_with("<<<TEXTO-") && calls[0].data.trim_end().contains("\nTEXTO-"), "{}", calls[0].data);
}

#[tokio::test]
async fn a_body_node_fed_from_outside_the_loop_has_that_input_in_every_batch() {
    let spec = flow(
        vec![
            start(),
            code("list", "return [{n: 1}, {n: 2}, {n: 3}];"),
            code("config", "return [{setting: 'x'}];"),
            node("L", "logic.loop", json!({"batchSize": 1})),
            node("both", "logic.merge", json!({"mode": "append"})),
        ],
        vec![
            wire("start", 0, "list", 0),
            wire("start", 0, "config", 0),
            wire("list", 0, "L", 0),
            wire("L", 0, "both", 0),
            wire("config", 0, "both", 1),
            wire("both", 0, "L", 0),
        ],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let batches: Vec<usize> = ran.reports_of("both").iter().map(|r| r.outputs[0].len()).collect();
    assert_eq!(batches, vec![2, 2, 2], "each batch is the loop's item and the setting");
}

#[test]
fn a_programs_arguments_keep_their_blanks_and_spaces() {
    let args = |value: Value| crate::flows::nodes::arguments(&json!({"args": value}), "args");
    assert_eq!(args(json!(["-i", "", "s/a/b/", "f"])), vec!["-i", "", "s/a/b/", "f"], "macOS sed needs its empty suffix");
    assert_eq!(args(json!(["-F", " ", "{print $1}"])), vec!["-F", " ", "{print $1}"]);
    assert_eq!(args(json!(["--password", ""])), vec!["--password"], "an unfinished last row is not an argument");
    assert_eq!(args(json!(["a", "", ""])), vec!["a"]);
    assert!(args(json!(null)).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn output_with_no_newline_is_read_in_pieces_and_kept_whole() {
    let spec = flow(
        vec![start(), node("big", "code.shell", json!({"shell": "sh", "script": "head -c 3000000 /dev/zero | tr '\\0' a", "output": "text"}))],
        vec![wire("start", 0, "big", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let item = &ran.output("big", 0)[0];
    let text = item["stdout"].as_str().or_else(|| item["text"].as_str()).or_else(|| item["output"].as_str()).unwrap_or_default();
    assert_eq!(text.len(), 3_000_000, "{}", item.to_string().chars().take(200).collect::<String>());
}

// ------------------------------------------------------------------------------- what a flow remembers

fn dedupe_history(items: &str) -> FlowSpec {
    flow(
        vec![
            start(),
            code("data", items),
            node("once", "transform.dedupe", json!({"compare": "fields", "fields": ["id"], "scope": "history"})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "once", 0)],
    )
}

async fn dedupe_run(label: &str, items: &str, memory: Memory) -> Ran {
    run_scripted_as(dedupe_history(items), RunMode::Full, label, HashMap::new(), CancellationToken::new(), Arc::new(Script::default()), memory, "flow-memory", 0).await
}

fn remembered(ran: &Ran) -> Memory {
    let memory = Memory::default();
    *memory.state.lock().unwrap() = ran.memory.state.lock().unwrap().clone();
    memory
}

#[tokio::test]
async fn a_run_started_by_hand_reads_what_the_flow_remembers_and_adds_nothing() {
    let items = "return [{id: 1}, {id: 2}];";
    // A real run sees both, and from then on they are known.
    let real = dedupe_run("trigger", items, Memory::default()).await;
    assert_eq!(real.output("once", 0).len(), 2);
    // Pressing Run by hand shows what a real run would do now: nothing new...
    let by_hand = dedupe_run("manual", "return [{id: 1}, {id: 3}];", remembered(&real)).await;
    let ids: Vec<i64> = by_hand.output("once", 0).iter().map(|i| i["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![3]);
    // ...and does not use #3 up: the next real run still gets it.
    let next = dedupe_run("trigger", "return [{id: 3}];", remembered(&by_hand)).await;
    assert_eq!(next.output("once", 0).len(), 1, "a look by hand left the memory as it was");
}

#[tokio::test]
async fn a_test_or_a_replay_starts_from_nothing_and_leaves_the_memory_alone() {
    let real = dedupe_run("trigger", "return [{id: 1}];", Memory::default()).await;
    for label in ["test", "retry"] {
        let replay = dedupe_run(label, "return [{id: 1}];", remembered(&real)).await;
        assert_eq!(replay.output("once", 0).len(), 1, "{label}: the item passes though a real run saw it");
        let after = dedupe_run("trigger", "return [{id: 1}];", remembered(&replay)).await;
        assert_eq!(after.output("once", 0).len(), 0, "{label}: and the memory is still what the real run left");
    }
}

#[tokio::test]
async fn only_what_changed_keeps_the_memory_of_a_run_that_was_not_real_out_of_it() {
    let spec = |items: &str| {
        flow(
            vec![start(), code("data", items), node("it", "transform.changes", json!({"key": "={{ $json.id }}", "firstRun": "emitNone"}))],
            vec![wire("start", 0, "data", 0), wire("data", 0, "it", 0)],
        )
    };
    let go = |label: &'static str, items: &str, memory: Memory| {
        let spec = spec(items);
        async move { run_scripted_as(spec, RunMode::Full, label, HashMap::new(), CancellationToken::new(), Arc::new(Script::default()), memory, "flow-changes", 0).await }
    };
    // By hand, with nothing remembered: the first look says nothing and learns nothing...
    let by_hand = go("manual", "return [{id: 1, v: 1}];", Memory::default()).await;
    assert_eq!(by_hand.output("it", 0).len(), 0);
    assert!(by_hand.memory.state.lock().unwrap().is_empty(), "a look by hand leaves no memory");
    // ...so the real first run is the first run, and says nothing too, but now remembers.
    let first = go("trigger", "return [{id: 1, v: 1}];", remembered(&by_hand)).await;
    assert_eq!(first.output("it", 0).len(), 0);
    let second = go("trigger", "return [{id: 1, v: 2}];", remembered(&first)).await;
    assert_eq!(second.output("it", 0).len(), 1, "the price moved");
}

#[tokio::test]
async fn the_memory_forgets_what_has_gone_longest_without_turning_up() {
    let many = (1..=10).map(|id| format!("{{id: {id}, v: 1}}")).collect::<Vec<_>>().join(", ");
    let spec = |items: String| {
        flow(
            vec![start(), code("data", &items), node("it", "transform.changes", json!({"key": "={{ $json.id }}", "memory": 10}))],
            vec![wire("start", 0, "data", 0), wire("data", 0, "it", 0)],
        )
    };
    let first = run_scripted_as(spec(format!("return [{many}];")), RunMode::Full, "trigger", HashMap::new(), CancellationToken::new(), Arc::new(Script::default()), Memory::default(), "flow-forget", 0).await;
    // #1 turns up again, unchanged, with the memory full: it is now the most recent, so #2 is what goes.
    let again = run_scripted_as(spec("return [{id: 1, v: 1}, {id: 11, v: 1}];".to_string()), RunMode::Full, "trigger", HashMap::new(), CancellationToken::new(), Arc::new(Script::default()), remembered(&first), "flow-forget", 0).await;
    assert_eq!(again.output("it", 0).len(), 1, "only #11 is new");
    let last = run_scripted_as(spec("return [{id: 1, v: 1}, {id: 2, v: 1}];".to_string()), RunMode::Full, "trigger", HashMap::new(), CancellationToken::new(), Arc::new(Script::default()), remembered(&again), "flow-forget", 0).await;
    let news: Vec<i64> = last.output("it", 0).iter().map(|i| i["id"].as_i64().unwrap()).collect();
    assert_eq!(news, vec![2], "#1 was kept because it kept turning up; #2 had gone longest unseen");
}

// ----------------------------------------------------------------- one item failing in the media nodes

static IMAGE_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[tokio::test]
async fn one_prompt_the_image_server_refuses_does_not_take_the_pictures_of_the_others() {
    use base64::Engine as _;
    // The second request is refused; the first and the third are answered with a picture.
    let (port, _) = raw_server(|_| {
        let nth = IMAGE_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if nth == 1 {
            return "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 29\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"refused\"}}".to_string();
        }
        let mut png = Vec::new();
        image::DynamicImage::new_rgb8(2, 2).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let body = serde_json::json!({"data": [{"b64_json": base64::engine::general_purpose::STANDARD.encode(&png)}]}).to_string();
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    })
    .await;
    let dir = std::env::temp_dir().join(format!("cf-image-{}", uuid::Uuid::new_v4()));
    let mut image = node(
        "img",
        "ai.image",
        json!({
            "imageProvider": "compatible",
            "baseUrl": format!("http://127.0.0.1:{port}/v1"),
            "imageModel": "m",
            "imagePrompt": "=Dibuja {{ $json.n }}",
            "savePath": format!("{}/img-{{{{ $json.n }}}}.png", dir.display()),
        }),
    );
    image.settings = json!({"onError": "continue"});
    let spec = flow(
        vec![start(), code("data", "return [{n: 1}, {n: 2}, {n: 3}];"), image],
        vec![wire("start", 0, "data", 0), wire("data", 0, "img", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("img", 0);
    assert_eq!(out.len(), 3, "{out:?}");
    assert!(out[..2].iter().all(|item| item["file"].is_object()), "two pictures, kept: {out:?}");
    assert!(out[2]["error"].as_str().unwrap_or_default().contains("refused"), "the third went on with the server's words: {}", out[2]);
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------------------------ a sign-in refused, a service busy

fn ntfy_poll(port: u16, credential: &str) -> FlowSpec {
    flow(
        vec![
            start(),
            node(
                "poll",
                "net.connector",
                json!({"call": {"connector": "ntfy", "operation": "poll", "fields": {"server": format!("http://127.0.0.1:{port}"), "topic": "avisos", "since": "all"}}, "credential": credential}),
            ),
        ],
        vec![wire("start", 0, "poll", 0)],
    )
}

fn ntfy_message() -> String {
    let body = r#"{"id":"m1","event":"message","message":"hola"}"#;
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

#[tokio::test]
async fn a_sign_in_whose_token_was_refused_is_renewed_and_the_call_made_again() {
    let (port, seen) = raw_server(|head| {
        if head.contains("Bearer ya29.renewed") {
            ntfy_message()
        } else {
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{\"error\":\"token revoked\"}".to_string()
        }
    })
    .await;
    let ran = run(ntfy_poll(port, "oauth")).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("poll", 0)[0]["message"], "hola");
    let heads = seen.lock().unwrap().clone();
    assert_eq!(heads.len(), 2, "asked twice: refused, then with the renewed token");
    assert!(heads[0].contains("Bearer ya29.fresh") && heads[1].contains("Bearer ya29.renewed"));
}

#[tokio::test]
async fn a_pasted_token_that_is_refused_is_not_asked_again() {
    let (port, seen) = raw_server(|_| "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"error\":\"nope!\"}".to_string()).await;
    let ran = run(ntfy_poll(port, "token")).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert_eq!(seen.lock().unwrap().len(), 1, "a bearer token has nothing to renew with");
}

static BUSY_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[tokio::test]
async fn a_service_that_says_too_many_requests_is_asked_again_after_the_wait() {
    let (port, seen) = raw_server(|_| {
        if BUSY_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
        } else {
            ntfy_message()
        }
    })
    .await;
    let ran = run(ntfy_poll(port, "")).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(seen.lock().unwrap().len(), 2);
    assert_eq!(ran.output("poll", 0)[0]["message"], "hola");
}

// ------------------------------------------------------------------------------------------------ SQS

/// A loopback SQS: two messages on the first ReceiveMessage, none after; a DeleteMessageBatch deletes what it names.
async fn sqs_server() -> (u16, Arc<Mutex<Vec<String>>>) {
    raw_server(|head| {
        let body = if head.contains("AmazonSQS.ReceiveMessage") {
            if SQS_RECEIVES.fetch_add(1, std::sync::atomic::Ordering::SeqCst) % 2 == 0 {
                r#"{"Messages":[{"MessageId":"1","ReceiptHandle":"r1","Body":"{\"n\":1}"},{"MessageId":"2","ReceiptHandle":"r2","Body":"{\"n\":2}"}]}"#.to_string()
            } else {
                "{}".to_string()
            }
        } else {
            r#"{"Successful":[{"Id":"m0"},{"Id":"m1"}],"Failed":[]}"#.to_string()
        };
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-amz-json-1.0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    })
    .await
}

static SQS_RECEIVES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn sqs_receive(port: u16, delete: &str) -> FlowSpec {
    flow(
        vec![
            start(),
            node(
                "read",
                "net.queue",
                json!({"broker": "sqs", "queueOp": "queueReceive", "credential": "aws", "queueUrl": format!("http://127.0.0.1:{port}/123/pedidos"), "messageLimit": 25, "sqsDelete": delete, "runFor": "once"}),
            ),
        ],
        vec![wire("start", 0, "read", 0)],
    )
}

fn actions(seen: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    seen.lock().unwrap().iter().filter_map(|head| head.lines().find(|l| l.to_ascii_lowercase().starts_with("x-amz-target:")).map(|l| l.split('.').last().unwrap_or_default().trim().to_string())).collect()
}

#[tokio::test]
async fn sqs_messages_are_deleted_only_after_all_were_read_and_by_default_only_when_the_run_ends_well() {
    // «As soon as they are read»: every message read first (asked again until the queue had no more), then one batch delete.
    let (port, seen) = sqs_server().await;
    let ran = run(sqs_receive(port, "afterRead")).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("read", 0).len(), 2);
    assert_eq!(actions(&seen), vec!["ReceiveMessage", "ReceiveMessage", "DeleteMessageBatch"]);
    assert!(ran.memory.deferred.lock().unwrap().is_empty());

    // The default: nothing deleted during the run — the delete waits for the run to end well.
    let (port, seen) = sqs_server().await;
    let ran = run(sqs_receive(port, "")).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(actions(&seen), vec!["ReceiveMessage", "ReceiveMessage"], "no delete while the run goes on");
    let deferred: Vec<_> = std::mem::take(&mut *ran.memory.deferred.lock().unwrap());
    assert_eq!(deferred.len(), 1);
    for work in deferred {
        work.await;
    }
    assert_eq!(actions(&seen).last().map(String::as_str), Some("DeleteMessageBatch"), "done when the host says the run ended well");
}
