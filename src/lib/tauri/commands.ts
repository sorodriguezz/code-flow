import { invoke } from "@tauri-apps/api/core";
import type {
  ActivityLogEntry,
  AdoProject,
  AdoRepo,
  AutoLinkResult,
  BranchInfo,
  ChatConversationSummary,
  CommitInfo,
  ConflictFile,
  FileDiffInfo,
  FileEntry,
  GitIdentity,
  JobHistoryEntry,
  MergeOutcome,
  NewProject,
  PrActionOutcome,
  PrCommentThread,
  PrDecision,
  PrDescriptionDraft,
  PrLinkActionOutcome,
  PrLinkResolution,
  Project,
  PullRequestSummary,
  RemoteInfo,
  RepoStatusInfo,
  ReviewContext,
  SecretHit,
  ShellProfile,
  StashInfo,
  TerminalOpened,
  ReviewRunDetail,
  ReviewRunSummary,
  Workspace,
  WorkspaceActivityEntry,
  WorkspaceAgent,
  WorkspaceMcp,
  WorkspaceSkill,
} from "../../types/domain";
import type { FindingLocation } from "../parseAnalysis";

// ---------- app lifecycle ----------

export const quitApp = () => invoke<void>("quit_app");

export const resetAppData = () => invoke<void>("reset_app_data");

// ---------- workspaces / projects ----------

export const pickFolder = () => invoke<string | null>("pick_folder");

export const defaultCloneDir = () => invoke<string>("default_clone_dir");

export const createWorkspace = (name: string, icon: string, color: string) =>
  invoke<Workspace>("create_workspace", { name, icon, color });

export const listWorkspaces = () => invoke<Workspace[]>("list_workspaces");

export const deleteWorkspace = (id: string) => invoke<void>("delete_workspace", { id });

export const updateWorkspaceColor = (id: string, color: string) =>
  invoke<void>("update_workspace_color", { id, color });

export const renameWorkspace = (id: string, name: string) => invoke<void>("rename_workspace", { id, name });

export const createProject = (input: NewProject) => invoke<Project>("create_project", { input });

export const listProjects = (workspaceId: string) =>
  invoke<Project[]>("list_projects", { workspaceId });

export const getProject = (id: string) => invoke<Project | null>("get_project", { id });

export const deleteProject = (id: string) => invoke<void>("delete_project", { id });

export const moveProjectToWorkspace = (id: string, workspaceId: string) =>
  invoke<void>("move_project_to_workspace", { id, workspaceId });

export const updateProjectColor = (id: string, color: string) =>
  invoke<void>("update_project_color", { id, color });

// ---------- git: read ----------

export const getStatus = (repoPath: string) => invoke<RepoStatusInfo>("get_status", { repoPath });

export const listCommits = (repoPath: string, allRefs: boolean, limit: number) =>
  invoke<CommitInfo[]>("list_commits", { repoPath, allRefs, limit });

export const listUnpushedCommits = (repoPath: string) =>
  invoke<CommitInfo[]>("list_unpushed_commits", { repoPath });

export const listBranches = (repoPath: string) => invoke<BranchInfo[]>("list_branches", { repoPath });

export const listStashes = (repoPath: string) => invoke<StashInfo[]>("list_stashes", { repoPath });

export const getWorkingDiff = (repoPath: string) =>
  invoke<FileDiffInfo[]>("get_working_diff", { repoPath });

export const getStagedDiff = (repoPath: string) =>
  invoke<FileDiffInfo[]>("get_staged_diff", { repoPath });

export const getCommitDiff = (repoPath: string, oid: string) =>
  invoke<FileDiffInfo[]>("get_commit_diff", { repoPath, oid });

// ---------- git: branches ----------

export const createBranch = (repoPath: string, name: string, startPoint?: string) =>
  invoke<void>("create_branch", { repoPath, name, startPoint: startPoint ?? null });

export const deleteBranch = (repoPath: string, name: string, isRemote: boolean) =>
  invoke<void>("delete_branch", { repoPath, name, isRemote });

export const setBranchLocked = (repoPath: string, name: string, locked: boolean) =>
  invoke<void>("set_branch_locked", { repoPath, name, locked });

export const checkoutLocalBranch = (repoPath: string, name: string) =>
  invoke<void>("checkout_local_branch", { repoPath, name });

export const checkoutDetached = (repoPath: string, refname: string) =>
  invoke<void>("checkout_detached", { repoPath, refname });

