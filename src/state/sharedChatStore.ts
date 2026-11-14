import { create } from "zustand";
import { dropLive, liveFilesOf, syncLive } from "../lib/collabLive/registry";
import { patchLiveSession } from "./liveStore";
import { chatQueueKey, releaseChatQueue } from "./chatQueueStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  collabCommit,
  collabInvite,
  collabJoin,
  collabLeave,
  collabResolve,
  collabSessionForChat,
  collabShare,
  collabThread,
  collabTick,
  type CollabCommitted,
  type CollabConflict,
  type CollabLeft,
  type CollabLock,
  type CollabMessage,
  type CollabPerson,
  type CollabSessionView,
} from "../lib/tauri/collabCommands";

/**
 * Shared workspace chats, the frontend half (`src-tauri/src/collab`).
 *
 * - **Which chat is shared** is asked once per chat (`ensure`) and kept by chat id.
 * - **A sync loop per open session** runs `collab_tick` every few seconds: files both ways, the
 *   shared thread, people, locks and conflicts. Like the API collections' sync (`lib/api/sync.ts`)
 *   it slows down while the window is hidden and backs off while the project keeps failing.
 * - **The thread** is held per session. The chat draws the turns of the others from it, between its
 *   own (`othersOf`).
 */

const VISIBLE_MS = 3000;
const HIDDEN_MS = 30000;
const MAX_BACKOFF_MS = 60000;

export interface CollabLive {
  people: CollabPerson[];
  locks: CollabLock[];
  conflicts: CollabConflict[];
  thread: CollabMessage[];
  sessionFiles: number;
  ended: boolean;
  /** The last round's problems that did not stop it, and the error of a round that failed. */
  errors: string[];
  lastTickAt: number | null;
  /** Files that arrived in the last round, for a short "llegaron cambios" notice. */
  lastPulled: string[];
}

const EMPTY_LIVE: CollabLive = {
  people: [],
  locks: [],
  conflicts: [],
  thread: [],
  sessionFiles: 0,
  ended: false,
  errors: [],
  lastTickAt: null,
  lastPulled: [],
};

interface CollabState {
  /** An invitation link opened from outside, waiting for the join dialog (`SharedChatJoinHost`). */
  pendingJoin: string | null;
  /** By chat id: the session it is shown in, `null` when the chat is not shared, absent when unknown. */
  byChat: Record<string, CollabSessionView | null>;
  live: Record<string, CollabLive>;
  ensure: (chatId: string) => Promise<CollabSessionView | null>;
  share: (args: Parameters<typeof collabShare>[0]) => Promise<string>;
  join: (workspaceId: string, link: string, nick: string) => Promise<CollabSessionView>;
  invite: (sessionId: string) => Promise<string>;
  tickNow: (sessionId: string) => Promise<void>;
  resolve: (sessionId: string, repoKey: string, path: string, keepMine: boolean) => Promise<void>;
  commit: (sessionId: string, message: string) => Promise<CollabCommitted[]>;
  leave: (chatId: string, keep: boolean) => Promise<CollabLeft[]>;
}

/** Shared chats whose queue is held until another person's turn lets go of their repositories. */
const waitingForTurn = new Set<string>();

export function markWaitingForTurn(chatId: string): void {
  waitingForTurn.add(chatId);
}

const loops = new Map<string, { timer: ReturnType<typeof setTimeout> | null; failures: number; busy: boolean }>();
/** Listeners told after a round that pulled files, so open editors and git views can refresh. */
const pulledListeners = new Set<(sessionId: string, paths: string[]) => void>();

export function onCollabPulled(fn: (sessionId: string, paths: string[]) => void): () => void {
  pulledListeners.add(fn);
  return () => pulledListeners.delete(fn);
}

function mergeThread(current: CollabMessage[], incoming: CollabMessage[]): CollabMessage[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((m) => m.seq));
  const added = incoming.filter((m) => !seen.has(m.seq));
  if (added.length === 0) return current;
  return [...current, ...added].sort((a, b) => a.seq - b.seq);
}

