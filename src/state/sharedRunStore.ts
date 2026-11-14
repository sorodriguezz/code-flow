import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { useToastStore } from "./toastStore";
import type { CollabSessionView } from "../lib/tauri/collabCommands";
import { collabInvite, collabLeave } from "../lib/tauri/collabCommands";
import {
  collabRunAccept,
  collabRunDecline,
  collabRunFor,
  collabRunFreeSeat,
  collabRunNote,
  collabRunSessions,
  collabRunSetSeats,
  collabRunShare,
  collabRunTakeSeat,
  collabRunTick,
  type CollabRunSeat,
  type CollabRunTick,
} from "../lib/tauri/collabRunCommands";

/**
 * Shared «Equipo» runs (`collab::team`): which runs of this workspace are shared, and the latest
 * round of each.
 *
 * Every shared run needs its round running whether or not its page is open: on the owner's machine
 * the round is what hands seats' work off and brings their answers back, and on a guest's it is
 * what shows them a task to accept. So the rounds start with the workspace (`load`), not with a view.
 */

const VISIBLE_MS = 3000;
const HIDDEN_MS = 15000;
const MAX_BACKOFF_MS = 60000;

interface Loop {
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  busy: boolean;
}

const loops = new Map<string, Loop>();
/** Offers already announced, so each new one gets one toast. */
const announced = new Set<string>();

/** The offers of a round not announced before. */
export function freshOffers(tick: CollabRunTick, seen: Set<string>): string[] {
  if (tick.owner) return [];
  return tick.offers.map((o) => `${tick.sessionId}:${o.itemId}:${o.attempt}`).filter((key) => !seen.has(key));
}

interface SharedRunState {
  /** By session id. */
  views: Record<string, CollabSessionView>;
  ticks: Record<string, CollabRunTick>;
  errors: Record<string, string>;
  /** The guest run page open in «En vivo», by session id. */
  openGuest: string | null;
  load: (workspaceId: string) => Promise<void>;
  /** The owner's session of a local run, loaded on demand. */
  ensureRun: (runId: string) => Promise<CollabSessionView | null>;
  share: (args: { runId: string; projectUrl: string; nick: string; seats: string[] }) => Promise<string>;
  invite: (sessionId: string) => Promise<string>;
  setSeats: (sessionId: string, seats: string[]) => Promise<void>;
  takeSeat: (sessionId: string, memberId: string, agentId: string) => Promise<void>;
  freeSeat: (sessionId: string, memberId: string) => Promise<void>;
  accept: (sessionId: string, itemId: string) => Promise<void>;
  decline: (sessionId: string, itemId: string, reason?: string) => Promise<void>;
  note: (sessionId: string, to: string, text: string) => Promise<void>;
  leave: (sessionId: string) => Promise<void>;
  tickNow: (sessionId: string) => Promise<void>;
  openGuestRun: (sessionId: string | null) => void;
}

let listening = false;

