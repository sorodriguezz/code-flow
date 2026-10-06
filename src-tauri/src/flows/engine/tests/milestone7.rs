//! Hito 7 — CodeFlow's own features as nodes: the PR analyzer, the API client's requests, pipelines
//! followed to their end, the Chat, a service's log and a database's schema as DBML.

use super::*;

fn scripted_app(answers: Vec<Result<Value, &str>>) -> Arc<Script> {
    let script = Script::default();
    *script.app_answers.lock().unwrap() = answers.into_iter().map(|answer| answer.map_err(str::to_string)).collect();
    Arc::new(script)
}

async fn run_script(spec: FlowSpec, script: Arc<Script>, ai_per_hour: u32) -> Ran {
    run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script, Memory::default(), "flow-7", ai_per_hour).await
}

#[tokio::test]
async fn the_pr_analyzer_is_codeflows_own_and_reviews_each_pull_request_once() {
    let review = json!({"status": "reviewed", "runId": "job-1", "prId": 12, "gate": "fail", "counts": {"critical": 1}});
    let script = scripted_app(vec![Ok(review.clone()), Ok(json!({"status": "unchanged", "prId": 13}))]);
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("prs", "return [{number: 12}, {number: 12}, {number: 13}];"),
            node(
                "review",
                "ai.prReview",
                json!({
                    "source": "project",
                    "project": "p1",
                    "prId": "={{ $json.number }}",
                    "level": "ultra",
                    "publish": "findings",
                    "minSeverity": "critical",
                    "engine": {"provider": "codex", "model": "gpt-5", "account": ""},
                }),
            ),
        ],
        vec![wire("start", 0, "prs", 0), wire("prs", 0, "review", 0)],
    );
    let ran = run_script(spec, script.clone(), 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2, "#12 twice in one batch is one review");
    let (op, args) = &calls[0];
    assert_eq!(op, "pr.review");
    assert_eq!(args["projectId"], "p1");
    assert_eq!(args["prId"], 12);
    assert_eq!(args["level"], "ultra");
    assert_eq!(args["publish"], "findings");
    assert_eq!(args["minSeverity"], "critical");
    assert_eq!((args["provider"].as_str(), args["model"].as_str()), (Some("codex"), Some("gpt-5")));
    let out = ran.output("review", 0);
    assert_eq!(out.len(), 3);
    assert_eq!(out[0]["gate"], "fail");
    assert_eq!(out[1]["runId"], "job-1", "the repeat gets the same answer");
    assert_eq!(out[2]["status"], "unchanged");
    assert!(out[0]["durationMs"].is_number());
}

#[tokio::test]
async fn the_pr_analyzer_counts_against_the_hourly_cap_and_asks_for_what_it_needs() {
    let script = scripted_app(vec![Ok(json!({"status": "reviewed"}))]);
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("prs", "return [{number: 1}, {number: 2}];"),
            node("review", "ai.prReview", json!({"source": "project", "project": "p1", "prId": "={{ $json.number }}"})),
        ],
        vec![wire("start", 0, "prs", 0), wire("prs", 0, "review", 0)],
    );
    let ran = run_script(spec, script.clone(), 1).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains("cap of 1 AI calls"), "{:?}", ran.outcome.error);
    assert_eq!(script.app_calls.lock().unwrap().len(), 1);

    // A link review needs the link; the local model is not an engine for it.
    for (params, expected) in [
        (json!({"source": "link"}), "link"),
        (json!({"source": "project", "project": "p1", "prId": "4", "engine": {"provider": "local"}}), "local model"),
        (json!({"source": "project", "prId": "4"}), "repository"),
    ] {
        let spec = flow(
            vec![node("start", "trigger.manual", json!({})), node("review", "ai.prReview", params)],
            vec![wire("start", 0, "review", 0)],
        );
        let ran = run_script(spec, scripted_app(vec![]), 0).await;
        assert_eq!(ran.outcome.status, RunStatus::Error);
        assert!(ran.outcome.error.as_deref().unwrap_or("").contains(expected), "{:?}", ran.outcome.error);
    }
}

fn pipeline_detail() -> Value {
    json!({
        "run": {"status": "failed", "web_url": "https://ci.example.com/runs/9", "branch": "main"},
        "jobs": [
            {"id": "j1", "name": "build", "status": "success", "web_url": "https://ci.example.com/jobs/1"},
            {"id": "j2", "name": "test", "status": "failed", "log_ref": "7", "web_url": "https://ci.example.com/jobs/2"},
        ],
    })
}

