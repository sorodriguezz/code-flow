//! Tauri commands for the AI features (commit messages, pre-commit analysis, chat, "fix with
//! AI"). Despite the file name — kept stable so the frontend command bindings don't move — these
//! are provider-neutral: each resolves the active engine from the `ai_provider` setting via
//! [`load_ai_config_in`] and dispatches through [`crate::ai`], so switching Claude ⇆ Gemini ⇆ … is a
//! settings change, not a code change. The PR-review command lives in `ado_cmd` (it needs the VCS
//! dispatch first) but shares these same helpers.

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::ai_accounts;
use crate::ai::{self, AiEngine};
use crate::ai_locks;
use crate::ai_runs;
use crate::commands::skills_cmd::sync_skills_into_project;
use crate::db::{hybrid_queries, queries, Db};
use crate::git;

#[derive(Serialize)]
pub struct ChatReply {
    text: String,
    session_id: Option<String>,
    /// Model that actually answered this turn, when the CLI reported one — shown as-is in the
    /// chat's "who am I talking to" chip. `None` falls back to the configured setting there.
    model: Option<String>,
    /// Provider id that answered this turn (`claude`, `codex`, …). Reported back rather than read
    /// from the setting on the frontend, so the stamp under a reply keeps naming the engine that
    /// actually ran even after the routing is changed.
    provider: String,
    /// Version of the engine CLI, when it could be read.
    engine_version: Option<String>,
    /// When this turn was recorded, RFC 3339. Comes from the persisted row so the timestamp shown
    /// live and the one shown on a reopened conversation are the same instant.
    created_at: String,
    /// How long the engine took to answer, in milliseconds — shown under the reply.
    response_time_ms: i64,
    /// The account that answered — `None` for the CLI's system account.
    account_id: Option<String>,
    /// The thread had a session, and this turn started a fresh one because the account changed.
    /// A session lives in its account's directory, so it could not be carried over — and this chat
    /// does not replay history into a fresh session, so the panel says so rather than letting the
    /// engine seem to have forgotten.
    account_changed: bool,
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
/// to that provider's base model). That's what lets one repo draft commits on a local model
/// through Cline, review PRs on Opus, and fix findings through opencode.
#[derive(Clone, Copy, PartialEq, Eq)]
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
    /// The editor's inline edit (Ctrl+I over a selection). Text-only like `Conflict`, so it can
    /// be routed to a fast local model — which is the point: this one runs while you type.
    Inline,
    /// Deriving user stories and acceptance criteria from documentation. Text-only and repo-less,
    /// so it routes anywhere — including a local model, which is often the right call for a task
    /// whose input is a wiki page rather than a codebase.
    Stories,
    /// Checking a story's acceptance criteria against the code of a repository. The opposite of
    /// [`AiTask::Stories`] in what it needs: this one reads the codebase, so it has to run on an
    /// engine with tools — a text-only local model would answer from the criteria alone, which is
    /// exactly the confident-and-wrong verdict the whole feature exists to avoid.
    StoryVerify,
    /// Reviewing a work item that already exists — analysis, description, criteria, tasks. Split
    /// from [`AiTask::StoryVerify`], which it used to share, because the two are different jobs at
    /// different lengths: one judges a handful of criteria, this one rewrites a whole work item
    /// four times over, and a team routinely wants the cheaper engine for one of them. Reads the
    /// repository, so it needs tools.
    WorkItemReview,
    /// Writing a repository's or a workspace's technical documentation by reading the code. Its
    /// own route rather than the verification's: this is the longest single run in the app, and
    /// which engine writes documentation is a decision a team makes on its own terms.
    Wiki,
    /// Drawing a diagram from a description. Text-only — the engine answers with a small JSON
    /// description of nodes and edges and CodeFlow lays it out itself (see `ai::draw_diagram`), so
    /// this routes anywhere, a local model included. Deliberately *not* sharing `Notes`' route:
    /// the two produce different things and a team routinely wants a cheaper engine for one.
    Diagram,
    /// The database console's assistant. Text-only like [`AiTask::Inline`] — the schema is read by
    /// CodeFlow's own driver and put on stdin, so the engine never touches the database — which is
    /// what lets this one be routed to a fast or local model. It is also the task most likely to be
    /// run twenty times in an afternoon, so being able to point it somewhere cheap is the point.
    DbQuery,
    /// Writing Markdown into the open note. Text-only — the engine never sees the repository, it
    /// is handed the note on stdin — so it routes anywhere, and a note is exactly the kind of
    /// prose someone wants on a different engine than their code: a local model for a rough
    /// outline, a large one for something that has to read well.
    Notes,
    /// Explaining why a CI pipeline broke. Reads the repository — that is the whole point of it,
    /// since the question is what the log means *in this codebase* — so it needs an engine with
    /// tools, like [`AiTask::StoryVerify`]. Its own route rather than [`AiTask::Analyze`]'s, which
    /// is the closest relative: that one is handed a diff and answers about the diff, this one is
    /// handed a log and has to go looking. A team that runs the cheap engine over its working copy
    /// routinely wants the expensive one for a build that has been red for an hour.
    Pipeline,
    /// Inventing sample rows for the DBML sandbox. Text-only — the engine answers with JSON that
    /// CodeFlow validates against the schema and turns into `INSERT`s itself (see `ai::fill_rows`),
    /// so it never reaches the database and routes anywhere. Deliberately *not* sharing
    /// [`AiTask::Diagram`]'s route, which is its closest relative: drawing a schema is one short
    /// answer, and filling it is fifteen tables of data — a long, cheap, repetitive job that a team
    /// routinely wants pointed somewhere other than the one that has to get a model right.
    SampleRows,
    /// The notebook's per-cell actions — generate, explain, fix an error, document. Text-only: the
    /// cells go to the engine on stdin and a cell's worth of code (or prose) comes back, shown as a
    /// diff to accept, so it routes anywhere, a local model included. Its own route rather than
    /// [`AiTask::Inline`]'s: a notebook is analysis more often than application code, and which
    /// engine explains a traceback is not the one a team picks for a quick rewrite.
    Notebook,
    /// Naming a conversation after its first question, in both chats — see `crate::chat_title`.
    /// Text-only and a handful of words, so like [`AiTask::Commit`] it defaults to the engine's fast
    /// model rather than the base one: it runs once per new conversation, behind the user's back.
    ChatTitle,
    /// The AI nodes of a flow whose engine is left automatic. A node that names its own engine runs
    /// on that one; this row is where the rest go, and what Settings shows as their default.
    Flows,
    /// Writing or changing a flow from a description in the editor — see `flows::builder`.
    /// Text-only (the catalogue goes on stdin, the answer is JSON checked before it is drawn), and
    /// its own row rather than [`AiTask::Flows`]': picking a strong model to *build* a flow must not
    /// move every automatic AI node of every flow onto it.
    FlowBuilder,
    /// Explaining a container's or a pod's log — the Contenedores panel's «Analizar con IA». Text-only:
    /// the log goes on stdin as the pane shows it, and the engine never reaches the cluster or the
    /// engine, so it routes anywhere, a local model included. Its own row rather than
    /// [`AiTask::Pipeline`]'s, its closest relative: that one reads a repository with tools to explain
    /// a red build, this one reads a log and nothing else — a different length of run, and routinely
    /// the cheaper engine.
    Logs,
    /// «Reuniones»: minutes, decisions, tasks… written from a meeting's transcript, and questions
    /// about it answered. Text-only — the transcript goes on stdin — so it routes anywhere. Unset, it
    /// takes the [`AiTask::Notes`] row's engine (see [`provider_for`]): a meeting is written into a
    /// note, and someone who chose an engine for their notes has chosen it for this too.
    Meetings,
    /// «Resumen hablado»: a long answer cut to two or three sentences before the thinking mark reads
    /// it aloud (`crate::speech`). Text-only and short, so like [`AiTask::ChatTitle`] it runs on the
    /// engine's fast model unless its row names another — it runs behind the user's back, after
    /// every answer they asked to hear.
    SpokenSummary,
}

