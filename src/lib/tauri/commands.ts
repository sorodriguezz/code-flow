import { invoke } from "@tauri-apps/api/core";
import type {
  ActivityLogEntry,
  AdoProject,
  AdoRepo,
  BoardWorkItem,
  AgentChain,
  AgentProject,
  AgentTask,
  AgentTaskStatus,
  AutoLinkResult,
  ChainClaim,
  StepCheck,
  ChainDetail,
  ChainStepBrief,
  ChainTemplate,
  NewChainStep,
  NewStoryWorkItem,
  UsageStats,
  ProviderQuota,
  BranchInfo,
  ChatConversationSummary,
  CommitInfo,
  ConflictFile,
  FileBlame,
  FileDiffInfo,
  FileEntry,
  GitIdentity,
  HunkRef,
  DiscardOutcome,
  FpSuppression,
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
  AdoWiki,
  AdoWikiPage,
  BoardItemType,
  BoardProvider,
  MondayBoardSchema,
  AdoClassificationNode,
  QuestionAnswer,
  StoryBatch,
  StoryBatchDetail,
  StoryBatchPrompt,
  StoryDraft,
  StoryPublishOutcome,
  StorySourceKind,
  Bench,
  BenchTab,
  BenchTerminal,
  TerminalOpened,
  ThreadCloseOutcome,
  Requirement,
  ReviewRunDetail,
  ReviewRunSummary,
  Workspace,
  WorkspaceActivityEntry,
  WorkspaceAgent,
  WorkspaceSkill,
  WorkItemKind,
  WorkItemRef,
  WorkItemReviewResult,
  WorkItemReviewRow,
  WorkItemReviewStage,
} from "../../types/domain";
import type {
  AdoWikiPageDetail,
  AdoWikiPageRef,
  BoardItemRef,
  DocPage,
  DocResult,
  DocScope,
} from "../../types/domain";
import type { FindingLocation } from "../parseAnalysis";

// ---------- app lifecycle ----------

export const quitApp = () => invoke<void>("quit_app");

export const resetAppData = () => invoke<void>("reset_app_data");

/** What the app cannot do without: `git` on `PATH`, and a writable data directory. Called once per
 *  installation — see `requirementsStore` for the flag that keeps it that way. */
export const checkRequirements = () => invoke<Requirement[]>("check_requirements");

// ---------- workspaces / projects ----------

export const pickFolder = () => invoke<string | null>("pick_folder");

/** One git repository found inside a picked folder. */
export interface FoundRepo {
  name: string;
  path: string;
  /** Its `origin` (or first remote), read while scanning — what says whether this is a repository
   *  the workspace already holds somewhere else. `null` when it has no remote. */
  remote_url: string | null;
}

/** What a picked folder turned out to be — see `scan_folder`. */
export interface FolderScan {
  /** The folder is itself a repository root. */
  is_repo: boolean;
  /** The picked folder's own remote, when `is_repo`. Same thing `FoundRepo` carries, for the
   *  folder that is a repository itself rather than one holding them. */
  remote_url: string | null;
  /** Repositories directly inside it, one level down and no further. */
  repos: FoundRepo[];
  empty: boolean;
  /** The folder had more entries than the scan looks at, and the rest were skipped. */
  truncated: boolean;
}

/** Asks what a picked folder actually is before anything is registered against it. Bounded on
 *  purpose: it stats one level and stops. */
export const scanFolder = (path: string) => invoke<FolderScan>("scan_folder", { path });

/** Why an incoming repository is the one the workspace already holds: literally the same folder,
 *  or a different folder cloned from the same remote. */
export type DuplicateReason = "path" | "remote";

/** The project already in the workspace that *is* the repository being added. */
export interface DuplicateProject {
  id: string;
  name: string;
  /** Where the copy already in the workspace lives — the point being that it is somewhere other
   *  than where the user is adding from. */
  local_path: string;
  reason: DuplicateReason;
}

/** A repository about to be added: where it is (or, for a clone, where it will be) and the remote
 *  it points at, for whichever of the two the caller knows first. */
export interface RepoCandidate {
  path: string;
  remote_url: string | null;
}

/**
 * For each candidate, the project of this workspace that already is that repository — `null` at
 * the positions with no match, lined up with what was asked.
 *
 * A workspace holds a repository once, and that is decided on the repository's *identity* rather
 * than its path: the same repository imported from `~/dev/api` and cloned into CodeFlow's own
 * `repos/api` is two folders and one repository. Ask before adding, so the refusal can name where
 * the copy already is — and, for a clone, before anything is downloaded.
 */
export const findDuplicateProjects = (workspaceId: string, candidates: RepoCandidate[]) =>
  invoke<(DuplicateProject | null)[]>("find_duplicate_projects", { workspaceId, candidates });

export const defaultCloneDir = () => invoke<string>("default_clone_dir");

export const createWorkspace = (name: string, icon: string, color: string) =>
  invoke<Workspace>("create_workspace", { name, icon, color });

export const listWorkspaces = () => invoke<Workspace[]>("list_workspaces");

/** Writes the order the workspaces are shown in. `ids` is the whole list, in order. */
export const reorderWorkspaces = (ids: string[]) => invoke<void>("reorder_workspaces", { ids });

export const deleteWorkspace = (id: string) => invoke<void>("delete_workspace", { id });

export const updateWorkspaceColor = (id: string, color: string) =>
  invoke<void>("update_workspace_color", { id, color });

export const renameWorkspace = (id: string, name: string) => invoke<void>("rename_workspace", { id, name });

export const createProject = (input: NewProject) => invoke<Project>("create_project", { input });

export const listProjects = (workspaceId: string) =>
  invoke<Project[]>("list_projects", { workspaceId });

export const getProject = (id: string) => invoke<Project | null>("get_project", { id });

export const deleteProject = (id: string) => invoke<void>("delete_project", { id });

/** Writes the order the workspace's repositories are shown in. `ids` is the whole list, in order. */
export const reorderProjects = (workspaceId: string, ids: string[]) =>
  invoke<void>("reorder_projects", { workspaceId, ids });

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

/** Every changed file, with `contextLines` of surrounding context per hunk.
 *
 * Omitting `contextLines` keeps the historical behaviour — near-unlimited context, i.e. the whole
 * file — which is what `reconstructSides` in `../diffText` needs to rebuild both sides of a file
 * from hunks alone. That is expensive: on a working tree with a few large touched files it turns
 * ~19 KB of real `git diff` into ~1.8 MB of JSON, because every line crosses IPC as two heap
 * strings. Callers that only need to *list* what changed should pass a small number and reach for
 * `getFileDiff` when the user actually opens a file.
 */
export const getWorkingDiff = (repoPath: string, contextLines?: number) =>
  invoke<FileDiffInfo[]>("get_working_diff", { repoPath, contextLines });

export const getStagedDiff = (repoPath: string, contextLines?: number) =>
  invoke<FileDiffInfo[]>("get_staged_diff", { repoPath, contextLines });

