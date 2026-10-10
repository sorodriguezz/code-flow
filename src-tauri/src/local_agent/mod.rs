//! «CodeFlow» — the AI provider that is part of the app: the model configured in Settings › AI
//! engines › Local model, driven from inside this process.
//!
//! # Why an engine with no CLI
//!
//! Every other provider is a headless CLI that brings its own agent loop. That is also why local
//! models used to need one: the direct Ollama engine was replaced by Cline because a completion
//! endpoint can draft a commit message but never open a file, so every tool-using feature was hidden
//! whenever a local model was chosen. This engine closes the same gap without the second install —
//! the integrated `llama-server` (or Ollama, or any OpenAI-compatible server, whichever the «Local
//! model» pane points at) is the model, and the loop that gives it hands lives here.
//!
//! [`crate::ai::run`] hands an in-process engine to [`run`] instead of spawning anything, so the
//! rest of the app sees an ordinary run: the same banner, the same Stop, the same usage row, the
//! same answer type.
//!
//! # Two modes, chosen per invocation
//!
//! * **Text** — the one-shot operations whose material is already in the request: a commit message
//!   from a diff, a chat title, a PR description, a review, anything that wants JSON. One streamed
//!   request; a JSON Schema, when the caller has one, becomes the server's grammar.
//! * **Agent** — a working folder to act in (the chats, "fix with AI", the agent chains). The model
//!   gets [`tools`] and the loop below runs them until it answers in words. A read-only invocation
//!   gets only the read tools; write tools need the invocation's own write opt-in.
//!
//! # Sized for a small model
//!
//! The window is the «Local model» pane's (the same figure the hybrid tasks budget against), tool
//! results are cut to what fits, the oldest ones are dropped first when the conversation outgrows
//! it, and the patterns small models fall into — an empty answer, the same call again and again —
//! get a nudge instead of a failure. None of that makes a 7B a frontier model; it makes it fail
//! less often in ways that cost the user a turn.

pub(crate) mod tools;

use std::collections::HashMap;

use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::watch;

use crate::ai::{task, AiEngine, AiInvocation, AiRun, AiUsage, ModelListing};
use crate::ai_runs::{self, RunCtx};
use crate::hybrid::config::{self, Settings};
use crate::hybrid::local_llm::{self, BackendKind, ChatRequest, ConverseRequest, Finish};
use crate::hybrid::{budget, runtime};

pub use tools::Grants;

/// The provider id, in `engine_for`, the `ai_provider` setting and the frontend's catalogue.
pub const PROVIDER_ID: &str = "codeflow";

/// Tool turns before the model must answer in words.
const MAX_STEPS: usize = 30;

/// How many times the same call (same tool, same arguments) is run before the model is told to
/// use the answer it already has.
const SAME_CALL_LIMIT: usize = 2;

/// The answer budget for one agent step — a step is a tool call or a final reply, rarely a whole
/// file, and a lower cap leaves more of the window for what the model reads. It is also the worst
/// case for a step that rambles: two of fifteen live runs of a 7B took four to five minutes instead
/// of ~13 s, which at ~20 tokens/s is a step writing to the old 4,096 cap. 2,048 halves that.
const STEP_OUTPUT_TOKENS: u32 = 2_048;

/// The share of a step's input the project map may take, and its bounds in characters: a 16k window
/// gets about ten thousand characters of map, a 4k one the floor.
const MAP_SHARE: u64 = 4;
const MAP_MIN_CHARS: usize = 3_000;
const MAP_MAX_CHARS: usize = 24_000;

/// How many times an answer that only announces its next step is sent back to be acted on. Five,
/// not one or two: measured on qwen2.5-coder 7B through Ollama, a run that announces once tends to
/// announce three or four times before it settles into calling tools, and each reminder is cheap
/// next to a run that ends on "Let's search for…". [`MAX_STEPS`] bounds the whole loop regardless.
const ANNOUNCE_NUDGES: usize = 5;

/// The same for the other ways a small model stops short: an invented tool result, a claimed change.
const OTHER_NUDGES: usize = 2;

/// What the run log line of this engine is tagged with, for the run card's parser.
const LOG_TAG: &str = "codeflow";

/// The tasks whose material arrives in the request itself, so tools would only be a way to wander.
const TEXT_TASKS: &[&str] = &[
    task::COMMIT,
    task::INLINE,
    task::PR_DESCRIPTION,
    task::COMMENT_REPLY,
    task::CHAT_TITLE,
    task::REPAIR_JSON,
    task::ANALYZE,
    task::REVIEW_PR,
    task::WORK_ITEM_REVIEW,
    task::STORIES_VERIFY,
    task::PIPELINE_ANALYZE,
    task::NOTE_WRITE,
    task::DIAGRAM_DRAW,
    task::DIAGRAM_ROWS,
    task::DB_ASSIST,
    task::HYBRID_EXECUTE,
    task::FLOWS,
    task::FLOW_BUILD,
];

pub struct CodeFlowEngine;

/// The read tools, by the names the model calls them.
const READ_TOOLS: &[&str] = &["list_files", "find_files", "read_file", "search"];
/// …and the write tools a "fix with AI" run adds.
const WRITE_TOOLS: &[&str] = &["edit_file", "write_file"];

impl AiEngine for CodeFlowEngine {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn label(&self) -> &'static str {
        "CodeFlow"
    }

    /// No binary: nothing is installed for this provider, the app is the program.
    fn default_binary(&self) -> &'static str {
        ""
    }

    /// One model: whatever the «Local model» pane chose. Empty is "that one".
    fn commit_message_model(&self) -> &'static str {
        ""
    }

    fn fix_tools(&self) -> Vec<String> {
        READ_TOOLS.iter().chain(WRITE_TOOLS).map(|tool| tool.to_string()).collect()
    }

    fn read_only_tools(&self) -> Vec<String> {
        READ_TOOLS.iter().map(|tool| tool.to_string()).collect()
    }

    /// Never spawned — [`crate::ai::run`] branches on [`AiEngine::in_process`] first. A command that
    /// cannot start is what a caller that skipped that branch would get, rather than a wrong program.
    fn build_command(&self, _binary: &str, _inv: &AiInvocation) -> Command {
        Command::new("codeflow-runs-in-process")
    }

    fn interpret(&self, _success: bool, _status_label: &str, _stdout: &str, _stderr: &str) -> Result<AiRun, String> {
        Err("The CodeFlow engine runs inside the app and has no process output to read.".to_string())
    }

    fn in_process(&self) -> bool {
        true
    }

    /// Every turn is a fresh request; the chats re-send the conversation, as for Cline.
    fn resumes_sessions(&self) -> bool {
        false
    }

    /// Text mode streams; an agent step arrives whole (a tool call is only usable complete).
    fn streams_partial(&self) -> bool {
        true
    }

    /// Enforced by construction: a read-only run is never offered a write tool. See [`tools`].
    fn enforces_read_only(&self) -> bool {
        true
    }

    fn fetch_models(&self) -> Option<ModelListing> {
        Some(Box::pin(async { available_models().await }))
    }
}