impl AiTask {
    /// Every task, so a caller can ask about the routing as a whole rather than one job at a time.
    ///
    /// The compiler holds this to the enum: the array is typed to its exact length, so adding a
    /// variant without adding it here fails the build. That matters because the one reader —
    /// [`routed_providers`] — is deciding what *not* to do, and a task missing from this list would
    /// silently make its engine invisible to the quota panel rather than produce an obvious error.
    pub(crate) const ALL: [AiTask; 24] = [
        AiTask::Commit,
        AiTask::Analyze,
        AiTask::Review,
        AiTask::PrDescription,
        AiTask::Chat,
        AiTask::Fix,
        AiTask::Conflict,
        AiTask::Inline,
        AiTask::Stories,
        AiTask::StoryVerify,
        AiTask::WorkItemReview,
        AiTask::Wiki,
        AiTask::DbQuery,
        AiTask::Notes,
        AiTask::Diagram,
        AiTask::Pipeline,
        AiTask::SampleRows,
        AiTask::Notebook,
        AiTask::ChatTitle,
        AiTask::Flows,
        AiTask::FlowBuilder,
        AiTask::Logs,
        AiTask::Meetings,
        AiTask::SpokenSummary,
    ];

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
            AiTask::Inline => "inline",
            AiTask::Stories => "stories",
            AiTask::StoryVerify => "story_verify",
            AiTask::WorkItemReview => "work_item_review",
            AiTask::Wiki => "wiki",
            AiTask::DbQuery => "db_query",
            AiTask::Notes => "notes",
            AiTask::Diagram => "diagram",
            AiTask::Pipeline => "pipeline",
            AiTask::SampleRows => "sample_rows",
            AiTask::Notebook => "notebook",
            AiTask::ChatTitle => "chat_title",
            AiTask::Flows => "flows",
            AiTask::FlowBuilder => "flow_builder",
            AiTask::Logs => "logs",
            AiTask::Meetings => "meetings",
            AiTask::SpokenSummary => "spoken_summary",
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
        // A meeting's row, unset, follows the Notes row (which itself falls back to the default).
        None if task == AiTask::Meetings => provider_for(conn, AiTask::Notes),
        None => active_provider(conn),
    }
}

/// Every provider this install actually sends work to — the global `ai_provider` plus every
/// per-task override that names a different one.
///
/// **This is "which engines do I use", not "which engines are installed".** The distinction is the
/// whole point. A machine routinely carries CLIs it does not route anything to: one installed to
/// try, one left behind by an uninstall, one that came with another tool. Asking those for a plan
/// limit spends a keychain read, an HTTPS call or a subprocess on an engine whose numbers nobody is
/// going to act on — and then puts them on screen, where they compete with the numbers that *do*
/// matter and can drive the status pill from a plan the user never touches.
///
/// The global default is always in the set, including when the setting is unset: [`active_provider`]
/// falls back to Claude, and a fresh install genuinely does route everything there.
///
/// Note this is a *superset* of the active provider by design. Routing PR review to Codex and
/// everything else to Claude means Codex running out is a real event for this install, so it stays
/// in the set even though it is not the global default.
pub(crate) fn routed_providers(conn: &Connection) -> Result<std::collections::HashSet<String>, String> {
    let mut providers = std::collections::HashSet::new();
    providers.insert(active_provider(conn)?);
    for task in AiTask::ALL {
        let routed = queries::get_setting(conn, &format!("ai_provider_{}", task.key()))
            .map_err(|e| e.to_string())?
            .filter(|p| !p.trim().is_empty());
        // Blank counts as unset here for the same reason it does in `provider_for`: clearing a row
        // in the UI means "inherit", and the inherited value is already in the set.
        if let Some(provider) = routed {
            providers.insert(provider);
        }
    }
    Ok(providers)
}

/// The active engine plus its resolved per-provider binary/model/tools. Binary/model/tools are
/// namespaced per provider (`{provider}_binary_path`, `{provider}_model`, `{provider}_allowed_tools`)
/// because they're intrinsically provider-specific — a binary path and model id only mean
/// something for one CLI, and tool names differ between CLIs. `model` is resolved for the specific
/// [`AiTask`] requested (per-task override → base model → engine default). The prompt *templates*,
/// by contrast, are shared across providers (see [`shared_template`]).
pub(crate) struct AiConfig {
    /// Already bound to [`AiConfig::account`] — every process it starts runs as that account.
    pub engine: Box<dyn AiEngine>,
    /// The provider id this config resolved to — kept so a caller can record *which* engine ran
    /// (the setting it came from is a moving target).
    pub provider: String,
    /// The account the engine runs as. See `crate::ai_accounts` for how it was chosen.
    pub account: ai_accounts::AccountEnv,
    pub binary: String,
    pub model: String,
    pub tools: Vec<String>,
}

impl AiConfig {
    /// The account to stamp on what this run leaves behind — `None` is the system account.
    pub fn account_id(&self) -> Option<&str> {
        self.account.account_id.as_deref()
    }
}

/// The configuration for `task`, for a run that belongs to `workspace_id` — which is what lets that
/// workspace's default account apply.
pub(crate) fn load_ai_config_in(
    conn: &Connection,
    task: AiTask,
    workspace_id: Option<&str>,
) -> Result<AiConfig, String> {
    // The meetings row follows the Notes row where it says nothing: its provider (`provider_for`),
    // and below, its model.
    let provider = provider_for(conn, task)?;
    let account = ai_accounts::resolve(conn, &provider, Some(task.key()), workspace_id, ai_accounts::Choice::Auto);
    let engine = ai::engine_as(&provider, account.clone());

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

    // Per-task model override → (for commits and chat titles) the engine's dedicated fast model →
    // the base model. The last fallback matters for engines with no fast model of their own (Cline,
    // opencode), whose model depends entirely on what the user configured inside them.
    let own = match nonblank(get(&format!("{}_model", task.key()))?) {
        None if task == AiTask::Meetings => nonblank(get(&format!("{}_model", AiTask::Notes.key()))?),
        found => found,
    };
    let model = match own {
        Some(override_model) => override_model,
        None => match task {
            AiTask::Commit | AiTask::ChatTitle | AiTask::SpokenSummary => {
                let dedicated = engine.commit_message_model();
                if dedicated.is_empty() { base_model.clone() } else { dedicated.to_string() }
            }
            _ => base_model.clone(),
        },
    };

    Ok(AiConfig { engine, provider, account, binary, model, tools })
}

