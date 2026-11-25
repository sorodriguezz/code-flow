import { invoke } from "@tauri-apps/api/core";
import type { TeamChatState } from "../../types/team";
import type { ChatAttachment } from "./chatCommands";
import type {
  TeamRunMetrics, Team, TeamCheck, TeamDispatch, TeamPolicy, TeamPrDraft, TeamRecommendation, TeamRun, TeamRunState } from "../../types/team";

export const teamList = (workspaceId: string) => invoke<Team[]>("team_list", { workspaceId });
/** `projectId` is only where members prefer to work: the chat is the team's, in its workspace. */
export const teamChatOpen = (teamId: string, projectId: string | null, fresh = false) => invoke<TeamChatState>("team_chat_open", { teamId, projectId, fresh });
export const teamChatState = (chatId: string) => invoke<TeamChatState>("team_chat_state", { chatId });
export const teamChatDraft = (chatId: string) =>
  invoke<{ teamId: string; projectId: string; goal: string; attachments: ChatAttachment[] }>("team_chat_draft", { chatId });
export interface TeamChatSummary { id: string; title: string; createdAt: string; messages: number }
export const teamChatHistory = (teamId: string) => invoke<TeamChatSummary[]>("team_chat_history", { teamId });
export const teamChatSend = (chatId: string, message: string, attachments?: string[]) => invoke<TeamChatState>("team_chat_send", { chatId, message, attachments: attachments ?? null });
export const teamChatCancel = (chatId: string) => invoke<void>("team_chat_cancel", { chatId });
/** Deletes the conversation with its messages and every member's turns in it. Refused while the team is answering it. */
export const teamChatDelete = (chatId: string) => invoke<void>("team_chat_delete", { chatId });
export const teamSave = (team: Team) => invoke<Team>("team_save", { team });
export const teamDelete = (id: string) => invoke<void>("team_delete", { id });
export const teamRuns = (workspaceId: string) => invoke<TeamRun[]>("team_runs", { workspaceId });
export const teamRunState = (runId: string) => invoke<TeamRunState>("team_run_state", { runId });
export const teamRunMeta = (runId: string, meta: { title?: string; pinned?: boolean; agentProjectId?: string }) =>
  invoke<void>("team_run_meta", {
    runId,
    title: meta.title ?? null,
    pinned: meta.pinned ?? null,
    agentProjectId: meta.agentProjectId ?? null,
  });

export interface TeamRepoPick {
  projectId: string;
  /** `""` is the branch the repository has checked out now. */
  targetBranch: string;
}

export const teamStart = (input: {
  workspaceId: string;
  teamId: string;
  goal: string;
  title?: string;
  repos: TeamRepoPick[];
  policy?: TeamPolicy | null;
  agentProjectId?: string;
}) =>
  invoke<TeamRunState>("team_start", {
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    goal: input.goal,
    title: input.title ?? null,
    repos: input.repos,
    policy: input.policy ?? null,
    agentProjectId: input.agentProjectId ?? null,
  });

export const teamClaim = (runId: string) => invoke<TeamDispatch[]>("team_claim", { runId });
export const teamSettle = (itemId: string, outcome: "ok" | "error" | "busy" | "cancelled", text?: string, error?: string) =>
  invoke<TeamRunState>("team_settle", { itemId, outcome, text: text ?? null, error: error ?? null });
export const teamAnswer = (messageId: string, answer: string) => invoke<TeamRunState>("team_answer", { messageId, answer });
export const teamNote = (runId: string, toId: string, body: string) => invoke<TeamRunState>("team_note", { runId, toId, body });
export const teamAmend = (runId: string, body: string) => invoke<TeamRunState>("team_amend", { runId, body });
export const teamRecommendations = (runId: string) => invoke<TeamRecommendation[]>("team_recommendations", { runId });

/** One agent or team a routine puts to work — `team/routines.rs`. */
export interface TeamRoutineWorker {
  nodeId: string;
  nodeName: string;
  kind: "team" | "agent" | "agents" | "lead";
  /** The team's id or the roster agents' ids; empty when it is decided as the flow runs. */
  refs: string[];
  ask: string;
}

/** A flow that puts this workspace's agents or teams to work. */
export interface TeamRoutine {
  flowId: string;
  name: string;
  description: string;
  active: boolean;
  global: boolean;
  triggers: string[];
  workers: TeamRoutineWorker[];
  lastRun: { status: string; startedAt: string; error: string } | null;
  runs: number;
  failed: number;
}

export const teamRoutines = (workspaceId: string) => invoke<TeamRoutine[]>("team_list_routines", { workspaceId });
/** The test suites a repository has, read off its manifests, for «Verificaciones» to start from. */
export const teamDetectChecks = (projectId: string) => invoke<TeamCheck[]>("team_detect_checks", { projectId });
export const teamPrDraft = (runId: string, projectId: string, spanish: boolean) =>
  invoke<TeamPrDraft>("team_pr_draft", { runId, projectId, spanish });
export const teamRemember = (runId: string, messageId: string, projectId: string, keep: boolean) =>
  invoke<TeamRunState>("team_remember", { runId, messageId, projectId, keep });
export const teamDecide = (runId: string, approve: boolean, comment?: string, expectedGate?: string) =>
  invoke<TeamRunState>("team_decide", { runId, approve, comment: comment ?? null, expectedGate: expectedGate ?? null });
