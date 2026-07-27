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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMdFile {
    pub id: String,
    pub workspace_id: String,
    pub filename: String,
    pub content: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSkill {
    pub id: String,
    pub workspace_id: String,
    pub skill_name: String,
    pub source_repo: String,
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
