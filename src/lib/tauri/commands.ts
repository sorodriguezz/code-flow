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
  PrCommentThread,
  PrDescriptionDraft,
  Project,
  PullRequestSummary,
  RemoteInfo,
  RepoStatusInfo,
  ReviewContext,
  SecretHit,
  StashInfo,
  Workspace,
  WorkspaceMcp,
  WorkspaceMdFile,
  WorkspaceSkill,
} from "../../types/domain";
import type { ReviewCommentInput } from "../parseAnalysis";

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
export const resolveConflictWithAi = (repoPath: string, relPath: string) =>
  invoke<string>("resolve_conflict_with_ai", { repoPath, relPath });

export const completeMerge = (repoPath: string, message: string) =>
  invoke<string>("complete_merge", { repoPath, message });

export const abortMerge = (repoPath: string) => invoke<void>("abort_merge", { repoPath });

// ---------- terminal ----------

export const openTerminal = (cwd: string) => invoke<string>("open_terminal", { cwd });

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

// ---------- workspace MD files (CLAUDE.md-style instructions) ----------

export const listWorkspaceMdFiles = (workspaceId: string) =>
  invoke<WorkspaceMdFile[]>("list_workspace_md_files", { workspaceId });

export const upsertWorkspaceMdFile = (
  id: string | undefined,
  workspaceId: string,
  filename: string,
  content: string,
  enabled: boolean,
) =>
  invoke<WorkspaceMdFile>("upsert_workspace_md_file", {
    id: id ?? null,
    workspaceId,
    filename,
    content,
    enabled,
  });

export const deleteWorkspaceMdFile = (id: string) => invoke<void>("delete_workspace_md_file", { id });

// ---------- workspace skills ----------

export const listWorkspaceSkills = (workspaceId: string) =>
  invoke<WorkspaceSkill[]>("list_workspace_skills", { workspaceId });

export const installWorkspaceSkill = (workspaceId: string, sourceRepo: string, skillName: string) =>
  invoke<WorkspaceSkill>("install_workspace_skill", { workspaceId, sourceRepo, skillName });

export const removeWorkspaceSkill = (id: string) => invoke<void>("remove_workspace_skill", { id });

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

export const generateCommitMessage = (diff: string) =>
  invoke<string>("generate_commit_message", { diff });

export const defaultCommitTemplate = () => invoke<string>("default_commit_template");

export const defaultReviewTemplate = () => invoke<string>("default_review_template");

export const defaultAnalyzeTemplate = () => invoke<string>("default_analyze_template");

export const defaultPrDescriptionTemplate = () => invoke<string>("default_pr_description_template");

export const defaultResolveConflictTemplate = () => invoke<string>("default_resolve_conflict_template");

export const analyzeWorkingChanges = (projectId: string, jobId: string) =>
  invoke<string>("analyze_working_changes", { projectId, jobId });

export const resolveFindingWithAi = (projectId: string, findingPrompt: string) =>
  invoke<string>("resolve_finding_with_ai", { projectId, findingPrompt });

export interface ChatReply {
  text: string;
  session_id: string | null;
  /** Model id the CLI reported for this turn, or `null` when it didn't report exactly one. */
  model: string | null;
  /** How long the engine took to answer, in milliseconds. */
  response_time_ms: number;
}

export const sendChatMessage = (projectId: string, message: string, sessionId: string | null) =>
  invoke<ChatReply>("send_chat_message", { projectId, message, sessionId });

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

export const listPrCommentThreads = (projectId: string, prId: number) =>
  invoke<PrCommentThread[]>("list_pr_comment_threads", { projectId, prId });

export const reviewPullRequest = (projectId: string, prId: number, jobId: string) =>
  invoke<string>("review_pull_request", { projectId, prId, jobId });

export const postPrReviewComment = (projectId: string, prId: number, comments: ReviewCommentInput[]) =>
  invoke<void>("post_pr_review_comment", { projectId, prId, comments });

export type PrAction = "approve" | "request_changes" | "close";

export const actOnPullRequest = (projectId: string, prId: number, action: PrAction, body?: string) =>
  invoke<void>("act_on_pull_request", { projectId, prId, action, body });

/** AI-drafts a PR title + body from the diff between two branches (no host call — local git). */
export const generatePrDescription = (projectId: string, sourceBranch: string, targetBranch: string) =>
  invoke<PrDescriptionDraft>("generate_pr_description", { projectId, sourceBranch, targetBranch });

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

export const openInDefaultApp = (repoPath: string, relPath: string) =>
  invoke<void>("open_in_default_app", { repoPath, relPath });

export const revealInFileManager = (path: string) => invoke<void>("reveal_in_file_manager", { path });

export const openInVsCode = (path: string) => invoke<void>("open_in_vscode", { path });

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

// ---------- filesystem watcher ----------

export const startWatching = (repoPath: string) => invoke<void>("start_watching", { repoPath });

export const stopWatching = (repoPath: string) => invoke<void>("stop_watching", { repoPath });
