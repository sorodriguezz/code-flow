import { create } from "zustand";
import { speakAnswer } from "../lib/speech/speakAnswer";
import { isRepoBusy } from "../lib/tauri/commands";
import {
  chatAttachBytes,
  chatAttachFile,
  chatCompact,
  chatCreateWorkspaceConversation,
  chatDeleteConversation,
  chatGetConversation,
  chatInflightTurns,
  chatListWorkspaceConversations,
  chatRemoveAttachment,
  chatRenameConversation,
  chatSend,
  chatSetEffort,
  chatSetEngine,
  chatSetUnread,
  chatTurnCheckpoints,
  type ChatAttachment,
  type ChatConversation,
  type ChatMessageRow,
} from "../lib/tauri/chatCommands";
import { traceIdOf } from "../lib/turnTrace";
import type { ChatBubbleMessage } from "../components/chat/ChatMessageBubble";
import type { SkillPick } from "../lib/tauri/chatCommands";
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
 * workspace (`src-tauri/src/workspace_chat.rs`).
 *
 * Backed by the chat workspace's tables and its `chat_send` (rows with `workspace_scope = 1`, which
 * that workspace never lists), so streaming, effort, compaction and titles are that engine path's.
 * This store is the panel's half: deliberately small, and separate from `conversationStore`, whose
 * active pointer, sidebar list and status-bar targets all mean the chat workspace.
 *
 * - **The tab mints the id.** A new chat is a tab before it is a row; its first question creates the
 *   row under the same id (`chatCreateWorkspaceConversation`), carrying what was picked meanwhile —
 *   engine, thinking level, the chain it was opened for.
 * - **Every turn is stamped with its workspace before the first await** (run isolation): the run
 *   row, the notification and the unread mark name the workspace the question was asked in.
 * - **Enter keeps working while a turn runs** — the same queue the other chats use (`chatQueueStore`).
 * - **Attachments, like the repository chat** — any file, staged per conversation and named to the
 *   engine with the question, which reads it with its own tool. Copied under the chat workspace's
 *   root (`chat_attach_*`), because `chat_send` is what resolves the ids; a queued question carries
 *   its own.
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
  /** Plan mode: each turn runs read-only and answers with a plan. Kept in memory, like the
   *  repository chat's. */
  plan: boolean;
  /**
   * What the engine said it was holding at the end of its last turn, or `null` when none has said.
   *
   * **Measured, never computed** — the meter falls back to an estimate over the transcript and
   * says which of the two it is showing (`ContextMeter`). Carried on the session because it comes
   * back on the reply and is written to the row, and the composer needs it without re-reading the
   * conversation.
   */
  contextTokens: number | null;
  /**
   * Whether {@link contextTokens} describes the **last** turn or an earlier one.
   *
   * A turn that reports no usage — and they happen: a cancelled run, a `/compact`, an output format
   * the parser did not recognise — leaves the previous figure standing, both here and on the
   * conversation row (`update_session` writes `COALESCE(new, old)`). That is the right thing to keep
   * and the wrong thing to present as current: the meter showed one number with full confidence
   * while the conversation had grown by several turns underneath it. `true` makes it read as the
   * approximation it is — see `ContextMeter`.
   */
  contextStale: boolean;
  /** The engine's own resume token for the last turn, `null` before one lands. The meter reads it
   *  to say whether the next turn continues that session or replays the thread. */
  engineSessionId: string | null;
}