/** One file's diff at full context — the counterpart to a narrow `getWorkingDiff`/`getStagedDiff`.
 *
 * Split view, the editor's diff tab and an expanded row in Changes all reconstruct the two file
 * texts from hunks, so they need every line. Asking for one path keeps that whole-file cost to the
 * file being looked at instead of paying it for the entire changeset on every watcher tick.
 * Resolves to `null` when the path has no diff on that side.
 */
export const getFileDiff = (repoPath: string, path: string, staged: boolean) =>
  invoke<FileDiffInfo | null>("get_file_diff", { repoPath, path, staged });

export const getCommitDiff = (repoPath: string, oid: string) =>
  invoke<FileDiffInfo[]>("get_commit_diff", { repoPath, oid });

/** One file's change in one commit, against that commit's first parent, at full context — what
 * clicking through from a blame annotation opens side by side.
 *
 * Not `getCommitDiff(...).find(...)`: that one returns every file the commit touched, and returns
 * them at three lines of context, which is not enough for `reconstructSides` to rebuild the two file
 * texts. Resolves to `null` when the commit didn't touch that path. */
export const getCommitFileDiff = (repoPath: string, oid: string, path: string) =>
  invoke<FileDiffInfo | null>("get_commit_file_diff", { repoPath, oid, path });

/** Who last changed each line of a file, as runs of lines.
 *
 * Pass `contents` — the editor's unsaved buffer — and lines the user has just typed come back with
 * `uncommitted: true` instead of inheriting the attribution of whatever used to sit at that line
 * number; it is `git blame --contents -`. Omit it to blame the file as committed, which is the only
 * form worth caching (see `state/blameStore.ts`), since a buffer blame is invalidated by every
 * keystroke. `contents ?? null` for the same reason as `createBranch`'s `startPoint`: tauri wants an
 * explicit null for a missing `Option`, not an absent key. */
export const getFileBlame = (repoPath: string, path: string, contents?: string) =>
  invoke<FileBlame>("get_file_blame", { repoPath, path, contents: contents ?? null });

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

// ---------- git: one hunk at a time (the editor's inline change peek) ----------
//
// `contextLines` must be the context the hunk was *read* at — hunk boundaries are a function of it,
// so passing a different number makes the backend's fingerprint match nothing and every call refuse
// as stale. Pass `LIST_DIFF_CONTEXT_LINES` from `../../state/repoStore`, which is what
// `workingDiff`/`stagedDiff` were fetched with; it crosses the wire rather than being a constant on
// each side so there is exactly one number to change.
//
// None of these three builds a patch. `hunk` is the hunk the peek drew, handed back so
// `src-tauri/src/git/hunk.rs` can recognise it in a diff it recomputes for itself — see `HunkRef`.
// A hunk that has moved since the panel was drawn comes back rejected with a `HUNK_STALE: ` prefix
// and nothing on disk has changed, so the caller can just refresh and let the user look again.

/** Adds one hunk to the index. The working tree is not touched — this is `git add -p`. */
export const stageHunk = (repoPath: string, hunk: HunkRef, contextLines: number) =>
  invoke<void>("stage_hunk", { repoPath, hunk, contextLines });

/** Removes one hunk from the index. The working tree is not touched — this is `git reset -p`. */
export const unstageHunk = (repoPath: string, hunk: HunkRef, contextLines: number) =>
  invoke<void>("unstage_hunk", { repoPath, hunk, contextLines });

/** Throws one hunk of working-tree change away, restoring that region from the **index** — the same
 * contract as `discardFileChanges`, so a file that is staged and then edited keeps its staged part.
 * Nothing here is recoverable: no reflog, no stash, no restore point. Confirm before calling. */
export const discardHunk = (repoPath: string, hunk: HunkRef, contextLines: number) =>
  invoke<void>("discard_hunk", { repoPath, hunk, contextLines });

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

// ---------- terminal: the agent console's bench ----------

/**
 * The workspace's bench, live state included.
 *
 * Re-read every time the bench opens rather than trusted from the store, because the two facts it
 * carries go stale in opposite directions: the rows change only when the user edits them, and
 * `session_id` changes whenever a shell starts or exits — including while the bench was closed,
 * which is the state the whole feature is built around.
 */
export const listWorkspaceTerminals = (workspaceId: string) =>
  invoke<Bench>("list_workspace_terminals", { workspaceId });

/** Adds a shell to `tabId` and starts it. Omit `profileId` for the configured default. */
export const addWorkspaceTerminal = (workspaceId: string, tabId: string, cwd: string, profileId?: string) =>
  invoke<BenchTerminal>("add_workspace_terminal", { workspaceId, tabId, cwd, profileId });

/** A new, empty tab. Its layout is written once something is put in it. */
export const addBenchTab = (workspaceId: string) => invoke<BenchTab>("add_bench_tab", { workspaceId });

/** Records a tab's pane arrangement — the serialized tree from `lib/bench/layout`. */
export const setBenchLayout = (tabId: string, layout: string) =>
  invoke<void>("set_bench_layout", { tabId, layout });

export const renameBenchTab = (tabId: string, title: string) =>
  invoke<void>("rename_bench_tab", { tabId, title });

/** Closes a tab: every shell in it killed, every transcript in it forgotten. */
export const removeBenchTab = (tabId: string) => invoke<void>("remove_bench_tab", { tabId });

/** Starts a shell for a row that has none, and returns its session id. Idempotent: a row that is
 *  already attached hands back the session it has rather than opening a second one. */
export const resumeWorkspaceTerminal = (id: string) =>
  invoke<string>("resume_workspace_terminal", { id });

export const renameWorkspaceTerminal = (id: string, title: string) =>
  invoke<void>("rename_workspace_terminal", { id, title });

/** Kills one terminal's shell and forgets its row and output. */
export const removeWorkspaceTerminal = (id: string) =>
  invoke<void>("remove_workspace_terminal", { id });

/** Empties the bench — every shell killed, every transcript forgotten. Irreversible. */
export const clearWorkspaceTerminals = (workspaceId: string) =>
  invoke<void>("clear_workspace_terminals", { workspaceId });

// ---------- git: remote (streamed) ----------

export const gitClone = (url: string, dest: string) => invoke<void>("git_clone", { url, dest });

export const gitFetch = (repoPath: string, remoteName?: string) =>
  invoke<void>("git_fetch", { repoPath, remoteName: remoteName ?? null });

export const gitPull = (repoPath: string) => invoke<void>("git_pull", { repoPath });

export const gitPush = (repoPath: string, setUpstream: boolean) =>
  invoke<void>("git_push", { repoPath, setUpstream });

// ---------- settings ----------

export const getSetting = (key: string) => invoke<string | null>("get_setting", { key });

/** Many settings in one round-trip, for the callers that read a whole block of them at once.
 *
 * `getSetting` is one key, one command, one acquisition of the database mutex — so a store that
 * hydrates 30-odd keys pays 30 serialized round-trips at startup no matter how it batches them on
 * the JS side, because the Rust end queues them all behind the same lock. This takes the lock once.
 *
 * A key that was never set is simply absent from the map, exactly as `getSetting` answers `null`
 * for it, so a value deliberately stored as `""` stays distinguishable from one that is unset.
 */
