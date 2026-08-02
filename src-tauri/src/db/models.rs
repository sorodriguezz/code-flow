use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub local_path: String,
    pub remote_url: Option<String>,
    pub color: String,
    pub icon: String,
    pub ado_org: Option<String>,
    pub ado_project: Option<String>,
    pub ado_repo_id: Option<String>,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
    pub github_host: Option<String>,
    /// The project's full path including every group it is nested under
    /// (`acme/backend/services/auth`) — GitLab has no "owner/repo" split to store.
    pub gitlab_project: Option<String>,
    pub gitlab_host: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProject {
    pub workspace_id: String,
    pub name: String,
    pub local_path: String,
    pub remote_url: Option<String>,
    pub color: String,
    pub icon: String,
    #[serde(default)]
    pub ado_org: Option<String>,
    #[serde(default)]
    pub ado_project: Option<String>,
    #[serde(default)]
    pub ado_repo_id: Option<String>,
    #[serde(default)]
    pub github_owner: Option<String>,
    #[serde(default)]
    pub github_repo: Option<String>,
    #[serde(default)]
    pub github_host: Option<String>,
    #[serde(default)]
    pub gitlab_project: Option<String>,
    #[serde(default)]
    pub gitlab_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewContext {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub content: String,
    pub enabled: bool,
    pub created_at: String,
}

/// A saved PR-review run as listed in the memory manager — the slim projection (no heavy
/// review/diff text), joined with the project name for display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewRunSummary {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub pr_id: i64,
    pub pr_title: String,
    pub iter: i64,
    pub level: String,
    pub findings_count: i64,
    pub created_at: String,
}

/// The full content of one saved review run, for the in-app viewer / export.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewRunDetail {
    pub id: String,
    pub project_id: String,
    pub pr_id: i64,
    pub iter: i64,
    pub level: String,
    pub meta: String,
    pub review_md: String,
    pub diff: String,
    pub findings: String,
    pub created_at: String,
}

/// A user-defined SDD/Harness agent (role) — name, role description, its model, an optional
/// prompt, and an on/off toggle. Empty by default; the user builds their own roster.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceAgent {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub role: String,
    pub provider: String,
    pub model: String,
    pub prompt: String,
    pub enabled: bool,
    pub sort_order: i64,
    pub created_at: String,
}

/// One agent task: a goal handed to a roster agent and worked on against one repository. The
/// turns themselves are `activity_log` rows sharing `conversation_id`; this row is the task's
/// identity and its overall state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTask {
    pub id: String,
    pub workspace_id: String,
    pub project_id: String,
    /// The roster row this came from, or `""` once that agent has been deleted.
    pub agent_id: String,
    /// Snapshot of the agent's name at creation, so a deleted agent still reads as itself.
    pub agent_name: String,
    pub provider: String,
    pub model: String,
    pub prompt: String,
    pub goal: String,
    pub title: String,
    pub conversation_id: String,
    /// `draft` | `running` | `idle` | `done` | `error` | `cancelled`.
    pub status: String,
    pub turns: i64,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// An ordered plan of agent steps against one repository. The steps' turns are ordinary agent
/// tasks; this row is the plan's identity and the scheduler's whole state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChain {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub goal: String,
    /// `queued` | `running` | `gated` | `paused` | `failed` | `done` | `aborted`.
    pub status: String,
    pub current_step: i64,
    pub step_count: i64,
    /// A translation key (`chain.interrupted`, `chain.repoBusy`, …) or a raw engine error.
    pub last_reason: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One step of a chain. The agent's identity and routing are snapshotted at creation — see the
/// table's comment in `migrations.rs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChainStep {
    pub id: String,
    pub chain_id: String,
    pub step_index: i64,
    pub agent_id: String,
    pub agent_name: String,
    pub provider: String,
    pub model: String,
    pub prompt: String,
    pub instruction: String,
    pub gate: bool,
    pub gate_cleared: bool,
    pub pending_input: String,
    pub task_id: String,
    pub run_id: String,
    pub log_count_at_dispatch: i64,
    pub output_text: String,
    pub output_truncated: bool,
    /// `pending` | `running` | `done` | `error` | `interrupted` | `skipped`.
    pub status: String,
    pub attempts: i64,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One step as the frontend authors it, before anything is snapshotted or persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewChainStep {
    pub agent_id: String,
    pub instruction: String,
    pub gate: bool,
}

