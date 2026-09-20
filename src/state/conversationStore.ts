import { create } from "zustand";
import {
  chatBranchConversation,
  chatCavemanLevels,
  chatCavemanResolve,
  chatCompact,
  chatContextWindow,
  chatCreateConversation,
  chatDeleteConversation,
  chatGetConversation,
  chatListConversations,
  chatRenameConversation,
  chatSetEngine,
  chatSetUnread,
  chatListGroups,
  chatCreateGroup,
  chatRenameGroup,
  chatDeleteGroup,
  chatSetGroupArchived,
  chatSetGroupPinned,
  chatSetGroupCollapsed,
  chatReorderGroups,
  chatSetConversationGroup,
  chatSetGroupInstructions,
  chatGroupAttachFile,
  chatGroupListContext,
  chatGroupRemoveContext,
  chatListAttachments,
  chatListOutputs,
  chatRemoveAttachment,
  chatSweepAttachments,
  chatInflightTurns,
  chatSetEffort,
  chatEffortSupport,
  chatModelEffortSupport,
  chatSearchConversations,
  chatSend,
  chatSetArchived,
  chatSetCaveman,
  chatSetPinned,
  chatUncompact,
  type ChatConversation,
  type ChatGroup,
  type ChatAttachment,
  type ChatMessageRow,
  type ChatOutput,
  type ChatSearchHit,
} from "../lib/tauri/chatCommands";
import { isRepoBusy, notifyStateChange, REPO_BUSY_MARKER } from "../lib/tauri/commands";
import { onAiChatDelta, onAiDone, onStateInvalidate, type AiChatDeltaEvent } from "../lib/tauri/events";
import { isCancellation, newRunId, snapshotTrace, useAiRunStore, type AiRunLine } from "./aiRunStore";
import { parseTrace } from "./chatStore";
import { formatAgentLogLine } from "../lib/agentLog";
import { providerCapabilities } from "../lib/aiProviders";
import { translate } from "./languageStore";
import { pushErrorToast, pushSuccessToast } from "./toastStore";
import { notify } from "./notificationStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * State for the `chat` workspace: the flat conversation list and the transcripts behind it.
 *
 * This is deliberately a **second** store rather than a widened `chatStore`. That one keeps serving
 * the AI panel's repo chat, is backed by `activity_log`, and is keyed by project at its edges;
 * this one is backed by the `chat_conversations` / `chat_messages` tables and is keyed by
 * conversation all the way through. What it does inherit from its predecessor is every trap that
 * one already paid for, so read `state/chatStore.ts` before changing anything here:
 *
 * - **Keyed by conversation, never by project.** A turn is in flight for as long as the engine
 *   takes, and in the meantime the user is free to start a new chat or reopen an old one. One slot
 *   per project meant the reply either vanished or — worse — was appended to whatever happened to
 *   be on screen when it arrived.
 * - **The app mints the conversation's identity, the engine's session id is a separate field.**
 *   The CLIs are inconsistent about their own ids (Codex reports one fixed sentinel per run, the
 *   Claude CLI can mint a new one per resumed turn, `agy` answers `agy-last` for everything), so a
 *   conversation that borrowed them would fragment or merge at random.
 * - **Nothing moves the active pointer when a reply lands.** Answers arrive while the user is
 *   looking somewhere else; that is the normal case, not the edge case.
 *
 * What is new here, and what most of the length below is about:
 *
 * - `projectId` is `string | null`, and `null` is the *default*. A conversation about nothing is
 *   the ordinary thing a chat workspace holds.
 * - Transcripts are capped at {@link MAX_LIVE_CONVERSATIONS} and re-read from disk on revisit.
 * - A reply can arrive in fragments, and the transcript grows a message object per fragment.
 */

/**
 * One message as the transcript renders it.
 *
 * Structurally the wire row plus two things disk cannot hand back directly: the trace already
 * parsed and formatted the way the live log renders it, and the reasoning accumulated from
 * `thinking_delta`. Deliberately a *superset* of `ChatMessageRow` rather than a parallel shape, so
 * a component can be typed on the contract type and still be handed one of these.
 *
 * `id` is the persisted row id once there is one. Before that — for the optimistic question, and
 * for an answer still being written — it is a locally minted placeholder, replaced the moment the
 * backend names the row. Every bubble is memoized on the message object, so this is also what tells
 * React that the bubble is the same bubble across that swap.
 *
 * `turn` is provisional for a turn this window just sent and authoritative for anything read back
 * from disk; the backend assigns the real one and the next read picks it up.
 */
export interface ConversationMessage extends Omit<ChatMessageRow, "trace"> {
  /** What the engine printed while producing this answer. Only present when the transcript was read
   *  with traces, or when the turn happened in this session. */
  trace?: AiRunLine[];
  /** The model's reasoning, from `thinking_delta`. Feeds the collapsible block, never the answer
   *  bubble — the two interleave in the stream and must not interleave on screen. */
  thinking?: string;
  /** Files this turn wrote, by path relative to the conversation's working directory. Parsed from
   *  the row; see `pathsOf`. */
  outputs?: string[];
}

/**
 * Rehydrates the `outputs` column, which arrives either as the stored JSON string or as an already
 * parsed array depending on how the backend hands it over — exactly like `trace`, and accepted in
 * both shapes here rather than betting on one.
 *
 * Anything that is not an array of strings answers `undefined`: a malformed column should draw no
 * chips, not a chip whose path is `[object Object]`.
 */
export function pathsOf(raw: unknown): string[] | undefined {
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(parsed)) return undefined;
  const paths = parsed.filter((entry): entry is string => typeof entry === "string");
  return paths.length > 0 ? paths : undefined;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Rehydrates whatever the backend hands over as a trace.
 *
 * The column is `TEXT` holding a JSON array of `{ stream, line }`, and the contract types the field
 * as a parsed array — so both shapes are accepted here rather than betting on one. Either way the
 * lines go through `formatAgentLogLine`, which is what the live log applies, so a turn reopened
 * tomorrow reads exactly as it did while it ran.
 */
export function traceOf(raw: unknown): AiRunLine[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") return parseTrace(raw);
  if (!Array.isArray(raw)) return undefined;
  const lines: AiRunLine[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { stream, line, text } = item as { stream?: unknown; line?: unknown; text?: unknown };
    // Already-formatted entries (`text`) pass through; raw ones (`line`) are formatted here. The
    // formatter answers `null` for a line that renders as nothing, which must not take up a slot.
    const rendered = typeof text === "string" ? text : typeof line === "string" ? formatAgentLogLine(line) : null;
    if (rendered === null) continue;
    lines.push({ stream: stream === "stderr" ? "stderr" : "stdout", text: rendered });
  }
  return lines.length > 0 ? lines : undefined;
}

// ---------------------------------------------------------------------------
// the reveal
// ---------------------------------------------------------------------------

/**
 * How fast a finished answer is uncovered when the engine could not type it.
 *
 * Five of the six CLIs emit nothing between the question and the completed reply — see
 * `providerCapabilities`. Pasting six paragraphs into the transcript in one frame reads as a
 * glitch rather than as an answer, so the same text is revealed at roughly reading-aloud speed
 * instead. It is cosmetic, and it is the *only* cosmetic thing here: it never invents a word the
 * engine did not produce and never delays the persisted row, which is already on disk by the time
 * the first character appears.
 *
 * The rate is deliberately not adaptive. A long answer therefore takes a long time to uncover,
 * which is why {@link ConversationState.skipReveal} exists — the honest escape is letting the user
 * ask for all of it, not silently speeding up until the effect is meaningless.
 */
export const REVEAL_CHARS_PER_SECOND = 600;

/** One frame at ~30fps. Finer than this buys nothing a screen can show and costs a store write. */
const REVEAL_TICK_MS = 33;

/** How much of a `total`-character answer should be visible `elapsedMs` after the reveal began.
 *  Computed from the clock rather than from a running counter so a dropped frame (a background
 *  tab, a slow render) catches up instead of stretching the reveal. */
export function revealedLength(
  total: number,
  elapsedMs: number,
  charsPerSecond: number = REVEAL_CHARS_PER_SECOND,
): number {
  if (elapsedMs <= 0 || charsPerSecond <= 0) return 0;
  return Math.min(total, Math.floor((elapsedMs * charsPerSecond) / 1000));
}

export interface Typewriter {
  /** Stop without emitting anything further — the conversation went away under it. */
  cancel(): void;
  /** Jump to the end and emit the final frame. What "show me all of it" calls. */
  finish(): void;
}

/**
 * Uncovers `full` a frame at a time, calling `onFrame` with the visible prefix.
 *
 * `now` is injectable so the scheduler can be tested against a clock the test controls rather than
 * against whatever the machine was doing; nothing in the app passes it.
 */
export function startTypewriter(
  full: string,
  onFrame: (visible: string, done: boolean) => void,
  options?: { charsPerSecond?: number; tickMs?: number; now?: () => number },
): Typewriter {
  const charsPerSecond = options?.charsPerSecond ?? REVEAL_CHARS_PER_SECOND;
  const tickMs = options?.tickMs ?? REVEAL_TICK_MS;
  const now = options?.now ?? Date.now;
  // An empty answer has nothing to uncover, and scheduling a timer to discover that would leave the
  // message marked as revealing for a frame it never needed.
  if (full.length === 0) {
    onFrame("", true);
    return { cancel: () => {}, finish: () => {} };
  }
  const startedAt = now();
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    const visible = revealedLength(full.length, now() - startedAt, charsPerSecond);
    const done = visible >= full.length;
    if (done) stop();
    onFrame(full.slice(0, visible), done);
  }, tickMs);

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  return {
    cancel: stop,
    finish: () => {
      if (timer === null) return;
      stop();
      onFrame(full, true);
    },
  };
}

// ---------------------------------------------------------------------------
// the streaming buffers
// ---------------------------------------------------------------------------