export const getSettings = (keys: string[]) =>
  invoke<Record<string, string>>("get_settings", { keys });

export const setSetting = (key: string, value: string) => invoke<void>("set_setting", { key, value });

/** The app-wide patterns whose branches come locked with no padlock clicked on them. Not a
 * `getSetting` call: the backend answers with the shipped defaults when nothing has been saved
 * yet, and re-seeds the cache the git-layer guards read. */
export const getLockedBranchRules = () => invoke<string[]>("get_locked_branch_rules");

/** Returns the list as actually stored — trimmed, blanks dropped, duplicates collapsed — so the
 * screen shows what the guards will use rather than what was typed. */
export const setLockedBranchRules = (rules: string[]) =>
  invoke<string[]>("set_locked_branch_rules", { rules });

export const defaultLockedBranchRules = () => invoke<string[]>("default_locked_branch_rules");

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

/** The statistics screen's whole payload for one window, in hours — and the only thing that reads
 * the recorded-spend table, now that the status bar draws quota alone. */
export const aiUsageStats = (windowHours: number) =>
  invoke<UsageStats>("ai_usage_stats", { windowHours });

/** How much of each provider's plan is left, read from the providers themselves.
 *
 * Never rejects as a whole: each provider carries its own error, because one engine being signed
 * out is no reason to stop showing another's remaining week. */
/** Who is asking. `"poll"` is the background timer and is the only one that may not start a
 * provider's CLI — on Windows that flashes a console window, and a timer doing it unprompted is the
 * app interrupting whatever the user was doing. `"open"` is the panel being shown, `"refresh"` the
 * button (which also bypasses the backend cache). */
export type QuotaTrigger = "poll" | "open" | "refresh";

export const aiQuotaStatus = (trigger: QuotaTrigger = "poll") =>
  invoke<ProviderQuota[]>("ai_quota_status", { trigger });

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

// ---------- agent tasks ----------

export const listAgentTasks = (workspaceId: string) =>
  invoke<AgentTask[]>("list_agent_tasks", { workspaceId });

export const getAgentTask = (id: string) => invoke<AgentTask | null>("get_agent_task", { id });

/** `provider`/`prompt` are the agent's, snapshotted here on purpose — see `AgentTask`. */
export const createAgentTask = (
  workspaceId: string,
  projectId: string,
  agentId: string,
  agentName: string,
  provider: string,
  model: string,
  prompt: string,
  goal: string,
  title: string,
  agentProjectId: string,
) =>
  invoke<AgentTask>("create_agent_task", {
    workspaceId,
    projectId,
    agentId,
    agentName,
    provider,
    model,
    prompt,
    goal,
    title,
    agentProjectId,
  });

export const updateAgentTaskRun = (
  id: string,
  status: AgentTaskStatus,
  model: string,
  turns: number,
  lastError: string,
) => invoke<void>("update_agent_task_run", { id, status, model, turns, lastError });

/** Ignored by the backend once the task has turns — moving a repo out from under a conversation
 * that has already edited it is not something a stale screen gets to do. */
export const setAgentTaskProject = (id: string, projectId: string) =>
  invoke<void>("set_agent_task_project", { id, projectId });

export const renameAgentTask = (id: string, title: string) =>
  invoke<void>("rename_agent_task", { id, title });

export const deleteAgentTask = (id: string) => invoke<void>("delete_agent_task", { id });

// ---------- agent chains ----------

export const listAgentChains = (workspaceId: string) =>
  invoke<AgentChain[]>("list_agent_chains", { workspaceId });

export const getChainDetail = (chainId: string) =>
  invoke<ChainDetail | null>("get_chain_detail", { chainId });

/** `projectIds` is the whole repository set, first one first — it is what a step that names no
 * repository of its own falls back to, and what a step marked `ALL_REPOS` expands over. */
export const createAgentChain = (
  projectIds: string[],
  title: string,
  goal: string,
  steps: NewChainStep[],
  agentProjectId: string,
) => invoke<ChainDetail>("create_agent_chain", { projectIds, title, goal, steps, agentProjectId });

/** A story run: the work item, the repositories that might have to change, and the two agents that
 * will read them and then write them. The 2N-step plan is built in Rust — see `create_story_chain`
 * there for why the instructions are not a parameter. */
export const createStoryChain = (input: {
  projectIds: string[];
  title: string;
  notes: string;
  analystAgentId: string;
  implementerAgentId: string;
  agentProjectId: string;
  workItem: NewStoryWorkItem;
}) => invoke<ChainDetail>("create_story_chain", input);

/** Freezes what one step will be sent, ahead of the gate it sits behind — how the story review
 * approves a plan for six repositories in one press. Ignored once the step has left `pending`. */
export const setChainStepInput = (stepId: string, input: string) =>
  invoke<void>("set_chain_step_input", { stepId, input });

/** Takes one step out of the plan, or puts it back. Only ever moves between `pending` and
 * `skipped`. */
export const setChainStepSkipped = (stepId: string, skipped: boolean) =>
  invoke<void>("set_chain_step_skipped", { stepId, skipped });

/** Asks the backend what happens next *and* records it. Everything that could refuse has already
 * refused by the time this resolves; `kind: "run"` means a step is now marked dispatched on disk
 * and the caller is obliged to run it and report back. */
export const claimNextChainStep = (chainId: string, runId: string) =>
  invoke<ChainClaim>("claim_next_chain_step", { chainId, runId });

export const completeChainStep = (
  stepId: string,
  outcome: "done" | "error" | "cancelled" | "requeue" | "check_failed",
  outputText: string,
  reason: string,
) => invoke<AgentChain | null>("complete_chain_step", { stepId, outcome, outputText, reason });

/** Runs the step's declared check in its own repository. `ran: false` when it declares none, which
 * is the caller's cue to complete the step exactly as it always did. Never throws for a check that
 * merely failed — a non-zero exit is an answer, not an error. */
export const runChainStepCheck = (stepId: string) =>
  invoke<StepCheck>("run_chain_step_check", { stepId });

/** Runs the plan again from one step, with a note from the user folded into that step's opening
 * message. Works on a finished chain: its memory folder and every step's answer are still there, so
 * the second pass starts knowing what the first one learned. */
export const rerunChainFrom = (chainId: string, stepIndex: number, note: string) =>
  invoke<AgentChain | null>("rerun_chain_from", { chainId, stepIndex, note });

export const approveChainGate = (chainId: string, input: string) =>
  invoke<AgentChain | null>("approve_chain_gate", { chainId, input });

export const skipChainStep = (chainId: string) => invoke<AgentChain | null>("skip_chain_step", { chainId });

export const retryChainStep = (chainId: string) => invoke<AgentChain | null>("retry_chain_step", { chainId });

export const resumeChain = (chainId: string) => invoke<AgentChain | null>("resume_chain", { chainId });

export const abortChain = (chainId: string) => invoke<AgentChain | null>("abort_chain", { chainId });

