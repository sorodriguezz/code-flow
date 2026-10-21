import { invoke } from "@tauri-apps/api/core";

/** The Knowledge Engine. Mirrors `src-tauri/src/commands/knowledge_cmd.rs` and `knowledge/mod.rs`. */

export interface KnowledgeStatus {
  collection: string;
  files: number;
  chunks: number;
  vectors: number;
  refreshedAt: number | null;
  /** The commit the collection was indexed at (repositories), empty otherwise. */
  head: string;
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
  /** The workspace's own content indexed beside the repositories: notes, meetings, generated docs,
   *  story drafts, PR review findings and commit messages. */
  sources: { kind: "note" | "meeting" | "doc" | "story" | "review" | "commit"; status: KnowledgeStatus }[];
}

export interface KnowledgeFound {
  source: "repo" | "folder" | "note" | "symbol" | "meeting" | "doc" | "story" | "review" | "commit";
  label: string;
  path: string;
  startLine: number;
  endLine: number;
  heading: string;
  snippet: string;
  score: number;
  /** A note's or document's title. */
  title: string;
  /** The commit its repository was indexed at, empty when it has none. */
  commit: string;
  indexedAt: number | null;
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
/** Empties the workspace's part of the index (rebuilt by the next search); resolves to the collections removed. */
export const knowledgeClear = (workspaceId: string) => invoke<number>("knowledge_clear", { workspaceId });
export const knowledgeSearch = (workspaceId: string, query: string, limit?: number) =>
  invoke<KnowledgeFound[]>("knowledge_search", { workspaceId, query, limit: limit ?? null });
export const knowledgeDownloadModel = (modelId: string) => invoke<void>("knowledge_download_model", { modelId });
export const knowledgeCancelDownload = (modelId: string) => invoke<void>("knowledge_cancel_download", { modelId });
export const knowledgeDeleteModel = (modelId: string) => invoke<void>("knowledge_delete_model", { modelId });