export const useSharedRunStore = create<SharedRunState>((set, get) => {
  async function round(sessionId: string): Promise<void> {
    const loop = loops.get(sessionId);
    if (!loop || loop.busy) return;
    loop.busy = true;
    try {
      const tick = await collabRunTick(sessionId);
      loop.failures = 0;
      set((s) => ({ ticks: { ...s.ticks, [sessionId]: tick }, errors: { ...s.errors, [sessionId]: tick.errors.join("\n") } }));
      const fresh = freshOffers(tick, announced);
      if (fresh.length > 0) {
        fresh.forEach((key) => announced.add(key));
        const name = tick.run?.title || get().views[sessionId]?.session.name || "";
        useToastStore
          .getState()
          .pushToast(
            fresh.length === 1
              ? `Una tarea de «${name}» quiere correr en tu máquina: acéptala en Agentes › En vivo.`
              : `${fresh.length} tareas de «${name}» quieren correr en tu máquina: acéptalas en Agentes › En vivo.`,
            "info",
          );
      }
      if (tick.ended && !tick.owner) stop(sessionId);
    } catch (error) {
      loop.failures += 1;
      set((s) => ({ errors: { ...s.errors, [sessionId]: String(error) } }));
    } finally {
      loop.busy = false;
    }
  }

  function schedule(sessionId: string): void {
    const loop = loops.get(sessionId);
    if (!loop) return;
    const base = typeof document !== "undefined" && document.hidden ? HIDDEN_MS : VISIBLE_MS;
    const delay = loop.failures > 0 ? Math.min(base * 2 ** Math.min(loop.failures, 5), MAX_BACKOFF_MS) : base;
    loop.timer = setTimeout(() => void round(sessionId).finally(() => schedule(sessionId)), delay);
  }

  function start(view: CollabSessionView): void {
    const id = view.session.id;
    set((s) => ({ views: { ...s.views, [id]: view } }));
    if (loops.has(id)) return;
    loops.set(id, { timer: null, failures: 0, busy: false });
    void round(id).finally(() => schedule(id));
  }

  function stop(sessionId: string): void {
    const loop = loops.get(sessionId);
    if (loop?.timer) clearTimeout(loop.timer);
    loops.delete(sessionId);
  }

  function listenOnce(): void {
    if (listening) return;
    listening = true;
    // A guest's task finished on this machine: the next round shows it without waiting.
    void listen<{ sessionId: string }>("collab:run-changed", (event) => void get().tickNow(event.payload.sessionId));
  }

  return {
    views: {},
    ticks: {},
    errors: {},
    openGuest: null,

    load: async (workspaceId) => {
      listenOnce();
      const views = await collabRunSessions(workspaceId).catch(() => [] as CollabSessionView[]);
      const keep = new Set(views.map((v) => v.session.id));
      for (const id of [...loops.keys()]) if (!keep.has(id)) stop(id);
      set({ views: Object.fromEntries(views.map((v) => [v.session.id, v])) });
      views.forEach(start);
    },

    ensureRun: async (runId) => {
      const known = Object.values(get().views).find((v) => v.runId === runId);
      if (known) return known;
      const view = await collabRunFor(runId).catch(() => null);
      if (view) start(view);
      return view;
    },

    share: async (args) => {
      const shared = await collabRunShare(args);
      start(shared.view);
      return shared.link;
    },

    invite: (sessionId) => collabInvite(sessionId),

    setSeats: async (sessionId, seats) => {
      await collabRunSetSeats(sessionId, seats);
      await get().tickNow(sessionId);
    },

    takeSeat: async (sessionId, memberId, agentId) => {
      await collabRunTakeSeat(sessionId, memberId, agentId);
      await get().tickNow(sessionId);
    },

    freeSeat: async (sessionId, memberId) => {
      await collabRunFreeSeat(sessionId, memberId);
      await get().tickNow(sessionId);
    },

    accept: async (sessionId, itemId) => {
      await collabRunAccept(sessionId, itemId);
      await get().tickNow(sessionId);
    },

    decline: async (sessionId, itemId, reason) => {
      await collabRunDecline(sessionId, itemId, reason);
      await get().tickNow(sessionId);
    },

    note: async (sessionId, to, text) => {
      await collabRunNote(sessionId, to, text);
      await get().tickNow(sessionId);
    },

    leave: async (sessionId) => {
      stop(sessionId);
      await collabLeave(sessionId, true);
      set((s) => {
        const { [sessionId]: _v, ...views } = s.views;
        const { [sessionId]: _t, ...ticks } = s.ticks;
        return { views, ticks, openGuest: s.openGuest === sessionId ? null : s.openGuest };
      });
    },

    tickNow: async (sessionId) => {
      if (!loops.has(sessionId)) return;
      await round(sessionId);
    },

    openGuestRun: (sessionId) => set({ openGuest: sessionId }),
  };
});

/** The seat of a member of a run shared from this machine, if it is one. */
export function useSeatOf(runId: string, memberId: string): CollabRunSeat | null {
  return useSharedRunStore((s) => {
    const view = Object.values(s.views).find((v) => v.runId === runId);
    return view ? (s.ticks[view.session.id]?.seats.find((seat) => seat.memberId === memberId) ?? null) : null;
  });
}

/** Guest sessions: runs other people shared with this person. */
export function guestViews(views: Record<string, CollabSessionView>): CollabSessionView[] {
  return Object.values(views).filter((v) => !v.isOwner);
}

/** How many offers wait for this person's answer across every shared run. */
export function waitingOffers(ticks: Record<string, CollabRunTick>): number {
  return Object.values(ticks).reduce((n, tick) => n + (tick.owner ? 0 : tick.offers.length), 0);
}
