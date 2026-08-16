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

/// A folder the user files agent work into. Not a repository: a task still names the `Project` its
/// turns run in, and this only says where the user put it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProject {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// One shell on the agent console's terminal bench.
///
/// The row is what survives; the shell is not. A pty belongs to the process that opened it, so
/// closing the app ends every one of them — what is kept is enough to put the same shell back in
/// the same directory (`cwd`, `profile_id`) with everything it had already said still on screen
/// (`transcript`).
/// One tab of the agent console's terminal bench, and the arrangement of shells inside it.
///
/// `layout` is a JSON binary tree over this tab's terminal ids — opaque here on purpose. The
/// backend keeps it and never walks it; the only place it means anything is `lib/bench/layout.ts`,
/// which is also where a tree that fails to parse or names a deleted terminal is repaired.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchTab {
    pub id: String,
    pub workspace_id: String,
    /// Empty until the user renames it, in which case the bench names it after its shells.
    pub title: String,
    pub layout: String,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTerminal {
    pub id: String,
    pub workspace_id: String,
    /// Which [`BenchTab`] this shell is a pane of.
    pub tab_id: String,
    pub title: String,
    pub cwd: String,
    /// Empty means the configured default profile, resolved at open time — not a fixed shell.
    pub profile_id: String,
    /// Everything the shell printed, capped. See `terminal::Transcript`.
    pub transcript: String,
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
    /// The [`AgentProject`] this is filed under, or `""` for none. Organisation only — it never
    /// changes which repository a turn runs in.
    pub agent_project_id: String,
    /// Whether the list keeps it in its pinned section, wherever else it lives.
    pub pinned: bool,
    pub conversation_id: String,
    /// `draft` | `running` | `idle` | `done` | `error` | `cancelled`.
    pub status: String,
    pub turns: i64,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One run of "read this documentation, write the backlog": where the requirements came from,
/// where the stories are going on Azure Boards, and how the generation itself went.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryBatch {
    pub id: String,
    pub workspace_id: String,
    /// The repository whose Markdown was read, for the `files` source. `None` otherwise — a batch
    /// derived from a wiki needs no repository at all.
    pub project_id: Option<String>,
    pub title: String,
    /// `wiki` | `files` | `text`.
    pub source_kind: String,
    /// Human-readable provenance: the wiki pages, the file paths, or `""` for pasted text.
    pub source_ref: String,
    /// A copy of exactly what was sent to the model — the wiki moves on, this doesn't.
    pub source_text: String,
    pub instructions: String,
    pub provider: String,
    pub model: String,
    /// The prompt the last successful generation ran with, frozen at the moment it ran: the
    /// resolved template, and the preamble that was actually sent (instructions plus answered
    /// questions). `instructions` above is the value the *next* run will use, and the template is
    /// shared and editable, so neither can answer "what did this set come out of?" later. Empty
    /// until a generation has succeeded.
    pub prompt_template: String,
    pub prompt_instructions: String,
    pub generated_at: String,
    /// Which board this set publishes to: `""` | `azure` | `jira`. Empty reads as Azure, which is
    /// what every set predating Jira was.
    pub board_provider: String,
    /// The target, as three strings whose meaning is the board's: on Azure the organisation, the
    /// project and the work item type; on Jira the site, the project key and the issue type id.
    pub ado_org: String,
    pub ado_project: String,
    pub work_item_type: String,
    /// Azure only — Jira has no equivalent, and leaves both empty.
    pub area_path: String,
    pub iteration_path: String,
    pub tags: String,
    /// JSON array of strings: what the documentation left ambiguous.
    pub open_questions: String,
    /// JSON array of `{question, answer}`: those questions once the team answered them. They
    /// accumulate rather than being consumed — an answer is a requirement the documentation was
    /// missing, and it stays true after the question stops being asked.
    pub question_answers: String,
    /// JSON array of project ids: the repositories the acceptance criteria are checked against.
    /// Deliberately not `project_id`, which records where the source came from. Several because one
    /// capability is routinely split across a service, its BFF and its jobs.
    pub verify_project_ids: String,
    /// Where the `.feature` file is written — one repository out of the set above, because a spec
    /// copied into each would be several files drifting apart. `None` until the user picks one.
    pub feature_project_id: Option<String>,
    /// What the last verification ran on, and when. Empty until one has run.
    pub verify_provider: String,
    pub verify_model: String,
    pub verified_at: String,
    /// `draft` | `generating` | `ready` | `error`.
    pub status: String,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One page of generated technical documentation.
///
/// See the `doc_pages` table comment for why the two scopes share a table and what `project_id`
/// being absent actually means.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocPage {
    pub id: String,
    pub workspace_id: String,
    /// The repository this documents. `None` for a workspace-scope document.
    pub project_id: Option<String>,
    /// `repo` | `workspace`.
    pub scope: String,
    pub title: String,
    /// Markdown, which is what a wiki page is.
    pub content: String,
    pub ado_org: String,
    pub ado_project: String,
    pub wiki_id: String,
    pub wiki_name: String,
    /// Wiki-absolute, e.g. `/Servicios/Checkout API`.
    pub page_path: String,
    pub published_at: String,
    pub published_url: String,
    pub engine: String,
    pub model: String,
    pub version: String,
    /// `draft` | `generating` | `ready` | `error`.
    pub status: String,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One saved review of a work item that already exists on the board.
///
/// A record of a session, not a live view of the item: the story on Azure moves on and this does
/// not follow it. See the `work_item_reviews` table comment for why that is the point.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkItemReviewRow {
    pub id: String,
    pub workspace_id: String,
    pub ado_org: String,
    pub work_item_id: i64,
    pub work_item_type: String,
    pub work_item_url: String,
    /// The title as the user last had it locally — not necessarily the one on the board.
    pub title: String,
    /// The whole session as JSON. Opaque here: its shape belongs to the screen that wrote it.
    pub payload: String,
    pub engine: String,
    pub model: String,
    pub version: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One user story as it stands right now — the model's proposal plus every edit since, and the
/// work item it became.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryDraft {
    pub id: String,
    pub batch_id: String,
    pub seq: i64,
    pub title: String,
    /// "Como <rol>, quiero <capacidad>, para <beneficio>".
    pub narrative: String,
    pub description: String,
    /// JSON array of strings, one criterion per element (each may be multi-line Gherkin).
    pub acceptance_criteria: String,
    /// Azure Boards' scale: 1 (critical) … 4 (low). `0` leaves the field alone.
    pub priority: i64,
    /// `0` leaves the estimate alone. Fractional on purpose — Azure accepts half points.
    pub story_points: f64,
    /// Hours the story is expected to take, which is a different question from the points above:
    /// points size it against the rest of the backlog, hours are what a sprint's capacity is
    /// planned against. Azure keeps both, and so does this. `0` leaves the field alone.
    #[serde(default)]
    pub original_estimate: f64,
    pub tags: String,
    pub notes: String,
    /// `0` until published; the host's numeric id afterwards, which is what stops a duplicate.
    pub work_item_id: i64,
    /// What the board calls it out loud — Jira's `PROJ-123`. Empty on Azure, where the id is the
    /// name, and the card falls back to `#id`.
    pub work_item_key: String,
    pub work_item_url: String,
    /// What the last check against the code concluded: `""` (never checked) | `pass` | `partial` |
    /// `fail` | `unknown`. Rolled up from `verify_criteria`, never taken from the model directly.
    pub verify_status: String,
    pub verify_summary: String,
    /// JSON array positionally aligned with `acceptance_criteria` — one verdict per criterion.
    pub verify_criteria: String,
    /// Cleared whenever the criteria are edited: a verdict about text that has since changed is
    /// worse than no verdict at all.
    pub verified_at: String,
    /// `draft` | `published` | `error`.
    pub status: String,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A batch and its stories in one round trip — what the detail pane renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryBatchDetail {
    pub batch: StoryBatch,
    pub stories: Vec<StoryDraft>,
}

/// An ordered plan of agent steps against one repository. The steps' turns are ordinary agent
/// tasks; this row is the plan's identity and the scheduler's whole state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChain {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub goal: String,
    /// The [`AgentProject`] this is filed under, or `""` for none. Its steps' tasks inherit it, so
    /// a chain and the work it produced are always filed together.
    pub agent_project_id: String,
    /// Whether the list keeps it in its pinned section, wherever else it lives.
    pub pinned: bool,
    /// `queued` | `running` | `gated` | `paused` | `failed` | `done` | `aborted`.
    pub status: String,
    pub current_step: i64,
    pub step_count: i64,
    /// A translation key (`chain.interrupted`, `chain.repoBusy`, …) or a raw engine error.
    pub last_reason: String,
    /// Step runs started, ever. Bounded by `queries::MAX_CHAIN_DISPATCHES` — `step_count` stopped
    /// being the bound once a step could send the plan backwards.
    pub dispatches: i64,
    pub created_at: String,
    pub updated_at: String,
    /// `chain` for one a user authored step by step, `story` for one the story realizer built out
    /// of a work item. The scheduler treats both identically; only the panes differ.
    pub kind: String,
    /// The work item a `story` chain was built from — empty on every ordinary chain. Kept as the
    /// same four opaque strings every other board caller uses (`provider`, `org`, `id`, `key`), so
    /// a link back to the board needs no second lookup.
    pub work_item_provider: String,
    pub work_item_org: String,
    pub work_item_id: i64,
    pub work_item_key: String,
    pub work_item_url: String,
    pub work_item_title: String,
    /// How many repositories the chain works across. A count and not the list: the task list draws
    /// one badge per chain and would otherwise pay a query per row for names it never shows.
    pub repo_count: i64,
}

