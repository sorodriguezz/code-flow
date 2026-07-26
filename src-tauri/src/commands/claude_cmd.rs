//! Tauri commands for the AI features (commit messages, pre-commit analysis, chat, "fix with
//! AI"). Despite the file name — kept stable so the frontend command bindings don't move — these
//! are provider-neutral: each resolves the active engine from the `ai_provider` setting via
//! [`load_ai_config`] and dispatches through [`crate::ai`], so switching Claude ⇆ Gemini ⇆ … is a
//! settings change, not a code change. The PR-review command lives in `ado_cmd` (it needs the VCS
//! dispatch first) but shares these same helpers.

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::ai::{self, AiEngine};
use crate::commands::ado_cmd::build_mcp_config;
use crate::commands::skills_cmd::sync_skills_into_project;
use crate::db::{queries, Db};
use crate::git;

#[derive(Serialize)]
pub struct ChatReply {
    text: String,
    session_id: Option<String>,
    /// Model that actually answered this turn, when the CLI reported one — shown as-is in the
    /// chat's "who am I talking to" chip. `None` falls back to the configured setting there.
    model: Option<String>,
    /// How long the engine took to answer, in milliseconds — shown under the reply.
    response_time_ms: i64,
}

/// The active AI provider id, from the `ai_provider` setting. Falls back to Claude when unset or
/// blank so a fresh install (or a cleared setting) always has a working engine.
pub(crate) fn active_provider(conn: &Connection) -> Result<String, String> {
    Ok(queries::get_setting(conn, "ai_provider")
        .map_err(|e| e.to_string())?
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string()))
}

/// Which AI action a command is performing — selects both the provider and the model for it.
/// Each task can be routed to its own provider (`ai_provider_{key}`, falling back to the global
/// `ai_provider`) and its own model within that provider (`{provider}_{key}_model`, falling back
/// to that provider's base model). That's what lets one repo draft commits on a local Ollama
/// model, review PRs on Opus, and fix findings through opencode.
#[derive(Clone, Copy)]
pub(crate) enum AiTask {
    /// Commit-message generation — defaults to the engine's fast model, not the base model.
    Commit,
    /// Pre-commit "Analyze changes" (bugs/vulnerabilities in the working diff).
    Analyze,
    /// Pull-request review.
    Review,
    /// Pull-request description drafting.
    PrDescription,
    /// Open-ended chat.
    Chat,
    /// "Fix with AI" on a finding — the only task that needs an agentic, write-capable engine.
    Fix,
    /// AI-proposed merge-conflict resolution. Split from [`AiTask::Fix`] because it only returns
    /// text (no tool use), so it can be routed to a local model that `Fix` can't use.
    Conflict,
}

impl AiTask {
    /// The settings-key fragment for this task: `ai_provider_{key}` and `{provider}_{key}_model`.
    /// The four original values (`commit`/`analyze`/`review`/`pr_description`) are unchanged, so
    /// model overrides saved before per-task routing existed keep working.
    pub(crate) fn key(self) -> &'static str {
        match self {
            AiTask::Commit => "commit",
            AiTask::Analyze => "analyze",
            AiTask::Review => "review",
            AiTask::PrDescription => "pr_description",
            AiTask::Chat => "chat",
            AiTask::Fix => "fix",
            AiTask::Conflict => "conflict",
        }
    }
}

/// The provider that should handle `task`: its own routing override when set, else the global
/// `ai_provider` default. Blank counts as unset, so clearing a row in the UI means "inherit".
fn provider_for(conn: &Connection, task: AiTask) -> Result<String, String> {
    let routed = queries::get_setting(conn, &format!("ai_provider_{}", task.key()))
        .map_err(|e| e.to_string())?
        .filter(|p| !p.trim().is_empty());
    match routed {
        Some(p) => Ok(p),
        None => active_provider(conn),
    }
}