/** The text being accumulated for each in-flight answer, keyed by message id.
 *
 * Keyed by *message* rather than by conversation because a conversation outlives its turns while
 * these do not: the buffers are born with an answer and die when it is complete, and keying them by
 * the thing with that lifetime is what makes "drop everything about this answer" a single delete. */
export interface StreamingBuffers {
  text: Record<string, string>;
  thinking: Record<string, string>;
}

const EMPTY_BUFFERS: StreamingBuffers = { text: {}, thinking: {} };

/** Writes an absolute value into one buffer, returning a new object. Both sources of streamed text
 *  end here — the live deltas by way of {@link reduceDelta}, the reveal by slicing — so there is
 *  exactly one place that decides what "the visible answer so far" is. */
function writeBuffer(
  buffers: StreamingBuffers,
  messageId: string,
  kind: "text" | "thinking",
  value: string,
): StreamingBuffers {
  if (kind === "thinking") {
    return { text: buffers.text, thinking: { ...buffers.thinking, [messageId]: value } };
  }
  return { text: { ...buffers.text, [messageId]: value }, thinking: buffers.thinking };
}

/**
 * Folds one `ai:chat-delta` chunk into the buffers.
 *
 * Append, never replace: the events carry fragments, and the backend makes no promise that a
 * fragment is a word, a line or valid UTF-8 on its own boundary — it is whatever the CLI flushed.
 * An empty chunk returns the same object so a stray event cannot re-render every subscriber.
 */
export function reduceDelta(buffers: StreamingBuffers, event: AiChatDeltaEvent): StreamingBuffers {
  if (event.text.length === 0) return buffers;
  const current =
    event.kind === "thinking" ? (buffers.thinking[event.messageId] ?? "") : (buffers.text[event.messageId] ?? "");
  return writeBuffer(buffers, event.messageId, event.kind, current + event.text);
}

/** Forgets everything about one answer. Called once the message object owns its final content. */
function dropBuffers(buffers: StreamingBuffers, messageId: string): StreamingBuffers {
  if (buffers.text[messageId] === undefined && buffers.thinking[messageId] === undefined) return buffers;
  const { [messageId]: _text, ...text } = buffers.text;
  const { [messageId]: _thinking, ...thinking } = buffers.thinking;
  return { text, thinking };
}

// ---------------------------------------------------------------------------
// the memory cap
// ---------------------------------------------------------------------------

/**
 * How many transcripts stay in memory.
 *
 * The number that matters most in this file. A trace is the bounded tail of a run's output — three
 * hundred lines — and a thirty-turn conversation carries thirty of them; a session spent reading
 * twenty past conversations would hold six hundred. That is how a store becomes the reason an app
 * feels heavy, and it happens silently because nothing on screen grows.
 *
 * Five is what the sidebar can plausibly be moved between without paying for a reload. Anything
 * collapsed is not lost: {@link ConversationState.open} reads it back from the `chat_messages` rows
 * exactly as it does one that was never opened this session.
 */
export const MAX_LIVE_CONVERSATIONS = 5;

/** What the cap needs to know about one live transcript to decide whether it can go. */
export interface EvictionCandidate {
  id: string;
  /** A turn is in flight. Its reply has nowhere to land if the session goes, and the panel is
   *  showing it right now. */
  sending: boolean;
  /** This is the conversation on screen. Collapsing it would blank the view under the user. */
  active: boolean;
  /** The backend has written rows for this conversation. Without them a re-read comes back empty,
   *  so an unpersisted conversation is one where memory is the *only* copy. */
  persisted: boolean;
  /** Holds a turn the backend does not write — a stopped one, or an answer still being revealed.
   *  Reading from disk would silently drop it. */
  holdsUnwritten: boolean;
}

/**
 * Which transcripts to collapse, oldest use first.
 *
 * `order` is least-recently-opened first and may name ids that are gone; anything not in it counts
 * as freshest and is simply never a candidate, which is the right default for a conversation that
 * has only ever been written to.
 */