/// One repository a chain works across, with the name to draw it by.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainRepo {
    pub project_id: String,
    /// Empty when the repository has been removed from the workspace since — the chain keeps the
    /// row so the plan can still say where a finished step ran.
    pub name: String,
    pub position: i64,
}

/// One step of a chain. The agent's identity and routing are snapshotted at creation — see the
/// table's comment in `migrations.rs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChainStep {
    pub id: String,
    pub chain_id: String,
    pub step_index: i64,
    /// Which repository *this* step runs in. Always written — a chain across three repositories is
    /// three sets of steps, each naming its own — and backfilled to the chain's own `project_id`
    /// for every row that predates multi-repo chains.
    pub project_id: String,
    /// The repository's name, joined at read time. Empty when it has left the workspace.
    pub project_name: String,
    /// `` for a step of an ordinary chain; `analyze` | `implement` for the two halves of a story
    /// realizer run. What lets the detail pane group the plan into the two phases the user asked
    /// for rather than into 2N flat rows.
    pub phase: String,
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
    /// A shell command run in [`Self::project_id`]'s working copy once the turn lands. Exit code 0
    /// is the whole verdict. Empty means this step has no check and advances on having answered,
    /// which is what every step did before checks existed.
    pub check_command: String,
    /// Step index to continue at when the check passes. `-1` is the next step.
    pub on_pass: i64,
    /// Step index to continue at when the check fails. `-1` stops the plan. A value **below**
    /// [`Self::step_index`] is a loop.
    pub on_fail: i64,
    /// What the step that jumped here said and why its check failed — written onto the target so a
    /// backward jump arrives knowing what it is fixing. Cleared once this step passes.
    pub feedback: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A chain step stripped to what the task list needs to draw it: which chain it belongs to, which
