import { invoke } from "./invoke";
import type { BoardProvider } from "../../types/domain";

/**
 * «Tickets» (Agentes › Tareas): the work assigned to you on every connected board, and the path from
 * one of them to a merged pull request — see `commands/tickets_cmd.rs`. Kept out of `commands.ts`,
 * which every feature edits, so this one's wrappers and types live together.
 */

/** One ticket, the same shape whichever board it came from (`boards::tickets::Ticket`). */
export interface Ticket {
  provider: BoardProvider;
  /** Azure organisation, Jira site, GitHub/GitLab host, Linear key, monday slug. */
  account: string;
  /** The container as people read it: Azure project, Jira project, `owner/repo`, Linear team, monday board. */
  project: string;
  container_id: string;
  id: number;
  /** Jira/Linear key, `owner/repo#12` on GitHub/GitLab; empty on Azure and monday. */
  key: string;
  title: string;
  state: string;
  /** `todo` | `doing` | `review` | `done` | "". */
  state_category: string;
  work_item_type: string;
  sprint: string;
  priority: string;
  url: string;
  updated_at: string;
  state_field: string;
  /** Display name of whoever it is assigned to; empty for nobody. Filled when the list shows everyone's. */
  assigned_to?: string;
}

export interface TicketComment {
  author: string;
  created_at: string;
  body_html: string;
}

export interface TicketDetail {
  ticket: Ticket;
  description_html: string;
  acceptance_criteria_html: string;
  comments: TicketComment[];
}

export interface TicketState {
  id: string;
  name: string;
  category: string;
}

export interface TicketSourceError {
  provider: BoardProvider;
  account: string;
  message: string;
}

export interface TicketList {
  tickets: Ticket[];
  errors: TicketSourceError[];
}

export interface TicketMove {
  ticket: Ticket;
  from: string;
  to: string;
}

export interface TicketLink {
  id: string;
  workspace_id: string;
  project_id: string;
  ticket_uid: string;
  ticket: Ticket;
  branch: string;
  worktree_path: string;
  pr_id: number;
  pr_url: string;
  /** `started` | `review` | `done`. */
  stage: string;
  created_at: string;
  updated_at: string;
}

export interface TicketStart {
  link: TicketLink;
  path: string;
  branch: string;
  prompt: string;
  reused: boolean;
}

export interface TicketPrReference {
  ticket: Ticket;
  title_prefix: string;
  body_line: string;
  work_item_ids: number[];
}

/** What an automatic move did — `moved` null and `error` empty when there was nothing to do. */
export interface TicketAuto {
  moved: TicketMove | null;
  error: string;
}

export const ticketsList = () => invoke<TicketList>("tickets_list");

/** The projects of each connected Azure organisation, for the «Proyectos» menu. */
export const ticketsAzureProjects = () => invoke<{ account: string; projects: string[] }[]>("tickets_azure_projects");
export const ticketsDetail = (ticket: Ticket) => invoke<TicketDetail>("tickets_detail", { ticket });
export const ticketsStates = (ticket: Ticket) => invoke<TicketState[]>("tickets_states", { ticket });
export const ticketsMove = (ticket: Ticket, state: string) => invoke<TicketMove>("tickets_move", { ticket, state });
export const ticketsLinks = (workspaceId: string) => invoke<TicketLink[]>("tickets_links", { workspaceId });
export const ticketsUnlink = (id: string) => invoke<void>("tickets_unlink", { id });
export const ticketsBranchName = (ticket: Ticket) => invoke<string>("tickets_branch_name", { ticket });
export const ticketsStart = (workspaceId: string, projectId: string, ticket: Ticket, branch: string | null) =>
  invoke<TicketStart>("tickets_start", { workspaceId, projectId, ticket, branch });
export const ticketsPrReference = (projectId: string, branch: string) =>
  invoke<TicketPrReference | null>("tickets_pr_reference", { projectId, branch });
export const ticketsApplyReference = (title: string, body: string, titlePrefix: string, bodyLine: string) =>
  invoke<[string, string]>("tickets_apply_reference", { title, body, titlePrefix, bodyLine });
export const ticketsOnPrCreated = (projectId: string, branch: string, prId: number, prUrl: string) =>
  invoke<TicketAuto>("tickets_on_pr_created", { projectId, branch, prId, prUrl });
export const ticketsOnPrMerged = (projectId: string, branch: string) =>
  invoke<TicketAuto>("tickets_on_pr_merged", { projectId, branch });
export const ticketsSync = (workspaceId: string) => invoke<TicketAuto[]>("tickets_sync", { workspaceId });