export const checkoutRemoteTracking = (repoPath: string, remoteBranch: string) =>
  invoke<string>("checkout_remote_tracking", { repoPath, remoteBranch });

export const resetToCommit = (repoPath: string, oid: string, mode: "soft" | "mixed" | "hard") =>
  invoke<void>("reset_to_commit", { repoPath, oid, mode });

// ---------- git: stash ----------

export const stashSave = (repoPath: string, message: string | undefined, includeUntracked: boolean) =>
  invoke<void>("stash_save", { repoPath, message: message ?? null, includeUntracked });

export const stashApply = (repoPath: string, index: number) =>
  invoke<void>("stash_apply", { repoPath, index });

export const stashPop = (repoPath: string, index: number) => invoke<void>("stash_pop", { repoPath, index });

export const stashDrop = (repoPath: string, index: number) =>
  invoke<void>("stash_drop", { repoPath, index });

export const renameStash = (repoPath: string, index: number, newMessage: string) =>
  invoke<void>("rename_stash", { repoPath, index, newMessage });

// ---------- git: staging / commit ----------

export const stageFile = (repoPath: string, filePath: string) =>
  invoke<void>("stage_file", { repoPath, filePath });

export const stageAll = (repoPath: string) => invoke<void>("stage_all", { repoPath });

export const unstageFile = (repoPath: string, filePath: string) =>
  invoke<void>("unstage_file", { repoPath, filePath });

export const unstageAll = (repoPath: string) => invoke<void>("unstage_all", { repoPath });

export const discardFileChanges = (repoPath: string, filePath: string) =>
  invoke<void>("discard_file_changes", { repoPath, filePath });

/** Reverts every unstaged change and deletes every untracked file. Staged content survives. */
export const discardAllChanges = (repoPath: string) => invoke<void>("discard_all_changes", { repoPath });

export const commitChanges = (
  repoPath: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
) =>
  invoke<string>("commit", {
    repoPath,
    message,
    authorName: authorName ?? null,
    authorEmail: authorEmail ?? null,
  });

/** Scans the staged diff for hardcoded credentials. Empty array = clean. */
export const scanStagedSecrets = (repoPath: string) =>
  invoke<SecretHit[]>("scan_staged_secrets", { repoPath });

// ---------- git: remotes ----------

export const listRemotes = (repoPath: string) => invoke<RemoteInfo[]>("list_remotes", { repoPath });

export const setRemoteUrl = (repoPath: string, name: string, url: string) =>
  invoke<void>("set_remote_url", { repoPath, name, url });

// ---------- git: identity ----------

export const getGitIdentity = () => invoke<GitIdentity>("get_git_identity");

export const setGitIdentity = (name: string, email: string) =>
  invoke<void>("set_git_identity", { name, email });

// ---------- git: merge / conflicts ----------

export const mergeBranch = (repoPath: string, branchName: string) =>
  invoke<MergeOutcome>("merge_branch", { repoPath, branchName });

export const isMerging = (repoPath: string) => invoke<boolean>("is_merging", { repoPath });

export const listConflicts = (repoPath: string) => invoke<ConflictFile[]>("list_conflicts", { repoPath });

export const resolveConflictSide = (repoPath: string, relPath: string, side: "ours" | "theirs") =>
  invoke<void>("resolve_conflict_side", { repoPath, relPath, side });

export const markConflictResolved = (repoPath: string, relPath: string) =>
  invoke<void>("mark_conflict_resolved", { repoPath, relPath });

/** Proposes an AI-merged version of a conflicted file. Returns the resolved content (no markers). */
export const resolveConflictWithAi = (repoPath: string, relPath: string, runId?: string) =>
  invoke<string>("resolve_conflict_with_ai", { repoPath, relPath, runId });

export const completeMerge = (repoPath: string, message: string) =>
  invoke<string>("complete_merge", { repoPath, message });

export const abortMerge = (repoPath: string) => invoke<void>("abort_merge", { repoPath });

// ---------- terminal ----------

export const listShellProfiles = () => invoke<ShellProfile[]>("list_shell_profiles");

/** Omit `profileId` to open the configured default profile. The reply names the profile that
 * actually started, which is what the tab is titled after. */
export const openTerminal = (cwd: string, profileId?: string) =>
  invoke<TerminalOpened>("open_terminal", { cwd, profileId });

export const writeTerminal = (id: string, data: string) => invoke<void>("write_terminal", { id, data });