/// The active engine plus its resolved per-provider binary/model/tools. Binary/model/tools are
/// namespaced per provider (`{provider}_binary_path`, `{provider}_model`, `{provider}_allowed_tools`)
/// because they're intrinsically provider-specific — a binary path and model id only mean
/// something for one CLI, and tool names differ between CLIs. `model` is resolved for the specific
/// [`AiTask`] requested (per-task override → base model → engine default). The prompt *templates*,
/// by contrast, are shared across providers (see [`shared_template`]).
pub(crate) struct AiConfig {
    pub engine: Box<dyn AiEngine>,
    pub binary: String,
    pub model: String,
    pub tools: Vec<String>,
}

pub(crate) fn load_ai_config(conn: &Connection, task: AiTask) -> Result<AiConfig, String> {
    let provider = provider_for(conn, task)?;
    let engine = ai::engine_for(&provider);

    let get = |suffix: &str| -> Result<Option<String>, String> {
        queries::get_setting(conn, &format!("{provider}_{suffix}")).map_err(|e| e.to_string())
    };
    // A stored setting that's blank counts as "unset" — falls through to the next fallback.
    let nonblank = |v: Option<String>| v.filter(|s| !s.trim().is_empty());

    let binary = nonblank(get("binary_path")?).unwrap_or_else(|| engine.default_binary().to_string());
    let base_model = get("model")?.unwrap_or_default();
    let tools = get("allowed_tools")?
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Per-task model override → (for commits) the engine's dedicated fast model → the base model.
    // The last fallback matters for engines with no fast model (Ollama), which need *some* explicit
    // model or the request fails.
    let model = match nonblank(get(&format!("{}_model", task.key()))?) {
        Some(override_model) => override_model,
        None => match task {
            AiTask::Commit => {
                let dedicated = engine.commit_message_model();
                if dedicated.is_empty() { base_model.clone() } else { dedicated.to_string() }
            }
            _ => base_model.clone(),
        },
    };

    Ok(AiConfig { engine, binary, model, tools })
}

/// Reads a shared (provider-independent) prompt template. New installs store these under an
/// unprefixed key (`commit_template`); older ones stored them under the legacy `claude_*` key —
/// so we read the new key and fall back to the legacy one, preserving a user's existing
/// customization without a migration step. Empty means "use the engine's built-in default".
pub(crate) fn shared_template(conn: &Connection, key: &str, legacy_key: &str) -> Result<String, String> {
    let current = queries::get_setting(conn, key).map_err(|e| e.to_string())?;
    if let Some(v) = current.filter(|s| !s.trim().is_empty()) {
        return Ok(v);
    }
    Ok(queries::get_setting(conn, legacy_key)
        .map_err(|e| e.to_string())?
        .unwrap_or_default())
}

#[tauri::command]
pub async fn generate_commit_message(db: State<'_, Db>, diff: String) -> Result<String, String> {
    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let config = load_ai_config(&conn, AiTask::Commit)?;
        let template = shared_template(&conn, "commit_template", "claude_commit_template")?;
        (config, template)
    };
    ai::generate_commit_message(&*config.engine, &config.binary, &config.model, &diff, &template).await
}

/// Lists the models a provider's CLI reports as actually available (e.g. `opencode models`), so the
/// Settings model picker shows the real set instead of a hardcoded guess. `provider` is the tab the
/// user is looking at; it defaults to the active provider when omitted. Returns an empty list for
/// providers whose CLI has no such command (Claude/Gemini) — the frontend falls back to its curated
/// list there.
#[tauri::command]
pub async fn list_ai_models(db: State<'_, Db>, provider: Option<String>) -> Result<Vec<String>, String> {
    let (engine, binary) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let provider = provider
            .filter(|p| !p.trim().is_empty())
            .map(Ok)
            .unwrap_or_else(|| active_provider(&conn))?;
        let engine = ai::engine_for(&provider);
        let binary = queries::get_setting(&conn, &format!("{provider}_binary_path"))
            .map_err(|e| e.to_string())?
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| engine.default_binary().to_string());
        (engine, binary)
    };
    ai::list_models(&*engine, &binary).await
}