/// The models the configured server can run right now: downloaded ones for the integrated engine,
/// whatever Ollama or the OpenAI-compatible server lists otherwise.
pub async fn available_models() -> Vec<String> {
    let Some(Ok(settings)) = crate::ai_usage::with_conn(config::read) else { return Vec::new() };
    let resolved = runtime::resolve(&settings, runtime::Freshness::Recent).await;
    match resolved.kind {
        BackendKind::Bundled => crate::localai::exec_catalogue::EXEC_CATALOGUE
            .iter()
            .filter(|entry| crate::localai::models::is_installed(&entry.spec))
            .map(|entry| entry.spec.id.to_string())
            .collect(),
        _ => resolved.available.into_iter().map(|model| model.id).collect(),
    }
}

/// Whether the provider can answer, for Settings' status badge: `detail` is the model it would use
/// when it can, and the reason code (`not-downloaded`, `unreachable`, …) when it cannot.
pub async fn status() -> (bool, String) {
    let Some(Ok(settings)) = crate::ai_usage::with_conn(config::read) else {
        return (false, "unavailable".to_string());
    };
    let resolved = runtime::resolve(&settings, runtime::Freshness::Now).await;
    match (resolved.error_code, resolved.model) {
        (None, Some(model)) => (true, model),
        (Some(code), _) => (false, code.to_string()),
        (None, None) => (false, "no-models".to_string()),
    }
}

/// How this invocation runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Text,
    Agent(Grants),
}

impl Mode {
    fn of(inv: &AiInvocation<'_>) -> Self {
        let Some(_) = inv.cwd else { return Mode::Text };
        if inv.json_schema.is_some() || TEXT_TASKS.contains(&inv.task) {
            return Mode::Text;
        }
        let write = !inv.read_only && inv.auto_approve_edits;
        // Commands are their own opt-in: a provider tool list that names `run_command` (or a Bash
        // rule, for a list carried over from Claude) — never implied by being allowed to edit.
        let run = write
            && inv.allowed_tools.iter().any(|tool| {
                let tool = tool.trim();
                tool == "run_command" || tool.starts_with("Bash")
            });
        Mode::Agent(Grants { write, run })
    }
}

/// Runs one invocation. The caller is [`crate::ai::run`], which has already announced the engine
/// and subscribed to Stop.
pub async fn run(inv: &AiInvocation<'_>, ctx: &Option<RunCtx>, cancel: &mut Option<watch::Receiver<bool>>) -> Result<AiRun, String> {
    if ai_runs::stopping() {
        return Err(ai_runs::CANCELLED_MARKER.to_string());
    }
    let spanish = spanish();
    let settings = match crate::ai_usage::with_conn(config::read) {
        Some(Ok(settings)) => settings,
        Some(Err(error)) => return Err(error),
        None => return Err(say(spanish, "La configuración del modelo local no está disponible.", "The local model settings are not available.")),
    };
    run_with(&settings, inv, ctx, cancel).await
}

/// [`run`] against settings already read — the seam the live test drives without an app.
async fn run_with(
    settings: &Settings,
    inv: &AiInvocation<'_>,
    ctx: &Option<RunCtx>,
    cancel: &mut Option<watch::Receiver<bool>>,
) -> Result<AiRun, String> {
    let spanish = spanish();
    let mode = Mode::of(inv);
    let session = Session::open(settings, inv.model, spanish).await?;
    log(
        ctx,
        json!({
            "event": "start",
            "model": session.live.model,
            "server": session.kind.as_str(),
            "ctx": session.ctx,
            "mode": match mode { Mode::Text => "text", Mode::Agent(_) => "agent" },
        }),
    );
    let outcome = match mode {
        Mode::Text => text(&session, inv, ctx, cancel).await,
        Mode::Agent(grants) => agent(&session, inv, grants, ctx, cancel).await,
    };
    outcome.map_err(|error| if error == CANCELLED { ai_runs::CANCELLED_MARKER.to_string() } else { error })
}

const CANCELLED: &str = "__cancelled__";

/// The server and model this run talks to, connected (the integrated engine started if need be).
struct Session {
    live: runtime::Live,
    kind: BackendKind,
    ctx: u32,
    budget: budget::Budget,
    /// The model has a thinking phase Ollama can switch off — and must, for an agent: qwen3:8b took
    /// 338 s to fix a one-line bug thinking, where the bundled engine starts it with no reasoning.
    thinking: bool,
}

impl Session {
    async fn open(settings: &Settings, wanted: &str, spanish: bool) -> Result<Self, String> {
        let first = runtime::resolve(settings, runtime::Freshness::Recent).await;
        let wanted = wanted.trim();
        // A model picked in the chat, when it differs from the pane's: resolved again so the window
        // and budget are that model's, not the pane's.
        let resolved = if !wanted.is_empty()
            && first.model.as_deref() != Some(wanted)
            && first.available.iter().any(|model| model.id == wanted)
        {
            let mut chosen = settings.clone();
            chosen.backend = Some(first.kind);
            match first.kind {
                BackendKind::Bundled => chosen.model_bundled = Some(wanted.to_string()),
                BackendKind::Ollama => chosen.model_ollama = Some(wanted.to_string()),
                BackendKind::Openai => chosen.model_openai = Some(wanted.to_string()),
            }
            runtime::resolve(&chosen, runtime::Freshness::Recent).await
        } else {
            first
        };
        if let Some(code) = resolved.error_code {
            return Err(not_ready(code, resolved.error.as_deref().unwrap_or_default(), spanish));
        }
        let Some(model) = resolved.model.clone() else {
            return Err(not_ready("no-models", "", spanish));
        };
        let live = runtime::connect(resolved.kind, &resolved.url, &model, resolved.ctx).await?;
        Ok(Self { live, kind: resolved.kind, ctx: resolved.ctx, budget: resolved.budget, thinking: resolved.details.thinking })
    }

    /// Ollama loads a model with the window it is asked for; the others were started with theirs.
    fn num_ctx(&self) -> Option<u32> {
        (self.kind == BackendKind::Ollama).then_some(self.ctx)
    }

    fn think(&self) -> Option<bool> {
        (self.kind == BackendKind::Ollama && self.thinking).then_some(false)
    }
}

/// Why nothing can run yet, in the reader's language, pointing at the pane that fixes it.
fn not_ready(code: &str, detail: &str, spanish: bool) -> String {
    let pane_es = "Configuración › Motores de IA › Modelo local";
    let pane_en = "Settings › AI engines › Local model";
    match code {
        "not-downloaded" => say(
            spanish,
            &format!("El modelo local de CodeFlow no está descargado. Descárgalo en {pane_es}."),
            &format!("CodeFlow's local model isn't downloaded. Download it in {pane_en}."),
        ),
        "engine-missing" => say(
            spanish,
            "Esta instalación no trae el motor local (llama-server). Reinstala CodeFlow o elige Ollama en Modelo local.",
            "This install is missing its local engine (llama-server). Reinstall CodeFlow or choose Ollama under Local model.",
        ),
        "no-models" => say(
            spanish,
            &format!("El servidor local responde pero no tiene modelos. Elige o descarga uno en {pane_es}."),
            &format!("The local server answers but has no models. Choose or download one in {pane_en}."),
        ),
        _ => say(
            spanish,
            &format!("El servidor del modelo local no responde ({detail}). Revísalo en {pane_es}."),
            &format!("The local model server isn't answering ({detail}). Check it in {pane_en}."),
        ),
    }
}

