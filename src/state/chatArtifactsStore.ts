import { create } from "zustand";
import { chatArtifactsList, onChatArtifacts, type ChatArtifactSummary } from "../lib/tauri/chatRefsCommands";

/**
 * The artifacts the chats' answers filed (`chat_refs::artifacts`), as lists: one per conversation
 * (the strip over a chat) and one per workspace (the Inbox). Read on demand and refreshed when an
 * answer files new ones (`chat:artifacts`) — the bubbles themselves draw from the answer's text.
 */
interface ChatArtifactsState {
  byConversation: Record<string, ChatArtifactSummary[]>;
  byWorkspace: Record<string, ChatArtifactSummary[]>;
  loadConversation: (workspaceId: string, conversationId: string) => Promise<void>;
  loadWorkspace: (workspaceId: string) => Promise<void>;
  /** Drops what is known about a workspace's lists, so the next read is fresh. */
  invalidate: (workspaceId: string) => void;
}

const EMPTY: ChatArtifactSummary[] = [];
export const NO_ARTIFACTS = EMPTY;

/** Which workspace each conversation list was read for, so an event can refresh it. */
const conversationWorkspace = new Map<string, string>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  void onChatArtifacts(({ workspaceId, conversationId }) => {
    const store = useChatArtifactsStore.getState();
    if (store.byWorkspace[workspaceId]) void store.loadWorkspace(workspaceId);
    if (store.byConversation[conversationId] || conversationWorkspace.has(conversationId)) void store.loadConversation(workspaceId, conversationId);
  }).catch(() => {
    listening = false;
  });
}

export const useChatArtifactsStore = create<ChatArtifactsState>((set) => ({
  byConversation: {},
  byWorkspace: {},
  loadConversation: async (workspaceId, conversationId) => {
    listen();
    conversationWorkspace.set(conversationId, workspaceId);
    try {
      const list = await chatArtifactsList(workspaceId, conversationId);
      set((s) => ({ byConversation: { ...s.byConversation, [conversationId]: list } }));
    } catch {
      /* the list stays as it was */
    }
  },
  loadWorkspace: async (workspaceId) => {
    listen();
    try {
      const list = await chatArtifactsList(workspaceId);
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: list } }));
    } catch {
      /* the list stays as it was */
    }
  },
  invalidate: (workspaceId) =>
    set((s) => {
      const byConversation = { ...s.byConversation };
      for (const [conversation, ws] of conversationWorkspace) if (ws === workspaceId) delete byConversation[conversation];
      const byWorkspace = { ...s.byWorkspace };
      delete byWorkspace[workspaceId];
      return { byConversation, byWorkspace };
    }),
}));