/** Deletes the plan, the tasks its steps produced, and its memory folder. Returns the ids of those
 * tasks so the caller can drop the same rows out of its own list — they are gone from the database
 * by the time this resolves, and a list still holding them would be showing work that no longer
 * exists until the next workspace load. */
export const deleteChain = (chainId: string) => invoke<string[]>("delete_chain", { chainId });

/** For a step whose run outlived the webview: `null` until its turn lands. */
export const harvestChainStep = (stepId: string) =>
  invoke<AgentChain | null>("harvest_chain_step", { stepId });

/** "Carry on from here": a chain whose first step is `source` — already finished, its answer ready
 * to hand on. */
export const createContinuationChain = (
  sourceTaskId: string,
  title: string,
  goal: string,
  steps: NewChainStep[],
  agentProjectId: string,
) =>
  invoke<ChainDetail>("create_continuation_chain", {
    sourceTaskId,
    title,
    goal,
    steps,
    agentProjectId,
  });

// ---------- chain templates ----------

export const listChainTemplates = (workspaceId: string) =>
  invoke<ChainTemplate[]>("list_chain_templates", { workspaceId });

export const upsertChainTemplate = (
  id: string | undefined,
  workspaceId: string,
  name: string,
  description: string,
  steps: NewChainStep[],
) => invoke<ChainTemplate>("upsert_chain_template", { id: id ?? null, workspaceId, name, description, steps });

export const deleteChainTemplate = (id: string) => invoke<void>("delete_chain_template", { id });

/** The marker `send_chat_message` returns when another run already owns the working copy
 * (`ai_locks::BUSY_MARKER`). Not an engine failure and not the user's doing — the turn never ran,
 * so the honest response is to wait and try again, which is what a chain does automatically. */
export const REPO_BUSY_MARKER = "REPO_BUSY::";

export function isRepoBusy(error: unknown): boolean {
  return String(error).includes(REPO_BUSY_MARKER);
}

// ---------- agent projects ----------

export const listAgentProjects = (workspaceId: string) =>
  invoke<AgentProject[]>("list_agent_projects", { workspaceId });

/** `id` null creates, otherwise the row is updated in place. A blank name is refused backend-side
 * with `agents.projectNameRequired`, which the caller renders translated. */
export const upsertAgentProject = (
  id: string | null,
  workspaceId: string,
  name: string,
  description: string,
  color: string,
) => invoke<AgentProject>("upsert_agent_project", { id, workspaceId, name, description, color });

/** The tasks and chains filed here survive: they only stop being filed. */
export const deleteAgentProject = (id: string) => invoke<void>("delete_agent_project", { id });

export const reorderAgentProjects = (ids: string[]) => invoke<void>("reorder_agent_projects", { ids });

// Filing and pinning deliberately leave `updated_at` alone — the list is ordered by it, and moving
// a task into a folder is not work done on the task.
export const setAgentTaskGroup = (id: string, agentProjectId: string) =>
  invoke<void>("set_agent_task_group", { id, agentProjectId });

export const setAgentTaskPinned = (id: string, pinned: boolean) =>
  invoke<void>("set_agent_task_pinned", { id, pinned });

export const setChainGroup = (chainId: string, agentProjectId: string) =>
  invoke<void>("set_chain_group", { chainId, agentProjectId });

export const setChainPinned = (chainId: string, pinned: boolean) =>
  invoke<void>("set_chain_pinned", { chainId, pinned });

/** Every chain's steps at once, stripped to what the task list draws — the tree needs all of them,
 * which the full rows of {@link getChainDetail} are far too heavy for. */
export const listWorkspaceChainSteps = (workspaceId: string) =>
  invoke<ChainStepBrief[]>("list_workspace_chain_steps", { workspaceId });

// ---------- review memory (review_runs) ----------

export const listReviewRuns = (workspaceId: string) =>
  invoke<ReviewRunSummary[]>("list_review_runs", { workspaceId });

export const getReviewRun = (id: string) => invoke<ReviewRunDetail | null>("get_review_run", { id });

/** `estado` is "falso_positivo" | "ignorado" to mark, or "abierto" to clear the mark. */
export const markReviewFinding = (runId: string, findingId: string, estado: string, motivo?: string) =>
  invoke<void>("mark_review_finding", { runId, findingId, estado, motivo: motivo ?? null });

/**
 * Rejects one finding of a saved review — the panel's "false positive" action, as opposed to
 * [`markReviewFinding`], which only writes the local mark.
 *
 * `estado` is "falso_positivo" | "ignorado" to reject, or "abierto" to undo. `scopeRepo` promotes
 * the judgement to a standing rule for the whole repository; `notifyHost` replies with the reason
 * on the finding's PR thread and closes it as *won't fix* (no-op when the finding was never
 * published). Neither optional effect can fail the mark itself.
 */
export const discardPrFinding = (
  projectId: string,
  prId: number,
  runId: string,
  findingId: string,
  estado: string,
  motivo: string | undefined,
  scopeRepo: boolean,
  notifyHost: boolean,
) =>
  invoke<DiscardOutcome>("discard_pr_finding", {
    projectId,
    prId,
    runId,
    findingId,
    estado,
    motivo: motivo ?? null,
    scopeRepo,
    notifyHost,
  });

/** Every standing false-positive rule in the workspace, across its repositories. */
export const listFpSuppressions = (workspaceId: string) =>
  invoke<FpSuppression[]>("list_fp_suppressions", { workspaceId });

/** Drops one rule — the finding it denied is reported again from the next review on. */
export const removeFpSuppression = (workspaceId: string, id: string) =>
  invoke<void>("remove_fp_suppression", { workspaceId, id });

export const deleteReviewRun = (id: string) => invoke<void>("delete_review_run", { id });

export const deleteReviewRunsForPr = (projectId: string, prId: number) =>
  invoke<void>("delete_review_runs_for_pr", { projectId, prId });

export const purgeWorkspaceReviewRuns = (workspaceId: string) =>
  invoke<void>("purge_workspace_review_runs", { workspaceId });

/** What an export wrote. `rules` is the standing false positives that travelled with it. */
export interface MemoryExportOutcome {
  runs: number;
  rules: number;
}

/** What an import found in a folder, and what it did with it. */
export interface MemoryImportOutcome {
  imported: number;
  /** Runs this install already had — the harmless case of importing the same folder twice. */
  alreadyPresent: number;
  rules: number;
  /** Repositories named by runs in the folder that no project here is linked to. Named rather than
   * counted, because the fix is to link that repository and import again. */
  unmatchedRepos: string[];
  /** Folders that looked like a run but couldn't be read back. */
  unreadable: number;
}

/**
 * Exports review memory to `destDir`, at one of three scopes: one run (`runId`), every run of one
 * repository (`projectId`), or — with neither — the whole workspace.
 *
 * The last two also carry the standing false positives in scope. A machine restored without those
 * re-argues every finding a human already dismissed, which is most of what this memory is worth.
 */
export const exportReviewRuns = (
  workspaceId: string,
  scope: { runId?: string; projectId?: string },
  destDir: string,
) =>
  invoke<MemoryExportOutcome>("export_review_runs", {
    workspaceId,
    id: scope.runId ?? null,
    projectId: scope.projectId ?? null,
    destDir,
  });