/// What [`queries::claim_next_chain_step`] hands back: the chain as it now stands, plus — only
/// when it decided a step must actually run — the task to run it against and the exact message.
///
/// Deliberately one type with an optional payload rather than an enum: the caller must apply the
/// chain state on *every* outcome, and an enum invites handling only the interesting arm.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainClaim {
    pub chain: AgentChain,
    /// `run` when there is work to dispatch, `idle` when the claim decided otherwise (gated,
    /// finished, failed, or the chain was not queued to begin with).
    pub kind: String,
    pub task: Option<AgentTask>,
    pub step: Option<AgentChainStep>,
    pub message: String,
}

/// A chain and its steps, for the detail pane.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainDetail {
    pub chain: AgentChain,
    pub steps: Vec<AgentChainStep>,
}

/// A reusable chain plan. Configuration, not history — see the table comment in `migrations.rs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainTemplate {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub description: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Always loaded with the template: a plan with its steps withheld is not a plan.
    pub steps: Vec<ChainTemplateStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainTemplateStep {
    pub id: String,
    pub template_id: String,
    pub step_index: i64,
    /// Named, never snapshotted: a template is meant to follow the roster.
    pub agent_id: String,
    pub instruction: String,
    pub gate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSkill {
    pub id: String,
    pub workspace_id: String,
    pub skill_name: String,
    pub source_repo: String,
    pub enabled: bool,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityLogEntry {
    pub id: String,
    pub project_id: String,
    /// The **conversation** this turn belongs to — app-minted and stable for the conversation's
    /// whole life. Not the engine's session token; see `engine_session_id`.
    pub session_id: Option<String>,
    /// The engine's own resume token for this turn, when it reported one. Only used to carry a
    /// reopened conversation forward on the CLI's side.
    pub engine_session_id: Option<String>,
    pub question: String,
    pub answer: String,
    /// What the engine printed while working on this turn, as a JSON array of
    /// `{stream, line}` — `None` for turns recorded before traces were kept.
    pub trace: Option<String>,
    pub created_at: String,
    /// How long the engine took to answer this turn, in milliseconds. `None` for turns recorded
    /// before this was tracked.
    pub response_time_ms: Option<i64>,
    /// Provider id this turn ran through (`claude`, `codex`, …). Recorded per turn rather than
    /// read from the setting at display time, because the setting is a *current* choice — a
    /// conversation reopened later would otherwise claim to have run on whatever is configured
    /// now. `None` for turns recorded before this was tracked.
    pub provider: Option<String>,
    /// Model the CLI reported for this turn, for the same reason as `provider`.
    pub model: Option<String>,
    /// Version of the engine CLI that answered this turn.
    pub engine_version: Option<String>,
    /// Whether this turn failed — `answer` then holds the engine's error rather than a reply, so
    /// a run that died (out of credit, CLI missing) is still there tomorrow.
    pub is_error: bool,
}

/// A finished PR review or pre-commit analysis run — `meta` is a small JSON blob (e.g.
/// `{"prId": 123}`) rather than its own columns, since it varies by `kind` and nothing
/// queries into it at the SQL level.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobHistoryEntry {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub label: String,
    /// A user-given rename, taking priority over `label` (and over whatever the frontend
    /// would otherwise auto-derive, e.g. the PR title) when set.
    pub custom_label: Option<String>,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub meta: String,
    pub created_at: String,
}

/// The repo-less twin of [`JobHistoryEntry`]: a PR review (or a decision taken on it) that ran
/// from a link alone, filed against the workspace it ran in because there is no project to file
/// it against. Same shape on purpose — the frontend folds both into the one Activity list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceActivityEntry {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub label: String,
    pub custom_label: Option<String>,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    /// Carries everything needed to reopen the review without the link being pasted again:
    /// `prUrl`, `repoLabel`, `cloneUrl` and a snapshot of the pull request itself.
    pub meta: String,
    pub created_at: String,
}

