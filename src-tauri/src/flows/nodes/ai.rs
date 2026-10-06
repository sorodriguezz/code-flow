//! The AI nodes: a subscription CLI as an agent, a local model, the shortcuts built on the agent
//! (classify, extract, summarize, review, commit) and a task for the Agents console.
//!
//! **What is decided here, and what the host does.** The model call itself — a CLI started as the
//! right account, a request to a local server — is the host's ([`RunHost::ai`] and friends), so the
//! engine stays free of Tauri and a test can answer for a model. Everything a node *decides* is
//! here:
//!
//! * the prompt, and the schema an answer must follow — checked in Rust whatever the engine
//!   promised, with **one** retry that reads the problems back to the model;
//! * the fallback: when an engine is out of quota, signed out, missing or overloaded, the next one
//!   in the node's list answers. A second account of the same CLI is never a fallback — rotating
//!   accounts on exhaustion is against the providers' terms — so the list keeps one per provider;
//! * waiting for a plan to reopen, when the last engine is out of quota and its provider said when
//!   (within [`MAX_QUOTA_WAIT`]);
//! * the flow's cap on AI calls an hour, and the warning when a plan is nearly spent;
//! * the restore point an editing agent leaves in the repository, so the run can undo it.
//!
//! [`RunHost::ai`]: crate::flows::engine::RunHost::ai

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::{flag, number, strings, text, NodeCtx, NodeError};
use crate::ai::AiFailureKind;
use crate::flows::engine::{AgentRequest, EngineChoice, LocalCall, LogStream};
use crate::flows::run::{Item, Ports};
use crate::flows::schema;
use crate::flows::value::set_path;

/// The longest a node waits for an engine's plan to reopen when no fallback is left. A window that
/// reopens later than this fails the node now rather than holding the run for a day.
const MAX_QUOTA_WAIT: Duration = Duration::from_secs(6 * 60 * 60);

/// Asked again this long after the instant a plan said it reopens — a clock a few seconds apart from
/// the provider's would otherwise ask a moment too early and be refused again.
const REOPEN_MARGIN: Duration = if cfg!(test) { Duration::from_millis(200) } else { Duration::from_secs(30) };

/// A plan this full is worth a line in the run's log before it is spent further.
const NEARLY_SPENT: f64 = 80.0;

/// Diffs are cut to this before they reach a model — the review's own budget.
const MAX_DIFF_CHARS: usize = crate::ai::MAX_REVIEW_DIFF_CHARS;

/// A commit message is written from at most this much diff, as in the Changes panel.
const MAX_COMMIT_DIFF_CHARS: usize = crate::ai::MAX_DIFF_CHARS;

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "ai.agent" => agent(ctx).await,
        "ai.local" => local(ctx).await,
        "ai.classify" => classify(ctx).await,
        "ai.extract" => extract(ctx).await,
        "ai.summarize" => summarize(ctx).await,
        "ai.review" => review(ctx).await,
        "ai.prReview" => pr_review(ctx).await,
        "ai.prFix" => pr_fix(ctx).await,
        "ai.prReply" => pr_reply(ctx).await,
        "ai.chat" => chat(ctx).await,
        "ai.commit" => commit(ctx).await,
        "app.agent" => agent_task(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

// ------------------------------------------------------------------------------------ the hourly cap

/// The AI calls each flow made in the last hour, oldest first.
static CALLS: LazyLock<Mutex<HashMap<String, VecDeque<Instant>>>> = LazyLock::new(Default::default);

const HOUR: Duration = Duration::from_secs(3600);

/// Counts one call against the flow's cap, or refuses it.
fn take_slot(ctx: &NodeCtx) -> Result<(), NodeError> {
    let cap = ctx.run.ai_per_hour;
    if cap == 0 {
        return Ok(());
    }
    let mut calls = CALLS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let list = calls.entry(ctx.run.flow_id.clone()).or_default();
    while list.front().is_some_and(|at| at.elapsed() >= HOUR) {
        list.pop_front();
    }
    if list.len() as u32 >= cap {
        let wait = list.front().map(|at| HOUR.saturating_sub(at.elapsed())).unwrap_or_default();
        return Err(NodeError::failed(format!(
            "This flow reached its cap of {cap} AI calls an hour — the next one is allowed in {} min (Flow settings › AI calls an hour)",
            wait.as_secs().div_ceil(60).max(1)
        )));
    }
    list.push_back(Instant::now());
    Ok(())
}

// --------------------------------------------------------------------------------------- engines

fn engine_of(value: Option<&Value>) -> EngineChoice {
    value.cloned().and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default()
}

/// The node's engine, then its fallbacks — one per provider.
pub fn engines(params: &Value) -> Vec<EngineChoice> {
    let mut list = vec![engine_of(params.get("engine"))];
    for entry in params.get("fallbackEngines").and_then(Value::as_array).into_iter().flatten() {
        let choice = engine_of(Some(entry));
        if choice.provider.trim().is_empty() || list.iter().any(|seen| seen.provider == choice.provider) {
            continue;
        }
        list.push(choice);
    }
    list
}

fn engine_label(engine: &EngineChoice) -> String {
    let name = match engine.provider.as_str() {
        "" => "The Flows engine",
        "claude" => "Claude Code",
        "codex" => "Codex",
        "gemini" => "Gemini",
        "grok" => "Grok",
        "opencode" => "OpenCode",
        "cline" => "Cline",
        "local" => "The local model",
        other => other,
    };
    if engine.model.trim().is_empty() {
        name.to_string()
    } else {
        format!("{name} ({})", engine.model.trim())
    }
}

fn is_cancel(error: &str) -> bool {
    error.starts_with(crate::ai_runs::CANCELLED_MARKER)
}

// ------------------------------------------------------------------------------------- one question

/// What a node asks a model, before it knows which engine will answer.
#[derive(Debug, Clone, Default)]
struct Ask {
    prompt: String,
    data: String,
    system: Option<String>,
    cwd: Option<String>,
    can_edit: bool,
    schema: Option<Value>,
    session: Option<String>,
    mcp: Vec<String>,
    effort: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct Reply {
    text: String,
    provider: String,
    model: String,
    account: Option<String>,
    session: Option<String>,
    usage: Option<Value>,
}

impl Reply {
    /// What every AI node's item says about the call besides its answer.
    fn stamp(&self, json: &mut Map<String, Value>, started: Instant) {
        json.insert("engine".into(), json!(self.provider));
        if !self.model.is_empty() {
            json.insert("model".into(), json!(self.model));
        }
        if let Some(account) = &self.account {
            json.insert("account".into(), json!(account));
        }
        if let Some(usage) = &self.usage {
            json.insert("usage".into(), usage.clone());
        }
        json.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
    }
}

async fn ask_once(ctx: &NodeCtx, engine: &EngineChoice, ask: &Ask) -> Result<Reply, String> {
    if engine.is_local() {
        let mut prompt = ask.prompt.clone();
        if !ask.data.trim().is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(&ask.data);
        }
        let call = LocalCall {
            server: "auto".into(),
            model: engine.model.clone(),
            system: ask.system.clone().unwrap_or_default(),
            prompt,
            schema: ask.schema.clone(),
            temperature: 0.2,
            max_tokens: 4_096,
            node_name: ctx.node.name.clone(),
            ..Default::default()
        };
        let answer = ctx.run.host.local_ai(call, ctx.cancel.clone()).await?;
        return Ok(Reply {
            text: answer.text,
            provider: "local".into(),
            model: answer.model,
            usage: Some(json!({ "inputTokens": answer.prompt_tokens, "outputTokens": answer.completion_tokens })),
            ..Default::default()
        });
    }
    let call = crate::flows::engine::AiCall {
        engine: engine.clone(),
        prompt: ask.prompt.clone(),
        data: ask.data.clone(),
        system: ask.system.clone(),
        cwd: ask.cwd.clone(),
        can_edit: ask.can_edit,
        schema: ask.schema.clone(),
        session: ask.session.clone(),
        mcp: ask.mcp.clone(),
        effort: ask.effort.clone(),
        node_name: ctx.node.name.clone(),
    };
    let answer = ctx.run.host.ai(call, ctx.cancel.clone()).await?;
    Ok(Reply {
        text: answer.text,
        provider: answer.provider,
        model: answer.model,
        account: answer.account,
        session: answer.session,
        usage: answer.usage,
    })
}

/// A line in the log when the engine about to run has spent most of its plan.
fn warn_if_nearly_spent(ctx: &NodeCtx, engine: &EngineChoice) {
    if engine.is_local() {
        return;
    }
    if let Some((used, resets)) = ctx.run.host.quota(engine) {
        if used >= NEARLY_SPENT {
            let when = reopen_text(ctx, &resets);
            ctx.log(
                LogStream::Info,
                &format!("{} has used {used:.0} % of its plan{when}", engine_label(engine)),
            );
        }
    }
}

fn reopen_text(ctx: &NodeCtx, resets: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(resets) {
        Ok(at) => format!(" (it renews {})", local_time(ctx, at.with_timezone(&chrono::Utc))),
        Err(_) => String::new(),
    }
}

/// `14:30` in the flow's zone — `Mon 14:30` when it is not today.
fn local_time(ctx: &NodeCtx, at: chrono::DateTime<chrono::Utc>) -> String {
    let zone: chrono_tz::Tz = ctx.run.timezone.as_deref().and_then(|zone| zone.parse().ok()).unwrap_or(chrono_tz::UTC);
    let local = at.with_timezone(&zone);
    if local.date_naive() == chrono::Utc::now().with_timezone(&zone).date_naive() {
        local.format("%H:%M").to_string()
    } else {
        local.format("%a %d %H:%M").to_string()
    }
}

/// When the plan that just refused reopens, if it is soon enough to wait for: the provider's own
/// instant, or the cached reading of a window that is full.
fn reopens_at(ctx: &NodeCtx, engine: &EngineChoice, failure: &crate::ai::AiFailure) -> Option<chrono::DateTime<chrono::Utc>> {
    use chrono::TimeZone;
    let at = failure.resets_at.and_then(|epoch| chrono::Utc.timestamp_opt(epoch, 0).single()).or_else(|| {
        let (used, resets) = ctx.run.host.quota(engine)?;
        if used < 99.0 {
            return None;
        }
        chrono::DateTime::parse_from_rfc3339(&resets).ok().map(|at| at.with_timezone(&chrono::Utc))
    })?;
    let wait = (at - chrono::Utc::now()).to_std().ok()?;
    (wait <= MAX_QUOTA_WAIT).then_some(at)
}

fn reason_word(kind: AiFailureKind) -> &'static str {
    match kind {
        AiFailureKind::Quota => "out of quota",
        AiFailureKind::AuthRequired => "not signed in",
        AiFailureKind::CliMissing => "not installed",
        AiFailureKind::CliBusy => "busy",
        AiFailureKind::Overloaded => "overloaded",
        AiFailureKind::Other => "failed",
    }
}

