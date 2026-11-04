/**
 * «Equipo» — mirrors of `src-tauri/src/team/mod.rs`. See `.claude/plans/agent-team.md`.
 */

import type { AgentTask } from "./domain";

export interface TeamCheck {
  /** A project id, or `"*"` for every repository of the run. */
  repo: string;
  command: string;
  when: "item" | "final";
}

export interface TeamReviewPolicy {
  enabled: boolean;
  reviewer: string;
  /** Members whose work is reviewed; empty is every member that edits. */
  of: string[];
  exigence: "correct" | "polished";
  laps: number;
}

export interface TeamPolicy {
  approve_plan: boolean;
  approve_code: "never" | "first" | "each";
  approve_merge: boolean;
  questions: "allow" | "plan" | "never";
  commit: "item" | "squash" | "none";
  commit_style: "conventional" | "free";
  integrate: "merge" | "branch";
  push: boolean;
  /** A member id, `author` or `user`. */
  conflicts: string;
  checks: TeamCheck[];
  review: TeamReviewPolicy;
  max_parallel: number;
  max_attempts: number;
  max_dispatches: number;
  lead_rounds: number;
  lead_final_check: boolean;
  cleanup: boolean;
}

export interface TeamMember {
  id: string;
  agent_id: string;
  name: string;
  role: string;
  edits: boolean;
  max_parallel: number;
  run_in: "headless" | "terminal";
  repos: string[];
  escalate_to: string;
}

export interface TeamPlanStep {
  key: string;
  member: string;
  /** `"*"` every repository, `""` the first, else a project id. */
  repo: string;
  kind: "work" | "investigate";
  title: string;
  instruction: string;
  depends_on: string[];
}

export interface Team {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  /** Member id, or `""` for a fixed plan. */
  lead: string;
  policy: TeamPolicy;
  plan: TeamPlanStep[];
  members: TeamMember[];
  created_at: string;
  updated_at: string;
}

export interface TeamMemberSnap extends TeamMember {
  provider: string;
  model: string;
  effort: string;
  prompt: string;
  account_id?: string | null;
}

export type TeamRunStatus = "running" | "gated" | "paused" | "done" | "failed" | "aborted";

export interface TeamRun {
  id: string;
  workspace_id: string;
  team_id: string;
  team_name: string;
  title: string;
  goal: string;
  status: TeamRunStatus;
  /** `plan`, `item:<id>`, `merge`, `review:<id>`, `stuck:<id>`. */
  gate: string;
  gate_note: string;
  lead: string;
  lead_rounds_used: number;
  lead_done: boolean;
  dispatches: number;
  last_reason: string;
  agent_project_id: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  policy: TeamPolicy;
  members: TeamMemberSnap[];
}

export interface TeamRunRepo {
  run_id: string;
  project_id: string;
  name: string;
  local_path: string;
  target_branch: string;
  integration_branch: string;
  integration_path: string;
  status: "ready" | "merged" | "left" | "failed";
  last_error: string;
  position: number;
}

export type TeamItemKind = "plan" | "final" | "answer" | "work" | "investigate" | "review" | "integrate";
export type TeamItemStatus = "pending" | "gated" | "running" | "waiting" | "done" | "error" | "cancelled" | "skipped";

export interface TeamItem {
  id: string;
  run_id: string;
  key: string;
  member_id: string;
  member_name: string;
  project_id: string;
  kind: TeamItemKind;
  title: string;
  instruction: string;
  depends_on: string[];
  status: TeamItemStatus;
  approved: boolean;
  task_id: string;
  worktree_path: string;
  branch: string;
  commit_sha: string;
  merged: boolean;
  output_text: string;
  attempts: number;
  last_error: string;
  feedback: string;
  round: number;
  lap: number;
  ref_item: string;
  run_in: "headless" | "terminal";
  terminal_session: string;
  created_at: string;
  updated_at: string;
  started_at: string;
  finished_at: string;
}

export type TeamMessageKind =
  | "plan"
  | "decision"
  | "handoff"
  | "question"
  | "answer"
  | "note"
  | "finding"
  | "status"
  | "merge"
  | "error";

export interface TeamMessage {
  id: string;
  run_id: string;
  item_id: string;
  /** A member id, `user`, `system`. */
  from_id: string;
  from_name: string;
  /** A member id, `lead`, `user`, `all`. */
  to_id: string;
  to_name: string;
  kind: TeamMessageKind;
  body: string;
  options: string[];
  answer: string;
  answered_at: string;
  delivered: boolean;
  created_at: string;
}

export interface TeamRunState {
  run: TeamRun;
  repos: TeamRunRepo[];
  items: TeamItem[];
  messages: TeamMessage[];
}

export interface TeamDispatch {
  item: TeamItem;
  task: AgentTask | null;
  message: string;
  cwd: string;
  runIn: "headless" | "terminal";
  provider: string;
  model: string;
  effort: string;
  title: string;
}

/** Prefix of `agent_tasks.batch_id` for a team item's task. */
export const TEAM_TASK_BATCH_PREFIX = "team:";

export function isTeamTask(task: { batch_id?: string }): boolean {
  return (task.batch_id ?? "").startsWith(TEAM_TASK_BATCH_PREFIX);
}

/** The policy defaults, the same as `team::Policy::default`. */
export function defaultPolicy(): TeamPolicy {
  return {
    approve_plan: true,
    approve_code: "never",
    approve_merge: true,
    questions: "allow",
    commit: "item",
    commit_style: "conventional",
    integrate: "merge",
    push: false,
    conflicts: "author",
    checks: [],
    review: { enabled: false, reviewer: "", of: [], exigence: "correct", laps: 3 },
    max_parallel: 3,
    max_attempts: 3,
    max_dispatches: 64,
    lead_rounds: 6,
    lead_final_check: true,
    cleanup: true,
  };
}

export type PolicyPreset = "autonomous" | "supervised" | "stepwise";

/** The three starting points. Each one is only the approval fields; everything else is kept. */
export function applyPreset(policy: TeamPolicy, preset: PolicyPreset): TeamPolicy {
  switch (preset) {
    case "autonomous":
      return { ...policy, approve_plan: false, approve_code: "never", approve_merge: true, questions: "plan" };
    case "supervised":
      return { ...policy, approve_plan: true, approve_code: "never", approve_merge: true, questions: "allow" };
    case "stepwise":
      return { ...policy, approve_plan: true, approve_code: "each", approve_merge: true, questions: "allow" };
  }
}

export function presetOf(policy: TeamPolicy): PolicyPreset | null {
  for (const preset of ["autonomous", "supervised", "stepwise"] as const) {
    const p = applyPreset(policy, preset);
    if (
      p.approve_plan === policy.approve_plan &&
      p.approve_code === policy.approve_code &&
      p.approve_merge === policy.approve_merge &&
      p.questions === policy.questions
    ) {
      return preset;
    }
  }
  return null;
}

export function emptyMember(): TeamMember {
  return { id: crypto.randomUUID(), agent_id: "", name: "", role: "", edits: true, max_parallel: 1, run_in: "headless", repos: [], escalate_to: "" };
}

export function emptyTeam(workspaceId: string): Team {
  return {
    id: "",
    workspace_id: workspaceId,
    name: "",
    description: "",
    lead: "",
    policy: defaultPolicy(),
    plan: [],
    members: [],
    created_at: "",
    updated_at: "",
  };
}

/** Whether a run still wants the user or is still working. */
export function runIsLive(run: TeamRun): boolean {
  return run.status === "running" || run.status === "gated" || run.status === "paused";
}
