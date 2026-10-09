//! The model calls behind the AI nodes, as the app makes them — the [`RunHost`] methods `ai`,
//! `local_ai` and `agent_task` of the run host in [`super::runs`].
//!
//! * [`cli`] runs one of the six subscription CLIs through [`crate::ai::flow_turn`]: as the node's
//!   account, with the node's CodeFlow MCP servers, inside an `ai_runs` scope so the status bar
//!   lists it and its Stop works. `flows:ai` goes out first, so the main window can name the row
//!   after the flow instead of filing it as a run nobody here started.
//! * [`local`] asks a local server through [`crate::hybrid::local_llm`] — the bundled engine
//!   (started on demand), Ollama natively with an explicit context, or an OpenAI-compatible one.
//! * [`agent_task`] files a chain in the Agents console and asks the main window to advance it —
//!   chains are driven from there and only there — then watches the row until it ends.
//!
//! Nothing here decides anything a node should: fallbacks, schemas and caps are the node's
//! (`nodes::ai`), so they are the same in a test host.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

use super::engine::{AgentRequest, AiAnswer, AiCall, EngineChoice, LocalAnswer, LocalCall, LogStream, RunHost};
use super::runs::AppHost;
use crate::ai_accounts::Choice;
use crate::ai_runs;
use crate::commands::claude_cmd::{load_ai_config_as, load_ai_config_in, shared_template, AiConfig, AiTask};
use crate::db::{queries, Db};
use crate::hybrid::local_llm::{self, BackendKind, ChatRequest, Endpoint, LocalError};
use crate::hybrid::{config as local_config, runtime};

/// The CLIs a node can name. `local` is not one: it never reaches [`cli`] (`ai::engine_for` would
/// quietly hand it to Cline).
pub const CLI_PROVIDERS: &[&str] = &["claude", "codex", "gemini", "grok", "opencode", "cline"];

/// How often a waiting Agents task is looked at.
const AGENT_POLL: Duration = Duration::from_secs(3);

fn lock_db(host: &AppHost) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
    let db = host.app.state::<Db>();
    // The guard borrows the state, which lives as long as the app handle the host holds.
    let db: &Db = db.inner();
    db.0.lock().map_err(|e| e.to_string())
}

fn engine_config(conn: &rusqlite::Connection, engine: &EngineChoice, workspace_id: &str) -> Result<AiConfig, String> {
    let provider = engine.provider.trim();
    if provider.is_empty() {
        return load_ai_config_in(conn, AiTask::Flows, Some(workspace_id));
    }
    if !CLI_PROVIDERS.contains(&provider) {
        return Err(format!("\"{provider}\" is not an AI engine CodeFlow knows"));
    }
    load_ai_config_as(
        conn,
        provider,
        engine.model.trim(),
        Choice::parse(Some(engine.account.as_str())),
        Some(AiTask::Flows),
        Some(workspace_id),
    )
}

/// Tells the main window an AI run of this flow is starting, so its status bar names it.
fn announce(host: &AppHost, run_id: &str, node_name: &str) {
    let _ = host.app.emit(
        "flows:ai",
        json!({
            "runId": run_id,
            "flowRunId": host.run_id,
            "flowId": host.flow_id,
            "flowName": host.flow_name,
            "workspaceId": host.workspace_id,
            "node": node_name,
        }),
    );
}