/**
 * Reads a folder written by {@link exportReviewRuns} back into this workspace.
 *
 * Runs are routed to the local project that *is* the repository each one names, so a run whose
 * repository isn't here is reported instead of filed against whatever project shares its id on the
 * machine that wrote it. Nothing already here is overwritten.
 */
export const importReviewRuns = (workspaceId: string, srcDir: string) =>
  invoke<MemoryImportOutcome>("import_review_runs", { workspaceId, srcDir });

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


// ---------- secrets ----------

export const setAdoPat = (org: string, pat: string) => invoke<void>("set_ado_pat", { org, pat });

export const getAdoPat = (org: string) => invoke<string | null>("get_ado_pat", { org });

export const deleteAdoPat = (org: string) => invoke<void>("delete_ado_pat", { org });

export const setGithubToken = (host: string, token: string) =>
  invoke<void>("set_github_token", { host, token });

export const getGithubToken = (host: string) => invoke<string | null>("get_github_token", { host });

export const deleteGithubToken = (host: string) => invoke<void>("delete_github_token", { host });

/** GitLab tokens are keyed per host too — gitlab.com and one or more self-managed instances are a
 * normal thing to be connected to at once, and a token only ever works on the instance that
 * issued it. */
export const setGitlabToken = (host: string, token: string) =>
  invoke<void>("set_gitlab_token", { host, token });

export const getGitlabToken = (host: string) => invoke<string | null>("get_gitlab_token", { host });

export const deleteGitlabToken = (host: string) => invoke<void>("delete_gitlab_token", { host });

/** Validates the saved token and returns the username it belongs to, so a wrong or expired one is
 * reported the moment it is pasted rather than the next time a merge request list is opened. */
export const gitlabAuthenticatedUser = (host: string) =>
  invoke<string>("gitlab_authenticated_user", { host });

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

/** The changed paths for a single checkpoint.
 *
 * `listAiCheckpoints` fills in `changed_paths` for every row, and each one costs a full working
 * tree walk with recursive untracked — so listing twenty checkpoints is twenty walks. This is the
 * per-row version, for a UI that computes them only for the row the user opens. */
export const aiCheckpointChangedPaths = (repoPath: string, checkpointId: string) =>
  invoke<string[]>("ai_checkpoint_changed_paths", { repoPath, checkpointId });

/** Restores the checkpoint's files. Returns the paths that were put back. */
export const restoreAiCheckpoint = (repoPath: string, checkpointId: string) =>
  invoke<string[]>("restore_ai_checkpoint", { repoPath, checkpointId });

export const deleteAiCheckpoint = (repoPath: string, checkpointId: string) =>
  invoke<void>("delete_ai_checkpoint", { repoPath, checkpointId });

export const defaultCommitTemplate = () => invoke<string>("default_commit_template");


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

// ---------- pull requests (Azure DevOps / GitHub / GitLab) ----------

/**
 * Checks an org + PAT pair against Azure DevOps *before* it is saved, resolving to the display
 * name of the account the token belongs to and rejecting with why it didn't work.
 *
 * The token is passed in rather than read from the keychain precisely so this can gate the save:
 * storing first would let a bad token overwrite a good one.
 */
export const adoVerifyPat = (org: string, pat: string) => invoke<string>("ado_verify_pat", { org, pat });

/** The same check for an org whose token is already in the keychain — resolves to the account
 * name, rejects with why the saved connection no longer works (typically an expired PAT). */
export const adoCheckOrg = (org: string) => invoke<string>("ado_check_org", { org });

export const adoListProjects = (org: string) => invoke<AdoProject[]>("ado_list_projects", { org });

export const adoListRepos = (org: string, project: string) =>
  invoke<AdoRepo[]>("ado_list_repos", { org, project });

/** Auto-detects the PR host (Azure DevOps, GitHub or GitLab) straight from the repo's git remote. */
export const autoLinkProject = (projectId: string) =>
  invoke<AutoLinkResult>("auto_link_project", { projectId });

export const linkProjectAdo = (id: string, adoOrg: string, adoProject: string, adoRepoId: string) =>
  invoke<void>("link_project_ado", { id, adoOrg, adoProject, adoRepoId });

export const linkProjectGithub = (id: string, githubOwner: string, githubRepo: string, githubHost: string) =>
  invoke<void>("link_project_github", { id, githubOwner, githubRepo, githubHost });

/** Links a project to a GitLab project by its **full path**, groups and all
 * (`acme/backend/auth`) — the identifier GitLab's own API takes, and the reason there is no
 * owner/repo pair here the way there is for GitHub. */
export const linkProjectGitlab = (id: string, gitlabProject: string, gitlabHost: string) =>
  invoke<void>("link_project_gitlab", { id, gitlabProject, gitlabHost });

/** Clears whichever VCS link (Azure DevOps, GitHub or GitLab) the project currently has. */
export const unlinkProject = (id: string) => invoke<void>("unlink_project", { id });

/** Opens the project's repository home page (GitHub / GitLab / Azure DevOps) in the browser. */
export const openRepoInBrowser = (projectId: string) =>
  invoke<void>("open_repo_in_browser", { projectId });

export const listPullRequests = (projectId: string) =>
  invoke<PullRequestSummary[]>("list_pull_requests", { projectId });

/** Resolves a pasted pull-request or merge-request URL — GitHub (including Enterprise), GitLab
 * (including self-managed) or Azure DevOps — into the PR plus the local repository it belongs to,
 * linking that repository to its host when it wasn't already, so the review runs with the
 * project's full context. */
export const resolvePrLink = (url: string) => invoke<PrLinkResolution>("resolve_pr_link", { url });

export const listPrCommentThreads = (projectId: string, prId: number) =>
  invoke<PrCommentThread[]>("list_pr_comment_threads", { projectId, prId });

/** Closes one comment thread on the host — Azure's "fixed", GitHub's resolved review thread —
 * leaving `body` on it first when given. `wontFix` closes it as *won't fix* instead of *fixed*
 * (Azure distinguishes the two; GitHub has one resolved state), which is what an answered-but-not-
 * applied comment actually is. */
export const resolvePrCommentThread = (
  projectId: string,
  prId: number,
  threadId: number,
  body: string | null,
  wontFix: boolean,
) => invoke<ThreadCloseOutcome>("resolve_pr_comment_thread", { projectId, prId, threadId, body, wontFix });

/** Drafts a reply to a PR comment thread with AI. `conversation` is the thread as text and `note`
 * the gist the reply should carry; returns prose for the user to edit — nothing is posted. */
export const draftPrCommentReply = (conversation: string, note: string | null, runId: string) =>
  invoke<string>("draft_pr_comment_reply", { conversation, note, runId });

/** `force` answers a skip that asked — a draft, a merged PR. Only ever set in reply to a
 * {@link REVIEW_SKIPPED} message the user chose to override; a review never assumes it. */
