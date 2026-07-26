import { create } from "zustand";
import { sendChatMessage, getChatConversation } from "../lib/tauri/commands";
import { useChatHistoryStore } from "./activityStore";
import { isCancellation, newRunId, useAiRunStore, type AiRunLine } from "./aiRunStore";
import { formatAgentLogLine } from "../lib/agentLog";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Response time in milliseconds — only set for assistant messages */
  responseTimeMs?: number;
  /** What the engine printed while producing this answer — kept with the message so the trace
   * outlives the run, and reloaded from disk when a past conversation is reopened. */
  trace?: AiRunLine[];
  /** This turn failed; `content` is the raw engine error (still carrying the quota marker, so the
   * bubble can re-derive the billing link when a past conversation is reopened). */
  isError?: boolean;
  /** The user stopped this turn. Not an error — it gets its own muted note in the transcript
   * rather than a red failure banner. */
  isCancelled?: boolean;
}

interface ProjectChat {
  messages: ChatMessage[];
  /** The engine's session id to `--resume` — `null` means the next message starts a fresh
   * engine session (there isn't one yet, or it was explicitly cleared). */
  sessionId: string | null;
  /** *Our* id for this conversation, minted on its first message and kept until "new chat".
   * This is what every turn is filed under, so a conversation is one activity no matter how the
   * engine behaves — engines are inconsistent here (Codex reports one fixed sentinel for every
   * run; the Claude CLI can mint a new id per resumed turn), which is exactly why the app can't
   * borrow their ids for this. `null` means "no conversation started yet". */
  conversationId: string | null;
  /** Model that answered the most recent turn, as reported by the CLI. Beats the configured
   * setting for the panel's model chip, since a blank setting lets the CLI choose and only
   * the reply says what it chose. `null` until the first answer of a conversation. */
  model: string | null;
  sending: boolean;
  /** Id of the turn currently in flight — what the panel streams output for and what the stop
   * button cancels. `null` when nothing is running. */
  runId: string | null;
}

function emptyChat(): ProjectChat {
  return { messages: [], sessionId: null, conversationId: null, model: null, sending: false, runId: null };
}

/** Rehydrates a stored trace into the shape the log component renders, applying the same
 * formatting the live view uses so a reopened turn reads identically to a fresh one. */
function parseTrace(raw: string | null): AiRunLine[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const lines: AiRunLine[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const { stream, line } = item as { stream?: unknown; line?: unknown };
      if (typeof line !== "string") continue;
      const text = formatAgentLogLine(line);
      if (text === null) continue;
      lines.push({ stream: stream === "stderr" ? "stderr" : "stdout", text });
    }
    return lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

const EMPTY_CHAT: ProjectChat = emptyChat();

interface ChatState {
  byProject: Record<string, ProjectChat>;
  /** Fire-and-forget — the reply lands in `byProject` whenever it arrives, so it isn't lost
   * if the user switches projects or closes the AI panel while Claude is still answering. */
  send: (projectId: string, message: string) => void;
  clear: (projectId: string) => void;
  /** Reopens a past conversation — replaces the live chat with its turns and adopts both its
   * conversation id (so new turns keep filing under the same activity) and the engine session
   * its last turn ran under (so the CLI continues where it left off). */
  switchTo: (projectId: string, conversationId: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  byProject: {},

  send: (projectId, message) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const existing = get().byProject[projectId] ?? emptyChat();
    if (existing.sending) return;

    const runId = newRunId("chat");
    useAiRunStore.getState().start(runId);
    // First message of a chat names the conversation; every later turn reuses it, so the whole
    // exchange stays one activity. "New chat" clears it, which is what makes the next message a
    // separate one.
    const conversationId = existing.conversationId ?? `conv-${crypto.randomUUID()}`;

    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: {
          ...existing,
          messages: [...existing.messages, { role: "user", content: trimmed }],
          sending: true,
          runId,
          conversationId,
        },
      },
    }));

    void sendChatMessage(projectId, trimmed, existing.sessionId, conversationId, runId)
      .then((reply) => {
        // The live log is already in memory and formatted; attaching it to the message is what
        // keeps "what did it do?" answerable after the run ends, without a second round trip.
        const trace = useAiRunStore.getState().linesFor(runId);
        set((s) => {
          const proj = s.byProject[projectId] ?? emptyChat();
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...proj,
                messages: [
                  ...proj.messages,
                  {
                    role: "assistant",
                    content: reply.text,
                    responseTimeMs: reply.response_time_ms,
                    trace: trace.length > 0 ? trace : undefined,
                  },
                ],
                sessionId: reply.session_id,
                model: reply.model ?? proj.model,
                sending: false,
                runId: null,
              },
            },
          };
        });
        void useChatHistoryStore.getState().load(projectId);
      })
      .catch((e) => {
        const cancelled = isCancellation(e);
        const trace = useAiRunStore.getState().linesFor(runId);
        set((s) => {
          const proj = s.byProject[projectId] ?? emptyChat();
          return {
            byProject: {
              ...s.byProject,
              [projectId]: {
                ...proj,
                // The failure joins the transcript rather than sitting in a separate banner that
                // the next message would wipe. The backend persists it too, so it's still here
                // tomorrow. Raw text is kept so the bubble can re-parse the quota marker. A turn
                // the user stopped isn't a failure, so it's flagged separately.
                messages: [
                  ...proj.messages,
                  cancelled
                    ? { role: "assistant", content: "", isCancelled: true, trace: trace.length > 0 ? trace : undefined }
                    : {
                        role: "assistant",
                        content: String(e),
                        isError: true,
                        trace: trace.length > 0 ? trace : undefined,
                      },
                ],
                sending: false,
                runId: null,
              },
            },
          };
        });
        // The failed turn was logged server-side — pick it up so it shows in the activity list.
        if (!cancelled) void useChatHistoryStore.getState().load(projectId);
      })
      .finally(() => useAiRunStore.getState().finish(runId));
  },

  clear: (projectId) => {
    set((s) => ({ byProject: { ...s.byProject, [projectId]: emptyChat() } }));
  },

  switchTo: async (projectId, conversationId) => {
    const entries = await getChatConversation(projectId, conversationId);
    const messages: ChatMessage[] = entries.flatMap((e) => [
      { role: "user" as const, content: e.question },
      {
        role: "assistant" as const,
        content: e.answer,
        responseTimeMs: e.response_time_ms ?? undefined,
        isError: e.is_error,
        trace: parseTrace(e.trace),
      },
    ]);
    // Continuing a reopened conversation resumes the engine session its *last* turn ran under —
    // earlier ones are stale (a CLI can hand out a new token per turn), and turns recorded before
    // the two ids were separated have none at all, which just means the next message starts a
    // fresh engine session while still filing under this same conversation.
    const engineSession = entries.reduce<string | null>((last, e) => e.engine_session_id ?? last, null);
    set((s) => ({
      // No model recorded for archived turns — the chip falls back to the configured setting
      // until this conversation gets a fresh reply.
      byProject: {
        ...s.byProject,
        [projectId]: {
          messages,
          sessionId: engineSession,
          conversationId,
          model: null,
          sending: false,
          runId: null,
        },
      },
    }));
  },
}));

export { EMPTY_CHAT };
