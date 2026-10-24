import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import {
  ticketsLinks,
  ticketsList,
  ticketsMove,
  ticketsOnPrCreated,
  ticketsOnPrMerged,
  ticketsSync,
  type Ticket,
  type TicketAuto,
  type TicketLink,
  type TicketMove,
  type TicketSourceError,
} from "../lib/tauri/ticketCommands";
import { NO_FILTERS, displayKey, ticketUid, type TicketFilters } from "../lib/tickets/ticketKeys";
import { translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useAgentsStore } from "./agentsStore";
import { useChainStore } from "./chainStore";
import { useUiStore } from "./uiStore";
import { useWorktreeViewStore } from "./worktreeViewStore";
import type { PullRequestSummary } from "../types/domain";

/**
 * «Tickets» in Agentes › Tareas: what is assigned to you on every connected board, the links
 * «Empezar» recorded between a ticket and a branch, and the moves CodeFlow made on its own.
 *
 * The list is someone else's API, so it is read when asked for — the section opening, its refresh
 * button — and kept, trimmed, in `tickets_cache`, so the projects panel can name the ticket of a
 * repository's branch at launch without asking any board (user, 2026-10-23: the chip in the panel
 * must not add a network call per row).
 */

const CACHE_KEY = "tickets_cache";
/** Enough for anyone's queue; a chip only needs the ones a branch could name. */
const CACHE_MAX = 400;
export const AUTO_MOVE_KEY = "tickets_auto_move";
export const BRANCH_PREFIX_KEY = "tickets_branch_prefix";
export const BUG_PREFIX_KEY = "tickets_bug_prefix";
export const TARGET_STATES_KEY = "tickets_target_states";

interface TicketState {
  tickets: Ticket[];
  errors: TicketSourceError[];
  loading: boolean;
  /** A list has been read (or the cache loaded) this session. */
  loaded: boolean;
  /** When the list was last read from the boards, epoch ms. */
  fetchedAt: number;
  links: TicketLink[];
  linksWorkspace: string | null;
  filters: TicketFilters;
  selectedUid: string | null;
  /** The last move CodeFlow (or the user, from the pane) made, per ticket uid — what undo puts back. */
  lastMove: Record<string, TicketMove>;

  loadCache: () => Promise<void>;
  refresh: (workspaceId: string | null) => Promise<void>;
  loadLinks: (workspaceId: string) => Promise<void>;
  setFilters: (filters: TicketFilters) => void;
  select: (uid: string | null) => void;
  /** Opens a ticket in Agentes › Tareas — what the panel chip's click does. */
  reveal: (uid: string) => void;
  applyMove: (move: TicketMove) => void;
  undo: (uid: string) => Promise<void>;
  onPrCreated: (projectId: string, branch: string, pr: PullRequestSummary) => Promise<void>;
  onPrMerged: (projectId: string, branch: string) => Promise<void>;
}

function persist(tickets: Ticket[]) {
  void setSetting(CACHE_KEY, JSON.stringify(tickets.slice(0, CACHE_MAX))).catch(() => undefined);
}

/** One loader for every caller: the panel's chips and the section both ask on mount. */
let cacheRead: Promise<void> | null = null;

export const useTicketStore = create<TicketState>((set, get) => ({
  tickets: [],
  errors: [],
  loading: false,
  loaded: false,
  fetchedAt: 0,
  links: [],
  linksWorkspace: null,
  filters: NO_FILTERS,
  selectedUid: null,
  lastMove: {},

  loadCache: () => {
    cacheRead ??= (async () => {
      const raw = await getSetting(CACHE_KEY).catch(() => null);
      if (!raw || get().fetchedAt > 0) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          set({ tickets: (parsed as Ticket[]).filter((t) => t && typeof t.provider === "string"), loaded: true });
        }
      } catch {
        // A corrupt cache is an empty one; the next refresh writes a good one over it.
      }
    })();
    return cacheRead;
  },

  refresh: async (workspaceId) => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const list = await ticketsList();
      set({ tickets: list.tickets, errors: list.errors, loaded: true, fetchedAt: Date.now() });
      persist(list.tickets);
      if (workspaceId) {
        // A pull request merged on the website moves its ticket on the next look at the list.
        const outcomes = await ticketsSync(workspaceId).catch(() => [] as TicketAuto[]);
        for (const outcome of outcomes) report(outcome);
        await get().loadLinks(workspaceId);
      }
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      set({ loading: false });
    }
  },

  loadLinks: async (workspaceId) => {
    const links = await ticketsLinks(workspaceId).catch(() => null);
    if (links) set({ links, linksWorkspace: workspaceId });
  },

  setFilters: (filters) => set({ filters }),

  select: (uid) => {
    if (uid) {
      // One thing in the middle column: a ticket replaces a task, a chain or a template.
      useAgentsStore.setState({ selectedId: null });
      useChainStore.setState({ selectedId: null, selectedTemplateId: null });
    }
    set({ selectedUid: uid });
  },

  reveal: (uid) => {
    useUiStore.getState().setActiveView("agents");
    // The section lives in the «Tareas» tree, which only the tasks layout draws.
    useWorktreeViewStore.getState().setLayout("tasks");
    useAgentsStore.getState().setGroupBy("tree");
    get().select(uid);
  },

  applyMove: (move) => {
    const uid = ticketUid(move.ticket);
    set((s) => {
      const tickets = s.tickets.map((t) => (ticketUid(t) === uid ? move.ticket : t));
      persist(tickets);
      return {
        tickets,
        links: s.links.map((l) => (l.ticket_uid === uid ? { ...l, ticket: move.ticket } : l)),
        lastMove: { ...s.lastMove, [uid]: move },
      };
    });
  },

  undo: async (uid) => {
    const move = get().lastMove[uid];
    if (!move || !move.from) return;
    try {
      const back = await ticketsMove(move.ticket, move.from);
      get().applyMove(back);
      set((s) => {
        const { [uid]: _gone, ...rest } = s.lastMove;
        return { lastMove: rest };
      });
      useToastStore.getState().pushToast(translate("tickets.undone", { key: displayKey(back.ticket), state: back.to }), "info");
    } catch (e) {
      pushErrorToast(String(e));
    }
  },

  onPrCreated: async (projectId, branch, pr) => {
    const outcome = await ticketsOnPrCreated(projectId, branch, pr.id, pr.url).catch(() => null);
    if (outcome) report(outcome);
    const workspaceId = get().linksWorkspace;
    if (workspaceId) await get().loadLinks(workspaceId);
  },

  onPrMerged: async (projectId, branch) => {
    const outcome = await ticketsOnPrMerged(projectId, branch).catch(() => null);
    if (outcome) report(outcome);
    const workspaceId = get().linksWorkspace;
    if (workspaceId) await get().loadLinks(workspaceId);
  },
}));

/** Says what an automatic move did — or why it could not — and keeps it for undo. */
function report(outcome: TicketAuto) {
  if (outcome.moved) {
    useTicketStore.getState().applyMove(outcome.moved);
    useToastStore
      .getState()
      .pushToast(translate("tickets.moved", { key: displayKey(outcome.moved.ticket), state: outcome.moved.to }), "success");
  } else if (outcome.error) {
    pushErrorToast(translate("tickets.moveFailed", { error: outcome.error }));
  }
}