/// One turn of a subscription CLI. A cancellation from the run comes back as
/// [`ai_runs::CANCELLED_MARKER`]; one from the status bar's Stop as a plain failure, since nothing
/// stopped the flow itself.
pub(super) async fn cli(host: &AppHost, call: AiCall, cancel: CancellationToken) -> Result<AiAnswer, String> {
    if cancel.is_cancelled() {
        return Err(ai_runs::CANCELLED_MARKER.to_string());
    }
    let (config, app_mcp) = {
        let conn = lock_db(host)?;
        let config = engine_config(&conn, &call.engine, &host.workspace_id)?;
        // A read-only run loads no MCP server on the CLIs that enforce read-only, so the node only
        // offers them for an agent that may edit.
        let app_mcp = if call.can_edit && !call.mcp.is_empty() {
            let store = crate::db::api_secrets::os_store();
            let overrides: BTreeMap<String, bool> = crate::mcp_registry::list(&conn, &host.workspace_id)
                .unwrap_or_default()
                .into_iter()
                .map(|server| (crate::mcp_registry::switch_key(&server.name), call.mcp.contains(&server.name)))
                .collect();
            crate::mcp_registry::live_servers(&conn, &store, &host.workspace_id, &config.provider, &overrides)
        } else {
            Vec::new()
        };
        (config, app_mcp)
    };
    // Other agents in the same checkout are told a flow is working there, as they are told of a chat.
    let _presence = call.cwd.as_deref().map(|cwd| {
        crate::ai_locks::enter(cwd, &format!("el flujo «{}» (nodo «{}»)", host.flow_name, call.node_name))
    });

    let run_id = format!("flow-ai-{}", uuid::Uuid::new_v4());
    announce(host, &run_id, &call.node_name);
    let schema = call.schema.as_ref().map(Value::to_string);
    let turn = crate::ai::FlowTurn {
        message: &call.prompt,
        data: &call.data,
        system_prompt: call.system.as_deref(),
        session_id: call.session.as_deref(),
        cwd: call.cwd.as_deref(),
        can_edit: call.can_edit,
        allowed_tools: &config.tools,
        effort: call.effort.as_deref(),
        json_schema: schema.as_deref(),
        app_mcp,
    };
    let run = ai_runs::scoped(
        host.app.clone(),
        Some(run_id.clone()),
        crate::ai::flow_turn(&*config.engine, &config.binary, &config.model, turn),
    );
    tokio::pin!(run);
    // The run first, so it is registered before a cancellation can look for it.
    let result = tokio::select! {
        biased;
        result = &mut run => result,
        _ = cancel.cancelled() => {
            ai_runs::cancel(&run_id);
            run.await
        }
    };
    match result {
        Ok(run) => Ok(AiAnswer {
            text: run.text,
            provider: config.provider.clone(),
            model: run.model.unwrap_or_else(|| config.model.clone()),
            account: config.account_id().map(str::to_string),
            session: run.session_id,
            usage: run.usage.map(|usage| {
                json!({
                    "inputTokens": usage.input_tokens,
                    "outputTokens": usage.output_tokens,
                    "cacheReadTokens": usage.cache_read_tokens,
                    "costUsd": usage.cost_usd,
                })
            }),
        }),
        Err(error) if error.starts_with(ai_runs::CANCELLED_MARKER) && !cancel.is_cancelled() => {
            Err("The AI run was stopped from the status bar".to_string())
        }
        Err(error) => Err(error),
    }
}

