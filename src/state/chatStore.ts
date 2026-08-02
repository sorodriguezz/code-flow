import { create } from "zustand";
import {
  getChatConversation,
  isRepoBusy,
  sendChatMessage,
  REPO_BUSY_MARKER,
  type ChatAgentOverride,
} from "../lib/tauri/commands";
import { useChatHistoryStore } from "./activityStore";
import { isCancellation, newRunId, useAiRunStore, type AiRunLine } from "./aiRunStore";
import { translate } from "./languageStore";
import { pushErrorToast } from "./toastStore";
import { formatAgentLogLine } from "../lib/agentLog";

/** The repository name the backend puts after its busy marker. */
function repoNameFromBusy(error: string): string {
  const at = error.indexOf(REPO_BUSY_MARKER);
  return at < 0 ? "" : error.slice(at + REPO_BUSY_MARKER.length).replace(/"$/, "").trim();
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Response time in milliseconds — only set for assistant messages */
  responseTimeMs?: number;
  /** When this turn happened, RFC 3339. Comes from the persisted row for anything the backend
   * recorded, so reopening a conversation shows the original instant rather than "now". */
  createdAt?: string;
  /** Which engine produced this answer — pinned per message rather than read from the current
   * setting, so a conversation that switched models mid-way still says what each turn ran on.
   * Assistant messages only; `undefined` for turns recorded before this was tracked. */
  provider?: string;
  model?: string;
  engineVersion?: string;
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

/** One conversation, live in memory for as long as the app runs.
 *
 * This store is keyed by *conversation*, not by project, and that is the whole point: a turn is
 * in flight for however long the engine takes, and in the meantime the user is free to start a
 * new chat, reopen an old one or go read a PR review. The reply has to land in the conversation
 * that asked the question — when the state was one slot per project, "new chat" and "reopen"
 * both overwrote that slot, so the answer either vanished or, worse, was appended to whatever
 * conversation happened to be on screen when it arrived.
 *
 * Nothing here is ever dropped on a view change: sessions are only removed when their
 * conversation is deleted from history (see `discard`). */
export interface ChatSession {
  /** Which project this conversation belongs to. Kept on the session because the store is no
   * longer keyed by project — a reply landing while a different chat is on screen still has to
   * know where it is filed, and Activity needs it to list a project's live conversations. */
  projectId: string;
  /** *Our* id for this conversation, minted on its first message and kept until it is deleted.
   * This is what every turn is filed under, so a conversation is one activity no matter how the
   * engine behaves — engines are inconsistent here (Codex reports one fixed sentinel for every
   * run; the Claude CLI can mint a new id per resumed turn), which is exactly why the app can't
   * borrow their ids for this. It is also this store's key. */
  conversationId: string;
  messages: ChatMessage[];
  /** The engine's session id to `--resume` — `null` means the next message starts a fresh
   * engine session (there isn't one yet, or it was explicitly cleared). */
  sessionId: string | null;
  /** Model that answered the most recent turn, as reported by the CLI. Beats the configured
   * setting for the panel's model chip, since a blank setting lets the CLI choose and only
   * the reply says what it chose. `null` until the first answer of a conversation. */
  model: string | null;
  sending: boolean;
  /** Id of the turn currently in flight — what the panel streams output for and what the stop
   * button cancels. `null` when nothing is running. */
  runId: string | null;
  /** When the in-flight turn started. The run log's timer is anchored to this rather than to when
   * the log was mounted, so coming back to a conversation after five minutes away shows five
   * minutes — not a stopwatch that restarts every time you look at it. */
  runStartedAt: number | null;
  /** The first question asked, so a conversation that hasn't finished a turn yet still has
   * something to call itself in the Activity list. Once the backend has recorded it, the
   * persisted row's title wins. */
  title: string;
  createdAt: number;
  /** Last time anything happened here, so Activity can sort live rows against persisted ones. */
  updatedAt: number;
  /** True once a turn landed and the backend wrote its row. Only a persisted conversation can be
   * reconciled against the history list — one whose first turn errored or was stopped has no row
   * on disk by design, and must not be mistaken for one the user deleted. */
  persisted: boolean;
}

function newSession(projectId: string, conversationId: string): ChatSession {
  const now = Date.now();
  return {
    projectId,
    conversationId,
    messages: [],
    sessionId: null,
    model: null,
    sending: false,
    runId: null,
    runStartedAt: null,
    title: "",
    createdAt: now,
    updatedAt: now,
    persisted: false,
  };
}

/** How much of the first question stands in for the conversation's name until the backend has
 * recorded one. Long enough to tell two chats apart, short enough for the Activity row. */
const LIVE_TITLE_MAX = 60;

function liveTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > LIVE_TITLE_MAX ? `${oneLine.slice(0, LIVE_TITLE_MAX)}…` : oneLine;
}

/** Rehydrates a stored trace into the shape the log component renders, applying the same
 * formatting the live view uses so a reopened turn reads identically to a fresh one.
 *
 * Exported for `agentsStore`, which replays the same `activity_log` rows: an agent task is a
 * conversation with a role attached, and a reopened one has to read the same as a reopened chat. */
export function parseTrace(raw: string | null): AiRunLine[] | undefined {
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

/** Stand-in for "this project has no conversation open" — a fresh, empty session the chat panel
 * can render without special-casing. Never stored. */
const EMPTY_CHAT: ChatSession = newSession("", "");

const EMPTY_LIVE: ChatSession[] = [];

interface ChatState {
  byConversation: Record<string, ChatSession>;
  /** Which conversation each project is currently *showing*. `null`/absent means the panel is on
   * a blank new chat — which is a view state, not a lifecycle one: whatever was showing before is
   * still in `byConversation`, still running if it was running. */
  activeByProject: Record<string, string | null>;
  /** The SDD/Harness agent selected for a project's chat, if any — its provider+model+prompt run
   * each turn as that role. `null`/absent means the normal chat routing. */
  agentByProject: Record<string, ChatAgentOverride | null>;
  setAgent: (projectId: string, agent: ChatAgentOverride | null) => void;
  /** Fire-and-forget — the reply lands in its own conversation whenever it arrives, so it isn't
   * lost (or misfiled) if the user switches chats, projects, or closes the AI panel while the
   * engine is still answering. Several conversations can be in flight at once; only a second turn
   * *within the same conversation* is refused, since the engine session can only be resumed once
   * at a time. */
  send: (projectId: string, message: string) => void;
  /** Detaches the project from whatever it was showing so the next message starts a fresh
   * conversation. Deliberately not destructive: a turn still running keeps running and stays in
   * Activity, and reopening its row brings it back exactly where it was. */
  clear: (projectId: string) => void;
  /** Reopens a conversation. One still in memory — running or not — is shown as-is, with no round
   * trip and nothing lost; anything else is read back from disk, adopting both its conversation id
   * (so new turns keep filing under the same activity) and the engine session its last turn ran
   * under (so the CLI continues where it left off). */
  switchTo: (projectId: string, conversationId: string) => Promise<void>;
  /** Forgets a conversation entirely — for one deleted from history, which has nothing left to
   * come back to. */
  discard: (conversationId: string) => void;
  /** The conversation a project is showing, or an empty one when it's on a blank new chat. */
  sessionFor: (projectId: string) => ChatSession;
}

export const useChatStore = create<ChatState>((set, get) => ({
  byConversation: {},
  activeByProject: {},
  agentByProject: {},

  setAgent: (projectId, agent) =>
    set((s) => ({ agentByProject: { ...s.agentByProject, [projectId]: agent } })),

  sessionFor: (projectId) => {
    const id = get().activeByProject[projectId];
    return (id ? get().byConversation[id] : undefined) ?? EMPTY_CHAT;
  },

  send: (projectId, message) => {
    const trimmed = message.trim();
    if (!trimmed) return;

    // First message of a chat names the conversation; every later turn reuses it, so the whole
    // exchange stays one activity. "New chat" detaches, which is what makes the next message a
    // separate one.
    const activeId = get().activeByProject[projectId] ?? null;
    const existing = (activeId ? get().byConversation[activeId] : undefined) ?? null;
    // Only this conversation's own turn blocks — another chat of the same project being mid-answer
    // is exactly the case this store exists to allow.
    if (existing?.sending) return;

    const conversationId = existing?.conversationId ?? `conv-${crypto.randomUUID()}`;
    const base = existing ?? newSession(projectId, conversationId);
    const runId = newRunId("chat");
    useAiRunStore.getState().start(runId);

    const now = Date.now();
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: {
          ...base,
          // Stamped client-side: the turn isn't persisted until the reply lands, and the question
          // was asked now, not whenever the engine finishes answering it.
          messages: [...base.messages, { role: "user", content: trimmed, createdAt: new Date().toISOString() }],
          title: base.title || liveTitle(trimmed),
          sending: true,
          runId,
          runStartedAt: now,
          updatedAt: now,
        },
      },
      activeByProject: { ...s.activeByProject, [projectId]: conversationId },
    }));

    /** Writes the outcome into *this* conversation, wherever the user happens to be looking. The
     * active pointer is never touched here — moving the panel out from under someone because a
     * background answer arrived is the bug this whole store is shaped to avoid. */
    const settle = (patch: (session: ChatSession) => ChatSession) => {
      set((s) => {
        const current = s.byConversation[conversationId];
        // Gone means the user deleted it while it ran; there is nothing to file the answer under.
        if (!current) return s;
        return { byConversation: { ...s.byConversation, [conversationId]: patch(current) } };
      });
    };

    const agent = get().agentByProject[projectId] ?? null;
    void sendChatMessage(projectId, trimmed, base.sessionId, conversationId, runId, agent)
      .then((reply) => {
        // The live log is already in memory and formatted; attaching it to the message is what
        // keeps "what did it do?" answerable after the run ends, without a second round trip.
        const trace = useAiRunStore.getState().linesFor(runId);
        settle((session) => ({
          ...session,
          messages: [
            ...session.messages,
            {
              role: "assistant",
              content: reply.text,
              responseTimeMs: reply.response_time_ms,
              createdAt: reply.created_at,
              provider: reply.provider,
              model: reply.model ?? undefined,
              engineVersion: reply.engine_version ?? undefined,
              trace: trace.length > 0 ? trace : undefined,
            },
          ],
          sessionId: reply.session_id,
          model: reply.model ?? session.model,
          sending: false,
          runId: null,
          runStartedAt: null,
          updatedAt: Date.now(),
          persisted: true,
        }));
        void useChatHistoryStore.getState().load(projectId);
      })
      .catch((e) => {
        // Another run already owns this repository's working copy, so this turn never reached an
        // engine: nothing was recorded, nothing was edited. Filing it in the transcript as a red
        // failure bubble would be a lie about something that did not happen — so the question is
        // taken back out and the reason is said once, in passing.
        if (isRepoBusy(e)) {
          settle((session) => ({
            ...session,
            messages: session.messages.slice(0, -1),
            sending: false,
            runId: null,
            runStartedAt: null,
            updatedAt: Date.now(),
          }));
          pushErrorToast(translate("agents.busyInRepo", { name: repoNameFromBusy(String(e)) }));
          return;
        }
        const cancelled = isCancellation(e);
        const trace = useAiRunStore.getState().linesFor(runId);
        settle((session) => ({
          ...session,
          // The failure joins the transcript rather than sitting in a separate banner that the
          // next message would wipe. The backend persists it too, so it's still here tomorrow.
          // Raw text is kept so the bubble can re-parse the quota marker. A turn the user stopped
          // isn't a failure, so it's flagged separately.
          // A rejected turn carries no reply to read the persisted timestamp from, so it's
          // stamped locally — off from the recorded row by the milliseconds of the IPC hop.
          messages: [
            ...session.messages,
            cancelled
              ? {
                  role: "assistant",
                  content: "",
                  isCancelled: true,
                  createdAt: new Date().toISOString(),
                  trace: trace.length > 0 ? trace : undefined,
                }
              : {
                  role: "assistant",
                  content: String(e),
                  isError: true,
                  createdAt: new Date().toISOString(),
                  trace: trace.length > 0 ? trace : undefined,
                },
          ],
          sending: false,
          runId: null,
          runStartedAt: null,
          updatedAt: Date.now(),
          // A stopped turn is never written to disk, so the conversation stays unpersisted and
          // must not be reconciled against the history list.
          persisted: session.persisted || !cancelled,
        }));
        // The failed turn was logged server-side — pick it up so it shows in the activity list.
        if (!cancelled) void useChatHistoryStore.getState().load(projectId);
      })
      .finally(() => useAiRunStore.getState().finish(runId));
  },

  clear: (projectId) => {
    set((s) => ({ activeByProject: { ...s.activeByProject, [projectId]: null } }));
  },

  switchTo: async (projectId, conversationId) => {
    // Already in memory: just point at it. This is what makes returning to a conversation that is
    // still answering free — its messages, its run id and its "sending" flag were never touched.
    if (get().byConversation[conversationId]) {
      set((s) => ({ activeByProject: { ...s.activeByProject, [projectId]: conversationId } }));
      return;
    }

    const entries = await getChatConversation(projectId, conversationId);
    // One stored row is one exchange, so both halves carry its timestamp — the question wasn't
    // recorded separately, and splitting hairs there would mean inventing a time.
    const messages: ChatMessage[] = entries.flatMap((e) => [
      { role: "user" as const, content: e.question, createdAt: e.created_at },
      {
        role: "assistant" as const,
        content: e.answer,
        responseTimeMs: e.response_time_ms ?? undefined,
        createdAt: e.created_at,
        provider: e.provider ?? undefined,
        model: e.model ?? undefined,
        engineVersion: e.engine_version ?? undefined,
        isError: e.is_error,
        trace: parseTrace(e.trace),
      },
    ]);
    // Continuing a reopened conversation resumes the engine session its *last* turn ran under —
    // earlier ones are stale (a CLI can hand out a new token per turn), and turns recorded before
    // the two ids were separated have none at all, which just means the next message starts a
    // fresh engine session while still filing under this same conversation.
    const engineSession = entries.reduce<string | null>((last, e) => e.engine_session_id ?? last, null);
    const firstAt = entries[0]?.created_at;
    const lastAt = entries[entries.length - 1]?.created_at;
    set((s) => {
      // Re-checked after the await: a turn could have been started in this conversation while the
      // read was in flight, and the freshly loaded copy would clobber it.
      if (s.byConversation[conversationId]) {
        return { activeByProject: { ...s.activeByProject, [projectId]: conversationId } };
      }
      return {
        byConversation: {
          ...s.byConversation,
          [conversationId]: {
            ...newSession(projectId, conversationId),
            messages,
            sessionId: engineSession,
            // No model recorded for archived turns — the chip falls back to the configured
            // setting until this conversation gets a fresh reply.
            model: null,
            title: liveTitle(entries[0]?.question ?? ""),
            createdAt: firstAt ? new Date(firstAt).getTime() : Date.now(),
            updatedAt: lastAt ? new Date(lastAt).getTime() : Date.now(),
            persisted: true,
          },
        },
        activeByProject: { ...s.activeByProject, [projectId]: conversationId },
      };
    });
  },

  discard: (conversationId) => {
    set((s) => {
      if (!s.byConversation[conversationId]) return s;
      const { [conversationId]: _dropped, ...rest } = s.byConversation;
      const activeByProject = Object.fromEntries(
        Object.entries(s.activeByProject).map(([p, id]) => [p, id === conversationId ? null : id]),
      );
      return { byConversation: rest, activeByProject };
    });
  },
}));

/** A project's conversations that are still in memory this session, newest activity first.
 *
 * Activity lists these alongside the persisted rows, which is how a chat that is still answering
 * shows up as "running" at all — the backend only writes its row once the turn lands. */
export function liveSessionsOf(
  byConversation: Record<string, ChatSession>,
  projectId: string | null,
): ChatSession[] {
  if (!projectId) return EMPTY_LIVE;
  const sessions = Object.values(byConversation).filter((s) => s.projectId === projectId);
  return sessions.length === 0 ? EMPTY_LIVE : sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export { EMPTY_CHAT, EMPTY_LIVE };
