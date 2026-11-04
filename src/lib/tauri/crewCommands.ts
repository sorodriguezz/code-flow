import { invoke } from "@tauri-apps/api/core";
import type { AgentDraft, WorkspaceAgent } from "../../types/domain";
import type { BacklogItem, BacklogLink, BacklogLinkKind, BacklogStatus, DecisionRow, LibraryItem, TicketImport } from "../../types/crew";

export const saveWorkspaceAgent = (draft: AgentDraft) => invoke<WorkspaceAgent>("save_workspace_agent", { draft });
export const reorderWorkspaceAgents = (workspaceId: string, ids: string[]) =>
  invoke<void>("reorder_workspace_agents", { workspaceId, ids });

export const libraryList = (kind?: "agent" | "team") => invoke<LibraryItem[]>("library_list", { kind: kind ?? null });
export const librarySave = (item: LibraryItem) => invoke<LibraryItem>("library_save", { item });
export const libraryDelete = (id: string) => invoke<void>("library_delete", { id });

export const backlogList = (workspaceId: string) => invoke<BacklogItem[]>("backlog_list", { workspaceId });
export const backlogSave = (item: BacklogItem) => invoke<BacklogItem>("backlog_save", { item });
export const backlogMove = (id: string, status: BacklogStatus, rank: number) => invoke<void>("backlog_move", { id, status, rank });
export const backlogDelete = (id: string) => invoke<void>("backlog_delete", { id });
export const backlogLink = (itemId: string, kind: BacklogLinkKind, refId: string) =>
  invoke<BacklogLink>("backlog_link", { itemId, kind, refId });
export const backlogUnlink = (linkId: string) => invoke<void>("backlog_unlink", { linkId });
export const backlogImportTickets = (workspaceId: string, tickets: TicketImport[]) =>
  invoke<BacklogItem[]>("backlog_import_tickets", { workspaceId, tickets });

export const decisionsForRun = (runId: string, limit?: number) => invoke<DecisionRow[]>("decisions_for_run", { runId, limit: limit ?? null });