/// Asks the first engine that can answer, falling back down the list; returns the reply and which
/// engine gave it.
async fn ask(ctx: &NodeCtx, engines: &[EngineChoice], question: &Ask) -> Result<(Reply, usize), NodeError> {
    let mut last = String::from("No engine to ask");
    for (index, engine) in engines.iter().enumerate() {
        if ctx.cancel.is_cancelled() {
            return Err(NodeError::Cancelled);
        }
        take_slot(ctx)?;
        warn_if_nearly_spent(ctx, engine);
        // A session belongs to the engine (and account) that opened it.
        let attempt = if index == 0 { question.clone() } else { Ask { session: None, ..question.clone() } };
        let error = match ask_once(ctx, engine, &attempt).await {
            Ok(reply) => return Ok((reply, index)),
            Err(error) => error,
        };
        if is_cancel(&error) || ctx.cancel.is_cancelled() {
            return Err(NodeError::Cancelled);
        }
        let failure = crate::ai::classify_failure(&error);
        let switchable = matches!(
            failure.kind,
            AiFailureKind::Quota
                | AiFailureKind::AuthRequired
                | AiFailureKind::CliMissing
                | AiFailureKind::CliBusy
                | AiFailureKind::Overloaded
        );
        if switchable && index + 1 < engines.len() {
            ctx.log(
                LogStream::Info,
                &format!(
                    "{} is {} — asking {}",
                    engine_label(engine),
                    reason_word(failure.kind),
                    engine_label(&engines[index + 1])
                ),
            );
            last = error;
            continue;
        }
        if failure.kind == AiFailureKind::Quota {
            if let Some(at) = reopens_at(ctx, engine, &failure) {
                let wait = (at - chrono::Utc::now()).to_std().unwrap_or_default() + REOPEN_MARGIN;
                ctx.log(
                    LogStream::Info,
                    &format!("{} is out of quota — the run waits until {} and asks again", engine_label(engine), local_time(ctx, at)),
                );
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
                }
                take_slot(ctx)?;
                return ask_once(ctx, engine, &attempt).await.map(|reply| (reply, index)).map_err(failure_of);
            }
        }
        return Err(NodeError::Failed(error));
    }
    Err(NodeError::Failed(last))
}

fn failure_of(error: String) -> NodeError {
    if is_cancel(&error) {
        NodeError::Cancelled
    } else {
        NodeError::Failed(error)
    }
}

/// The instruction that goes with a schema — said in words for the engines that cannot enforce one,
/// and harmless for the ones that can.
fn schema_instruction(schema: &Value) -> String {
    format!(
        "\n\nResponde ÚNICAMENTE con un objeto JSON que cumpla este JSON Schema — sin texto antes ni después \
         y sin bloque de código:\n{}",
        serde_json::to_string_pretty(schema).unwrap_or_default()
    )
}

