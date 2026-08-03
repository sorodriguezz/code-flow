export interface Workspace {
  id: string;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
  created_at: string;
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  local_path: string;
  remote_url: string | null;
  color: string;
  icon: string;
  ado_org: string | null;
  ado_project: string | null;
  ado_repo_id: string | null;
  github_owner: string | null;
  github_repo: string | null;
  github_host: string | null;
  /** The project's full path including every group it is nested under (`acme/backend/auth`).
   * One column, not an owner/repo pair: GitLab groups nest, so there is nothing to split off. */
  gitlab_project: string | null;
  gitlab_host: string | null;
  sort_order: number;
  created_at: string;
}

export interface NewProject {
  workspace_id: string;
  name: string;
  local_path: string;
  remote_url: string | null;
  color: string;
  icon: string;
  ado_org: string | null;
  ado_project: string | null;
  ado_repo_id: string | null;
  github_owner: string | null;
  github_repo: string | null;
  github_host: string | null;
  /** The project's full path including every group it is nested under (`acme/backend/auth`).
   * One column, not an owner/repo pair: GitLab groups nest, so there is nothing to split off. */
  gitlab_project: string | null;
  gitlab_host: string | null;
}

/** A saved GitHub connection — one per host (github.com or an Enterprise Server). Persisted as
 * the `github_connections` app-setting (JSON); the token itself lives in the OS keychain. */
export interface GithubConnection {
  host: string;
  username: string;
}

/** A saved GitLab connection — one per host (gitlab.com or a self-managed instance). Persisted
 * as the `gitlab_connections` app-setting (JSON); the token itself lives in the OS keychain.
 *
 * That list is also the allowlist auto-detection reads. It carries more weight than GitHub's: a
 * GitLab project path has no fixed number of segments, so an unlisted host is indistinguishable
 * from any other self-hosted git server. */
export interface GitlabConnection {
  host: string;
  username: string;
}

/** A saved Azure DevOps connection — one per organization. Persisted as the `ado_connections`
 * app-setting (JSON); the PAT itself lives in the OS keychain, keyed per org. */
export interface AdoConnection {
  org: string;
}

export interface FileStatusEntry {
  path: string;
  status: string;
}

export interface RepoStatusInfo {
  staged: FileStatusEntry[];
  unstaged: FileStatusEntry[];
  untracked: FileStatusEntry[];
  conflicted: FileStatusEntry[];
  current_branch: string | null;
  is_detached: boolean;
  /** Commit HEAD points at, branch or not — the only way to place HEAD once it's detached. */
  head_oid: string | null;
}

export interface CommitInfo {
  id: string;
  short_id: string;
  summary: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  parent_ids: string[];
  refs: string[];
}

export interface BranchInfo {
  name: string;
  is_head: boolean;
  is_remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  target: string | null;
  /** Locked by the user: no merges onto it and no pushes of it. Always false when remote. */
  is_locked: boolean;
}

export interface StashInfo {
  index: number;
  message: string;
  oid: string;
}

