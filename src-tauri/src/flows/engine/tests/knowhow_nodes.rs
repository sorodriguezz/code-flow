//! What CodeFlow knows, as nodes: the code map, the knowledge index, memories and a terminal's
//! output (`nodes/knowhow.rs`) — the same reach an agent has through `cf` or MCP.

use super::*;

fn scripted_app(answers: Vec<Result<Value, &str>>) -> Arc<Script> {
    let script = Script::default();
    *script.app_answers.lock().unwrap() = answers.into_iter().map(|answer| answer.map_err(str::to_string)).collect();
    Arc::new(script)
}

async fn run_one(type_id: &str, params: Value, script: Arc<Script>) -> Ran {
    let spec = flow(vec![node("start", "trigger.manual", json!({})), node("n", type_id, params)], vec![wire("start", 0, "n", 0)]);
    run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script, Memory::default(), "flow-knowhow", 0).await
}

#[tokio::test]
async fn the_code_map_answers_from_the_repository_s_own_files() {
    let dir = std::env::temp_dir().join(format!("cf-flow-codemap-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    git2::Repository::init(&dir).unwrap();
    std::fs::write(dir.join("src/pricing.ts"), "export function applyDiscount(p: number) { return p; }\n").unwrap();
    std::fs::write(dir.join("src/cart.ts"), "import { applyDiscount } from './pricing';\nexport const t = applyDiscount(1);\n").unwrap();
    let script = Arc::new(Script::default());
    script.projects.lock().unwrap().insert("p1".into(), dir.to_string_lossy().to_string());

    let ran = run_one("app.codemap", json!({"project": "p1", "codemapOp": "mapUsages", "symbolName": "applyDiscount"}), script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let out = ran.output("n", 0);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["operation"], "mapUsages");
    assert!(out[0]["text"].as_str().unwrap().contains("src/cart.ts"), "{}", out[0]["text"]);

    let ran = run_one("app.codemap", json!({"project": "p1", "codemapOp": "mapSymbol", "symbolName": "applyDiscount"}), script.clone()).await;
    assert!(ran.output("n", 0)[0]["text"].as_str().unwrap().contains("src/pricing.ts:1"));

    let ran = run_one("app.codemap", json!({"project": "p1", "codemapOp": "mapOutline", "outlinePath": ""}), script).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.report("n").error.unwrap_or_default().contains("path"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_knowledge_search_is_one_item_per_passage_best_first() {
    let hits = json!([
        {"source": "repo", "path": "docs/adr/0003-refunds.md", "startLine": 1, "endLine": 20, "snippet": "Refunds are issued by…"},
        {"source": "note", "path": "", "startLine": 0, "endLine": 0, "snippet": "Refund policy"}
    ]);
    let script = scripted_app(vec![Ok(hits)]);
    let ran = run_one("app.knowledge", json!({"project": "p1", "knowledgeQuery": "how is a refund issued?", "maxResults": 3}), script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let calls = script.app_calls.lock().unwrap().clone();
    assert_eq!(calls[0].0, "knowledge.search");
    assert_eq!(calls[0].1, json!({"projectId": "p1", "query": "how is a refund issued?", "limit": 3}));
    let out = ran.output("n", 0);
    assert_eq!(out.len(), 2);
    assert_eq!((out[0]["rank"].as_u64(), out[1]["rank"].as_u64()), (Some(1), Some(2)));
    assert_eq!(out[0]["path"], "docs/adr/0003-refunds.md");
    assert_eq!(out[1]["query"], "how is a refund issued?");
}

#[tokio::test]
async fn memory_is_recalled_for_the_flow_s_workspace_and_proposed_as_a_candidate() {
    let script = scripted_app(vec![Ok(json!([{"title": "Deploys on Tuesdays"}, {"title": "No mocks for the DB"}]))]);
    let ran = run_one("app.memory", json!({"memoryOp": "memoryRecall", "project": "p1", "memoryTopic": "deploys"}), script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let (op, args) = script.app_calls.lock().unwrap()[0].clone();
    assert_eq!(op, "memory.recall");
    assert_eq!(args, json!({"projectId": "p1", "workspaceId": "w1", "topic": "deploys"}));
    assert_eq!(ran.output("n", 0).len(), 2);

    let script = scripted_app(vec![Ok(json!({"id": "m1", "status": "candidate", "title": "Deploys on Tuesdays"}))]);
    let ran = run_one("app.memory", json!({"memoryOp": "memoryPropose", "memoryFact": "Deploys on Tuesdays"}), script.clone()).await;
    let (op, args) = script.app_calls.lock().unwrap()[0].clone();
    assert_eq!(op, "memory.propose");
    assert_eq!(args["fact"], "Deploys on Tuesdays");
    assert_eq!(args["projectId"], "", "no repository: the workspace's memory");
    assert_eq!(ran.output("n", 0)[0]["memory"]["status"], "candidate");

    let ran = run_one("app.memory", json!({"memoryOp": "memoryPropose", "memoryFact": "  "}), Arc::new(Script::default())).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
}

#[tokio::test]
async fn a_terminal_s_output_is_asked_of_the_flow_s_workspace() {
    let script = scripted_app(vec![
        Ok(json!({"terminal": "tests", "running": true, "text": "12 passed", "lines": 1})),
        Ok(json!([{"number": 1, "title": "dev", "running": true}, {"number": 2, "title": "tests", "running": false}])),
    ]);
    let ran = run_one("app.terminalOutput", json!({"terminalName": "tests", "lines": 20}), script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let (op, args) = script.app_calls.lock().unwrap()[0].clone();
    assert_eq!(op, "terminal.output");
    assert_eq!(args, json!({"workspaceId": "w1", "terminal": "tests", "lines": 20}));
    assert_eq!(ran.output("n", 0)[0]["text"], "12 passed");

    // No name: one item per terminal.
    let ran = run_one("app.terminalOutput", json!({"terminalName": ""}), script).await;
    assert_eq!(ran.output("n", 0).len(), 2);
}