export const resizeTerminal = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_terminal", { id, cols, rows });

export const closeTerminal = (id: string) => invoke<void>("close_terminal", { id });

// ---------- git: remote (streamed) ----------

export const gitClone = (url: string, dest: string) => invoke<void>("git_clone", { url, dest });

export const gitFetch = (repoPath: string, remoteName?: string) =>
  invoke<void>("git_fetch", { repoPath, remoteName: remoteName ?? null });

export const gitPull = (repoPath: string) => invoke<void>("git_pull", { repoPath });

export const gitPush = (repoPath: string, setUpstream: boolean) =>
  invoke<void>("git_push", { repoPath, setUpstream });

// ---------- settings ----------

export const getSetting = (key: string) => invoke<string | null>("get_setting", { key });

export const setSetting = (key: string, value: string) => invoke<void>("set_setting", { key, value });

/** Models the given provider's CLI reports as available (e.g. `opencode models`). Empty for
 * providers whose CLI has no listing command — the caller falls back to a curated list. */
export const listAiModels = (provider: string) => invoke<string[]>("list_ai_models", { provider });

// AI provider API keys live in the OS keyring. There's deliberately no "get" — the key is only
// read backend-side when building a request, so the UI can only ask whether one is set.
export const setAiApiKey = (provider: string, key: string) =>
  invoke<void>("set_ai_api_key", { provider, key });

export const hasAiApiKey = (provider: string) => invoke<boolean>("has_ai_api_key", { provider });

export const deleteAiApiKey = (provider: string) => invoke<void>("delete_ai_api_key", { provider });

/** Opens an http(s) link in the default browser — e.g. a provider's billing page from its own
 * error message. Non-http schemes are rejected backend-side. */
export const openExternalUrl = (url: string) => invoke<void>("open_external_url", { url });

export interface ProviderStatus {
  available: boolean;
  /** Resolved path/endpoint when available; the missing binary name or connection error when not. */
  detail: string;
  /** What was actually checked — the configured binary path or endpoint. */
  binary: string;
}

/** Whether a provider's CLI is installed (or Ollama's endpoint answers), for the Settings badge. */
export const checkAiProvider = (provider: string) =>
  invoke<ProviderStatus>("check_ai_provider", { provider });

// ---------- workspace prompts (review standard, PR description) ----------

/** `kind` is "review_standard" | "pr_description" — provider-independent, per-workspace. */
export const getWorkspacePrompt = (workspaceId: string, kind: string) =>
  invoke<string>("get_workspace_prompt", { workspaceId, kind });

export const setWorkspacePrompt = (workspaceId: string, kind: string, content: string) =>
  invoke<void>("set_workspace_prompt", { workspaceId, kind, content });

export const defaultWorkspacePrompt = (kind: string) =>
  invoke<string>("default_workspace_prompt", { kind });

// ---------- SDD/Harness agents ----------

export const listWorkspaceAgents = (workspaceId: string) =>
  invoke<WorkspaceAgent[]>("list_workspace_agents", { workspaceId });

export const upsertWorkspaceAgent = (
  id: string | undefined,
  workspaceId: string,
  name: string,
  role: string,
  provider: string,
  model: string,
  prompt: string,
  enabled: boolean,
) =>
  invoke<WorkspaceAgent>("upsert_workspace_agent", {
    id: id ?? null,
    workspaceId,
    name,
    role,
    provider,
    model,
    prompt,
    enabled,
  });

export const deleteWorkspaceAgent = (id: string) => invoke<void>("delete_workspace_agent", { id });

// ---------- review memory (review_runs) ----------

export const listReviewRuns = (workspaceId: string) =>
  invoke<ReviewRunSummary[]>("list_review_runs", { workspaceId });

export const getReviewRun = (id: string) => invoke<ReviewRunDetail | null>("get_review_run", { id });

/** `estado` is "falso_positivo" | "ignorado" to mark, or "abierto" to clear the mark. */
export const markReviewFinding = (runId: string, findingId: string, estado: string, motivo?: string) =>
  invoke<void>("mark_review_finding", { runId, findingId, estado, motivo: motivo ?? null });

export const deleteReviewRun = (id: string) => invoke<void>("delete_review_run", { id });

export const deleteReviewRunsForPr = (projectId: string, prId: number) =>
  invoke<void>("delete_review_runs_for_pr", { projectId, prId });

export const purgeWorkspaceReviewRuns = (workspaceId: string) =>
  invoke<void>("purge_workspace_review_runs", { workspaceId });