/// Builds an [`AiConfig`] for an explicit provider + model (an SDD/Harness agent's own routing),
/// bypassing per-task resolution — the binary path and tool allow-list still come from that
/// provider's saved settings — run as `choice`: an explicit account, the system one, or automatic,
/// in which case `task` and `workspace_id` are what the resolution consults.
pub(crate) fn load_ai_config_as(
    conn: &Connection,
    provider: &str,
    model: &str,
    choice: ai_accounts::Choice,
    task: Option<AiTask>,
    workspace_id: Option<&str>,
) -> Result<AiConfig, String> {
    let account = ai_accounts::resolve(conn, provider, task.map(|t| t.key()), workspace_id, choice);
    let engine = ai::engine_as(provider, account.clone());
    let get = |suffix: &str| -> Result<Option<String>, String> {
        queries::get_setting(conn, &format!("{provider}_{suffix}")).map_err(|e| e.to_string())
    };
    let nonblank = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
    let binary = nonblank(get("binary_path")?).unwrap_or_else(|| engine.default_binary().to_string());
    let tools = get("allowed_tools")?
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    Ok(AiConfig { engine, provider: provider.to_string(), account, binary, model: model.to_string(), tools })
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
pub async fn generate_commit_message(
    app: AppHandle,
    db: State<'_, Db>,
    diff: String,
    run_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // The caller's workspace, so its default account applies — the one the chip beside Commit
        // names. Optional: a caller that does not say gets the task's pin or the provider's default.
        let config = load_ai_config_in(&conn, AiTask::Commit, workspace_id.as_deref())?;
        let template = shared_template(&conn, "commit_template", "claude_commit_template")?;
        (config, template)
    };
    ai_runs::scoped(app, run_id, async {
        ai::generate_commit_message(&*config.engine, &config.binary, &config.model, &diff, &template).await
    })
    .await
}

/// Drafts a reply to a pull-request comment thread — the "write it with AI" half of answering a
/// reviewer, next to writing it by hand.
///
/// `conversation` is the thread as the panel already renders it (author: text, one per line) and
/// `note` is the gist the user wants the reply to carry ("no aplica, es intencional"). Routed to
/// the Chat task rather than Fix: this only produces prose for a textarea the user then edits, so
/// it needs no tools, no working copy, and can run on a local model.
#[tauri::command]
pub async fn draft_pr_comment_reply(
    app: AppHandle,
    db: State<'_, Db>,
    conversation: String,
    note: Option<String>,
    run_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<String, String> {
    draft_reply_on(app, db, conversation, note, run_id, workspace_id, None).await
}

/// The engine a task runs on: one chosen by the caller (a Flujos node's picker), else the task's
/// own routing.
fn config_for(conn: &Connection, task: AiTask, workspace_id: Option<&str>, chosen: Option<(&str, &str)>) -> Result<AiConfig, String> {
    match chosen {
        Some((provider, model)) if !provider.trim().is_empty() => {
            load_ai_config_as(conn, provider, model, ai_accounts::Choice::Auto, Some(task), workspace_id)
        }
        _ => load_ai_config_in(conn, task, workspace_id),
    }
}

/// [`draft_pr_comment_reply`] on a chosen engine — Flujos' "Responder con IA".
pub(crate) async fn draft_reply_on(
    app: AppHandle,
    db: State<'_, Db>,
    conversation: String,
    note: Option<String>,
    run_id: Option<String>,
    workspace_id: Option<String>,
    engine: Option<(String, String)>,
) -> Result<String, String> {
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // The workspace the review is open in, when the caller says — what lets its account answer
        // rather than the provider's default.
        config_for(&conn, AiTask::Chat, workspace_id.as_deref(), engine.as_ref().map(|(p, m)| (p.as_str(), m.as_str())))?
    };
    ai_runs::scoped(app, run_id, async {
        ai::draft_comment_reply(&*config.engine, &config.binary, &config.model, &conversation, note.as_deref()).await
    })
    .await
}

/// Stops a run started with the given id. `false` means it had already finished (or never
/// started) — the frontend treats that as "nothing to do" rather than an error, since the race
/// between clicking stop and the reply arriving is perfectly normal.
#[tauri::command]
pub fn cancel_ai_run(run_id: String) -> bool {
    ai_runs::cancel(&run_id)
}

/// The providers whose read-only mode is a limit their CLI **enforces** — see
/// `ai::AiEngine::enforces_read_only`.
///
/// Asked of the engines rather than listed in the frontend, so the promise on screen ("it can only
/// answer in text", "writes nothing") comes from the same code that builds the command line. Where
/// a provider is missing from this list the UI says plainly that "text only" is a request. Fixed
/// for a build, so a window asks once.
/// Classifies the error an AI run failed with — quota, sign-in, missing CLI, provider outage, or
/// anything else — with the provider's own words and, for a quota, when it resets. See
/// `ai::classify_failure`; this is the frontend's door to the same function, so the chain executor
/// and the banners decide on one classifier rather than a copy of it.
#[tauri::command]
pub fn ai_classify_failure(error: String) -> ai::AiFailure {
    ai::classify_failure(&error)
}

#[tauri::command]
pub fn ai_read_only_engines() -> Vec<String> {
    ["claude", "gemini", "codex", "grok", "opencode", "cline"]
        .into_iter()
        .filter(|id| ai::engine_for(id).enforces_read_only())
        .map(str::to_string)
        .collect()
}

/// Lists the models a provider's CLI reports as actually available (e.g. `opencode models`), so the
/// Settings model picker shows the real set instead of a hardcoded guess. `provider` is the tab the
/// user is looking at; it defaults to the active provider when omitted. Returns an empty list for
/// providers whose CLI has no such command (Claude/Gemini) — the frontend falls back to its curated
/// list there.
#[tauri::command]
///
/// `account` lists what that account of the provider offers — a plan decides which models exist,
/// and Codex keeps its catalogue per account. An id that no longer exists lists the system one.
pub async fn list_ai_models(
    db: State<'_, Db>,
    provider: Option<String>,
    account: Option<String>,
) -> Result<Vec<String>, String> {
    let (engine, binary) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let provider = provider
            .filter(|p| !p.trim().is_empty())
            .map(Ok)
            .unwrap_or_else(|| active_provider(&conn))?;
        let explicit = match ai_accounts::Choice::parse(account.as_deref()) {
            ai_accounts::Choice::Auto => ai_accounts::Choice::System,
            other => other,
        };
        let engine = ai::engine_as(&provider, ai_accounts::resolve(&conn, &provider, None, None, explicit));
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

/// Checks whether `provider`'s CLI is actually installed, so Settings can show "available / not
/// found" instead of letting the user discover it when an action fails.
#[tauri::command]
pub async fn check_ai_provider(db: State<'_, Db>, provider: String) -> Result<ProviderStatus, String> {
    let binary = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let engine = ai::engine_for(&provider);
        queries::get_setting(&conn, &format!("{provider}_binary_path"))
            .map_err(|e| e.to_string())?
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| engine.default_binary().to_string())
    };
    let (available, detail) = ai::probe(&binary);
    Ok(ProviderStatus { available, detail, binary })
}