fn problems_of(text: &str, schema: &Value) -> (Option<Value>, Vec<String>) {
    match schema::answer_object(text) {
        None => (None, vec!["the answer is not a JSON object".to_string()]),
        Some(mut value) => {
            schema::prune(&mut value, schema);
            let problems = schema::validate(&value, schema);
            (Some(value), problems)
        }
    }
}

/// The answer's object, held to the schema: asked once more, on the engine that answered, with what
/// was wrong — then a failure that says what still is.
async fn conform(
    ctx: &NodeCtx,
    engines: &[EngineChoice],
    question: &Ask,
    reply: Reply,
    index: usize,
) -> Result<(Reply, Value), NodeError> {
    let Some(schema) = &question.schema else {
        return Err(NodeError::failed("No schema to hold the answer to"));
    };
    let (object, problems) = problems_of(&reply.text, schema);
    if problems.is_empty() {
        if let Some(object) = object {
            return Ok((reply, object));
        }
    }
    ctx.log(
        LogStream::Info,
        &format!("The answer did not follow the schema ({}) — asking once more", problems.join("; ")),
    );
    let previous: String = reply.text.chars().take(4_000).collect();
    let retry = Ask {
        prompt: format!(
            "{}\n\nTu respuesta anterior no cumplió el esquema:\n- {}\n\nRespuesta anterior:\n{}\n\n\
             Responde de nuevo SOLO con el objeto JSON corregido.",
            question.prompt,
            problems.join("\n- "),
            previous
        ),
        session: None,
        ..question.clone()
    };
    take_slot(ctx)?;
    let again = ask_once(ctx, &engines[index], &retry).await.map_err(failure_of)?;
    let (object, problems) = problems_of(&again.text, schema);
    match object {
        Some(object) if problems.is_empty() => Ok((again, object)),
        _ => Err(NodeError::failed(format!(
            "The answer did not follow the schema, even after a retry: {}",
            problems.join("; ")
        ))),
    }
}

// --------------------------------------------------------------------------------- shared reading

/// The schema the node's answer must follow, from its `output` setting: none for text, the field
/// list's, or one written by hand.
fn output_schema(params: &Value) -> Result<Option<Value>, NodeError> {
    match params.get("output").and_then(Value::as_str).unwrap_or("text") {
        "json" => schema::from_fields(params.get("schemaFields").unwrap_or(&Value::Null)).map(Some).map_err(NodeError::Failed),
        "schema" => schema::from_text(&text(params, "schemaJson")).map(Some).map_err(NodeError::Failed),
        _ => Ok(None),
    }
}

