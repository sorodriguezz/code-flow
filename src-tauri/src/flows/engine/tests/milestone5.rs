//! Milestone 5's engine work: the loop node, which hands its list out in batches and runs its body
//! once per batch.

use super::*;

fn start() -> FlowNode {
    node("start", "trigger.manual", json!({}))
}

fn succeeded(ran: &Ran) {
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
}

fn ten() -> FlowNode {
    code("list", "return Array.from({ length: 10 }, (_, i) => ({ n: i + 1 }));")
}

fn loop_node(id: &str, batch: u32) -> FlowNode {
    node(id, "logic.loop", json!({"batchSize": batch}))
}

#[tokio::test]
async fn a_loop_runs_its_body_once_per_batch_and_gathers_what_comes_back() {
    let spec = flow(
        vec![
            start(),
            ten(),
            loop_node("each", 3),
            code("double", "return items.map((it) => ({ n: it.json.n, twice: it.json.n * 2, batch: items.length }));"),
            node("after", "transform.set", json!({"assignments": [{"name": "done", "type": "boolean", "value": "true"}]})),
        ],
        vec![
            wire("start", 0, "list", 0),
            wire("list", 0, "each", 0),
            wire("each", 0, "double", 0),
            wire("double", 0, "each", 0),
            wire("each", 1, "after", 0),
        ],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    let batches: Vec<usize> = ran.reports_of("double").iter().map(|r| r.outputs[0].len()).collect();
    assert_eq!(batches, vec![3, 3, 3, 1]);
    assert_eq!(ran.reports_of("double").iter().map(|r| r.iteration).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
    let after = ran.output("after", 0);
    assert_eq!(after.len(), 10, "every item came back, in order");
    assert_eq!(after[0], json!({"n": 1, "twice": 2, "batch": 3, "done": true}));
    assert_eq!(after[9], json!({"n": 10, "twice": 20, "batch": 1, "done": true}));
    let finished = ran.last("each");
    assert_eq!(finished.status, NodeStatus::Success);
    assert!(finished.outputs[0].is_empty() && finished.outputs[1].len() == 10);
    assert_eq!(ran.reports_of("after").len(), 1, "what follows the loop runs once");
}

#[tokio::test]
async fn with_nothing_wired_back_done_hands_on_the_original_list() {
    let spec = flow(
        vec![
            start(),
            ten(),
            loop_node("each", 4),
            code("look", "return items.map((it) => ({ seen: it.json.n }));"),
            node("after", "transform.set", json!({})),
        ],
        vec![wire("start", 0, "list", 0), wire("list", 0, "each", 0), wire("each", 0, "look", 0), wire("each", 1, "after", 0)],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.reports_of("look").len(), 3);
    assert_eq!(ran.output("after", 0).len(), 10);
    assert_eq!(ran.output("after", 0)[3], json!({"n": 4}));
}

#[tokio::test]
async fn a_loop_inside_a_loop_starts_its_list_over_each_outer_batch() {
    let spec = flow(
        vec![
            start(),
            code("list", "return [1, 2, 3, 4].map((n) => ({ n }));"),
            loop_node("outer", 2),
            loop_node("inner", 1),
            code("mark", "return items.map((it) => ({ n: it.json.n, inner: true }));"),
            node("after", "transform.set", json!({})),
        ],
        vec![
            wire("start", 0, "list", 0),
            wire("list", 0, "outer", 0),
            wire("outer", 0, "inner", 0),
            wire("inner", 0, "mark", 0),
            wire("mark", 0, "inner", 0),
            wire("inner", 1, "outer", 0),
            wire("outer", 1, "after", 0),
        ],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.reports_of("mark").len(), 4, "one item per inner batch, two per outer batch");
    let after = ran.output("after", 0);
    assert_eq!(after.iter().map(|it| it["n"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(2), json!(3), json!(4)]);
    assert!(after.iter().all(|it| it["inner"] == json!(true)));
}

#[tokio::test]
async fn an_empty_list_skips_the_body_and_what_follows() {
    let spec = flow(
        vec![start(), code("list", "return [];"), loop_node("each", 2), node("body", "transform.set", json!({})), node("after", "transform.set", json!({}))],
        vec![wire("start", 0, "list", 0), wire("list", 0, "each", 0), wire("each", 0, "body", 0), wire("body", 0, "each", 0), wire("each", 1, "after", 0)],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.status("each"), NodeStatus::Skipped);
    assert_eq!(ran.status("body"), NodeStatus::Skipped);
    assert_eq!(ran.status("after"), NodeStatus::Skipped);
}

#[tokio::test]
async fn a_failing_body_stops_the_loop_and_the_run() {
    let spec = flow(
        vec![
            start(),
            ten(),
            loop_node("each", 4),
            code("check", "if (items.some((it) => it.json.n === 6)) throw new Error('six'); return items;"),
            node("after", "transform.set", json!({})),
        ],
        vec![
            wire("start", 0, "list", 0),
            wire("list", 0, "each", 0),
            wire("each", 0, "check", 0),
            wire("check", 0, "each", 0),
            wire("each", 1, "after", 0),
        ],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.clone().unwrap_or_default().contains("six"));
    assert_eq!(ran.reports_of("check").len(), 2, "the second batch held the six");
    assert!(ran.reports_of("after").is_empty());
}

#[tokio::test]
async fn a_switched_off_loop_hands_its_list_straight_to_done() {
    let mut each = loop_node("each", 2);
    each.disabled = true;
    let spec = flow(
        vec![start(), ten(), each, node("body", "transform.set", json!({})), node("after", "transform.set", json!({}))],
        vec![wire("start", 0, "list", 0), wire("list", 0, "each", 0), wire("each", 0, "body", 0), wire("body", 0, "each", 0), wire("each", 1, "after", 0)],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.status("body"), NodeStatus::Skipped);
    assert_eq!(ran.output("after", 0).len(), 10);
}

// ---------------------------------------------------------------------------------------- waiting

fn answer(decision: &str, by: &str, payload: Value) -> WaitAnswer {
    WaitAnswer { decision: decision.into(), by: by.into(), at: "2026-10-05T12:00:00Z".into(), payload }
}

fn scripted(answers: Vec<WaitAnswer>) -> Arc<Script> {
    let script = Script::default();
    *script.waits.lock().unwrap() = answers.into();
    Arc::new(script)
}

async fn run_with_script(spec: FlowSpec, script: Arc<Script>) -> Ran {
    run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script, Memory::default(), "flow-1", 0).await
}

fn approval_flow(params: Value) -> FlowSpec {
    flow(
        vec![
            start(),
            code("order", "return [{ id: 7, total: 120 }];"),
            node("ask", "logic.approval", params),
            node("yes", "transform.set", json!({})),
            node("no", "transform.set", json!({})),
        ],
        vec![wire("start", 0, "order", 0), wire("order", 0, "ask", 0), wire("ask", 0, "yes", 0), wire("ask", 1, "no", 0)],
    )
}

#[tokio::test]
async fn an_approval_waits_and_routes_by_the_decision() {
    let script = scripted(vec![answer("approved", "phone", json!("ok, adelante"))]);
    let ran = run_with_script(approval_flow(json!({"message": "=¿Pagar el pedido {{ $json.id }}?", "timeoutHours": 2})), script.clone()).await;
    succeeded(&ran);
    let asked = script.wait_calls.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].kind, "approval");
    assert_eq!(asked[0].message, "¿Pagar el pedido 7?");
    assert_eq!(asked[0].timeout, Some(Duration::from_secs(7200)));
    assert_eq!(asked[0].inputs[0][0].json, json!({"id": 7, "total": 120}), "the input is kept for a pick-up after a restart");
    assert_eq!(
        ran.output("yes", 0),
        vec![json!({"id": 7, "total": 120, "approval": {"decision": "approved", "by": "phone", "at": "2026-10-05T12:00:00Z", "comment": "ok, adelante"}})]
    );
    assert_eq!(ran.status("no"), NodeStatus::Skipped);

    let script = scripted(vec![answer("rejected", "desktop", Value::Null)]);
    let ran = run_with_script(approval_flow(json!({"message": "x"})), script).await;
    succeeded(&ran);
    assert_eq!(ran.status("yes"), NodeStatus::Skipped);
    assert_eq!(ran.output("no", 0)[0]["approval"]["decision"], "rejected");
}

