import { invoke } from "./invoke";

/** One subchat link (`chat_lineage.rs`): `conversationId` was started under `parentId`. */
export interface ChatLink {
  conversationId: string;
  /** `panel` = a repository chat, `ws` = a workspace chat. */
  surface: "panel" | "ws";
  parentId: string;
  /** `new` = «Nuevo subchat», `branch` = «Bifurcar». */
  kind: "new" | "branch";
  /** The project (panel) or workspace (ws) the subchat runs on. */
  scopeId: string;
  branchedTurn: number | null;
  createdAt: string;
}

export const chatLineageList = (workspaceId: string) => invoke<ChatLink[]>("chat_lineage_list", { workspaceId });

export const chatLineageLink = (link: Omit<ChatLink, "createdAt" | "branchedTurn"> & { branchedTurn?: number | null }) =>
  invoke<boolean>("chat_lineage_link", {
    conversationId: link.conversationId,
    surface: link.surface,
    parentId: link.parentId,
    kind: link.kind,
    scopeId: link.scopeId,
    branchedTurn: link.branchedTurn ?? null,
  });

export const chatLineageForget = (conversationId: string) => invoke<void>("chat_lineage_forget", { conversationId });
