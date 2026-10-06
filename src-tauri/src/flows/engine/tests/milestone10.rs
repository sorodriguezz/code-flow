//! Hito 10 — the PR analyzer's features as nodes: reading pull requests, deciding on one, its
//! comment threads, the review memory, and its two AI helpers ("Resolver con IA" and drafting a
//! reply). The app's side (`flows::pr_ops`) is faked here; what is checked is what each node asks
//! CodeFlow for and what it hands on.

use super::*;

fn scripted_app(answers: Vec<Result<Value, &str>>) -> Arc<Script> {
    let script = Script::default();
    *script.app_answers.lock().unwrap() = answers.into_iter().map(|answer| answer.map_err(str::to_string)).collect();
    Arc::new(script)
}

async fn run_script(spec: FlowSpec, script: Arc<Script>, ai_per_hour: u32) -> Ran {
    run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script, Memory::default(), "flow-10", ai_per_hour).await
}

fn one(type_id: &str, params: Value) -> FlowSpec {
    flow(vec![node("start", "trigger.manual", json!({})), node("it", type_id, params)], vec![wire("start", 0, "it", 0)])
}

fn ops(script: &Script) -> Vec<String> {
    script.app_calls.lock().unwrap().iter().map(|(op, _)| op.clone()).collect()
}

#[tokio::test]
async fn pull_requests_are_listed_once_and_read_one_by_one() {
    let script = scripted_app(vec![Ok(json!([{"id": 12, "title": "Login"}, {"id": 13, "title": "Pagos"}]))]);
    let ran = run_script(one("app.prList", json!({"project": "p1", "prState": "closedPrs", "maxResults": 5})), script.clone(), 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls[0].0, "pr.list");
    assert_eq!((calls[0].1["scope"].as_str(), calls[0].1["max"].as_u64()), (Some("closedPrs"), Some(5)));
    assert_eq!(ran.output("it", 0).len(), 2);

    let script = scripted_app(vec![Ok(json!({"id": 12, "myDecision": "none", "checksPassing": true}))]);
    let ran = run_script(one("app.prList", json!({"project": "p1", "prOp": "prGet", "prId": "12"})), script.clone(), 0).await;
    assert_eq!(ops(&script), vec!["pr.get"]);
    assert_eq!(ran.output("it", 0)[0]["checksPassing"], true);
    let ran = run_script(one("app.prList", json!({"prOp": "prGet", "prId": "12"})), scripted_app(vec![]), 0).await;
    assert!(ran.report("it").error.unwrap_or_default().contains("Choose the repository"));
}

#[tokio::test]
async fn a_decision_follows_the_node_and_is_taken_once_per_pull_request() {
    let decided = json!({"prId": 12, "decision": "approve", "status": "open", "gate": "pass", "summaryPosted": true});
    let script = scripted_app(vec![Ok(decided)]);
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("prs", "code.js", json!({"code": "return [{id: 12}, {id: 12}];"})),
            node("it", "app.prDecide", json!({"project": "p1", "prId": "={{ $json.id }}", "prDecision": "byReview", "postSummary": true})),
        ],
        vec![wire("start", 0, "prs", 0), wire("prs", 0, "it", 0)],
    );
    let ran = run_script(spec, script.clone(), 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "the same decision twice is one");
    assert_eq!((calls[0].1["decision"].as_str(), calls[0].1["postSummary"].as_bool()), (Some("byReview"), Some(true)));
    assert_eq!(ran.output("it", 0).len(), 2);

    let script = scripted_app(vec![Ok(json!({"prId": 9, "decision": "request_changes", "summaryPosted": false, "summaryError": "403"}))]);
    let ran = run_script(one("app.prDecide", json!({"project": "p1", "prId": "9", "prDecision": "requestChanges"})), script, 0).await;
    assert_eq!(ran.status("it"), NodeStatus::Success);
    let said: Vec<String> = ran.memory.logs.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect();
    assert!(said.iter().any(|line| line.contains("summary was not posted")), "{said:?}");
}

#[tokio::test]
async fn comment_threads_read_as_items_and_resolve_by_id() {
    let threads = json!([
        {"id": 41, "file_path": "src/app.ts", "start_line": 3, "end_line": 3, "comments": [{"author": "Ana", "content": "¿Y el null?", "published_date": "x"}]},
        {"id": 42, "file_path": null, "start_line": null, "end_line": null, "comments": []}
    ]);
    let script = scripted_app(vec![Ok(threads)]);
    let ran = run_script(one("app.prComments", json!({"project": "p1", "prId": "7"})), script, 0).await;
    let out = ran.output("it", 0);
    assert_eq!((out.len(), out[0]["location"].as_str(), out[0]["author"].as_str()), (2, Some("src/app.ts:3"), Some("Ana")));

    let script = scripted_app(vec![Ok(json!({"replied": true, "resolved": true})), Ok(json!({"replied": true, "resolved": false, "error": "locked"}))]);
    let ran = run_script(
        one("app.prComments", json!({"project": "p1", "prId": "7", "threadOp": "resolveThread", "threadIds": "41, 42", "reply": "Hecho", "wontFix": true})),
        script.clone(),
        0,
    )
    .await;
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls.iter().map(|(_, a)| a["threadId"].clone()).collect::<Vec<_>>(), vec![json!("41"), json!("42")]);
    assert_eq!((calls[0].1["reply"].as_str(), calls[0].1["wontFix"].as_bool()), (Some("Hecho"), Some(true)));
    assert_eq!(ran.output("it", 0)[1]["error"], "locked");
}