/// A folder of the run's own for an engine that only reads what it is handed: an empty directory,
/// so a CLI started there finds no project to wander into.
fn scratch(ctx: &NodeCtx) -> Result<String, NodeError> {
    let dir = ctx.run.host.work_dir().join(format!("ai-{}", ctx.node.id));
    std::fs::create_dir_all(&dir).map_err(|e| NodeError::failed(format!("Could not prepare a folder for the model: {e}")))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// `sub` inside `root`, refusing a way out of it.
fn inside(root: &str, sub: &str) -> Result<String, NodeError> {
    let sub = sub.trim().trim_start_matches(['/', '\\']);
    if sub.is_empty() {
        return Ok(root.to_string());
    }
    if Path::new(sub).components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err(NodeError::failed("The subfolder must stay inside the repository"));
    }
    let path: PathBuf = Path::new(root).join(sub);
    if !path.is_dir() {
        return Err(NodeError::failed(format!("{} is not a folder", path.display())));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// The working copy `folder` is in, if any.
fn repository_of(folder: &str) -> Option<String> {
    let repo = git2::Repository::discover(folder).ok()?;
    let root = repo.workdir()?.to_string_lossy().trim_end_matches(['/', '\\']).to_string();
    Some(root)
}

/// Where the agent works, and the repository that is in (for its restore point).
fn work_folder(ctx: &NodeCtx) -> Result<(String, Option<String>), NodeError> {
    let folder = match ctx.param_str("workIn").as_str() {
        "project" => {
            let project = ctx.param_str("project");
            if project.trim().is_empty() {
                return Err(NodeError::failed("Choose the repository the agent works in"));
            }
            let root = ctx.run.host.project_path(&project).map_err(NodeError::Failed)?;
            inside(&root, &ctx.param_str("subfolder"))?
        }
        "path" => {
            let path = ctx.param_str("workDir");
            if path.trim().is_empty() {
                return Err(NodeError::failed("Choose the folder the agent works in"));
            }
            if !Path::new(path.trim()).is_dir() {
                return Err(NodeError::failed(format!("{} is not a folder", path.trim())));
            }
            path.trim().to_string()
        }
        _ => scratch(ctx)?,
    };
    let repo = repository_of(&folder);
    Ok((folder, repo))
}

/// A field of the input item to write the answer into: `target` set on a copy of the item, or the
/// answer's fields merged into it when the target is empty and the answer is an object.
fn with_answer(item: Option<&Item>, target: &str, answer: Value) -> Value {
    let mut json = item.map(|item| item.json.clone()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let target = target.trim();
    if target.is_empty() {
        if let (Value::Object(into), Value::Object(fields)) = (&mut json, &answer) {
            for (key, value) in fields {
                into.insert(key.clone(), value.clone());
            }
            return json;
        }
        set_path(&mut json, "result", answer);
        return json;
    }
    set_path(&mut json, target, answer);
    json
}

fn output_item(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

fn effort_of(ctx: &NodeCtx) -> Option<String> {
    match ctx.param_str("effort").as_str() {
        "" | "default" => None,
        level => Some(level.to_string()),
    }
}

// -------------------------------------------------------------------------------------- the agent

/// The resume token kept for this node between runs, when it is the same engine and account.
fn stored_session(ctx: &NodeCtx, key: &str, engine: &EngineChoice) -> Option<String> {
    let stored = ctx.run.host.state_get(key).ok().flatten()?;
    let same = stored.get("provider").and_then(Value::as_str) == Some(engine.provider.as_str())
        && stored.get("account").and_then(Value::as_str).unwrap_or_default() == engine.account;
    same.then(|| stored.get("session").and_then(Value::as_str).map(str::to_string)).flatten()
}

async fn agent(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let engines = engines(&ctx.params);
    let schema = output_schema(&ctx.params)?;
    let can_edit = ctx.param_str("access") == "edit";
    let (cwd, repo) = work_folder(ctx)?;
    if can_edit {
        if let Some(root) = &repo {
            crate::git::checkpoint::create_flow_baseline(root, &ctx.run.run_id)
                .map_err(|e| NodeError::failed(format!("Could not take a restore point in {root}: {e}")))?;
            ctx.run.host.edits_recorded(root);
        }
    }
    let keep_session = ctx.param_str("session") == "continue";
    let session_key = format!("ai-session:{}", ctx.node.id);
    let mut session = if keep_session { stored_session(ctx, &session_key, &engines[0]) } else { None };
    let mcp = if can_edit { strings(&ctx.params, "mcp") } else { Vec::new() };
    let resolved = if ctx.param_str("runFor") == "once" { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };

    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let prompt = text(params, "prompt");
        if prompt.trim().is_empty() {
            return Err(NodeError::failed("Write what the agent should do"));
        }
        let mut full = prompt.trim().to_string();
        if let Some(schema) = &schema {
            full.push_str(&schema_instruction(schema));
        }
        let question = Ask {
            prompt: full,
            data: text(params, "data"),
            system: Some(text(params, "system")).filter(|system| !system.trim().is_empty()),
            cwd: Some(cwd.clone()),
            can_edit,
            schema: schema.clone(),
            session: session.clone(),
            mcp: mcp.clone(),
            effort: effort_of(ctx),
        };
        let started = Instant::now();
        let (reply, used) = ask(ctx, &engines, &question).await?;
        let (reply, data) = match schema {
            Some(_) => {
                let (reply, object) = conform(ctx, &engines, &question, reply, used).await?;
                (reply, Some(object))
            }
            None => (reply, None),
        };
        if keep_session && used == 0 {
            if let Some(id) = &reply.session {
                session = Some(id.clone());
                let stored = json!({ "provider": engines[0].provider, "account": engines[0].account, "session": id });
                let _ = ctx.run.host.state_set(&session_key, Some(&stored));
            }
        }
        let mut json = Map::new();
        json.insert("text".into(), json!(reply.text.trim()));
        if let Some(data) = data {
            json.insert("data".into(), data);
        }
        if let Some(id) = &reply.session {
            json.insert("sessionId".into(), json!(id));
        }
        reply.stamp(&mut json, started);
        if can_edit {
            if let Some(root) = &repo {
                if let Ok(files) = crate::git::checkpoint::flow_changed_paths(root, &ctx.run.run_id) {
                    json.insert("changedFiles".into(), json!(files));
                }
                json.insert("repository".into(), json!(root));
            }
        }
        out.push(output_item(ctx, index, Value::Object(json)));
    }
    Ok(vec![out])
}

// -------------------------------------------------------------------------------- the local model

async fn local(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let schema = output_schema(&ctx.params)?;
    let credential = ctx.param_str("credential");
    let api_key = if credential.trim().is_empty() {
        None
    } else {
        Some(ctx.run.host.credential(&credential).map_err(NodeError::Failed)?.secret)
    };
    let resolved = if ctx.param_str("runFor") == "once" { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let prompt = text(params, "prompt");
        if prompt.trim().is_empty() {
            return Err(NodeError::failed("Write what the model should do"));
        }
        let mut full = prompt.trim().to_string();
        if let Some(schema) = &schema {
            full.push_str(&schema_instruction(schema));
        }
        let call = LocalCall {
            server: text(params, "server"),
            url: text(params, "url"),
            model: text(params, "model"),
            api_key: api_key.clone(),
            system: text(params, "system"),
            prompt: full.clone(),
            schema: schema.clone(),
            temperature: number(params, "temperature").unwrap_or(0.2).clamp(0.0, 2.0) as f32,
            max_tokens: number(params, "maxTokens").unwrap_or(1_024.0).clamp(16.0, 131_072.0) as u32,
            context: number(params, "contextSize").unwrap_or(0.0).clamp(0.0, 1_048_576.0) as u32,
            node_name: ctx.node.name.clone(),
        };
        let started = Instant::now();
        take_slot(ctx)?;
        let mut answer = ctx.run.host.local_ai(call.clone(), ctx.cancel.clone()).await.map_err(failure_of)?;
        let mut data = None;
        if let Some(schema) = &schema {
            let (object, problems) = problems_of(&answer.text, schema);
            match object {
                Some(object) if problems.is_empty() => data = Some(object),
                _ => {
                    ctx.log(
                        LogStream::Info,
                        &format!("The answer did not follow the schema ({}) — asking once more", problems.join("; ")),
                    );
                    let previous: String = answer.text.chars().take(4_000).collect();
                    let retry = LocalCall {
                        prompt: format!(
                            "{full}\n\nTu respuesta anterior no cumplió el esquema:\n- {}\n\nRespuesta anterior:\n{previous}\n\n\
                             Responde de nuevo SOLO con el objeto JSON corregido.",
                            problems.join("\n- ")
                        ),
                        ..call
                    };
                    take_slot(ctx)?;
                    answer = ctx.run.host.local_ai(retry, ctx.cancel.clone()).await.map_err(failure_of)?;
                    let (object, problems) = problems_of(&answer.text, schema);
                    match object {
                        Some(object) if problems.is_empty() => data = Some(object),
                        _ => {
                            return Err(NodeError::failed(format!(
                                "The answer did not follow the schema, even after a retry: {}",
                                problems.join("; ")
                            )))
                        }
                    }
                }
            }
        }
        if answer.cut {
            ctx.log(LogStream::Info, "The answer reached the token limit and is cut — raise «Max tokens»");
        }
        let mut json = Map::new();
        json.insert("text".into(), json!(answer.text.trim()));
        if let Some(data) = data {
            json.insert("data".into(), data);
        }
        json.insert("engine".into(), json!("local"));
        json.insert("server".into(), json!(answer.server));
        json.insert("model".into(), json!(answer.model));
        json.insert("usage".into(), json!({ "inputTokens": answer.prompt_tokens, "outputTokens": answer.completion_tokens }));
        json.insert("cut".into(), json!(answer.cut));
        json.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
        out.push(output_item(ctx, index, Value::Object(json)));
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------ the shortcuts

/// A shortcut's question about one item: read-only, in a scratch folder, on the node's engines.
async fn ask_text(ctx: &NodeCtx, prompt: String, data: String, schema: Option<Value>) -> Result<(Reply, Option<Value>), NodeError> {
    let engines = engines(&ctx.params);
    let mut full = prompt;
    if let Some(schema) = &schema {
        full.push_str(&schema_instruction(schema));
    }
    let question = Ask { prompt: full, data, cwd: Some(scratch(ctx)?), schema: schema.clone(), ..Default::default() };
    let (reply, used) = ask(ctx, &engines, &question).await?;
    match schema {
        Some(_) => {
            let (reply, object) = conform(ctx, &engines, &question, reply, used).await?;
            Ok((reply, Some(object)))
        }
        None => Ok((reply, None)),
    }
}

fn extra(instructions: &str) -> String {
    let instructions = instructions.trim();
    if instructions.is_empty() {
        String::new()
    } else {
        format!("\n\nInstrucciones adicionales:\n{instructions}")
    }
}

/// `[{ name, description }]`, skipping unnamed rows.
fn categories(params: &Value) -> Vec<(String, String)> {
    params
        .get("categories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let name = text(row, "name").trim().to_string();
            (!name.is_empty()).then(|| (name, text(row, "description").trim().to_string()))
        })
        .collect()
}

pub const OTHER_CATEGORY: &str = "other";

async fn classify(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let listed = categories(&ctx.params);
    if listed.is_empty() {
        return Err(NodeError::failed("List the categories to choose from"));
    }
    let multiple = flag(&ctx.params, "multiple");
    let allow_other = flag(&ctx.params, "allowOther");
    let mut names: Vec<String> = listed.iter().map(|(name, _)| name.clone()).collect();
    if allow_other && !names.iter().any(|name| name == OTHER_CATEGORY) {
        names.push(OTHER_CATEGORY.to_string());
    }
    let label = json!({ "type": "string", "enum": names });
    let schema = if multiple {
        json!({
            "type": "object",
            "properties": { "categories": { "type": "array", "items": label }, "reason": { "type": "string" } },
            "required": ["categories", "reason"],
            "additionalProperties": false,
        })
    } else {
        json!({
            "type": "object",
            "properties": { "category": label, "reason": { "type": "string" } },
            "required": ["category", "reason"],
            "additionalProperties": false,
        })
    };
    let list = listed
        .iter()
        .map(|(name, description)| if description.is_empty() { format!("- {name}") } else { format!("- {name}: {description}") })
        .collect::<Vec<_>>()
        .join("\n");
    let resolved = ctx.resolve_each().await?;
    let items = ctx.items();
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let subject = text(params, "text");
        if subject.trim().is_empty() {
            return Err(NodeError::failed("The text to classify is empty"));
        }
        let how = if multiple { "en todas las categorías que correspondan" } else { "en UNA categoría" };
        let other = if allow_other {
            format!("\nSi no encaja en ninguna, usa «{OTHER_CATEGORY}».")
        } else {
            "\nElige siempre la que mejor encaje.".to_string()
        };
        let prompt = format!(
            "Clasifica el texto que recibes por stdin {how} de esta lista:\n{list}{other}\n\
             En «reason» explica la elección en una frase.{}",
            extra(&text(params, "instructions"))
        );
        let (_, object) = ask_text(ctx, prompt, subject, Some(schema.clone())).await?;
        let object = object.unwrap_or_default();
        let answer = if multiple { object.get("categories").cloned() } else { object.get("category").cloned() }.unwrap_or(Value::Null);
        let target = ctx.param_str("target");
        let target = if target.trim().is_empty() { if multiple { "categories" } else { "category" }.to_string() } else { target };
        out.push(output_item(ctx, index, with_answer(items.get(index).copied(), &target, answer)));
    }
    Ok(vec![out])
}

async fn extract(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let schema = schema::from_fields(ctx.params.get("schemaFields").unwrap_or(&Value::Null)).map_err(NodeError::Failed)?;
    let resolved = ctx.resolve_each().await?;
    let items = ctx.items();
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let subject = text(params, "text");
        if subject.trim().is_empty() {
            return Err(NodeError::failed("The text to read is empty"));
        }
        let prompt = format!(
            "Extrae del texto que recibes por stdin los campos del esquema. Usa solo lo que dice el texto: \
             si un dato no aparece, déjalo en null (o vacío si el campo no admite null); no lo inventes.{}",
            extra(&text(params, "instructions"))
        );
        let (_, object) = ask_text(ctx, prompt, subject, Some(schema.clone())).await?;
        out.push(output_item(ctx, index, with_answer(items.get(index).copied(), &ctx.param_str("target"), object.unwrap_or_default())));
    }
    Ok(vec![out])
}

async fn summarize(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let items = ctx.items();
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let subject = text(params, "text");
        if subject.trim().is_empty() {
            return Err(NodeError::failed("The text to summarize is empty"));
        }
        let bullets = text(params, "summaryStyle") == "bullets";
        let length = match (text(params, "summaryLength").as_str(), bullets) {
            ("long", true) => "con todos los puntos que importen",
            ("long", false) => "con el detalle necesario, en varios párrafos",
            ("medium", true) => "en 4 a 7 puntos",
            ("medium", false) => "en un párrafo de 4 a 6 frases",
            (_, true) => "en 2 a 4 puntos",
            (_, false) => "en 1 a 3 frases",
        };
        let style = if bullets { ", como lista de viñetas en Markdown" } else { "" };
        let language = match text(params, "answerLanguage").as_str() {
            "es" => " en español",
            "en" => " en inglés",
            _ => " en el mismo idioma del texto",
        };
        let prompt = format!(
            "Resume el texto que recibes por stdin{language}, {length}{style}. Responde solo con el resumen, \
             sin introducción ni comentarios.{}",
            extra(&text(params, "instructions"))
        );
        let started = Instant::now();
        let (reply, _) = ask_text(ctx, prompt, subject, None).await?;
        let mut json = with_answer(items.get(index).copied(), &or(&ctx.param_str("target"), "summary"), json!(reply.text.trim()));
        if let Value::Object(map) = &mut json {
            let mut meta = Map::new();
            reply.stamp(&mut meta, started);
            map.entry("ai").or_insert(Value::Object(meta));
        }
        out.push(output_item(ctx, index, json));
    }
    Ok(vec![out])
}

fn or(value: &str, fallback: &str) -> String {
    if value.trim().is_empty() {
        fallback.to_string()
    } else {
        value.trim().to_string()
    }
}

/// The diff a review or a commit message is about, and the working copy it is in.
fn diff_of(ctx: &NodeCtx, params: &Value, default_source: &str) -> Result<(String, Option<String>), NodeError> {
    let source = or(&text(params, "diffSource"), default_source);
    if source == "diffText" {
        return Ok((text(params, "diff"), None));
    }
    let project = text(params, "project");
    if project.trim().is_empty() {
        return Err(NodeError::failed("Choose the repository"));
    }
    let root = ctx.run.host.project_path(&project).map_err(NodeError::Failed)?;
    let files = match source.as_str() {
        "staged" => crate::git::diff::get_staged_diff(&root),
        "branchDiff" => {
            let base = or(&text(params, "base"), "main");
            crate::git::diff::get_branch_diff(&root, &base, "HEAD")
        }
        _ => crate::git::diff::get_uncommitted_diff(&root, None),
    }
    .map_err(|e| NodeError::failed(format!("Could not read the changes: {e}")))?;
    Ok((crate::git::diff::render_diff_for_prompt(&files), Some(root)))
}

fn cut(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push_str("\n[…diff cut for length]");
    out
}

/// The review's grades from its first line: `📈 CALIDAD: Fiabilidad=A Seguridad=B Mantenibilidad=A`.
pub fn review_quality(review: &str) -> Option<Value> {
    let line = review.lines().find(|line| line.contains("CALIDAD:"))?;
    let grade = |key: &str| -> Value {
        line.find(&format!("{key}="))
            .and_then(|at| line[at + key.len() + 1..].chars().next())
            .filter(char::is_ascii_alphabetic)
            .map_or(Value::Null, |grade| json!(grade.to_ascii_uppercase().to_string()))
    };
    Some(json!({
        "reliability": grade("Fiabilidad"),
        "security": grade("Seguridad"),
        "maintainability": grade("Mantenibilidad"),
    }))
}

/// The findings of a review in the shared template's format, one object each.
pub fn review_findings(review: &str) -> Vec<Value> {
    let mut findings: Vec<Map<String, Value>> = Vec::new();
    for line in review.lines() {
        let trimmed = line.trim();
        if let Some(head) = trimmed.strip_prefix("### ") {
            let mut finding = Map::new();
            if let (Some(open), Some(close)) = (head.find('['), head.find(']')) {
                if open < close {
                    let mut tags = head[open + 1..close].split('·').map(str::trim);
                    finding.insert("severity".into(), json!(tags.next().unwrap_or_default()));
                    finding.insert("type".into(), json!(tags.next().unwrap_or_default()));
                    let rest = head[close + 1..].trim();
                    let (title, id) = match rest.rfind("· F-") {
                        Some(at) => (rest[..at].trim(), rest[at + 2..].trim()),
                        None => (rest, ""),
                    };
                    finding.insert("title".into(), json!(title));
                    finding.insert("id".into(), json!(id));
                }
            }
            if finding.is_empty() {
                finding.insert("title".into(), json!(head.trim()));
            }
            findings.push(finding);
            continue;
        }
        let Some(current) = findings.last_mut() else { continue };
        let field = |prefix: &str| trimmed.strip_prefix(prefix).map(str::trim);
        if let Some(value) = field("📍 Ubicación:") {
            current.insert("location".into(), json!(value));
        } else if let Some(value) = field("💭 Por qué:") {
            current.insert("why".into(), json!(value));
        } else if let Some(value) = field("💡 Sugerencia:") {
            current.insert("suggestion".into(), json!(value));
        } else if let Some(value) = field("🎯 Confianza:") {
            let number: String = value.chars().take_while(char::is_ascii_digit).collect();
            current.insert("confidence".into(), number.parse::<u64>().map_or(Value::Null, |n| json!(n)));
        } else if !trimmed.is_empty() && !current.contains_key("summary") && !current.contains_key("location") {
            current.insert("summary".into(), json!(trimmed));
        }
    }
    findings.into_iter().map(Value::Object).collect()
}

async fn review(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let per_item = ctx.param_str("diffSource") == "diffText";
    let resolved = if per_item { ctx.resolve_each().await? } else { vec![ctx.resolve_once().await?] };
    let engines = engines(&ctx.params);
    let template = ctx.run.host.ai_template("review");
    let base_prompt = if template.trim().is_empty() { crate::ai::DEFAULT_ANALYZE_TEMPLATE.to_string() } else { template };
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let (diff, root) = diff_of(ctx, params, "working")?;
        if diff.trim().is_empty() {
            ctx.log(LogStream::Info, "Nothing to review: the diff is empty");
            out.push(output_item(ctx, index, json!({ "review": "", "findings": [], "findingCount": 0, "empty": true })));
            continue;
        }
        let prompt = format!("{base_prompt}{}", extra(&text(params, "instructions")));
        let cwd = match &root {
            Some(root) => root.clone(),
            None => scratch(ctx)?,
        };
        let question = Ask { prompt, data: format!("DIFF:\n{}", cut(&diff, MAX_DIFF_CHARS)), cwd: Some(cwd), ..Default::default() };
        let started = Instant::now();
        let (reply, _) = ask(ctx, &engines, &question).await?;
        let findings = review_findings(&reply.text);
        let mut json = Map::new();
        json.insert("review".into(), json!(reply.text.trim()));
        json.insert("quality".into(), review_quality(&reply.text).unwrap_or(Value::Null));
        json.insert("findingCount".into(), json!(findings.len()));
        json.insert("findings".into(), Value::Array(findings));
        if let Some(root) = root {
            json.insert("repository".into(), json!(root));
        }
        reply.stamp(&mut json, started);
        out.push(output_item(ctx, index, Value::Object(json)));
    }
    Ok(vec![out])
}