#[tokio::test]
async fn an_approval_nobody_answered_rejects_or_fails_as_told() {
    let ran = run_with_script(approval_flow(json!({"message": "x", "timeoutHours": 1})), scripted(vec![answer("expired", "timer", Value::Null)])).await;
    succeeded(&ran);
    assert_eq!(ran.output("no", 0)[0]["approval"]["decision"], "expired");

    let ran = run_with_script(
        approval_flow(json!({"message": "x", "timeoutHours": 1, "onTimeout": "fail"})),
        scripted(vec![answer("expired", "timer", Value::Null)]),
    )
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.clone().unwrap_or_default().contains("Nobody decided"));
}

#[tokio::test]
async fn a_wait_for_a_call_hands_on_the_calls_body_and_knows_its_url() {
    let spec = flow(
        vec![
            start(),
            code("link", "return [{ url: $execution.resumeUrl }];"),
            node("hold", "logic.wait", json!({"mode": "webhook", "timeoutHours": 0})),
        ],
        vec![wire("start", 0, "link", 0), wire("link", 0, "hold", 0)],
    );
    let script = scripted(vec![answer("resumed", "webhook", json!({"body": {"ok": true}}))]);
    let ran = run_with_script(spec, script.clone()).await;
    succeeded(&ran);
    assert_eq!(script.wait_calls.lock().unwrap()[0].kind, "webhook");
    assert_eq!(script.wait_calls.lock().unwrap()[0].timeout, None);
    assert_eq!(
        ran.output("hold", 0),
        vec![json!({"url": "http://127.0.0.1:47811/resume/run-1", "call": {"body": {"ok": true}}})]
    );
}

