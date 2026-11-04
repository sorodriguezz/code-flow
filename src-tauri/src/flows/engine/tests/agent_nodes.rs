//! Agents in a flow: a roster agent answering as itself, agents at once, a lead with helpers, a team run.

use super::*;

fn script_for(agents: &[(&str, Vec<&str>)]) -> Arc<Script> {
    let script = Script::default();
    for (name, answers) in agents {
        script.by_agent.lock().unwrap().insert(name.to_string(), answers.iter().map(|answer| Ok(answer.to_string())).collect());
    }
    Arc::new(script)
}

fn one_node(id: &str, type_id: &str, params: Value) -> FlowSpec {
    flow(vec![node("start", "trigger.manual", json!({})), node(id, type_id, params)], vec![wire("start", 0, id, 0)])
}

#[tokio::test]
async fn a_roster_agent_answers_as_itself_and_keeps_its_limits() {
    let spec = one_node("agent", "ai.agent", json!({"runAs": "rosterAgent", "agent": "lectora", "prompt": "Resume", "access": "edit", "system": "En inglés."}));
    let script = script_for(&[("Lectora", vec!["resumen"])]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("agent", 0);
    assert_eq!(out[0]["text"], "resumen");
    assert_eq!(out[0]["agent"], "Lectora");
    let calls = script.calls.lock().unwrap();
    assert_eq!(calls[0].engine.provider, "claude");
    assert_eq!(calls[0].engine.model, "claude-model");
    assert_eq!(calls[0].system.as_deref(), Some("Eres «Lectora», rol de Lectora.\n\nInstrucciones de Lectora.\n\nEn inglés."));
    assert!(!calls[0].can_edit, "an agent that may not edit stays read-only even when the node says edit");
    assert!(logs_of(&ran, "agent").iter().any(|line| line.contains("may not edit")));
}

#[tokio::test]
async fn several_agents_vote_and_the_majority_wins() {
    let spec = one_node(
        "vote",
        "ai.agents",
        json!({"agents": ["ana", "beto", "caro"], "prompt": "¿Se publica?", "combine": "majority"}),
    );
    let script = script_for(&[("Ana", vec!["Sí."]), ("Beto", vec!["No"]), ("Caro", vec!["sí"])]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("vote", 0);
    assert_eq!(out[0]["text"], "Sí.");
    assert_eq!(out[0]["votes"], 2);
    assert_eq!(out[0]["answers"].as_array().unwrap().len(), 3);
    assert_eq!(out[0]["answers"][1]["agent"], "Beto", "answers keep the agents' order");
    let calls = script.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    let folders: std::collections::HashSet<_> = calls.iter().map(|call| call.cwd.clone()).collect();
    assert_eq!(folders.len(), 3, "on the desk each agent works in a folder of its own");
    let ana = calls.iter().find(|call| call.engine.provider == "claude").unwrap();
    assert_eq!(ana.effort.as_deref(), Some("high"), "the agent's own effort");
}

#[tokio::test]
async fn a_judge_agent_writes_the_final_answer() {
    let spec = one_node(
        "pick",
        "ai.agents",
        json!({"agents": ["ana", "beto"], "prompt": "Titular", "combine": "judgeByAgent", "judgeAgent": "caro"}),
    );
    let script = script_for(&[
        ("Ana", vec!["Titular A"]),
        ("Beto", vec!["Titular B"]),
        ("Caro", vec![r#"{"winner": "Beto", "reason": "más claro", "answer": "Titular B, pulido"}"#]),
    ]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("pick", 0);
    assert_eq!(out[0]["text"], "Titular B, pulido");
    assert_eq!(out[0]["winner"], "Beto");
    assert_eq!(out[0]["judge"]["agent"], "Caro");
    let calls = script.calls.lock().unwrap();
    let judge = calls.iter().find(|call| call.engine.provider == "gemini").unwrap();
    assert!(judge.data.contains("RESPUESTA DE Ana") && judge.data.contains("Titular B"), "{}", judge.data);
}

#[tokio::test]
async fn one_agent_goes_through_every_item_and_answers_stay_paired() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("data", "return [{t: 'uno'}, {t: 'dos'}, {t: 'tres'}];"),
            node("each", "ai.agents", json!({"mode": "perItem", "agent": "ana", "prompt": "=Traduce {{ $json.t }}", "concurrency": 2})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "each", 0)],
    );
    let script = script_for(&[("Ana", vec!["x", "y", "z"])]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let report = ran.report("each");
    let paired: Vec<Option<u32>> = report.outputs[0].iter().map(|item| item.paired).collect();
    assert_eq!(paired, vec![Some(0), Some(1), Some(2)]);
    let prompts: Vec<String> = script.calls.lock().unwrap().iter().map(|call| call.prompt.clone()).collect();
    for word in ["uno", "dos", "tres"] {
        assert!(prompts.iter().any(|prompt| prompt.starts_with(&format!("Traduce {word}\n"))), "{prompts:?}");
    }
}

#[tokio::test]
async fn a_lead_delegates_a_round_then_answers() {
    let spec = one_node(
        "lead",
        "ai.orchestrator",
        json!({"runAs": "rosterAgent", "agent": "jefe", "helpers": ["ana", "beto"], "prompt": "Informe de la competencia", "maxRounds": 3}),
    );
    let script = script_for(&[
        (
            "Jefe",
            vec![
                r#"{"done": false, "answer": "", "calls": [{"to": "Ana", "task": "precios de X"}, {"to": "Beto", "task": "novedades de X"}]}"#,
                r#"{"done": true, "answer": "Informe final", "calls": []}"#,
            ],
        ),
        ("Ana", vec!["X cuesta 10"]),
        ("Beto", vec!["X lanzó Y"]),
    ]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("lead", 0);
    assert_eq!(out[0]["text"], "Informe final");
    assert_eq!(out[0]["calls"].as_array().unwrap().len(), 2);
    assert_eq!(out[0]["lead"], "Jefe");
    let calls = script.calls.lock().unwrap();
    assert_eq!(calls.len(), 4, "two lead turns and two helpers");
    let ana = calls.iter().find(|call| call.system.as_deref().is_some_and(|s| s.starts_with("Eres «Ana»"))).unwrap();
    assert!(ana.prompt.starts_with("precios de X\n") && !ana.prompt.contains("competencia"), "a helper gets only its own task: {}", ana.prompt);
    let second = calls.iter().filter(|call| call.system.as_deref().is_some_and(|s| s.starts_with("Eres «Jefe»"))).nth(1).unwrap();
    assert!(second.prompt.contains("X cuesta 10") && second.prompt.contains("X lanzó Y"), "{}", second.prompt);
}

#[tokio::test]
async fn a_lead_that_keeps_delegating_is_stopped_at_its_last_round() {
    let spec = one_node("lead", "ai.orchestrator", json!({"runAs": "rosterAgent", "agent": "jefe", "helpers": ["ana"], "prompt": "Objetivo", "maxRounds": 2}));
    let keep_going = r#"{"done": false, "answer": "", "calls": [{"to": "Ana", "task": "más"}]}"#;
    let script = script_for(&[("Jefe", vec![keep_going, r#"{"done": false, "answer": "lo que hay", "calls": [{"to": "Ana", "task": "más"}]}"#]), ("Ana", vec!["dato"])]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("lead", 0);
    assert_eq!(out[0]["text"], "lo que hay");
    let calls = script.calls.lock().unwrap();
    assert_eq!(calls.len(), 3, "two lead turns, one helper — the last round runs no work");
    assert!(calls[2].prompt.contains("ÚLTIMA"), "{}", calls[2].prompt);
}

#[tokio::test]
async fn a_team_run_takes_the_goal_and_decides_in_the_flow() {
    let spec = one_node(
        "team",
        "ai.team",
        json!({"team": "t1", "project": "p1", "prompt": "=Añade {{ 'CSV' }}", "targetBranch": "develop", "timeoutHours": 2}),
    );
    let script = Arc::new(Script::default());
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("team", 0)[0]["summary"], "hecho: Añade CSV");
    let requests = script.team_requests.lock().unwrap();
    assert_eq!(requests[0].team_id, "t1");
    assert_eq!(requests[0].target_branch, "develop");
    assert!(requests[0].wait && requests[0].decide_in_flow);
    assert_eq!(requests[0].wait_timeout, Some(Duration::from_secs(7200)));
}

#[tokio::test]
async fn on_the_desk_each_agent_writes_in_a_folder_of_its_own() {
    let spec = one_node("desk", "ai.agents", json!({"agents": ["ana", "lectora"], "prompt": "Escribe el informe", "workIn": "temp"}));
    let script = script_for(&[("Ana", vec!["dejé entrega.md"]), ("Lectora", vec!["solo leí"])]);
    *script.touch.lock().unwrap() = Some("entrega.md".into());
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("desk", 0);
    let ana = &out[0]["answers"][0];
    assert_eq!(ana["files"], json!(["entrega.md"]));
    assert!(ana["folder"].as_str().unwrap().ends_with("/ana"), "{}", ana["folder"]);
    assert!(out[0]["answers"][1].get("files").is_none(), "an agent that may not edit writes nothing");
    let calls = script.calls.lock().unwrap();
    let (writer, reader): (Vec<&AiCall>, Vec<&AiCall>) = calls.iter().partition(|call| call.system.as_deref().is_some_and(|s| s.starts_with("Eres «Ana»")));
    assert!(writer[0].can_edit && writer[0].prompt.contains("tu propia carpeta"));
    assert!(!reader[0].can_edit && !reader[0].prompt.contains("tu propia carpeta"));
    assert_ne!(writer[0].cwd, reader[0].cwd, "never the same folder");
}

#[tokio::test]
async fn the_lead_reads_the_desk_and_is_told_where_the_work_is() {
    let spec = one_node("lead", "ai.orchestrator", json!({"runAs": "rosterAgent", "agent": "jefe", "helpers": ["ana"], "prompt": "Objetivo", "workIn": "temp"}));
    let script = script_for(&[
        ("Jefe", vec![r#"{"done": false, "answer": "", "calls": [{"to": "Ana", "task": "investiga"}]}"#, r#"{"done": true, "answer": "listo", "calls": []}"#]),
        ("Ana", vec!["está en entrega.md"]),
    ]);
    *script.touch.lock().unwrap() = Some("entrega.md".into());
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("lead", 0);
    assert_eq!(out[0]["files"], json!(["ana/entrega.md"]));
    assert_eq!(out[0]["calls"][0]["folder"], "ana");
    let calls = script.calls.lock().unwrap();
    let leads: Vec<&AiCall> = calls.iter().filter(|call| call.system.as_deref().is_some_and(|s| s.starts_with("Eres «Jefe»"))).collect();
    assert!(!leads[1].can_edit, "the lead only reads the desk");
    assert!(leads[1].prompt.contains("su trabajo completo está en `ana/`"), "{}", leads[1].prompt);
}