/** Exports one run (by `id`) or all of the workspace's runs (`id` undefined) to `destDir`.
 * Returns how many runs were written. */
export const exportReviewRuns = (workspaceId: string, id: string | undefined, destDir: string) =>
  invoke<number>("export_review_runs", { workspaceId, id: id ?? null, destDir });

export const listReviewContexts = (workspaceId: string) =>
  invoke<ReviewContext[]>("list_review_contexts", { workspaceId });

export const upsertReviewContext = (
  id: string | undefined,
  workspaceId: string,
  name: string,
  content: string,
  enabled: boolean,
) =>
  invoke<ReviewContext>("upsert_review_context", {
    id: id ?? null,
    workspaceId,
    name,
    content,
    enabled,
  });

export const deleteReviewContext = (id: string) => invoke<void>("delete_review_context", { id });

// ---------- workspace skills ----------

export const listWorkspaceSkills = (workspaceId: string) =>
  invoke<WorkspaceSkill[]>("list_workspace_skills", { workspaceId });

export const installWorkspaceSkill = (workspaceId: string, sourceRepo: string, skillName: string) =>
  invoke<WorkspaceSkill>("install_workspace_skill", { workspaceId, sourceRepo, skillName });

export const removeWorkspaceSkill = (id: string) => invoke<void>("remove_workspace_skill", { id });

export const setWorkspaceSkillEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_workspace_skill_enabled", { id, enabled });

export const createCustomSkill = (workspaceId: string, name: string, skillMd: string) =>
  invoke<WorkspaceSkill>("create_custom_skill", { workspaceId, name, skillMd });

export const importSkillFromFolder = (workspaceId: string, srcDir: string) =>
  invoke<WorkspaceSkill>("import_skill_from_folder", { workspaceId, srcDir });

export const listSkillFiles = (workspaceId: string, skillName: string) =>
  invoke<string[]>("list_skill_files", { workspaceId, skillName });

export const readSkillFile = (workspaceId: string, skillName: string, relPath: string) =>
  invoke<string>("read_skill_file", { workspaceId, skillName, relPath });

export const writeSkillFile = (workspaceId: string, skillName: string, relPath: string, content: string) =>
  invoke<void>("write_skill_file", { workspaceId, skillName, relPath, content });

export const deleteSkillFile = (workspaceId: string, skillName: string, relPath: string) =>
  invoke<void>("delete_skill_file", { workspaceId, skillName, relPath });

// ---------- workspace MCP servers ----------

export const listWorkspaceMcps = (workspaceId: string) =>
  invoke<WorkspaceMcp[]>("list_workspace_mcps", { workspaceId });

export const upsertWorkspaceMcp = (
  id: string | undefined,
  workspaceId: string,
  name: string,
  command: string,
  args: string,
  env: string,
  enabled: boolean,
) =>
  invoke<WorkspaceMcp>("upsert_workspace_mcp", {
    id: id ?? null,
    workspaceId,
    name,
    command,
    args,
    env,
    enabled,
  });

export const deleteWorkspaceMcp = (id: string) => invoke<void>("delete_workspace_mcp", { id });

// ---------- secrets ----------

export const setAdoPat = (org: string, pat: string) => invoke<void>("set_ado_pat", { org, pat });

export const getAdoPat = (org: string) => invoke<string | null>("get_ado_pat", { org });

export const deleteAdoPat = (org: string) => invoke<void>("delete_ado_pat", { org });

export const setGithubToken = (host: string, token: string) =>
  invoke<void>("set_github_token", { host, token });

export const getGithubToken = (host: string) => invoke<string | null>("get_github_token", { host });

export const deleteGithubToken = (host: string) => invoke<void>("delete_github_token", { host });

/** Validates the token saved for `host`, returning the login it authenticates as. */
export const githubAuthenticatedUser = (host: string) =>
  invoke<string>("github_authenticated_user", { host });

// ---------- claude ----------

export const generateCommitMessage = (diff: string, runId?: string) =>
  invoke<string>("generate_commit_message", { diff, runId });

/** Stops a run by the id it was started with. Resolves `false` when it had already finished. */
export const cancelAiRun = (runId: string) => invoke<boolean>("cancel_ai_run", { runId });

export interface AiCheckpoint {
  id: string;
  /** Stable action key (`chat`, `fix-finding`, …) — translated in the UI, not here. */
  kind: string;
  /** Unix seconds. */
  created_at: number;
  /** Files that differ from the snapshot right now — exactly what restoring would put back. */
  changed_paths: string[];
}

