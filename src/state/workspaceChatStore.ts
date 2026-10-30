import { create } from "zustand";
import { speakAnswer } from "../lib/speech/speakAnswer";
import { isRepoBusy } from "../lib/tauri/commands";
import {
  chatAttachBytes,
  chatAttachFile,
  chatBranchConversation,
  chatClearContext,
  chatCompact,
  chatCreateWorkspaceConversation,
  chatFailedTurnChanges,
  chatDeleteConversation,
  chatGetConversation,
  chatInflightTurns,
  chatListWorkspaceConversations,
  chatListStagedAttachments,
  chatRemoveAttachment,
  chatRenameConversation,
  chatSend,
  chatCavemanLevels,
  chatCavemanResolve,
  chatSetCaveman,
  chatSetEffort,
  chatSetEngine,
  chatSetUnread,
  chatTruncateFrom,
  chatTurnCheckpoints,
  type ChatAttachment,
  type ChatConversation,
  type ChatMessageRow,
  type ContextReset,
} from "../lib/tauri/chatCommands";
import { traceIdOf } from "../lib/turnTrace";
import type { ChatBubbleMessage } from "../components/chat/ChatMessageBubble";
import type { SkillPick } from "../lib/tauri/chatCommands";
import { onAiChatDelta, onAiDone, onChatTitled } from "../lib/tauri/events";
import type { ContextSource } from "../lib/editorContext";
import type { TurnUsage } from "../types/domain";
import { registerTabBusyProbe, useAiPanelStore } from "./aiPanelStore";
import {
  isCancellation,
  newRunId,
  snapshotTrace,
  useAiRunStore,
} from "./aiRunStore";
import {
  chatQueueKey,
  dropChatQueue,
  enqueueChatMessage,
  holdChatQueue,
  queuedMessages,
  releaseChatQueue,
  restoreChatQueue,
  requeueChatMessageFirst,
  shiftChatQueue,
  takeQueuedChatMessage,
  type QueuedChatMessage,
} from "./chatQueueStore";
import { traceOf } from "./conversationStore";
import { translate } from "./languageStore";
import { notify } from "./notificationStore";
import { pushErrorToast, pushSuccessToast } from "./toastStore";
import { confirmAction } from "./confirmStore";
import type { EditingTurn } from "./chatStore";
import { learnedKey } from "../lib/memoryToast";
import { leavesContextAsIs } from "../lib/contextWindow";

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
  /** `/caveman` level (`""` = off). Lives on the row, so `chat_send` applies it to every engine. */
  cavemanLevel: string;
  /** The chain this chat was opened to carry on, `""` for none. */
  focusChainId: string;
  messages: WsChatMessage[];
  /** The row exists. A fresh tab's chat has none until its first question. */
  persisted: boolean;
  loaded: boolean;
  /** Why the transcript could not be read back, `null` when it could (or was not tried). */
  loadError: string | null;
  /** Where this conversation's context started again, from its row — `/clear`s and account changes.
   *  Nothing before the last is replayed; each draws a line in the transcript. */
  contextResets: ContextReset[];
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
  /** Opens a session in memory — a fresh one, or one read back from disk. `fresh: false` says the
   *  transcript is still to be read, so the chat shows it loading rather than empty. */
  prepare: (
    conversationId: string,
    workspaceId: string,
    opts?: { focusChainId?: string | null; fresh?: boolean },
  ) => void;
  /**
   * Which repositories (project ids) each conversation's next turns are about — `null` or absent
   * means all of them. The picker in the «n repos» popover writes it; the send reads it through
   * {@link scopeFor} once the backend takes the list.
   */
  scopeRepos: Record<string, string[] | null>;
  setScope: (conversationId: string, projectIds: string[] | null) => void;
  /** The repositories the conversation is limited to, `null` for all. */
  scopeFor: (conversationId: string) => string[] | null;
  /** The running turn is stopped and the same question asked again — for a run that has stalled. */
  retryTurn: (conversationId: string) => void;
  /** `/clear`: the next question starts without the earlier history (the transcript stays). */
  clearContext: (conversationId: string) => Promise<void>;
  /** «Bifurcar desde aquí»: a new workspace chat holding the turns up to `atTurn`, opened in its own tab. */
  branchAt: (conversationId: string, atTurn: number) => Promise<void>;
  /** Reads a persisted conversation's transcript (and a turn another window is running in it). */
  ensureLoaded: (conversationId: string, workspaceId: string) => Promise<void>;
  loadList: (workspaceId: string) => Promise<void>;
  setEngine: (conversationId: string, provider: string, model: string, account?: string | null) => Promise<void>;
  setEffort: (conversationId: string, effort: string) => Promise<void>;
  /** What the backend accepts for `/caveman`, loaded once by the first use. */
  cavemanLevels: string[];
  /** Applies `/caveman <argument>`; `false` when the backend did not recognise the word. */
  applyCaveman: (conversationId: string, argument: string) => Promise<boolean>;
  setCaveman: (conversationId: string, level: string) => Promise<void>;
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
  /** The question each conversation's box is rewriting, if any («Editar y reenviar»). */
  editing: Record<string, EditingTurn | undefined>;
  beginEdit: (conversationId: string, index: number) => void;
  cancelEdit: (conversationId: string) => void;
  /**
   * The send of an edited question: confirms once when turns follow it, deletes the thread from that
   * question on (rows, then memory), drops the engine session so the next turn replays the survivors,
   * and asks `text` in its place. `false` = nothing sent (declined, or the cut failed and was said);
   * the box keeps its text and the marker. Queued messages stay queued behind.
   */
  submitEdit: (
    conversationId: string,
    text: string,
    opts?: { skill?: SkillPick | null },
  ) => Promise<boolean>;
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
  /** Deletes the conversation. `false` when it was refused (a turn is running in it) or failed —
   *  the caller must not close the tab then. */
  remove: (conversationId: string) => Promise<boolean>;
}