interface WsChatState {
  byConversation: Record<string, WsChatSession>;
  listByWorkspace: Record<string, ChatConversation[]>;
  /** Images waiting in each conversation's composer, sent with its next question. */
  attachments: Record<string, ChatAttachment[]>;
  attachFilePath: (conversationId: string, sourcePath: string) => Promise<void>;
  attachFileBytes: (conversationId: string, name: string, data: Uint8Array) => Promise<void>;
  removeAttachment: (conversationId: string, attachmentId: string) => void;
  /** Opens a session in memory — a fresh one, or one read back from disk. */
  prepare: (conversationId: string, workspaceId: string, opts?: { focusChainId?: string | null }) => void;
  /** Reads a persisted conversation's transcript (and a turn another window is running in it). */
  ensureLoaded: (conversationId: string, workspaceId: string) => Promise<void>;
  loadList: (workspaceId: string) => Promise<void>;
  setEngine: (conversationId: string, provider: string, model: string, account?: string | null) => Promise<void>;
  setEffort: (conversationId: string, effort: string) => Promise<void>;
  setPlan: (conversationId: string, on: boolean) => void;
  /** Conversations whose summary is being written right now — the meter's spinner. */
  compacting: Record<string, boolean>;
  /**
   * Replaces the turns so far with a summary the thread's own engine writes (`chat_compact`), so
   * the next question starts from a fraction of the context.
   *
   * The app's own compaction, not Claude's `/compact`. Sending that word as a question is what the
   * repository chat does, where the CLI session is resumed and the CLI acts on it; this chat
   * replays its prefix instead, so the same word simply reached the model as a question and was
   * answered as one (user report, 2026-10-19). The backend already compacts these conversations by
   * itself when a turn would overflow — this is the same operation, asked for.
   */
  compact: (conversationId: string) => Promise<void>;
  /** Sends now, or queues behind the turn that is running. */
  submit: (conversationId: string, text: string, opts?: { skill?: SkillPick | null }) => void;
  /** `files` are a queued question's own images; absent, the composer's staged ones go. */
  send: (conversationId: string, text: string, files?: ChatAttachment[], skill?: SkillPick | null) => void;
  drainQueue: (conversationId: string) => void;
  resumeQueue: (conversationId: string) => void;
  discardQueued: (conversationId: string, itemId: string) => void;
  editQueued: (conversationId: string, itemId: string) => QueuedChatMessage | null;
  stop: (conversationId: string) => void;
  takeRestored: (conversationId: string) => string | null;
  /** A title the user chose, in the row, the open chat and the store. */
  rename: (conversationId: string, title: string) => Promise<void>;
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
  plan: false,
  contextTokens: null,
  // Nothing has been measured yet, so there is nothing to be stale about; the meter falls back to
  // the estimate and says so.
  contextStale: false,
  engineSessionId: null,
};

export const EMPTY_WS_LIST: ChatConversation[] = [];

/** One turn as the transcript draws it, with the id and number it is filed under. */
export interface WsChatMessage extends ChatBubbleMessage {
  id: string;
  turn: number;
  /** On a question asked in plan mode, and on its answer — the panel offers to carry it out. Live only. */
  plan?: boolean;
  /** On an answer: what the turn changed, one entry per repository — the per-turn review. */
  changes?: WsTurnChanges[];
}

/** One repository's part of what a workspace chat's turn changed. */
export interface WsTurnChanges {
  repo: string;
  repoPath: string;
  checkpointId: string;
  paths: string[];
}