export const listAiCheckpoints = (repoPath: string) =>
  invoke<AiCheckpoint[]>("list_ai_checkpoints", { repoPath });

/** Restores the checkpoint's files. Returns the paths that were put back. */
export const restoreAiCheckpoint = (repoPath: string, checkpointId: string) =>
  invoke<string[]>("restore_ai_checkpoint", { repoPath, checkpointId });

export const deleteAiCheckpoint = (repoPath: string, checkpointId: string) =>
  invoke<void>("delete_ai_checkpoint", { repoPath, checkpointId });

export const defaultCommitTemplate = () => invoke<string>("default_commit_template");

export const defaultReviewTemplate = () => invoke<string>("default_review_template");

export const defaultAnalyzeTemplate = () => invoke<string>("default_analyze_template");

export const defaultPrDescriptionTemplate = () => invoke<string>("default_pr_description_template");

export const defaultResolveConflictTemplate = () => invoke<string>("default_resolve_conflict_template");

export const analyzeWorkingChanges = (projectId: string, jobId: string, agent?: ChatAgentOverride | null) =>
  invoke<string>("analyze_working_changes", {
    projectId,
    jobId,
    agentProvider: agent?.provider ?? null,
    agentModel: agent?.model ?? null,
    agentPrompt: agent?.prompt ?? null,
  });

export const resolveFindingWithAi = (projectId: string, findingPrompt: string, runId?: string) =>
  invoke<string>("resolve_finding_with_ai", { projectId, findingPrompt, runId });

export interface ChatReply {
  text: string;
  session_id: string | null;
  /** Model id the CLI reported for this turn, or `null` when it didn't report exactly one. */
  model: string | null;
  /** Provider id that answered this turn — the engine that actually ran, not the one currently
   * configured (they differ the moment the routing is changed mid-conversation). */
  provider: string;
  /** Version of the engine CLI, or `null` when it couldn't be read (HTTP engines have none). */
  engine_version: string | null;
  /** When the turn was recorded, RFC 3339 — taken from the persisted row, so the live timestamp
   * and the one on a reopened conversation are the same instant. */
  created_at: string;
  /** How long the engine took to answer, in milliseconds. */
  response_time_ms: number;
}

/** `sessionId` is the engine's resume token; `conversationId` is *our* identity for the chat and
 * is what groups turns into one activity. See the Rust command's docs for why they're separate. */
/** When an SDD/Harness agent is active, its provider + model + prompt run this turn as that role.
 * `id` is carried for the UI to show which agent is selected; the backend only uses the rest. */
export interface ChatAgentOverride {
  id?: string;
  provider: string;
  model: string;
  prompt: string;
}

export const sendChatMessage = (
  projectId: string,
  message: string,
  sessionId: string | null,
  conversationId: string,
  runId?: string,
  agent?: ChatAgentOverride | null,
) =>
  invoke<ChatReply>("send_chat_message", {
    projectId,
    message,
    sessionId,
    conversationId,
    runId,
    agentProvider: agent?.provider ?? null,
    agentModel: agent?.model ?? null,
    agentPrompt: agent?.prompt ?? null,
  });

// ---------- pull requests (Azure DevOps / GitHub) ----------

export const adoListProjects = (org: string) => invoke<AdoProject[]>("ado_list_projects", { org });

export const adoListRepos = (org: string, project: string) =>
  invoke<AdoRepo[]>("ado_list_repos", { org, project });

/** Auto-detects the PR host (Azure DevOps or GitHub) straight from the repo's git remote. */
export const autoLinkProject = (projectId: string) =>
  invoke<AutoLinkResult>("auto_link_project", { projectId });

export const linkProjectAdo = (id: string, adoOrg: string, adoProject: string, adoRepoId: string) =>
  invoke<void>("link_project_ado", { id, adoOrg, adoProject, adoRepoId });

export const linkProjectGithub = (id: string, githubOwner: string, githubRepo: string, githubHost: string) =>
  invoke<void>("link_project_github", { id, githubOwner, githubRepo, githubHost });

/** Clears whichever VCS link (Azure DevOps or GitHub) the project currently has. */
export const unlinkProject = (id: string) => invoke<void>("unlink_project", { id });