export const EMPTY_WS_CHAT: WsChatSession = {
  conversationId: "",
  workspaceId: "",
  title: "",
  provider: "",
  model: "",
  accountId: null,
  effort: "",
  cavemanLevel: "",
  focusChainId: "",
  messages: [],
  persisted: false,
  loaded: false,
  loadError: null,
  contextResets: [],
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
  /** On an answer: what the engine read to answer, drawn under it. Restored from the row on reload. */
  context?: ContextSource[];
  /** On an answer: what the turn cost, when the engine said. `undefined` is unreported, not zero. */
  usage?: TurnUsage;
  /** On an answer: folders the engine could write in that are not git repositories, so edits there
   *  cannot be undone from CodeFlow. Restored from the row on reload. */
  unprotectedDirs?: string[];
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
    context: row.context && row.context.length > 0 ? row.context : undefined,
    usage: row.usage ?? undefined,
    unprotectedDirs:
      row.unprotectedDirs && row.unprotectedDirs.length > 0
        ? row.unprotectedDirs
        : undefined,
  };
}

/** Conversations with an edit being confirmed or cut right now: a second Enter must not open a second dialog. */
const editsInFlight = new Set<string>();
async function guardedEdit(
  conversationId: string,
  run: () => Promise<boolean>,
): Promise<boolean> {
  if (editsInFlight.has(conversationId)) return false;
  editsInFlight.add(conversationId);
  try {
    return await run();
  } finally {
    editsInFlight.delete(conversationId);
  }
}

/** A message the backend stored: not the optimistic question (`pending-user-…`) nor a failed turn's
 *  local bubble that has not learned its row's id yet. */
const isStoredId = (id: string) =>
  !id.startsWith("pending-user-") && !id.endsWith("-failed");

/**
 * What replacing the thread from the question at `index` removes — see `chatStore.editPlan`.
 * `cutId` is the stored message of that very exchange (its answer, else the question); `null` when
 * neither is known here, which the store settles by reading the rows.
 */