export const reviewPullRequest = (
  projectId: string,
  prId: number,
  jobId: string,
  level: string,
  force = false,
  agent?: ChatAgentOverride | null,
) =>
  invoke<string>("review_pull_request", {
    projectId,
    prId,
    jobId,
    level,
    force,
    agentProvider: agent?.provider ?? null,
    agentModel: agent?.model ?? null,
    agentPrompt: agent?.prompt ?? null,
  });

/** Prefix the backend puts on a review it stopped to ask about, so the panel can offer "review
 * anyway" instead of rendering a perfectly ordinary draft as a failure. Mirrors
 * `review_pipeline::SKIP_MARKER`. */
export const REVIEW_SKIPPED = "REVIEW_SKIPPED::";

/** One depth level as the settings screen edits it — every value resolved, so the screen shows
 * what a review will really run under even before anything is customised. */
export interface ReviewLevelSettings {
  level: string;
  minConfidence: number;
  minConfidenceBlocker: number;
  severities: string[];
  lenses: number[];
  subagents: boolean;
  nitpicks: boolean;
  filesPerGroup: number;
  maxGroups: number;
  crossFile: boolean;
}

/** The workspace's whole PR review policy. The numbers the engine enforces and freezes into every
 * saved review — deliberately apart from the prompts, which are text handed to a model. */
export interface ReviewEngineConfig {
  levels: ReviewLevelSettings[];
  qualityGate: { blockingSeverities: string[] };
  scope: { include: string[]; exclude: string[] };
  graph: { enabled: boolean; maxSymbols: number; maxCallers: number };
  bundles: { contextLines: number; maxLinesPerFile: number; maxKbPerGroup: number };
  workers: { maxParallel: number };
  /** Every lens the catalog knows, as `[number, label]` — from the editable `review_lenses`
   * prompt, so the level editor offers them by name rather than by number. */
  lensCatalog: [number, string][];
}

export const getReviewEngineConfig = (workspaceId: string) =>
  invoke<ReviewEngineConfig>("get_review_engine_config", { workspaceId });

export const setReviewEngineConfig = (workspaceId: string, config: ReviewEngineConfig) =>
  invoke<void>("set_review_engine_config", { workspaceId, config });

export const resetReviewEngineConfig = (workspaceId: string) =>
  invoke<void>("reset_review_engine_config", { workspaceId });

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

/** What an external drop landed, and what it deliberately didn't. */
export interface ImportOutcome {
  /** Repo-relative paths of everything copied in. */
  copied: string[];
  /** Names left alone because the destination already had one — never overwritten. */
  skipped: string[];
}

/** Copies files and folders from anywhere on disk into `destDir` (repo-relative; `""` is the repo
 * root) — what dragging a selection out of Finder/Explorer onto the editor does. `sources` are the
 * absolute paths the platform handed over with the drag. */
export const copyIntoRepo = (repoPath: string, destDir: string, sources: string[]) =>
  invoke<ImportOutcome>("copy_into_repo", { repoPath, destDir, sources });

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

/** One project's job history, newest first.
 *
 * `limit`/`offset` page it. Omitting them returns the whole table, which is what this did before
 * paging existed — every PR review and analysis the project has ever run, each carrying its full
 * result text, in one IPC response. Callers that render a list should page; the store's
 * "load more" path is what keeps the older entries reachable. */
export const listJobHistory = (projectId: string, limit?: number, offset?: number) =>
  invoke<JobHistoryEntry[]>("list_job_history", { projectId, limit, offset });


export const renameJobHistoryEntry = (id: string, label: string) => invoke<void>("rename_job_history_entry", { id, label });

export const deleteJobHistoryEntry = (id: string) => invoke<void>("delete_job_history_entry", { id });

// ---------- workspace activity (reviews of PRs with no repository here) ----------

/** Everything reviewed from a link in this workspace, newest first. Repository-agnostic by
 * design: these runs have no project, so they follow the workspace instead.
 *
 * Paged the same way as `listJobHistory`, and for the same reason. */
export const listWorkspaceActivity = (workspaceId: string, limit?: number, offset?: number) =>
  invoke<WorkspaceActivityEntry[]>("list_workspace_activity", { workspaceId, limit, offset });

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

/** Replies to and closes one comment thread of the PR behind a link — see
 * {@link resolvePrCommentThread}, which this mirrors for a review with no clone. */
export const prLinkResolveCommentThread = (url: string, threadId: number, body: string | null, wontFix: boolean) =>
  invoke<ThreadCloseOutcome>("pr_link_resolve_comment_thread", { url, threadId, body, wontFix });

/** What the signed-in user has already decided on the PR behind a link. */
export const prLinkDecision = (url: string) => invoke<PrDecision>("pr_link_decision", { url });

/** Approve / request changes / close the PR behind a link. Returns it as the host now reports it,
 * plus the workspace Activity row the decision was filed under. */
export const actOnPrLink = (url: string, workspaceId: string, action: PrAction, body?: string) =>
  invoke<PrLinkActionOutcome>("act_on_pr_link", { url, workspaceId, action, body });

// ---------- user stories: reading the source ----------

/** The wikis of one Azure DevOps project — a project wiki, plus any code wikis published from a
 * repo. Authenticated with the PAT saved for `org`. */
export const adoListWikis = (org: string, project: string) =>
  invoke<AdoWiki[]>("ado_list_wikis", { org, project });

/** Every page of a wiki, flattened and depth-tagged, in the order the wiki lists them. */
export const adoListWikiPages = (org: string, project: string, wiki: string) =>
  invoke<AdoWikiPage[]>("ado_list_wiki_pages", { org, project, wiki });

/** The selected pages' Markdown, concatenated under their own paths — one round trip for the
 * whole selection rather than one per page. */
export const adoWikiPagesContent = (org: string, project: string, wiki: string, paths: string[]) =>
  invoke<string>("ado_wiki_pages_content", { org, project, wiki, paths });

// ---------- user stories: the board target ----------

/** The kinds of work item the target project offers. Read from the host in both cases: which types
 * exist depends on the Azure process ("User Story" on Agile, "Product Backlog Item" on Scrum) or on
 * the Jira issue-type scheme, and neither is knowable from here. */
export const boardListItemTypes = (provider: BoardProvider, org: string, project: string) =>
  invoke<BoardItemType[]>("board_list_item_types", { provider, org, project });

/** The Jira projects the saved account can see. Azure's equivalent is `adoListProjects`, which the
 * pull-request side already had. */
export const jiraListProjects = (site: string) =>
  invoke<{ key: string; name: string }[]>("jira_list_projects", { site });

export const setJiraToken = (site: string, token: string) =>
  invoke<void>("set_jira_token", { site, token });

export const getJiraToken = (site: string) => invoke<string | null>("get_jira_token", { site });

export const deleteJiraToken = (site: string) => invoke<void>("delete_jira_token", { site });

/** Who a monday.com token belongs to. The connect step: monday has one API host for everyone, so
 * the token is the whole identity and the slug it resolves to is what everything else is keyed by. */
export const mondayWhoami = (token: string) =>
  invoke<{ slug: string; name: string }>("monday_whoami", { token });