/// Proposes an AI-merged version of a conflicted file (from its base/ours/theirs index stages).
/// Returns the resolved file content as a string — nothing is written to disk here; the frontend
/// shows it for review and only writes + stages it once the user accepts.
#[tauri::command]
pub async fn resolve_conflict_with_ai(
    app: AppHandle,
    db: State<'_, Db>,
    repo_path: String,
    rel_path: String,
    run_id: Option<String>,
) -> Result<String, String> {
    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let workspace = ai_accounts::workspace_of_repo(&conn, &repo_path);
        let config = load_ai_config_in(&conn, AiTask::Conflict, workspace.as_deref())?;
        let template = shared_template(&conn, "resolve_conflict_template", "claude_resolve_conflict_template")?;
        (config, template)
    };
    let versions = git::merge::conflict_versions(&repo_path, &rel_path)?;
    ai_runs::scoped(app, run_id, async {
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
    })
    .await
}

#[tauri::command]
pub fn default_commit_template() -> String {
    ai::DEFAULT_COMMIT_TEMPLATE.to_string()
}

#[tauri::command]
pub fn default_analyze_template() -> String {
    ai::DEFAULT_ANALYZE_TEMPLATE.to_string()
}

#[tauri::command]
pub fn default_resolve_conflict_template() -> String {
    ai::DEFAULT_RESOLVE_CONFLICT_TEMPLATE.to_string()
}

/// The built-in prompt the CI failure analyser runs when `pipeline_template` is blank.
///
/// Added late: the setting has been honoured by `analyze_pipeline_failure` since that feature
/// shipped, but with no command exposing the default there was no way to build an editor for it —
/// so the one prompt about reading a build log was the one prompt nobody could change.
#[tauri::command]
pub fn default_pipeline_template() -> String {
    ai::DEFAULT_PIPELINE_TEMPLATE.to_string()
}

/// The built-in prompt behind "Rellenar con IA" when `sample_rows_template` is blank.
///
/// Worth having editable rather than fixed: this is the one prompt in the app whose *output* is
/// data about a domain, so "los nombres son chilenos", "los importes van en pesos" and "las fechas
/// son de 2024" are standing preferences rather than something to retype into the box every time.
#[tauri::command]
pub fn default_sample_rows_template() -> String {
    ai::DEFAULT_ROWS_PROMPT.to_string()
}

/// The built-in prompt behind «Resumen hablado» when `spoken_summary_template` is blank.
#[tauri::command]
pub fn default_spoken_summary_template() -> String {
    ai::SPOKEN_SUMMARY_PROMPT.to_string()
}

/// Snapshots the working tree before an AI action that can write to it, so the run is undoable.
/// Best-effort by design: a repo that can't be snapshotted (no HEAD yet, an unreadable index)
/// must not block the action the user actually asked for — they just don't get the undo button.
fn checkpoint_before(repo_path: &str, kind: &str) -> Option<String> {
    match git::checkpoint::create(repo_path, kind) {
        Ok(id) => Some(id),
        Err(e) => {
            eprintln!("checkpoint before '{kind}' failed: {e}");
            None
        }
    }
}

/// Discards a checkpoint whose run turned out to change nothing on disk — an "undo" that would
/// restore zero files is just clutter in the list.
fn checkpoint_after(repo_path: &str, checkpoint: Option<String>) {
    if let Some(id) = checkpoint {
        let _ = git::checkpoint::remove_if_unchanged(repo_path, &id);
    }
}

/// What [`analyze_working_changes`] fails with when there is nothing uncommitted to read — HEAD and
/// the working tree agree, staged or not. A prefix the frontend matches, the same way it matches
/// `ai_locks::BUSY_MARKER`.
pub const NOTHING_TO_ANALYZE_MARKER: &str = "NOTHING_TO_ANALYZE::";

/// Scans everything not yet committed — staged, unstaged and untracked alike (HEAD → working tree)
/// — for bugs and vulnerabilities before the user commits it. Folds in the same workspace-level
/// context/instructions/skills/MCPs as a PR review, just pointed at the local diff instead of a pull
/// request.
///
/// It used to read index → working tree only, so the moment right before a commit — everything
/// staged — was exactly when it had nothing to analyze.

#[tauri::command]
pub async fn analyze_working_changes(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
    job_id: String,
    // When an SDD/Harness agent runs this analysis, its provider + model + prompt for this run.
    agent_provider: Option<String>,
    agent_model: Option<String>,
    agent_prompt: Option<String>,
) -> Result<String, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    let workspace_id = project.workspace_id.clone();

    // Listed in the repository so a chat or a fix running beside it is told an analysis is reading
    // the tree. It reads, so it is not refused and it waits for nobody — see `ai_locks`.
    let _presence = ai_locks::enter(&project.local_path, "un análisis de los cambios sin commitear (solo lee)");

    let (contexts, skills, config, analyze_template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        // An active agent analyzes on its own provider + model; otherwise the Analyze routing.
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => load_ai_config_as(
                &conn,
                p,
                m,
                ai_accounts::Choice::Auto,
                Some(AiTask::Analyze),
                Some(&workspace_id),
            )?,
            _ => load_ai_config_in(&conn, AiTask::Analyze, Some(&workspace_id))?,
        };
        let analyze_template = shared_template(&conn, "analyze_template", "claude_analyze_template")?;
        (contexts, skills, config, analyze_template)
    };

    // Best-effort, same as the PR review path — a missing/unwritable skills dir shouldn't
    // block the analysis itself.
    let _ = sync_skills_into_project(&skills, &workspace_id, &project.local_path);

    let diff_files = git::diff::get_uncommitted_diff(&project.local_path, None)?;
    // An empty diff used to go to the engine anyway, which answered about nothing and left a red row
    // in the history. The buttons that start an analysis are off when there is nothing to read; this
    // is for a tree that emptied between the click and here — a commit from a terminal, a phone.
    // Refused before any engine starts and filed nowhere: nothing to analyze is not a failed run.
    if diff_files.is_empty() {
        return Err(NOTHING_TO_ANALYZE_MARKER.to_string());
    }
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    if let Some(prompt) = agent_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        enabled_contexts.insert(0, ("Agent".to_string(), prompt.to_string()));
    }


    // The job id doubles as the run id: the job row the UI already renders is exactly the thing
    // that should show this run's live output and its stop button.
    let result = ai_runs::scoped(app, Some(job_id.clone()), async {
        ai::analyze_changes(
            &*config.engine,
            &config.binary,
            &config.model,
            &enabled_contexts,
            &diff_text,
            &config.tools,
            &project.local_path,
            &analyze_template,
        )
        .await
    })
    .await;

    // A run the user stopped isn't history worth keeping: it has no result, and filing it as an
    // error would leave a permanent red row for something they did on purpose.
    if !matches!(&result, Err(e) if e.starts_with(ai_runs::CANCELLED_MARKER)) {
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
pub async fn resolve_finding_with_ai(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
    finding_prompt: String,
    run_id: Option<String>,
) -> Result<String, String> {
    resolve_finding_on(app, db, project_id, finding_prompt, run_id, None).await
}

/// [`resolve_finding_with_ai`] on a chosen engine — Flujos' "Resolver con IA".
pub(crate) async fn resolve_finding_on(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
    finding_prompt: String,
    run_id: Option<String>,
    engine: Option<(String, String)>,
) -> Result<String, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    // This one writes: it applies a fix to the working copy. Shared like every run (see `ai_locks`),
    // and told who else is in the checkout, the way a chat turn is.
    let presence = ai_locks::enter(&project.local_path, "una corrección automática de un hallazgo (edita archivos)");
    let finding_prompt = match ai::parallel_work_note(&presence.others()) {
        Some(note) => format!("{finding_prompt}{note}"),
        None => finding_prompt,
    };

    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        config_for(&conn, AiTask::Fix, Some(&project.workspace_id), engine.as_ref().map(|(p, m)| (p.as_str(), m.as_str())))?
    };

    let checkpoint = checkpoint_before(&project.local_path, "fix-finding");
    let result = ai_runs::scoped(app, run_id, async {
        ai::apply_finding_fix(&*config.engine, &config.binary, &config.model, &finding_prompt, &project.local_path)
            .await
    })
    .await;
    // Runs after failures and cancellations too: an agent killed mid-edit is exactly when a
    // half-applied fix needs undoing, so the checkpoint only goes away if nothing moved.
    checkpoint_after(&project.local_path, checkpoint);
    result
}