export function pickEvictions(
  order: readonly string[],
  candidates: readonly EvictionCandidate[],
  keep: number = MAX_LIVE_CONVERSATIONS,
): string[] {
  if (candidates.length <= keep) return [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const gone: string[] = [];
  for (const id of order) {
    if (candidates.length - gone.length <= keep) break;
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (candidate.sending || candidate.active || !candidate.persisted || candidate.holdsUnwritten) continue;
    gone.push(id);
  }
  return gone;
}

/**
 * The question that produced the answer at `turn`, or `null` when there is none in this transcript.
 *
 * **The two halves of one exchange share a turn number.** That is not an accident to be worked
 * around — it is what makes "branch at turn N" expressible at all, and `chat_queries` says so at the
 * read that orders them: the tiebreak on `created_at` is what keeps the question above its answer
 * when both carry turn 3.
 *
 * Which makes the comparison here the whole of the function, and it is `<=`. It was `<`, and that
 * was wrong in both directions at once: on the first exchange there is no user message *before*
 * turn 0, so Regenerate found nothing and returned in silence — a button that did nothing at all on
 * the most common case there is. On every later exchange it found the previous exchange's question
 * and asked *that* again, which is worse than nothing, because it looks like it worked.
 *
 * Found by turn rather than by index because a transcript read back from disk and one grown in this
 * session number their messages the same way, and only the turn survives the reload.
 */
export function questionBehind(
  messages: readonly ConversationMessage[],
  turn: number,
): ConversationMessage | null {
  return messages
    .filter((m) => m.role === "user" && m.turn <= turn)
    .reduce<ConversationMessage | null>(
      (last, m) => (last === null || m.turn > last.turn ? m : last),
      null,
    );
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface ConversationSession {
  conversationId: string;
  /** `null` is the default and means the turn runs read-only in a scratch directory the app owns.
   *  Binding a repository is what grants write access, so this field is a permission as much as it
   *  is a filing decision. */
  projectId: string | null;
  /** The workspace this conversation belongs to, taken once when it was created or loaded and
   *  never re-derived. Every run this session raises is stamped with it — see `send`. */
  workspaceId: string;
  title: string;
  provider: string;
  model: string | null;
  /** How hard this conversation asks the model to think. `""` means no flag is sent, which leaves
   *  the CLI's own configuration in charge — a real state, not a missing one. */
  effort: string;
  /** The engine's resume token from the most recent turn; `null` starts a fresh engine session. */
  sessionId: string | null;
  messages: ConversationMessage[];
  /** Whether the transcript in `messages` came from disk. A row that only ever came from the
   *  sidebar list is a stub with no messages, and must not be mistaken for an empty conversation. */
  loaded: boolean;
  sending: boolean;
  runId: string | null;
  runStartedAt: number | null;
  /**
   * The answer being written right now, if any.
   *
   * It is deliberately **not** in `messages` while it is in flight. An answer that has not landed is
   * not a turn yet — it has no persisted row, no timestamp the backend agrees with, and nothing to
   * show if the run is stopped — so the transcript renders it from {@link ConversationState.streamingText}
   * under the last real turn, and it joins `messages` as one whole object when the run settles.
   *
   * The id starts as a locally minted placeholder because this window does not learn the backend's
   * id for the answer until the first delta carries it (or, for an engine that does not stream,
   * until `chat_send` resolves). It is swapped in place the moment either arrives.
   */
  pendingMessageId: string | null;
  /**
   * This window is *showing* a turn it did not start.
   *
   * The distinction decides who finishes the turn. A turn this window sent is completed by its own
   * `chatSend` promise, which carries the reply, the usage, the trace and the persisted row id. An
   * adopted one has no promise here at all — the window that owned it may since have been closed —
   * so `ai:done` is its only ending, and the transcript is re-read from disk instead.
   *
   * Without the flag both paths would fire for a turn this window started, and the re-read would
   * race the promise that is about to deliver strictly better data.
   */
  adopted: boolean;
  /** The answer currently being uncovered by the typewriter, if any. Distinct from `sending`: the
   *  run is over and the row is on disk, only the screen is behind. */
  revealingMessageId: string | null;
  persisted: boolean;
  updatedAt: number;
}

function newSession(conversation: ChatConversation): ConversationSession {
  return {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    workspaceId: conversation.workspaceId,
    title: conversation.title,
    provider: conversation.provider,
    effort: conversation.effort ?? "",
    model: conversation.model || null,
    sessionId: conversation.engineSessionId,
    messages: [],
    loaded: false,
    sending: false,
    adopted: false,
    runId: null,
    runStartedAt: null,
    pendingMessageId: null,
    revealingMessageId: null,
    persisted: true,
    updatedAt: new Date(conversation.updatedAt).getTime() || Date.now(),
  };
}

/** Stand-in for "nothing is selected" — a session the view can render without special-casing. */
const EMPTY_CONVERSATION: ConversationSession = {
  conversationId: "",
  projectId: null,
  workspaceId: "",
  title: "",
  provider: "",
  effort: "",
  model: null,
  sessionId: null,
  messages: [],
  loaded: false,
  sending: false,
  adopted: false,
  runId: null,
  runStartedAt: null,
  pendingMessageId: null,
  revealingMessageId: null,
  persisted: false,
  updatedAt: 0,
};

/** Conversation ids in the order they were last used, oldest first. Bookkeeping rather than state:
 *  nothing renders it, so keeping it in the store would re-render every subscriber on each open. */
let recent: string[] = [];

function touch(conversationId: string): void {
  recent = recent.filter((id) => id !== conversationId);
  recent.push(conversationId);
}

/** Live typewriters, keyed by the message they are uncovering. Not state for the same reason
 *  `recent` is not: a timer handle is not something a component reads. */
const revealers = new Map<string, Typewriter>();

function stopRevealer(messageId: string): void {
  revealers.get(messageId)?.cancel();
  revealers.delete(messageId);
}

/** The repository name the backend puts after its busy marker. */
function repoNameFromBusy(error: string): string {
  const at = error.indexOf(REPO_BUSY_MARKER);
  return at < 0 ? "" : error.slice(at + REPO_BUSY_MARKER.length).replace(/"$/, "").trim();
}

/** How much of the first question stands in for an untitled conversation. Matches the backend's own
 *  auto-title width so the sidebar row does not change length once the row is written. */
const LIVE_TITLE_MAX = 60;

function liveTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > LIVE_TITLE_MAX ? `${oneLine.slice(0, LIVE_TITLE_MAX)}…` : oneLine;
}

function toMessage(row: ChatMessageRow): ConversationMessage {
  return {
    ...row,
    isError: !!row.isError,
    isCancelled: !!row.isCancelled,
    trace: traceOf(row.trace),
    outputs: pathsOf(row.outputs),
  };
}

interface ConversationState {
  /** The flat, global sidebar list — pinned first, then by recency. Not filtered by workspace: the
   *  workspace is stored for backup grouping and for the run stamp, but a chat list that hides
   *  yesterday's conversation because the user switched workspace is a list nobody trusts. */
  conversations: ChatConversation[];
  /** Transcripts held in memory, capped at {@link MAX_LIVE_CONVERSATIONS}. */
  byConversation: Record<string, ConversationSession>;
  activeId: string | null;
  /** The answer text accumulated for each in-flight message, whether it arrived as deltas or is
   *  being uncovered by the typewriter. The message object carries the same text — this is the
   *  accumulator the message is rebuilt from, so the two can never disagree. */
  streamingText: Record<string, string>;
  /** The reasoning accumulated for each in-flight message, for the collapsible block. */
  streamingThinking: Record<string, string>;
  listing: boolean;

  /** Subscribes to `ai:chat-delta` and `ai:done`, and adopts whatever turns the process is already
   *  running. Idempotent — safe to call from an effect. */
  init: () => void;
  /**
   * Rebuilds this window's view of every turn the process has in flight.
   *
   * The reason this exists rather than trusting the local store: a run belongs to the Rust process,
   * not to a webview. Detaching the chat into a satellite gives that window a store which never
   * heard of the question, and re-attaching gives the main window one whose session may have been
   * evicted — in both cases the engine is still working and the UI showed nothing. Called on init
   * and whenever a conversation is opened, so a window that appeared mid-turn catches up instead of
   * assuming it started everything it is showing.
   */
  adoptInflight: () => Promise<void>;
  loadConversations: (includeArchived?: boolean) => Promise<void>;
  /** Creates a conversation and selects it. `projectId` `null` is the ordinary case and is what
   *  makes the conversation read-only. */
  create: (projectId: string | null, provider: string, model: string) => Promise<string | null>;
  /** Selects a conversation, reading its transcript back from disk unless memory is the only copy
   *  of it. Also what drives the memory cap. */
  open: (conversationId: string) => Promise<void>;
  /** Detaches from whatever is selected. A turn still running keeps running. */
  deselect: () => void;
  /** Fire-and-forget: the reply lands in its own conversation whenever it arrives, so it is neither
   *  lost nor misfiled if the user has moved on. Several conversations may be in flight at once;
   *  only a second turn *within one conversation* is refused, since its engine session can only be
   *  resumed once at a time. */
  send: (conversationId: string, message: string, over?: { provider?: string; model?: string }) => void;
  /**
   * Asks the question behind the answer at `turn` again, in the selected conversation.
   *
   * **Not a rewind, and the UI must not imply one.** No CLI here can unsay a turn: the engine
   * session already contains the answer being regenerated, so what this does is ask the same
   * question a second time with that answer in context. The old exchange stays in the transcript
   * and on disk, because it happened. Cheap to store, a full turn to run — which is what the cost
   * chip on the button is for.
   */
  regenerate: (turn: number) => void;
  stop: (conversationId: string) => void;
  /** Uncovers the rest of a revealing answer at once. */
  skipReveal: (conversationId: string) => void;
  rename: (conversationId: string, title: string) => Promise<void>;
  /** Re-points this conversation at an engine. Switching provider mid-thread is a context
   *  transplant, not a resume: the transcript survives because it is this app's rows, but the
   *  engine's own memory of it does not, and the next turn re-sends what it needs. */
  setEngine: (conversationId: string, provider: string, model: string) => Promise<void>;
  /** How hard the model thinks, for every future turn of this conversation. `""` clears it and
   *  hands the decision back to whatever the CLI itself is configured with. */
  setEffort: (conversationId: string, effort: string) => Promise<void>;
  /**
   * The compression style every future answer in this conversation comes back in.
   *
   * `""` turns it off. Free and immediate: the style rides on each turn's message, so unlike a
   * provider change there is no session to lose and no transcript to replay.
   */
  setCaveman: (conversationId: string, level: string) => Promise<void>;
  /** The levels this build knows, in picker order. Empty until `init` has answered — the picker
   *  draws nothing rather than a list it invented. */
  cavemanLevels: string[];
  /**
   * The style the *next* conversation will be created with, for the same reason `pendingEffort`
   * exists: `/caveman` on the empty state has no row to write to, and a command that silently does
   * nothing is worse than one that is absent.
   */
  pendingCaveman: string;
  setPendingCaveman: (level: string) => void;
  /**
   * Applies `/caveman <argument>` to a conversation, or holds it for the next one when none is
   * open. Resolves the word through the backend first — see {@link chatCavemanResolve} — and
   * answers `false` when it is not a level, so the caller can say which words are.
   */
  applyCaveman: (conversationId: string | null, argument: string) => Promise<boolean>;
  /** Provider ids that accept a level at all, loaded once. Empty until `init` has answered. */
  effortProviders: string[];
  /**
   * Whether the *model* a `(provider, model)` pair names can use a level, keyed by
   * {@link effortKey}. Missing means "not asked yet", and every reader treats that as yes.
   *
   * Permissive on purpose. The engine half of the gate is synchronous, so a CLI with no flag at
   * all never draws the control for a frame; this half arrives a tick later, and defaulting it to
   * no would make the dial blink out of existence on every engine switch — for the ordinary case,
   * where the model does reason.
   */
  effortByModel: Record<string, boolean>;
  /** Asks the backend about one pair, once. Fire-and-forget: the answer lands in
   *  {@link ChatState.effortByModel} and re-renders whoever is reading it. */
  ensureEffortSupport: (provider: string, model: string) => void;
  /**
   * This model's context window in tokens, or `null` where the app will not name one. Missing means
   * "not asked yet", which every reader draws as no bar at all rather than as a guess.
   *
   * Asked of the backend rather than held in a table beside the meter, because the backend decides
   * with the same number: `auto_compact_if_full` compares the last turn's occupancy against it. Two
   * tables would let the ring read 92% while the turn that follows it thinks there is room.
   */
  windowByModel: Record<string, number | null>;
  /** Asks the backend about one model, once. Fire-and-forget, like {@link ensureEffortSupport}. */
  ensureContextWindow: (model: string) => void;
  /**
   * The reasoning level the *next* conversation will be created with.
   *
   * Exists because the level has to be choosable before there is anything to store it on. A new
   * chat has no row until its first message creates one, so the picker on the empty state had
   * nowhere to write and was simply absent — which made the control look like something that only
   * appears once you have already sent a message at the default level, i.e. exactly too late to be
   * useful. Provider and model solve the same problem by falling back to the workspace routing;
   * this is that fallback for effort, held here rather than in settings because it is a property
   * of the question being asked, not a preference.
   */
  pendingEffort: string;
  setPendingEffort: (effort: string) => void;

  // ---- folders ----
  /** The sidebar's folders, in their stored order. */
  groups: ChatGroup[];
  loadGroups: () => Promise<void>;
  createGroup: (name: string, color: string) => Promise<ChatGroup | null>;
  renameGroup: (groupId: string, name: string, color: string) => Promise<void>;
  /** Pins a folder above the rest, or unpins it. */
  setGroupPinned: (groupId: string, pinned: boolean) => Promise<void>;
  /** Puts a folder on the shelf, or takes it back. Nothing inside it moves — the list is what
   *  hides, so restoring brings the folder back with its conversations still filed. */
  setGroupArchived: (groupId: string, archived: boolean) => Promise<void>;
  /** Removes the folder and returns its conversations to the ungrouped list. Never deletes a chat. */
  deleteGroup: (groupId: string) => Promise<void>;
  toggleGroup: (groupId: string) => Promise<void>;
  reorderGroups: (ids: string[]) => Promise<void>;
  /** Files a conversation, or returns it to the ungrouped list with `null`. */
  setConversationGroup: (conversationId: string, groupId: string | null) => Promise<void>;
  /** The project whose page is open, or `null`. Selecting a conversation clears it and vice versa:
   *  the main pane shows one or the other, never both. */
  activeGroupId: string | null;
  openGroup: (groupId: string | null) => Promise<void>;
  setGroupInstructions: (groupId: string, instructions: string) => Promise<void>;
  /** A project's shared reference documents, keyed by project. */
  groupContext: Record<string, ChatAttachment[]>;
  loadGroupContext: (groupId: string) => Promise<void>;
  attachGroupContext: (groupId: string, sourcePath: string) => Promise<void>;
  removeGroupContext: (groupId: string, attachmentId: string) => Promise<void>;

  // ---- attachments ----
  /** Files staged for the *next* turn, per conversation. They are already on disk — the composer
   *  copies them in as they are picked — so this is a view of that folder, not a pending upload. */
  attachments: Record<string, ChatAttachment[]>;
  loadAttachments: (conversationId: string) => Promise<void>;
  /**
   * Files the *turns* produced, per conversation — the other direction from `attachments`.
   *
   * Not persisted anywhere: the conversation's working directory is the record, and this is a
   * listing of it. Which is why it is re-read rather than appended to — a turn can overwrite a file
   * it wrote before, and a store that only ever grew would show two chips for one spreadsheet.
   */
  outputs: Record<string, ChatOutput[]>;
  loadOutputs: (conversationId: string) => Promise<void>;
  addAttachment: (conversationId: string, file: ChatAttachment) => void;
  removeAttachment: (conversationId: string, attachmentId: string) => Promise<void>;
  setPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  setArchived: (conversationId: string, archived: boolean) => Promise<void>;
  remove: (conversationId: string) => Promise<void>;
  branch: (conversationId: string, atTurn: number) => Promise<string | null>;

  // ---- compaction ----
  /**
   * The run id of the compaction in flight on each conversation, while one is.
   *
   * Keyed by conversation rather than held as a single flag for the same reason `sending` is on the
   * session and not on the store: two conversations may be busy at once, and a window showing one
   * of them must not draw the other's spinner. Absent means nothing is compacting, which is almost
   * always.
   */
  compacting: Record<string, string>;
  /**
   * Replaces the earlier turns of a conversation with a summary the model writes of them.
   *
   * **A real turn.** It costs what a turn costs, it shows up in the status bar and can be stopped
   * from there, and it can fail. Nothing is deleted: the transcript is untouched and
   * {@link uncompact} puts the full replay back — what changes is what the *next* turn is sent.
   *
   * `guidance` is whatever the user typed after `/compact`, steering what the summary keeps —
   * "quédate con los nombres de archivo", "olvida lo de los tests". It is added to the standing
   * instructions rather than replacing them, so a steer cannot accidentally turn the summary into
   * something unusable as context.
   */
  compact: (conversationId: string, guidance?: string) => Promise<void>;
  /** Throws the summary away, so the whole transcript is replayed again. Instant and free. */
  uncompact: (conversationId: string) => Promise<void>;

  search: (query: string, limit?: number) => Promise<ChatSearchHit[]>;
  sessionFor: (conversationId: string | null) => ConversationSession;
}

let subscribed = false;
const offs: (() => void)[] = [];

/**
 * Re-reads the conversation list after a turn, clearing the unread mark on the one being watched.
 *
 * The backend marks *every* finished turn unread, because it cannot know which window — or which
 * conversation — the user is looking at: a turn started in the quick-ask box lands in a thread the
 * main sidebar is also drawing. The window that *is* showing the conversation clears it here, in
 * the same pass that re-reads the list, so the dot never appears on the row the user is reading.
 *
 * Fire-and-forget on the write, like `open`: a mark that failed to clear costs one stale dot until
 * the next open, which is not worth failing a delivered answer over.
 */
function reloadAfterTurn(conversationId: string) {
  const store = useConversationStore.getState();
  const watched = store.activeId === conversationId;
  if (watched) void chatSetUnread(conversationId, false).catch(() => {});
  void store.loadConversations().then(() => {
    if (!watched) return;
    useConversationStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, unread: false } : c,
      ),
    }));
  });
}