fn nonblank(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// One request to a local model.
pub(super) async fn local(host: &AppHost, call: LocalCall, cancel: CancellationToken) -> Result<LocalAnswer, String> {
    local_on(&host.app, Some(host), call, cancel).await
}

/// [`local`] for a run (`host`, which the status bar names) or for a command outside one.
async fn local_on(app: &tauri::AppHandle, host: Option<&AppHost>, call: LocalCall, cancel: CancellationToken) -> Result<LocalAnswer, String> {
    if cancel.is_cancelled() {
        return Err(ai_runs::CANCELLED_MARKER.to_string());
    }
    let settings = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        local_config::read(&conn)?
    };
    let api_key = call.api_key.clone().or_else(local_config::api_key);
    let (kind, url, model, context) = match BackendKind::from_setting(&call.server) {
        Some(kind) => {
            let url = nonblank(&call.url).unwrap_or_else(|| settings.url_for(kind));
            let mut model = nonblank(&call.model).or_else(|| settings.model_for(kind));
            if model.is_none() {
                model = match kind {
                    BackendKind::Bundled => Some(crate::localai::exec_catalogue::DEFAULT_EXEC_MODEL_ID.to_string()),
                    _ => {
                        let endpoint = Endpoint::new(kind, &url, api_key.clone());
                        let listed = local_llm::list_models(&endpoint).await.map_err(|e| e.sentence())?;
                        runtime::pick_model(None, &listed)
                    }
                };
            }
            let model = model.ok_or_else(|| "The local server has no model to run — pull or choose one first".to_string())?;
            let context = if call.context > 0 { call.context } else { settings.ctx.unwrap_or(8_192) };
            (kind, url, model, context)
        }
        None => {
            let resolved = runtime::resolve(&settings, runtime::Freshness::Recent).await;
            if let Some(error) = resolved.error.clone() {
                return Err(error);
            }
            let model = nonblank(&call.model)
                .or(resolved.model.clone())
                .ok_or_else(|| "No local model is set up — choose one in Settings › AI engines › Local model".to_string())?;
            let context = if call.context > 0 { call.context } else { resolved.ctx };
            (resolved.kind, resolved.url.clone(), model, context)
        }
    };
    let live = runtime::connect(kind, &url, &model, context).await?;
    let endpoint = match (kind, &call.api_key) {
        (BackendKind::Openai, Some(key)) => Endpoint::new(kind, &url, Some(key.clone())),
        _ => live.endpoint.clone(),
    };

    let run_id = format!("flow-local-{}", uuid::Uuid::new_v4());
    if let Some(host) = host {
        announce(host, &run_id, &call.node_name);
    }
    let label = match kind {
        BackendKind::Bundled => "Local model",
        BackendKind::Ollama => "Ollama",
        BackendKind::Openai => "Local server",
    };
    if !call.messages.is_empty() || !call.tools.is_empty() {
        return converse(app, &run_id, label, kind, &endpoint, &live.model, context, &call, cancel).await;
    }
    let request = ChatRequest {
        model: &live.model,
        system: &call.system,
        user: &call.prompt,
        num_ctx: (kind == BackendKind::Ollama).then_some(context),
        max_tokens: call.max_tokens.max(16),
        temperature: call.temperature,
        think: None,
        keep_alive: (kind == BackendKind::Ollama).then_some("5m"),
        schema: call.schema.as_ref(),
    };
    let work = async {
        let mut stop = None;
        if let Some(scope) = ai_runs::current() {
            ai_runs::emit_engine(&scope, "local", label, &live.model, None);
            stop = ai_runs::subscribe(&run_id);
        }
        let stopped = async {
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = ai_runs::cancelled(&mut stop) => {}
            }
        };
        local_llm::chat(&endpoint, &request, |_| {}, stopped).await
    };
    let outcome = ai_runs::scoped(app.clone(), Some(run_id.clone()), work).await;
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(LocalError::Cancelled) if cancel.is_cancelled() => return Err(ai_runs::CANCELLED_MARKER.to_string()),
        Err(LocalError::Cancelled) => return Err("The local model run was stopped from the status bar".to_string()),
        Err(error) => return Err(error.sentence()),
    };
    let usage = crate::ai::AiUsage {
        input_tokens: outcome.prompt_tokens.unwrap_or(0) as i64,
        output_tokens: outcome.completion_tokens.unwrap_or(0) as i64,
        ..Default::default()
    };
    crate::ai_usage::record("local", &live.model, crate::ai::task::FLOWS, None, &usage);
    Ok(LocalAnswer {
        text: outcome.text,
        server: kind.as_str().to_string(),
        model: live.model.clone(),
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        cut: outcome.finish == local_llm::Finish::Length,
        ..Default::default()
    })
}