export const useSharedChatStore = create<CollabState>((set, get) => {
  const patchLive = (sessionId: string, patch: Partial<CollabLive>) =>
    set((s) => ({ live: { ...s.live, [sessionId]: { ...(s.live[sessionId] ?? EMPTY_LIVE), ...patch } } }));

  async function round(sessionId: string): Promise<void> {
    const loop = loops.get(sessionId);
    if (!loop || loop.busy) return;
    loop.busy = true;
    try {
      const tick = await collabTick(sessionId, liveFilesOf(sessionId));
      loop.failures = 0;
      const view = Object.values(get().byChat).find((v) => v?.session.id === sessionId);
      if (view) void syncLive(view, tick).catch(() => undefined);
      // A turn that just landed in the thread is no longer one being written.
      for (const message of tick.messages) {
        if ((message.kind === "assistant" || message.kind === "turn_failed") && message.personId) {
          const person = message.personId;
          patchLiveSession(sessionId, (s) => {
            if (!s.turns[person]) return s;
            const { [person]: _done, ...turns } = s.turns;
            return { ...s, turns };
          });
        }
      }
      const current = get().live[sessionId] ?? EMPTY_LIVE;
      patchLive(sessionId, {
        people: tick.people,
        locks: tick.locks,
        conflicts: tick.conflicts,
        thread: mergeThread(current.thread, tick.messages),
        sessionFiles: tick.sessionFiles,
        ended: tick.ended,
        errors: tick.errors,
        lastTickAt: Date.now(),
        lastPulled: tick.pulled,
      });
      // A question that waited for someone else's turn goes out once nobody else holds a lock.
      const chatId = Object.entries(get().byChat).find(([, v]) => v?.session.id === sessionId)?.[0];
      if (chatId && waitingForTurn.has(chatId)) {
        const me = get().byChat[chatId]?.session.personId ?? "";
        if (!busyHolder(get().live[sessionId], me)) {
          waitingForTurn.delete(chatId);
          releaseChatQueue(chatQueueKey("panel", `ws:${chatId}`));
        }
      }
      if (tick.pulled.length > 0 || tick.rebased.length > 0) {
        pulledListeners.forEach((fn) => fn(sessionId, tick.pulled));
      }
    } catch (error) {
      loop.failures += 1;
      patchLive(sessionId, { errors: [String(error)], lastTickAt: Date.now() });
    } finally {
      loop.busy = false;
    }
  }

  function schedule(sessionId: string): void {
    const loop = loops.get(sessionId);
    if (!loop) return;
    const base = typeof document !== "undefined" && document.hidden ? HIDDEN_MS : VISIBLE_MS;
    const delay = Math.min(base * 2 ** Math.min(loop.failures, 5), Math.max(base, MAX_BACKOFF_MS));
    loop.timer = setTimeout(() => {
      void round(sessionId).finally(() => schedule(sessionId));
    }, loop.failures > 0 ? delay : base);
  }

  function startLoop(sessionId: string): void {
    if (loops.has(sessionId)) return;
    loops.set(sessionId, { timer: null, failures: 0, busy: false });
    void collabThread(sessionId)
      .then((thread) => patchLive(sessionId, { thread: mergeThread(get().live[sessionId]?.thread ?? [], thread) }))
      .catch(() => undefined);
    void round(sessionId).finally(() => schedule(sessionId));
  }

  function stopLoop(sessionId: string): void {
    const loop = loops.get(sessionId);
    if (loop?.timer) clearTimeout(loop.timer);
    loops.delete(sessionId);
    dropLive(sessionId);
  }

  return {
    pendingJoin: null,
    byChat: {},
    live: {},

    ensure: async (chatId) => {
      if (chatId in get().byChat) {
        const known = get().byChat[chatId];
        if (known) startLoop(known.session.id);
        return known;
      }
      const view = await collabSessionForChat(chatId).catch(() => null);
      set((s) => ({ byChat: { ...s.byChat, [chatId]: view } }));
      if (view) startLoop(view.session.id);
      return view;
    },

    share: async (args) => {
      const { view, link } = await collabShare(args);
      set((s) => ({ byChat: { ...s.byChat, [args.chatId]: view } }));
      // The session copies are projects of the workspace now («api · sesión»).
      void useWorkspaceStore.getState().loadProjects(args.workspaceId);
      startLoop(view.session.id);
      return link;
    },

    join: async (workspaceId, link, nick) => {
      const view = await collabJoin(workspaceId, link, nick);
      // A shared run has no chat and no worktrees of its own: `sharedRunStore` runs its rounds.
      if (view.kind === "run") return view;
      set((s) => ({ byChat: { ...s.byChat, [view.session.chatId]: view } }));
      void useWorkspaceStore.getState().loadProjects(workspaceId);
      startLoop(view.session.id);
      return view;
    },

    invite: (sessionId) => collabInvite(sessionId),

    tickNow: async (sessionId) => {
      if (!loops.has(sessionId)) return;
      await round(sessionId);
    },

    resolve: async (sessionId, repoKey, path, keepMine) => {
      await collabResolve(sessionId, repoKey, path, keepMine);
      await get().tickNow(sessionId);
    },

    commit: async (sessionId, message) => {
      const done = await collabCommit(sessionId, message);
      await get().tickNow(sessionId);
      return done;
    },

    leave: async (chatId, keep) => {
      const view = get().byChat[chatId];
      if (!view) return [];
      const left = await collabLeave(view.session.id, keep);
      stopLoop(view.session.id);
      void useWorkspaceStore.getState().loadProjects(view.session.workspaceId);
      set((s) => {
        const live = { ...s.live };
        delete live[view.session.id];
        return { byChat: { ...s.byChat, [chatId]: null }, live };
      });
      return left;
    },
  };
});

/** The turns of the other people in a session's thread: what the chat draws besides its own. */
export function othersOf(thread: CollabMessage[], myPersonId: string): CollabMessage[] {
  return thread.filter((m) => m.personId !== myPersonId && (m.kind === "user" || m.kind === "assistant") && !!m.body.text?.trim());
}

/** Who holds a lock on any of `repoKeys` other than me: the nick, for "turno de X en curso". */
export function busyHolder(live: CollabLive | undefined, myPersonId: string): string | null {
  if (!live) return null;
  const now = Date.now();
  const lock = live.locks.find((l) => l.personId !== myPersonId && Date.parse(l.expiresAt) > now);
  if (!lock) return null;
  return live.people.find((p) => p.id === lock.personId)?.nick ?? null;
}

/** A person is connected when their CodeFlow sent a heartbeat in the last 20 seconds. */
export function isOnline(person: CollabPerson, now = Date.now()): boolean {
  const seen = Date.parse(person.lastSeen);
  return Number.isFinite(seen) && now - seen < 20000;
}