fn spanish() -> bool {
    crate::ai_usage::setting("app_language").is_some_and(|language| language.starts_with("es"))
}

fn say(spanish: bool, es: &str, en: &str) -> String {
    if spanish { es.to_string() } else { en.to_string() }
}

/// One line on the run's log, tagged so the run card can draw it as a step.
fn log(ctx: &Option<RunCtx>, mut event: Value) {
    #[cfg(test)]
    if std::env::var("CODEFLOW_LIVE_AGENT").is_ok() {
        eprintln!("  · {event}");
    }
    let Some(ctx) = ctx else { return };
    event["type"] = json!(LOG_TAG);
    ai_runs::emit_line(ctx, "stdout", &event.to_string());
}

// ---------------------------------------------------------------------------------------- text

/// The base instructions for a one-shot answer. The caller's own system prompt follows.
const TEXT_SYSTEM: &str = "You are CodeFlow's built-in assistant, running on this computer with a local model. \
Answer exactly what is asked, in the format asked for, with no preamble. \
Write in the same language as the request unless it says otherwise.";

async fn text(session: &Session, inv: &AiInvocation<'_>, ctx: &Option<RunCtx>, cancel: &mut Option<watch::Receiver<bool>>) -> Result<AiRun, String> {
    let system = join_system(TEXT_SYSTEM, inv.system_prompt, "");
    let user = fit_user(&user_message(inv), session.budget.input, budget::estimate_tokens(&system));
    let schema = inv.json_schema.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let request = ChatRequest {
        model: &session.live.model,
        system: &system,
        user: &user,
        num_ctx: session.num_ctx(),
        max_tokens: session.budget.output,
        temperature: 0.2,
        think: session.think(),
        keep_alive: None,
        schema: schema.as_ref(),
    };
    let sink = inv.stream_deltas.clone();
    let on_text = |piece: &str| {
        if let (Some(ctx), Some(sink)) = (ctx, &sink) {
            ai_runs::emit_delta(ctx, &sink.conversation_id, &sink.message_id, "text", piece);
        }
    };
    let sent = budget::estimate_tokens(&system) + budget::estimate_tokens(&user);
    let outcome = local_llm::chat(&session.live.endpoint, &request, on_text, ai_runs::cancelled(cancel))
        .await
        .map_err(|error| failure(error, spanish()))?;
    if budget::truncated(sent, outcome.prompt_tokens) {
        return Err(say(
            spanish(),
            "El servidor local recortó la petición: no cabía en la ventana del modelo. Sube el contexto en Modelo local.",
            "The local server cut the request: it did not fit the model's window. Raise the context under Local model.",
        ));
    }
    let mut answer = outcome.text.trim().to_string();
    if outcome.finish == Finish::Length {
        log(ctx, json!({ "event": "note", "text": "cut at the answer limit" }));
    }
    if answer.is_empty() {
        answer = say(spanish(), "El modelo local no devolvió texto.", "The local model returned no text.");
        return Err(answer);
    }
    Ok(AiRun {
        text: answer,
        session_id: None,
        model: Some(session.live.model.clone()),
        usage: usage_of(outcome.prompt_tokens, outcome.completion_tokens),
        context_tokens: outcome.prompt_tokens.map(|tokens| tokens as i64),
    })
}

fn failure(error: local_llm::LocalError, spanish: bool) -> String {
    if matches!(error, local_llm::LocalError::Cancelled) {
        return CANCELLED.to_string();
    }
    let detail = error.sentence();
    say(spanish, &format!("El modelo local falló: {detail}"), &format!("The local model failed: {detail}"))
}

fn usage_of(prompt: Option<u64>, completion: Option<u64>) -> Option<AiUsage> {
    let usage = AiUsage {
        input_tokens: prompt.unwrap_or(0) as i64,
        output_tokens: completion.unwrap_or(0) as i64,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        // Spent on this machine: nothing to pay, and saying so is different from not knowing.
        cost_usd: Some(0.0),
    };
    (!usage.is_empty()).then_some(usage)
}

fn join_system(base: &str, extra: Option<&str>, more: &str) -> String {
    let mut system = base.to_string();
    for part in [extra.unwrap_or_default(), more] {
        if !part.trim().is_empty() {
            system.push_str("\n\n");
            system.push_str(part.trim());
        }
    }
    system
}

/// The request as one message: the ask, then the skills note and the data the CLIs get on stdin.
fn user_message(inv: &AiInvocation<'_>) -> String {
    let mut user = inv.prompt.to_string();
    for part in [inv.skills_note.as_str(), inv.stdin_content] {
        if !part.trim().is_empty() {
            user.push_str("\n\n");
            user.push_str(part);
        }
    }
    user
}

/// `user` cut to what the window leaves after the system prompt: the head (the ask) and the tail
/// (the newest material — the last turn of a transcript, the end of a diff) are kept, the middle
/// goes, and the cut says so.
fn fit_user(user: &str, input_budget: u32, system_tokens: u64) -> String {
    let room = (input_budget as u64).saturating_sub(system_tokens + 256);
    if budget::estimate_tokens(user) <= room {
        return user.to_string();
    }
    // `estimate_tokens` is a characters-per-token ratio; the cut is made on characters with the same.
    let ratio = (user.chars().count() as f64 / budget::estimate_tokens(user).max(1) as f64).max(1.0);
    let keep = ((room as f64) * ratio) as usize;
    let head = keep / 3;
    let tail = keep - head;
    let chars: Vec<char> = user.chars().collect();
    let dropped = chars.len().saturating_sub(head + tail);
    let mut out: String = chars[..head.min(chars.len())].iter().collect();
    out.push_str(&format!("\n\n[… {dropped} characters left out to fit the local model's window …]\n\n"));
    out.extend(chars[chars.len().saturating_sub(tail)..].iter());
    out
}

// --------------------------------------------------------------------------------------- agent

/// Characters of project map a step with `input_budget` tokens of input can carry.
fn map_budget(input_budget: u64) -> usize {
    (((input_budget / MAP_SHARE) as f64 * 3.5) as usize).clamp(MAP_MIN_CHARS, MAP_MAX_CHARS)
}

fn agent_system(grants: Grants, map: bool) -> String {
    let look = if map {
        "- Look before you answer. The project's files are listed below with what each one declares. find_symbol tells you where a function or class is defined, find_usages which files use it, outline what a file declares with its line numbers; then read_file the part you need (search and find_files help with anything else). Never guess what a file contains.\n"
    } else {
        "- Look before you answer. The project's files are listed below; use read_file on the relevant ones (search and find_files help in large projects). Never guess what a file contains.\n"
    };
    let mut system = String::from(
        "You are CodeFlow's built-in coding agent, running on this computer with a local model. \
You work inside one project folder; every path you use is relative to it.\n\
Write your replies in the same language as the user's request.\n\n\
How to work:\n",
    );
    system.push_str(look);
    system.push_str(
        "\
- Act, don't announce: when you decide to look at or change something, call the tool in that same reply instead of saying you will.\n\
- Call one tool at a time and use its result before deciding the next step.\n",
    );
    if grants.write {
        system.push_str(
            "- To change a file: read it first, then call edit_file with old_text copied exactly from the file (without the line numbers read_file adds) and enough lines to be unique. Use write_file only to create a file or to rewrite a small one completely.\n\
- Change only what the request needs. Keep the file's style and indentation.\n",
        );
    } else {
        system.push_str("- This conversation is read-only: you cannot change files. If a change is needed, show it in your reply instead.\n");
    }
    if grants.run {
        system.push_str("- run_command runs a shell command in the project root; use it to run tests or builds when that helps. Never run destructive or interactive commands.\n");
    }
    system.push_str("- When you are done, answer the user in plain words: what you found or what you changed. Do not call tools in that last reply.");
    system
}

