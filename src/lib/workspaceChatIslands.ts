import { useAiPanelStore } from "../state/aiPanelStore";
import { useWorkspaceChatStore } from "../state/workspaceChatStore";
import { useWindowStore } from "../state/windowStore";
import { chatCreateWorkspaceConversation } from "./tauri/chatCommands";
import { chatIslandRefId, parseChatIslandRef, type ChatIslandRef } from "./chatIslandSync";
import type { SatelliteInfo } from "./tauri/windows";

const CHAT_ISLAND_KIND = "chat";
const WORKSPACE_CHAT_SURFACE = "ws";
const WORKSPACE_CHAT_KIND = "wsChat";
const EMPTY_ENGINE = "";
const BACKGROUND_TAB = { focus: false };
const openingByWorkspace = new Map<string, Promise<boolean>>();

export function workspaceChatIslands(satellites: readonly SatelliteInfo[]) {
  return satellites.flatMap((satellite) => {
    if (satellite.kind !== CHAT_ISLAND_KIND) return [];
    const ref = parseChatIslandRef(satellite.ref_id);
    if (ref?.surface !== WORKSPACE_CHAT_SURFACE) return [];
    return [{ ...satellite, workspaceId: ref.workspaceId, conversationId: ref.conversationId }];
  });
}

async function createWorkspaceChatIsland(workspaceId: string, title: string): Promise<boolean> {
  const windows = useWindowStore.getState();
  const islands = workspaceChatIslands(windows.satellites);
  const existing = islands.find((island) => island.workspaceId === workspaceId);
  if (existing) {
    await windows.focus(existing.label);
    return true;
  }

  const panel = useAiPanelStore.getState();
  await panel.load(workspaceId);
  const conversationId = crypto.randomUUID();
  await chatCreateWorkspaceConversation({
    conversationId,
    workspaceId,
    provider: EMPTY_ENGINE,
    model: EMPTY_ENGINE,
  });
  panel.open({ kind: WORKSPACE_CHAT_KIND, workspaceId, conversationId }, BACKGROUND_TAB);
  await useWorkspaceChatStore.getState().loadList(workspaceId);
  const ref: ChatIslandRef = { surface: WORKSPACE_CHAT_SURFACE, workspaceId, conversationId };
  const refId = chatIslandRefId(ref);
  return windows.detach(CHAT_ISLAND_KIND, refId, title);
}

export async function openWorkspaceChatIsland(workspaceId: string, title: string): Promise<boolean> {
  const pending = openingByWorkspace.get(workspaceId);
  if (pending) return pending;
  const opening = createWorkspaceChatIsland(workspaceId, title);
  openingByWorkspace.set(workspaceId, opening);
  try {
    return await opening;
  } finally {
    openingByWorkspace.delete(workspaceId);
  }
}