/** Opens the project's repository home page (GitHub / Azure DevOps) in the default browser. */
export const openRepoInBrowser = (projectId: string) =>
  invoke<void>("open_repo_in_browser", { projectId });

export const listPullRequests = (projectId: string) =>
  invoke<PullRequestSummary[]>("list_pull_requests", { projectId });

/** Resolves a pasted pull-request URL (GitHub, GitHub Enterprise or Azure DevOps) into the PR
 * plus the local repository it belongs to — linking that repository to its host when it wasn't
 * already, so the review runs with the project's full context. */
export const resolvePrLink = (url: string) => invoke<PrLinkResolution>("resolve_pr_link", { url });

export const listPrCommentThreads = (projectId: string, prId: number) =>
  invoke<PrCommentThread[]>("list_pr_comment_threads", { projectId, prId });

/** Closes one comment thread on the host — Azure's "fixed", GitHub's resolved review thread. */
export const resolvePrCommentThread = (projectId: string, prId: number, threadId: number) =>
  invoke<void>("resolve_pr_comment_thread", { projectId, prId, threadId });

export const reviewPullRequest = (
  projectId: string,
  prId: number,
  jobId: string,
  level: string,
  agent?: ChatAgentOverride | null,
) =>
  invoke<string>("review_pull_request", {
    projectId,
    prId,
    jobId,
    level,
    agentProvider: agent?.provider ?? null,
    agentModel: agent?.model ?? null,
    agentPrompt: agent?.prompt ?? null,
  });

/** Reviews a pull request from its link alone: the diff comes from the host's API, not from a
 * working copy. Weaker than {@link reviewPullRequest} by construction — the model sees the diff
 * but not the surrounding codebase. It is recorded in `workspace_activity` rather than job
 * history: no project to file it under, but the workspace it ran in outlives the session.
 * `jobId` doubles as the run id the CLI streams on, which is what makes the live log and the
 * stop button work. */
export const reviewPrFromLink = (url: string, jobId: string, level: string, workspaceId: string) =>
  invoke<string>("review_pr_from_link", {
    url,
    jobId,
    level,
    workspaceId,
    agentProvider: null,
    agentModel: null,
    agentPrompt: null,
  });

/** One human-selected finding to post — identity (`file` + `category`) reuses its stored thread. */
export interface PostFindingItem {
  file: string | null;
  category: string;
  content: string;
  location: FindingLocation | null;
}

/** Posts the selected findings to the PR, reconciling threads (new / reply / resolve) against the
 * saved run (`runId`), plus an optional summary comment. */
export const postPrReviewComment = (
  projectId: string,
  prId: number,
  runId: string,
  items: PostFindingItem[],
  postSummary: boolean,
  summary: string | null,
) => invoke<void>("post_pr_review_comment", { projectId, prId, runId, items, postSummary, summary });

/** Posts the findings of a link-only review, addressed by URL. There's no saved run to reconcile
 * against, so each finding opens a fresh thread rather than continuing an earlier one. */
export const postPrLinkReviewComment = (
  url: string,
  items: PostFindingItem[],
  postSummary: boolean,
  summary: string | null,
) => invoke<void>("post_pr_link_review_comment", { url, items, postSummary, summary });

export type PrAction = "approve" | "request_changes" | "close";

/** Approves / requests changes on / closes the PR on its host, returning the pull request as the
 * host reports it afterwards plus the Activity row the action was filed under. */
export const actOnPullRequest = (projectId: string, prId: number, action: PrAction, body?: string) =>
  invoke<PrActionOutcome>("act_on_pull_request", { projectId, prId, action, body });

/** What the signed-in user has already decided on this PR, read from the host. */
export const prReviewDecision = (projectId: string, prId: number) =>
  invoke<PrDecision>("pr_review_decision", { projectId, prId });

/** AI-drafts a PR title + body from the diff between two branches (no host call — local git). */
export const generatePrDescription = (
  projectId: string,
  sourceBranch: string,
  targetBranch: string,
  runId?: string,
) => invoke<PrDescriptionDraft>("generate_pr_description", { projectId, sourceBranch, targetBranch, runId });

/** Opens a PR on the project's linked host. Returns the created PR. */
export const createPullRequest = (
  projectId: string,
  title: string,
  description: string,
  sourceBranch: string,
  targetBranch: string,
  draft: boolean,
) => invoke<PullRequestSummary>("create_pull_request", { projectId, title, description, sourceBranch, targetBranch, draft });

// ---------- filesystem (embedded editor) ----------