/**
 * The cache key for one `(provider, model)` pair.
 *
 * `\u0000` as the separator because a model id can contain anything a provider serves — opencode
 * and cline address theirs as `provider/model`, so `/`, `:` and `-` are all spoken for — and a
 * separator that collided would make two different pairs share one answer.
 */
export function effortKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/** Pairs with a probe in flight, so two composers asking at once cost one call. Module-level
 *  rather than store state: it is bookkeeping about requests, and nothing renders from it. */
const asking = new Set<string>();

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  byConversation: {},
  activeId: null,
  streamingText: {},
  streamingThinking: {},
  listing: false,
  effortProviders: [],
  effortByModel: {},
  pendingEffort: "",
  cavemanLevels: [],
  pendingCaveman: "",
  groups: [],
  activeGroupId: null,
  groupContext: {},
  attachments: {},
  outputs: {},

  init: () => {
    if (subscribed) return;
    // Set before the listener resolves so a second call in the same tick — React StrictMode mounts
    // effects twice — cannot register a duplicate subscription.
    subscribed = true;
    void onAiChatDelta((event) => {
      applyStream(event);
    }).then((off) => {
      offs.push(off);
    });

    /**
     * A run ended somewhere in the process.
     *
     * Only ever acts on a turn this window **adopted** — one it is showing but did not start. A
     * turn this window sent has a `chatSend` promise that is about to resolve with the reply, the
     * usage, the trace and the persisted id, and doing the work twice would race that: the promise
     * is strictly better informed than this event, which carries a run id and nothing else.
     *
     * For an adopted turn there is no promise anywhere — the window that owned it may have been
     * closed — so this is the only signal that the answer has landed, and the transcript is re-read
     * from disk, which is where the backend already wrote it.
     */
    void onAiDone(({ run_id }) => {
      const entry = Object.entries(get().byConversation).find(
        ([, session]) => session.runId === run_id && session.adopted,
      );
      if (!entry) return;
      const [conversationId, adoptedSession] = entry;
      // Read before the `set` below clears it. Reading it afterwards is the same capture-before-the-
      // write mistake this store warns about elsewhere: the id would already be null and the
      // streaming buffers for this turn would leak for the life of the window.
      const streamedInto = adoptedSession.pendingMessageId;
      set((s) => {
        const session = s.byConversation[conversationId];
        if (!session) return s;
        return {
          byConversation: {
            ...s.byConversation,
            [conversationId]: {
              ...session,
              sending: false,
              adopted: false,
              runId: null,
              runStartedAt: null,
              pendingMessageId: null,
              loaded: false,
            },
          },
        };
      });
      if (streamedInto) clearBuffers(streamedInto);
      // Re-read rather than patch: the row, its trace, its usage and its timing were all written by
      // the backend, and this window never saw any of them.
      void get().open(conversationId);
      void get().loadConversations();
    }).then((off) => {
      offs.push(off);
    });

    /**
     * A conversation changed somewhere that is not this window.
     *
     * The gap this closes is the ask box's, and it is the one the whole quick-ask feature was
     * falling into: a question asked there writes a real row, and the window holding the chat
     * workspace listed its conversations *before* that row existed. Nothing told it. Press the
     * chord, ask, dismiss the box — and the thread was simply not in the sidebar, with the app
     * sitting open on the chat tab the whole time.
     *
     * "Open in CodeFlow" is not the answer to this, and that is the point worth being clear about:
     * that button is an addressed request to *show* one conversation (see `lib/chatBridge`), and
     * the common gesture is not to press it. The box is dismissed with Escape or its ✕, which hide
     * the window without changing anything the rest of the app can observe — no satellite is
     * created or destroyed, so even the window-list signal `ChatView` wakes on never fires.
     *
     * `state:invalidate` is the right carrier and already exists: `send` raises it at the end of
     * every turn, the Rust side emits it to *every* window, and `windowBus`'s own note says that
     * anything which could be a row should travel this way rather than as a bus message. A
     * conversation is a row.
     *
     * **The sender hears its own frame**, because the emit is a broadcast with no window label on
     * it. That is harmless and deliberately not filtered: the list reload is idempotent, and the
     * transcript re-read is guarded on exactly the two states where memory is the only copy — a
     * turn in flight, and an answer still being uncovered by the typewriter.
     */
    void onStateInvalidate((event) => {
      if (event.domain !== "chat") return;
      // The list first and always: the row may be new, or may just have moved to the top.
      void get().loadConversations(true);
      const id = event.conversation;
      // Only the conversation on screen here, and only when this window is not the one writing it.
      if (!id || get().activeId !== id) return;
      // The files first and unconditionally: a turn that produced a spreadsheet changed the
      // directory whether or not this window is the one showing the conversation.
      void get().loadOutputs(id);
      const session = get().byConversation[id];
      if (session?.sending || session?.revealingMessageId) return;
      void get().open(id);
    }).then((off) => {
      offs.push(off);
    });

    void get().adoptInflight();
    // Which engines accept a level at all, asked once. The composer hides the control for the rest
    // rather than drawing a dial that turns nothing — the same rule the capability matrix follows.
    // Folders, and the orphan sweep, once per app session. The sweep is deliberately here rather
    // than in the Rust startup path: it needs the conversation list to know what is an orphan, and
    // running it from the one place that already owns that list keeps the two from disagreeing.
    void get().loadGroups();
    void chatSweepAttachments();
    void chatEffortSupport().then(
      (effortProviders) => set({ effortProviders }),
      // A failed probe leaves the list empty, which hides the control everywhere. That is the safe
      // direction: an absent control is a smaller lie than one whose setting is silently dropped.
      () => {},
    );
    // Same shape, same reason: the picker offers what this build's backend actually accepts, and an
    // empty list means it offers nothing rather than a list the frontend made up.
    void chatCavemanLevels().then(
      (cavemanLevels) => set({ cavemanLevels }),
      () => {},
    );
  },

  adoptInflight: async () => {
    let turns;
    try {
      turns = await chatInflightTurns();
    } catch {
      // A probe that failed leaves the window exactly as it was. Showing a conversation as idle
      // when it might be busy is the safe direction: the turn is still running in the process, and
      // the next open — or the `ai:done` that ends it — brings this window back in line.
      return;
    }
    const running = new Set(turns.map((t) => t.conversationId));
    set((s) => {
      const byConversation = { ...s.byConversation };
      // A session this window believes is in flight, against a turn the process is not running.
      //
      // The honest cause is a lost promise: the turn was sent from a window that has since been
      // closed — a satellite the user re-attached — so nothing anywhere is waiting to finish it and
      // the spinner would have spun until restart. The transcript is on disk either way, because
      // the backend writes it before returning, so the recovery is to drop the flags and re-read.
      for (const [id, session] of Object.entries(byConversation)) {
        if (!session.sending || running.has(id)) continue;
        byConversation[id] = {
          ...session,
          sending: false,
          adopted: false,
          runId: null,
          runStartedAt: null,
          pendingMessageId: null,
          loaded: false,
        };
      }
      for (const turn of turns) {
        const session = byConversation[turn.conversationId];
        // Already sending here means this window started it and owns the promise. Adopting it would
        // hand the ending to `ai:done` as well, and the two would race.
        if (session?.sending) continue;
        // A window that has never listed this conversation still has to be able to show its run.
        // The row from the sidebar list when there is one; otherwise `open` will fill in the rest
        // the moment the user goes there, and until then the spinner is the honest minimum.
        const row = s.conversations.find((c) => c.id === turn.conversationId);
        const base = session ?? (row ? newSession(row) : { ...EMPTY_CONVERSATION, conversationId: turn.conversationId });
        byConversation[turn.conversationId] = {
          ...base,
          provider: turn.provider,
          sending: true,
          adopted: true,
          runId: turn.runId,
          // The turn's own start, not this window's: an elapsed timer that restarted every time a
          // window opened would say a two-minute run had been going for four seconds.
          runStartedAt: turn.startedAtMs,
          pendingMessageId: turn.messageId,
        };
      }
      return { byConversation };
    });

    // The run log and the Stop button are the generic run machinery's, and it is keyed by run id in
    // its own store — which, like this one, only knows about runs its window started.
    for (const turn of turns) {
      const known = get().conversations.find((c) => c.id === turn.conversationId);
      useAiRunStore.getState().adopt(turn.runId, {
        kindKey: "agents.liveKindChat",
        // The conversation's title, because the question it was asked is not in this window: only
        // the window that sent it ever held that text. An untitled thread falls back to its id,
        // which is at least addressable.
        detail: known?.title || turn.conversationId,
        target: { view: "chat", select: { kind: "chatAppConversation", id: turn.conversationId } },
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      });
    }
  },

  loadConversations: async (includeArchived) => {
    set({ listing: true });
    try {
      const conversations = await chatListConversations(includeArchived);
      set({ conversations });
    } finally {
      set({ listing: false });
    }
  },

  create: async (projectId, provider, model) => {
    // Captured before the await for the same reason a run's stamp is: this is the workspace the
    // conversation belongs to, and by the time the row comes back the user may be standing in a
    // different one. A repository-bound chat takes its repository's workspace; an unbound one takes
    // whatever is active, which is the only workspace it can honestly be said to belong to.
    const workspaceId =
      (projectId ? useWorkspaceStore.getState().workspaceOfProject(projectId) : null) ??
      useWorkspaceStore.getState().activeWorkspaceId;
    if (!workspaceId) return null;
    const created = await chatCreateConversation(workspaceId, projectId, provider, model);
    // Applied before the row reaches the store, so the first turn — which `ChatView` sends as soon
    // as this resolves — already runs at the level the user picked. Writing it afterwards would
    // make the opening message the one turn in the thread that ignored the control.
    const pending = get().pendingEffort;
    let conversation = created;
    if (pending) {
      try {
        await chatSetEffort(created.id, pending);
        conversation = { ...created, effort: pending };
      } catch {
        // A level that failed to stick is not a reason to lose the conversation the user is in the
        // middle of starting. It runs at the CLI's own default and the picker still shows the row's
        // real value, which is now the honest one.
      }
    }
    // The same dance for the answer style, and for the same reason: `/caveman` typed on the empty
    // state has no row to write to, so it is held here and applied to the row the first message
    // creates — otherwise the one turn that ignored the command would be the opening one.
    const pendingStyle = get().pendingCaveman;
    if (pendingStyle) {
      try {
        await chatSetCaveman(created.id, pendingStyle);
        conversation = { ...conversation, cavemanLevel: pendingStyle };
      } catch {
        // Same trade as above: a style that failed to stick costs a verbose first answer, not a
        // conversation.
      }
    }
    touch(conversation.id);
    set((s) => ({
      conversations: [conversation, ...s.conversations.filter((c) => c.id !== conversation.id)],
      byConversation: {
        ...s.byConversation,
        // A conversation created here is empty *and* loaded: there is nothing on disk to read, and
        // marking it unloaded would send `open` to fetch a transcript that cannot exist yet.
        [conversation.id]: { ...newSession(conversation), loaded: true, persisted: true },
      },
      activeId: conversation.id,
    }));
    prune();
    return conversation.id;
  },

  open: async (conversationId) => {
    // Opening a conversation closes any project page. The pane shows one or the other, and leaving
    // both set would make "go back to the project" depend on which one the view checked first.
    if (get().activeGroupId) set({ activeGroupId: null });
    // Catch up before deciding what to draw. A satellite that was opened after the question was
    // asked reaches this with a store that has never heard of the run, and without the probe it
    // would read the transcript from disk — where the answer is not yet — and render an idle
    // conversation while the engine is working.
    void get().adoptInflight();
    // Opening *is* reading. Cleared locally first so the dot goes out on the click rather than a
    // round trip later, and the write is fire-and-forget: a mark that failed to clear costs one
    // stale dot until the next open, which is not worth blocking the view on.
    if (get().conversations.some((c) => c.id === conversationId && c.unread)) {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId ? { ...c, unread: false } : c,
        ),
      }));
      void chatSetUnread(conversationId, false).catch(() => {});
    }
    touch(conversationId);
    // What earlier turns left behind, refreshed on every open: the directory can have changed
    // since this window last looked — another window's turn, or the user deleting a file by hand.
    void get().loadOutputs(conversationId);
    const cached = get().byConversation[conversationId];
    // The three cases where memory is the only copy, and pointing at it is the whole of the work.
    //
    // `sending`: the turn is in flight, so disk does not have it and a re-read would replace a live
    // transcript — run id, stop button and all — with the state it had before the question.
    // `revealingMessageId`: the same, one step later; the row exists but the visible text is being
    // uncovered from memory and a reload would jump to the end or blank it.
    // `!persisted`: nothing was ever written (a first turn that was stopped), so the read would come
    // back empty and blank a conversation the user can still see.
    if (cached && (cached.sending || cached.revealingMessageId !== null || !cached.persisted)) {
      set({ activeId: conversationId });
      prune();
      return;
    }

    /**
     * A conversation this window's list has never heard of.
     *
     * The list is loaded once per window and then kept current by whoever changes it *here*, which
     * is the whole of the assumption and it is not true: a conversation can be created in another
     * webview entirely. The ask box is the ordinary case — it writes a real row and then hands the
     * id over — and a notification followed from the status bar is the other one.
     *
     * Without the row there is nothing to build a session onto: the `set` below finds no `meta`,
     * gives up on `base`, and leaves `activeId` pointing at a conversation the view draws as empty.
     * So the list is re-read first, which also puts the conversation in the sidebar it is about to
     * be selected in. Guarded on not having it, so the ordinary click — the row came *from* the
     * sidebar — pays nothing.
     */
    if (!cached && !get().conversations.some((c) => c.id === conversationId)) {
      // Archived included, the same as `ChatView`'s own load: a conversation that has been archived
      // is still one this can be asked to open, and listing without it would leave us exactly where
      // we started.
      await get().loadConversations(true).catch(() => {});
    }

    // Everything else is re-read, *including* transcripts this store already holds. Not an early
    // return: a second device can add a turn to the same conversation, and a cache that is only
    // refreshed on eviction means "close it and open it again" would not surface it. The read is one
    // indexed query against the conversation the user just asked to see, and it deliberately does
    // **not** ask for traces — see `chatGetConversation`.
    const rows = await chatGetConversation(conversationId, false).catch(() => null);
    set((s) => {
      // Re-checked after the await: a turn could have been started here while the read was in
      // flight, and the freshly loaded copy would clobber the optimistic bubble.
      const live = s.byConversation[conversationId];
      if (live?.sending || live?.revealingMessageId) return { activeId: conversationId };
      const meta = s.conversations.find((c) => c.id === conversationId);
      const base = live ?? (meta ? newSession(meta) : undefined);
      if (!base || !rows) return { activeId: conversationId };
      const messages = rows.map(toMessage);
      return {
        activeId: conversationId,
        byConversation: {
          ...s.byConversation,
          [conversationId]: {
            ...base,
            messages,
            loaded: true,
            // The *last* turn's session is the one to resume — earlier ones are stale, since a CLI
            // may hand out a new token per turn.
            sessionId: meta?.engineSessionId ?? base.sessionId,
            model: rows.reduce<string | null>((last, r) => r.model ?? last, base.model),
            persisted: true,
          },
        },
      };
    });
    prune();
  },

  deselect: () => set({ activeId: null }),

  send: (conversationId, message, over) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const session = get().byConversation[conversationId];
    if (!session) return;
    // Only this conversation's own turn blocks. N other conversations answering at the same time is
    // precisely what a chat workspace has to allow, and what the per-conversation lease on the Rust
    // side exists to make safe.
    if (session.sending) return;

    touch(conversationId);
    const provider = over?.provider ?? session.provider;
    const model = over?.model ?? session.model ?? "";
    const runId = newRunId("chat");
    // **Captured before the first await, and never read back afterwards.** This store is built
    // around an answer arriving while the user is standing somewhere else, so by the time the reply
    // lands "which workspace is in front" is a different question with a different answer. Every
    // stamp this turn raises — the status-bar row, both notifications — uses this one value.
    const workspaceId = session.workspaceId;
    const projectId = session.projectId;
    const title = session.title || liveTitle(trimmed);

    useAiRunStore.getState().start(runId, {
      kindKey: "agents.liveKindChat",
      // The question, not the conversation: a brand-new chat has no title yet to name it by.
      detail: trimmed,
      // `chatAppConversation`, not `chatConversation`: the latter addresses the assistant panel's
      // chat, which is keyed by project and lives in `chatStore`. Following this row from the status
      // bar has to land in *this* workspace.
      target: { view: "chat", select: { kind: "chatAppConversation", id: conversationId } },
      workspaceId,
    });

    const now = Date.now();
    const lastTurn = session.messages.length > 0 ? session.messages[session.messages.length - 1].turn : -1;
    // Locally minted, and replaced by the persisted ids the moment the backend names them. The
    // answer's placeholder is what the first delta is matched against — the backend's own id for it
    // only reaches this window with that first chunk, or with the reply if nothing streams.
    const pendingUserId = `pending-user-${crypto.randomUUID()}`;
    const pendingAnswerId = `pending-answer-${crypto.randomUUID()}`;
    const askedAt = new Date().toISOString();
    const question: ConversationMessage = {
      id: pendingUserId,
      conversationId,
      role: "user",
      content: trimmed,
      turn: lastTurn + 1,
      // Stamped client-side: the turn is not persisted until the reply lands, and the question was
      // asked now rather than whenever the engine finishes answering it.
      createdAt: askedAt,
      isError: false,
      isCancelled: false,
    };

    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: {
          ...s.byConversation[conversationId],
          messages: [...s.byConversation[conversationId].messages, question],
          title,
          provider,
          sending: true,
          runId,
          runStartedAt: now,
          pendingMessageId: pendingAnswerId,
          updatedAt: now,
        },
      },
      // Seeded empty so the view can tell "answering, nothing yet" from "not answering at all".
      streamingText: { ...s.streamingText, [pendingAnswerId]: "" },
    }));

    /** Writes the outcome into *this* conversation, wherever the user happens to be looking. The
     *  active pointer is never touched — moving the view out from under someone because a background
     *  answer arrived is the bug this store is shaped to avoid. */
    const settle = (patch: (session: ConversationSession) => ConversationSession) => {
      set((s) => {
        const current = s.byConversation[conversationId];
        // Gone means the conversation was deleted while it ran; there is nothing to file under.
        if (!current) return s;
        return { byConversation: { ...s.byConversation, [conversationId]: patch(current) } };
      });
    };

    // Always asked for. The backend honours it only where the engine can actually produce deltas and
    // ignores it everywhere else, so the check here is about what the *frontend* then does with the
    // answer — reveal it, or leave it alone because it already arrived a word at a time.
    const streams = providerCapabilities(provider).streamsTokens;

    // Captured before the await, like the workspace stamp beside it: the user is free to remove a
    // chip while the turn is in flight, and the turn must be sent with what was staged when they
    // pressed send — not with whatever the list happens to hold when the promise is constructed.
    const staged = (get().attachments[conversationId] ?? []).map((a) => a.id);
    // Cleared here, before the turn even starts, and the *files are not deleted*. The distinction
    // is the whole design: the chips belong to the message that is being sent, so leaving them up
    // would make every later turn re-announce "files attached to this message" about a screenshot
    // from five turns ago. The copies themselves live as long as the conversation, because a
    // follow-up question can make the model read one again — see `commands::chat_attach`.
    if (staged.length > 0) {
      set((s) => ({ attachments: { ...s.attachments, [conversationId]: [] } }));
    }
    void chatSend(conversationId, trimmed, runId, over?.provider ?? null, over?.model ?? null, true, staged)
      .then((reply) => {
        const trace = snapshotTrace(runId);
        const messageId = reply.message_id;
        // Read before the adoption below, and under either key: a turn that streamed adopted the
        // backend's id on its first chunk, one that did not is still filed under the placeholder.
        const streamed = get().streamingText[messageId] ?? get().streamingText[pendingAnswerId] ?? "";
        // What the capability matrix promises is not quite the question. What matters here is
        // whether text *actually* arrived: an engine that claims to type but produced no deltas
        // (the flag says Claude, the run says otherwise) would otherwise leave the answer blank,
        // and revealing it is the strictly safer of the two failures.
        const typed = streams && streamed.length > 0;
        // The backend's id replaces the placeholder in both the buffers and the message, so
        // everything downstream of here talks about the row that actually exists.
        adoptMessageId(conversationId, pendingAnswerId, messageId);

        // The answer joins the transcript as one whole object, which is what every other turn in
        // the list already is. A provider that typed brings its text with it; anything else starts
        // blank and is uncovered below. Either way `reply.text` is authoritative and the
        // accumulated deltas are dropped in favour of it — a lost chunk must not be allowed to
        // become a permanently truncated answer.
        const answer: ConversationMessage = {
          id: messageId,
          conversationId,
          role: "assistant",
          content: typed ? reply.text : "",
          turn: lastTurn + 2,
          createdAt: reply.created_at,
          provider: reply.provider,
          model: reply.model ?? undefined,
          engineVersion: reply.engine_version ?? undefined,
          responseTimeMs: reply.response_time_ms,
          isError: false,
          isCancelled: false,
          thinking: get().streamingThinking[messageId] || undefined,
          // Straight from the reply rather than from a re-read: on a provider whose answer is
          // uncovered by the typewriter, `open` declines to re-read while the reveal is running,
          // so waiting for one would leave the chips missing for as long as the reveal lasts.
          outputs: reply.outputs.length > 0 ? reply.outputs : undefined,
          // A copy of the live log, never the store's own array — see `snapshotTrace`.
          trace: trace.length > 0 ? trace : undefined,
        };

        settle((current) => ({
          ...current,
          messages: [
            ...current.messages.map((m) => (m.id === pendingUserId ? { ...m, createdAt: reply.created_at } : m)),
            answer,
          ],
          sessionId: reply.session_id,
          model: reply.model ?? current.model,
          sending: false,
          runId: null,
          runStartedAt: null,
          pendingMessageId: null,
          revealingMessageId: typed ? null : messageId,
          updatedAt: Date.now(),
          persisted: true,
        }));

        if (typed) {
          clearBuffers(messageId);
        } else {
          beginReveal(conversationId, messageId, reply.text);
        }

        // Said once, after the answer rather than before it: the user asked a question and got
        // one, and the housekeeping that happened on the way is a footnote to that, not an event of
        // its own. The durable record is the mark in the transcript.
        if (reply.compacted) pushSuccessToast(translate("chat.compactedAuto"));

        reloadAfterTurn(conversationId);
        // The turn is persisted by the time this resolves, so a phone can go and read it. Nothing
        // about a chat turn moves a byte on disk, and the delta stream is deliberately not forwarded
        // to a phone — so this emit is the only thing that tells one the transcript grew.
        notifyStateChange("chat", projectId, conversationId);
        notify({
          source: "chatApp",
          titleKey: "notifications.chatDone",
          target: {
            view: "chat",
            projectId: projectId ?? undefined,
            select: { kind: "chatAppConversation", id: conversationId },
          },
          // The workspace stamped when the question was asked, not whichever one is in front when
          // the answer lands.
          workspaceId,
          status: "success",
          detail: title,
        });
      })
      .catch((e) => {
        // Whichever id the answer is filed under by now: a turn that streamed before it failed
        // adopted the backend's id on its first chunk, and clearing the stale placeholder would
        // leave the accumulated fragments in the buffers for the rest of the session.
        clearBuffers(get().byConversation[conversationId]?.pendingMessageId ?? pendingAnswerId);
        // Another run already owns this repository's working copy, so the turn never reached an
        // engine: nothing was recorded, nothing was edited. Filing it as a red failure bubble would
        // be a lie about something that did not happen, so the question is taken back out and the
        // reason is said once, in passing. Only reachable for a repository-bound conversation —
        // an unbound one takes a lease on itself, which its own `sending` guard already holds.
        if (isRepoBusy(e)) {
          settle((current) => ({
            ...current,
            messages: current.messages.filter((m) => m.id !== pendingUserId),
            sending: false,
            runId: null,
            runStartedAt: null,
            pendingMessageId: null,
            updatedAt: Date.now(),
          }));
          pushErrorToast(translate("agents.busyInRepo", { name: repoNameFromBusy(String(e)) }));
          return;
        }
        const cancelled = isCancellation(e);
        const trace = snapshotTrace(runId);
        // The failure joins the transcript rather than sitting in a banner the next message would
        // wipe. The raw text is kept so the bubble can re-parse the quota marker. A turn the user
        // stopped is not a failure, so it is flagged separately and gets a muted note instead.
        // Stamped locally: a rejected turn carries no reply to read the persisted instant from.
        const failure: ConversationMessage = {
          id: `${pendingAnswerId}-failed`,
          conversationId,
          role: "assistant",
          content: cancelled ? "" : String(e),
          turn: lastTurn + 2,
          createdAt: new Date().toISOString(),
          provider,
          model: model || undefined,
          isError: !cancelled,
          isCancelled: cancelled,
          trace: trace.length > 0 ? trace : undefined,
        };
        settle((current) => ({
          ...current,
          messages: [...current.messages, failure],
          sending: false,
          runId: null,
          runStartedAt: null,
          pendingMessageId: null,
          updatedAt: Date.now(),
          // A stopped turn is never written to disk, so the conversation keeps whatever persisted
          // state it already had rather than claiming a row that does not exist.
          persisted: current.persisted || !cancelled,
        }));
        if (!cancelled) {
          reloadAfterTurn(conversationId);
          notifyStateChange("chat", projectId, conversationId);
          notify({
            source: "chatApp",
            titleKey: "notifications.chatFailed",
            target: {
              view: "chat",
              projectId: projectId ?? undefined,
              select: { kind: "chatAppConversation", id: conversationId },
            },
            workspaceId,
            status: "error",
            detail: title,
          });
        }
      })
      .finally(() => useAiRunStore.getState().finish(runId));
  },

  regenerate: (turn) => {
    const conversationId = get().activeId;
    if (!conversationId) return;
    const session = get().byConversation[conversationId];
    if (!session || session.sending) return;
    const question = questionBehind(session.messages, turn);
    if (!question) return;
    get().send(conversationId, question.content);
  },

  stop: (conversationId) => {
    const runId = get().byConversation[conversationId]?.runId;
    if (!runId) return;
    void useAiRunStore.getState().cancel(runId);
  },

  skipReveal: (conversationId) => {
    const messageId = get().byConversation[conversationId]?.revealingMessageId;
    if (!messageId) return;
    // `finish` emits the final frame through the same path every other frame took, so the message
    // ends in exactly the state it would have reached on its own.
    revealers.get(messageId)?.finish();
  },

  rename: async (conversationId, title) => {
    await chatRenameConversation(conversationId, title);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, title } : c)),
      byConversation: s.byConversation[conversationId]
        ? { ...s.byConversation, [conversationId]: { ...s.byConversation[conversationId], title } }
        : s.byConversation,
    }));
  },

  setEngine: async (conversationId, provider, model) => {
    const previous = get().byConversation[conversationId]?.provider;
    await chatSetEngine(conversationId, provider, model);
    set((s) => {
      const session = s.byConversation[conversationId];
      return {
        conversations: s.conversations.map((c) =>
          c.id === conversationId ? { ...c, provider, model } : c,
        ),
        byConversation: session
          ? {
              ...s.byConversation,
              [conversationId]: {
                ...session,
                provider,
                model,
                // Mirrors what the backend just did. A session id belongs to the CLI that minted
                // it, so switching engine leaves this conversation with no resume token and the
                // next turn starts that engine fresh — keeping the old id here would send Codex a
                // token Claude issued and fail the turn on an argument, not on the question.
                sessionId: previous && previous !== provider ? null : session.sessionId,
              },
            }
          : s.byConversation,
      };
    });
  },

  setPendingEffort: (effort) => set({ pendingEffort: effort }),

  setPendingCaveman: (level) => set({ pendingCaveman: level }),

  applyCaveman: async (conversationId, argument) => {
    const level = await chatCavemanResolve(argument).catch(() => null);
    if (level === null) return false;
    // With no conversation open the level is held for the one the next message creates — the same
    // thing `pendingEffort` does for the reasoning dial.
    if (conversationId) await get().setCaveman(conversationId, level);
    else set({ pendingCaveman: level });
    return true;
  },

  setCaveman: async (conversationId, level) => {
    await chatSetCaveman(conversationId, level);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, cavemanLevel: level } : c,
      ),
    }));
  },

  setEffort: async (conversationId, effort) => {
    await chatSetEffort(conversationId, effort);
    set((s) => {
      const session = s.byConversation[conversationId];
      return {
        conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, effort } : c)),
        byConversation: session
          ? { ...s.byConversation, [conversationId]: { ...session, effort } }
          : s.byConversation,
      };
    });
  },

  windowByModel: {},

  ensureContextWindow: (model) => {
    const key = model.trim();
    // Same two guards as `ensureEffortSupport`, for the same reason: the map answers "already
    // known", `asking` answers "already in flight". The key is prefixed so it cannot collide with
    // an effort key in the shared set.
    const flight = `window:${key}`;
    if (key in get().windowByModel || asking.has(flight)) return;
    asking.add(flight);
    void chatContextWindow(key)
      .then((tokens) => set((s) => ({ windowByModel: { ...s.windowByModel, [key]: tokens } })))
      // A failed probe stays unrecorded rather than stored as `null`: both render the same today,
      // but writing it down would mean one bad call permanently removed the bar for that model.
      .catch(() => {})
      .finally(() => {
        asking.delete(flight);
      });
  },

  ensureEffortSupport: (provider, model) => {
    const key = effortKey(provider, model);
    // Two guards, and they are not the same: the map answers "already known", `asking` answers
    // "already in flight". Without the second, two composers mounted in one window ask for the
    // same pair on the same frame and both pay for it.
    if (key in get().effortByModel || asking.has(key)) return;
    asking.add(key);
    void chatModelEffortSupport(provider, model)
      .then((supported) => set((s) => ({ effortByModel: { ...s.effortByModel, [key]: supported } })))
      // A failed probe is left unrecorded rather than stored as `false`: unknown already reads as
      // yes, and writing the failure down would hide the control for good over one bad call.
      .catch(() => {})
      .finally(() => {
        asking.delete(key);
      });
  },

  // ---- folders ----

  loadGroups: async () => {
    set({ groups: await chatListGroups() });
  },

  createGroup: async (name, color) => {
    const group = await chatCreateGroup(name, color);
    await get().loadGroups();
    return group;
  },

  renameGroup: async (groupId, name, color) => {
    await chatRenameGroup(groupId, name, color);
    await get().loadGroups();
  },

  setGroupPinned: async (groupId, pinned) => {
    await chatSetGroupPinned(groupId, pinned);
    await get().loadGroups();
  },

  setGroupArchived: async (groupId, archived) => {
    // An archived folder that is still the open page would leave the user reading something the
    // sidebar no longer offers a way back to, so the selection goes with it.
    if (archived && get().activeGroupId === groupId) set({ activeGroupId: null });
    await chatSetGroupArchived(groupId, archived);
    await get().loadGroups();
  },

  deleteGroup: async (groupId) => {
    await chatDeleteGroup(groupId);
    // Both, and in this order: the conversations that were in the folder are now ungrouped, so a
    // sidebar that only refreshed the folder list would keep drawing them under a heading that no
    // longer exists.
    await get().loadGroups();
    await get().loadConversations();
  },

  toggleGroup: async (groupId) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return;
    const collapsed = !group.collapsed;
    // Optimistic: collapsing a folder should feel instant, and the write is a single boolean whose
    // failure costs nothing worse than a folder that reopens on the next launch.
    set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g)) }));
    await chatSetGroupCollapsed(groupId, collapsed);
  },

  reorderGroups: async (ids) => {
    set((s) => ({
      groups: [...s.groups].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
    }));
    await chatReorderGroups(ids);
  },

  setConversationGroup: async (conversationId, groupId) => {
    await chatSetConversationGroup(conversationId, groupId);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, groupId } : c)),
    }));
    // The counts on the folder headings are computed by the query, so they are re-read rather than
    // adjusted here — two places deciding what a count is, is how a count goes wrong.
    await get().loadGroups();
  },

  // ---- attachments ----

  openGroup: async (groupId) => {
    // Opening a project closes whatever conversation was on screen, and opening a conversation
    // clears the project — the pane shows one or the other. A turn already running is untouched:
    // it lands in its own conversation whenever it arrives, which is this store's oldest rule.
    set({ activeGroupId: groupId, activeId: groupId ? null : get().activeId });
    if (groupId) await get().loadGroupContext(groupId);
  },

  setGroupInstructions: async (groupId, instructions) => {
    await chatSetGroupInstructions(groupId, instructions);
    set((s) => ({
      groups: s.groups.map((g) => (g.id === groupId ? { ...g, instructions } : g)),
    }));
  },

  loadGroupContext: async (groupId) => {
    const files = await chatGroupListContext(groupId);
    set((s) => ({ groupContext: { ...s.groupContext, [groupId]: files } }));
  },

  attachGroupContext: async (groupId, sourcePath) => {
    const file = await chatGroupAttachFile(groupId, sourcePath);
    set((s) => ({
      groupContext: { ...s.groupContext, [groupId]: [...(s.groupContext[groupId] ?? []), file] },
    }));
  },

  removeGroupContext: async (groupId, attachmentId) => {
    await chatGroupRemoveContext(groupId, attachmentId);
    set((s) => ({
      groupContext: {
        ...s.groupContext,
        [groupId]: (s.groupContext[groupId] ?? []).filter((a) => a.id !== attachmentId),
      },
    }));
  },

  loadAttachments: async (conversationId) => {
    const files = await chatListAttachments(conversationId);
    set((s) => ({ attachments: { ...s.attachments, [conversationId]: files } }));
  },

  loadOutputs: async (conversationId) => {
    // A conversation whose directory was never created answers with an empty list rather than
    // failing, so the ordinary case — a chat that has produced nothing — costs one cheap call and
    // renders nothing.
    const files = await chatListOutputs(conversationId).catch(() => [] as ChatOutput[]);
    set((s) => ({ outputs: { ...s.outputs, [conversationId]: files } }));
  },

  addAttachment: (conversationId, file) => {
    set((s) => ({
      attachments: {
        ...s.attachments,
        [conversationId]: [...(s.attachments[conversationId] ?? []), file],
      },
    }));
  },

  removeAttachment: async (conversationId, attachmentId) => {
    await chatRemoveAttachment(conversationId, attachmentId);
    set((s) => ({
      attachments: {
        ...s.attachments,
        [conversationId]: (s.attachments[conversationId] ?? []).filter((a) => a.id !== attachmentId),
      },
    }));
  },

  setPinned: async (conversationId, pinned) => {
    await chatSetPinned(conversationId, pinned);
    // Re-listed rather than patched in place: pinning changes the *order*, which is the backend's
    // to decide (pinned first, then recency) and would otherwise be re-implemented here.
    await get().loadConversations();
  },

  setArchived: async (conversationId, archived) => {
    await chatSetArchived(conversationId, archived);
    await get().loadConversations();
  },

  remove: async (conversationId) => {
    await chatDeleteConversation(conversationId);
    // Deleted means there is nothing left to reload, so the cap's bookkeeping about it goes too
    // rather than outliving the thing it describes.
    recent = recent.filter((id) => id !== conversationId);
    set((s) => {
      const { [conversationId]: dropped, ...rest } = s.byConversation;
      if (dropped?.revealingMessageId) stopRevealer(dropped.revealingMessageId);
      return {
        conversations: s.conversations.filter((c) => c.id !== conversationId),
        byConversation: rest,
        activeId: s.activeId === conversationId ? null : s.activeId,
      };
    });
  },

  branch: async (conversationId, atTurn) => {
    const conversation = await chatBranchConversation(conversationId, atTurn);
    set((s) => ({ conversations: [conversation, ...s.conversations] }));
    await get().open(conversation.id);
    return conversation.id;
  },

  compacting: {},

  compact: async (conversationId, guidance) => {
    // Two guards for two different collisions. A second compaction would summarise a summary being
    // written; a compaction during a turn would summarise a conversation one exchange shorter than
    // the one on screen and then clear the session that exchange is about to be written into. The
    // Rust side refuses both as well — it takes the conversation's lease — but refusing here is
    // what keeps the button from looking broken.
    if (get().compacting[conversationId]) return;
    if (get().byConversation[conversationId]?.sending) return;

    const runId = newRunId("chat");
    const title = get().conversations.find((c) => c.id === conversationId)?.title ?? "";
    set((s) => ({ compacting: { ...s.compacting, [conversationId]: runId } }));
    useAiRunStore.getState().start(runId, {
      kindKey: "chat.compacting",
      detail: title,
      target: { view: "chat", select: { kind: "chatAppConversation", id: conversationId } },
      workspaceId: get().byConversation[conversationId]?.workspaceId,
    });

    try {
      const result = await chatCompact(conversationId, runId, guidance);
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                compactedSummary: result.summary,
                compactedThroughTurn: result.through_turn,
                // The last measurement described the context that was just replaced, so it is not
                // a measurement of anything any more. Cleared on the Rust side too; mirrored here
                // so the meter stops claiming ninety thousand tokens the instant the summary
                // lands, rather than at whatever point the next turn happens to run.
                contextTokens: null,
                // Cleared on the Rust side in the same statement that filed the summary — see
                // `chat_queries::set_compaction`. Mirrored here rather than re-read, because a row
                // that still named a session would have the capabilities panel and the meter both
                // claiming this thread resumes when its next turn will not.
                engineSessionId: null,
              }
            : c,
        ),
        byConversation: s.byConversation[conversationId]
          ? {
              ...s.byConversation,
              [conversationId]: { ...s.byConversation[conversationId], sessionId: null },
            }
          : s.byConversation,
      }));
      // The number, not an adjective. "Compactado" alone gives the user nothing to judge whether it
      // was worth a turn; a percentage off the replay is exactly what they were buying.
      const saved = result.before_chars > 0
        ? Math.max(0, Math.round((1 - result.after_chars / result.before_chars) * 100))
        : 0;
      pushSuccessToast(translate("chat.compactedBy", { percent: saved }));
    } catch (e) {
      // A cancellation is the user pressing Stop on their own compaction. Nothing was written —
      // the summary is filed only after the run returns — so there is nothing to explain.
      if (!isCancellation(e)) pushErrorToast(String(e));
    } finally {
      useAiRunStore.getState().finish(runId);
      set((s) => {
        const next = { ...s.compacting };
        delete next[conversationId];
        return { compacting: next };
      });
    }
  },

  uncompact: async (conversationId) => {
    await chatUncompact(conversationId).catch((e: unknown) => {
      pushErrorToast(String(e));
      throw e;
    });
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, compactedSummary: "", compactedThroughTurn: null, contextTokens: null }
          : c,
      ),
    }));
  },

  search: (query, limit) => chatSearchConversations(query, limit),

  sessionFor: (conversationId) =>
    (conversationId ? get().byConversation[conversationId] : undefined) ?? EMPTY_CONVERSATION,
}));

