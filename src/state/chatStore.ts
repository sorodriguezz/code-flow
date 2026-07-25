import { create } from "zustand";
import { sendChatMessage, getChatConversation } from "../lib/tauri/commands";
import { parseClaudeError, type ClaudeErrorInfo } from "../lib/claudeError";
import { useChatHistoryStore } from "./activityStore";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ProjectChat {
  messages: ChatMessage[];
  /** Claude Code session id to `--resume` — `null` means the next message starts a fresh
   * conversation (there isn't one yet, or it was explicitly cleared). */
  sessionId: string | null;
  /** Every session id this live chat has spanned. The CLI can mint a *new* session id on each
   * resumed turn, so one visible conversation may map to several `activity_log` session ids.
   * Tracking them all lets the panel reconcile against the persisted conversation list: when
   * none of these remain (the conversation was deleted), the panel resets — instead of keeping
   * a deleted chat on screen or re-creating it on the next message. */
  sessionIds: string[];
  /** Model that answered the most recent turn, as reported by the CLI. Beats the configured
   * setting for the panel's model chip, since a blank setting lets the CLI choose and only
   * the reply says what it chose. `null` until the first answer of a conversation. */
  model: string | null;
  sending: boolean;
  error: ClaudeErrorInfo | null;
}

function emptyChat(): ProjectChat {
  return { messages: [], sessionId: null, sessionIds: [], model: null, sending: false, error: null };
}

const EMPTY_CHAT: ProjectChat = emptyChat();

interface ChatState {
  byProject: Record<string, ProjectChat>;
  /** Fire-and-forget — the reply lands in `byProject` whenever it arrives, so it isn't lost
   * if the user switches projects or closes the AI panel while Claude is still answering. */
  send: (projectId: string, message: string) => void;
  clear: (projectId: string) => void;
  /** Reopens a past conversation from `activity_log` — replaces the live chat with its turns
   * and resumes its `session_id`, so sending another message continues that same Claude Code
   * session instead of starting a new one. */
  switchTo: (projectId: string, sessionId: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  byProject: {},

  send: (projectId, message) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const existing = get().byProject[projectId] ?? emptyChat();
    if (existing.sending) return;

    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: {
          ...existing,
          messages: [...existing.messages, { role: "user", content: trimmed }],
          sending: true,
          error: null,
        },
      },
    }));

    void sendChatMessage(projectId, trimmed, existing.sessionId)
      .then((reply) => {
        set((s) => {
          const proj = s.byProject[projectId] ?? emptyChat();
          const sessionIds =
            reply.session_id && !proj.sessionIds.includes(reply.session_id)
              ? [...proj.sessionIds, reply.session_id]
              : proj.sessionIds;
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...proj,
                messages: [...proj.messages, { role: "assistant", content: reply.text }],
                sessionId: reply.session_id,
                sessionIds,
                model: reply.model ?? proj.model,
                sending: false,
              },
            },
          };
        });
        void useChatHistoryStore.getState().load(projectId);
      })
      .catch((e) => {
        set((s) => {
          const proj = s.byProject[projectId] ?? emptyChat();
          return {
            byProject: {
              ...s.byProject,
              [projectId]: { ...proj, sending: false, error: parseClaudeError(String(e)) },
            },
          };
        });
      });
  },

  clear: (projectId) => {
    set((s) => ({ byProject: { ...s.byProject, [projectId]: emptyChat() } }));
  },

  switchTo: async (projectId, sessionId) => {
    const entries = await getChatConversation(projectId, sessionId);
    const messages: ChatMessage[] = entries.flatMap((e) => [
      { role: "user" as const, content: e.question },
      { role: "assistant" as const, content: e.answer },
    ]);
    set((s) => ({
      // No model recorded for archived turns — the chip falls back to the configured setting
      // until this conversation gets a fresh reply.
      byProject: {
        ...s.byProject,
        [projectId]: { messages, sessionId, sessionIds: [sessionId], model: null, sending: false, error: null },
      },
    }));
  },
}));

export { EMPTY_CHAT };