/// task it produced, and how it ended. Deliberately without `prompt`, `pending_input` and
/// `output_text` — the handoff alone runs to 6k characters a step, and the list loads every chain
/// of the workspace at once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainStepBrief {
    pub id: String,
    pub chain_id: String,
    pub step_index: i64,
    pub agent_name: String,
    pub instruction: String,
    pub gate: bool,
    pub task_id: String,
    pub status: String,
    /// Which repository this step runs in. The id as well as the name, because deleting a
    /// repository has to find every chain with a step in it — including the ones whose *primary*
    /// repository is something else and which therefore survive the cascade.
    pub project_id: String,
    pub project_name: String,
    /// See [`AgentChainStep::phase`].
    pub phase: String,
}

/// One step as the frontend authors it, before anything is snapshotted or persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewChainStep {
    pub agent_id: String,
    pub instruction: String,
    pub gate: bool,
    /// Which of the chain's repositories this step runs in.
    ///
    /// Three spellings, and the third is the one that makes a multi-repo chain worth authoring:
    /// a project id runs the step there, `""` runs it in the chain's first repository, and `"*"`
    /// means *every* repository the chain was given — which
    /// [`queries::create_agent_chain`](crate::db::queries::create_agent_chain) expands into one
    /// consecutive row per repository at creation, so the plan on disk stays the flat list the
    /// scheduler knows how to walk.
    #[serde(default)]
    pub project_id: String,
    /// See [`AgentChainStep::phase`]. Empty for everything a user authors by hand.
    #[serde(default)]
    pub phase: String,
    /// See [`AgentChainStep::check_command`]. `#[serde(default)]` on all three of these is what
    /// keeps an older frontend — or a saved template written before they existed — able to author
    /// a chain: absent means no check and the linear defaults.
    #[serde(default)]
    pub check_command: String,
    /// See [`AgentChainStep::on_pass`]. Authored against the step positions of the plan as typed,
    /// which is why a `"*"` step cannot carry one: expansion turns one authored step into N rows
    /// and there is no single index left to point at.
    #[serde(default = "minus_one")]
    pub on_pass: i64,
    /// See [`AgentChainStep::on_fail`].
    #[serde(default = "minus_one")]
    pub on_fail: i64,
}