export const listDir = (repoPath: string, subPath?: string) =>
  invoke<FileEntry[]>("list_dir", { repoPath, subPath: subPath ?? null });

export const readFileText = (repoPath: string, relPath: string) =>
  invoke<string>("read_file_text", { repoPath, relPath });

export const writeFileText = (repoPath: string, relPath: string, content: string) =>
  invoke<void>("write_file_text", { repoPath, relPath, content });

/** Writes an exported binary to an absolute path — the one the user picked in a native save
 * dialog, which is what authorises writing outside the repo. */
export const writeFileBytes = (path: string, contents: Uint8Array) =>
  invoke<void>("write_file_bytes", { path, contents: Array.from(contents) });

/** Moves a file or folder into `destDir` (repo-relative; `""` is the repo root), keeping its
 * name. Returns the new repo-relative path. */
export const movePath = (repoPath: string, fromRel: string, destDir: string) =>
  invoke<string>("move_path", { repoPath, fromRel, destDir });

/** Creates a folder, and any missing parents — so `a/b/c` typed into one box works in one go. */
export const createDir = (repoPath: string, relPath: string) =>
  invoke<void>("create_dir", { repoPath, relPath });

/** Creates an empty file, and any missing parent folders: `docs/api/spec.md` makes `docs` and
 * `docs/api` on the way. Refuses rather than truncating a file that already exists. */
export const createFile = (repoPath: string, relPath: string) =>
  invoke<void>("create_file", { repoPath, relPath });

/** Renames a file or folder in place, keeping it in the same parent. `newName` is a plain name —
 * no separators. Returns the new repo-relative path. */
export const renamePath = (repoPath: string, fromRel: string, newName: string) =>
  invoke<string>("rename_path", { repoPath, fromRel, newName });

/** Sends a file or folder to the OS trash, so a mis-aimed click is recoverable from Finder. */
export const deletePath = (repoPath: string, relPath: string) =>
  invoke<void>("delete_path", { repoPath, relPath });

export const openInDefaultApp = (repoPath: string, relPath: string) =>
  invoke<void>("open_in_default_app", { repoPath, relPath });

export const revealInFileManager = (path: string) => invoke<void>("reveal_in_file_manager", { path });

export const openInVsCode = (path: string) => invoke<void>("open_in_vscode", { path });

/** Every non-ignored file in the repo, repo-relative — the corpus "go to file" filters over. */
export const listRepoFiles = (repoPath: string) => invoke<string[]>("list_repo_files", { repoPath });

export interface SearchHit {
  path: string;
  /** 1-based. */
  line_no: number;
  line: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** True when `maxResults` cut the list short. */
  truncated: boolean;
}

/** The find box's toggles. `include`/`exclude` are comma-separated globs; a pattern without a
 * slash matches by file name at any depth (`*.ts`). */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
}

export interface ReplaceOutcome {
  replacements: number;
  files: number;
  /** Snapshot taken before anything was written — restorable from the restore-points list. */
  checkpoint_id: string | null;
}

export const searchRepo = (repoPath: string, query: string, options: SearchOptions, maxResults = 500) =>
  invoke<SearchOutcome>("search_repo", { repoPath, query, options, maxResults });

/** Rewrites every match, across the repo or within `onlyPath`. Writes to disk — the backend
 * checkpoints first so the whole thing can be undone as a unit. */
export const replaceInRepo = (
  repoPath: string,
  query: string,
  replacement: string,
  options: SearchOptions,
  onlyPath?: string | null,
) => invoke<ReplaceOutcome>("replace_in_repo", { repoPath, query, replacement, options, onlyPath: onlyPath ?? null });

/** Rewrites `selection` per `instruction` and returns the replacement text. Nothing is written
 * to disk — the editor applies it to its buffer, so it stays undoable. */
export const inlineEditWithAi = (
  relPath: string,
  fileContent: string,
  selection: string,
  instruction: string,
  runId?: string,
) => invoke<string>("inline_edit_with_ai", { relPath, fileContent, selection, instruction, runId });

// ---------- activity log (AI chat history / conversations) ----------

export const listChatConversations = (projectId: string, search?: string) =>
  invoke<ChatConversationSummary[]>("list_chat_conversations", { projectId, search: search ?? null });

export const getChatConversation = (projectId: string, sessionId: string) =>
  invoke<ActivityLogEntry[]>("get_chat_conversation", { projectId, sessionId });

