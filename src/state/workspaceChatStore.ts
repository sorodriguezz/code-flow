import { create } from "zustand";
import { speakAnswer } from "../lib/speech/speakAnswer";
import { isRepoBusy } from "../lib/tauri/commands";
import {
  chatCreateWorkspaceConversation,
  chatDeleteConversation,
  chatGetConversation,
  chatInflightTurns,
  chatListWorkspaceConversations,
  chatSend,
  chatSetEffort,
  chatSetEngine,
  chatSetUnread,
  chatSetWorkspaceAgent,
  type ChatConversation,
  type ChatMessageRow,
} from "../lib/tauri/chatCommands";
import { traceIdOf } from "../lib/turnTrace";
import type { ChatBubbleMessage } from "../components/chat/ChatMessageBubble";
import { onAiChatDelta, onAiDone, onChatTitled } from "../lib/tauri/events";
import { isCancellation, newRunId, snapshotTrace, useAiRunStore } from "./aiRunStore";
import {
  chatQueueKey,
  dropChatQueue,
  enqueueChatMessage,
  holdChatQueue,
  queuedMessages,
  releaseChatQueue,
  requeueChatMessageFirst,
  shiftChatQueue,
  takeQueuedChatMessage,
  type QueuedChatMessage,
} from "./chatQueueStore";
import { traceOf } from "./conversationStore";
import { translate } from "./languageStore";
import { notify } from "./notificationStore";
import { pushErrorToast } from "./toastStore";

/**
 * The assistant panel's **workspace chats** — one conversation that talks to every repository of a
 * workspace and knows what its SDD/Harness agents are in the middle of (`src-tauri/src/workspace_chat.rs`).
 *
 * Backed by the chat workspace's tables and its `chat_send` (rows with `workspace_scope = 1`, which
 * that workspace never lists), so streaming, effort, compaction and titles are that engine path's.
 * This store is the panel's half: deliberately small, and separate from `conversationStore`, whose
 * active pointer, sidebar list and status-bar targets all mean the chat workspace.
 *
 * - **The tab mints the id.** A new chat is a tab before it is a row; its first question creates the
 *   row under the same id (`chatCreateWorkspaceConversation`), carrying what was picked meanwhile —
 *   engine, thinking level, agent, the chain it was opened for.
 * - **Every turn is stamped with its workspace before the first await** (run isolation): the run
 *   row, the notification and the unread mark name the workspace the question was asked in.
 * - **Enter keeps working while a turn runs** — the same queue the other chats use (`chatQueueStore`).
 */

export interface WsChatSession {
  conversationId: string;
  workspaceId: string;
  title: string;
  /** The engine the conversation answers on — the row's, or what was picked before it existed. */
  provider: string;
  model: string;
  accountId: string | null;
  effort: string;
  /** The SDD/Harness agent in charge, `""` for none. While one is, its routing answers. */
  agentId: string;
  /** The chain this chat was opened to carry on, `""` for none. */
  focusChainId: string;
  messages: WsChatMessage[];
  /** The row exists. A fresh tab's chat has none until its first question. */
  persisted: boolean;
  loaded: boolean;
  sending: boolean;
  /** A turn this window did not start (another window's), followed until `ai:done`. */
  adopted: boolean;
  runId: string | null;
  runStartedAt: number | null;
  /** The answer being written, token by token, for an engine that streams. */
  streamText: string;
  /** A question taken back out of the transcript (refused before reaching an engine), for the box. */
  restored: string | null;
}

