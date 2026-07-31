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
}

/** A saved GitHub connection — one per host (github.com or an Enterprise Server). Persisted as
 * the `github_connections` app-setting (JSON); the token itself lives in the OS keychain. */
export interface GithubConnection {
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
  /** `github:host/owner/repo` or `azure:org/project/repoId`. */
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

export type VcsProvider = "azure" | "github";

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
