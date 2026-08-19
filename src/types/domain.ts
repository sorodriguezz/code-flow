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

/**
 * What a ref drawn against a commit is: a local branch, a remote-tracking branch, or a tag.
 *
 * Sent by the backend rather than guessed here, because it cannot be guessed: `v2.0.1` looks like a
 * release and usually is one, but nothing stops a branch being called that, and `origin/main` looks
 * remote only by a convention that a local branch is free to imitate. See `git/graph.rs`.
 */
export type RefKind = "branch" | "remote" | "tag";

export interface CommitRef {
  /** The shorthand: "main", "origin/main", "v1.0". */
  name: string;
  kind: RefKind;
}

export interface CommitInfo {
  id: string;
  short_id: string;
  summary: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  parent_ids: string[];
  /** Ordered by the backend: local branches, then tags, then remotes. */
  refs: CommitRef[];
}

export interface BranchInfo {
  name: string;
  is_head: boolean;
  is_remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  target: string | null;
  /** Tip commit time, Unix seconds UTC — the backend orders on this, HEAD pinned first. Null only for
   *  a ref that can't be peeled. */
  tip_time: number | null;
  /** Locked against merges onto it and pushes of it, by this branch's own padlock or by the
   * app-wide rule list. Always false when remote. */
  is_locked: boolean;
  /** True only when the lock comes from the rule list rather than from a padlock clicked on this
   * branch — which is what lets the padlock say where its lock came from. */
  locked_by_rule: boolean;
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
  /** libgit2's own binary flag. `status` cannot stand in for it — a changed PNG is `"modified"`
   *  just like a changed source file, and both arrive with no hunks — so this is the only thing
   *  that lets a viewer say "binary file" instead of guessing from an empty diff. */
  binary: boolean;
  hunks: DiffHunkInfo[];
}

/**
 * One hunk, sent back down to `stage_hunk` / `unstage_hunk` / `discard_hunk` so the backend can
 * **find** that hunk — never so it can apply it.
 *
 * Nothing here is a patch, and that is the whole design. `src-tauri/src/git/hunk.rs` recomputes the
 * diff itself and applies its *own* hunk, the one whose fingerprint matches this, or refuses and
 * touches nothing. The alternative — building unified-diff text here and handing it to libgit2 —
 * would make this file the author of bytes that land in the user's working tree, where a mistake in
 * a `@@` count or a `\r` is a corrupted file with no reflog to recover from.
 *
 * So this is a copy of what the peek drew, verbatim: pass a `DiffHunkInfo` straight through from
 * `workingDiff`/`stagedDiff` and add the path. Snake_case because there is no codegen between the
 * two languages and serde reads these names literally — a rename on either side is a
 * deserialization failure at the IPC boundary, which is what `hunk.rs`'s
 * `the_wire_shape_matches_the_hand_written_typescript` exists to catch.
 */
export interface HunkRef {
  /** Repo-relative, POSIX separators — the same form as `OpenTab.path`. */
  file_path: string;
  /** The `@@` header, exactly as `DiffHunkInfo.header` carries it. */
  header: string;
  /** Every line of the hunk, in order, exactly as `DiffHunkInfo.lines` carries them. */
  lines: DiffLine[];
}

/**
 * One run of consecutive lines that all came from the same commit — the unit a blame comes back in.
 *
 * Runs rather than lines, and that is what makes the annotation affordable: a 5,000-line file is
 * tens-to-hundreds of these, where the per-line form would be 5,000 objects each carrying its own
 * copy of the author's name and email across IPC. Finding the owner of a line is a binary search
 * over `start_line`, which is why the backend guarantees the list is ascending and gap-free — see
 * `git/blame.rs`.
 */
export interface BlameHunkInfo {
  /** First line of the run, counting from 1. */
  start_line: number;
  line_count: number;
  /** Empty when `uncommitted`. */
  commit_id: string;
  /** First 7 of `commit_id` — the same abbreviation the graph shows. */
  short_id: string;
  author_name: string;
  author_email: string;
  /** Unix seconds UTC, same unit as `CommitInfo.timestamp`. Zero when `uncommitted`. */
  timestamp: number;
  summary: string;
  /** Only present in the unsaved buffer that was blamed: nobody has committed it. Everything above
   *  is empty or zero in that case, deliberately — the UI renders a fixed string for these. */
  uncommitted: boolean;
  /** The author is whoever *this repository* commits as (a per-repo `user.email` wins over the
   *  global one), which is what lets the annotation say "You" without mislabelling a namesake. */
  is_me: boolean;
}