/// `-1` — "the default target", which is not what `i64::default()` gives.
fn minus_one() -> i64 {
    -1
}

/// Hand-written for exactly that reason: `#[derive(Default)]` would make `on_pass`/`on_fail` zero,
/// which is not "no target" but "jump to the first step" — a plan that loops forever, arrived at by
/// deriving a trait.
impl Default for NewChainStep {
    fn default() -> Self {
        Self {
            agent_id: String::new(),
            instruction: String::new(),
            gate: false,
            project_id: String::new(),
            phase: String::new(),
            check_command: String::new(),
            on_pass: -1,
            on_fail: -1,
        }
    }
}

/// The verdict on one step: what its declared check said when it ran.
///
/// `ran: false` is the ordinary case and covers both a step with no check and a repository that has
/// gone missing — the caller then completes the step exactly as it always did, on having answered.
/// Keeping "there was nothing to check" distinct from "the check passed" is what stops a chain
/// silently reporting every unverified step as verified.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepCheck {
    pub ran: bool,
    pub passed: bool,
    /// stdout and stderr together, in the order the process wrote them to each. Fed back to the
    /// agent being asked to fix it, so it is the process's own words and not a summary.
    pub output: String,
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
    /// Every repository the chain works across, in the order they were picked. Always at least
    /// one, and for a single-repo chain exactly the one `chain.project_id` names.
    pub repos: Vec<ChainRepo>,
}

