import { invoke } from "@tauri-apps/api/core";

/** The Memory Engine. Mirrors `src-tauri/src/ai_memory/mod.rs` and `commands/memory_cmd.rs`. */

export type MemoryScope = "global" | "workspace" | "project" | "task";
export type MemoryKind = "preference" | "convention" | "decision" | "fact";
export type MemoryStatus = "candidate" | "approved" | "revoked";

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
  source: string;
  evidence: string[];
  supersedes: string | null;
  localOnly: boolean;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  usedAt: number | null;
  useCount: number;
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
}

export interface MemoryPatch {
  title?: string;
  body?: string;
  kind?: MemoryKind;
  localOnly?: boolean;
  expiresAt?: number | null;
  clearExpiry?: boolean;
}

export interface MemoryRevision {
  at: number;
  action: string;
  title: string;
  body: string;
  actor: string;
}

export const aiMemoryList = (filter?: MemoryFilter) => invoke<Memory[]>("ai_memory_list", { filter: filter ?? null });
export const aiMemoryCreate = (input: NewMemory) => invoke<Memory>("ai_memory_create", { input });
export const aiMemoryEdit = (id: string, patch: MemoryPatch) => invoke<Memory>("ai_memory_edit", { id, patch });
export const aiMemorySetStatus = (id: string, status: MemoryStatus) => invoke<void>("ai_memory_set_status", { id, status });
export const aiMemoryDelete = (id: string) => invoke<void>("ai_memory_delete", { id });
export const aiMemoryRevisions = (id: string) => invoke<MemoryRevision[]>("ai_memory_revisions", { id });
export const aiMemoryPropose = (workspaceId: string) => invoke<Memory[]>("ai_memory_propose", { workspaceId });