/// CodeFlow's own PR analyzer — the one behind the pull request panel, not [`review`] above (one
/// prompt over a local diff). Each item reviews one pull request: of a linked repository (by
/// number, so `{{ $json.number }}` after the PR trigger) or, with no clone here, by its link. What
/// the panel brings comes along: the workspace's levels and policy, reviewers in parallel by lens
/// with a pass across files, the pull request's memory (a finding keeps its `F-NNN` from one
/// iteration to the next) and, when asked, the new findings published as threads.
///
/// The engine is the "Revisión de PR" routing row's unless the node names one, and each review is
/// one call against the flow's hourly cap — one decision to spend, however many reviewers it fans
/// out to. The same pull request twice in one batch is reviewed once.
async fn pr_review(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let engine = engine_of(ctx.params.get("engine"));
    if engine.is_local() {
        return Err(NodeError::failed("CodeFlow's PR analyzer runs on a CLI engine, not on the local model"));
    }
    let mut done: Vec<(String, Value)> = Vec::new();
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let by_link = text(params, "source") == "link";
        if by_link && text(params, "prUrl").trim().is_empty() {
            return Err(NodeError::failed("Paste the pull request's link"));
        }
        if !by_link && text(params, "project").trim().is_empty() {
            return Err(NodeError::failed("Choose the repository"));
        }
        let pr_id = params.get("prId").cloned().unwrap_or(Value::Null);
        if !by_link && text(params, "prId").trim().is_empty() {
            return Err(NodeError::failed("Say which pull request — its number"));
        }
        let args = json!({
            "source": if by_link { "link" } else { "project" },
            "projectId": text(params, "project").trim(),
            "prId": pr_id,
            "url": text(params, "prUrl").trim(),
            "level": text(params, "level"),
            "force": flag(params, "force"),
            "publish": if by_link { String::new() } else { text(params, "publish") },
            "minSeverity": text(params, "minSeverity"),
            "provider": engine.provider,
            "model": engine.model,
            "nodeId": ctx.node.id,
        });
        let key = args.to_string();
        if let Some((_, answer)) = done.iter().find(|(seen, _)| *seen == key) {
            out.push(output_item(ctx, index, answer.clone()));
            continue;
        }
        take_slot(ctx)?;
        let what = if by_link { text(params, "prUrl") } else { format!("#{}", text(params, "prId").trim().trim_start_matches('#')) };
        ctx.log(LogStream::Info, &format!("Reviewing pull request {what} with CodeFlow's analyzer"));
        let started = Instant::now();
        let mut answer = ctx.run.host.app_call("pr.review", args, ctx.cancel.clone()).await.map_err(|error| {
            if is_cancel(&error) {
                NodeError::Cancelled
            } else {
                NodeError::Failed(error)
            }
        })?;
        if let Value::Object(map) = &mut answer {
            map.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
        }
        done.push((key, answer.clone()));
        out.push(output_item(ctx, index, answer));
    }
    Ok(vec![out])
}