interface WsChatState {
  byConversation: Record<string, WsChatSession>;
  listByWorkspace: Record<string, ChatConversation[]>;
  /** Opens a session in memory — a fresh one, or one read back from disk. */
  prepare: (conversationId: string, workspaceId: string, opts?: { focusChainId?: string | null }) => void;
  /** Reads a persisted conversation's transcript (and a turn another window is running in it). */
  ensureLoaded: (conversationId: string, workspaceId: string) => Promise<void>;
  loadList: (workspaceId: string) => Promise<void>;
  setEngine: (conversationId: string, provider: string, model: string, account?: string | null) => Promise<void>;
  setEffort: (conversationId: string, effort: string) => Promise<void>;
  setAgent: (conversationId: string, agentId: string) => Promise<void>;
  /** Sends now, or queues behind the turn that is running. */
  submit: (conversationId: string, text: string) => void;
  send: (conversationId: string, text: string) => void;
  drainQueue: (conversationId: string) => void;
  resumeQueue: (conversationId: string) => void;
  discardQueued: (conversationId: string, itemId: string) => void;
  editQueued: (conversationId: string, itemId: string) => QueuedChatMessage | null;
  stop: (conversationId: string) => void;
  takeRestored: (conversationId: string) => string | null;
  remove: (conversationId: string) => Promise<void>;
}

export const EMPTY_WS_CHAT: WsChatSession = {
  conversationId: "",
  workspaceId: "",
  title: "",
  provider: "",
  model: "",
  accountId: null,
  effort: "",
  agentId: "",
  focusChainId: "",
  messages: [],
  persisted: false,
  loaded: false,
  sending: false,
  adopted: false,
  runId: null,
  runStartedAt: null,
  streamText: "",
  restored: null,
};

export const EMPTY_WS_LIST: ChatConversation[] = [];

/** One turn as the transcript draws it, with the id and number it is filed under. */
export interface WsChatMessage extends ChatBubbleMessage {
  id: string;
  turn: number;
}

export function messageFromRow(row: ChatMessageRow): WsChatMessage {
  return {
    id: row.id,
    turn: row.turn,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    engineVersion: row.engineVersion ?? undefined,
    responseTimeMs: row.responseTimeMs ?? undefined,
    isError: !!row.isError,
    isCancelled: !!row.isCancelled,
    trace: traceOf(row.trace),
    traceId: traceIdOf(row.trace, row.id),
  };
}

export const wsChatQueueKey = (conversationId: string) => chatQueueKey("panel", `ws:${conversationId}`);

const LIVE_TITLE_MAX = 60;
function liveTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > LIVE_TITLE_MAX ? `${oneLine.slice(0, LIVE_TITLE_MAX)}…` : oneLine;
}

/** A session built from its row. */
export function sessionFromRow(row: ChatConversation): WsChatSession {
  return {
    ...EMPTY_WS_CHAT,
    conversationId: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    provider: row.provider,
    model: row.model,
    accountId: row.accountId ?? null,
    effort: row.effort,
    agentId: row.agentId ?? "",
    focusChainId: row.focusChainId ?? "",
    persisted: true,
  };
}

const runToConversation = new Map<string, string>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  void onAiChatDelta((event) => {
    if (event.kind !== "text") return;
    const conversationId = runToConversation.get(event.runId);
    if (!conversationId) return;
    useWorkspaceChatStore.setState((s) => {
      const session = s.byConversation[conversationId];
      if (!session || session.runId !== event.runId) return s;
      return { byConversation: { ...s.byConversation, [conversationId]: { ...session, streamText: session.streamText + event.text } } };
    });
  });
  void onChatTitled(({ surface, conversationId, title }) => {
    if (surface !== "chat") return;
    useWorkspaceChatStore.setState((s) => {
      const session = s.byConversation[conversationId];
      const lists = Object.entries(s.listByWorkspace);
      const touched = lists.some(([, rows]) => rows.some((row) => row.id === conversationId));
      if (!session && !touched) return s;
      return {
        byConversation: session ? { ...s.byConversation, [conversationId]: { ...session, title } } : s.byConversation,
        listByWorkspace: touched
          ? Object.fromEntries(lists.map(([ws, rows]) => [ws, rows.map((row) => (row.id === conversationId ? { ...row, title } : row))]))
          : s.listByWorkspace,
      };
    });
  });
  // A turn another window started ends: its answer is on disk, read it back.
  void onAiDone(({ run_id }) => {
    const entry = Object.entries(useWorkspaceChatStore.getState().byConversation).find(
      ([, session]) => session.adopted && session.runId === run_id,
    );
    if (!entry) return;
    const [conversationId, session] = entry;
    useWorkspaceChatStore.setState((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: { ...s.byConversation[conversationId], sending: false, adopted: false, runId: null, runStartedAt: null, streamText: "", loaded: false },
      },
    }));
    void useWorkspaceChatStore.getState().ensureLoaded(conversationId, session.workspaceId);
  });
}