/// A local model's turn in a conversation — remembered turns, other flows as tools.
#[allow(clippy::too_many_arguments)]
async fn converse(
    app: &tauri::AppHandle,
    run_id: &str,
    label: &str,
    kind: BackendKind,
    endpoint: &Endpoint,
    model: &str,
    context: u32,
    call: &LocalCall,
    cancel: CancellationToken,
) -> Result<LocalAnswer, String> {
    let mut messages = Vec::with_capacity(call.messages.len() + 1);
    if !call.system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": call.system }));
    }
    messages.extend(call.messages.iter().cloned());
    let request = local_llm::ConverseRequest {
        model,
        messages: &messages,
        tools: &call.tools,
        no_more_tools: call.no_more_tools,
        num_ctx: (kind == BackendKind::Ollama).then_some(context),
        max_tokens: call.max_tokens.max(16),
        temperature: call.temperature,
        keep_alive: (kind == BackendKind::Ollama).then_some("5m"),
    };
    let work = async {
        let mut stop = None;
        if let Some(scope) = ai_runs::current() {
            ai_runs::emit_engine(&scope, "local", label, model, None);
            stop = ai_runs::subscribe(run_id);
        }
        let stopped = async {
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = ai_runs::cancelled(&mut stop) => {}
            }
        };
        local_llm::converse(endpoint, &request, stopped).await
    };
    let outcome = match ai_runs::scoped(app.clone(), Some(run_id.to_string()), work).await {
        Ok(outcome) => outcome,
        Err(LocalError::Cancelled) if cancel.is_cancelled() => return Err(ai_runs::CANCELLED_MARKER.to_string()),
        Err(LocalError::Cancelled) => return Err("The local model run was stopped from the status bar".to_string()),
        Err(error) => return Err(error.sentence()),
    };
    let usage = crate::ai::AiUsage {
        input_tokens: outcome.prompt_tokens.unwrap_or(0) as i64,
        output_tokens: outcome.completion_tokens.unwrap_or(0) as i64,
        ..Default::default()
    };
    crate::ai_usage::record("local", model, crate::ai::task::FLOWS, None, &usage);
    Ok(LocalAnswer {
        text: outcome.text,
        server: kind.as_str().to_string(),
        model: model.to_string(),
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        cut: outcome.finish == local_llm::Finish::Length,
        message: Some(outcome.message),
        tool_calls: outcome.tool_calls,
    })
}

/// One question outside a run — «Generar código» of «Transformar con IA» — on the node's engine.
/// `run_id` files it in the AI run log, where its Stop works. Answers the model's text.
#[allow(clippy::too_many_arguments)]
pub async fn ask_outside(
    app: &tauri::AppHandle,
    workspace_id: &str,
    engine: &EngineChoice,
    system: &str,
    prompt: &str,
    data: &str,
    schema: &Value,
    run_id: Option<String>,
) -> Result<String, String> {
    if engine.is_local() {
        let call = LocalCall {
            server: "auto".into(),
            model: engine.model.clone(),
            system: system.to_string(),
            prompt: format!("{prompt}\n\n{data}"),
            schema: Some(schema.clone()),
            temperature: 0.2,
            max_tokens: 8_192,
            node_name: "Transformar con IA".into(),
            ..Default::default()
        };
        return local_on(app, None, call, CancellationToken::new()).await.map(|answer| answer.text);
    }
    let config = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        engine_config(&conn, engine, workspace_id)?
    };
    let schema = schema.to_string();
    ai_runs::scoped(app.clone(), run_id, crate::ai::build_flow(&*config.engine, &config.binary, &config.model, system, prompt, data, &schema)).await
}

/// The template the user keeps for one of the shortcuts, or `""` for the built-in one.
pub(super) fn template(host: &AppHost, kind: &str) -> String {
    let (key, legacy) = match kind {
        "commit" => ("commit_template", "claude_commit_template"),
        "pr" => ("pr_description_template", "claude_pr_description_template"),
        "review" => ("analyze_template", "claude_analyze_template"),
        _ => return String::new(),
    };
    lock_db(host).ok().and_then(|conn| shared_template(&conn, key, legacy).ok()).unwrap_or_default()
}