/// Drops a resume token that was minted by a *different* engine than the one about to run.
///
/// Session tokens aren't portable across providers. Every engine that resumes now hands back a real
/// id, and each namespaces it differently (a Claude UUID, an opencode `ses_…`, a Codex rollout
/// UUID, an agy conversation id); agy falls back to a fixed "continue your last run" sentinel only
/// when its CLI printed no id. Replaying any of them into a *different* engine
/// either fails outright (`claude --resume ses_abc`) or — worse — silently continues something
/// unrelated, answering with the wrong context. Returning `None` makes the turn open a fresh engine
/// session, which also re-sends the project context.
///
/// This is only about crossing *between* providers. Two conversations on the *same* provider are
/// kept apart by the engines themselves, by resuming a specific id rather than "the last run".
///
/// The model picker refuses to switch provider while a chat is open, so this is the backstop for
/// the paths it doesn't cover: routing edited in Settings, and a past conversation reopened after
/// its provider changed. Anything it can't determine (no recorded provider, a read that failed)
/// keeps the token — discarding a working session is the worse failure.
///
/// **The account counts as much as the provider.** A CLI keeps its sessions in its state
/// directory, and each account has its own (see `crate::ai_accounts`), so a token minted by the
/// work account is as foreign to the personal one as a Claude token is to Codex. The second value
/// says the token was dropped for that reason, which the panel turns into a notice.
fn session_for_engine(
    conn: &Connection,
    project_id: &str,
    conversation_id: Option<&str>,
    session_id: Option<String>,
    provider: &str,
    account_id: Option<&str>,
) -> (Option<String>, bool) {
    let Some(session_id) = session_id else { return (None, false) };
    let Some(conversation_id) = conversation_id else { return (Some(session_id), false) };
    match queries::last_turn_engine(conn, project_id, conversation_id) {
        Ok(Some((previous, _))) if previous != provider => (None, false),
        Ok(Some((_, previous_account))) if previous_account.as_deref() != account_id => (None, true),
        _ => (Some(session_id), false),
    }
}