// ---------------------------------------------------------------------------
// the one streaming path
// ---------------------------------------------------------------------------

/**
 * Publishes an accumulated answer into the transcript.
 *
 * **The single place a streaming answer reaches the screen**, and both sources go through it: the
 * live `ai:chat-delta` chunks of an engine that types, and the typewriter uncovering one that does
 * not. Two renderers would be two behaviours — different whitespace handling, different final
 * frame, one of them quietly breaking when only the other is exercised — for what is the same
 * question asked twice.
 *
 * **The message object is replaced, never mutated.** `ChatMessageBubble` is memoized on message
 * identity (see the comment in `components/ai/AiPanel.tsx`, which this store's predecessor earned),
 * so growing `content` in place would leave an answer that is arriving perfectly and looks frozen.
 * That is not a React subtlety to be rediscovered later: it is the reason this function returns a
 * new array with a new object in it on every chunk.
 */
function publish(conversationId: string, messageId: string, buffers: StreamingBuffers): void {
  useConversationStore.setState((s) => {
    const session = s.byConversation[conversationId];
    if (!session) return s;
    const text = buffers.text[messageId] ?? "";
    const thinking = buffers.thinking[messageId] ?? "";
    let changed = false;
    const messages = session.messages.map((m) => {
      if (m.id !== messageId) return m;
      if (m.content === text && (m.thinking ?? "") === thinking) return m;
      changed = true;
      return { ...m, content: text, thinking: thinking || undefined };
    });
    if (!changed) {
      return { streamingText: buffers.text, streamingThinking: buffers.thinking };
    }
    return {
      streamingText: buffers.text,
      streamingThinking: buffers.thinking,
      byConversation: { ...s.byConversation, [conversationId]: { ...session, messages, updatedAt: Date.now() } },
    };
  });
}

