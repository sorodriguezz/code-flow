import { invoke } from "@tauri-apps/api/core";
import type { TeamChatState } from "../../types/team";
import type { ChatAttachment } from "./chatCommands";
import type {
  TeamRunMetrics, Team, TeamDispatch, TeamPolicy, TeamPrDraft, TeamRecommendation, TeamRun, TeamRunState } from "../../types/team";

export const teamList = (workspaceId: string) => invoke<Team[]>("team_list", { workspaceId });
export const teamChatOpen = (teamId: string, projectId: string, fresh = false) => invoke<TeamChatState>("team_chat_open", { teamId, projectId, fresh });
export const teamChatState = (chatId: string) => invoke<TeamChatState>("team_chat_state", { chatId });
export const teamChatDraft = (chatId: string) =>
  invoke<{ teamId: string; projectId: string; goal: string; attachments: ChatAttachment[] }>("team_chat_draft", { chatId });
export interface TeamChatSummary { id: string; title: string; createdAt: string }
export const teamChatHistory = (teamId: string, projectId: string) => invoke<TeamChatSummary[]>("team_chat_history", { teamId, projectId });
export const teamChatSend = (chatId: string, message: string, attachments?: string[]) => invoke<TeamChatState>("team_chat_send", { chatId, message, attachments: attachments ?? null });
export const teamChatCancel = (chatId: string) => invoke<void>("team_chat_cancel", { chatId });
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
