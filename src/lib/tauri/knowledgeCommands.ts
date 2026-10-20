import { invoke } from "@tauri-apps/api/core";

/** The Knowledge Engine. Mirrors `src-tauri/src/commands/knowledge_cmd.rs` and `knowledge/mod.rs`. */

export interface KnowledgeStatus {
  collection: string;
  files: number;
  chunks: number;
  vectors: number;
  refreshedAt: number | null;
}

export interface KnowledgeCollection {
  id: string;
  workspaceId: string | null;
  name: string;
  kind: string;
  path: string;
  localOnly: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EmbedRow {
  id: string;
  label: string;
  params: string;
  licence: string;
  sizeBytes: number;
  installed: boolean;
  partialBytes: number | null;
  dims: number;
}

export interface KnowledgeOverview {
  cloudAllowed: boolean;
  embedModels: EmbedRow[];
  embedSetting: string | null;
  space: string | null;
  repos: { projectId: string; name: string; status: KnowledgeStatus }[];
  folders: { collection: KnowledgeCollection; status: KnowledgeStatus }[];
}

export interface KnowledgeFound {
  source: "repo" | "folder" | "note" | "symbol";
  label: string;
  path: string;
  startLine: number;
  endLine: number;
  heading: string;
  snippet: string;
  score: number;
}

export interface KnowledgeRefreshed {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  chunks: number;
}

export const knowledgeOverview = (workspaceId: string) => invoke<KnowledgeOverview>("knowledge_overview", { workspaceId });
export const knowledgeAddFolder = (workspaceId: string, path: string, localOnly: boolean) =>
  invoke<KnowledgeCollection>("knowledge_add_folder", { workspaceId, path, name: null, localOnly });
export const knowledgeUpdateFolder = (id: string, patch: { localOnly?: boolean; enabled?: boolean }) =>
  invoke<void>("knowledge_update_folder", { id, localOnly: patch.localOnly ?? null, enabled: patch.enabled ?? null });
export const knowledgeRemoveFolder = (id: string) => invoke<void>("knowledge_remove_folder", { id });
export const knowledgeSetCloud = (workspaceId: string, allowed: boolean) => invoke<void>("knowledge_set_cloud", { workspaceId, allowed });
export const knowledgeSetEmbedModel = (model: string | null) => invoke<void>("knowledge_set_embed_model", { model });
export const knowledgeReindex = (workspaceId: string) => invoke<[string, KnowledgeRefreshed][]>("knowledge_reindex", { workspaceId });
export const knowledgeSearch = (workspaceId: string, query: string, limit?: number) =>
  invoke<KnowledgeFound[]>("knowledge_search", { workspaceId, query, limit: limit ?? null });
export const knowledgeDownloadModel = (modelId: string) => invoke<void>("knowledge_download_model", { modelId });
export const knowledgeCancelDownload = (modelId: string) => invoke<void>("knowledge_cancel_download", { modelId });
export const knowledgeDeleteModel = (modelId: string) => invoke<void>("knowledge_delete_model", { modelId });