/// The work item a story chain is built from, as the dialog hands it over.
///
/// The prose arrives already flattened to text by the caller: the board clients answer in HTML, and
/// the Markdown renderer that turns it back into something an engine should read lives on the
/// frontend, beside the review screen that already does it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewStoryWorkItem {
    pub provider: String,
    pub org: String,
    pub id: i64,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub url: String,
    pub title: String,
    /// Title, narrative, description and acceptance criteria as one block of plain text. This is
    /// what every step of the run reads as its objective.
    pub body: String,
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
    /// See [`AgentChainStep::check_command`]. Kept by a template because it is workspace-neutral,
    /// unlike the repository a step runs in.
    #[serde(default)]
    pub check_command: String,
    /// See [`AgentChainStep::on_pass`], against the template's own step positions.
    #[serde(default = "minus_one")]
    pub on_pass: i64,
    /// See [`AgentChainStep::on_fail`].
    #[serde(default = "minus_one")]
    pub on_fail: i64,
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
    /// Free text. Empty is "ungrouped", which the UI shows as a bucket of its own at the top.
    pub group_name: String,
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

/// A folder in the connection tree.
///
/// Carries no members: a connection's `group_name` is still what puts it in a group. This row
/// exists so a group can exist while empty — see the table's comment in `migrations` for why that
/// is the one thing the string alone cannot express.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbGroupRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

/// Everything the database workspace needs on load, in one round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbWorkspaceTree {
    pub connections: Vec<DbConnectionRow>,
    pub groups: Vec<DbGroupRow>,
    pub consoles: Vec<DbConsole>,
}

// ---------------------------------------------------------------------------
// Remote workspace
// ---------------------------------------------------------------------------

/// A saved SSH host.
///
/// `spec` is the JSON the remote layer deserializes into a [`crate::remotes::RemoteHostSpec`],
/// minus the password — that lives in the OS keychain, so this row can be read by anything that can
/// read the config file without leaking a credential. The same split, and the same reason, as
/// [`DbConnectionRow`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHostRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    /// Free text. Empty is "ungrouped", which the UI shows as a group of its own at the top.
    pub group_name: String,
    pub spec: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A command to send into a session.
///
/// Workspace-scoped rather than host-scoped, because the point of a snippet is that it runs on more
/// than one host — "tail the app log", "show disk", "restart the service" are written once and used
/// across the whole estate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSnippet {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub body: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// One thing that was opened against a host, and how it went.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteLogEntry {
    pub id: String,
    pub workspace_id: String,
    pub host_id: String,
    pub host_name: String,
    pub kind: String,
    pub detail: String,
    /// Empty when it worked.
    pub error: String,
    pub at: String,
}

/// A folder in the host tree.
///
/// Carries no members: a host's `group_name` is still what puts it in a group. This row exists so a
/// group can exist while empty — see the table's comment in `migrations` for why that is the one
/// thing the string alone cannot express.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteGroupRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
}

/// Everything the Remote workspace needs on load, in one round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteWorkspaceTree {
    pub hosts: Vec<RemoteHostRow>,
    pub groups: Vec<RemoteGroupRow>,
    pub snippets: Vec<RemoteSnippet>,
}

// ---------------------------------------------------------------------------
// Notes workspace
// ---------------------------------------------------------------------------

/// A book in the note tree — a shelf, nestable. `parent_id` is `None` at the top level.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteBookRow {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A note **without its body** — every column of `notes` except `content`.
///
/// This is what the tree, the gallery and the tag counts are built from, and it is a separate type
/// from [`NoteRow`] rather than one with an optional field so that "the list does not carry
/// bodies" is enforced by the compiler instead of by remembering. See the `notes` table comment.
///
/// `excerpt` and `word_count` are here precisely because of that: they are the two things a list
/// wants from a body it is not allowed to have.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMeta {
    pub id: String,
    pub workspace_id: String,
    pub book_id: Option<String>,
    pub title: String,
    pub excerpt: String,
    /// JSON array of strings, verbatim as stored.
    pub tags: String,
    pub pinned: bool,
    pub word_count: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// One note, body included. Fetched one at a time by [`super::note_queries::get_note`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRow {
    pub id: String,
    pub workspace_id: String,
    pub book_id: Option<String>,
    pub title: String,
    pub content: String,
    pub excerpt: String,
    pub tags: String,
    pub pinned: bool,
    pub word_count: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A note skeleton the user saved to start from again.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteTemplateRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub description: String,
    /// A lucide icon name.
    pub icon: String,
    pub content: String,
    pub tags: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Everything the Notes workspace needs on load, in one round trip — and no note bodies.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesWorkspaceTree {
    pub notes: Vec<NoteMeta>,
    pub books: Vec<NoteBookRow>,
    pub templates: Vec<NoteTemplateRow>,
}