#[tokio::test]
async fn a_long_wait_is_parked_and_a_short_one_is_not() {
    let spec = |amount: u32, unit: &str| {
        flow(
            vec![start(), node("hold", "logic.wait", json!({"mode": "duration", "amount": amount, "unit": unit}))],
            vec![wire("start", 0, "hold", 0)],
        )
    };
    let script = scripted(vec![answer("resumed", "timer", Value::Null)]);
    let ran = run_with_script(spec(2, "hours"), script.clone()).await;
    succeeded(&ran);
    let asked = script.wait_calls.lock().unwrap().clone();
    assert_eq!((asked[0].kind.as_str(), asked[0].timeout), ("time", Some(Duration::from_secs(7200))));

    let script = scripted(vec![]);
    let ran = run_with_script(spec(0, "seconds"), script.clone()).await;
    succeeded(&ran);
    assert!(script.wait_calls.lock().unwrap().is_empty(), "a short wait stays in memory");
}

/// A run picked up after a restart: what had finished is a silent seed, the node that waited
/// reports its decision, and only what follows runs.
#[tokio::test]
async fn a_picked_up_run_runs_only_what_follows_the_wait() {
    let spec = approval_flow(json!({"message": "x"}));
    let given: Ports = vec![vec![Item::new(json!({"id": 7}))]];
    let decided = crate::flows::nodes::decided_ports("logic.approval", &given, &answer("approved", "phone", Value::Null));
    let plan = Plan {
        trigger: None,
        active: spec.nodes.iter().map(|n| n.id.clone()).collect(),
        seeds: HashMap::from([
            ("start".to_string(), (vec![vec![Item::new(json!({}))]], false)),
            ("order".to_string(), (given.clone(), false)),
            ("ask".to_string(), (decided, false)),
        ]),
        trigger_output: None,
        quiet: HashSet::from(["start".to_string(), "order".to_string()]),
        decided: Some("ask".to_string()),
    };
    let memory = Arc::new(Memory::default());
    let host = Arc::new(Host { memory: memory.clone(), dir: std::env::temp_dir(), script: Arc::new(Script::default()) });
    let context = Arc::new(RunContext {
        run_id: "run-1".into(),
        flow_id: "flow-1".into(),
        flow_name: "Prueba".into(),
        workspace_id: "w1".into(),
        mode: "trigger".into(),
        vars: serde_json::Map::new(),
        timezone: None,
        locale: "es".into(),
        host,
        cancel: CancellationToken::new(),
        respond: Mutex::new(None),
        depth: 0,
        ai_per_hour: 0,
    });
    let outcome = execute(Arc::new(spec), plan, context).await;
    assert_eq!(outcome.status, RunStatus::Success, "{:?}", outcome.error);
    let reported: Vec<(String, NodeStatus)> = memory.reports.lock().unwrap().iter().map(|r| (r.node_id.clone(), r.status)).collect();
    assert!(!reported.iter().any(|(id, _)| id == "start" || id == "order"), "{reported:?}");
    assert!(reported.contains(&("ask".to_string(), NodeStatus::Success)));
    assert!(reported.contains(&("yes".to_string(), NodeStatus::Success)));
    assert!(reported.contains(&("no".to_string(), NodeStatus::Skipped)));
}