#[tokio::test]
async fn the_review_memory_is_read_and_marked() {
    let script = scripted_app(vec![Ok(json!([{"id": "F-001", "severity": "critical", "estado": "abierto"}]))]);
    let ran = run_script(one("app.prMemory", json!({"project": "p1", "prId": "7", "findingState": "discardedFindings"})), script.clone(), 0).await;
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!((calls[0].0.as_str(), calls[0].1["state"].as_str()), ("pr.memoryFindings", Some("discardedFindings")));
    assert_eq!(ran.output("it", 0)[0]["id"], "F-001");

    let script = scripted_app(vec![Ok(json!([{"findingId": "F-001", "estado": "falso_positivo", "rule_added": true}]))]);
    let ran = run_script(
        one(
            "app.prMemory",
            json!({"project": "p1", "prId": "7", "memoryOp": "memoryMark", "findingIds": "F-001", "markAs": "falsePositive", "reason": "intencional", "wholeRepo": true}),
        ),
        script.clone(),
        0,
    )
    .await;
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls[0].0, "pr.findingMark");
    assert_eq!((calls[0].1["markAs"].as_str(), calls[0].1["wholeRepo"].as_bool(), calls[0].1["notifyPr"].as_bool()), (Some("falsePositive"), Some(true), Some(true)));
    assert_eq!(ran.output("it", 0)[0]["rule_added"], true);

    let script = scripted_app(vec![Ok(json!([{"runId": "r1", "prId": 7}, {"runId": "r2", "prId": 8}]))]);
    let ran = run_script(one("app.prMemory", json!({"project": "p1", "memoryOp": "memoryRuns"})), script.clone(), 0).await;
    assert_eq!(ops(&script), vec!["pr.memoryRuns"]);
    assert_eq!(ran.output("it", 0).len(), 2);
}

#[tokio::test]
async fn resolver_con_ia_fixes_what_stands_one_finding_at_a_time() {
    // The node asks which findings still stand, then fixes each at or above the floor on its own.
    let standing = json!([
        {"id": "F-001", "severity": "critical"},
        {"id": "F-002", "severity": "info"},
        {"id": "F-003", "severity": "warning"}
    ]);
    let script = scripted_app(vec![
        Ok(standing),
        Ok(json!([{"kind": "finding", "findingId": "F-001", "fixed": true, "result": "Validado el null"}])),
        Ok(json!([{"kind": "finding", "findingId": "F-003", "fixed": false, "error": "no compila"}])),
    ]);
    let ran = run_script(
        one(
            "ai.prFix",
            json!({"project": "p1", "prId": "7", "minSeverity": "warning", "instructions": "no cambies la firma", "engine": {"provider": "claude", "model": "sonnet", "account": ""}}),
        ),
        script.clone(),
        0,
    )
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls.iter().map(|(op, _)| op.as_str()).collect::<Vec<_>>(), vec!["pr.memoryFindings", "pr.fix", "pr.fix"]);
    assert_eq!(calls[1].1["ids"], json!(["F-001"]));
    assert_eq!(calls[2].1["ids"], json!(["F-003"]));
    assert_eq!((calls[1].1["provider"].as_str(), calls[1].1["instructions"].as_str()), (Some("claude"), Some("no cambies la firma")));
    assert_eq!(calls[1].1["switchBranch"], true);
    let out = ran.output("it", 0);
    assert_eq!((out.len(), out[1]["error"].as_str()), (2, Some("no compila")));

    let local = run_script(one("ai.prFix", json!({"project": "p1", "prId": "7", "engine": {"provider": "local", "model": "", "account": ""}})), scripted_app(vec![]), 0).await;
    assert!(local.report("it").error.unwrap_or_default().contains("CLI engine"));
    // Each fix is an AI run: the hourly cap counts them.
    let capped = run_script(one("ai.prFix", json!({"project": "p1", "prId": "7", "ids": "F-001, F-002"})), scripted_app(vec![Ok(json!([]))]), 1).await;
    assert_eq!(capped.status("it"), NodeStatus::Error);
}

#[tokio::test]
async fn replies_are_drafted_per_thread_from_the_conversation() {
    let script = scripted_app(vec![
        Ok(json!([{"id": 41}, {"id": 42}])),
        Ok(json!([{"threadId": 41, "draft": "Lo corrijo en este PR."}])),
        Ok(json!([{"threadId": 42, "draft": "Es intencional."}])),
    ]);
    let ran = run_script(one("ai.prReply", json!({"project": "p1", "prId": "7", "replyNote": "aceptar lo primero"})), script.clone(), 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls.iter().map(|(op, _)| op.as_str()).collect::<Vec<_>>(), vec!["pr.threads", "pr.replyDraft", "pr.replyDraft"]);
    assert_eq!((calls[1].1["ids"].clone(), calls[1].1["note"].as_str()), (json!(["41"]), Some("aceptar lo primero")));
    assert_eq!(ran.output("it", 0)[1]["draft"], "Es intencional.");
}