/// Open-ended chat about the project — "preguntas abiertas del repositorio", the free-text
/// half of the AI panel alongside PR review and change analysis.
///
/// Two ids, deliberately separate:
/// - `session_id` is the *engine's* resume token: `None` for a brand new conversation, and
///   whatever the previous call returned afterwards, so the CLI carries the context forward.
/// - `conversation_id` is the *app's* identity for the conversation, minted by the frontend when
///   a chat starts and stable for its whole life. It's what turns group under in the activity
///   list. Leaving that to the engines never worked: Gemini/agy reports one fixed sentinel for
///   every run (so every chat ever collapsed into a single activity), while the Claude CLI can mint
///   a fresh id on each resumed turn (so one conversation could scatter into several).
/// - `agent_provider` / `agent_model` / `agent_prompt`: when an SDD/Harness agent is active, its
///   own provider + model + prompt for this turn — the role runs on its own routing and its
///   instructions frame the message. All absent → the normal per-task chat routing.
#[tauri::command]
pub async fn send_chat_message(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
    message: String,
    session_id: Option<String>,
    conversation_id: Option<String>,
    run_id: Option<String>,
    agent_provider: Option<String>,
    agent_model: Option<String>,
    agent_prompt: Option<String>,
    agent_account: Option<String>,
    stream: Option<bool>,
    skill: Option<crate::provider_skills::SkillPick>,
    attachments: Option<Vec<String>>,
) -> Result<ChatReply, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // Moved to the chat workspace (`chat_cmd::chat_move_from_panel`): it lives there now, and a
        // turn filed here under the same id would start a second copy of it. A phone, or a window
        // that had not heard yet, still has it open.
        if let Some(id) = conversation_id.as_deref() {
            if crate::db::chat_queries::get_conversation(&conn, id).map_err(|e| e.to_string())?.is_some() {
                return Err("Esta conversación se movió al Chat.".to_string());
            }
        }
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    let workspace_id = project.workspace_id.clone();

    // One turn per *conversation*, taken before anything else happens: a phone and the desk asking in
    // the same thread at once would resume one engine session twice. Refusing here — before the
    // checkpoint, before the CLI — is what makes it a free retry (the frontend waits on the marker).
    // The repository itself is shared: other conversations, analyses and fixes run beside this one,
    // and this turn is told about them below (see `ai_locks`).
    let _turn_lease = match conversation_id.as_deref() {
        Some(id) => Some(
            ai_locks::acquire_key(&format!("panel::{id}"))
                .ok_or_else(|| format!("{}{}", ai_locks::BUSY_MARKER, project.name))?,
        ),
        None => None,
    };
    // The chain step this run id is bound to, if any. The claim recorded it on the step before the
    // run existed, so nothing a webview sends can move a turn out of its step's phase.
    let step = match run_id.as_deref() {
        Some(id) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            hybrid_queries::running_step(&conn, id).map_err(|e| e.to_string())?
        }
        None => None,
    };
    // A hybrid run's execute step is not an engine turn: this app walks the plan on the local model.
    // Same lease, same run id, one `activity_log` row — see `run_hybrid_execute`.
    if let Some(step) = step.as_ref().filter(|s| s.kind == "hybrid" && s.phase == "execute") {
        return run_hybrid_execute(app, &db, &project, conversation_id, run_id, message, step).await;
    }
    // `local-exec` names that step, never an engine anybody can talk to.
    if agent_provider.as_deref() == Some("local-exec") {
        return Err("This task is a step of a hybrid run; it runs from its chain.".to_string());
    }
    let presence = ai_locks::enter(&project.local_path, &ai::chat_presence_label(&message));
    // What a hybrid plan or review takes from its run: the run's other repositories, handed to the
    // CLI as extra directories, and whether this review round answers in the review's JSON.
    let (extra_dirs, review_json) = match step.as_ref().filter(|s| s.kind == "hybrid" && s.phase != "execute") {
        Some(s) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let repos = hybrid_queries::chain_repo_refs(&conn, &s.chain_id).unwrap_or_default();
            let extra: Vec<String> = repos.iter().skip(1).map(|repo| repo.path.clone()).filter(|path| !path.is_empty()).collect();
            let review_json = s.phase == "review"
                && hybrid_queries::get_run(&conn, &s.chain_id)
                    .ok()
                    .flatten()
                    .is_some_and(|run| run.review_mode == "local" && run.fix_round < crate::hybrid::prompts::MAX_FIX_ROUNDS);
            (extra, review_json)
        }
        None => (Vec::new(), false),
    };

    let (contexts, skills, config, session_id, analysis) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // Read-only wherever the step promises to write nothing: a story's analysis pass, a hybrid
        // run's plan, its review when the run asked for a report only, and a round of the local fix
        // loop with no task of the review's own to implement. Each promise used to be a sentence in
        // an instruction; here the CLI enforces it. See `chat_with_repo`.
        let analysis = match step.as_ref() {
            Some(s) if s.kind == "story" => s.phase == "analyze",
            Some(s) if s.kind == "hybrid" && s.phase == "plan" => true,
            Some(s) if s.kind == "hybrid" && s.phase == "review" => hybrid_queries::get_run(&conn, &s.chain_id)
                .ok()
                .flatten()
                .is_some_and(|run| {
                    run.review_mode == "report"
                        || (review_json
                            && hybrid_queries::list_items(&conn, &s.chain_id)
                                .is_ok_and(|items| crate::hybrid::prompts::for_review(&run, &items).is_empty()))
                }),
            _ => false,
        };
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        // An active agent runs on its own provider + model — and its own account, when it names
        // one; otherwise the normal chat routing. Either way an automatic account is this
        // repository's workspace's.
        //
        // A provider with no model is an engine pinned by the panel's chip on a conversation whose
        // answers named none — the CLI's own default — and is honoured as such rather than dropped
        // back to the routing, which would move the conversation to another engine behind its back.
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), m) if !p.trim().is_empty() => load_ai_config_as(
                &conn,
                p,
                m.unwrap_or("").trim(),
                ai_accounts::Choice::parse(agent_account.as_deref()),
                Some(AiTask::Chat),
                Some(&workspace_id),
            )?,
            _ => load_ai_config_in(&conn, AiTask::Chat, Some(&workspace_id))?,
        };
        // A `/clear` nothing has been asked since — typed here, in another window or on a phone, and
        // kept on disk — promised this question a fresh session, whatever session the caller holds.
        let session_id = match conversation_id.as_deref() {
            Some(id) if queries::conversation_reset_pending(&conn, &project_id, id).unwrap_or(false) => None,
            _ => session_id,
        };
        // A hybrid review resumes the planner's own session — the one that already read the
        // repository — when it runs on the same engine and account. Read here rather than handed in,
        // because the frontend's copy of a task's session does not survive a reload.
        let session_id = match (session_id, step.as_ref()) {
            (None, Some(s)) if s.kind == "hybrid" && s.phase == "review" => hybrid_queries::plan_session(&conn, &s.chain_id)
                .ok()
                .flatten()
                .filter(|(_, provider, account)| provider == &config.provider && account.as_deref() == config.account_id())
                .map(|(session, _, _)| session),
            (session, _) => session,
        };
        // Shadows the argument on purpose: nothing below should see the unvalidated token, and the
        // turn is recorded against the session it actually ran under.
        let (session_id, account_changed) = session_for_engine(
            &conn,
            &project_id,
            conversation_id.as_deref(),
            session_id,
            &config.provider,
            config.account_id(),
        );
        (contexts, skills, config, (session_id, account_changed), analysis)
    };
    let (session_id, account_changed) = session_id;

    let _ = sync_skills_into_project(&skills, &workspace_id, &project.local_path);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    // The active agent's own instructions go first, so the role frames the whole turn.
    if let Some(prompt) = agent_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        enabled_contexts.insert(0, ("Agent".to_string(), prompt.to_string()));
    }


    // Images attached in the composer, resolved from ids to the copies this conversation owns —
    // never a path from the frontend (see `chat_attach`). One that has gone missing is dropped
    // rather than failing the turn, as in the chat workspace. They are named in the question itself,
    // the same note `chat_send` writes, so a reopened conversation still shows what went with it,
    // and the engine reads them with its own tool (Claude) or takes them as images (`codex -i`).
    let attachments: Vec<ai::AiAttachment> = match (conversation_id.as_deref(), attachments) {
        (Some(conversation), Some(ids)) if !ids.is_empty() => {
            let stored = super::chat_attach::repo_conversation_attachments(conversation);
            ids.iter()
                .filter_map(|id| stored.iter().find(|file| &file.id == id))
                .map(|file| ai::AiAttachment { path: file.path.clone(), name: file.name.clone(), is_image: file.is_image })
                .collect()
        }
        _ => Vec::new(),
    };
    // The user's own words, kept for the conversation's title: the note below names files, not the
    // topic.
    let asked = message.clone();
    let message = match attachments.is_empty() {
        true => message,
        false => format!("{message}{}", ai::attachment_note(&attachments)),
    };

    // A skill picked in the composer goes to the engine, never into the stored question — see
    // `provider_skills::instruction`. An app skill is pointed at its copy synced into this checkout
    // above, which is always under `.claude/skills` in a repository.
    let engine_message = match skill.as_ref().filter(|pick| !pick.name.trim().is_empty()) {
        Some(pick) => {
            let local = (pick.source == "app").then(|| format!(".claude/skills/{}/SKILL.md", pick.name.trim()));
            format!(
                "{message}\n\n{}",
                crate::provider_skills::instruction(&config.provider, pick, local.as_deref())
            )
        }
        None => message.clone(),
    };
    // Who else is working in this checkout right now — told to the engine, never stored. Read once,
    // at the start: a run that starts later is told about this one instead.
    let engine_message = match ai::parallel_work_note(&presence.others()) {
        Some(note) => format!("{engine_message}{note}"),
        None => engine_message,
    };
    // Claude Code denies, in `-p`, any tool nobody pre-approved, and `Skill` is the one that opens a
    // skill — so the panel's chat has it whatever the saved tool list says, as the free chat does.
    let mut tools = config.tools.clone();
    if config.provider == "claude" && !tools.iter().any(|tool| tool == "Skill") {
        tools.push("Skill".to_string());
    }
    // The user's own MCP servers, as switched for this repository in the panel — see
    // `crate::chat_mcp`. A story's read-only analysis loads none, so it plans none.
    let turn_mcp = if analysis {
        // A story's analysis promises to write nothing; on Codex that includes its own servers.
        let block = if config.provider == "codex" {
            let env = config.engine.account().cloned().unwrap_or_else(|| ai_accounts::AccountEnv::system(&config.provider));
            crate::chat_mcp::codex_read_only_block(&config.binary, &env).await
        } else {
            Vec::new()
        };
        crate::chat_mcp::TurnMcp { block, ..Default::default() }
    } else {
        let overrides = db
            .0
            .lock()
            .ok()
            .and_then(|conn| queries::get_setting(&conn, &crate::chat_mcp::panel_setting_key(&project_id)).ok().flatten())
            .unwrap_or_default();
        let env = config.engine.account().cloned().unwrap_or_else(|| ai_accounts::AccountEnv::system(&config.provider));
        crate::commands::chat_cmd::mcp_plan(&db, &workspace_id, &config.provider, &config.binary, &env, &overrides).await
    };
    tools.extend(turn_mcp.allow_rules.iter().cloned());

    // Timed around the engine call only, so it reflects how long the model actually took —
    // not the surrounding DB reads or IPC.
    let started = std::time::Instant::now();
    // The chat runs with edits auto-approved (see `chat_with_repo`), so it can and does touch
    // files — it gets the same undo protection as an explicit "fix with AI". A story's analysis
    // pass keeps it too: on an engine that cannot enforce read-only, the checkpoint is what is left
    // if the model writes anyway.
    let checkpoint = checkpoint_before(&project.local_path, "chat");
    // The reply as it is written, for the panel that asked (Claude alone produces it; every other
    // engine ignores the sink). Keyed by run: the panel matches fragments on the run id it minted.
    let stream_deltas = stream.unwrap_or(false).then(|| ai::DeltaSink {
        conversation_id: conversation_id.clone().unwrap_or_default(),
        message_id: run_id.clone().unwrap_or_default(),
    });
    // Kept for the title run below; `app` moves into the run's scope.
    let title_app = app.clone();
    let (result, trace) = ai_runs::scoped_with_trace(app, run_id, async {
        ai::chat_with_repo(
            &*config.engine,
            &config.binary,
            &config.model,
            &enabled_contexts,
            &engine_message,
            session_id.as_deref(),
            &tools,
            &project.local_path,
            stream_deltas,
            analysis,
            turn_mcp.block.clone(),
            turn_mcp.app.clone(),
            &attachments,
            // A hybrid plan's answer must be the plan's JSON, and a round of the local fix loop the
            // review's; the CLIs that can enforce a schema do.
            step.as_ref().filter(|s| s.kind == "hybrid").and_then(|s| match s.phase.as_str() {
                "plan" => Some(crate::hybrid::plan::PLAN_SCHEMA),
                "review" if review_json => Some(crate::hybrid::plan::REVIEW_SCHEMA),
                _ => None,
            }),
            &extra_dirs,
        )
        .await
    })
    .await;
    let response_time_ms = started.elapsed().as_millis() as i64;
    checkpoint_after(&project.local_path, checkpoint);
    // Read after the run, not before: it's cached per binary, so only the very first turn of an
    // app session pays for the probe, and it never sits between the user pressing send and the
    // engine starting.
    let engine_version = ai::engine_version(&config.binary).await;
    // Kept with the turn so the answer can still show *how* it was reached — which files were
    // read, which commands ran — long after the live log is gone.
    let trace_json = (!trace.is_empty()).then(|| serde_json::to_string(&trace).unwrap_or_default());

    // Every turn files under the conversation the frontend named. The fallback only matters for
    // a caller that didn't supply one (an older frontend): it mints a throwaway id so the turn is
    // still recorded, as its own single-turn activity, rather than silently lost.
    let named_conversation = conversation_id.is_some();
    let conversation_id =
        conversation_id.unwrap_or_else(|| format!("conv-{}", uuid::Uuid::new_v4()));

    let run = match result {
        Ok(run) => run,
        Err(e) => {
            // A run the user stopped isn't history: it has no answer, and filing it would leave
            // a permanent failed turn in the transcript for something they did on purpose.
            if !e.starts_with(ai_runs::CANCELLED_MARKER) {
                // Record other failures. Otherwise the panel's error vanishes the moment the next
                // message is sent, and days later there's nothing left explaining why a run died
                // (out of credit, CLI gone).
                if let Ok(conn) = db.0.lock() {
                    let _ = queries::add_activity_log(
                        &conn,
                        &project_id,
                        &conversation_id,
                        session_id.as_deref(),
                        &message,
                        &e,
                        trace_json.as_deref(),
                        // A failed turn has no model to report (the CLI never got that far), but
                        // *which* engine and version failed is exactly what makes it diagnosable.
                        queries::TurnMeta {
                            provider: Some(&config.provider),
                            account_id: config.account_id(),
                            model: None,
                            engine_version: engine_version.as_deref(),
                            response_time_ms: Some(response_time_ms),
                        },
                        true,
                    );
                }
            }
            return Err(e);
        }
    };

    // A hybrid run counts what its subscription turns spent, for the summary it ends with.
    if let (Some(s), Some(usage)) = (step.as_ref().filter(|s| s.kind == "hybrid"), run.usage.as_ref()) {
        if let Ok(conn) = db.0.lock() {
            let _ = hybrid_queries::add_step_usage(
                &conn,
                &s.chain_id,
                &s.phase,
                usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens,
                usage.output_tokens,
            );
        }
    }

    let (created_at, wants_title) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let created_at = queries::add_activity_log(
            &conn,
            &project_id,
            &conversation_id,
            run.session_id.as_deref(),
            &message,
            &run.text,
            trace_json.as_deref(),
            queries::TurnMeta {
                provider: Some(&config.provider),
                account_id: config.account_id(),
                model: run.model.as_deref(),
                engine_version: engine_version.as_deref(),
                response_time_ms: Some(response_time_ms),
            },
            false,
        )
        .map(|entry| entry.created_at)
        // The reply is already in hand; a failed *write* shouldn't cost the user their answer, so
        // the turn is still returned — just stamped with the time it arrived rather than the time
        // it was filed.
        .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
        // Its first answer: the conversation is named after what was asked — see `chat_title`. Not
        // an agent task's, which the Agents view names, nor a turn filed under a throwaway id.
        let wants_title = named_conversation
            && !conversation_id.starts_with(queries::AGENT_CONVERSATION_PREFIX)
            && queries::conversation_awaits_title(&conn, &project_id, &conversation_id).unwrap_or(false);
        (created_at, wants_title)
    };
    if wants_title {
        crate::chat_title::spawn(
            &title_app,
            Some(workspace_id.clone()),
            asked,
            crate::chat_title::Target::Panel { project_id: project_id.clone(), conversation_id: conversation_id.clone() },
        );
    }

    let account_id = config.account_id().map(str::to_string);
    Ok(ChatReply {
        text: run.text,
        session_id: run.session_id,
        model: run.model,
        provider: config.provider,
        engine_version,
        created_at,
        response_time_ms,
        account_id,
        account_changed,
    })
}

