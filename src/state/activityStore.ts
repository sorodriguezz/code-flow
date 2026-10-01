import { create } from "zustand";
import { listChatConversations, deleteChatConversation, renameChatConversation } from "../lib/tauri/commands";
import { onChatTitled } from "../lib/tauri/events";
import type { ChatConversationSummary } from "../types/domain";

interface ChatHistoryState {
  byProject: Record<string, ChatConversationSummary[]>;
  loaded: Record<string, boolean>;
  load: (projectId: string) => Promise<void>;
  remove: (projectId: string, sessionId: string) => Promise<void>;
  rename: (projectId: string, sessionId: string, title: string) => Promise<void>;
}

export const useChatHistoryStore = create<ChatHistoryState>((set) => ({
  byProject: {},
  loaded: {},

  load: async (projectId) => {
    ensureTitleListener();
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

  rename: async (projectId, sessionId, title) => {
    await renameChatConversation(projectId, sessionId, title);
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((c) => (c.session_id === sessionId ? { ...c, title } : c)),
      },
    }));
  },
}));

export const EMPTY_CONVERSATIONS: ChatConversationSummary[] = [];

let titleListener: Promise<unknown> | null = null;

/**
 * Subscribed on the first load: from then on the title a model writes from a conversation's first
 * question (`chat_title.rs`) renames its row here as it lands — the Inbox and the tab both read it.
 * A list not loaded yet is left alone; it reads the title from disk when it is.
 */
function ensureTitleListener(): void {
  if (titleListener) return;
  titleListener = onChatTitled(({ surface, projectId, conversationId, title }) => {
    if (surface !== "panel" || !projectId) return;
    useChatHistoryStore.setState((s) => {
      const list = s.byProject[projectId];
      if (!list?.some((c) => c.session_id === conversationId)) return s;
      return {
        byProject: { ...s.byProject, [projectId]: list.map((c) => (c.session_id === conversationId ? { ...c, title } : c)) },
      };
    });
  }).catch(() => {
    // No event bridge (a test DOM): the list still reads titles from disk on every load.
    titleListener = null;
  });
}