/// A note whose *body* matched a search, with the matching stretch of it.
///
/// Only bodies produce these. A title or tag match needs no round trip — the frontend already
/// holds every [`NoteMeta`] and filters them as the user types; see `note_queries::search_notes`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSearchHit {
    pub id: String,
    /// A window of the body around the first match, with the surrounding words for context.
    pub snippet: String,
    /// Offset of the match *within `snippet`*, so the frontend can mark it without searching again.
    pub match_start: i64,
    pub match_len: i64,
}

/// A folder in the Diagrams tree. The same shape as [`NoteBookRow`], and deliberately so — the two
/// trees are the same gesture over different documents, and a reader who knows one knows the other.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagramFolderRow {
    pub id: String,
    pub workspace_id: String,
    /// `None` is the root, which is a real place: a diagram made from the gallery lands there.
    pub parent_id: Option<String>,
    pub name: String,
    /// Empty for "no colour", which draws the folder in the muted default.
    pub color: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A diagram **without its document** — every column of `diagrams` except `doc`.
///
/// Separate from [`DiagramRow`] for exactly the reason [`NoteMeta`] is separate from [`NoteRow`]:
/// so that "the tree does not carry documents" is enforced by the compiler rather than by
/// remembering. A workspace of two hundred diagrams is tens of megabytes of XML, and the sidebar
/// draws titles.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagramMeta {
    pub id: String,
    pub workspace_id: String,
    /// `None` is the root of the tree — unlike a note, a diagram is not forced into a folder.
    pub folder_id: Option<String>,
    pub title: String,
    /// Which dialect `doc` is written in. See the `diagrams` table comment; this is the column that
    /// keeps the choice of editor from being baked into every row.
    pub format: String,
    /// JSON array of strings, verbatim as stored.
    pub tags: String,
    pub pinned: bool,
    /// Vertices plus edges, derived from `doc` on every write. What a list wants from a document
    /// it is not allowed to have.
    pub shape_count: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// One diagram, document included. The only shape that carries `doc`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagramRow {
    pub id: String,
    pub workspace_id: String,
    pub folder_id: Option<String>,
    pub title: String,
    pub doc: String,
    pub format: String,
    pub thumbnail: String,
    pub tags: String,
    pub pinned: bool,
    pub shape_count: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A diagram skeleton the user starts from.
///
/// Carries its own `doc`, unlike [`DiagramMeta`] — a template *is* its document, and there are a
/// handful of them rather than hundreds, so the rule that keeps documents out of the tree has
/// nothing to say here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagramTemplateRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub description: String,
    /// A lucide icon name.
    pub icon: String,
    pub doc: String,
    pub format: String,
    pub tags: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Everything the Diagrams workspace needs on load, in one round trip — and no documents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagramsWorkspaceTree {
    pub diagrams: Vec<DiagramMeta>,
    pub folders: Vec<DiagramFolderRow>,
    pub templates: Vec<DiagramTemplateRow>,
}

/// One diagram's picture, fetched separately from its metadata.
///
/// **Deliberately not a field of [`DiagramMeta`].** A thumbnail is a rendered PNG — tens of
/// kilobytes each — and the workspace holds every diagram's metadata at once. Carrying pictures in
/// that load would undo the same rule the `doc` split exists for, just an order of magnitude
/// further down: a hundred diagrams would be megabytes of image fetched to draw a sidebar of
/// titles. The gallery asks for the ones it is about to draw and no more.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagramThumbnail {
    pub id: String,
    /// A `data:` URI, exactly as the editor exported it. Empty for a diagram never saved.
    pub thumbnail: String,
}