function buffersOf(): StreamingBuffers {
  const { streamingText, streamingThinking } = useConversationStore.getState();
  return { text: streamingText, thinking: streamingThinking };
}

/**
 * Routes one delta into the conversation that asked for it.
 *
 * Routing is by **conversation** and not by message, because during a streaming turn this window
 * does not yet know the backend's id for the answer — `chat_send` only hands it back when the turn
 * is over. The first chunk is therefore also the introduction: the pending answer adopts the id it
 * carries, and every later chunk matches on it directly.
 */
function applyStream(event: AiChatDeltaEvent): void {
  const state = useConversationStore.getState();
  const session = state.byConversation[event.conversationId];
  // No pending answer means this window is not the one that asked — a turn driven from a paired
  // phone reaches the same engine, and its chunks have nothing here to grow.
  if (!session?.sending || !session.pendingMessageId) return;
  if (session.pendingMessageId !== event.messageId) {
    adoptMessageId(event.conversationId, session.pendingMessageId, event.messageId);
  }
  publish(event.conversationId, event.messageId, reduceDelta(buffersOf(), event));
}

/** Moves a pending answer onto the id the backend gave it, in the transcript and in both buffers at
 *  once so nothing is left keyed by a placeholder that no longer names anything. */
function adoptMessageId(conversationId: string, fromId: string, toId: string): void {
  if (fromId === toId) return;
  useConversationStore.setState((s) => {
    const session = s.byConversation[conversationId];
    if (!session) return s;
    // Already adopted — the first delta did it, and `chat_send` resolving is simply saying the same
    // thing again. Bailing keeps that from costing a store write that changes nothing.
    if (session.pendingMessageId === toId && s.streamingText[fromId] === undefined) return s;
    const text = { ...s.streamingText };
    const thinking = { ...s.streamingThinking };
    if (text[fromId] !== undefined) {
      text[toId] = text[fromId];
      delete text[fromId];
    }
    if (thinking[fromId] !== undefined) {
      thinking[toId] = thinking[fromId];
      delete thinking[fromId];
    }
    return {
      streamingText: text,
      streamingThinking: thinking,
      byConversation: {
        ...s.byConversation,
        [conversationId]: {
          ...session,
          messages: session.messages.map((m) => (m.id === fromId ? { ...m, id: toId } : m)),
          pendingMessageId: session.pendingMessageId === fromId ? toId : session.pendingMessageId,
          revealingMessageId: session.revealingMessageId === fromId ? toId : session.revealingMessageId,
        },
      },
    };
  });
}

