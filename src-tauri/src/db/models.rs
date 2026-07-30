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
