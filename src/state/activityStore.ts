import { create } from "zustand";
import { listChatConversations, deleteChatConversation } from "../lib/tauri/commands";
import type { ChatConversationSummary } from "../types/domain";

interface ChatHistoryState {
  byProject: Record<string, ChatConversationSummary[]>;
  loaded: Record<string, boolean>;
  load: (projectId: string) => Promise<void>;
  remove: (projectId: string, sessionId: string) => Promise<void>;
}

export const useChatHistoryStore = create<ChatHistoryState>((set) => ({
  byProject: {},
  loaded: {},

  load: async (projectId) => {
    const conversations = await listChatConversations(projectId);
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: conversations },
      loaded: { ...s.loaded, [projectId]: true },
    }));
  },

  remove: async (projectId, sessionId) => {
    await deleteChatConversation(projectId, sessionId);
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).filter((c) => c.session_id !== sessionId),
      },
    }));
  },
}));

export const EMPTY_CONVERSATIONS: ChatConversationSummary[] = [];