fn app_failure(error: String) -> NodeError {
    if is_cancel(&error) {
        NodeError::Cancelled
    } else {
        NodeError::Failed(error)
    }
}

/// The PR's targets of a helper: the ids written, or — none written — what the analyzer lists:
/// the review's findings still standing at `minSeverity` or above, or the open comment threads.
async fn pr_targets(ctx: &NodeCtx, project: &str, pr: &Value, threads: bool, params: &Value) -> Result<Vec<String>, NodeError> {
    let written = crate::flows::pr_ops::ids_of(params.get("ids"));
    if !written.is_empty() {
        return Ok(written);
    }
    if threads {
        let listed = ctx.run.host.app_call("pr.threads", json!({"projectId": project, "prId": pr}), ctx.cancel.clone()).await.map_err(app_failure)?;
        return Ok(listed.as_array().into_iter().flatten().filter_map(|t| t.get("id").map(|id| id.to_string())).collect());
    }
    let floor = match text(params, "minSeverity").as_str() {
        "critical" => 3,
        "info" => 1,
        _ => 2,
    };
    let rank = |severity: &str| match severity {
        "critical" => 3,
        "warning" => 2,
        _ => 1,
    };
    let standing = ctx
        .run
        .host
        .app_call("pr.memoryFindings", json!({"projectId": project, "prId": pr, "state": "activeFindings"}), ctx.cancel.clone())
        .await
        .map_err(app_failure)?;
    Ok(standing
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| rank(f["severity"].as_str().unwrap_or_default()) >= floor)
        .filter_map(|f| f["id"].as_str().map(str::to_string))
        .collect())
}