function clearBuffers(messageId: string): void {
  stopRevealer(messageId);
  useConversationStore.setState((s) => {
    const next = dropBuffers({ text: s.streamingText, thinking: s.streamingThinking }, messageId);
    if (next.text === s.streamingText && next.thinking === s.streamingThinking) return s;
    return { streamingText: next.text, streamingThinking: next.thinking };
  });
}

/** Starts uncovering a finished answer. The frames go through {@link publish} exactly as live
 *  deltas do; only where the text comes from is different. */
function beginReveal(conversationId: string, messageId: string, full: string): void {
  stopRevealer(messageId);
  const typewriter = startTypewriter(full, (visible, done) => {
    publish(conversationId, messageId, writeBuffer(buffersOf(), messageId, "text", visible));
    if (!done) return;
    revealers.delete(messageId);
    clearBuffers(messageId);
    useConversationStore.setState((s) => {
      const session = s.byConversation[conversationId];
      if (!session || session.revealingMessageId !== messageId) return s;
      return {
        byConversation: { ...s.byConversation, [conversationId]: { ...session, revealingMessageId: null } },
      };
    });
    // The cap could not touch this conversation while it was revealing — see `pickEvictions` —
    // so this is the first moment it is a candidate again.
    prune();
  });
  revealers.set(messageId, typewriter);
}