fn one_node(type_id: &str, params: Value) -> FlowSpec {
    flow(
        vec![node("start", "trigger.manual", json!({})), node("it", type_id, params)],
        vec![wire("start", 0, "it", 0)],
    )
}

#[tokio::test]
async fn a_pipeline_run_is_read_and_its_failed_jobs_logs_come_one_item_each() {
    let script = scripted_app(vec![Ok(pipeline_detail())]);
    let ran = run_script(one_node("files.pipeline", json!({"operation": "status", "project": "p1", "runId": "9"})), script.clone(), 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let status = &ran.output("it", 0)[0];
    assert_eq!((status["status"].as_str(), status["ref"].as_str()), (Some("failed"), Some("main")));
    assert_eq!(status["jobs"].as_array().unwrap().len(), 2);

    let script = scripted_app(vec![Ok(pipeline_detail()), Ok(json!({"text": "error[E0308]: mismatched types", "truncated": false}))]);
    let ran = run_script(
        one_node("files.pipeline", json!({"operation": "jobLogs", "project": "p1", "runId": "9", "maxChars": 1000})),
        script.clone(),
        0,
    )
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let logs = ran.output("it", 0);
    assert_eq!(logs.len(), 1, "only the failed job");
    assert_eq!((logs[0]["job"].as_str(), logs[0]["log"].as_str()), (Some("test"), Some("error[E0308]: mismatched types")));
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls[1].0, "pipeline.log");
    assert_eq!((calls[1].1["jobId"].as_str(), calls[1].1["logRef"].as_str()), (Some("j2"), Some("7")));

    // A node saved before the operations existed starts a pipeline, as it always did.
    let script = scripted_app(vec![Ok(json!({"run_id": "10", "web_url": "https://ci.example.com/runs/10"}))]);
    let ran = run_script(
        one_node("files.pipeline", json!({"project": "p1", "definitionId": "ci.yml", "ref": "main", "waitEnd": false})),
        script.clone(),
        0,
    )
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    assert_eq!(script.app_calls.lock().unwrap()[0].0, "pipeline.start");
    assert_eq!(ran.output("it", 0)[0]["runId"], "10");
}

#[tokio::test]
async fn a_runs_artifacts_are_listed_and_saved_where_asked() {
    let folder = std::env::temp_dir().join(format!("cf-artifacts-{}", uuid::Uuid::new_v4()));
    let script = scripted_app(vec![Ok(json!([{"id": "a1", "name": "dist", "size_bytes": 2048}])), Ok(json!({"bytes": 2048}))]);
    let ran = run_script(
        one_node(
            "files.pipeline",
            json!({"operation": "artifacts", "project": "p1", "runId": "9", "download": true, "folder": folder.to_string_lossy()}),
        ),
        script.clone(),
        0,
    )
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let item = &ran.output("it", 0)[0];
    assert_eq!(item["bytes"], 2048);
    let path = item["path"].as_str().unwrap();
    assert!(path.starts_with(&*folder.to_string_lossy()), "{path}");
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls[1].0, "pipeline.artifactDownload");
    assert_eq!(calls[1].1["destination"], path);
    let _ = std::fs::remove_dir_all(&folder);

    let ran = run_script(one_node("files.pipeline", json!({"operation": "jobLogs", "project": "p1"})), scripted_app(vec![]), 0).await;
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains("which run"), "{:?}", ran.outcome.error);
}

