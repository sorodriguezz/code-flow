import { invoke } from "@tauri-apps/api/core";
import type {
  TeamRunMetrics, Team, TeamDispatch, TeamPolicy, TeamRun, TeamRunState } from "../../types/team";

export const teamList = (workspaceId: string) => invoke<Team[]>("team_list", { workspaceId });
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
export const teamDecide = (runId: string, approve: boolean, comment?: string) =>
  invoke<TeamRunState>("team_decide", { runId, approve, comment: comment ?? null });
/** `pause`, `resume`, `abort`, `retry:<item>`, `skip:<item>`. Returns the tasks that were running. */
export const teamControl = (runId: string, action: string) => invoke<string[]>("team_control", { runId, action });
export const teamItemTerminal = (itemId: string, sessionId: string) => invoke<void>("team_item_terminal", { itemId, sessionId });
export const teamDeleteRun = (runId: string) => invoke<void>("team_delete_run", { runId });

export const teamRunPolicy = (runId: string, policy: TeamPolicy) => invoke<TeamRunState>("team_run_policy", { runId, policy });
export const teamRunMetrics = (runId: string) => invoke<TeamRunMetrics>("team_run_metrics", { runId });
export const teamRunArtifacts = (runId: string) =>
  invoke<import("./chatRefsCommands").ChatArtifactSummary[]>("team_run_artifacts", { runId });
