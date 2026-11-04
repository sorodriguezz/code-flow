/**
 * The Agents view's own records — mirrors of `src-tauri/src/crew/mod.rs`.
 */

/** A template in the library shared by every workspace. `body` is `AgentTemplateBody` or
 * `TeamTemplateBody` (see `lib/agents/builtinTemplates.ts`). */
export interface LibraryItem {
  id: string;
  kind: "agent" | "team";
  name: string;
  description: string;
  icon: string;
  color: string;
  tags: string[];
  body: unknown;
  /** `builtin:<key>` when it is an edited copy of a built-in template. */
  based_on: string;
  version: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type BacklogStatus = "backlog" | "ready" | "doing" | "review" | "done";
export type BacklogKind = "story" | "task" | "bug";
export type BacklogMode = "" | "solo" | "race" | "team" | "flow" | "hybrid" | "story";
export type BacklogLinkKind = "task" | "race" | "chain" | "team_run";

export interface Criterion {
  id: string;
  text: string;
  done: boolean;
}

export interface BacklogLink {
  id: string;
  item_id: string;
  kind: BacklogLinkKind;
  ref_id: string;
  created_at: string;
}

export interface BacklogTicket {
  provider: string;
  uid: string;
  key: string;
  url: string;
  title: string;
}

/** How a card is started, as the «¿Cómo lo hacen?» dialog left it. */
export interface BacklogModeConfig {
  racers?: string[];
  flowTemplateId?: string;
  branch?: string;
  /** A team run's target branch per repository (project id → branch); `""` the checked-out one. */
  branches?: Record<string, string>;
  worktree?: boolean;
  preset?: "autonomous" | "supervised" | "stepwise";
}

export interface BacklogItem {
  id: string;
  workspace_id: string;
  parent_id: string;
  kind: BacklogKind;
  title: string;
  body: string;
  criteria: Criterion[];
  status: BacklogStatus;
  rank: number;
  priority: number;
  labels: string[];
  repos: string[];
  assignee_kind: "" | "agent" | "team";
  assignee_id: string;
  mode: BacklogMode;
  mode_config: BacklogModeConfig;
  ticket: BacklogTicket | null;
  agent_project_id: string;
  created_at: string;
  updated_at: string;
  links: BacklogLink[];
}

export interface TicketImport {
  provider: string;
  uid: string;
  key: string;
  url: string;
  title: string;
  kind: BacklogKind;
  body: string;
}

/** One finite choice the decision layer made (`src-tauri/src/decide`). */
export interface DecisionRow {
  id: string;
  workspace_id: string;
  run_id: string;
  item_id: string;
  /** `route`, `model`, `retry`, `risk`, `ask`, `review`. */
  kind: string;
  question: string;
  options: string[];
  choice: string;
  /** How much the votes agreed, 0…1. */
  p: number;
  /** True when the code acted on it; false when it escalated. */
  sharp: boolean;
  /** `rules`, `local`, `haiku`, `jev`, `escalated`. */
  source: string;
  votes: string[];
  ms: number;
  saved_tokens: number;
  created_at: string;
}

export function emptyBacklogItem(workspaceId: string, kind: BacklogKind = "task"): BacklogItem {
  return {
    id: "",
    workspace_id: workspaceId,
    parent_id: "",
    kind,
    title: "",
    body: "",
    criteria: [],
    status: "backlog",
    rank: 0,
    priority: 0,
    labels: [],
    repos: [],
    assignee_kind: "",
    assignee_id: "",
    mode: "",
    mode_config: {},
    ticket: null,
    agent_project_id: "",
    created_at: "",
    updated_at: "",
    links: [],
  };
}