export const mondayListBoards = (slug: string) =>
  invoke<{ id: string; name: string }[]>("monday_list_boards", { slug });

/** Which of a board's columns were matched to a story's parts. Shown in the target panel, because a
 * detection the user can't see is one they can't correct. */
export const mondayBoardSchema = (slug: string, boardId: string) =>
  invoke<MondayBoardSchema>("monday_board_schema", { slug, boardId });

export const setMondayToken = (slug: string, token: string) =>
  invoke<void>("set_monday_token", { slug, token });

export const deleteMondayToken = (slug: string) => invoke<void>("delete_monday_token", { slug });

/** The project's area or iteration tree, flattened, with each node's path already in the form the
 * work item field takes. */
export const adoListClassificationNodes = (org: string, project: string, structure: "areas" | "iterations") =>
  invoke<AdoClassificationNode[]>("ado_list_classification_nodes", { org, project, structure });

// ---------- user stories: batches ----------

export const listStoryBatches = (workspaceId: string) =>
  invoke<StoryBatch[]>("list_story_batches", { workspaceId });

export const getStoryBatch = (id: string) =>
  invoke<StoryBatchDetail | null>("get_story_batch", { id });

/** Creates the batch with its source already captured; the stories arrive when the generation
 * runs. `sourceText` is copied, not referenced — the wiki it came from will move on. */
export const createStoryBatch = (
  workspaceId: string,
  projectId: string | null,
  title: string,
  sourceKind: StorySourceKind,
  sourceRef: string,
  sourceText: string,
  instructions: string,
) =>
  invoke<StoryBatch>("create_story_batch", {
    workspaceId,
    projectId,
    title,
    sourceKind,
    sourceRef,
    sourceText,
    instructions,
  });

export const renameStoryBatch = (id: string, title: string) =>
  invoke<void>("rename_story_batch", { id, title });

/** One Azure Boards target per batch — "publish the selected stories" has to be a single
 * decision, not one dropdown per card. */
export const setStoryBatchTarget = (
  id: string,
  boardProvider: BoardProvider,
  adoOrg: string,
  adoProject: string,
  workItemType: string,
  areaPath: string,
  iterationPath: string,
  tags: string,
) =>
  invoke<void>("set_story_batch_target", {
    id,
    boardProvider,
    adoOrg,
    adoProject,
    workItemType,
    areaPath,
    iterationPath,
    tags,
  });

/** The extra instructions the *next* generation runs with. The captured source is untouched, which
 * is what makes re-running a comparison rather than a fresh start. */
export const setStoryBatchInstructions = (id: string, instructions: string) =>
  invoke<void>("set_story_batch_instructions", { id, instructions });

/** The answers to the set's open questions. The whole list is written at once — it is a form, and
 * half-saved forms are how two answers end up contradicting each other. Answers whose question has
 * since disappeared are kept: the documentation was still missing that fact. */
export const setStoryBatchAnswers = (id: string, answers: QuestionAnswer[]) =>
  invoke<void>("set_story_batch_answers", { id, answers });

/** The repositories whose code this set's acceptance criteria are checked against. An empty list
 * clears them. Not the same as the set's source repository: a backlog derived from a product wiki is
 * routinely verified against the services that implement it — plural, because one capability is
 * normally split across several of them. */
export const setStoryBatchVerifyProjects = (id: string, projectIds: string[]) =>
  invoke<void>("set_story_batch_verify_projects", { id, projectIds });

/** Which of those repositories the `.feature` file is written into. `null` falls back to the first
 * of the set. */
export const setStoryBatchFeatureProject = (id: string, projectId: string | null) =>
  invoke<void>("set_story_batch_feature_project", { id, projectId });

export const deleteStoryBatch = (id: string) => invoke<void>("delete_story_batch", { id });

/** Derives the batch's stories from the documentation it already holds. Re-runnable: stories
 * already published survive it, fresh proposals are appended after them. */
export const generateStories = (
  batchId: string,
  runId: string,
  agent?: { provider: string; model: string },
) =>
  invoke<StoryBatchDetail>("generate_stories", {
    batchId,
    runId,
    agentProvider: agent?.provider ?? null,
    agentModel: agent?.model ?? null,
  });

/** Exactly what the last generation sent to the model, rebuilt from the snapshot taken when it ran.
 * Falls back to today's template for sets generated before that snapshot existed, and says so. */
export const storyBatchPrompt = (id: string) =>
  invoke<StoryBatchPrompt>("story_batch_prompt", { id });

// ---------- user stories: one story ----------

export const addStoryDraft = (batchId: string) => invoke<StoryDraft>("add_story_draft", { batchId });

/** Saves the user's edits. Never touches `work_item_id` — editing a published story changes the
 * draft here, not the work item on Azure. */
export const saveStoryDraft = (
  id: string,
  fields: {
    title: string;
    narrative: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;
    storyPoints: number;
    /** Hours, next to the points rather than instead of them — Azure keeps both. `0` publishes
     *  the story without an Original Estimate. */
    originalEstimate: number;
    tags: string;
    notes: string;
  },
) =>
  invoke<StoryDraft>("save_story_draft", {
    id,
    title: fields.title,
    narrative: fields.narrative,
    description: fields.description,
    acceptanceCriteria: fields.acceptanceCriteria,
    priority: fields.priority,
    storyPoints: fields.storyPoints,
    originalEstimate: fields.originalEstimate,
    tags: fields.tags,
    notes: fields.notes,
  });

export const deleteStoryDraft = (id: string) => invoke<void>("delete_story_draft", { id });

/** Checks the set's acceptance criteria against the code of the repository it points at, and
 * files a verdict per criterion with the evidence behind it. Read-only: the engine is pointed at
 * the working copy to look, never to change it. `storyIds` empty means every story that has
 * criteria. */
export const verifyStories = (
  batchId: string,
  runId: string,
  storyIds: string[],
  agent?: { provider: string; model: string },
) =>
  invoke<StoryBatchDetail>("verify_stories", {
    batchId,
    runId,
    storyIds,
    agentProvider: agent?.provider ?? null,
    agentModel: agent?.model ?? null,
  });

/** Writes the set's Gherkin into `<repo>/features/<name>.feature`, in the repository the criteria
 * are verified against. Returns the absolute path it landed on. */
export const writeStoryFeatureFile = (batchId: string, fileName: string, contents: string) =>
  invoke<string>("write_story_feature_file", { batchId, fileName, contents });

/** Creates one work item per selected story. Already-published stories are skipped, and every
 * story is attempted even when an earlier one fails. */
export const publishStories = (batchId: string, storyIds: string[]) =>
  invoke<StoryPublishOutcome>("publish_stories", { batchId, storyIds });

// ---------- reviewing a work item that is already on the board ----------

/** Resolves whatever was pasted — an Azure link or id, a Jira link or `PROJ-123` — into the host,
 * the project and the identifier it names, along with which board can act on it. */
export const boardParseItemRef = (input: string) =>
  invoke<WorkItemRef>("board_parse_item_ref", { input });