/// The engine's plan at the last reading, from the quota cache — never a request.
pub(super) fn quota(host: &AppHost, engine: &EngineChoice) -> Option<(f64, String)> {
    let key = {
        let conn = lock_db(host).ok()?;
        engine_config(&conn, engine, &host.workspace_id).ok()?.account.key()
    };
    crate::ai_quota::cached_tightest(&key)
}

/// Files a chain for the Agents console — one step for an agent, or a saved template's steps — and,
/// with `wait`, follows it until it ends.
pub(super) async fn agent_task(host: &AppHost, request: AgentRequest, cancel: CancellationToken) -> Result<Value, String> {
    let detail = {
        let conn = lock_db(host)?;
        let (steps, default_title) = if !request.template_id.is_empty() {
            let template = queries::list_chain_templates(&conn, &host.workspace_id)
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|template| template.id == request.template_id)
                .ok_or_else(|| "That chain template no longer exists".to_string())?;
            if template.kind != "chain" {
                return Err("Only a template of steps can run from a flow".to_string());
            }
            let steps: Vec<crate::db::models::NewChainStep> = template
                .steps
                .iter()
                .map(|step| crate::db::models::NewChainStep {
                    agent_id: step.agent_id.clone(),
                    instruction: step.instruction.clone(),
                    gate: step.gate,
                    check_command: step.check_command.clone(),
                    on_pass: step.on_pass,
                    on_fail: step.on_fail,
                    ..Default::default()
                })
                .collect();
            (steps, template.name.clone())
        } else {
            let step = crate::db::models::NewChainStep {
                agent_id: request.agent_id.clone(),
                instruction: request.instruction.clone(),
                ..Default::default()
            };
            let first_line: String = request.instruction.lines().next().unwrap_or_default().chars().take(80).collect();
            (vec![step], first_line)
        };
        if steps.is_empty() {
            return Err("The template has no steps".to_string());
        }
        let title = nonblank(&request.title).unwrap_or(default_title);
        let goal = request.instruction.clone();
        let detail = queries::create_agent_chain(&conn, &[request.project_id.clone()], &title, &goal, &steps, "")
            .map_err(|e| e.to_string())?;
        queries::resume_chain(&conn, &detail.chain.id).map_err(|e| e.to_string())?;
        detail
    };
    let chain_id = detail.chain.id.clone();
    let _ = host.app.emit(
        "flows:agent",
        json!({ "chainId": chain_id, "workspaceId": host.workspace_id, "flowId": host.flow_id, "flowRunId": host.run_id }),
    );
    host.log(&request.node_id, LogStream::Info, &format!("Agents: «{}» queued", detail.chain.title));
    if !request.wait {
        return Ok(chain_summary(&detail));
    }

    let mut said = String::new();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(AGENT_POLL) => {}
            _ = cancel.cancelled() => {
                if let Ok(conn) = lock_db(host) {
                    let _ = queries::abort_chain(&conn, &chain_id);
                }
                let _ = host.app.emit("flows:agent", json!({ "chainId": chain_id, "workspaceId": host.workspace_id, "aborted": true }));
                return Err(ai_runs::CANCELLED_MARKER.to_string());
            }
        }
        let detail = {
            let conn = lock_db(host)?;
            queries::get_chain_detail(&conn, &chain_id).map_err(|e| e.to_string())?
        };
        let Some(detail) = detail else {
            return Err("The task was deleted from Agents".to_string());
        };
        let status = detail.chain.status.as_str();
        match status {
            "done" => return Ok(chain_summary(&detail)),
            "failed" | "aborted" => {
                let reason = detail.chain.last_reason.trim();
                return Err(if reason.is_empty() {
                    format!("The task ended {status} in Agents")
                } else {
                    format!("The task ended {status} in Agents: {reason}")
                });
            }
            "gated" | "paused" if said != status => {
                said = status.to_string();
                let what = if status == "gated" { "waits for an approval in Agents" } else { "is paused in Agents" };
                host.log(&request.node_id, LogStream::Info, &format!("«{}» {what}", detail.chain.title));
            }
            _ => {}
        }
    }
}

