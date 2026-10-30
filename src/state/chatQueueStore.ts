import { create } from "zustand";
import type { ChatAttachment, SkillPick } from "../lib/tauri/chatCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";

/**
 * Messages written while a conversation was still answering, waiting their turn.
 *
 * # Why a queue and not a refusal
 *
 * Both chats used to refuse a second message while a turn ran: the composer's Enter did nothing
 * and the send button had become Stop. That is the one-lease rule showing through — an engine
 * session resumes once at a time, so a conversation cannot run two turns — but the rule is about
 * *running*, not about *asking*. The desktop chat apps let you keep typing while the answer is
 * being written, and the thought you had halfway through reading it is exactly the one that is
 * gone if the box will not take it. So what is sent while a turn runs is kept here, in order, and
 * each message is sent the moment the conversation is free again.
 *
 * # Shared by both chats, driven by each
 *
 * The chat workspace (`conversationStore`) and the assistant's repository chat (`chatStore`) have
 * different turn machinery and different stores, and that is exactly why the queue is neither of
 * them: one implementation of what "in order", "held" and "released" mean is how the two surfaces
 * are guaranteed to agree. What each store owns is *when* to advance — it is the one that knows a
 * turn just landed, failed or was stopped — and *how* to send, which is its own `send`.
 *
 * # Held, never fired, after something went wrong
 *
 * A turn that failed or was stopped holds the rest of the queue ({@link QueueHold}). Firing the
 * next message anyway would answer a question built on an answer that never arrived — or, after a
 * Stop, keep spending on a conversation the user just tried to halt. Held messages stay visible
 * and each can still be edited or removed; resuming, or sending anything new, lets them go again.
 *
 * # Persisted, but never resumed by itself
 *
 * Like the composer's drafts, the two panel chats' queues survive a restart (see
 * {@link loadChatQueues}); the chat app's do not. Nothing here has been sent to anyone, so there
 * is nothing a restart could leave half-done — but a restart is an interruption, so what comes
 * back is held ({@link QueueHold} `"restored"`) until the user sends or discards it.
 */

/** Which chat a queue belongs to. The two key their conversations with ids that cannot collide,
 *  but the prefix keeps a stray id from ever being read as the other surface's. */
export type ChatQueueSurface = "chat" | "panel";

/**
 * An app command that waits its turn instead of running at once.
 *
 * Only the ones that act on *what the next turn is sent*: `/compact` summarises the conversation
 * (so it has to see the answer still being written, and the messages queued before it), `/clear`
 * starts the engine's session over (so the questions queued before it keep the old one). The rest
 * — `/new`, `/export`, `/caveman`, `/branch` — never touch a turn in flight and run immediately;
 * see where each surface parses the line.
 */
export interface QueuedCommand {
  id: "compact" | "clear";
  args: string;
}

export interface QueuedChatMessage {
  /** Local only — a React key and what the row's buttons address. */
  id: string;
  /** What was typed, trimmed. For a command, the whole line (`/compact keep the paths`), so it
   *  reads in the list exactly as it was written and goes back into the box the same way. */
  text: string;
  /** The skill picked in the composer for this message. It was an ingredient of the message when
   *  it was written, so it travels with it rather than staying behind for the next one. */
  skill?: SkillPick | null;
  /** The chat workspace's staged files, taken off the composer with the message. Already on disk in
   *  the conversation's folder, which is why a queued message can carry them at all. */
  attachments?: ChatAttachment[];
  command?: QueuedCommand;
  queuedAt: number;
}

/** Why a queue has stopped moving: the turn ahead of it failed, the user stopped it, or the app
 *  restarted with it non-empty. */
export type QueueHold = "error" | "stopped" | "restored";

interface ChatQueueState {
  /** First in, first out, per {@link chatQueueKey}. An absent key is an empty queue. */
  items: Record<string, QueuedChatMessage[]>;
  /** Queues that are waiting for the user rather than for a turn — absent means flowing. */
  held: Record<string, QueueHold>;
}

export const useChatQueueStore = create<ChatQueueState>(() => ({ items: {}, held: {} }));

/** One shared empty list, so a conversation with nothing queued hands every subscriber the same
 *  reference and a selector does not re-render on each store write. */
export const EMPTY_QUEUE: QueuedChatMessage[] = [];