/// One row per Claude Code `session_id` seen in `activity_log` for a project — the
/// conversation-level view the "Chat history" sidebar/modal actually lists, as opposed to
/// the individual question/answer turns underneath it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatConversationSummary {
    pub session_id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub turn_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMcp {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub command: String,
    /// Space-separated args, same convention as the shell — kept as plain text rather than
    /// a JSON array so the settings UI can just be a single text input.
    pub args: String,
    /// `KEY=value` pairs, one per line.
    pub env: String,
    pub enabled: bool,
    pub created_at: String,
}

// ===================== API client (per workspace) =====================
//
// These mirror `src/types/api.ts` one-for-one. Everything editable about a request travels in
// the `spec` JSON string rather than in typed fields — the backend never interprets it, it only
// stores and returns it, so a new protocol or auth scheme is a frontend-only change.
//
// Only the roots carry `workspace_id`; folders and requests reach it through their collection.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiCollection {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub description: String,
    /// JSON `AuthConfig`, or `""` when nothing is configured.
    pub auth: String,
    pub pre_script: String,
    pub post_script: String,
    /// JSON `ApiVariable[]`.
    pub variables: String,
    pub sort_order: i64,
    /// Sorts above the unpinned ones in the explorer, ahead of `sort_order`.
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiFolder {
    pub id: String,
    pub collection_id: String,
    /// `None` = directly under the collection.
    pub parent_id: Option<String>,
    pub name: String,
    pub description: String,
    pub auth: String,
    pub pre_script: String,
    pub post_script: String,
    pub sort_order: i64,
    pub created_at: String,
    /// Defaulted so a payload written by an older build still deserialises; the migration
    /// backfills stored rows from their `created_at`.
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiRequestRow {
    pub id: String,
    pub collection_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub method: String,
    pub url: String,
    /// JSON `ApiRequestSpec`.
    pub spec: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// The whole tree in one round trip — the UI rebuilds nesting client-side from the parent ids,
/// which is cheaper than three chatty queries per expand.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiTree {
    pub collections: Vec<ApiCollection>,
    pub folders: Vec<ApiFolder>,
    pub requests: Vec<ApiRequestRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEnvironment {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    /// JSON `ApiVariable[]`.
    pub variables: String,
    pub is_global: bool,
    pub sort_order: i64,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiHistoryEntry {
    pub id: String,
    pub workspace_id: String,
    pub request_id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub method: String,
    pub url: String,
    pub status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub size_bytes: Option<i64>,
    /// JSON `{ request, response }`.
    pub snapshot: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiCookie {
    pub id: String,
    pub workspace_id: String,
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: String,
    pub secure: bool,
    pub http_only: bool,
    pub expires: Option<String>,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Database workspace
// ---------------------------------------------------------------------------

/// A saved database connection.
///
/// `spec` is the JSON the driver layer deserializes into a `datasource::DbConnectionConfig`, minus
/// the password — that lives in the OS keychain, so this row can be read by anything that can read
/// the config file without leaking a credential.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbConnectionRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub kind: String,
    pub spec: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A saved SQL (or Mongo) console, bound to one connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbConsole {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub body: String,
    pub database_name: String,
    pub schema_name: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// One statement that ran. `error` is empty on success.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbQueryHistoryEntry {
    pub id: String,
    pub workspace_id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub statement: String,
    pub database_name: String,
    pub duration_ms: i64,
    pub row_count: i64,
    pub error: String,
    pub ran_at: String,
}

/// Everything the database workspace needs on load, in one round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbWorkspaceTree {
    pub connections: Vec<DbConnectionRow>,
    pub consoles: Vec<DbConsole>,
}
