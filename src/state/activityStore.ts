import { create } from "zustand";
import { listChatConversations, deleteChatConversation, renameChatConversation } from "../lib/tauri/commands";
import { onChatTitled } from "../lib/tauri/events";
import type { ChatConversationSummary } from "../types/domain";

interface ChatHistoryState {
  byProject: Record<string, ChatConversationSummary[]>;
  loaded: Record<string, boolean>;
  /** When (ms) the read behind each project's current list *started* — what the list can vouch for.
   *  A conversation that changed after that is simply not in it yet, which is not «deleted». */
  listedAt: Record<string, number>;
  load: (projectId: string) => Promise<void>;
  remove: (projectId: string, sessionId: string) => Promise<void>;
  rename: (projectId: string, sessionId: string, title: string) => Promise<void>;
}

const loadSeq = new Map<string, number>();

export const useChatHistoryStore = create<ChatHistoryState>((set) => ({
  byProject: {},
  loaded: {},
  listedAt: {},

  load: async (projectId) => {
    ensureTitleListener();
    // Sequenced: two loads close together (two conversations finishing at once) could land out of
    // order, and the older list would overwrite the newer one.
    const seq = (loadSeq.get(projectId) ?? 0) + 1;
    loadSeq.set(projectId, seq);
    const startedAt = Date.now();
    let conversations: ChatConversationSummary[];
    try {
      conversations = await listChatConversations(projectId);
    } catch {
      // Left unloaded: the next caller tries again. Never an unhandled rejection.
      return;
    }
    if (loadSeq.get(projectId) !== seq) return;
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: conversations },
      loaded: { ...s.loaded, [projectId]: true },
      listedAt: { ...s.listedAt, [projectId]: startedAt },
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
