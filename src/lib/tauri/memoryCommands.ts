import { invoke } from "@tauri-apps/api/core";

/** The Memory Engine. Mirrors `src-tauri/src/ai_memory/mod.rs` and `commands/memory_cmd.rs`. */

export type MemoryScope = "global" | "workspace" | "project" | "task";
export type MemoryKind = "preference" | "convention" | "decision" | "fact";
export type MemoryStatus = "candidate" | "approved" | "revoked";
/** What a create did — `ai_memory::Remembered`. */
export type MemoryOutcome = "new" | "approved" | "updated" | "already_known";

/** Days without a confirmation after which an approved memory of a kind waits for review —
 *  `null`: never (`ai_memory::review_days`). */
export const MEMORY_REVIEW_DAYS: Record<MemoryKind, number | null> = { fact: 30, decision: 90, convention: 90, preference: null };

/** A file or symbol a memory is about, as last found in the code — `ai_memory::review::Anchor`. */
export interface MemoryAnchor {
  projectId: string;
  path?: string;
  symbol?: string;
}

/** An anchor a pass did not find; a file of the same name elsewhere in `movedTo`. */
export interface MemoryMissing {
  path?: string;
  symbol?: string;
  movedTo?: string;
}

/** Why an approved memory waits for the user — `ai_memory::review::Review`. */
export interface MemoryReview {
  reason: "code_changed" | "contradicted";
  /** The model's words, for a contradiction. */
  detail: string;
  evidence: string[];
  missing: MemoryMissing[];
  by: string;
  at: number;
}

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
  /** Approved and not confirmed in its kind's `MEMORY_REVIEW_DAYS`. */
  stale: boolean;
  /** The title of the memory this one replaces, while it exists. */
  supersedesTitle: string | null;
  anchors: MemoryAnchor[];
  anchoredAt: number | null;
  /** The short commit it was anchored at. */
  anchorHead: string | null;
  review: MemoryReview | null;
  /** An approved memory this one seems to clash with, while it is live, and its title. */
  conflictsWith: string | null;
  conflictsWithTitle: string | null;
  /** When the user last kept it as it is, or a pass found its anchors where they were. */
  confirmedAt: number | null;
  /** Approved and waiting for review: stale, code changed, contradicted or clashing. */
  needsReview: boolean;
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
  /** Only approved memories not confirmed in their kind's time. */
  stale?: boolean;
  /** Only the approved memories waiting for review («para revisar»). */
  review?: boolean;
}

/** One page of the pane — `ai_memory::Page`. The counts are the place's, whatever the status filter. */
export interface MemoryPage {
  rows: Memory[];
  total: number;
  candidates: number;
  stale: number;
  review: number;
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
/** One pass over the workspace's approved memories: anchors new ones, sends to review those whose code is gone. */
export const aiMemoryReview = (workspaceId: string) => invoke<number>("ai_memory_review", { workspaceId });
/** «Mantener»: keep a memory waiting for review as it is. */
export const aiMemoryConfirm = (id: string) => invoke<Memory>("ai_memory_confirm", { id });
/** A clash settled: `replaces` — it replaces the other memory; otherwise they are different. */
export const aiMemorySettleClash = (id: string, replaces: boolean) => invoke<Memory>("ai_memory_settle_clash", { id, replaces });
