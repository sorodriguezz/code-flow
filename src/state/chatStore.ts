import { create } from "zustand";
import { sendChatMessage } from "../lib/tauri/commands";
import { parseClaudeError, type ClaudeErrorInfo } from "../lib/claudeError";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ProjectChat {
  messages: ChatMessage[];
  /** Claude Code session id to `--resume` — `null` means the next message starts a fresh
   * conversation (there isn't one yet, or it was explicitly cleared). */
  sessionId: string | null;
  sending: boolean;
  error: ClaudeErrorInfo | null;
}

function emptyChat(): ProjectChat {
  return { messages: [], sessionId: null, sending: false, error: null };
}

const EMPTY_CHAT: ProjectChat = emptyChat();

interface ChatState {
  byProject: Record<string, ProjectChat>;
  /** Fire-and-forget — the reply lands in `byProject` whenever it arrives, so it isn't lost
   * if the user switches projects or closes the AI panel while Claude is still answering. */
  send: (projectId: string, message: string) => void;
  clear: (projectId: string) => void;
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
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...proj,
                messages: [...proj.messages, { role: "assistant", content: reply.text }],
                sessionId: reply.session_id,
                sending: false,
              },
            },
          };
        });
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
}));

export { EMPTY_CHAT };