/// "Resolver con IA" — the analyzer's fix applied to the working copy, on the pull request's
/// branch: one AI run per finding (or comment thread), each counted against the hourly cap. The
/// changes are left uncommitted, as the panel leaves them; a Git node commits and pushes them.
async fn pr_fix(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let engine = engine_of(ctx.params.get("engine"));
    if engine.is_local() {
        return Err(NodeError::failed("Resolver con IA edits files, so it runs on a CLI engine, not on the local model"));
    }
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let project = text(params, "project").trim().to_string();
        if project.is_empty() {
            return Err(NodeError::failed("Choose the repository"));
        }
        if text(params, "prId").trim().is_empty() {
            return Err(NodeError::failed("Say which pull request — its number"));
        }
        let pr = params.get("prId").cloned().unwrap_or(Value::Null);
        let threads = text(params, "fixSource") == "fixThreads";
        let targets = pr_targets(ctx, &project, &pr, threads, params).await?;
        if targets.is_empty() {
            ctx.log(LogStream::Info, "Nothing to fix: no finding (or thread) left standing");
        }
        for target in targets {
            take_slot(ctx)?;
            ctx.log(LogStream::Info, &format!("Fixing {} {target} with AI", if threads { "comment thread" } else { "finding" }));
            let started = Instant::now();
            let args = json!({
                "projectId": project,
                "prId": pr,
                "source": if threads { "fixThreads" } else { "fixFindings" },
                "ids": [target],
                "instructions": text(params, "instructions"),
                "switchBranch": flag(params, "switchBranch"),
                "provider": engine.provider,
                "model": engine.model,
            });
            let answer = ctx.run.host.app_call("pr.fix", args, ctx.cancel.clone()).await.map_err(app_failure)?;
            for mut item in answer.as_array().cloned().unwrap_or_default() {
                if let Some(error) = item["error"].as_str() {
                    ctx.log(LogStream::Stderr, &format!("{target}: {error}"));
                }
                item["durationMs"] = json!(started.elapsed().as_millis() as u64);
                out.push(output_item(ctx, index, item));
            }
        }
    }
    Ok(vec![out])
}

/// "Responder con IA" — a reply to each comment thread, drafted by a model from the conversation
/// and what the reply should carry. Only drafted: "Comentarios del PR" posts it (and closes the
/// thread), so a flow can put a person in between.
async fn pr_reply(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let engine = engine_of(ctx.params.get("engine"));
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let project = text(params, "project").trim().to_string();
        if project.is_empty() {
            return Err(NodeError::failed("Choose the repository"));
        }
        if text(params, "prId").trim().is_empty() {
            return Err(NodeError::failed("Say which pull request — its number"));
        }
        let pr = params.get("prId").cloned().unwrap_or(Value::Null);
        for target in pr_targets(ctx, &project, &pr, true, params).await? {
            take_slot(ctx)?;
            let args = json!({
                "projectId": project,
                "prId": pr,
                "ids": [target],
                "note": text(params, "replyNote"),
                "provider": engine.provider,
                "model": engine.model,
            });
            let answer = ctx.run.host.app_call("pr.replyDraft", args, ctx.cancel.clone()).await.map_err(app_failure)?;
            for item in answer.as_array().cloned().unwrap_or_default() {
                out.push(output_item(ctx, index, item));
            }
        }
    }
    Ok(vec![out])
}

/// A turn of CodeFlow's Chat — the thread shows up in the Chat with its question and its answer, to
/// be read or carried on by hand. One turn per item; each counts against the hourly cap.
async fn chat(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let engine = engine_of(ctx.params.get("engine"));
    if engine.is_local() {
        return Err(NodeError::failed("The Chat runs on a CLI engine, not on the local model"));
    }
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let message = text(params, "message");
        if message.trim().is_empty() {
            return Err(NodeError::failed("Write the message"));
        }
        let mode = text(params, "conversation");
        if mode == "byId" && text(params, "conversationId").trim().is_empty() {
            return Err(NodeError::failed("Say which conversation — its id"));
        }
        take_slot(ctx)?;
        let args = json!({
            "conversation": if mode.is_empty() { "byTitle".to_string() } else { mode },
            "title": text(params, "title").trim(),
            "conversationId": text(params, "conversationId").trim(),
            "message": message,
            "projectId": text(params, "project").trim(),
            "wait": params.get("waitReply").is_none() || flag(params, "waitReply"),
            "provider": engine.provider,
            "model": engine.model,
        });
        let answer = ctx.run.host.app_call("chat.send", args, ctx.cancel.clone()).await.map_err(|error| {
            if is_cancel(&error) {
                NodeError::Cancelled
            } else {
                NodeError::Failed(error)
            }
        })?;
        out.push(output_item(ctx, index, answer));
    }
    Ok(vec![out])
}

fn branch_of(root: &str) -> String {
    git2::Repository::open(root)
        .ok()
        .and_then(|repo| repo.head().ok().and_then(|head| head.shorthand().map(str::to_string)))
        .unwrap_or_else(|| "HEAD".to_string())
}