/**
 * Why a file could not be blamed, or that it could.
 *
 * A union rather than a free string, following `RefKind`: an empty `hunks` cannot distinguish "git
 * has never seen this file" from "this file is empty", and those two are worded differently on
 * screen. Sent by the backend because only it knows — the answer comes from HEAD's tree, not from
 * the working copy the frontend can see.
 */
export type BlameState = "ok" | "untracked" | "binary" | "nohead";

export interface FileBlame {
  state: BlameState;
  /** Ascending by `start_line` and covering every line, so a lookup never has to handle a gap.
   *  Empty for every `state` other than `"ok"`, and for an empty file. */
  hunks: BlameHunkInfo[];
  /** The commit these hunks were computed against. The cache keys on it, which is how a commit,
   *  checkout, reset or rebase invalidates without an event: the key changes. Empty for `"nohead"`. */
  head_oid: string;
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
  /**
   * This finding rendered as a pull-request comment, written when the run was saved.
   *
   * Optional because it is read out of a JSON blob that may have been written by an older build:
   * runs recorded before the field existed, and findings carried forward from one, simply do not
   * have it. A client that publishes from the stored memory rather than from the parsed review — the
   * mobile one — must treat its absence as "this finding cannot be published from here" rather than
   * substituting the subtitle, which posts an unanchored one-liner and then owns the thread for
   * good (see `apply_post_outcome`).
   */
  comentario_md?: string;
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

/** What a chain was made by. Both run through the same scheduler; only the panes differ. */
export type ChainKind = "chain" | "story";

/** Which half of a story run a step belongs to. `""` on every step of an ordinary chain. */
export type ChainStepPhase = "" | "analyze" | "implement";

/** An ordered plan of agent steps across one or more repositories. */
export interface AgentChain {
  id: string;
  /** The **first** repository of the set, and the one a step that names none falls back to. Every
   * workspace-scoped query joins `projects` through this column. */
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
  /** Step runs started, ever — the budget a looping plan spends. `step_count` stopped being the
   * bound once a step could send the plan backwards. */
  dispatches: number;
  created_at: string;
  updated_at: string;
  kind: ChainKind;
  /** The work item a `story` chain was built from. Empty on every ordinary chain. */
  work_item_provider: string;
  work_item_org: string;
  work_item_id: number;
  work_item_key: string;
  work_item_url: string;
  work_item_title: string;
  /** How many repositories the chain works across. A count, not the list — the tree draws a badge
   * and the detail pane asks for the names. */
  repo_count: number;
}

/** One repository a chain works across. `name` is empty once it has left the workspace. */
export interface ChainRepo {
  project_id: string;
  name: string;
  position: number;
}

/**
 * What one poll of a recovered step found.
 *
 * `chain` and `gone` are separate answers because the poller has to tell "the turn is still out
 * there" from "there is nothing left to wait for". They used to share one `null`, so a step deleted
 * with its chain — or cascaded away with the repository the chain was filed under — read as
 * "not yet" and was asked about every few seconds until the poller's own timeout gave up.
 */
export interface HarvestOutcome {
  chain: AgentChain | null;
  gone: boolean;
}

/**
 * A plan parked on a human decision, listed across **every** workspace.
 *
 * The one chain shape that is not workspace-scoped, and the status bar is why: it is the app's
 * single answer to "is anything waiting on me?", so an answer scoped to whichever workspace happens
 * to be open is one the user has to re-ask everywhere else before they can trust it. A gate is a
 * plan that has *stopped*, which makes an invisible one the most expensive thing to miss.
 *
 * Slim by design — one line of a narrow panel. Everything else is a `getChainDetail` away, after the
 * click has crossed into its workspace.
 */
export interface GatedChain {
  chain_id: string;
  /** Resolved through the chain's first repository at read time; `agent_chains` has no workspace
   *  column of its own. */
  workspace_id: string;
  /** The repository of the step it is waiting on — not necessarily the chain's first. */
  project_id: string;
  title: string;
  goal: string;
}

export interface AgentChainStep {
  id: string;
  chain_id: string;
  step_index: number;
  /** Which repository *this* step runs in. Always set — a chain across three repositories is three
   * sets of steps, each naming its own. */
  project_id: string;
  /** That repository's name, joined at read time. Empty once it has left the workspace. */
  project_name: string;
  phase: ChainStepPhase;
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
  /** See `NewChainStep.check_command`. */
  check_command: string;
  /** See `NewChainStep.on_pass`. Already remapped to real step indices. */
  on_pass: number;
  /** See `NewChainStep.on_fail`. Already remapped to real step indices. */
  on_fail: number;
  /** Why the plan was sent back here, written by the step that rejected the work. Cleared when this
   * step passes. */
  feedback: string;
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
  /** Which repository this step runs in. The id as well as the name, because deleting a repository
   * has to find every chain with a step in it — including the ones that survive the cascade. */
  project_id: string;
  project_name: string;
  phase: ChainStepPhase;
}

/** Every repository, for a step that should run in all of them. Expanded into one row per
 * repository when the chain is created, so the plan on disk stays a flat list. */
export const ALL_REPOS = "*";

/**
 * A blank authored step, with whatever the caller wants to differ patched over it.
 *
 * A factory rather than an object literal at each site, because of one field: `on_pass`/`on_fail`
 * default to **-1** — "the following step" and "retry this one" — and `0` does not mean "unset", it
 * means *jump to the first step*. A site that forgot them and let TypeScript fill in zeroes would
 * author a plan that loops forever, and would compile.
 */
export function blankChainStep(patch: Partial<NewChainStep> = {}): NewChainStep {
  return {
    agent_id: "",
    instruction: "",
    gate: false,
    project_id: "",
    phase: "",
    check_command: "",
    on_pass: -1,
    on_fail: -1,
    ...patch,
  };
}

/** One step as the dialog authors it, before anything is snapshotted. */
export interface NewChainStep {
  agent_id: string;
  instruction: string;
  gate: boolean;
  /** A repository id, `""` for the chain's first one, or `ALL_REPOS` for every one it has. */
  project_id: string;
  phase: ChainStepPhase;
  /** A shell command run in this step's repository once the turn lands. Exit code 0 is the whole
   * verdict. `""` is a step with no check, which advances on having answered. */
  check_command: string;
  /** Where to continue when the check passes, as a position in the plan *as authored*. `-1` is the
   * next step. Expansion of an "every repository" step remaps these, so they always mean the row
   * the dialog shows. */
  on_pass: number;
  /** Where to continue when the check fails. `-1` retries this step. A value below its own position
   * is the loop — the reviewer sending the implementer back. */
  on_fail: number;
}

/** What a step's declared check said when it ran.
 *
 * `ran: false` covers both "this step has no check" and "its repository is gone", and is kept
 * distinct from `passed` on purpose: a chain that reported every unchecked step as verified would
 * be worse than one with no checks at all. */
export interface StepCheck {
  ran: boolean;
  passed: boolean;
  /** The process's own stdout and stderr, which is what gets fed back to the agent asked to fix it. */
  output: string;
}

/** The work item a story run is built from, as the dialog resolves it. `body` is the story's prose
 * already flattened to text — the board clients answer in HTML, and the renderer lives here. */
export interface NewStoryWorkItem {
  provider: string;
  org: string;
  id: number;
  key: string;
  url: string;
  title: string;
  body: string;
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
  /** Every repository the chain works across, in the order they were picked. Never empty. */
  repos: ChainRepo[];
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
  /** Kept by a template, unlike the repository: a check command and "if this fails go back to step
   * 2" mean the same thing in any workspace. */
  check_command: string;
  on_pass: number;
  on_fail: number;
}

export interface WorkspaceSkill {
  id: string;
  workspace_id: string;
  skill_name: string;
  source_repo: string;
  enabled: boolean;
  installed_at: string;
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

/** One thing the first-launch check looked at, and what it found. `id` is a stable key — never
 *  shown raw — while `detail` is the machine's own words (a version string, or the error) and is
 *  deliberately untranslated: it is a quotation, not a sentence of ours. See `requirements.rs`. */
export interface Requirement {
  id: string;
  ok: boolean;
  detail: string;
}

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

/**
 * One shell on the agent console's terminal bench.
 *
 * The row survives; the shell does not. A pty belongs to the process that opened it, so quitting
 * the app ends every one of them — what is stored is enough to put the same shell back in the same
 * directory with everything it had already said still on screen.
 *
 * `session_id` is the live half and is `null` far more often than it looks: after a restart every
 * terminal on the bench has one until it is resumed. The bench draws a row either way; what
 * changes is whether opening it attaches to a running shell or starts a new one under the replay.
 *
 * Deliberately never in a backup — see `NEVER_BACKED_UP` in `backup/snapshot.rs`.
 */
/** One tab of the bench. `layout` is the JSON pane tree — opaque everywhere but
 *  `lib/bench/layout.ts`, which is also where a stale or corrupt one is repaired. */
export interface BenchTab {
  id: string;
  workspace_id: string;
  /** Empty until renamed; the bench then names the tab after the shells in it. */
  title: string;
  layout: string;
  sort_order: number;
  created_at: string;
}

/** The whole bench in one reply. The two halves are only meaningful together — see the Rust
 *  `Bench` for why they are not fetched separately. */
export interface Bench {
  tabs: BenchTab[];
  terminals: BenchTerminal[];
}

export interface BenchTerminal {
  id: string;
  workspace_id: string;
  /** Which `BenchTab` this shell is a pane of. */
  tab_id: string;
  title: string;
  cwd: string;
  /** Empty means the configured default profile, resolved when the shell opens — not a fixed
   *  shell, so changing the default in Settings reaches these too. */
  profile_id: string;
  /** Everything the shell printed, capped at ~256 KB by the backend. */
  transcript: string;
  sort_order: number;
  created_at: string;
  session_id: string | null;
}

// ---------- user stories (wiki in, Azure Boards out) ----------

/** One wiki of an Azure DevOps project. `kind` is `projectWiki` or `codeWiki`. */
export interface AdoWiki {
  id: string;
  name: string;
  kind: string;
  /** The Git repository behind the wiki — where a page's history lives. Empty when the host did
   *  not report one. */
  repository_id: string;
}

/** One wiki page as Azure holds it right now: its Markdown, and who has touched it.
 *
 * The history fields are best effort and are empty when unknown — a PAT that can read pages cannot
 * always read the repository they live in. An empty string means "the app does not know", never
 * "nobody". */
export interface AdoWikiPageDetail {
  path: string;
  title: string;
  content: string;
  url: string;
  created_by: string;
  created_at: string;
  modified_by: string;
  modified_at: string;
  /** Commits that touched this page, capped by the backend. `0` when the history is unreadable. */
  revisions: number;
  /** Whether there is more history than was read — with it, the creation is genuinely unknown. */
  history_truncated: boolean;
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

/**
 * Which board a story set publishes to, or a review session reads from.
 *
 * `""` is a saved target that predates the others and means Azure — the backend applies the same
 * rule, so an older row and a newer one land on the same client rather than on none.
 */
export type BoardProvider = "azure" | "jira" | "monday";

/** Where inside the container a published story lands — "User Story" on Azure Agile, "Story" on
 * Jira, a group on monday. Read from the host, never assumed. */
export interface BoardItemType {
  name: string;
  /** What the create call actually sends: Azure's reference name, Jira's issue type id, monday's
   * group id. */
  reference_name: string;
  description: string;
  /** Hex without the leading `#`. Empty on the hosts that don't colour these. */
  color: string;
  /** Jira sub-task types, which cannot be created at the top level. Always false elsewhere. */
  subtask: boolean;
}

/** One node of the area or iteration tree. `path` is already in the form the work item field
 * takes (`Proyecto\Área\Sub`). */
export interface AdoClassificationNode {
  path: string;
  name: string;
  depth: number;
}

/**
 * Which of a monday.com board's columns this app matched to a story's parts.
 *
 * Only monday has this, and that is the difference between it and the other two boards rather than
 * a quirk: Azure has `System.Description` and Jira has `description`, but a monday board has only
 * the columns somebody made, with ids that are per-board. So the mapping is detected by column
 * **type** and reported here — a story published into a mapping the user never saw is one they
 * cannot check.
 */
export interface MondayBoardSchema {
  /** Where the narrative, description and criteria go. `null` means this board cannot hold a story
   * at all, which the panel says outright rather than discovering at publish time. */
  text_column: MondayColumn | null;
  /** Where the estimate goes. `null` publishes stories without their points rather than not at all. */
  numbers_column: MondayColumn | null;
}

export interface MondayColumn {
  id: string;
  /** The column's own title, so the panel can name which one it picked. */
  title: string;
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
  /** The prompt the last successful generation ran with, frozen at the moment it ran. `instructions`
   * above is what the *next* run will use, and the template is shared and editable, so neither can
   * answer "what did this set come out of?" afterwards. Empty until a generation has succeeded. */
  prompt_template: string;
  prompt_instructions: string;
  generated_at: string;
  /** Which board this set publishes to. `""` is a set that predates the others and means Azure. */
  board_provider: BoardProvider | "";
  /** The target, as three strings the board interprets: on Azure the organisation, the project and
   * the work item type; on Jira the site, the project key and the issue type id; on monday the
   * account slug, the board id and the group id. */
  ado_org: string;
  ado_project: string;
  work_item_type: string;
  /** Azure only — neither of the others has an equivalent, so both stay empty there. */
  area_path: string;
  iteration_path: string;
  /** Applied to every story of the batch, on top of the story's own. */
  tags: string;
  /** JSON array of strings: what the documentation left ambiguous. */
  open_questions: string;
  /** JSON array of `{question, answer}`: those questions once the team answered them. They
   * accumulate rather than being consumed — an answer is a requirement the documentation was
   * missing, and it stays true after the question stops being asked. */
  question_answers: string;
  /** JSON array of project ids: the repositories the acceptance criteria are checked against.
   * Deliberately not `project_id`, which records where the documentation came from. Several,
   * because one capability is routinely split across a service, its BFF and its jobs. */
  verify_project_ids: string;
  /** Where the `.feature` file is written — one of the repositories above. `null` falls back to the
   * first of the set. */
  feature_project_id: string | null;
  /** What the last verification ran on, and when. Empty until one has run. */
  verify_provider: string;
  verify_model: string;
  verified_at: string;
  status: StoryBatchStatus;
  last_error: string;
  created_at: string;
  updated_at: string;
}

/** One open question and what the team answered — a requirement the documentation was missing. */
export interface QuestionAnswer {
  question: string;
  answer: string;
}

/** Exactly what a generation sent to the model, rebuilt for reading.
 *
 * Two fields rather than one blob because they travel on two different channels: `prompt` is the
 * engine's prompt argument (the standing instructions), `stdin` is this set's own payload. */
export interface StoryBatchPrompt {
  prompt: string;
  stdin: string;
  /** `true` when these are the pieces the run actually used; `false` when the set predates the
   * snapshot and this is a reconstruction from today's template and today's instructions. */
  from_snapshot: boolean;
  generated_at: string;
  provider: string;
  model: string;
  /** The documentation was longer than one payload and got cut at the ceiling. */
  truncated: boolean;
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
  /** Hours, which is a different question from the points above: points size the story against
   * the rest of the backlog, hours are what a sprint's capacity is planned against. Azure keeps
   * both. `0` leaves the field alone. */
  original_estimate: number;
  tags: string;
  notes: string;
  /** `0` until published; the host's numeric id afterwards, which is what stops a duplicate. */
  work_item_id: number;
  /** What the board calls it out loud — Jira's `PROJ-123`. Empty on Azure, where the card falls
   * back to `#id`. */
  work_item_key: string;
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

/**
 * What a pasted work-item reference resolved to. `org`/`project` are null for a bare id or key.
 *
 * `id` is `0` on Jira until the issue is fetched: a Jira URL carries `PROJ-123` and never the
 * numeric id, so the key is the identifier the screen has to hold on to.
 */
export interface WorkItemRef {
  /** The Azure organisation, or the Jira site. */
  org: string | null;
  project: string | null;
  id: number;
  /** Jira's `PROJ-123`. Empty on the other two, where the numeric id is the whole address. */
  key: string;
  provider: BoardProvider;
}

/** A child of a user story — the tasks it already has. */
export interface BoardWorkItemChild {
  id: number;
  url: string;
  /** Jira's `PROJ-123`; empty on Azure. */
  key: string;
  work_item_type: string;
  title: string;
  state: string;
  /** What the task says, as Azure stores it — HTML, shown through `htmlToText`. */
  description_html: string;
  /** Display name of whoever it is assigned to. Empty when nobody is. */
  assigned_to: string;
}

/**
 * One work item, whichever board it came from. The prose fields arrive as HTML — Azure stores them
 * that way and the Jira client converts on the way out — and are turned into text by `workItemHtml`,
 * which is also what gets sent to the review, so the story that was judged is the one on screen.
 */
export interface BoardWorkItem {
  id: number;
  url: string;
  /** Jira's `PROJ-123`; empty on Azure. */
  key: string;
  work_item_type: string;
  title: string;
  state: string;
  team_project: string;
  /** The same container, by whatever identifier a write to it takes: Azure's project name, Jira's
   * project key, monday's numeric board id. Empty falls back to `team_project`, which is what the
   * first two use for both. */
  container_id: string;
  description_html: string;
  /** Where an Azure **Bug** actually keeps its prose — the Agile and Scrum bug forms have no
   *  description. Always empty on the other two, which have no such field. */
  repro_steps_html: string;
  /** Environment, version, OS. Azure only. */
  system_info_html: string;
  acceptance_criteria_html: string;
  /** `0` means "not estimated", which for a Basic-process item is the only possible answer. */
  effort: number;
  /** The field the estimate came out of, so the UI can name it instead of inventing one. */
  effort_field: string;
  tags: string;
  /** Azure only; empty on the other two. */
  area_path: string;
  iteration_path: string;
  children: BoardWorkItemChild[];
}

/**
 * What is being reviewed, which decides what "well written" means.
 *
 * A story is judged by INVEST; a bug by whether anyone can reproduce it. Only the analysis stage
 * branches on this — criteria and tasks are the same job either way.
 */
export type WorkItemKind = "story" | "bug";

/**
 * Which question one review run is asking.
 *
 * One per tab of the review screen, plus `tasksqa` — the QA ladder is its own run because it is
 * its own prompt. `analyze` predates the tab split and is no longer run from anywhere; it stays
 * because saved sessions carry its answer and still have to open.
 */
export type WorkItemReviewStage = "analyze" | "description" | "criteria" | "tasks" | "tasksqa";

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

/**
 * Which shape a criterion wants to be written in.
 *
 * Not a setting: a behaviour with a trigger and an observable result is a scenario, and a set of
 * conditions with no flow is a list. The model decides per criterion, and `ambos` is its honest
 * "I cannot tell" — both texts come back filled and the user picks which one goes to the draft.
 */
export type CriterionFormat = "gherkin" | "checklist" | "ambos";

export interface ProposedCriterion {
  /** A few words naming what the criterion is about. Published as a bold first line inside it,
   *  which is what the draft pane collapses each criterion down to. Empty is allowed. */
  title: string;
  /** The vertical slice it belongs to — `Slice 1 – Persistencia`. Criteria that have to ship
   *  together carry the same string. Empty when the story does not divide. */
  slice: string;
  /** `ALTO` | `MEDIO` | `BAJO`, normalised by the backend, or empty when it declined to judge. */
  risk: string;
  format: CriterionFormat;
  /** One whole Gherkin scenario. Empty when `format` is `checklist`. */
  gherkin: string;
  /** The same requirement as a verification list, one condition per line. */
  checklist: string;
  rationale: string;
  /** The 1-based number of the story's criterion this rewrites, or `0` when it is new. */
  replaces: number;
  evidence: string[];
  repo: string;
}

export interface ProposedTask {
  kind: "dev" | "qa";
  /** Already carries its `[DEV]`/`[QA]` prefix — the backend puts it on. */
  title: string;
  /** The three questions as the one block of prose the board has a field for. */
  detail: string;
  /** ¿Qué? — what is being built or changed. */
  what: string;
  /** ¿Cómo? — the approach, and in which files. */
  how: string;
  /** ¿Para qué? — which behaviour or criterion it covers. */
  why: string;
  evidence: string[];
  repo: string;
  /**
   * How long the task should take, in hours, and how urgent it is on Azure's 1-4 scale.
   *
   * Proposed by the run and editable on the card: what publishes is what is on screen when the
   * user hits publish. `0` on either means "unset", which publishes the task without the field
   * rather than with a number nobody stands behind.
   */
  estimate_hours: number;
  priority: number;
}

/** Tagged by stage, so the caller reads the shape it asked for. */
export type WorkItemReview =
  | { stage: "analyze"; summary: string; invest: InvestVerdict[]; findings: ReviewFinding[] }
  /** An empty `description` is "the current one is already fine", not a failed run. */
  | { stage: "description"; description: string; rationale: string; evidence: string[] }
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
export interface BoardItemRef {
  id: number;
  /** The page a human opens, not the REST resource. */
  url: string;
  /** Jira's `PROJ-123`; empty on Azure. */
  key: string;
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

/** One engine's slice of a statistics window. */
export interface ProviderStat {
  provider: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  costed_runs: number;
}

/** One model of one engine. `model` is empty when the CLI picked for itself and never said which. */
export interface ModelStat {
  provider: string;
  model: string;
  runs: number;
  tokens: number;
  cost_usd: number;
  costed_runs: number;
}

/**
 * One feature's slice of a window — which *part of the app* spent the tokens, as opposed to which
 * engine answered. `task` is one of the ids in `AI_TASK_LABELS`, or empty for rows recorded before
 * the app labelled them.
 */
export interface TaskStat {
  task: string;
  runs: number;
  tokens: number;
  cost_usd: number;
  costed_runs: number;
}

/** One column of the usage chart, closed at `start` and open at the next one. */
export interface UsageBucket {
  start: string;
  runs: number;
  tokens: number;
  cost_usd: number;
}

/** Everything the statistics screen draws, for one window. */
export interface UsageStats {
  /** Echoed back so a late answer cannot be drawn under the heading of a window the user has since
   * moved away from. */
  window_hours: number;
  bucket_minutes: number;
  /** Gap-filled: every bucket of the window is present, including the empty ones. */
  series: UsageBucket[];
  providers: ProviderStat[];
  models: ModelStat[];
  /** Busiest first. A feature missing from here spent nothing in the window. */
  tasks: TaskStat[];
  /** The busiest single bucket, as tokens — the chart's scale. */
  peak_tokens: number;
  since: string;
}

/**
 * One window of a provider's plan, as the provider itself reported it.
 *
 * The counterpart to `ProviderStat`: that one is what this app measured, this one is what the
 * provider published. Nothing here is derived from the other — a percentage computed from spend
 * would be a guess wearing a limit's clothes.
 */
export interface QuotaLimit {
  /** `"session"`, `"weekly"`, or `"model"` for a per-model bucket. Translated in the UI. */
  kind: string;
  /** The provider's own name for the bucket — a model id or scope label — when `kind` alone does
   * not identify it. Empty when it does. */
  scope: string;
  /** How much of the limit has been **consumed**, 0–100. Normalised in the backend so every
   * surface that draws it agrees on the direction. */
  used_percent: number;
  /** RFC 3339 of when the window rolls over, or `""` when the provider did not say. */
  resets_at: string;
}

/** Every limit one provider published, or why there are none. */
export interface ProviderQuota {
  provider: string;
  /** Tightest first — the limit about to run out is the one worth reading. */
  limits: QuotaLimit[];
  /** The plan the limits belong to, when the provider names it. */
  plan: string;
  /** `"signed_out"`, `"stale"`, or a transport error. Empty when the read succeeded. */
  error: string;
  /** RFC 3339 of when the numbers were read from the provider — a cached answer keeps its own, so
   * the UI can tell how old it is. */
  fetched_at: string;
}

/**
 * One reading of every installed provider that publishes limits, plus which of them this install
 * routes work to.
 *
 * Two surfaces, two answers to "whose plan is this". The panel draws every provider — an engine
 * installed and signed in is one of yours whether or not a task points at it today. The status pill
 * is one worst number and compares `routed` only, so it cannot go red over a plan nobody is
 * spending.
 */
export interface QuotaReport {
  providers: ProviderQuota[];
  /** Provider ids the global default or a per-task override points at. */
  routed: string[];
}

/**
 * The machine's power situation, when it has one.
 *
 * The command returns `null` for a machine with no battery — a desktop — and the UI draws nothing
 * for it. A permanently full icon is a pixel that never changes and stops being read.
 */
export interface PowerStatus {
  /** 0–100, across every battery the machine has. */
  percent: number;
  /** Whether mains power is connected. */
  plugged_in: boolean;
  /** Whether it is actively taking charge — distinct from `plugged_in`, since a laptop sitting at
   * 100% on the mains is plugged in and charging nothing. */
  charging: boolean;
  /** Runway at the current rate: to empty while discharging, to full while charging. `null` when
   * the OS will not estimate it, which it routinely refuses to do just after a cable is moved. */
  minutes_left: number | null;
}

/**
 * What the machine is doing right now, and how much of it is us.
 *
 * Both halves come from one refresh on the Rust side (`sysload.rs`), which is the point: the bar
 * shows the machine and the panel behind it shows this app's share, and two numbers read a second
 * apart would be describing two different moments.
 *
 * Every percentage is 0–100 against the *whole machine*, `app_cpu_percent` included — sysinfo
 * reports a process per-core (400% on four busy cores) and the backend divides that down, so the
 * app's figure can never exceed the machine's figure it sits under.
 */
export interface SystemLoad {
  cpu_percent: number;
  /** What `cpu_percent` is a percentage of, and what the app's per-core figure was divided by. Sent
   * rather than read from `navigator.hardwareConcurrency`, which browsers may round down. */
  cpu_cores: number;
  mem_percent: number;
  /** Bytes. Formatted at render time so the unit follows the reader, not the wire. */
  mem_used: number;
  mem_total: number;
  disk_percent: number;
  disk_used: number;
  disk_total: number;
  /** The volume the percentage is about — the one home is on. Named, because a machine has several
   * and a bare disk percentage is a number about nothing. */
  disk_mount: string;
  /** This app **and everything it launched**: the webview process, agent CLI turns, terminals.
   * Reporting the main process alone would answer 0.3% while a run has three cores busy. */
  app_cpu_percent: number;
  app_mem: number;
  /** `app_mem` as a share of `mem_total` — us against everything else on the machine. */
  app_mem_percent: number;
  /** How many processes that tree came to — the line that explains the two figures above it. */
  app_processes: number;
}

// ---------------------------------------------------------------------------
// Remote control
// ---------------------------------------------------------------------------

/**
 * The remote-control server, as the settings panel sees it.
 *
 * `enabled` and `running` are two different facts and the panel shows both: the first is the
 * stored preference (what happens at the next launch), the second is whether a socket is bound
 * right now. They disagree when the port was taken at startup — a real case on a developer's
 * machine — and collapsing them into one boolean would make that look like the toggle not working.
 */
export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** The address to type into a phone. Absent when the server is off, or when this machine has no
   *  non-loopback address to advertise (offline, or every interface is a VPN). */
  url: string | null;
  /** Whether a pairing code is on screen right now. */
  pairing: boolean;
  /**
   * Whether paired devices may open and drive a shell.
   *
   * Its own switch rather than part of `enabled`, because it is its own decision: everything else
   * a phone can do is a specific act with a specific blast radius, and a shell is arbitrary code
   * execution on this machine. Turning the server on must not silently mean this too.
   */
  allow_terminal: boolean;
}

/**
 * A shell a paired device has running on this machine right now.
 *
 * There is no stored row behind this and there deliberately is not one: it is a live pty and nothing
 * else, so the list is empty the moment the app restarts. It exists because a shell started from a
 * phone left no trace anywhere in the desktop UI — not the dock, not the bench — and "what is
 * running on my computer" is a question the person at the machine is entitled to an answer to.
 */
export interface RemoteTerminal {
  id: string;
  /** Where the shell started. The resolved directory, so a session opened with no path shows the
   *  home directory it actually landed in rather than an empty string. */
  cwd: string;
  /** The shell profile's name — "zsh", "PowerShell" — not the command line. */
  profile: string;
  /** The device that opened it, by id. Resolved against the device list for a name to show; the raw
   *  id is the fallback rather than a placeholder, because a session whose device has been forgotten
   *  is still a real process and mislabelling it would be worse than showing a uuid. */
  owner: string | null;
}

/** A phone or tablet that has been paired. Carries no credential — see the `remote_devices` table. */
export interface RemoteDevice {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked: boolean;
  /**
   * Whether the device is holding an open event socket right now.
   *
   * The question `last_seen_at` cannot answer: a WebSocket authenticates once, when it is opened,
   * so a phone driving the machine all afternoon writes that column exactly once and then looks
   * like a device that connected at lunchtime and left. This comes from the desktop's live socket
   * map instead, and it is the field the panel's dot is drawn from.
   */
  connected: boolean;
}