export const useWorkspaceChatStore = create<WsChatState>((set, get) => {
  const patch = (conversationId: string, change: (session: WsChatSession) => WsChatSession) =>
    set((s) => {
      const current = s.byConversation[conversationId];
      if (!current) return s;
      return { byConversation: { ...s.byConversation, [conversationId]: change(current) } };
    });

  return {
    byConversation: {},
    listByWorkspace: {},

    prepare: (conversationId, workspaceId, opts) => {
      listen();
      if (get().byConversation[conversationId]) return;
      // The history list may already have the row: start from it rather than from a blank.
      const row = (get().listByWorkspace[workspaceId] ?? []).find((c) => c.id === conversationId);
      set((s) => ({
        byConversation: {
          ...s.byConversation,
          [conversationId]: row
            ? sessionFromRow(row)
            : { ...EMPTY_WS_CHAT, conversationId, workspaceId, focusChainId: opts?.focusChainId ?? "", loaded: true },
        },
      }));
    },

    ensureLoaded: async (conversationId, workspaceId) => {
      listen();
      get().prepare(conversationId, workspaceId);
      const [rows, list, inflight] = await Promise.all([
        chatGetConversation(conversationId, false).catch(() => null),
        chatListWorkspaceConversations(workspaceId).catch(() => null),
        chatInflightTurns().catch(() => []),
      ]);
      if (list) set((s) => ({ listByWorkspace: { ...s.listByWorkspace, [workspaceId]: list } }));
      const row = list?.find((c) => c.id === conversationId);
      // No row: a fresh chat nobody has written in yet — nothing on disk to read.
      if (!row) return;
      void chatSetUnread(conversationId, false).catch(() => {});
      const running = inflight.find((turn) => turn.conversationId === conversationId);
      set((s) => {
        const live = s.byConversation[conversationId];
        // A turn of this window's own is in flight: memory is the only copy of it.
        if (live?.sending && !live.adopted) return s;
        const base = { ...sessionFromRow(row), ...(live ? { streamText: live.streamText, restored: live.restored } : {}) };
        return {
          byConversation: {
            ...s.byConversation,
            [conversationId]: {
              ...base,
              messages: rows ? rows.map(messageFromRow) : (live?.messages ?? []),
              loaded: true,
              ...(running
                ? { sending: true, adopted: true, runId: running.runId, runStartedAt: running.startedAtMs }
                : { sending: false, adopted: false, runId: null, runStartedAt: null }),
            },
          },
        };
      });
      // Only a turn this window did not start: its own is already registered, with its promise.
      if (running && get().byConversation[conversationId]?.adopted) {
        runToConversation.set(running.runId, conversationId);
        useAiRunStore.getState().adopt(running.runId, {
          kindKey: "agents.liveKindChat",
          detail: row.title || conversationId,
          target: { openAiPanel: true, select: { kind: "workspaceChat", id: `${workspaceId}::${conversationId}` } },
          workspaceId,
        });
      }
    },

    loadList: async (workspaceId) => {
      listen();
      const list = await chatListWorkspaceConversations(workspaceId).catch(() => null);
      if (list) set((s) => ({ listByWorkspace: { ...s.listByWorkspace, [workspaceId]: list } }));
    },

    setEngine: async (conversationId, provider, model, account) => {
      const session = get().byConversation[conversationId];
      if (!session) return;
      // Picking an engine is taking the agent out of charge: one answers, not both.
      patch(conversationId, (s) => ({ ...s, provider, model, accountId: account ?? s.accountId, agentId: "" }));
      if (!session.persisted) return;
      try {
        if (session.agentId) await chatSetWorkspaceAgent(conversationId, "");
        const accountId = await chatSetEngine(conversationId, provider, model, account ?? null);
        patch(conversationId, (s) => ({ ...s, accountId }));
      } catch (e) {
        patch(conversationId, (s) => ({ ...s, provider: session.provider, model: session.model, accountId: session.accountId, agentId: session.agentId }));
        pushErrorToast(String(e));
      }
    },

    setEffort: async (conversationId, effort) => {
      const session = get().byConversation[conversationId];
      if (!session) return;
      patch(conversationId, (s) => ({ ...s, effort }));
      if (session.persisted) await chatSetEffort(conversationId, effort).catch((e: unknown) => pushErrorToast(String(e)));
    },

    setAgent: async (conversationId, agentId) => {
      const session = get().byConversation[conversationId];
      if (!session) return;
      patch(conversationId, (s) => ({ ...s, agentId }));
      if (!session.persisted) return;
      await chatSetWorkspaceAgent(conversationId, agentId).catch((e: unknown) => {
        patch(conversationId, (s) => ({ ...s, agentId: session.agentId }));
        pushErrorToast(String(e));
      });
    },

    submit: (conversationId, text) => {
      const trimmed = text.trim();
      const session = get().byConversation[conversationId];
      if (!trimmed || !session) return;
      const key = wsChatQueueKey(conversationId);
      if (!session.sending && queuedMessages(key).length === 0) {
        get().send(conversationId, trimmed);
        return;
      }
      enqueueChatMessage(key, { text: trimmed });
      get().drainQueue(conversationId);
    },

    drainQueue: (conversationId) => {
      const session = get().byConversation[conversationId];
      if (!session || session.sending) return;
      const next = shiftChatQueue(wsChatQueueKey(conversationId));
      if (next) get().send(conversationId, next.text);
    },

    resumeQueue: (conversationId) => {
      releaseChatQueue(wsChatQueueKey(conversationId));
      get().drainQueue(conversationId);
    },

    discardQueued: (conversationId, itemId) => {
      takeQueuedChatMessage(wsChatQueueKey(conversationId), itemId);
    },

    editQueued: (conversationId, itemId) => takeQueuedChatMessage(wsChatQueueKey(conversationId), itemId),

    stop: (conversationId) => {
      const runId = get().byConversation[conversationId]?.runId;
      if (runId) void useAiRunStore.getState().cancel(runId);
    },

    takeRestored: (conversationId) => {
      const text = get().byConversation[conversationId]?.restored ?? null;
      if (text !== null) patch(conversationId, (s) => ({ ...s, restored: null }));
      return text;
    },

    remove: async (conversationId) => {
      const session = get().byConversation[conversationId];
      if (session?.sending) return;
      await chatDeleteConversation(conversationId);
      dropChatQueue(wsChatQueueKey(conversationId));
      set((s) => {
        const { [conversationId]: _gone, ...byConversation } = s.byConversation;
        return {
          byConversation,
          listByWorkspace: Object.fromEntries(
            Object.entries(s.listByWorkspace).map(([ws, rows]) => [ws, rows.filter((row) => row.id !== conversationId)]),
          ),
        };
      });
    },

    send: (conversationId, text) => {
      listen();
      const trimmed = text.trim();
      const session = get().byConversation[conversationId];
      if (!trimmed || !session || session.sending) return;

      // Captured before the first await, never re-read: the answer may land while the user stands
      // in another workspace, and everything this turn files is the asking workspace's.
      const workspaceId = session.workspaceId;
      const title = session.title || liveTitle(trimmed);
      const runId = newRunId("chat");
      const target = { openAiPanel: true, select: { kind: "workspaceChat" as const, id: `${workspaceId}::${conversationId}` } };
      useAiRunStore.getState().start(runId, { kindKey: "agents.liveKindChat", detail: trimmed, target, workspaceId });
      runToConversation.set(runId, conversationId);

      const lastTurn = session.messages.length > 0 ? session.messages[session.messages.length - 1].turn : -1;
      const questionId = `pending-user-${crypto.randomUUID()}`;
      patch(conversationId, (s) => ({
        ...s,
        title,
        sending: true,
        adopted: false,
        runId,
        runStartedAt: Date.now(),
        streamText: "",
        messages: [
          ...s.messages,
          {
            id: questionId,
            role: "user",
            content: trimmed,
            turn: lastTurn + 1,
            createdAt: new Date().toISOString(),
            isError: false,
            isCancelled: false,
          },
        ],
      }));

      const run = async () => {
        if (!session.persisted) {
          // The first question makes the row, with everything picked before it was asked.
          const row = await chatCreateWorkspaceConversation({
            conversationId,
            workspaceId,
            provider: session.provider,
            model: session.model,
            account: session.accountId,
            agentId: session.agentId || null,
            focusChainId: session.focusChainId || null,
            effort: session.effort || null,
          });
          patch(conversationId, (s) => ({ ...s, persisted: true, accountId: row.accountId ?? s.accountId, provider: row.provider, model: row.model }));
        }
        return chatSend(conversationId, trimmed, runId, null, null, true, [], null);
      };

      void run()
        .then((reply) => {
          const trace = snapshotTrace(runId);
          const answer: WsChatMessage = {
            id: reply.message_id,
            role: "assistant",
            content: reply.text,
            turn: lastTurn + 2,
            createdAt: reply.created_at,
            provider: reply.provider,
            model: reply.model ?? undefined,
            engineVersion: reply.engine_version ?? undefined,
            responseTimeMs: reply.response_time_ms,
            isError: false,
            isCancelled: false,
            trace: trace.length > 0 ? trace : undefined,
          };
          patch(conversationId, (s) => ({
            ...s,
            messages: [...s.messages, answer],
            provider: reply.provider,
            model: reply.model ?? s.model,
            accountId: reply.account_id !== undefined ? (reply.account_id ?? null) : s.accountId,
            sending: false,
            runId: null,
            runStartedAt: null,
            streamText: "",
          }));
          notify({
            source: "chat",
            titleKey: "notifications.chatDone",
            target,
            workspaceId,
            status: "success",
            detail: title,
          });
          speakAnswer(reply.text, workspaceId);
          void get().loadList(workspaceId);
          get().drainQueue(conversationId);
        })
        .catch((e: unknown) => {
          // Refused before any engine ran (another window holds this conversation's turn): nothing
          // was recorded, so the question goes back to the head of the queue, held.
          if (isRepoBusy(e)) {
            patch(conversationId, (s) => ({
              ...s,
              messages: s.messages.filter((m) => m.id !== questionId),
              sending: false,
              runId: null,
              runStartedAt: null,
              streamText: "",
            }));
            requeueChatMessageFirst(wsChatQueueKey(conversationId), { text: trimmed });
            holdChatQueue(wsChatQueueKey(conversationId), "error");
            pushErrorToast(translate("assistant.wsChatBusy"));
            return;
          }
          const cancelled = isCancellation(e);
          holdChatQueue(wsChatQueueKey(conversationId), cancelled ? "stopped" : "error");
          const trace = snapshotTrace(runId);
          patch(conversationId, (s) => ({
            ...s,
            messages: [
              ...s.messages,
              {
                id: `${questionId}-failed`,
                role: "assistant",
                content: cancelled ? "" : String(e),
                turn: lastTurn + 2,
                createdAt: new Date().toISOString(),
                provider: s.provider || undefined,
                isError: !cancelled,
                isCancelled: cancelled,
                trace: trace.length > 0 ? trace : undefined,
              },
            ],
            sending: false,
            runId: null,
            runStartedAt: null,
            streamText: "",
          }));
          if (!cancelled) {
            notify({ source: "chat", titleKey: "notifications.chatFailed", target, workspaceId, status: "error", detail: title });
          }
          void get().loadList(workspaceId);
        })
        .finally(() => {
          runToConversation.delete(runId);
          useAiRunStore.getState().finish(runId);
        });
    },
  };
});