/** `ChatReply.checkpoints` / `chat_turn_checkpoints` — `[{repo, path, id, paths}]` — or `undefined`. */
export function parseWsTurnChanges(json: string | null | undefined): WsTurnChanges[] | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return undefined;
    const out: WsTurnChanges[] = [];
    for (const entry of value as { repo?: unknown; path?: unknown; id?: unknown; paths?: unknown }[]) {
      if (typeof entry.path !== "string" || typeof entry.id !== "string" || !Array.isArray(entry.paths)) continue;
      const paths = entry.paths.filter((path): path is string => typeof path === "string");
      if (paths.length > 0) out.push({ repo: typeof entry.repo === "string" ? entry.repo : "", repoPath: entry.path, checkpointId: entry.id, paths });
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
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
    focusChainId: row.focusChainId ?? "",
    contextTokens: row.contextTokens,
    // Read off the row, which is the last measurement there has ever been — so until a turn runs
    // here, what it holds is by definition from an earlier one.
    contextStale: row.contextTokens !== null,
    engineSessionId: row.engineSessionId,
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
    applyTitle(conversationId, title);
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
    attachments: {},

    attachFilePath: async (conversationId, sourcePath) => {
      try {
        const file = await chatAttachFile(conversationId, sourcePath);
        set((s) => ({ attachments: { ...s.attachments, [conversationId]: [...(s.attachments[conversationId] ?? []), file] } }));
      } catch (e) {
        pushErrorToast(String(e));
      }
    },

    attachFileBytes: async (conversationId, name, data) => {
      try {
        const file = await chatAttachBytes(conversationId, name, Array.from(data));
        set((s) => ({ attachments: { ...s.attachments, [conversationId]: [...(s.attachments[conversationId] ?? []), file] } }));
      } catch (e) {
        pushErrorToast(String(e));
      }
    },

    removeAttachment: (conversationId, attachmentId) => {
      set((s) => ({
        attachments: {
          ...s.attachments,
          [conversationId]: (s.attachments[conversationId] ?? []).filter((file) => file.id !== attachmentId),
        },
      }));
      // Best effort: a copy that could not be deleted goes with the conversation, or with the sweep.
      void chatRemoveAttachment(conversationId, attachmentId).catch(() => {});
    },

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
      const [rows, list, inflight, checkpoints] = await Promise.all([
        chatGetConversation(conversationId, false).catch(() => null),
        chatListWorkspaceConversations(workspaceId).catch(() => null),
        chatInflightTurns().catch(() => []),
        chatTurnCheckpoints(conversationId).catch(() => ({}) as Record<string, string>),
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
              messages: rows
                ? rows.map((row) => {
                    const message = messageFromRow(row);
                    const changes = parseWsTurnChanges(checkpoints[row.id]);
                    return changes ? { ...message, changes } : message;
                  })
                : (live?.messages ?? []),
              plan: live?.plan ?? false,
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
      patch(conversationId, (s) => ({ ...s, provider, model, accountId: account ?? s.accountId }));
      if (!session.persisted) return;
      try {
        const accountId = await chatSetEngine(conversationId, provider, model, account ?? null);
        patch(conversationId, (s) => ({ ...s, accountId }));
      } catch (e) {
        patch(conversationId, (s) => ({ ...s, provider: session.provider, model: session.model, accountId: session.accountId }));
        pushErrorToast(String(e));
      }
    },

    setEffort: async (conversationId, effort) => {
      const session = get().byConversation[conversationId];
      if (!session) return;
      patch(conversationId, (s) => ({ ...s, effort }));
      if (session.persisted) await chatSetEffort(conversationId, effort).catch((e: unknown) => pushErrorToast(String(e)));
    },

    setPlan: (conversationId, on) => patch(conversationId, (s) => ({ ...s, plan: on })),

    compacting: {},

    compact: async (conversationId) => {
      const session = get().byConversation[conversationId];
      // Nothing to summarise, or something already using this conversation's lease: the backend
      // refuses both as well, and refusing here is what keeps the button from looking broken.
      if (!session || !session.persisted || session.sending || get().compacting[conversationId]) return;
      const runId = newRunId("chat");
      set((s) => ({ compacting: { ...s.compacting, [conversationId]: true } }));
      useAiRunStore.getState().start(runId, {
        kindKey: "chat.compacting",
        detail: session.title,
        target: { openAiPanel: true, select: { kind: "workspaceChat", id: `${session.workspaceId}::${conversationId}` } },
        workspaceId: session.workspaceId,
      });
      try {
        await chatCompact(conversationId, runId);
        // What was measured described the context that has just been replaced, and the session it
        // was measured in is gone with it — `chat_compact` clears both on the row.
        patch(conversationId, (s) => ({ ...s, contextTokens: null, engineSessionId: null }));
        await get().loadList(session.workspaceId);
      } catch (e: unknown) {
        pushErrorToast(String(e));
      } finally {
        set((s) => ({ compacting: { ...s.compacting, [conversationId]: false } }));
      }
    },

    submit: (conversationId, text, opts) => {
      const trimmed = text.trim();
      const session = get().byConversation[conversationId];
      if (!trimmed || !session) return;
      const key = wsChatQueueKey(conversationId);
      const skill = opts?.skill ?? null;
      if (!session.sending && queuedMessages(key).length === 0) {
        get().send(conversationId, trimmed, undefined, skill);
        return;
      }
      // A queued question takes the staged images with it: the box is free for the next one.
      const files = get().attachments[conversationId] ?? [];
      if (files.length > 0) set((s) => ({ attachments: { ...s.attachments, [conversationId]: [] } }));
      enqueueChatMessage(key, { text: trimmed, attachments: files.length > 0 ? files : undefined, skill: skill ?? undefined });
      get().drainQueue(conversationId);
    },

    drainQueue: (conversationId) => {
      const session = get().byConversation[conversationId];
      if (!session || session.sending) return;
      const next = shiftChatQueue(wsChatQueueKey(conversationId));
      if (next) get().send(conversationId, next.text, next.attachments ?? [], next.skill ?? null);
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

    rename: async (conversationId, title) => {
      await chatRenameConversation(conversationId, title);
      applyTitle(conversationId, title);
    },

    remove: async (conversationId) => {
      const session = get().byConversation[conversationId];
      if (session?.sending) return;
      await chatDeleteConversation(conversationId);
      dropChatQueue(wsChatQueueKey(conversationId));
      set((s) => {
        const { [conversationId]: _gone, ...byConversation } = s.byConversation;
        const { [conversationId]: _staged, ...attachments } = s.attachments;
        return {
          byConversation,
          attachments,
          listByWorkspace: Object.fromEntries(
            Object.entries(s.listByWorkspace).map(([ws, rows]) => [ws, rows.filter((row) => row.id !== conversationId)]),
          ),
        };
      });
    },

    send: (conversationId, text, filesArg, skill) => {
      listen();
      const trimmed = text.trim();
      const session = get().byConversation[conversationId];
      if (!trimmed || !session || session.sending) return;

      // The images go with this question — a queued one's own, else the composer's, taken off now.
      const files = filesArg ?? get().attachments[conversationId] ?? [];
      if (!filesArg && files.length > 0) set((s) => ({ attachments: { ...s.attachments, [conversationId]: [] } }));

      // Captured before the first await, never re-read: the answer may land while the user stands
      // in another workspace, and everything this turn files is the asking workspace's.
      const workspaceId = session.workspaceId;
      const title = session.title || liveTitle(trimmed);
      const runId = newRunId("chat");
      const target = { openAiPanel: true, select: { kind: "workspaceChat" as const, id: `${workspaceId}::${conversationId}` } };
      useAiRunStore.getState().start(runId, { kindKey: "agents.liveKindChat", detail: trimmed, target, workspaceId });
      runToConversation.set(runId, conversationId);

      const lastTurn = session.messages.length > 0 ? session.messages[session.messages.length - 1].turn : -1;
      // Read when the turn goes out, as the repository chat does: a queued question takes the mode
      // the composer is in by the time its turn comes.
      const plan = session.plan;
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
            attachments: files.length > 0 ? files : undefined,
            skill: skill?.name,
            plan: plan || undefined,
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
            focusChainId: session.focusChainId || null,
            effort: session.effort || null,
          });
          patch(conversationId, (s) => ({ ...s, persisted: true, accountId: row.accountId ?? s.accountId, provider: row.provider, model: row.model }));
        }
        return chatSend(
          conversationId,
          trimmed,
          runId,
          null,
          null,
          true,
          files.map((file) => file.id),
          skill ?? null,
          plan,
        );
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
            plan: plan || undefined,
            changes: parseWsTurnChanges(reply.checkpoints),
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
            // `undefined` from an engine that does not report it leaves the last measurement
            // standing, the way the row does — emptying the gauge would read as "no context".
            contextTokens: reply.context_tokens ?? s.contextTokens,
            // This turn measured itself, or it did not — see `contextStale`.
            contextStale: reply.context_tokens == null,
            engineSessionId: reply.session_id ?? s.engineSessionId,
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
            requeueChatMessageFirst(wsChatQueueKey(conversationId), {
              text: trimmed,
              attachments: files.length > 0 ? files : undefined,
              skill: skill ?? undefined,
            });
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

/** A conversation's new title, everywhere this store keeps it — the open chat and every list row. */
function applyTitle(conversationId: string, title: string): void {
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
}
