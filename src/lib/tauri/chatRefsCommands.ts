import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ArtifactKind } from "../chatArtifacts";

/** A stored artifact version, without its content (`chat_refs::artifacts::ArtifactSummary`). */
export interface ChatArtifactSummary {
  id: string;
  workspace_id: string;
  /** `panel` (repo chat) · `ws` (workspace chat) · `chat` (the Chat app). */
  surface: string;
  conversation_id: string;
  project_id: string | null;
  message_id: string;
  name: string;
  title: string;
  kind: ArtifactKind;
  language: string;
  version: number;
  versions: number;
  size: number;
  created_at: string;
}

export interface ChatArtifact extends ChatArtifactSummary {
  content: string;
}

/** A chat another chat can cite (`chat_refs::refs::ChatRef`). */
export interface ChatRef {
  id: string;
  surface: "panel" | "ws" | "chat";
  title: string;
  project_id: string | null;
  project_name: string | null;
  workspace_id: string;
  updated_at: string;
  turns: number;
}

export const chatArtifactsList = (workspaceId: string, conversationId?: string | null) =>
  invoke<ChatArtifactSummary[]>("chat_artifacts_list", { workspaceId, conversationId: conversationId ?? null });
export const chatArtifactVersions = (workspaceId: string, name: string) =>
  invoke<ChatArtifact[]>("chat_artifact_versions", { workspaceId, name });
export const chatArtifactDelete = (workspaceId: string, name: string) => invoke<number>("chat_artifact_delete", { workspaceId, name });
export const chatRefsList = (workspaceId: string) => invoke<ChatRef[]>("chat_refs_list", { workspaceId });
export const chatDelegateAccept = (requestId: string) => invoke<boolean>("chat_delegate_accept", { requestId });
export const chatDelegateSettle = (requestId: string, reply: string | null, error: string | null) =>
  invoke<boolean>("chat_delegate_settle", { requestId, reply, error });

/** Another chat asked this one to continue (`chat_refs::delegate`). */
export interface ChatDelegateRequest {
  requestId: string;
  surface: "panel" | "ws";
  conversationId: string;
  projectId: string | null;
  workspaceId: string;
  message: string;
  fromId: string;
  fromTitle: string;
}

export const onChatDelegate = (handler: (request: ChatDelegateRequest) => void) =>
  listen<ChatDelegateRequest>("chat:delegate", (e) => handler(e.payload));

/** A chat's answer filed artifacts. */
export const onChatArtifacts = (handler: (event: { workspaceId: string; conversationId: string }) => void) =>
  listen<{ workspaceId: string; conversationId: string }>("chat:artifacts", (e) => handler(e.payload));