// ---------------------------------------------------------------------------
// the cap, applied
// ---------------------------------------------------------------------------

function prune(): void {
  const { byConversation, activeId } = useConversationStore.getState();
  const ids = Object.keys(byConversation);
  if (ids.length <= MAX_LIVE_CONVERSATIONS) return;
  // Ids of conversations that have since gone would otherwise sit in the recency list for ever.
  recent = recent.filter((id) => byConversation[id] !== undefined);
  const candidates: EvictionCandidate[] = ids.map((id) => {
    const session = byConversation[id];
    return {
      id,
      sending: session.sending,
      active: id === activeId,
      persisted: session.persisted && session.loaded,
      // A stopped turn is never written, and a revealing one is only half on screen. Either way
      // memory holds something the re-read would not bring back.
      holdsUnwritten:
        session.revealingMessageId !== null ||
        session.pendingMessageId !== null ||
        session.messages.some((m) => m.isCancelled),
    };
  });
  const gone = new Set(pickEvictions(recent, candidates));
  if (gone.size === 0) return;
  recent = recent.filter((id) => !gone.has(id));
  useConversationStore.setState((s) => {
    const rest: Record<string, ConversationSession> = {};
    for (const id of Object.keys(s.byConversation)) {
      if (!gone.has(id)) rest[id] = s.byConversation[id];
    }
    return { byConversation: rest };
  });
}

export { EMPTY_CONVERSATION, EMPTY_BUFFERS };