// ------------------------------------------------------------------------------------------- scale

/// The milestone's bar: 10,000 items through a 50-node flow, every node evaluating an expression
/// per item. Ignored by default (it measures, it does not check behaviour); run with `--ignored
/// --nocapture` to see the time.
#[tokio::test]
#[ignore = "a measurement: 10,000 items through 50 nodes"]
async fn ten_thousand_items_through_fifty_nodes() {
    let mut nodes = vec![start(), code("many", "return Array.from({ length: 10000 }, (_, i) => ({ n: i, name: 'pedido-' + i }));")];
    let mut wires = vec![wire("start", 0, "many", 0)];
    let mut previous = "many".to_string();
    for step in 0..48 {
        let id = format!("step{step}");
        nodes.push(node(&id, "transform.set", json!({"assignments": [{"name": format!("f{step}"), "type": "number", "value": "={{ $json.n * 2 }}"}]})));
        wires.push(wire(&previous, 0, &id, 0));
        previous = id;
    }
    let spec = flow(nodes, wires);
    let ran = run(spec).await;
    succeeded(&ran);
    let last = ran.output("step47", 0);
    assert_eq!(last.len(), 10_000);
    assert_eq!(last[9999]["f47"], json!(19998));
    eprintln!("10,000 items × 50 nodes: {:?}", ran.elapsed);
}

#[tokio::test]
#[ignore = "a measurement: the same chain with no expressions"]
async fn ten_thousand_items_through_fifty_plain_nodes() {
    let mut nodes = vec![start(), code("many", "return Array.from({ length: 10000 }, (_, i) => ({ n: i, name: 'pedido-' + i }));")];
    let mut wires = vec![wire("start", 0, "many", 0)];
    let mut previous = "many".to_string();
    for step in 0..48 {
        let id = format!("step{step}");
        nodes.push(node(&id, "transform.set", json!({"assignments": [{"name": format!("f{step}"), "type": "number", "value": "2"}]})));
        wires.push(wire(&previous, 0, &id, 0));
        previous = id;
    }
    let ran = run(flow(nodes, wires)).await;
    succeeded(&ran);
    eprintln!("10,000 items × 50 plain nodes: {:?}", ran.elapsed);
}