/// Whether a provider is ready to use, for the Settings status badge.
#[derive(Serialize)]
pub struct ProviderStatus {
    available: bool,
    /// Resolved binary path / endpoint when available; the missing binary name or the connection
    /// error when not. The frontend pairs this with a translated label.
    detail: String,
    /// The binary path or endpoint that was checked — echoed back so the UI can show what it tried.
    binary: String,
}

/// Checks whether `provider`'s CLI is actually installed (or, for Ollama, whether its endpoint
/// answers), so Settings can show "available / not found" instead of letting the user discover it
/// when an action fails.
#[tauri::command]
pub async fn check_ai_provider(db: State<'_, Db>, provider: String) -> Result<ProviderStatus, String> {
    let (engine, binary) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let engine = ai::engine_for(&provider);
        let binary = queries::get_setting(&conn, &format!("{provider}_binary_path"))
            .map_err(|e| e.to_string())?
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| engine.default_binary().to_string());
        (engine, binary)
    };
    let (available, detail) = ai::probe(&*engine, &binary).await;
    Ok(ProviderStatus { available, detail, binary })
}

/// Proposes an AI-merged version of a conflicted file (from its base/ours/theirs index stages).
/// Returns the resolved file content as a string — nothing is written to disk here; the frontend
/// shows it for review and only writes + stages it once the user accepts.
#[tauri::command]
pub async fn resolve_conflict_with_ai(
    db: State<'_, Db>,
    repo_path: String,
    rel_path: String,
) -> Result<String, String> {
    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let config = load_ai_config(&conn, AiTask::Conflict)?;
        let template = shared_template(&conn, "resolve_conflict_template", "claude_resolve_conflict_template")?;
        (config, template)
    };
    let versions = git::merge::conflict_versions(&repo_path, &rel_path)?;
    ai::resolve_conflict(
        &*config.engine,
        &config.binary,
        &config.model,
        &rel_path,
        &versions.base,
        &versions.ours,
        &versions.theirs,
        &template,
    )
    .await
}

#[tauri::command]
pub fn default_commit_template() -> String {
    ai::DEFAULT_COMMIT_TEMPLATE.to_string()
}

#[tauri::command]
pub fn default_review_template() -> String {
    ai::DEFAULT_REVIEW_PROMPT.to_string()
}

#[tauri::command]
pub fn default_analyze_template() -> String {
    ai::DEFAULT_ANALYZE_TEMPLATE.to_string()
}

#[tauri::command]
pub fn default_pr_description_template() -> String {
    ai::DEFAULT_PR_DESCRIPTION_TEMPLATE.to_string()
}

#[tauri::command]
pub fn default_resolve_conflict_template() -> String {
    ai::DEFAULT_RESOLVE_CONFLICT_TEMPLATE.to_string()
}

/// Scans whatever's currently sitting in the working directory (the "Changes" list —
/// unstaged + untracked, not what's already staged) for bugs/vulnerabilities before the
/// user commits it. Folds in the same workspace-level context/instructions/skills/MCPs as
/// a PR review, just pointed at the local diff instead of a pull request.
#[tauri::command]
pub async fn analyze_working_changes(db: State<'_, Db>, project_id: String, job_id: String) -> Result<String, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    let workspace_id = project.workspace_id.clone();

    let (contexts, md_files, mcps, config, analyze_template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let md_files = queries::list_workspace_md_files(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = load_ai_config(&conn, AiTask::Analyze)?;
        let analyze_template = shared_template(&conn, "analyze_template", "claude_analyze_template")?;
        (contexts, md_files, mcps, config, analyze_template)
    };

    // Best-effort, same as the PR review path — a missing/unwritable skills dir shouldn't
    // block the analysis itself.
    let _ = sync_skills_into_project(&workspace_id, &project.local_path);

    let diff_files = git::diff::get_working_diff(&project.local_path)?;
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    enabled_contexts.extend(md_files.into_iter().filter(|f| f.enabled).map(|f| (f.filename, f.content)));

    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    let result = ai::analyze_changes(
        &*config.engine,
        &config.binary,
        &config.model,
        &enabled_contexts,
        &diff_text,
        &config.tools,
        &project.local_path,
        &analyze_template,
        mcp_config_path.as_deref(),
    )
    .await;

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = match &result {
            Ok(text) => queries::add_job_history(&conn, &job_id, &project_id, "analyze-changes", "Análisis de cambios", "done", Some(text), None, "{}"),
            Err(e) => queries::add_job_history(&conn, &job_id, &project_id, "analyze-changes", "Análisis de cambios", "error", None, Some(e), "{}"),
        };
    }

    result
}