/** `pause`, `resume`, `abort`, `retry:<item>`, `skip:<item>`. Returns the tasks that were running. */
export const teamControl = (runId: string, action: string) => invoke<string[]>("team_control", { runId, action });
export const teamItemTerminal = (itemId: string, sessionId: string) => invoke<void>("team_item_terminal", { itemId, sessionId });
export const teamDeleteRun = (runId: string) => invoke<void>("team_delete_run", { runId });

export const teamRunPolicy = (runId: string, policy: TeamPolicy) => invoke<TeamRunState>("team_run_policy", { runId, policy });
export const teamRunMetrics = (runId: string) => invoke<TeamRunMetrics>("team_run_metrics", { runId });
export const teamRunArtifacts = (runId: string) =>
  invoke<import("./chatRefsCommands").ChatArtifactSummary[]>("team_run_artifacts", { runId });

/** Whether this computer can run a team's checks isolated — `team/sandbox.rs`. */
export interface TeamSandboxStatus {
  available: boolean;
  /** `OrbStack`, `Docker Desktop`, `podman`… */
  engine: string;
  /** `""`, `none` (nothing installed) or `stopped` (installed, not running). */
  problem: string;
}
export const teamSandboxStatus = (fresh = false) => invoke<TeamSandboxStatus>("team_sandbox_status", { fresh });

/** One thing on an agent's plate — `team/inbox.rs`. */
export interface TeamInboxEntry {
  kind: "question" | "failure" | "gate" | "task" | "queued" | "note" | "card";
  runId: string;
  runTitle: string;
  itemId: string;
  messageId: string;
  cardId: string;
  memberId: string;
  title: string;
  detail: string;
  at: string;
}
export interface TeamAgentInbox {
  agentId: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  teams: string[];
  waiting: number;
  working: number;
  queued: number;
  entries: TeamInboxEntry[];
}
export const teamInboxes = (workspaceId: string) => invoke<TeamAgentInbox[]>("team_list_inboxes", { workspaceId });

/** One team's result in a comparison — `team/lab.rs`. */
export interface TeamEvalEntry {
  teamId: string;
  teamName: string;
  runId: string;
  error: string;
  status: "running" | "gated" | "paused" | "done" | "aborted" | "failed" | "gone" | (string & {});
  gate: string;
  finished: boolean;
  scored: boolean;
  scores: { command: string; result: "passed" | "failed" | "unavailable" | (string & {}); detail: string }[];
  passed: number;
  usd: number;
  tokens: number;
  minutes: number;
  tasksDone: number;
  tasksTotal: number;
  retries: number;
  files: number;
  insertions: number;
  deletions: number;
  /** 1 is the best; 0 while the comparison is not decided, or for a team that delivered nothing. */
  rank: number;
}
export interface TeamEval {
  id: string;
  title: string;
  goal: string;
  projectId: string;
  projectName: string;
  baseBranch: string;
  baseSha: string;
  checks: string[];
  createdAt: string;
  entries: TeamEvalEntry[];
  state: "running" | "scoring" | "decided";
  winner: string;
}
export const teamEvals = (workspaceId: string) => invoke<TeamEval[]>("team_list_evals", { workspaceId });
export const teamEvalStart = (input: { workspaceId: string; title: string; goal: string; projectId: string; targetBranch: string; teamIds: string[]; checks: string[] }) =>
  invoke<TeamEval>("team_eval_start", input);
export const teamEvalScore = (evalId: string) => invoke<TeamEval>("team_eval_score", { evalId });
export const teamEvalDelete = (evalId: string) => invoke<void>("team_eval_delete", { evalId });

/** A seat of a team a chat proposed, as the review dialog draws it. */
export interface TeamProposalSeat {
  name: string;
  role: string;
  agent: string;
  /** The agent does not exist yet: accepting the proposal makes it. */
  fresh: boolean;
  provider: string;
  model: string;
  edits: boolean;
  lead: boolean;
  handsOn: boolean;
  advisor: boolean;
  subLead: boolean;
  reviewer: boolean;
  /** The seat it answers to, by name; empty is the lead. */
  reportsTo: string;
  /** Repository names; empty is every one. */
  repos: string[];
  icon: string;
  color: string;
}

/** Something the user should know before accepting — worded here, in their language. */
export interface TeamProposalFlag {
  kind: "model_unchecked" | "agent_off" | "sublead_alone" | "no_engine" | "nobody_writes" | "read_only_unenforced" | "unmetered" | "guarantees_block" | "merge_unasked";
  who: string;
  what: string;
}

/** A team a chat designed in a turn that could not create it: it waits for the user's yes. */
export interface TeamProposal {
  id: string;
  workspaceId: string;
  createdAt: string;
  /** Accepting it replaces a team that exists. */
  updating: boolean;
  team: Team;
  seats: TeamProposalSeat[];
  /** The agents accepting it adds to the roster. */
  agents: { name: string; role: string; provider: string; model: string; effort: string; prompt: string; icon: string; color: string }[];
  flags: TeamProposalFlag[];
}

export const teamProposals = (workspaceId: string) => invoke<TeamProposal[]>("team_list_proposals", { workspaceId });
/** The user's yes: creates the proposed team with the agents it needs. */
export const teamProposalAccept = (id: string) => invoke<Team>("team_proposal_accept", { id });
export const teamProposalDismiss = (id: string) => invoke<void>("team_proposal_dismiss", { id });

/** Starts a new run from where another was: before one of its tasks, or from what it integrated. */
export const teamForkRun = (input: { runId: string; itemId?: string; goal?: string; teamId?: string }) =>
  invoke<TeamRunState>("team_fork_run", { runId: input.runId, itemId: input.itemId ?? null, goal: input.goal ?? null, teamId: input.teamId ?? null });
