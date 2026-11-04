import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  backlogDelete,
  backlogImportTickets,
  backlogLink,
  backlogList,
  backlogMove,
  backlogSave,
} from "../lib/tauri/crewCommands";
import { deriveStatus, type WorkIndex } from "../lib/backlog/status";
import type { BacklogItem, BacklogLinkKind, BacklogStatus, TicketImport } from "../types/crew";
import { pushErrorToast } from "./toastStore";

/**
 * The workspace's local backlog. Writes are optimistic, as in `agentsStore`; a refusal reloads.
 * Columns past «ready» follow the work linked to each card (`lib/backlog/status.ts`), and when the
 * work has moved further than the stored column, `syncDerived` writes it back so the board is right
 * after a restart without loading every run.
 */
interface BacklogState {
  workspaceId: string | null;
  items: BacklogItem[];
  loaded: boolean;
  load: (workspaceId: string | null) => Promise<void>;
  save: (item: BacklogItem) => Promise<BacklogItem | null>;
  move: (id: string, status: BacklogStatus, rank: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
  link: (itemId: string, kind: BacklogLinkKind, refId: string) => Promise<void>;
  importTickets: (tickets: TicketImport[]) => Promise<BacklogItem[]>;
  syncDerived: (index: WorkIndex) => void;
}

export const useBacklogStore = create<BacklogState>((set, get) => ({
  workspaceId: null,
  items: [],
  loaded: false,

  load: async (workspaceId) => {
    if (!workspaceId) {
      set({ workspaceId: null, items: [], loaded: false });
      return;
    }
    const items = await backlogList(workspaceId).catch(() => [] as BacklogItem[]);
    set({ workspaceId, items, loaded: true });
  },

  save: async (item) => {
    try {
      const saved = await backlogSave(item);
      set((s) => ({ items: [...s.items.filter((x) => x.id !== saved.id), saved] }));
      return saved;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  move: async (id, status, rank) => {
    set((s) => ({ items: s.items.map((x) => (x.id === id ? { ...x, status, rank } : x)) }));
    await backlogMove(id, status, rank).catch((error: unknown) => {
      pushErrorToast(String(error));
      void get().load(get().workspaceId);
    });
  },

  remove: async (id) => {
    set((s) => ({ items: s.items.filter((x) => x.id !== id && x.parent_id !== id) }));
    await backlogDelete(id).catch((error: unknown) => pushErrorToast(String(error)));
  },

  link: async (itemId, kind, refId) => {
    const link = await backlogLink(itemId, kind, refId).catch((error: unknown) => {
      pushErrorToast(String(error));
      return null;
    });
    if (!link) return;
    set((s) => ({
      items: s.items.map((x) => (x.id === itemId && !x.links.some((l) => l.id === link.id) ? { ...x, links: [...x.links, link] } : x)),
    }));
  },

  importTickets: async (tickets) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId || tickets.length === 0) return [];
    const cards = await backlogImportTickets(workspaceId, tickets).catch((error: unknown) => {
      pushErrorToast(String(error));
      return [] as BacklogItem[];
    });
    set((s) => ({ items: [...s.items.filter((x) => !cards.some((c) => c.id === x.id)), ...cards] }));
    return cards;
  },

  syncDerived: (index) => {
    for (const item of get().items) {
      const derived = deriveStatus(item, index);
      if (derived !== item.status) void get().move(item.id, derived, item.rank);
    }
  },
}));

if (typeof window !== "undefined") {
  void listen<{ workspaceId: string }>("crew:backlog", (event) => {
    const store = useBacklogStore.getState();
    if (event.payload.workspaceId === store.workspaceId) void store.load(store.workspaceId);
  }).catch(() => undefined);
}