export function chatQueueKey(surface: ChatQueueSurface, conversationId: string): string {
  return `${surface}:${conversationId}`;
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** What is waiting in `key`'s queue, oldest first. */
export function queuedMessages(key: string): QueuedChatMessage[] {
  return useChatQueueStore.getState().items[key] ?? EMPTY_QUEUE;
}

export function queueHold(key: string): QueueHold | null {
  return useChatQueueStore.getState().held[key] ?? null;
}

/**
 * Adds a message to the end of `key`'s queue.
 *
 * **Also releases a held queue.** Writing a new message is the user sending again, and a queue
 * that stayed held behind it would leave the new message stuck behind a failure they have plainly
 * moved on from. It goes to the *end* all the same: what was queued first was asked first, and the
 * list on screen says so.
 */
export function enqueueChatMessage(
  key: string,
  entry: Omit<QueuedChatMessage, "id" | "queuedAt">,
): QueuedChatMessage {
  const item: QueuedChatMessage = { ...entry, id: `queued-${crypto.randomUUID()}`, queuedAt: Date.now() };
  useChatQueueStore.setState((s) => ({
    items: { ...s.items, [key]: [...(s.items[key] ?? EMPTY_QUEUE), item] },
    held: omit(s.held, key),
  }));
  return item;
}

/**
 * Puts a message back at the head of `key`'s queue — one that was taken off to be sent and never
 * reached an engine (the conversation was busy in another window). First, because it was next; and
 * without touching the hold, because whoever put it back is about to decide that.
 */
export function requeueChatMessageFirst(
  key: string,
  entry: Omit<QueuedChatMessage, "id" | "queuedAt">,
): void {
  const item: QueuedChatMessage = { ...entry, id: `queued-${crypto.randomUUID()}`, queuedAt: Date.now() };
  useChatQueueStore.setState((s) => ({ items: { ...s.items, [key]: [item, ...(s.items[key] ?? EMPTY_QUEUE)] } }));
}

/**
 * Takes the next message off `key`'s queue, or `null` when there is none — or when the queue is
 * held, which is the one place the hold is enforced: every surface advances through here, so none
 * of them can forget it.
 */
export function shiftChatQueue(key: string): QueuedChatMessage | null {
  const { items, held } = useChatQueueStore.getState();
  if (held[key]) return null;
  const list = items[key];
  if (!list || list.length === 0) return null;
  const [head, ...rest] = list;
  useChatQueueStore.setState((s) => ({
    items: rest.length > 0 ? { ...s.items, [key]: rest } : omit(s.items, key),
  }));
  return head;
}

/**
 * Removes one message from `key`'s queue and hands it back — for the row's remove and edit
 * buttons. A queue emptied this way is no longer held: there is nothing left to hold, and a hold
 * that outlived its messages would silently hold back the next one written.
 */
export function takeQueuedChatMessage(key: string, id: string): QueuedChatMessage | null {
  const list = useChatQueueStore.getState().items[key] ?? EMPTY_QUEUE;
  const taken = list.find((item) => item.id === id) ?? null;
  if (!taken) return null;
  const rest = list.filter((item) => item.id !== id);
  useChatQueueStore.setState((s) => ({
    items: rest.length > 0 ? { ...s.items, [key]: rest } : omit(s.items, key),
    held: rest.length > 0 ? s.held : omit(s.held, key),
  }));
  return taken;
}

/** Holds `key`'s queue — only when there is something in it, since an empty queue has nothing to
 *  hold back and the mark would outlive the reason for it. */
export function holdChatQueue(key: string, why: QueueHold): void {
  if (queuedMessages(key).length === 0) return;
  useChatQueueStore.setState((s) => (s.held[key] === why ? s : { held: { ...s.held, [key]: why } }));
}

export function releaseChatQueue(key: string): void {
  useChatQueueStore.setState((s) => (key in s.held ? { held: omit(s.held, key) } : s));
}

/** Forgets `key`'s queue entirely — its conversation was deleted. Returns what was in it, for a
 *  caller that has files to clean up. */
export function dropChatQueue(key: string): QueuedChatMessage[] {
  const dropped = queuedMessages(key);
  useChatQueueStore.setState((s) =>
    key in s.items || key in s.held ? { items: omit(s.items, key), held: omit(s.held, key) } : s,
  );
  return dropped;
}

/** The files `key`'s queued messages are carrying — which a re-read of the staged list must not
 *  put back on the composer, or they would be sent twice. */
export function queuedAttachmentIds(key: string): Set<string> {
  return new Set(queuedMessages(key).flatMap((item) => (item.attachments ?? []).map((file) => file.id)));
}

/** `key`'s queue, for a component. `null` — no conversation yet — reads as empty. */
export function useChatQueue(key: string | null): QueuedChatMessage[] {
  return useChatQueueStore((s) => (key ? (s.items[key] ?? EMPTY_QUEUE) : EMPTY_QUEUE));
}

export function useChatQueueHold(key: string | null): QueueHold | null {
  return useChatQueueStore((s) => (key ? (s.held[key] ?? null) : null));
}

/** Drops a queue and the messages in it, whether it was restored or not — the strip's "Descartar". */
export function discardChatQueue(key: string): void {
  dropChatQueue(key);
}

// --- Persistence ------------------------------------------------------------------------------

const QUEUES_KEY = "chat_queues";
/** Caps: a queue is a handful of messages, and only the freshest conversations' are worth keeping. */
export const MAX_QUEUED_PER_CHAT = 20;
export const MAX_QUEUED_CHATS = 30;
/** Only the panel chats (repo + workspace) persist; the chat app's queue is window-lived. */
const PERSISTED_PREFIX = "panel:";

let queuesLoad: Promise<void> | null = null;
let queuesTimer: ReturnType<typeof setTimeout> | null = null;
let applyingLoad = false;
/** Keys that came off disk and have not had their attachments checked against the staged files. */
const unvalidated = new Set<string>();

function isQueued(value: unknown): value is QueuedChatMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.text === "string" && typeof item.queuedAt === "number";
}

function isAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return typeof file.id === "string" && typeof file.name === "string";
}

/** What goes to disk: the panel chats' queues, newest conversations kept, each capped. */
export function serializeChatQueues(items: Record<string, QueuedChatMessage[]>): string {
  const entries = Object.entries(items)
    .filter(([key, list]) => key.startsWith(PERSISTED_PREFIX) && list.length > 0)
    .sort((a, b) => (a[1][a[1].length - 1]?.queuedAt ?? 0) - (b[1][b[1].length - 1]?.queuedAt ?? 0))
    .slice(-MAX_QUEUED_CHATS)
    .map(([key, list]) => [key, list.slice(0, MAX_QUEUED_PER_CHAT)] as const);
  return JSON.stringify(Object.fromEntries(entries));
}

function parseChatQueues(raw: string | null): Record<string, QueuedChatMessage[]> {
  const out: Record<string, QueuedChatMessage[]> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return out;
    for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.startsWith(PERSISTED_PREFIX) || !Array.isArray(list)) continue;
      const kept = list
        .filter(isQueued)
        .slice(0, MAX_QUEUED_PER_CHAT)
        .map((item) => ({
          ...item,
          attachments: Array.isArray(item.attachments) ? item.attachments.filter(isAttachment) : undefined,
        }));
      if (kept.length > 0) out[key] = kept;
    }
  } catch {
    // A corrupt blob is a lost queue, never a broken chat.
  }
  return out;
}

/**
 * Reads the persisted queues once and puts them under whatever was queued this session. Everything
 * that comes back is held as `"restored"`: it does not send until the user says so.
 */
export function loadChatQueues(): Promise<void> {
  if (!queuesLoad) {
    queuesLoad = (async () => {
      const raw = await Promise.resolve(getSetting(QUEUES_KEY)).catch(() => null);
      const stored = parseChatQueues(raw ?? null);
      applyingLoad = true;
      try {
        useChatQueueStore.setState((s) => {
          const items = { ...s.items };
          const held = { ...s.held };
          for (const [key, list] of Object.entries(stored)) {
            // This session's queue for the key is newer than the disk copy.
            if (items[key]?.length) continue;
            items[key] = list;
            held[key] = "restored";
            unvalidated.add(key);
          }
          return { items, held };
        });
      } finally {
        applyingLoad = false;
      }
    })();
  }
  return queuesLoad;
}

/**
 * Drops, from a restored queue, the attachments whose staged copy is gone. `staged` is the
 * conversation's staged list, or `null` when it could not be read — in which case nothing is
 * dropped, since "could not ask" is not "they are gone".
 */
export async function restoreChatQueue(key: string, staged: ChatAttachment[] | null): Promise<void> {
  await loadChatQueues();
  if (!unvalidated.delete(key) || staged === null) return;
  const live = new Map(staged.map((file) => [file.id, file]));
  useChatQueueStore.setState((s) => {
    const list = s.items[key];
    if (!list) return s;
    return {
      items: {
        ...s.items,
        [key]: list.map((item) =>
          item.attachments
            ? {
                ...item,
                attachments: item.attachments.filter((file) => live.has(file.id)).map((file) => live.get(file.id) ?? file),
              }
            : item,
        ),
      },
    };
  });
}

function persistChatQueues(): void {
  if (queuesTimer) clearTimeout(queuesTimer);
  queuesTimer = setTimeout(() => {
    queuesTimer = null;
    void (async () => {
      // After the read, so a write can never clobber what the disk still holds.
      await loadChatQueues();
      await setSetting(QUEUES_KEY, serializeChatQueues(useChatQueueStore.getState().items));
    })().catch(() => {});
  }, 400);
}

useChatQueueStore.subscribe((state, prev) => {
  if (applyingLoad || state.items === prev.items) return;
  persistChatQueues();
});