async fn agent(
    session: &Session,
    inv: &AiInvocation<'_>,
    grants: Grants,
    ctx: &Option<RunCtx>,
    cancel: &mut Option<watch::Receiver<bool>>,
) -> Result<AiRun, String> {
    let root = inv.cwd.unwrap_or_default();
    let toolbox = tools::Toolbox::new(root, grants)?;
    #[cfg(test)]
    let toolbox = if std::env::var("CODEFLOW_LIVE_NO_MAP").is_ok() { toolbox.without_map() } else { toolbox };
    let schemas = toolbox.schemas();
    let tools_tokens = budget::estimate_tokens(&Value::Array(schemas.clone()).to_string());
    let input_budget = (session.budget.input as u64).saturating_sub(tools_tokens);
    let (map, built) = toolbox.project_map(map_budget(input_budget)).await;
    if let Some(info) = built {
        log(ctx, json!({ "event": "map", "files": info.files, "symbols": info.symbols, "parsed": info.parsed, "ms": info.millis }));
    }
    let system = join_system(&agent_system(toolbox.grants(), toolbox.has_map()), inv.system_prompt, &map);
    let user = fit_user(&user_message(inv), input_budget as u32, budget::estimate_tokens(&system));
    let mut messages = vec![json!({ "role": "system", "content": system }), json!({ "role": "user", "content": user })];

    let mut prompt_total = 0u64;
    let mut completion_total = 0u64;
    let mut last_prompt: Option<u64> = None;
    let mut nudged_empty = false;
    let mut announce_nudges = 0usize;
    let mut code_nudges = 0usize;
    let mut claim_nudges = 0usize;
    let mut invented_nudges = 0usize;
    let mut unfixed_nudged = false;
    let mut dangling_nudged = false;
    let mut calls_seen: HashMap<String, usize> = HashMap::new();
    let mut changed_files = 0usize;
    let max_tokens = session.budget.output.min(STEP_OUTPUT_TOKENS);

    for step in 0..MAX_STEPS {
        let last_step = step + 1 == MAX_STEPS;
        compact(&mut messages, input_budget);
        let request = ConverseRequest {
            model: &session.live.model,
            messages: &messages,
            tools: &schemas,
            no_more_tools: last_step,
            num_ctx: session.num_ctx(),
            max_tokens,
            temperature: 0.2,
            keep_alive: None,
            think: session.think(),
        };
        let outcome = local_llm::converse(&session.live.endpoint, &request, ai_runs::cancelled(cancel))
            .await
            .map_err(|error| failure(error, spanish()))?;
        prompt_total += outcome.prompt_tokens.unwrap_or(0);
        completion_total += outcome.completion_tokens.unwrap_or(0);
        last_prompt = outcome.prompt_tokens.or(last_prompt);

        let mut outcome = outcome;
        if outcome.tool_calls.is_empty() {
            // A small model often *writes* its call instead of making it — Qwen 7B through Ollama
            // answered `{"name": "search", "arguments": {…}}` as prose on the first live run. Read
            // it the way the server would have, so the loop goes on instead of handing that JSON to
            // the user as the answer.
            let names: Vec<&str> = schemas.iter().filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str)).collect();
            let (prose, calls) = written_calls(&outcome.text, &names);
            if !calls.is_empty() {
                outcome.text = prose;
                outcome.message = assistant_with_calls(&outcome.text, &calls);
                outcome.tool_calls = calls;
            }
        }
        if outcome.tool_calls.is_empty() {
            let answer = outcome.text.trim().to_string();
            // The model wrote a tool's *result* itself — the chat template's own tag leaking into
            // its reply (seen once in three live runs of a 7B). That text is invented, never an
            // answer: it is dropped and the model is asked to make the call.
            if answer.contains("tool_response>") && !last_step && invented_nudges < OTHER_NUDGES {
                invented_nudges += 1;
                messages.push(json!({ "role": "user", "content": "That was not a tool result — only tools produce those. Call the tool you need, or give your final answer." }));
                continue;
            }
            if answer.is_empty() {
                // Measured with Cline on a 7B: an assistant message with no text and no call, a third
                // of the time. Asking once more is the remedy a person would apply.
                if !nudged_empty && !last_step {
                    nudged_empty = true;
                    messages.push(json!({ "role": "user", "content": "Continue: call a tool, or reply to the user with your answer." }));
                    continue;
                }
                return Err(say(spanish(), "El modelo local no devolvió respuesta.", "The local model returned no answer."));
            }
            // "Let's search for the file…" and then nothing: an intention, not an answer. Small
            // models stop there often; sending it back once or twice is what gets the call made.
            if announces_action(&answer) && announce_nudges < ANNOUNCE_NUDGES && !last_step {
                announce_nudges += 1;
                log(ctx, json!({ "event": "text", "text": answer }));
                messages.push(json!({ "role": "assistant", "content": answer }));
                messages.push(json!({ "role": "user", "content": "Do it now: reply with only the tool call, no explanation. If you already have everything you need, give your final answer instead." }));
                continue;
            }
            // Asked to change files, and answered with the corrected code instead of applying it —
            // the 7B's other way of stopping short (one live run in three pasted the whole file).
            let unapplied = toolbox.grants().write && changed_files == 0 && !last_step;
            if unapplied && answer.contains("```") && code_nudges < 1 {
                code_nudges += 1;
                log(ctx, json!({ "event": "text", "text": answer }));
                messages.push(json!({ "role": "assistant", "content": answer }));
                messages.push(json!({ "role": "user", "content": "Apply that change to the file with edit_file (or write_file for a new file) instead of showing the code. If no change is needed, say so." }));
                continue;
            }
            // "The change has been applied" with nothing on disk: the claim is checked against what
            // the tools actually wrote, and the model is told the truth (the third way a live run
            // of the 7B stopped short — after an announcement and a pasted file).
            if unapplied && claims_change(&answer) && claim_nudges < OTHER_NUDGES {
                claim_nudges += 1;
                log(ctx, json!({ "event": "text", "text": answer }));
                messages.push(json!({ "role": "assistant", "content": answer }));
                messages.push(json!({ "role": "user", "content": "No file has been changed yet: only edit_file and write_file change files, and you have not called them. Call edit_file now with old_text copied exactly from the file." }));
                continue;
            }
            // A fix that ends on a diagnosis. Only for "fix with AI", whose whole request is the
            // change — in a chat the same answer to a question is exactly right, and a reminder there
            // would push the model into edits nobody asked for.
            if unapplied && inv.task == task::FIX_FINDING && !unfixed_nudged {
                unfixed_nudged = true;
                log(ctx, json!({ "event": "text", "text": answer }));
                messages.push(json!({ "role": "assistant", "content": answer }));
                messages.push(json!({ "role": "user", "content": "You have not changed any file yet. Make the fix now with edit_file; if no change is needed, explain why." }));
                continue;
            }
            // A rename or a removal finished in one file and not in the rest. Checked against the
            // project as it now is, once: the model may know better (a same-named thing elsewhere).
            if toolbox.grants().write && !dangling_nudged && !last_step {
                let dangling = toolbox.dangling();
                if !dangling.is_empty() {
                    dangling_nudged = true;
                    let list = dangling
                        .iter()
                        .map(|(name, places)| format!("`{name}`:\n{}", places.join("\n")))
                        .collect::<Vec<_>>()
                        .join("\n");
                    log(ctx, json!({ "event": "text", "text": answer }));
                    messages.push(json!({ "role": "assistant", "content": answer }));
                    messages.push(json!({ "role": "user", "content": format!("Not finished: you renamed or removed these, and they are still used here:\n{list}\nUpdate each place with edit_file (read the file first), then give your final answer. If one of them is a different thing with the same name, leave it and say so.") }));
                    continue;
                }
            }
            return Ok(AiRun {
                text: answer,
                session_id: None,
                model: Some(session.live.model.clone()),
                usage: usage_of(Some(prompt_total), Some(completion_total)),
                context_tokens: last_prompt.map(|tokens| tokens as i64),
            });
        }

        if !outcome.text.trim().is_empty() {
            log(ctx, json!({ "event": "text", "text": outcome.text.trim() }));
        }
        messages.push(outcome.message.clone());
        for call in &outcome.tool_calls {
            let id = call["id"].as_str().unwrap_or_default().to_string();
            let name = call["name"].as_str().unwrap_or_default().to_string();
            let args = call.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let key = format!("{name}:{args}");
            // `name` before `path`: `find_usages` takes both, and the symbol is what it was asked about.
            let arg = ["name", "path", "pattern", "query", "command"]
                .iter()
                .find_map(|field| args.get(*field).and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();
            let seen = calls_seen.entry(key).or_insert(0);
            *seen += 1;
            let result = if *seen > SAME_CALL_LIMIT && !matches!(name.as_str(), "edit_file" | "write_file" | "run_command") {
                tools::Outcome {
                    content: "You already made this exact call; its result is above. Use it, or try something different.".to_string(),
                    summary: "repeated call".to_string(),
                    ok: false,
                    changed: None,
                }
            } else {
                toolbox.call(&name, &args, cancel).await
            };
            if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
                return Err(CANCELLED.to_string());
            }
            if result.changed.is_some() {
                changed_files += 1;
            }
            #[cfg(test)]
            if std::env::var("CODEFLOW_LIVE_AGENT").is_ok() && !result.ok {
                eprintln!("    args: {args}");
            }
            log(
                ctx,
                json!({
                    "event": "tool",
                    "tool": name,
                    "arg": arg,
                    "detail": result.summary,
                    "ok": result.ok,
                    "added": result.changed.map(|(added, _)| added),
                    "removed": result.changed.map(|(_, removed)| removed),
                }),
            );
            messages.push(json!({ "role": "tool", "tool_call_id": id, "content": result.content }));
        }
    }
    // Out of steps while still calling tools: what was changed is on disk, and saying so is better
    // than an error that suggests nothing happened.
    let text = if changed_files > 0 {
        say(
            spanish(),
            &format!("Me quedé sin pasos antes de terminar. Alcancé a modificar {changed_files} archivo(s); revisa los cambios y pídeme que siga."),
            &format!("I ran out of steps before finishing. I changed {changed_files} file(s); review them and ask me to continue."),
        )
    } else {
        say(spanish(), "Me quedé sin pasos antes de terminar. Prueba con una petición más acotada.", "I ran out of steps before finishing. Try a narrower request.")
    };
    Ok(AiRun {
        text,
        session_id: None,
        model: Some(session.live.model.clone()),
        usage: usage_of(Some(prompt_total), Some(completion_total)),
        context_tokens: last_prompt.map(|tokens| tokens as i64),
    })
}