export function wsEditPlan(
  messages: readonly WsChatMessage[],
  index: number,
): {
  kept: WsChatMessage[];
  laterTurns: number;
  cutId: string | null;
  userOrdinal: number;
} {
  const question = messages[index];
  const answer = messages[index + 1];
  const cutId =
    question && isStoredId(question.id)
      ? question.id
      : answer?.role === "assistant" && isStoredId(answer.id)
        ? answer.id
        : null;
  return {
    kept: messages.slice(0, index),
    laterTurns: messages.slice(index + 1).filter((m) => m.role === "user")
      .length,
    cutId,
    userOrdinal: messages.slice(0, index).filter((m) => m.role === "user")
      .length,
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
    cavemanLevel: row.cavemanLevel ?? "",
    focusChainId: row.focusChainId ?? "",
    contextTokens: row.contextTokens,
    // Read off the row, which is the last measurement there has ever been — so until a turn runs
    // here, what it holds is by definition from an earlier one.
    contextStale: row.contextTokens !== null,
    engineSessionId: row.engineSessionId,
    contextResets: row.contextResets ?? [],
    persisted: true,
  };
}

/** The backend's refusal of a scope naming a repository that is not in the workspace. */
const UNKNOWN_REPO_MARKER = "unknown repository for this workspace";

const runToConversation = new Map<string, string>();
/** Conversations whose running turn was stopped to be asked again — see `retryTurn`. */
const retryAfterStop = new Set<string>();
let listening = false;

// ── Memory cap ─────────────────────────────────────────────────────────────────────────────
// A session holds the whole transcript; opening chats all day would keep every one of them. Sessions
// beyond the cap are dropped, least recently touched first, and read back from disk when reopened.
const MAX_LIVE_SESSIONS = 12;
/** Sessions drawn by a mounted tab: dropping one would leave that tab on an empty chat. */
const pinned = new Map<string, number>();
let recent: string[] = [];

/** Marks a conversation as on screen for as long as the returned function has not been called. */
export function pinWsChat(conversationId: string): () => void {
  pinned.set(conversationId, (pinned.get(conversationId) ?? 0) + 1);
  return () => {
    const n = (pinned.get(conversationId) ?? 1) - 1;
    if (n <= 0) pinned.delete(conversationId);
    else pinned.set(conversationId, n);
  };
}

function touch(conversationId: string): void {
  recent = [...recent.filter((id) => id !== conversationId), conversationId];
}

