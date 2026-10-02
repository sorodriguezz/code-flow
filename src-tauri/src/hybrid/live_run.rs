//! Real hybrid runs, end to end: the subscription's own CLI plans and reviews, the local model writes,
//! against a fresh clone of a repository — the same moves the Agents view makes (claim a step, run
//! it, complete it, run its check first), minus the window.
//!
//! Ignored: the full run spends real subscription quota. Run with
//!
//! ```text
//! CODEFLOW_LIVE_HYBRID=/path/to/a/git/repo cargo test --lib hybrid::live_run -- --ignored --nocapture
//! ```
//!
//! It needs `claude` signed in and an Ollama with `qwen2.5-coder:7b`. The clone is left behind and
//! its path printed, so what the run wrote can be read afterwards.

use std::path::{Path, PathBuf};

use crate::db::models::NewProject;
use crate::db::{hybrid_queries, migrations, queries, Db};
use crate::hybrid::plan::{PlanCheck, RepoRef};
use crate::hybrid::{budget, execute, prompts, triage};

const LOCAL_MODEL: &str = "qwen2.5-coder:7b";
const PLANNER_MODEL: &str = "sonnet";

fn source_repo() -> Option<String> {
    std::env::var("CODEFLOW_LIVE_HYBRID").ok().filter(|path| Path::new(path).join(".git").exists())
}

fn clone_of(source: &str, tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cf-live-{tag}-{}", uuid::Uuid::new_v4()));
    let status = std::process::Command::new("git").args(["clone", "--quiet", source]).arg(&dir).status().unwrap();
    assert!(status.success(), "git clone");
    for (key, value) in [("user.email", "live@example.com"), ("user.name", "Live run")] {
        std::process::Command::new("git").arg("-C").arg(&dir).args(["config", key, value]).status().unwrap();
    }
    dir
}

/// A database with one workspace, one repository and one roster agent on Claude.
fn database(repo: &Path) -> (Db, String, String) {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    migrations::run(&conn).unwrap();
    let ws = queries::create_workspace(&conn, "Live", "folder", "#fff").unwrap();
    let project = queries::create_project(
        &conn,
        NewProject {
            workspace_id: ws.id.clone(),
            name: "orders-service".into(),
            local_path: repo.to_string_lossy().into_owned(),
            remote_url: None,
            color: "#fff".into(),
            icon: "folder".into(),
            ado_org: None,
            ado_project: None,
            ado_repo_id: None,
            github_owner: None,
            github_repo: None,
            github_host: None,
            gitlab_project: None,
            gitlab_host: None,
        },
    )
    .unwrap();
    let agent = queries::upsert_workspace_agent(&conn, None, &ws.id, "Claude", "", "claude", PLANNER_MODEL, "", true, None).unwrap();
    (Db(std::sync::Mutex::new(conn)), project.id, agent.id)
}

/// The run's configuration as `create_hybrid_task` would freeze it for Ollama at 16k.
fn run_config(review_mode: &str, checks: Vec<PlanCheck>) -> hybrid_queries::HybridRun {
    let budget = budget::budget_for(16_384);
    hybrid_queries::HybridRun {
        chain_id: String::new(),
        backend: "ollama".into(),
        base_url: "http://127.0.0.1:11434".into(),
        model: LOCAL_MODEL.into(),
        ctx: 16_384,
        budget_input: budget.input as i64,
        budget_output: budget.output as i64,
        delegate: "medium".into(),
        on_fail: "review".into(),
        review_mode: review_mode.into(),
        unload: false,
        thinking: false,
        plan_summary: String::new(),
        plan_risks: vec![],
        checks: checks.clone(),
        approved_checks: checks,
        gate_note: String::new(),
        baseline_commit: String::new(),
        plan_input_tokens: 0,
        plan_output_tokens: 0,
        review_input_tokens: 0,
        review_output_tokens: 0,
        direct: false,
        fix_round: 0,
        review_skip: String::new(),
        created_at: queries::now(),
        updated_at: queries::now(),
    }
}

/// One subscription turn, the way `send_chat_message` makes it.
async fn cli_turn(cwd: &str, message: &str, session: Option<&str>, read_only: bool, schema: Option<&str>) -> crate::ai::AiRun {
    let engine = crate::ai::engine_for("claude");
    crate::ai::chat_with_repo(&*engine, "claude", PLANNER_MODEL, &[], message, session, &[], cwd, None, read_only, Vec::new(), Vec::new(), &[], schema, &[])
        .await
        .expect("the CLI answers")
}

