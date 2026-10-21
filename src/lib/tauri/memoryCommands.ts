import { invoke } from "@tauri-apps/api/core";

/** The Memory Engine. Mirrors `src-tauri/src/ai_memory/mod.rs` and `commands/memory_cmd.rs`. */

export type MemoryScope = "global" | "workspace" | "project" | "task";
export type MemoryKind = "preference" | "convention" | "decision" | "fact";
export type MemoryStatus = "candidate" | "approved" | "revoked";
/** What a create did — `ai_memory::Remembered`. */
export type MemoryOutcome = "new" | "approved" | "updated" | "already_known";

/** Days without use after which an approved memory shows as «sin uso» (`ai_memory::STALE_DAYS`). */
export const MEMORY_STALE_DAYS = 90;

export interface Memory {
  id: string;
  scope: MemoryScope;
  workspaceId: string | null;
  projectId: string | null;
  taskRef: string | null;
  kind: MemoryKind;
  title: string;
  body: string;
  status: MemoryStatus;
  /** `user`, `agent`, `flow`, `experience`… */
  source: string;
  evidence: string[];
  supersedes: string | null;
  localOnly: boolean;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  usedAt: number | null;
  useCount: number;
  /** When the user last vouched for the text (approved or edited it); approved memories only. */
  approvedAt: number | null;
  /** Approved and unused for `MEMORY_STALE_DAYS`. */
  stale: boolean;
  /** The title of the memory this one replaces, while it exists. */
  supersedesTitle: string | null;
}

export interface NewMemory {
  scope: MemoryScope;
  workspaceId?: string | null;
  projectId?: string | null;
  kind: MemoryKind;
  title: string;
  body: string;
  approved: boolean;
  localOnly?: boolean;
  expiresAt?: number | null;
  supersedes?: string | null;
}

export interface MemoryFilter {
  scope?: string | null;
  status?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  query?: string | null;
  limit?: number;
  offset?: number;
  /** With `workspaceId` / `projectId`: the global memories match too. */
  includeGlobal?: boolean;
  /** Only approved memories unused in `MEMORY_STALE_DAYS`. */
  stale?: boolean;
}

/** One page of the pane — `ai_memory::Page`. The counts are the place's, whatever the status filter. */
export interface MemoryPage {
  rows: Memory[];
  total: number;
  candidates: number;
  stale: number;
}

export interface MemoryPatch {
  title?: string;
  body?: string;
  kind?: MemoryKind;
  localOnly?: boolean;
  expiresAt?: number | null;
  clearExpiry?: boolean;
  supersedes?: string | null;
  clearSupersedes?: boolean;
}

export interface MemoryRevision {
  at: number;
  action: string;
  title: string;
  body: string;
  actor: string;
}

export const aiMemoryList = (filter?: MemoryFilter) => invoke<MemoryPage>("ai_memory_list", { filter: filter ?? null });
export const aiMemoryCreate = (input: NewMemory) => invoke<{ memory: Memory; outcome: MemoryOutcome }>("ai_memory_create", { input });
export const aiMemoryEdit = (id: string, patch: MemoryPatch) => invoke<Memory>("ai_memory_edit", { id, patch });
/** `kind`, with `approved`: what the user approves it as. */
export const aiMemorySetStatus = (id: string, status: MemoryStatus, kind?: MemoryKind) =>
  invoke<void>("ai_memory_set_status", { id, status, kind: kind ?? null });
export const aiMemoryDelete = (id: string) => invoke<void>("ai_memory_delete", { id });
export const aiMemoryRevisions = (id: string) => invoke<MemoryRevision[]>("ai_memory_revisions", { id });
export const aiMemoryPropose = (workspaceId: string) => invoke<Memory[]>("ai_memory_propose", { workspaceId });