/** Drops the least recently used sessions that hold nothing memory alone has. Exported for tests. */
export function pruneSessions(max = MAX_LIVE_SESSIONS): void {
  const { byConversation } = useWorkspaceChatStore.getState();
  const ids = Object.keys(byConversation);
  if (ids.length <= max) return;
  recent = recent.filter((id) => byConversation[id] !== undefined);
  // What exists only here: a running turn, a conversation never written, the stopped or failed
  // turns the backend does not store, plan mode, queued questions.
  const evictable = (id: string): boolean => {
    const session = byConversation[id];
    return (
      !!session &&
      !pinned.has(id) &&
      !session.sending &&
      session.persisted &&
      !session.plan &&
      !session.messages.some((m) => m.isCancelled || m.isError) &&
      queuedMessages(wsChatQueueKey(id)).length === 0
    );
  };
  const gone = new Set<string>();
  // Sessions never touched (not in `recent`) go first.
  const order = [...ids.filter((id) => !recent.includes(id)), ...recent];
  for (const id of order) {
    if (ids.length - gone.size <= max) break;
    if (evictable(id)) gone.add(id);
  }
  if (gone.size === 0) return;
  recent = recent.filter((id) => !gone.has(id));
  useWorkspaceChatStore.setState((s) => {
    const rest: Record<string, WsChatSession> = {};
    for (const id of Object.keys(s.byConversation))
      if (!gone.has(id)) rest[id] = s.byConversation[id];
    return { byConversation: rest };
  });
}

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
    editing: {},

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

    scopeRepos: {},
    setScope: (conversationId, projectIds) =>
      set((s) => ({
        scopeRepos: {
          ...s.scopeRepos,
          [conversationId]:
            projectIds && projectIds.length > 0 ? projectIds : null,
        },
      })),
    scopeFor: (conversationId) => get().scopeRepos[conversationId] ?? null,

    retryTurn: (conversationId) => {
      const session = get().byConversation[conversationId];
      if (!session?.sending || !session.runId) return;
      retryAfterStop.add(conversationId);
      void useAiRunStore.getState().cancel(session.runId);
    },

    clearContext: async (conversationId) => {
      const session = get().byConversation[conversationId];
      // Nothing stored has nothing to forget; and the backend refuses while a turn runs.
      if (!session || !session.persisted) return;
      if (session.sending) {
        pushErrorToast(translate("assistant.wsChatClearBusy"));
        return;
      }
      try {
        const row = await chatClearContext(conversationId);
        // What was measured described the history that has just been set aside.
        patch(conversationId, (s) => ({
          ...s,
          contextResets: row.contextResets ?? s.contextResets,
          contextTokens: null,
          contextStale: false,
          engineSessionId: null,
        }));
      } catch (e) {
        pushErrorToast(String(e));
      }
    },

    branchAt: async (conversationId, atTurn) => {
      const session = get().byConversation[conversationId];
      if (!session) return;
      try {
        const fork = await chatBranchConversation(conversationId, atTurn);
        await get().loadList(session.workspaceId);
        useAiPanelStore
          .getState()
          .open({
            kind: "wsChat",
            workspaceId: session.workspaceId,
            conversationId: fork.id,
          });
      } catch (e) {
        pushErrorToast(
          translate("assistant.branchFailed", { error: String(e) }),
        );
      }
    },

    prepare: (conversationId, workspaceId, opts) => {
      listen();
      touch(conversationId);
      if (get().byConversation[conversationId]) return;
      // The history list may already have the row: start from it rather than from a blank.
      const row = (get().listByWorkspace[workspaceId] ?? []).find((c) => c.id === conversationId);
      set((s) => ({
        byConversation: {
          ...s.byConversation,
          [conversationId]: row
            ? sessionFromRow(row)
            : {
                ...EMPTY_WS_CHAT,
                conversationId,
                workspaceId,
                focusChainId: opts?.focusChainId ?? "",
                loaded: opts?.fresh !== false,
              },
        },
      }));
      pruneSessions();
    },

    ensureLoaded: async (conversationId, workspaceId) => {
      listen();
      get().prepare(conversationId, workspaceId);
      // A queue that came back from a restart is checked against the files still on disk.
      void chatListStagedAttachments(conversationId)
        .catch(() => null)
        .then((staged) =>
          restoreChatQueue(wsChatQueueKey(conversationId), staged),
        )
        .catch(() => {});
      let loadFailure: string | null = null;
      const [rows, list, inflight, checkpoints] = await Promise.all([
        chatGetConversation(conversationId, false).catch((e: unknown) => {
          loadFailure = String(e);
          return null;
        }),
        chatListWorkspaceConversations(workspaceId).catch(() => null),
        chatInflightTurns().catch(() => []),
        chatTurnCheckpoints(conversationId).catch(() => ({}) as Record<string, string>),
      ]);
      if (list) set((s) => ({ listByWorkspace: { ...s.listByWorkspace, [workspaceId]: list } }));
      const row = list?.find((c) => c.id === conversationId);
      // The transcript could not be read: say so, and let the user try again. Reading it as empty
      // looked like a chat that had lost everything.
      if (rows === null && (row || list === null)) {
        patch(conversationId, (s) =>
          s.sending && !s.adopted
            ? s
            : { ...s, loaded: false, loadError: loadFailure ?? "load failed" },
        );
        return;
      }
      // No row: a fresh chat nobody has written in yet — nothing on disk to read.
      if (!row) {
        patch(conversationId, (s) =>
          s.loaded ? s : { ...s, loaded: true, loadError: null },
        );
        return;
      }
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
      pruneSessions();
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

    cavemanLevels: [],

    applyCaveman: async (conversationId, argument) => {
      if (get().cavemanLevels.length === 0) {
        void chatCavemanLevels().then(
          (cavemanLevels) => set({ cavemanLevels }),
          () => {},
        );
      }
      const level = await chatCavemanResolve(argument).catch(() => null);
      if (level === null) return false;
      await get().setCaveman(conversationId, level);
      return true;
    },

    setCaveman: async (conversationId, level) => {
      const session = get().byConversation[conversationId];
      if (!session) return;
      patch(conversationId, (s) => ({ ...s, cavemanLevel: level }));
      // A chat nobody has written in has no row yet: the level is applied when the first question
      // creates it (see `send`), the way the reasoning level is.
      if (session.persisted)
        await chatSetCaveman(conversationId, level).catch((e: unknown) =>
          pushErrorToast(String(e)),
        );
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

    beginEdit: (conversationId, index) => {
      const session = get().byConversation[conversationId];
      if (
        !session ||
        session.sending ||
        session.messages[index]?.role !== "user"
      )
        return;
      const fromTurn =
        session.messages.slice(0, index).filter((m) => m.role === "user")
          .length + 1;
      set((s) => ({
        editing: { ...s.editing, [conversationId]: { index, fromTurn } },
      }));
    },

    cancelEdit: (conversationId) => {
      if (!get().editing[conversationId]) return;
      set((s) => ({ editing: { ...s.editing, [conversationId]: undefined } }));
    },

    submitEdit: (conversationId, text, opts) =>
      guardedEdit(conversationId, async () => {
        const edit = get().editing[conversationId];
        const session = get().byConversation[conversationId];
        // No marker, or the question it named is gone: an ordinary send.
        if (
          !edit ||
          !session ||
          session.messages[edit.index]?.role !== "user"
        ) {
          get().cancelEdit(conversationId);
          get().submit(conversationId, text, opts);
          return true;
        }
        if (session.sending) {
          pushErrorToast(translate("chat.editBusy"));
          return false;
        }
        const plan = wsEditPlan(session.messages, edit.index);
        if (plan.laterTurns > 0) {
          const ok = await confirmAction(
            translate("chat.editReplaceConfirm", { count: plan.laterTurns }),
            true,
            translate("chat.editReplaceAction"),
          );
          if (!ok) return false;
        }
        const current = get().byConversation[conversationId];
        if (
          !current ||
          current.sending ||
          current.messages[edit.index]?.role !== "user"
        )
          return false;
        let contextResets = current.contextResets;
        if (current.persisted) {
          try {
            let cutId = wsEditPlan(current.messages, edit.index).cutId;
            if (!cutId) {
              // Neither message of the exchange has met its row id in this window (a stopped or failed
              // turn): the question is the n-th user row on disk.
              const rows = await chatGetConversation(conversationId, false);
              cutId =
                rows.filter((row) => row.role === "user")[plan.userOrdinal]
                  ?.id ?? null;
            }
            if (cutId)
              contextResets =
                (await chatTruncateFrom(conversationId, cutId)).contextResets ??
                contextResets;
          } catch (e) {
            pushErrorToast(String(e));
            return false;
          }
        }
        patch(conversationId, (s) => ({
          ...s,
          messages: s.messages.slice(0, edit.index),
          contextResets,
          // What was measured, and the session it was measured in, described the removed turns.
          contextTokens: null,
          contextStale: false,
          engineSessionId: null,
        }));
        set((s) => ({
          editing: { ...s.editing, [conversationId]: undefined },
        }));
        get().send(conversationId, text, undefined, opts?.skill ?? null);
        return true;
      }),

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
      // A turn is running in it (here, or in another window): deleting the row under it would lose
      // the answer. Say so — the caller keeps the tab open on `false`.
      if (session?.sending || get().compacting[conversationId]) {
        pushErrorToast(translate("assistant.wsChatDeleteBusy"));
        return false;
      }
      try {
        await chatDeleteConversation(conversationId);
      } catch (e) {
        pushErrorToast(String(e));
        return false;
      }
      dropChatQueue(wsChatQueueKey(conversationId));
      recent = recent.filter((id) => id !== conversationId);
      set((s) => {
        const { [conversationId]: _gone, ...byConversation } = s.byConversation;
        const { [conversationId]: _staged, ...attachments } = s.attachments;
        const { [conversationId]: _scope, ...scopeRepos } = s.scopeRepos;
        const { [conversationId]: _compacting, ...compacting } = s.compacting;
        const { [conversationId]: _editing, ...editing } = s.editing;
        return {
          editing,
          byConversation,
          attachments,
          scopeRepos,
          compacting,
          listByWorkspace: Object.fromEntries(
            Object.entries(s.listByWorkspace).map(([ws, rows]) => [ws, rows.filter((row) => row.id !== conversationId)]),
          ),
        };
      });
      return true;
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
      // The repositories this question is limited to, read when the turn goes out.
      const scope = get().scopeFor(conversationId);
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
          if (session.cavemanLevel)
            await chatSetCaveman(conversationId, session.cavemanLevel).catch(
              () => {},
            );
          patch(conversationId, (s) => ({
            ...s,
            persisted: true,
            accountId: row.accountId ?? s.accountId,
            provider: row.provider,
            model: row.model,
          }));
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
          scope,
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
            context:
              reply.context && reply.context.length > 0
                ? reply.context
                : undefined,
            usage: reply.usage ?? undefined,
            unprotectedDirs:
              reply.unprotected_dirs && reply.unprotected_dirs.length > 0
                ? reply.unprotected_dirs
                : undefined,
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
            // This turn measured itself, or it did not — see `contextStale`. A `/context` or
            // `/usage` asked the model nothing, so the last figure is as current as it was.
            contextStale: reply.context_tokens == null ? (leavesContextAsIs(trimmed) ? s.contextStale : true) : false,
            engineSessionId: reply.session_id ?? s.engineSessionId,
          }));
          // Said only when a memory was really saved — never to suggest the model itself learned.
          if (reply.learned_memory) pushSuccessToast(translate(learnedKey(reply.learned_outcome), { title: reply.learned_memory }));
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
          // A repository in the scope was removed since it was picked: the picker's choice is stale,
          // and the error already names it. Back to all, so the next question is not refused too.
          if (String(e).includes(UNKNOWN_REPO_MARKER))
            get().setScope(conversationId, null);
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
          // What the failed or stopped turn left changed on disk, filed under the persisted answer's
          // id: the local bubble takes that id (a reload matches it) and draws the per-repo review.
          void chatFailedTurnChanges(conversationId)
            .then((found) => {
              const changes = parseWsTurnChanges(found?.checkpoints);
              if (!found || !changes) return;
              patch(conversationId, (s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === `${questionId}-failed`
                    ? { ...m, id: found.message_id, changes }
                    : m,
                ),
              }));
            })
            .catch(() => {});
          // A stop that was a retry: the same question again, as it was asked. The queue the stop
          // just held is let go first — a retry is the user carrying on, not pausing.
          if (retryAfterStop.delete(conversationId) && cancelled) {
            releaseChatQueue(wsChatQueueKey(conversationId));
            get().send(conversationId, trimmed, files, skill ?? null);
          }
        })
        .finally(() => {
          // A retry asked for as the turn finished on its own is not a retry of the next Stop.
          retryAfterStop.delete(conversationId);
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

// The panel trims its tabs when too many are open; a workspace chat that is answering, or has
// questions waiting, is spared.
registerTabBusyProbe((tab) => {
  if (tab.kind !== "wsChat") return false;
  const session =
    useWorkspaceChatStore.getState().byConversation[tab.conversationId];
  return (
    !!session?.sending ||
    queuedMessages(wsChatQueueKey(tab.conversationId)).length > 0
  );
});