fn chain_summary(detail: &crate::db::models::ChainDetail) -> Value {
    json!({
        "chainId": detail.chain.id,
        "title": detail.chain.title,
        "status": detail.chain.status,
        "steps": detail.steps.iter().map(|step| json!({
            "index": step.step_index,
            "agent": step.agent_name,
            "status": step.status,
            "output": step.output_text,
            "error": step.last_error,
        })).collect::<Vec<_>>(),
        "output": detail.steps.iter().rev().find(|step| !step.output_text.trim().is_empty()).map(|step| step.output_text.clone()),
    })
}

/// Against the real CLIs, so ignored by default — and it spends a little real quota: one short
/// structured answer per installed CLI, on the cheapest model where there is a choice. Run with
/// `CODEFLOW_LIVE_FLOWS=1 cargo test --lib flows::ai_host::live -- --ignored --nocapture`, or name
/// the CLIs (`CODEFLOW_LIVE_FLOWS=claude,codex`).
#[cfg(test)]
mod live {
    use std::time::Instant;

    use serde_json::json;

    fn wanted(provider: &str) -> bool {
        match std::env::var("CODEFLOW_LIVE_FLOWS") {
            Ok(value) if value == "1" || value == "all" => true,
            Ok(value) => value.split(',').any(|name| name.trim() == provider),
            Err(_) => false,
        }
    }

    #[tokio::test]
    #[ignore]
    async fn every_installed_cli_answers_to_a_schema() {
        let schema = crate::flows::schema::from_fields(&json!([
            {"name": "n", "type": "integer"},
            {"name": "color", "type": "enum", "options": "rojo, verde"},
        ]))
        .unwrap();
        let schema_text = schema.to_string();
        let prompt = format!(
            "Responde con n = 7 y color = verde.\n\nResponde ÚNICAMENTE con un objeto JSON que cumpla este JSON Schema — \
             sin texto antes ni después y sin bloque de código:\n{}",
            serde_json::to_string_pretty(&schema).unwrap()
        );
        let dir = std::env::temp_dir().join(format!("cf-flows-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let mut failures = Vec::new();
        for provider in super::CLI_PROVIDERS {
            if !wanted(provider) {
                continue;
            }
            let engine = crate::ai::engine_for(provider);
            let binary = engine.default_binary();
            if crate::ai::find_on_path(binary).is_none() {
                eprintln!("{provider}: not installed");
                continue;
            }
            let model = if *provider == "claude" { "claude-haiku-4-5-20251001" } else { "" };
            let turn = crate::ai::FlowTurn {
                message: &prompt,
                data: "",
                system_prompt: None,
                session_id: None,
                cwd: Some(&cwd),
                can_edit: false,
                allowed_tools: &[],
                effort: None,
                json_schema: Some(&schema_text),
                app_mcp: Vec::new(),
            };
            let started = Instant::now();
            match crate::ai::flow_turn(&*engine, binary, model, turn).await {
                Ok(run) => {
                    let mut object = crate::flows::schema::answer_object(&run.text);
                    if let Some(object) = &mut object {
                        crate::flows::schema::prune(object, &schema);
                    }
                    let problems = match &object {
                        Some(object) => crate::flows::schema::validate(object, &schema),
                        None => vec!["the answer is not a JSON object".to_string()],
                    };
                    eprintln!(
                        "{provider}: model={:?} {:.1}s session={:?} usage={:?}\n  text={:?}\n  problems={problems:?}",
                        run.model,
                        started.elapsed().as_secs_f64(),
                        run.session_id,
                        run.usage,
                        run.text.chars().take(300).collect::<String>(),
                    );
                    if !problems.is_empty() || object.as_ref().map(|o| o["n"] != 7).unwrap_or(true) {
                        failures.push(format!("{provider}: {problems:?} — {}", run.text));
                    }
                }
                Err(error) => {
                    eprintln!("{provider}: ERROR {error}");
                    failures.push(format!("{provider}: {error}"));
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(failures.is_empty(), "{failures:#?}");
    }
}
