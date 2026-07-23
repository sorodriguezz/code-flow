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
  Project,
  PullRequestSummary,
  RemoteInfo,
  RepoStatusInfo,
  ReviewContext,
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

// ---------- claude ----------

export const generateCommitMessage = (diff: string) =>
  invoke<string>("generate_commit_message", { diff });

export const defaultCommitTemplate = () => invoke<string>("default_commit_template");

export const defaultReviewTemplate = () => invoke<string>("default_review_template");

export const defaultAnalyzeTemplate = () => invoke<string>("default_analyze_template");

export const analyzeWorkingChanges = (projectId: string, jobId: string) =>
  invoke<string>("analyze_working_changes", { projectId, jobId });

export const resolveFindingWithAi = (projectId: string, findingPrompt: string) =>
  invoke<string>("resolve_finding_with_ai", { projectId, findingPrompt });

export interface ChatReply {
  text: string;
  session_id: string | null;
}

export const sendChatMessage = (projectId: string, message: string, sessionId: string | null) =>
  invoke<ChatReply>("send_chat_message", { projectId, message, sessionId });

// ---------- Azure DevOps pull requests ----------

export const adoListProjects = (org: string) => invoke<AdoProject[]>("ado_list_projects", { org });

export const adoListRepos = (org: string, project: string) =>
  invoke<AdoRepo[]>("ado_list_repos", { org, project });

export const autoLinkProjectAdo = (projectId: string) =>
  invoke<AutoLinkResult>("auto_link_project_ado", { projectId });

export const linkProjectAdo = (id: string, adoOrg: string, adoProject: string, adoRepoId: string) =>
  invoke<void>("link_project_ado", { id, adoOrg, adoProject, adoRepoId });

export const unlinkProjectAdo = (id: string) => invoke<void>("unlink_project_ado", { id });

export const listPullRequests = (projectId: string) =>
  invoke<PullRequestSummary[]>("list_pull_requests", { projectId });

export const listPrCommentThreads = (projectId: string, prId: number) =>
  invoke<PrCommentThread[]>("list_pr_comment_threads", { projectId, prId });

export const reviewPullRequest = (projectId: string, prId: number, jobId: string) =>
  invoke<string>("review_pull_request", { projectId, prId, jobId });

export const postPrReviewComment = (projectId: string, prId: number, comments: ReviewCommentInput[]) =>
  invoke<void>("post_pr_review_comment", { projectId, prId, comments });

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