/// Runs the step's check the way the Agents view does before completing it: each command in its
/// repository, the first failure being the verdict.
async fn step_check(db: &Db, step_id: &str) -> Option<(bool, String)> {
    use crate::commands::agents_cmd::{run_check_process, CheckEnd, CHECK_TIMEOUT};
    let target = queries::chain_step_check(&db.0.lock().unwrap(), step_id).unwrap();
    let (_, checks) = target?;
    let stop = std::sync::Arc::new(tokio::sync::Notify::new());
    let mut out = String::new();
    for (command, cwd) in checks {
        let (passed, output) = match run_check_process(&command, &cwd, CHECK_TIMEOUT, &stop).await {
            CheckEnd::Exited { success, output } => (success, output),
            CheckEnd::TimedOut { output } => (false, output),
            CheckEnd::Failed(output) => (false, output),
            CheckEnd::Stopped => (false, String::new()),
        };
        out.push_str(&format!("$ {command}\n{output}\n"));
        if !passed {
            return Some((false, out));
        }
    }
    Some((true, out))
}

fn print_items(db: &Db, chain_id: &str) {
    let items = hybrid_queries::list_items(&db.0.lock().unwrap(), chain_id).unwrap();
    for item in items {
        eprintln!(
            "  [{}] r{} {} {} ({}, {}) → {} {}  in {} out {} {} ms  {}",
            item.task_key,
            item.round,
            item.file,
            item.action,
            item.difficulty,
            item.assignee,
            item.status,
            if item.error_code.is_empty() { String::new() } else { format!("[{}]", item.error_code) },
            item.tokens_in,
            item.tokens_out,
            item.ms,
            item.error
        );
    }
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").arg("-C").arg(repo).args(args).output().unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A small change that names its file: no plan, no review, no subscription — the local model alone.
#[tokio::test]
#[ignore = "needs a local Ollama with qwen2.5-coder:7b and CODEFLOW_LIVE_HYBRID"]
async fn a_small_task_goes_straight_to_the_local_model() {
    let Some(source) = source_repo() else { return };
    let repo = clone_of(&source, "direct");
    let (db, project, agent) = database(&repo);
    let goal = "En src/ui/status.ts agrega `export function isOpen(status: Status): boolean` que devuelva lo contrario de `isTerminal(status)`.";
    let verdict = triage::triage(&repo, goal, &budget::budget_for(16_384));
    eprintln!("triage: {verdict:?}");
    assert!(verdict.direct, "the triage sends it to the local model");
    let files: Vec<String> = verdict.files.iter().map(|file| file.path.clone()).collect();
    let check = PlanCheck { repo: project.clone(), command: "grep -q 'export function isOpen' src/ui/status.ts".into() };
    let detail = queries::create_hybrid_chain(
        &db.0.lock().unwrap(),
        &[project.clone()],
        "isOpen",
        goal,
        &agent,
        &agent,
        "",
        true,
        &run_config("local", vec![check]),
        Some(&files),
    )
    .unwrap();
    let chain_id = detail.chain.id.clone();
    queries::resume_chain(&db.0.lock().unwrap(), &chain_id).unwrap();
    let claim = queries::claim_next_chain_step(&db.0.lock().unwrap(), &chain_id, "live-direct").unwrap();
    assert_eq!(claim.step.as_ref().unwrap().phase, "execute");
    let repos = vec![RepoRef { project_id: project.clone(), name: "orders-service".into(), path: repo.to_string_lossy().into_owned() }];
    let app = tauri::test::mock_app();
    let started = std::time::Instant::now();
    let report = execute::run(execute::Job { app: app.handle(), db: &db, chain_id: &chain_id, repos: &repos }).await.expect("the run completes");
    let chain = queries::complete_chain_step(&db.0.lock().unwrap(), &claim.step.unwrap().id, "done", &report, "").unwrap().unwrap();
    eprintln!("{report}");
    eprintln!("direct run: {:?} in {} s", chain.status, started.elapsed().as_secs());
    print_items(&db, &chain_id);
    let run = hybrid_queries::get_run(&db.0.lock().unwrap(), &chain_id).unwrap().unwrap();
    assert_eq!(chain.status, "done");
    assert_eq!((run.plan_input_tokens, run.review_input_tokens), (0, 0), "no subscription token spent");
    assert!(report.contains("passed"), "the check passed");
    eprintln!("clone kept at {}", repo.display());
}

/// Drives a hybrid run to its end the way the Agents view does, with the real subscription for the
/// plan and the review and the local model for everything else, and prints what happened.
async fn drive(tag: &str, goal: &str, check: &str) -> (PathBuf, crate::db::models::ChainDetail, hybrid_queries::HybridRun) {
    let source = source_repo().expect("CODEFLOW_LIVE_HYBRID");
    let repo = clone_of(&source, tag);
    let (db, project, agent) = database(&repo);
    let check = PlanCheck { repo: project.clone(), command: check.to_string() };
    let detail = queries::create_hybrid_chain(
        &db.0.lock().unwrap(),
        &[project.clone()],
        tag,
        goal,
        &agent,
        &agent,
        "",
        false,
        &run_config("local", vec![check]),
        None,
    )
    .unwrap();
    let chain_id = detail.chain.id.clone();
    let cwd = repo.to_string_lossy().into_owned();
    let repos = vec![RepoRef { project_id: project.clone(), name: "orders-service".into(), path: cwd.clone() }];
    let app = tauri::test::mock_app();
    queries::resume_chain(&db.0.lock().unwrap(), &chain_id).unwrap();

    let started = std::time::Instant::now();
    let mut plan_session: Option<String> = None;
    for turn in 0..14 {
        let claim = queries::claim_next_chain_step(&db.0.lock().unwrap(), &chain_id, &format!("live-{turn}")).unwrap();
        if claim.kind != "run" {
            eprintln!("── chain {} ({})", claim.chain.status, claim.chain.last_reason);
            break;
        }
        let step = claim.step.clone().unwrap();
        let at = started.elapsed().as_secs();
        match step.phase.as_str() {
            "plan" => {
                eprintln!("── t+{at}s PLAN (claude {PLANNER_MODEL}, read-only, schema)");
                let answer = cli_turn(&cwd, &claim.message, None, true, Some(crate::hybrid::plan::PLAN_SCHEMA)).await;
                plan_session = answer.session_id.clone();
                if let Some(usage) = &answer.usage {
                    let _ = hybrid_queries::add_step_usage(&db.0.lock().unwrap(), &chain_id, "plan", usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens, usage.output_tokens);
                    eprintln!("   usage: {usage:?}");
                }
                let chain = queries::complete_chain_step(&db.0.lock().unwrap(), &step.id, "done", &answer.text, "").unwrap().unwrap();
                eprintln!("   → chain {} {}", chain.status, chain.last_reason);
                print_items(&db, &chain_id);
            }
            "execute" => {
                eprintln!("── t+{at}s EXECUTE (local {LOCAL_MODEL})");
                let report = execute::run(execute::Job { app: app.handle(), db: &db, chain_id: &chain_id, repos: &repos })
                    .await
                    .expect("the run completes");
                let chain = queries::complete_chain_step(&db.0.lock().unwrap(), &step.id, "done", &report, "").unwrap().unwrap();
                eprintln!("   checks: {}", report.lines().filter(|line| line.contains("— passed") || line.contains("— FAILED")).collect::<Vec<_>>().join(" | "));
                eprintln!("   → chain {} {}", chain.status, chain.last_reason);
                print_items(&db, &chain_id);
            }
            "review" => {
                let (schema, read_only, round) = {
                    let conn = db.0.lock().unwrap();
                    let run = hybrid_queries::get_run(&conn, &chain_id).unwrap().unwrap();
                    let items = hybrid_queries::list_items(&conn, &chain_id).unwrap();
                    let local = run.review_mode == "local" && run.fix_round < prompts::MAX_FIX_ROUNDS;
                    let read_only = run.review_mode == "report" || (local && prompts::for_review(&run, &items).is_empty());
                    (local.then_some(crate::hybrid::plan::REVIEW_SCHEMA), read_only, run.fix_round)
                };
                eprintln!("── t+{at}s REVIEW round {round} (claude, resumed: {}, read-only: {read_only}, schema: {})", plan_session.is_some(), schema.is_some());
                let answer = cli_turn(&cwd, &claim.message, plan_session.as_deref(), read_only, schema).await;
                if let Some(usage) = &answer.usage {
                    let _ = hybrid_queries::add_step_usage(&db.0.lock().unwrap(), &chain_id, "review", usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens, usage.output_tokens);
                    eprintln!("   usage: {usage:?}");
                }
                eprintln!("   answer: {}", answer.text.chars().take(1_500).collect::<String>());
                let (outcome, reason) = match step_check(&db, &step.id).await {
                    Some((false, output)) => ("check_failed", output),
                    _ => ("done", String::new()),
                };
                let chain = queries::complete_chain_step(&db.0.lock().unwrap(), &step.id, outcome, &answer.text, &reason).unwrap().unwrap();
                eprintln!("   → {outcome}: chain {} {}", chain.status, chain.last_reason);
                print_items(&db, &chain_id);
            }
            other => panic!("unexpected phase {other}"),
        }
    }

    let conn = db.0.lock().unwrap();
    let run = hybrid_queries::get_run(&conn, &chain_id).unwrap().unwrap();
    let detail = queries::get_chain_detail(&conn, &chain_id).unwrap().unwrap();
    drop(conn);
    eprintln!("════ {} s · chain {} {} · review skipped: {:?}", started.elapsed().as_secs(), detail.chain.status, detail.chain.last_reason, run.review_skip);
    eprintln!(
        "subscription: plan {}+{} · review {}+{} tokens · local correction rounds: {}",
        run.plan_input_tokens, run.plan_output_tokens, run.review_input_tokens, run.review_output_tokens, run.fix_round
    );
    print_items(&db, &chain_id);
    eprintln!("review said:\n{}", detail.steps.last().map(|s| s.output_text.as_str()).unwrap_or(""));
    eprintln!("{}", git(&repo, &["status", "--short"]));
    eprintln!("{}", git(&repo, &["diff"]));
    eprintln!("clone kept at {}", repo.display());
    (repo, detail, run)
}

/// The full loop with the real subscription: plan, local execution, and — a plan of two easy tasks
/// whose check passes — no review at all.
#[tokio::test]
#[ignore = "spends real subscription quota; needs claude signed in, Ollama and CODEFLOW_LIVE_HYBRID"]
async fn a_full_hybrid_run_with_the_subscription() {
    if source_repo().is_none() {
        return;
    }
    let goal = "Saca el cálculo del total de src/api/orders.ts a un módulo nuevo src/api/totals.ts que exporte \
`orderTotalCents(lines: OrderLine[]): number` (la suma de quantity × unitCents) y `formatCents(cents: number): string` \
(por ejemplo 1234 → \"12.34\"). En src/api/orders.ts usa orderTotalCents en lugar de la función local total() y borra \
esa función. totals.ts no debe importar nada que no sea un tipo.";
    let check = "node -e \"import('./src/api/totals.ts').then(m => { if (m.orderTotalCents([{ sku: 'a', quantity: 2, unitCents: 150 }, { sku: 'b', quantity: 1, unitCents: 5 }]) !== 305 || m.formatCents(1234) !== '12.34') { console.error('wrong totals'); process.exit(1) } })\"";
    let (repo, detail, _) = drive("full", goal, check).await;
    if let Ok(totals) = std::fs::read_to_string(repo.join("src/api/totals.ts")) {
        eprintln!("── src/api/totals.ts\n{totals}");
    }
    assert_eq!(detail.chain.status, "done", "the run ends");
}

/// A change across three files: too big to skip the review, which runs on the subscription in the
/// local fix loop — handing corrections back to the local model if it finds any.
#[tokio::test]
#[ignore = "spends real subscription quota; needs claude signed in, Ollama and CODEFLOW_LIVE_HYBRID"]
async fn a_hybrid_run_whose_review_runs() {
    if source_repo().is_none() {
        return;
    }
    let goal = "En src/ui/status.ts agrega `export function badge(status: Status): { label: string; colour: string }` que \
devuelva label(status) y el color de COLOURS para ese estado, o 'grey' cuando COLOURS no tiene uno. En src/api/router.ts \
agrega la ruta GET /status/<estado> que responda 200 con badge(estado) si el estado está en STATUSES, y 404 con \
{ error: 'unknown_status' } si no. Agrega pruebas de badge() en tests/status.test.ts con vitest, como las de tests/orders.test.ts.";
    let check = "node -e \"import('./src/ui/status.ts').then(m => { const p = m.badge('pending'); const s = m.badge('shipped'); if (p.label !== 'Pending' || p.colour !== 'amber' || s.colour !== 'grey') { console.error(JSON.stringify([p, s])); process.exit(1) } })\"";
    let (_, detail, run) = drive("review", goal, check).await;
    assert_eq!(detail.chain.status, "done", "the run ends");
    assert!(run.review_input_tokens > 0, "the review ran on the subscription");
}