/** One work item and the children it already has. Both identifiers travel because the two boards
 * address an item differently: Azure by number, Jira by key. */
export const boardGetWorkItem = (provider: BoardProvider, org: string, id: number, key?: string) =>
  invoke<BoardWorkItem>("board_get_work_item", { provider, org, id, key });

/**
 * Runs one stage of the review against a repository.
 *
 * `storyText` is assembled here rather than in Rust: Azure's HTML becomes text in the frontend, and
 * sending anything else would judge a story the user never saw.
 */
export const reviewWorkItem = (input: {
  workspaceId: string;
  /** Zero or more. Each is read by its own engine run and the answers are merged in Rust; none
   *  judges the story on its text alone. */
  projectIds: string[];
  stage: WorkItemReviewStage;
  kind: WorkItemKind;
  storyText: string;
  /** Whether the workspace's review contexts travel with the story. */
  useContext: boolean;
  runId: string;
  agent?: { provider: string; model: string };
}) =>
  invoke<WorkItemReviewResult>("review_work_item", {
    workspaceId: input.workspaceId,
    projectIds: input.projectIds,
    stage: input.stage,
    kind: input.kind,
    storyText: input.storyText,
    useContext: input.useContext,
    runId: input.runId,
    agentProvider: input.agent?.provider,
    agentModel: input.agent?.model,
  });

/**
 * Writes reviewed text back onto the work item it came from.
 *
 * Every field is optional and omitting one leaves it alone — which is not the same as sending an
 * empty string, that being a real edit ("the user emptied this").
 */
export const boardUpdateWorkItem = (input: {
  provider: BoardProvider;
  org: string;
  /** The container the item lives in, as the host addresses it. Only monday needs it — a column
   *  write there is addressed by board *and* item — but it travels for all three. */
  project?: string;
  id: number;
  key?: string;
  title?: string;
  description?: string;
  reproSteps?: string;
  acceptanceCriteria?: string[];
  /** The estimate, in the unit the item's own process names it. `0` clears it; omitting the field
   *  leaves it alone. Send `effortField` with it — the item's own `effort_field` — so the value
   *  lands in the field the board already shows rather than in a second one nobody looks at. */
  effort?: number;
  effortField?: string;
  /** Whether `description`/`reproSteps` are already HTML. The review screen edits them as Markdown
   *  and renders them here, where the parser is; without this the backend escapes the marks and the
   *  board shows a paragraph starting with two hash characters. */
  proseIsHtml?: boolean;
}) => invoke<BoardItemRef>("board_update_work_item", input);

/** Creates the accepted tasks as children of the story, in order, stopping at the first failure. */
export const boardCreateChildTasks = (input: {
  provider: BoardProvider;
  org: string;
  project: string;
  parentId: number;
  parentKey?: string;
  workItemType: string;
  /** `kind` picks the fields that say what kind of work it is (Azure's Activity, and the team's
   *  own "task type" field where the project has one). The planning numbers are whatever the user
   *  left on the card; `0` publishes without that field. */
  tasks: {
    title: string;
    detail: string;
    kind: "dev" | "qa";
    priority: number;
    estimateHours: number;
  }[];
}) => invoke<BoardItemRef[]>("board_create_child_tasks", input);

// ---------- technical documentation ----------

export const listDocPages = (workspaceId: string) => invoke<DocPage[]>("list_doc_pages", { workspaceId });

export const createDocPage = (input: {
  workspaceId: string;
  /** The repository being documented; omit for a workspace-scope document. */
  projectId?: string;
  scope: DocScope;
  title: string;
}) => invoke<DocPage>("create_doc_page", input);

/**
 * Brings a page that already exists in the wiki into the app as a document.
 *
 * It lands with its target pointing back at where it came from, so the round trip works: read it,
 * edit it (or have the model rewrite it), publish it back over the same path. Nothing is written
 * to Azure here.
 */
export const importWikiPage = (input: {
  workspaceId: string;
  /** The repository the page is about; omit for a workspace-scope document. */
  projectId?: string;
  scope: DocScope;
  org: string;
  project: string;
  wikiId: string;
  wikiName: string;
  /** Wiki-absolute, starting with «/» — the exact path, as the wiki spells it. */
  path: string;
  /** Overrides the title taken from the last path segment. */
  title?: string;
}) => invoke<DocPage>("import_wiki_page", input);

/** One wiki page as Azure holds it right now — its Markdown and, when the host will give it up,
 *  who wrote it and when it last changed. */
export const adoWikiPageDetail = (org: string, project: string, wiki: string, path: string) =>
  invoke<AdoWikiPageDetail>("ado_wiki_page_detail", { org, project, wiki, path });

export const setDocPageContent = (id: string, content: string) =>
  invoke<void>("set_doc_page_content", { id, content });

export const setDocPageTitle = (id: string, title: string) => invoke<void>("set_doc_page_title", { id, title });

export const setDocPageTarget = (input: {
  id: string;
  org: string;
  project: string;
  wikiId: string;
  wikiName: string;
  pagePath: string;
}) => invoke<void>("set_doc_page_target", input);

export const deleteDocPage = (id: string) => invoke<void>("delete_doc_page", { id });

/** Publishes a stored document to its configured wiki and records that it landed. */
export const publishDocPage = (id: string) => invoke<AdoWikiPageRef>("publish_doc_page", { id });

/**
 * Generates a document's content by reading the code.
 *
 * For `workspace` scope this runs once per repository and then a synthesis pass — no single engine
 * run can see two checkouts, so the architecture document is written from the grounded ones.
 */
export const generateDocPage = (input: {
  workspaceId: string;
  docId: string;
  scope: DocScope;
  projectIds: string[];
  instructions: string;
  useContext: boolean;
  runId: string;
  agent?: { provider: string; model: string };
}) =>
  invoke<DocResult>("generate_doc_page", {
    workspaceId: input.workspaceId,
    docId: input.docId,
    scope: input.scope,
    projectIds: input.projectIds,
    instructions: input.instructions,
    useContext: input.useContext,
    runId: input.runId,
    agentProvider: input.agent?.provider,
    agentModel: input.agent?.model,
  });

/** Publishes one page to a wiki. Azure DevOps today; a second host gets its own command. */
export const adoPublishWikiPage = (input: {
  org: string;
  project: string;
  wiki: string;
  path: string;
  content: string;
}) => invoke<AdoWikiPageRef>("ado_publish_wiki_page", input);

/** The workspace's saved review sessions, newest first. */
export const listWorkItemReviews = (workspaceId: string) =>
  invoke<WorkItemReviewRow[]>("list_work_item_reviews", { workspaceId });

/** Saves a session under its own id, overwriting the previous save of that same session. */
export const saveWorkItemReview = (input: {
  id: string;
  workspaceId: string;
  org: string;
  workItemId: number;
  workItemType: string;
  workItemUrl: string;
  title: string;
  payload: string;
  engine: string;
  model: string;
  version: string;
}) => invoke<void>("save_work_item_review", input);

export const deleteWorkItemReview = (id: string) => invoke<void>("delete_work_item_review", { id });