/// Whether a reply only says what the model is about to do — "Let's search…", "Voy a leer…",
/// a closing colon — rather than answering. Checked on the last lines, where the intention sits.
fn announces_action(answer: &str) -> bool {
    let tail: String = answer.lines().rev().take(2).collect::<Vec<_>>().join(" ").to_lowercase();
    let tail = tail.trim();
    if tail.ends_with(':') {
        return true;
    }
    const OPENERS: &[&str] = &[
        "let's ", "let me ", "i will ", "i'll ", "next, i", "now i ", "i need to ", "i am going to ", "i'm going to ",
        "voy a ", "vamos a ", "ahora voy", "a continuación", "primero voy", "necesito ",
    ];
    OPENERS.iter().any(|opener| tail.contains(opener)) && answer.len() < 600
}

/// Whether a reply says files were changed — checked only when none were.
fn claims_change(answer: &str) -> bool {
    let lower = answer.to_lowercase();
    const CLAIMS: &[&str] = &[
        "has been applied", "have been applied", "has been fixed", "has been updated", "has been changed", "i fixed",
        "i've fixed", "i have fixed", "i updated", "i've updated", "i changed", "i've changed", "i applied", "is now fixed",
        "now correctly", "aplicado", "aplicamos", "apliqué", "corregido", "corregí", "actualizado", "actualicé",
        "modificado", "modifiqué", "cambié",
    ];
    CLAIMS.iter().any(|claim| lower.contains(claim))
}

/// Tool calls a model wrote into its text rather than making: `<tool_call>{…}</tool_call>` (Qwen's
/// and Hermes' own tag), a fenced ```json block, or a bare `{"name": …, "arguments": …}` object —
/// only for a name the run actually offers, so an answer that merely *shows* JSON is left alone.
/// Returns the text with the calls taken out, and the calls in [`local_llm::converse`]'s shape.
fn written_calls(text: &str, names: &[&str]) -> (String, Vec<Value>) {
    let mut calls = Vec::new();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'{' {
            index += 1;
            continue;
        }
        let Some(end) = object_end(text, index) else { break };
        let candidate = &text[index..=end];
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            let name = value.get("name").and_then(Value::as_str).unwrap_or_default();
            if names.contains(&name) {
                let arguments = match value.get("arguments").or_else(|| value.get("parameters")) {
                    Some(Value::Object(map)) => Value::Object(map.clone()),
                    Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).ok().filter(Value::is_object).unwrap_or_else(|| json!({})),
                    _ => json!({}),
                };
                calls.push(json!({ "id": format!("written_{}", calls.len()), "name": name, "arguments": arguments }));
                spans.push((index, end + 1));
                index = end + 1;
                continue;
            }
        }
        index += 1;
    }
    if calls.is_empty() {
        return (text.to_string(), calls);
    }
    let mut prose = String::new();
    let mut from = 0;
    for (start, end) in spans {
        prose.push_str(&text[from..start]);
        from = end;
    }
    prose.push_str(&text[from..]);
    let prose = prose.replace("<tool_call>", "").replace("</tool_call>", "").replace("```json", "").replace("```", "");
    (prose.trim().to_string(), calls)
}