async fn commit(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let pr = ctx.param_str("writeWhat") == "prDescription";
    let per_item = ctx.param_str("diffSource") == "diffText";
    let resolved = if per_item { ctx.resolve_each().await? } else { vec![ctx.resolve_once().await?] };
    let engines = engines(&ctx.params);
    let template = ctx.run.host.ai_template(if pr { "pr" } else { "commit" });
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let (diff, root) = diff_of(ctx, params, if pr { "branchDiff" } else { "staged" })?;
        if diff.trim().is_empty() {
            return Err(NodeError::failed(if pr { "No differences between the branches to describe" } else { "No changes to write a commit message for" }));
        }
        let started = Instant::now();
        let mut json = Map::new();
        if pr {
            let prompt = if template.trim().is_empty() { crate::ai::DEFAULT_PR_DESCRIPTION_TEMPLATE.to_string() } else { template.clone() };
            let head = root.as_deref().map(branch_of).unwrap_or_else(|| "HEAD".into());
            let base = or(&text(params, "base"), "main");
            let data = format!("RAMA ORIGEN: {head}\nRAMA DESTINO: {base}\n\nDIFF:\n{}", cut(&diff, MAX_DIFF_CHARS));
            let question = Ask { prompt, data, cwd: Some(scratch(ctx)?), ..Default::default() };
            let (reply, _) = ask(ctx, &engines, &question).await?;
            let description = reply.text.trim().to_string();
            let (title, body) = match description.split_once('\n') {
                Some((first, rest)) if first.trim_start().starts_with("TITLE:") => {
                    (first.trim_start().trim_start_matches("TITLE:").trim().to_string(), rest.trim().to_string())
                }
                _ => (String::new(), description.clone()),
            };
            json.insert("title".into(), json!(title));
            json.insert("body".into(), json!(body));
            json.insert("description".into(), json!(description));
            json.insert("branch".into(), json!(head));
            json.insert("base".into(), json!(base));
            reply.stamp(&mut json, started);
        } else {
            let default = template.trim().is_empty();
            let prompt = if default { crate::ai::DEFAULT_COMMIT_TEMPLATE.to_string() } else { template.clone() };
            let question = Ask { prompt: prompt.clone(), data: cut(&diff, MAX_COMMIT_DIFF_CHARS), cwd: Some(scratch(ctx)?), ..Default::default() };
            let (reply, _) = ask(ctx, &engines, &question).await?;
            let message = crate::ai::clean_commit_message(&reply.text, prompt.trim() == crate::ai::DEFAULT_COMMIT_TEMPLATE.trim());
            if message.is_empty() {
                return Err(NodeError::failed("The model did not write a commit message"));
            }
            let (subject, body) = match message.split_once('\n') {
                Some((subject, body)) => (subject.trim().to_string(), body.trim().to_string()),
                None => (message.clone(), String::new()),
            };
            json.insert("message".into(), json!(message));
            json.insert("subject".into(), json!(subject));
            json.insert("body".into(), json!(body));
            reply.stamp(&mut json, started);
        }
        if let Some(root) = root {
            json.insert("repository".into(), json!(root));
        }
        out.push(output_item(ctx, index, Value::Object(json)));
    }
    Ok(vec![out])
}

// --------------------------------------------------------------------------------- an Agents task

async fn agent_task(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let from_template = text(&params, "mode") == "template";
    let request = AgentRequest {
        node_id: ctx.node.id.clone(),
        agent_id: if from_template { String::new() } else { text(&params, "agent") },
        template_id: if from_template { text(&params, "template") } else { String::new() },
        project_id: text(&params, "project"),
        instruction: text(&params, "instruction"),
        title: text(&params, "title"),
        wait: flag(&params, "waitEnd"),
    };
    if request.project_id.trim().is_empty() {
        return Err(NodeError::failed("Choose the repository the task runs in"));
    }
    if from_template && request.template_id.is_empty() {
        return Err(NodeError::failed("Choose a chain template"));
    }
    if !from_template && (request.agent_id.is_empty() || request.instruction.trim().is_empty()) {
        return Err(NodeError::failed("Choose an agent and write its instruction"));
    }
    let outcome = ctx.run.host.agent_task(request, ctx.cancel.clone()).await.map_err(failure_of)?;
    Ok(vec![vec![output_item(ctx, 0, outcome)]])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallbacks_keep_one_engine_per_provider() {
        let params = json!({
            "engine": {"provider": "claude", "model": "claude-sonnet-5-5", "account": "work"},
            "fallbackEngines": [
                {"provider": "claude", "account": "personal"},
                {"provider": "codex", "model": "gpt-5.6"},
                {"provider": ""},
                {"provider": "local", "model": "qwen2.5-coder:7b"},
                {"provider": "codex", "model": "other"},
            ],
        });
        let list = engines(&params);
        let providers: Vec<&str> = list.iter().map(|engine| engine.provider.as_str()).collect();
        assert_eq!(providers, vec!["claude", "codex", "local"]);
        assert_eq!(list[0].account, "work");
        assert_eq!(engines(&json!({}))[0], EngineChoice::default());
    }

    #[test]
    fn a_review_reads_back_into_findings() {
        let review = "📈 CALIDAD: Fiabilidad=B Seguridad=d Mantenibilidad=A\n\n\
            ### 🚨 [Crítico · Seguridad] Secreto en el código · F-001\n\n\
            Un token de API quedó escrito en el cliente\n\n\
            📍 Ubicación: src/api/client.ts:12-14\n\n\
            💭 Por qué: cualquiera con el bundle lo lee\n\n\
            💡 Sugerencia: leerlo de la configuración\n\n\
            🎯 Confianza: 92/100\n\n---\n\n\
            ### ℹ️ [Menor · Estilo] Nombre poco claro · F-002\n\n📍 Ubicación: src/util.ts:3-3\n";
        assert_eq!(review_quality(review), Some(json!({"reliability": "B", "security": "D", "maintainability": "A"})));
        let findings = review_findings(review);
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0]["severity"], "Crítico");
        assert_eq!(findings[0]["type"], "Seguridad");
        assert_eq!(findings[0]["title"], "Secreto en el código");
        assert_eq!(findings[0]["id"], "F-001");
        assert_eq!(findings[0]["summary"], "Un token de API quedó escrito en el cliente");
        assert_eq!(findings[0]["location"], "src/api/client.ts:12-14");
        assert_eq!(findings[0]["confidence"], 92);
        assert_eq!(findings[1]["location"], "src/util.ts:3-3");
        assert!(review_findings("✅ Sin problemas").is_empty());
    }

    #[test]
    fn answers_land_on_a_copy_of_the_item() {
        let item = Item::new(json!({"id": 7, "text": "hola"}));
        assert_eq!(with_answer(Some(&item), "category", json!("billing")), json!({"id": 7, "text": "hola", "category": "billing"}));
        assert_eq!(with_answer(Some(&item), "", json!({"amount": 3})), json!({"id": 7, "text": "hola", "amount": 3}));
        assert_eq!(with_answer(None, "out.summary", json!("x")), json!({"out": {"summary": "x"}}));
        assert!(inside("/tmp", "../etc").is_err());
    }
}