#[tokio::test]
async fn a_manual_run_nobody_filled_a_form_for_gets_the_defaults_or_names_what_is_missing() {
    let fields = json!([
        {"name": "cantidad", "label": "Cantidad", "type": "number", "default": "3"},
        {"name": "urgente", "type": "boolean"},
    ]);
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({"fields": fields})),
            code("double", "return [{ total: $json.cantidad * 2, urgente: $json.urgente }];"),
        ],
        vec![wire("start", 0, "double", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    assert_eq!(ran.output("start", 0), vec![json!({"cantidad": 3.0, "urgente": false})]);
    assert_eq!(ran.output("double", 0)[0]["total"], 6.0, "a number, not the text \"3\"");

    let spec = flow(
        vec![node("start", "trigger.manual", json!({"fields": [{"name": "cliente", "label": "Cliente", "required": true}]}))],
        vec![],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains("Cliente"), "{:?}", ran.outcome.error);
}

#[tokio::test]
async fn a_chat_turn_goes_to_the_thread_named_by_its_title() {
    let script = scripted_app(vec![Ok(json!({"conversationId": "c1", "created": true, "reply": "Tres puntos."}))]);
    let ran = run_script(
        one_node(
            "ai.chat",
            json!({"conversation": "byTitle", "title": "Informe diario", "message": "=Resume: {{ 1 + 1 }}", "engine": {"provider": "claude", "model": "sonnet"}}),
        ),
        script.clone(),
        0,
    )
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls[0].0, "chat.send");
    let args = &calls[0].1;
    assert_eq!((args["conversation"].as_str(), args["title"].as_str()), (Some("byTitle"), Some("Informe diario")));
    assert_eq!(args["message"], "Resume: 2");
    assert_eq!(args["wait"], true, "waiting is the default");
    assert_eq!(ran.output("it", 0)[0]["reply"], "Tres puntos.");

    for (params, expected) in [
        (json!({"message": " "}), "message"),
        (json!({"conversation": "byId", "message": "hola"}), "which conversation"),
        (json!({"message": "hola", "engine": {"provider": "local"}}), "local model"),
    ] {
        let ran = run_script(one_node("ai.chat", params), scripted_app(vec![]), 0).await;
        assert!(ran.outcome.error.as_deref().unwrap_or("").contains(expected), "{:?}", ran.outcome.error);
    }
}

#[tokio::test]
async fn a_schema_is_asked_for_as_dbml_and_kept_where_the_node_says() {
    let script = scripted_app(vec![Ok(json!({"dbml": "Table capa {\n  id integer [pk]\n}\n", "tables": 1, "diagramId": "d1"}))]);
    let ran = run_script(
        one_node("data.dbml", json!({"connection": "pg1", "database": "app", "schema": "reglas", "saveTo": "diagram", "title": "Reglas"})),
        script.clone(),
        0,
    )
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let (op, args) = script.app_calls.lock().unwrap()[0].clone();
    assert_eq!(op, "db.dbml");
    assert_eq!((args["connectionId"].as_str(), args["schema"].as_str(), args["saveTo"].as_str()), (Some("pg1"), Some("reglas"), Some("diagram")));
    assert_eq!(ran.output("it", 0)[0]["diagramId"], "d1");

    let ran = run_script(one_node("data.dbml", json!({"connection": "pg1", "saveTo": "dbmlFile"})), scripted_app(vec![]), 0).await;
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains(".dbml file"), "{:?}", ran.outcome.error);
}

#[tokio::test]
async fn a_saved_request_is_sent_per_item_with_its_variables_and_can_fail_the_node() {
    let ok = json!({"status": 200, "statusText": "OK", "body": {"name": "Ana"}, "testsPassed": 2, "testsFailed": 0});
    let script = scripted_app(vec![Ok(ok.clone()), Ok(ok.clone())]);
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("ids", "return [{id: 7}, {id: 8}];"),
            node(
                "it",
                "app.apiRequest",
                json!({"request": "r1", "environment": "", "variables": [{"name": "id", "value": "={{ $json.id }}"}]}),
            ),
        ],
        vec![wire("start", 0, "ids", 0), wire("ids", 0, "it", 0)],
    );
    let ran = run_script(spec, script.clone(), 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2, "one request per item");
    assert_eq!(calls[0].0, "api.request");
    assert_eq!((calls[0].1["variables"]["id"].as_str(), calls[1].1["variables"]["id"].as_str()), (Some("7"), Some("8")));
    assert_eq!(ran.output("it", 0)[1]["body"]["name"], "Ana");

    let script = scripted_app(vec![Ok(json!({"status": 404, "statusText": "Not Found"}))]);
    let ran = run_script(one_node("app.apiRequest", json!({"request": "r1", "failOnStatus": true})), script, 0).await;
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains("404"), "{:?}", ran.outcome.error);
    let script = scripted_app(vec![Ok(json!({"status": 200, "testsFailed": 1}))]);
    let ran = run_script(one_node("app.apiRequest", json!({"request": "r1", "failOnTests": true})), script, 0).await;
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains("tests failed"), "{:?}", ran.outcome.error);
}