/// A hybrid run's execute step, as the turn it is to everything around it: run under the claimed run
/// id (so Stop, the run card and the status bar work), filed as exactly one `activity_log` row —
/// the report when it finishes, the error when it fails, nothing when it is stopped — because that
/// row, found by its position, is how a restart learns how the step ended. See `crate::hybrid`.
async fn run_hybrid_execute(
    app: AppHandle,
    db: &State<'_, Db>,
    project: &crate::db::models::Project,
    conversation_id: Option<String>,
    run_id: Option<String>,
    message: String,
    step: &hybrid_queries::RunningStep,
) -> Result<ChatReply, String> {
    let (model, repos) = db
        .0
        .lock()
        .ok()
        .map(|conn| {
            let model = hybrid_queries::get_run(&conn, &step.chain_id).ok().flatten().map(|run| run.model).unwrap_or_default();
            let repos = hybrid_queries::chain_repo_refs(&conn, &step.chain_id).unwrap_or_default();
            (model, repos)
        })
        .unwrap_or_default();
    // A run created before chains kept their repositories still has the step's own.
    let repos = if repos.is_empty() {
        vec![crate::hybrid::plan::RepoRef {
            project_id: project.id.clone(),
            name: project.name.clone(),
            path: project.local_path.clone(),
        }]
    } else {
        repos
    };
    let started = std::time::Instant::now();
    let job_app = app.clone();
    let (result, trace) = ai_runs::scoped_with_trace(app, run_id, async {
        crate::hybrid::execute::run(crate::hybrid::execute::Job {
            app: &job_app,
            db,
            chain_id: &step.chain_id,
            repos: &repos,
        })
        .await
    })
    .await;
    let response_time_ms = started.elapsed().as_millis() as i64;
    let trace_json = (!trace.is_empty()).then(|| serde_json::to_string(&trace).unwrap_or_default());
    let conversation_id = conversation_id.unwrap_or_else(|| format!("conv-{}", uuid::Uuid::new_v4()));
    fn meta(model: &str, response_time_ms: i64) -> queries::TurnMeta<'_> {
        queries::TurnMeta {
            provider: Some("local-exec"),
            account_id: None,
            model: (!model.is_empty()).then_some(model),
            engine_version: None,
            response_time_ms: Some(response_time_ms),
        }
    }
    match result {
        Err(e) => {
            if !e.starts_with(ai_runs::CANCELLED_MARKER) {
                if let Ok(conn) = db.0.lock() {
                    let _ = queries::add_activity_log(
                        &conn,
                        &project.id,
                        &conversation_id,
                        None,
                        &message,
                        &e,
                        trace_json.as_deref(),
                        meta(&model, response_time_ms),
                        true,
                    );
                }
            }
            Err(e)
        }
        Ok(report) => {
            let created_at = {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                queries::add_activity_log(
                    &conn,
                    &project.id,
                    &conversation_id,
                    None,
                    &message,
                    &report,
                    trace_json.as_deref(),
                    meta(&model, response_time_ms),
                    false,
                )
                .map(|entry| entry.created_at)
                .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339())
            };
            Ok(ChatReply {
                text: report,
                session_id: None,
                model: (!model.is_empty()).then_some(model),
                provider: "local-exec".to_string(),
                engine_version: None,
                created_at,
                response_time_ms,
                account_id: None,
                account_changed: false,
            })
        }
    }
}