export const deleteChatConversation = (projectId: string, sessionId: string) =>
  invoke<void>("delete_chat_conversation", { projectId, sessionId });

export const renameChatConversation = (projectId: string, sessionId: string, title: string) =>
  invoke<void>("rename_chat_conversation", { projectId, sessionId, title });

export const listJobHistory = (projectId: string) => invoke<JobHistoryEntry[]>("list_job_history", { projectId });

export const renameJobHistoryEntry = (id: string, label: string) => invoke<void>("rename_job_history_entry", { id, label });

export const deleteJobHistoryEntry = (id: string) => invoke<void>("delete_job_history_entry", { id });

// ---------- workspace activity (reviews of PRs with no repository here) ----------

/** Everything reviewed from a link in this workspace, newest first. Repository-agnostic by
 * design: these runs have no project, so they follow the workspace instead. */
export const listWorkspaceActivity = (workspaceId: string) =>
  invoke<WorkspaceActivityEntry[]>("list_workspace_activity", { workspaceId });

export const renameWorkspaceActivityEntry = (id: string, label: string) =>
  invoke<void>("rename_workspace_activity_entry", { id, label });

export const deleteWorkspaceActivityEntry = (id: string) =>
  invoke<void>("delete_workspace_activity_entry", { id });

// ---------- debugger (Node / JavaScript) ----------

export interface StackFrame {
  id: string;
  name: string;
  /** Absolute path, or the raw script url for runtime internals. */
  file: string;
  /** 1-based. */
  line: number;
  scope_id: string | null;
}

export interface DebugVariable {
  name: string;
  value: string;
  /** Present when the value can be expanded. */
  object_id: string | null;
}

/** Launches `program` under Node with the inspector attached. `breakpoints` maps absolute file
 * paths to 1-based lines and is applied before the first statement runs. */
export const debugStart = (
  cwd: string,
  program: string,
  args: string[],
  breakpoints: Record<string, number[]>,
  nodeBinary?: string,
) => invoke<void>("debug_start", { cwd, program, args, breakpoints, nodeBinary: nodeBinary ?? null });

/** Starts a session through a DAP adapter — every language other than Node. `launchConfig` is
 * that adapter's own launch object. */
export const debugStartAdapter = (
  cwd: string,
  command: string,
  args: string[],
  launchConfig: Record<string, unknown>,
  breakpoints: Record<string, number[]>,
) => invoke<void>("debug_start_adapter", { cwd, command, args, launchConfig, breakpoints });

export const debugStop = () => invoke<void>("debug_stop");
export const debugContinue = () => invoke<void>("debug_continue");
export const debugPause = () => invoke<void>("debug_pause");
export const debugStep = (kind: "over" | "into" | "out") => invoke<void>("debug_step", { kind });
export const debugSetBreakpoints = (breakpoints: Record<string, number[]>) =>
  invoke<void>("debug_set_breakpoints", { breakpoints });
export const debugProperties = (objectId: string) =>
  invoke<DebugVariable[]>("debug_properties", { objectId });
export const debugEvaluate = (frameId: string, expression: string) =>
  invoke<DebugVariable>("debug_evaluate", { frameId, expression });

// ---------- filesystem watcher ----------

export const startWatching = (repoPath: string) => invoke<void>("start_watching", { repoPath });

export const stopWatching = (repoPath: string) => invoke<void>("stop_watching", { repoPath });

// ---------- pull requests addressed by link (no local clone) ----------

/** The PR behind a link, re-read from its host. */
export const prLinkPullRequest = (url: string) =>
  invoke<PullRequestSummary>("pr_link_pull_request", { url });

/** The PR's existing comment threads, addressed by link. */
export const prLinkCommentThreads = (url: string) =>
  invoke<PrCommentThread[]>("pr_link_comment_threads", { url });

/** Closes one comment thread of the PR behind a link. */
export const prLinkResolveCommentThread = (url: string, threadId: number) =>
  invoke<void>("pr_link_resolve_comment_thread", { url, threadId });

/** What the signed-in user has already decided on the PR behind a link. */
export const prLinkDecision = (url: string) => invoke<PrDecision>("pr_link_decision", { url });

/** Approve / request changes / close the PR behind a link. Returns it as the host now reports it,
 * plus the workspace Activity row the decision was filed under. */
export const actOnPrLink = (url: string, workspaceId: string, action: PrAction, body?: string) =>
  invoke<PrLinkActionOutcome>("act_on_pr_link", { url, workspaceId, action, body });