/// The index of the `}` that closes the object opening at `start`, strings and escapes respected.
fn object_end(text: &str, start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, char) in text[start..].char_indices() {
        if in_string {
            match char {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match char {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(start + offset);
                }
            }
            _ => {}
        }
    }
    None
}

/// The assistant message that carries `calls`, as `read_converse` would have stored it.
fn assistant_with_calls(text: &str, calls: &[Value]) -> Value {
    json!({
        "role": "assistant",
        "content": text,
        "tool_calls": calls.iter().map(|call| json!({
            "id": call["id"],
            "type": "function",
            "function": { "name": call["name"], "arguments": call["arguments"].to_string() },
        })).collect::<Vec<_>>(),
    })
}

/// Keeps the conversation inside the window: the oldest tool results are replaced by a stub first —
/// they are the bulk, and the model can ask again for anything it still needs — and the newest two
/// are never touched, since the next step is about them.
fn compact(messages: &mut [Value], input_budget: u64) {
    let size = |messages: &[Value]| -> u64 {
        messages.iter().map(|m| budget::estimate_tokens(m["content"].as_str().unwrap_or_default()) + 8).sum::<u64>()
            + messages.iter().filter_map(|m| m.get("tool_calls")).map(|calls| budget::estimate_tokens(&calls.to_string())).sum::<u64>()
    };
    if size(messages) <= input_budget {
        return;
    }
    let tool_indexes: Vec<usize> =
        messages.iter().enumerate().filter(|(_, m)| m["role"] == "tool").map(|(index, _)| index).collect();
    let keep = tool_indexes.len().saturating_sub(2);
    for &index in tool_indexes.iter().take(keep) {
        if messages[index]["content"].as_str().is_some_and(|c| c.starts_with("[earlier result")) {
            continue;
        }
        messages[index]["content"] = json!("[earlier result removed to fit the window — call the tool again if you still need it]");
        if size(messages) <= input_budget {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inv<'a>(cwd: Option<&'a str>, task: &'static str) -> AiInvocation<'a> {
        super::tests_support::bare("do it", cwd, task)
    }

    #[test]
    fn a_folder_and_a_conversation_make_an_agent() {
        assert_eq!(Mode::of(&inv(Some("/repo"), task::CHAT)), Mode::Agent(Grants { write: false, run: false }));
        assert_eq!(Mode::of(&inv(None, task::CHAT)), Mode::Text);
        assert_eq!(Mode::of(&inv(Some("/repo"), task::COMMIT)), Mode::Text, "a commit message has its diff already");
    }

    #[test]
    fn writing_needs_the_opt_in_and_never_survives_read_only() {
        let mut write = inv(Some("/repo"), task::FIX_FINDING);
        write.auto_approve_edits = true;
        assert_eq!(Mode::of(&write), Mode::Agent(Grants { write: true, run: false }));
        write.read_only = true;
        assert_eq!(Mode::of(&write), Mode::Agent(Grants { write: false, run: false }));
    }

    #[test]
    fn commands_need_their_own_opt_in() {
        let tools = vec!["run_command".to_string()];
        let mut call = inv(Some("/repo"), task::CHAT);
        call.allowed_tools = &tools;
        assert_eq!(Mode::of(&call), Mode::Agent(Grants { write: false, run: false }), "no command without write");
        call.auto_approve_edits = true;
        assert_eq!(Mode::of(&call), Mode::Agent(Grants { write: true, run: true }));
    }

    #[test]
    fn a_schema_keeps_it_one_shot() {
        let mut call = inv(Some("/repo"), task::CHAT);
        call.json_schema = Some("{\"type\":\"object\"}");
        assert_eq!(Mode::of(&call), Mode::Text);
    }

    #[test]
    fn fit_user_keeps_the_ask_and_the_newest_material() {
        let user = format!("ASK {}TAIL", "x".repeat(200_000));
        let fitted = fit_user(&user, 4_000, 100);
        assert!(fitted.starts_with("ASK "));
        assert!(fitted.ends_with("TAIL"));
        assert!(fitted.contains("left out"));
        assert!(budget::estimate_tokens(&fitted) < 4_000);
        assert_eq!(fit_user("short", 4_000, 100), "short");
    }

    #[test]
    fn compact_drops_the_oldest_tool_results_first() {
        let big = "y".repeat(40_000);
        let mut messages = vec![
            json!({ "role": "system", "content": "s" }),
            json!({ "role": "user", "content": "u" }),
            json!({ "role": "tool", "tool_call_id": "1", "content": big }),
            json!({ "role": "tool", "tool_call_id": "2", "content": big }),
            json!({ "role": "tool", "tool_call_id": "3", "content": big }),
            json!({ "role": "tool", "tool_call_id": "4", "content": "newest" }),
        ];
        compact(&mut messages, 25_000);
        assert!(messages[2]["content"].as_str().unwrap().starts_with("[earlier result"));
        assert_eq!(messages[5]["content"], "newest", "the newest results are what the next step is about");
        assert_eq!(messages[4]["content"].as_str().unwrap().len(), 40_000);
    }

    #[test]
    fn written_calls_are_read_like_real_ones() {
        let names = ["search", "read_file"];
        let text = "Let's look.\n\n{\"name\": \"search\", \"arguments\": {\"query\": \"total\"}}";
        let (prose, calls) = written_calls(text, &names);
        assert_eq!(prose, "Let's look.");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["name"], "search");
        assert_eq!(calls[0]["arguments"]["query"], "total");

        let tagged = "<tool_call>\n{\"name\": \"read_file\", \"arguments\": \"{\\\"path\\\": \\\"a.js\\\"}\"}\n</tool_call>";
        let (prose, calls) = written_calls(tagged, &names);
        assert_eq!(prose, "");
        assert_eq!(calls[0]["arguments"]["path"], "a.js");

        let fenced = "```json\n{\"name\": \"read_file\", \"parameters\": {\"path\": \"b.ts\"}}\n```";
        assert_eq!(written_calls(fenced, &names).1[0]["arguments"]["path"], "b.ts");
    }

    #[test]
    fn an_announced_step_is_not_an_answer() {
        assert!(announces_action("No files matched. Let's search for files named cart."));
        assert!(announces_action("Voy a leer el archivo src/cart.js para ver el error."));
        assert!(announces_action("The fix is in two places:"));
        assert!(!announces_action("The bug was `total -= item.price`; I changed it to `+=`."));
    }

    #[test]
    fn a_claimed_change_is_recognised() {
        assert!(claims_change("The change has been applied to the `cart.js` file."));
        assert!(claims_change("Listo, he corregido el cálculo del total."));
        assert!(!claims_change("The total is computed in src/cart.js by a for loop."));
    }

    /// JSON that is the answer — a config the user asked for — is not a call.
    #[test]
    fn json_in_an_answer_is_left_alone() {
        let text = "Use this:\n{\"name\": \"my-app\", \"version\": \"1.0.0\"}";
        let (prose, calls) = written_calls(text, &["search"]);
        assert!(calls.is_empty());
        assert_eq!(prose, text);
    }

    #[test]
    fn local_usage_is_free_but_counted() {
        let usage = usage_of(Some(1200), Some(80)).expect("tokens were spent");
        assert_eq!(usage.input_tokens, 1200);
        assert_eq!(usage.cost_usd, Some(0.0));
        assert!(usage_of(None, None).is_none());
    }
}

/// Against a real model, so ignored by default. With Ollama serving `qwen2.5-coder:7b`:
/// `CODEFLOW_LIVE_AGENT=1 cargo test --lib local_agent::live -- --ignored --nocapture --test-threads=1`
/// (`CODEFLOW_LIVE_AGENT_MODEL` picks another Ollama model).
#[cfg(test)]
mod live {
    use super::*;

    fn settings() -> Option<Settings> {
        std::env::var("CODEFLOW_LIVE_AGENT").ok()?;
        let model = std::env::var("CODEFLOW_LIVE_AGENT_MODEL").unwrap_or_else(|_| "qwen2.5-coder:7b".to_string());
        Some(Settings {
            backend: Some(BackendKind::Ollama),
            url_ollama: None,
            url_openai: None,
            model_bundled: None,
            model_ollama: Some(model),
            model_openai: None,
            ctx: Some(16_384),
            delegate: None,
            on_fail: config::OnFail::Review,
            unload: false,
            review_mode: config::ReviewMode::Local,
        })
    }

    fn repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codeflow-live-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        git2::Repository::init(&dir).unwrap();
        std::fs::write(
            dir.join("src/cart.js"),
            "// Sums the price of every item in the cart.\nfunction cartTotal(items) {\n  let total = 0;\n  for (const item of items) {\n    total -= item.price;\n  }\n  return total;\n}\n\nmodule.exports = { cartTotal };\n",
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "# Cart\n\nA tiny cart library.\n").unwrap();
        dir
    }

    fn invocation<'a>(prompt: &'a str, cwd: Option<&'a str>, task: &'static str, write: bool) -> AiInvocation<'a> {
        let mut inv = super::tests_support::bare(prompt, cwd, task);
        inv.auto_approve_edits = write;
        inv
    }

    #[tokio::test]
    #[ignore]
    async fn fixes_a_bug_reads_code_and_writes_text() {
        let Some(settings) = settings() else { return };
        let dir = repo();
        let root = dir.to_string_lossy().to_string();

        let started = std::time::Instant::now();
        let fix = invocation(
            "The cart total comes out negative. Find the bug in this project and fix it.",
            Some(&root),
            task::FIX_FINDING,
            true,
        );
        let run = run_with(&settings, &fix, &None, &mut None).await.expect("the agent should answer");
        let code = std::fs::read_to_string(dir.join("src/cart.js")).unwrap();
        eprintln!("live agent: fix in {} ms → {:?}\n{code}", started.elapsed().as_millis(), run.text);
        assert!(code.contains("total += item.price"), "the bug is still there:\n{code}");

        let started = std::time::Instant::now();
        let ask = invocation("¿Qué exporta src/cart.js? Responde en una frase.", Some(&root), task::CHAT, false);
        let run = run_with(&settings, &ask, &None, &mut None).await.expect("the agent should answer");
        eprintln!("live agent: read-only chat in {} ms → {:?}", started.elapsed().as_millis(), run.text);
        assert!(run.text.contains("cartTotal"), "it should have read the file: {:?}", run.text);

        let started = std::time::Instant::now();
        let mut commit = invocation("Write a one-line conventional commit message for this diff.", None, task::COMMIT, false);
        commit.stdin_content = "-    total -= item.price;\n+    total += item.price;";
        let run = run_with(&settings, &commit, &None, &mut None).await.expect("text mode should answer");
        eprintln!("live agent: commit message in {} ms → {:?}", started.elapsed().as_millis(), run.text);
        assert!(!run.text.trim().is_empty());
        assert!(run.usage.is_some_and(|usage| usage.cost_usd == Some(0.0)));

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The map's worth, measured: tasks whose cause is not in the file the symptom names. Each runs
/// `CODEFLOW_LIVE_RUNS` times (default 1) against a fresh copy of a ~25-file project; set
/// `CODEFLOW_LIVE_NO_MAP=1` for the baseline without the repository map.
/// `CODEFLOW_LIVE_AGENT=1 [CODEFLOW_LIVE_AGENT_MODEL=…] [CODEFLOW_LIVE_NO_MAP=1] cargo test --lib local_agent::live_map -- --ignored --nocapture --test-threads=1`
#[cfg(test)]
mod live_map {
    use super::*;

    fn settings() -> Option<Settings> {
        std::env::var("CODEFLOW_LIVE_AGENT").ok()?;
        let model = std::env::var("CODEFLOW_LIVE_AGENT_MODEL").unwrap_or_else(|_| "qwen2.5-coder:7b".to_string());
        Some(Settings {
            backend: Some(BackendKind::Ollama),
            url_ollama: None,
            url_openai: None,
            model_bundled: None,
            model_ollama: Some(model),
            model_openai: None,
            ctx: Some(16_384),
            delegate: None,
            on_fail: config::OnFail::Review,
            unload: false,
            review_mode: config::ReviewMode::Local,
        })
    }

    fn runs() -> usize {
        std::env::var("CODEFLOW_LIVE_RUNS").ok().and_then(|n| n.parse().ok()).unwrap_or(1)
    }

    fn write(dir: &std::path::Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A small shop: the discount bug lives in `src/lib/pricing.js`, the symptom in checkout.
    fn shop() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codeflow-live-map-{}", uuid::Uuid::new_v4()));
        git2::Repository::init(&dir).unwrap();
        write(&dir, "README.md", "# Shop\n\nCart, checkout and a small HTTP API.\n");
        write(&dir, "package.json", "{\n  \"name\": \"shop\",\n  \"version\": \"1.0.0\"\n}\n");
        write(&dir, "src/lib/pricing.js", "// Price helpers shared by the cart and the checkout.\n\nfunction applyDiscount(price, percent) {\n  return price * percent / 100;\n}\n\nfunction formatPrice(amount) {\n  return '$' + amount.toFixed(2);\n}\n\nfunction roundCents(amount) {\n  return Math.round(amount * 100) / 100;\n}\n\nmodule.exports = { applyDiscount, formatPrice, roundCents };\n");
        write(&dir, "src/lib/tax.js", "function taxFor(amount, rate) {\n  return amount * rate;\n}\n\nmodule.exports = { taxFor };\n");
        write(&dir, "src/lib/strings.js", "function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n}\n\nfunction capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1);\n}\n\nmodule.exports = { slugify, capitalize };\n");
        write(&dir, "src/cart/cart.js", "const { applyDiscount, roundCents } = require('../lib/pricing');\n\nfunction cartSubtotal(items) {\n  let total = 0;\n  for (const item of items) {\n    total += item.price * item.qty;\n  }\n  return total;\n}\n\nfunction cartTotal(items, discountPercent) {\n  const subtotal = cartSubtotal(items);\n  const total = discountPercent ? applyDiscount(subtotal, discountPercent) : subtotal;\n  return roundCents(total);\n}\n\nmodule.exports = { cartSubtotal, cartTotal };\n");
        write(&dir, "src/cart/items.js", "function addItem(items, item) {\n  return [...items, item];\n}\n\nfunction removeItem(items, id) {\n  return items.filter((item) => item.id !== id);\n}\n\nmodule.exports = { addItem, removeItem };\n");
        write(&dir, "src/checkout/checkout.js", "const { cartTotal } = require('../cart/cart');\nconst { formatPrice } = require('../lib/pricing');\nconst { taxFor } = require('../lib/tax');\n\nfunction checkoutSummary(items, discountPercent) {\n  const total = cartTotal(items, discountPercent);\n  return { total, tax: taxFor(total, 0), label: formatPrice(total) };\n}\n\nmodule.exports = { checkoutSummary };\n");
        write(&dir, "src/checkout/receipt.js", "const { formatPrice } = require('../lib/pricing');\n\nfunction receiptLines(items) {\n  return items.map((item) => `${item.name} x${item.qty} ${formatPrice(item.price * item.qty)}`);\n}\n\nmodule.exports = { receiptLines };\n");
        write(&dir, "src/api/routes.js", "const { checkoutSummary } = require('../checkout/checkout');\nconst { receiptLines } = require('../checkout/receipt');\n\nfunction postCheckout(req) {\n  return checkoutSummary(req.body.items, req.body.discount);\n}\n\nfunction getReceipt(req) {\n  return receiptLines(req.body.items);\n}\n\nmodule.exports = { postCheckout, getReceipt };\n");
        write(&dir, "src/api/server.js", "const routes = require('./routes');\n\nfunction handle(path, req) {\n  if (path === '/checkout') return routes.postCheckout(req);\n  if (path === '/receipt') return routes.getReceipt(req);\n  return { status: 404 };\n}\n\nmodule.exports = { handle };\n");
        for (name, body) in [
            ("users", "function findUser(users, id) {\n  return users.find((u) => u.id === id);\n}\n\nmodule.exports = { findUser };\n"),
            ("orders", "function orderStatus(order) {\n  return order.paid ? 'paid' : 'pending';\n}\n\nmodule.exports = { orderStatus };\n"),
            ("stock", "function inStock(product) {\n  return product.stock > 0;\n}\n\nmodule.exports = { inStock };\n"),
            ("shipping", "function shippingCost(weight) {\n  return weight > 10 ? 15 : 5;\n}\n\nmodule.exports = { shippingCost };\n"),
            ("reviews", "function averageRating(reviews) {\n  return reviews.reduce((a, r) => a + r.stars, 0) / reviews.length;\n}\n\nmodule.exports = { averageRating };\n"),
            ("coupons", "function couponValid(coupon, now) {\n  return coupon.expires > now;\n}\n\nmodule.exports = { couponValid };\n"),
            ("emails", "function welcomeEmail(user) {\n  return `Hola ${user.name}`;\n}\n\nmodule.exports = { welcomeEmail };\n"),
            ("search", "function searchProducts(products, text) {\n  return products.filter((p) => p.name.includes(text));\n}\n\nmodule.exports = { searchProducts };\n"),
        ] {
            write(&dir, &format!("src/domain/{name}.js"), body);
        }
        for name in ["CartView", "CheckoutView", "ProductList", "Header", "Footer", "UserMenu"] {
            write(&dir, &format!("src/ui/{name}.js"), &format!("function {name}(props) {{\n  return {{ type: '{name}', props }};\n}}\n\nmodule.exports = {{ {name} }};\n"));
        }
        dir
    }

    fn node_eval(dir: &std::path::Path, code: &str) -> Option<String> {
        let out = std::process::Command::new("node").arg("-e").arg(code).current_dir(dir).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn label() -> String {
        format!(
            "{} {}",
            std::env::var("CODEFLOW_LIVE_AGENT_MODEL").unwrap_or_else(|_| "qwen2.5-coder:7b".to_string()),
            if std::env::var("CODEFLOW_LIVE_NO_MAP").is_ok() { "WITHOUT map" } else { "with map" }
        )
    }

    async fn task(prompt: &str, check: impl Fn(&std::path::Path) -> Result<(), String>) {
        let Some(settings) = settings() else { return };
        let mut passed = 0;
        let mut seconds = Vec::new();
        for run in 0..runs() {
            let dir = shop();
            let root = dir.to_string_lossy().to_string();
            let mut inv = super::tests_support::bare(prompt, Some(&root), task::FIX_FINDING);
            inv.auto_approve_edits = true;
            let started = std::time::Instant::now();
            let outcome = run_with(&settings, &inv, &None, &mut None).await;
            let elapsed = started.elapsed().as_secs_f64();
            seconds.push(elapsed);
            let verdict = outcome.as_ref().map_err(|e| e.clone()).and_then(|_| check(&dir));
            if verdict.is_ok() {
                passed += 1;
            }
            eprintln!("[{}] run {}: {} in {:.0} s → {:?}", label(), run + 1, if verdict.is_ok() { "PASS" } else { "FAIL" }, elapsed, verdict.err().unwrap_or_default());
            let _ = std::fs::remove_dir_all(&dir);
        }
        let mean = seconds.iter().sum::<f64>() / seconds.len().max(1) as f64;
        eprintln!("[{}] {passed}/{} passed, mean {:.0} s", label(), runs(), mean);
    }

    #[tokio::test]
    #[ignore]
    async fn fixes_a_bug_whose_cause_is_in_another_file() {
        task(
            "Con un descuento del 10% sobre una compra de 100, el total del checkout sale 10 en vez de 90. Encuentra la causa en este proyecto y arréglala.",
            |dir| match node_eval(dir, "console.log(require('./src/checkout/checkout').checkoutSummary([{price: 100, qty: 1}], 10).total)") {
                Some(total) if total == "90" => Ok(()),
                Some(total) => Err(format!("checkout total is {total}")),
                None => Err("the project no longer runs".to_string()),
            },
        )
        .await;
    }

    #[tokio::test]
    #[ignore]
    async fn renames_a_function_everywhere_it_is_used() {
        task(
            "Renombra la función cartTotal a computeCartTotal en todo el proyecto: la declaración y cada lugar donde se usa.",
            |dir| {
                let mut leftovers = Vec::new();
                for rel in ["src/cart/cart.js", "src/checkout/checkout.js"] {
                    let text = std::fs::read_to_string(dir.join(rel)).unwrap_or_default();
                    if text.contains("cartTotal") {
                        leftovers.push(rel);
                    }
                }
                if !leftovers.is_empty() {
                    return Err(format!("cartTotal still in {leftovers:?}"));
                }
                match node_eval(dir, "console.log(require('./src/checkout/checkout').checkoutSummary([{price: 50, qty: 2}], 0).total)") {
                    Some(total) if total == "100" => Ok(()),
                    Some(total) => Err(format!("checkout total is {total}")),
                    None => Err("the project no longer runs".to_string()),
                }
            },
        )
        .await;
    }
}

#[cfg(test)]
mod tests_support {
    use super::*;

    pub fn bare<'a>(prompt: &'a str, cwd: Option<&'a str>, task: &'static str) -> AiInvocation<'a> {
        AiInvocation {
            prompt,
            system_prompt: None,
            model: "",
            allowed_tools: &[],
            cwd,
            stdin_content: "",
            skills_note: String::new(),
            resume_session_id: None,
            auto_approve_edits: false,
            attachments: &[],
            effort: None,
            task,
            stream_deltas: None,
            read_only: false,
            prompt_files: Default::default(),
            mcp_block: Vec::new(),
            app_mcp: Vec::new(),
            json_schema: None,
            extra_dirs: &[],
        }
    }
}