export interface RemoteInfo {
  name: string;
  url: string;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface MergeOutcome {
  status: "up_to_date" | "fast_forward" | "merged" | "conflicts";
  conflicts: string[];
}

export interface ConflictFile {
  path: string;
}

export interface DiffLine {
  origin: string;
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
}

export interface DiffHunkInfo {
  header: string;
  lines: DiffLine[];
}

export interface FileDiffInfo {
  old_path: string | null;
  new_path: string | null;
  status: string;
  hunks: DiffHunkInfo[];
}

/** A credential-looking match found in the staged diff by the pre-commit secret scanner. */
export interface SecretHit {
  file: string;
  line: number;
  rule: string;
  rule_name: string;
  severity: "critical" | "warning";
  preview: string;
}

export interface ReviewContext {
  id: string;
  workspace_id: string;
  name: string;
  content: string;
  enabled: boolean;
  created_at: string;
}

/** A saved PR-review run as listed in the memory manager (slim projection, no heavy text). */
export interface ReviewRunSummary {
  id: string;
  project_id: string;
  project_name: string;
  pr_id: number;
  pr_title: string;
  iter: number;
  level: string;
  findings_count: number;
  created_at: string;
}

/** One finding inside a saved run's `findings` JSON (mirrors the Rust `MemoryFinding`). */
export interface SavedFinding {
  id: string;
  severity: string;
  tipo: string;
  categoria: string;
  subtitulo: string;
  archivo: string | null;
  lineas: string | null;
  confianza: number | null;
  estado: string;
  thread_id?: number | null;
  introducido_en_iter: number;
  resuelto_en_iter?: number | null;
  motivo_descarte?: string | null;
  delta?: string | null;
}

/** A standing "this is a known false positive" rule for one repository (mirrors the Rust
 * `FpSuppression`). Unlike a finding's `falso_positivo` mark — which only reaches its own pull
 * request — these are read into every review of the repository they name. */
export interface FpSuppression {
  id: string;
  /** `github:host/owner/repo`, `gitlab:host/full/path` or `azure:org/project/repoId`. */
  repo_key: string;
  categoria: string;
  /** The file the rule is scoped to, or null for "this category, anywhere in the repo". */
  archivo?: string | null;
  motivo: string;
  pr_id: number;
  created_at: string;
}

/** What discarding a finding achieved. The local mark always holds; `host_error` means the PR
 * thread couldn't be updated, which is a warning rather than a failure. */
export interface DiscardOutcome {
  host_notified: boolean;
  host_error: string | null;
  rule_added: boolean;
}

/** What closing a PR comment thread managed to do. Reply and close are two host calls and fail
 * independently, so a thread that took the reply but refused to close comes back as
 * `replied: true, resolved: false` with the reason — the card stays open and says so, rather than
 * disappearing on a close that never happened. */
export interface ThreadCloseOutcome {
  replied: boolean;
  resolved: boolean;
  error: string | null;
}

/** Full content of one saved review run, for the in-app viewer / export. */
export interface ReviewRunDetail {
  id: string;
  project_id: string;
  pr_id: number;
  iter: number;
  level: string;
  /** Run metadata as a JSON string (ReviewMeta). */
  meta: string;
  review_md: string;
  diff: string;
  /** Parsed findings as a JSON string. */
  findings: string;
  created_at: string;
}

/** A user-defined SDD/Harness agent (role): name, role, model, prompt, on/off. */
export interface WorkspaceAgent {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  prompt: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
}

/** A folder for agent work. Not a repository: `AgentTask.project_id` is still the git working copy
 * a turn runs in, and this is only where the user filed it. */
export interface AgentProject {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * Where an agent task stands.
 *
 * `draft` has never been sent. `idle` finished a turn and is waiting on the user — the state a
 * task spends most of its life in, and the one worth surfacing in the list. `running` is only
 * meaningful inside the session that set it: a row still saying so when the app starts is one
 * that was killed mid-turn, and `agentsStore` demotes it to `idle` on load rather than showing a
 * spinner for a process that died yesterday.
 */
export type AgentTaskStatus = "draft" | "running" | "idle" | "done" | "error" | "cancelled";

/** One goal handed to a roster agent and worked on against one repository of the workspace. */
export interface AgentTask {
  id: string;
  workspace_id: string;
  /** The repository the turns run in — an agent has to have a working directory. */
  project_id: string;
  /** The `WorkspaceAgent` this came from, or `""` once that agent has been deleted. */
  agent_id: string;
  /** The agent's name as it was at creation, so a deleted agent still reads as itself. */
  agent_name: string;
  /** Copied off the agent at creation: editing the roster must not rewrite a task that already ran. */
  provider: string;
  prompt: string;
  /** The one piece of routing a later turn may change. */
  model: string;
  goal: string;
  title: string;
  /** The `AgentProject` this is filed under, or `""` for none. */
  agent_project_id: string;
  /** Whether it sits in the list's pinned section. */
  pinned: boolean;
  /** `activity_log.session_id` for every turn of this task. Prefixed `agent-`. */
  conversation_id: string;
  status: AgentTaskStatus;
  turns: number;
  last_error: string;
  created_at: string;
  updated_at: string;
}

/**
 * Where a chain stands. `queued` means the scheduler may dispatch its next step as soon as the
 * repository frees; `gated` is parked *before* a step the plan marks for review, which is the
 * user's move; `paused` is parked for any other reason — stopped, interrupted, window hidden.
 *
 * Nothing ever moves from `paused` or `failed` on its own. A turn edits a real working copy, so
 * resuming is always a click.
 */
export type ChainStatus = "queued" | "running" | "gated" | "paused" | "failed" | "done" | "aborted";

/** `interrupted` is the app-was-killed case: the turn never landed, so the tree may hold half of
 * its edits and only a human can say what to do. */
export type ChainStepStatus = "pending" | "running" | "done" | "error" | "interrupted" | "skipped";

/** An ordered plan of agent steps against one repository. */
export interface AgentChain {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  /** The `AgentProject` this is filed under, or `""` for none. */
  agent_project_id: string;
  /** Whether it sits in the list's pinned section. */
  pinned: boolean;
  status: ChainStatus;
  current_step: number;
  step_count: number;
  /** A translation key (`chain.interrupted`, `chain.repoBusy`, …) or a raw engine error. */
  last_reason: string;
  created_at: string;
  updated_at: string;
}

export interface AgentChainStep {
  id: string;
  chain_id: string;
  step_index: number;
  /** Snapshotted off the roster when the chain was authored — see `AgentTask`. */
  agent_id: string;
  agent_name: string;
  provider: string;
  model: string;
  prompt: string;
  instruction: string;
  gate: boolean;
  gate_cleared: boolean;
  /** The message frozen at the gate, sent verbatim. Editing the handoff writes here. */
  pending_input: string;
  task_id: string;
  run_id: string;
  log_count_at_dispatch: number;
  /** A *copy* of the answer, so the handoff survives deleting the step's task. */
  output_text: string;
  output_truncated: boolean;
  status: ChainStepStatus;
  attempts: number;
  last_error: string;
  created_at: string;
  updated_at: string;
}

/** A chain step as the task list needs it — see the Rust `ChainStepBrief` for why it is not the
 * whole row. */
export interface ChainStepBrief {
  id: string;
  chain_id: string;
  step_index: number;
  agent_name: string;
  instruction: string;
  gate: boolean;
  task_id: string;
  status: ChainStepStatus;
}

/** One step as the dialog authors it, before anything is snapshotted. */
export interface NewChainStep {
  agent_id: string;
  instruction: string;
  gate: boolean;
}

/** What the backend hands back when asked what happens next. `kind: "idle"` still carries a fresh
 * `chain` that the caller must apply — the claim may have gated, finished or failed it. */
export interface ChainClaim {
  chain: AgentChain;
  kind: "run" | "idle";
  task: AgentTask | null;
  step: AgentChainStep | null;
  message: string;
}

export interface ChainDetail {
  chain: AgentChain;
  steps: AgentChainStep[];
}

/** A reusable chain plan. Configuration rather than history: it belongs to the workspace, carries
 * no run state, and travels with a backup. */
export interface ChainTemplate {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  steps: ChainTemplateStep[];
}

export interface ChainTemplateStep {
  id: string;
  template_id: string;
  step_index: number;
  /** Named, never snapshotted — a template is meant to follow the roster. */
  agent_id: string;
  instruction: string;
  gate: boolean;
}

export interface WorkspaceSkill {
  id: string;
  workspace_id: string;
  skill_name: string;
  source_repo: string;
  enabled: boolean;
  installed_at: string;
}

export interface WorkspaceMcp {
  id: string;
  workspace_id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: boolean;
  created_at: string;
}

export interface ActivityLogEntry {
  id: string;
  project_id: string;
  /** The conversation this turn belongs to (app-minted, stable), not the engine's session token. */
  session_id: string | null;
  /** The engine's resume token for this turn, when it reported one — used to carry a reopened
   * conversation forward on the CLI's side. */
  engine_session_id: string | null;
  question: string;
  answer: string;
  /** JSON array of `{stream, line}` with what the engine printed while working on this turn, so a
   * finished answer can still show how it got there. `null` for turns recorded before traces. */
  trace: string | null;
  created_at: string;
  /** How long the engine took to answer, in ms. `null` for turns recorded before this was tracked. */
  response_time_ms: number | null;
  /** True when the turn failed — `answer` then holds the engine's error text. */
  is_error: boolean;
  /** Provider id that answered this turn (`claude`, `codex`, …), recorded at the time it ran so a
   * reopened conversation isn't relabelled by today's routing. `null` for older turns. */
  provider: string | null;
  /** Model the CLI reported for this turn. `null` for older turns, or when it didn't report one. */
  model: string | null;
  /** Version of the engine CLI that answered this turn. `null` for older turns. */
  engine_version: string | null;
}

export interface JobHistoryEntry {
  id: string;
  project_id: string;
  kind: string;
  label: string;
  custom_label: string | null;
  status: string;
  result: string | null;
  error: string | null;
  meta: string;
  created_at: string;
}

/** The repo-less twin of {@link JobHistoryEntry}: a PR reviewed (or decided on) from its link
 * alone, filed against the *workspace* because there is no project to file it against. Its `meta`
 * carries `prUrl`, `repoLabel`, `cloneUrl` and a `pr` snapshot — everything needed to reopen the
 * review without the link being pasted again. */
export interface WorkspaceActivityEntry {
  id: string;
  workspace_id: string;
  kind: string;
  label: string;
  custom_label: string | null;
  status: string;
  result: string | null;
  error: string | null;
  meta: string;
  created_at: string;
}

export interface ChatConversationSummary {
  session_id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
}

export interface PrThreadComment {
  author: string;
  content: string;
  published_date: string;
}

export interface PrCommentThread {
  id: number;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  comments: PrThreadComment[];
}

export interface GitProgressEvent {
  op: string;
  line: string;
}

export interface GitDoneEvent {
  op: string;
  success: boolean;
  message: string;
}

export type ThemePreference = "light" | "dark" | "system";

export interface AdoProject {
  id: string;
  name: string;
}

export interface AdoRepo {
  id: string;
  name: string;
}

export type VcsProvider = "azure" | "github" | "gitlab";

/** AI-drafted PR title + body, returned by `generate_pr_description` to prefill the create form. */
export interface PrDescriptionDraft {
  title: string;
  body: string;
}

export interface PullRequestSummary {
  id: number;
  title: string;
  description: string;
  status: "open" | "draft" | "merged" | "closed";
  source_branch: string;
  target_branch: string;
  author: string;
  created_at: string;
  url: string;
  /** Which host this PR came from — drives the "view on…" link and post-confirmation copy. */
  provider: VcsProvider;
}

export type AutoLinkResult =
  | { status: "Linked"; project: Project }
  | { status: "NeedsToken"; provider: VcsProvider; identifier: string }
  | { status: "NotDetected" };

/** The decision the signed-in user has already recorded on a pull request, as its host reports it
 * — so a vote cast on the website counts the same as one cast here. Drives whether the approve /
 * request-changes buttons are still offered. */
export type PrDecision = "approved" | "changes_requested" | "none";

/** What a PR decision left behind: the pull request as the host now reports it, and the Activity
 * row the action was filed under. */
export interface PrActionOutcome {
  pr: PullRequestSummary;
  activity: JobHistoryEntry;
}

/** The same, for a decision taken on a PR reached by link — its Activity row belongs to the
 * workspace rather than to a project. */
export interface PrLinkActionOutcome {
  pr: PullRequestSummary;
  activity: WorkspaceActivityEntry;
}

/** What a pasted pull-request link turned out to be. `Ready` is the happy path: the PR was read
 * from its host *and* matched to a local repository (linked on the spot if it wasn't already), so
 * everything downstream — diff, findings, comments, review memory — works exactly as it does for
 * a PR picked from the sidebar. */
export type PrLinkResolution =
  | {
      status: "Ready";
      project_id: string;
      workspace_id: string;
      project_name: string;
      pr: PullRequestSummary;
    }
  | { status: "NeedsToken"; provider: VcsProvider; identifier: string }
  | {
      status: "NoLocalRepo";
      provider: VcsProvider;
      repo_label: string;
      /** Clone URL for the "clone it and review" offer. */
      clone_url: string;
      pr: PullRequestSummary;
    }
  | { status: "Unrecognized" };

/** A shell the terminal can be opened with. `builtin` profiles are detected on this machine at
 * every launch and aren't editable; the rest are the user's own, persisted in app settings. */
export interface ShellProfile {
  id: string;
  name: string;
  command: string;
  args: string[];
  builtin: boolean;
}

/** What `open_terminal` hands back: the pty session id plus the profile that actually started —
 * which is resolved in the backend, so it isn't always the one the caller asked for. */
export interface TerminalOpened {
  id: string;
  profile_id: string;
  profile_name: string;
}

// ---------- user stories (wiki in, Azure Boards out) ----------

/** One wiki of an Azure DevOps project. `kind` is `projectWiki` or `codeWiki`. */
export interface AdoWiki {
  id: string;
  name: string;
  kind: string;
}

/** One page of a wiki, flattened out of the tree the API answers with — `depth` is what lets the
 * picker redraw the nesting without re-deriving it from the slashes in `path`. */
export interface AdoWikiPage {
  /** The wiki-absolute path, e.g. `/Producto/Checkout`. This is the page's identity. */
  path: string;
  title: string;
  depth: number;
  has_children: boolean;
}

/** A work item type the project's process defines — "User Story" on Agile, "Product Backlog Item"
 * on Scrum, "Issue" on Basic. Read from the host, never assumed. */
export interface AdoWorkItemType {
  name: string;
  reference_name: string;
  description: string;
  /** Hex without the leading `#`, as Azure reports it. */
  color: string;
}

/** One node of the area or iteration tree. `path` is already in the form the work item field
 * takes (`Proyecto\Área\Sub`). */
export interface AdoClassificationNode {
  path: string;
  name: string;
  depth: number;
}

/** Where a batch's documentation came from. */
export type StorySourceKind = "wiki" | "files" | "text";

/** `generating` is only meaningful inside the session that set it — a row still saying so at
 * startup is one whose app was killed mid-run, and the backend demotes it on load. */
export type StoryBatchStatus = "draft" | "generating" | "ready" | "error";

/** One run of "read this documentation, write the backlog". */
export interface StoryBatch {
  id: string;
  workspace_id: string;
  /** The repository whose Markdown was read, for the `files` source. `null` otherwise — a batch
   * derived from a wiki needs no repository at all. */
  project_id: string | null;
  title: string;
  source_kind: StorySourceKind;
  /** Human-readable provenance: the wiki pages, the file paths, or `""` for pasted text. */
  source_ref: string;
  /** A copy of exactly what was sent to the model — the wiki moves on, this doesn't. */
  source_text: string;
  instructions: string;
  provider: string;
  model: string;
  ado_org: string;
  ado_project: string;
  work_item_type: string;
  area_path: string;
  iteration_path: string;
  /** Applied to every story of the batch, on top of the story's own. */
  tags: string;
  /** JSON array of strings: what the documentation left ambiguous. */
  open_questions: string;
  /** The repository whose code the acceptance criteria are checked against. `null` until picked —
   * deliberately not `project_id`, which records where the documentation came from. */
  verify_project_id: string | null;
  /** What the last verification ran on, and when. Empty until one has run. */
  verify_provider: string;
  verify_model: string;
  verified_at: string;
  status: StoryBatchStatus;
  last_error: string;
  created_at: string;
  updated_at: string;
}

/** What checking a criterion against the code concluded. `unknown` is a real answer, not a
 * failure to answer: it means nobody has proven it either way, which is exactly where QA should
 * still be looking. */
export type StoryVerdict = "pass" | "partial" | "fail" | "unknown";

/** One criterion's verdict, as stored in `StoryDraft.verify_criteria`. */
export interface CriterionVerdict {
  verdict: StoryVerdict;
  /** Repository-relative `path:line` references backing the verdict. */
  evidence: string[];
  note: string;
  covered_by_test: boolean;
}

export type StoryDraftStatus = "draft" | "published" | "error";

/** One user story as it stands right now — the model's proposal plus every edit since, and the
 * Azure Boards work item it became. */
export interface StoryDraft {
  id: string;
  batch_id: string;
  seq: number;
  title: string;
  /** "Como <rol>, quiero <capacidad>, para <beneficio>". */
  narrative: string;
  description: string;
  /** JSON array of strings, one criterion per element (each may be multi-line Gherkin). */
  acceptance_criteria: string;
  /** Azure Boards' scale: 1 (critical) … 4 (low). `0` leaves the field alone. */
  priority: number;
  /** `0` leaves the estimate alone. */
  story_points: number;
  tags: string;
  notes: string;
  /** `0` until published; the work item id afterwards, which is what stops a duplicate. */
  work_item_id: number;
  work_item_url: string;
  /** What the last check against the code concluded. `""` means never checked. Rolled up from
   * `verify_criteria`, so it can never disagree with the criteria underneath it. */
  verify_status: StoryVerdict | "";
  verify_summary: string;
  /** JSON array of {@link CriterionVerdict}, positionally aligned with `acceptance_criteria`. */
  verify_criteria: string;
  /** Cleared whenever the criteria are edited — a verdict about text that has since changed is
   * worse than no verdict, because it stops QA looking exactly where the gap now is. */
  verified_at: string;
  status: StoryDraftStatus;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface StoryBatchDetail {
  batch: StoryBatch;
  stories: StoryDraft[];
}

/** What a publish did, story by story. The whole list comes back — including the rows that
 * failed, which now carry their own reason — so the view re-renders from one answer. */
export interface StoryPublishOutcome {
  stories: StoryDraft[];
  published: number;
  failed: number;
}

// ---------- reviewing a work item that is already on the board ----------

/** What a pasted work-item reference resolved to. `org`/`project` are null for a bare id. */
export interface WorkItemRef {
  org: string | null;
  project: string | null;
  id: number;
}

/** A child of a user story — the tasks it already has. */
export interface AdoWorkItemChild {
  id: number;
  url: string;
  work_item_type: string;
  title: string;
  state: string;
  /** What the task says, as Azure stores it — HTML, shown through `htmlToText`. */
  description_html: string;
  /** Display name of whoever it is assigned to. Empty when nobody is. */
  assigned_to: string;
}

/**
 * One work item as Azure stores it. The prose fields arrive as HTML and are turned into text by
 * `workItemHtml`, which is also what gets sent to the review — so the story that was judged is the
 * one on screen.
 */
export interface AdoWorkItem {
  id: number;
  url: string;
  work_item_type: string;
  title: string;
  state: string;
  team_project: string;
  description_html: string;
  /** Where a **Bug** actually keeps its prose — the Agile and Scrum bug forms have no description. */
  repro_steps_html: string;
  /** Environment, version, OS. Half the context of a bug report lives here. */
  system_info_html: string;
  acceptance_criteria_html: string;
  /** `0` means "not estimated", which for a Basic-process item is the only possible answer. */
  effort: number;
  /** The field the estimate came out of, so the UI can name it instead of inventing one. */
  effort_field: string;
  tags: string;
  area_path: string;
  iteration_path: string;
  children: AdoWorkItemChild[];
}

/**
 * What is being reviewed, which decides what "well written" means.
 *
 * A story is judged by INVEST; a bug by whether anyone can reproduce it. Only the analysis stage
 * branches on this — criteria and tasks are the same job either way.
 */
export type WorkItemKind = "story" | "bug";

export type WorkItemReviewStage = "analyze" | "criteria" | "tasks";

export interface InvestVerdict {
  letter: string;
  verdict: "ok" | "weak" | "missing";
  note: string;
}

/** Which part of the story a finding belongs to. */
export type StorySection = "titulo" | "narrativa" | "descripcion" | "criterios";

export interface ReviewFinding {
  section: StorySection;
  severity: "alta" | "media" | "baja";
  issue: string;
  /** Written to be pasted as-is. The review never edits the story itself. */
  proposal: string;
  evidence: string[];
  /** Which repository it came from. Empty when only one was reviewed. */
  repo: string;
}

export interface ProposedCriterion {
  gherkin: string;
  rationale: string;
  evidence: string[];
  repo: string;
}

export interface ProposedTask {
  kind: "dev" | "qa";
  /** Already carries its `[DEV]`/`[QA]` prefix — the backend puts it on. */
  title: string;
  detail: string;
  evidence: string[];
  repo: string;
}

/** Tagged by stage, so the caller reads the shape it asked for. */
export type WorkItemReview =
  | { stage: "analyze"; summary: string; invest: InvestVerdict[]; findings: ReviewFinding[] }
  | { stage: "criteria"; criteria: ProposedCriterion[] }
  | { stage: "tasks"; tasks: ProposedTask[] };

/** Which document is being written — see `DocScope` in the Rust AI layer. */
export type DocScope = "repo" | "workspace";

/** One page of generated technical documentation, as stored. */
export interface DocPage {
  id: string;
  workspace_id: string;
  /** The repository it documents. `null` for a workspace-scope document. */
  project_id: string | null;
  scope: DocScope;
  title: string;
  /** Markdown, which is what a wiki page is. */
  content: string;
  ado_org: string;
  ado_project: string;
  wiki_id: string;
  wiki_name: string;
  page_path: string;
  published_at: string;
  published_url: string;
  engine: string;
  model: string;
  version: string;
  /** `draft` | `generating` | `ready` | `error`. */
  status: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

/** A finished generation, plus what produced it. */
export interface DocResult {
  content: string;
  engine: string;
  model: string;
  version: string;
  elapsed_ms: number;
  repos_read: number;
}

/** A work item the app just wrote to or created. */
export interface AdoWorkItemRef {
  id: number;
  /** The page a human opens, not the REST resource. */
  url: string;
}

/** Where a published wiki page ended up. */
export interface AdoWikiPageRef {
  path: string;
  url: string;
  /** Whether the page existed already — "updated" rather than "created". */
  updated: boolean;
}

/** What produced one stage's answer, kept next to the answer itself. */
export interface ReviewProvenance {
  /** The engine's display name — "Claude Code", "Codex", … */
  engine: string;
  /** The model that actually answered, as the CLI reported it. */
  model: string;
  /** The engine CLI's version. Empty for the HTTP engines, which have no CLI to ask. */
  version: string;
  /** Wall clock for the whole stage, including every repository it read. */
  elapsed_ms: number;
  /** How many repositories it was grounded in. `0` is the story judged on its text alone. */
  repos_read: number;
}

export interface WorkItemReviewResult extends ReviewProvenance {
  review: WorkItemReview;
}

/** One saved review session, as the history lists it. */
export interface WorkItemReviewRow {
  id: string;
  workspace_id: string;
  ado_org: string;
  work_item_id: number;
  work_item_type: string;
  work_item_url: string;
  title: string;
  /** The session as JSON — see `ReviewSessionPayload` in the review store. */
  payload: string;
  engine: string;
  model: string;
  version: string;
  created_at: string;
  updated_at: string;
}