/// Rewrites the selected code according to a natural-language instruction, for the editor's
/// inline edit. Returns the replacement text only — nothing is written to disk here; the editor
/// applies it to its buffer, so it's undoable and the user still decides whether to save.
#[tauri::command]
pub async fn inline_edit_with_ai(
    app: AppHandle,
    db: State<'_, Db>,
    rel_path: String,
    file_content: String,
    selection: String,
    instruction: String,
    run_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        load_ai_config_in(&conn, AiTask::Inline, workspace_id.as_deref())?
    };
    ai_runs::scoped(app, run_id, async {
        ai::inline_edit(
            &*config.engine,
            &config.binary,
            &config.model,
            &rel_path,
            &file_content,
            &selection,
            &instruction,
        )
        .await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    /// The three engines whose read-only mode their CLI enforces, and only those — the list the UI
    /// uses to decide between promising "text only" and saying it is a request.
    #[test]
    fn only_engines_that_enforce_read_only_are_reported() {
        assert_eq!(ai_read_only_engines(), vec!["claude", "codex", "grok"]);
    }

    /// The command is the classifier itself, not a second copy of it.
    #[test]
    fn the_classifier_command_answers_like_the_classifier() {
        let failure = ai_classify_failure("QUOTA_EXCEEDED::You've hit your weekly limit · resets Mon 9am".into());
        assert_eq!(failure.kind, ai::AiFailureKind::Quota);
        assert_eq!(failure.resets.as_deref(), Some("Mon 9am"));
    }

    /// The meetings row says nothing until it is set: it writes with whatever engine and model the
    /// notes row names — and a model picked on the meetings row alone (its provider still inherited)
    /// is the one used.
    #[test]
    fn the_meetings_row_follows_the_notes_row_until_it_says_otherwise() {
        let conn = install();
        queries::set_setting(&conn, "ai_provider_notes", "codex").unwrap();
        queries::set_setting(&conn, "codex_notes_model", "gpt-notes").unwrap();
        let config = load_ai_config_in(&conn, AiTask::Meetings, None).unwrap();
        assert_eq!((config.provider.as_str(), config.model.as_str()), ("codex", "gpt-notes"));
        queries::set_setting(&conn, "codex_meetings_model", "gpt-meetings").unwrap();
        let config = load_ai_config_in(&conn, AiTask::Meetings, None).unwrap();
        assert_eq!((config.provider.as_str(), config.model.as_str()), ("codex", "gpt-meetings"));
        queries::set_setting(&conn, "ai_provider_meetings", "claude").unwrap();
        assert_eq!(load_ai_config_in(&conn, AiTask::Meetings, None).unwrap().provider, "claude");
    }

    /// A fresh install routes everything to Claude without any setting being written, so the panel
    /// has something to show on first run. Nothing else is asked — an untouched machine with five
    /// CLIs installed must not spend five reads (and, on macOS, a keychain prompt) on four engines
    /// it has never sent a turn to.
    #[test]
    fn an_untouched_install_routes_to_claude_alone() {
        let routed = routed_providers(&install()).unwrap();
        assert_eq!(routed, ["claude".to_string()].into_iter().collect());
    }

    /// The set is the global default *plus* every per-task override — not just the default. An
    /// engine handling only PR review still has a plan that can run out, and that is exactly the
    /// event the panel exists to show.
    #[test]
    fn per_task_overrides_join_the_global_default() {
        let conn = install();
        queries::set_setting(&conn, "ai_provider", "claude").unwrap();
        queries::set_setting(&conn, "ai_provider_review", "codex").unwrap();
        queries::set_setting(&conn, "ai_provider_commit", "cline").unwrap();

        let routed = routed_providers(&conn).unwrap();
        assert_eq!(
            routed,
            ["claude", "codex", "cline"].map(String::from).into_iter().collect()
        );
    }

    /// Blank is unset, matching `provider_for`: clearing a row in the UI means "inherit", and the
    /// inherited value is the global default that is already in the set. Reading it literally would
    /// put an empty provider id in the set, which matches no engine and is asked for nothing — a
    /// silent no-op that is only ever confusing.
    #[test]
    fn a_blank_override_inherits_rather_than_adding_nothing() {
        let conn = install();
        queries::set_setting(&conn, "ai_provider", "gemini").unwrap();
        queries::set_setting(&conn, "ai_provider_chat", "   ").unwrap();

        let routed = routed_providers(&conn).unwrap();
        assert_eq!(routed, ["gemini".to_string()].into_iter().collect());
    }

    /// A cleared global falls back to Claude rather than emptying the set — the quota panel going
    /// blank because a settings row was reset would read as "you have no limits", which is the one
    /// thing it must never say wrongly.
    #[test]
    fn a_cleared_global_still_routes_somewhere() {
        let conn = install();
        queries::set_setting(&conn, "ai_provider", "").unwrap();
        assert!(routed_providers(&conn).unwrap().contains("claude"));
    }
}