/// Asks the active engine to apply one finding's fix (from a PR review or a pre-commit analysis)
/// directly to the working tree — `finding_prompt` is the finding's location/why/suggestion,
/// pre-formatted by the frontend from the already-parsed finding. Leaves the result as
/// uncommitted changes; nothing here stages, commits, or pushes anything.
#[tauri::command]
pub async fn resolve_finding_with_ai(db: State<'_, Db>, project_id: String, finding_prompt: String) -> Result<String, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        load_ai_config(&conn, AiTask::Fix)?
    };

    ai::apply_finding_fix(&*config.engine, &config.binary, &config.model, &finding_prompt, &project.local_path).await
}

/// Open-ended chat about the project — "preguntas abiertas del repositorio", the free-text
/// half of the AI panel alongside PR review and change analysis. `session_id` is `None` for a
/// brand new conversation and whatever the previous call returned for every turn after that,
/// so the engine resumes the same session instead of losing prior context each message.
#[tauri::command]
pub async fn send_chat_message(
    db: State<'_, Db>,
    project_id: String,
    message: String,
    session_id: Option<String>,
) -> Result<ChatReply, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    let workspace_id = project.workspace_id.clone();

    let (contexts, md_files, mcps, config) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let md_files = queries::list_workspace_md_files(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = load_ai_config(&conn, AiTask::Chat)?;
        (contexts, md_files, mcps, config)
    };

    let _ = sync_skills_into_project(&workspace_id, &project.local_path);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    enabled_contexts.extend(md_files.into_iter().filter(|f| f.enabled).map(|f| (f.filename, f.content)));

    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    // Timed around the engine call only, so it reflects how long the model actually took —
    // not the surrounding DB reads or IPC.
    let started = std::time::Instant::now();
    let result = ai::chat_with_repo(
        &*config.engine,
        &config.binary,
        &config.model,
        &enabled_contexts,
        &message,
        session_id.as_deref(),
        &config.tools,
        &project.local_path,
        mcp_config_path.as_deref(),
    )
    .await;
    let response_time_ms = started.elapsed().as_millis() as i64;

    let run = match result {
        Ok(run) => run,
        Err(e) => {
            // Record the failure too. Otherwise the panel's error vanishes the moment the next
            // message is sent, and days later there's nothing left explaining why a run died
            // (out of credit, CLI gone). A first-turn failure has no session yet, so mint one so
            // it still groups as its own entry in the activity list.
            let sid = session_id.unwrap_or_else(|| format!("failed-{}", uuid::Uuid::new_v4()));
            if let Ok(conn) = db.0.lock() {
                let _ =
                    queries::add_activity_log(&conn, &project_id, &sid, &message, &e, Some(response_time_ms), true);
            }
            return Err(e);
        }
    };

    if let Some(sid) = &run.session_id {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = queries::add_activity_log(&conn, &project_id, sid, &message, &run.text, Some(response_time_ms), false);
    }

    Ok(ChatReply { text: run.text, session_id: run.session_id, model: run.model, response_time_ms })
}
