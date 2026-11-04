import { create } from "zustand";
import { chatLineageForget, chatLineageLink, chatLineageList, type ChatLink } from "../lib/tauri/chatLineage";

/**
 * Subchats: which assistant conversation hangs under which (`chat_lineage.rs`), per workspace.
 *
 * Read by the three places that nest them — the Inbox's Recientes, the tab strip and the chat's own
 * subchat row. Written by «Nuevo subchat» (here, before the blank tab opens) and by «Bifurcar» (the
 * backend links the fork; the caller reloads).
 */
interface ChatLineageState {
  byWorkspace: Record<string, ChatLink[]>;
  load: (workspaceId: string, opts?: { force?: boolean }) => Promise<void>;
  /** Links `link.conversationId` under `link.parentId`, in memory at once and on disk. */
  link: (workspaceId: string, link: Omit<ChatLink, "createdAt" | "branchedTurn"> & { branchedTurn?: number | null }) => Promise<void>;
  /** The conversation went away (or a blank subchat was closed unwritten): its children move up. */
  forget: (conversationId: string) => void;
  /** `forget`'s memory half, for a conversation the backend has already let go of (a delete). */
  dropLocal: (conversationId: string) => void;
}

const loads = new Map<string, Promise<void>>();

export const EMPTY_LINKS: ChatLink[] = [];

export const useChatLineageStore = create<ChatLineageState>((set, get) => ({
  byWorkspace: {},

  load: (workspaceId, opts = {}) => {
    if (!workspaceId) return Promise.resolve();
    const pending = loads.get(workspaceId);
    if (pending && !opts.force) return pending;
    const task = chatLineageList(workspaceId)
      .then((links) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: links } })))
      .catch(() => {});
    loads.set(workspaceId, task);
    return task;
  },

  link: async (workspaceId, link) => {
    const row: ChatLink = { ...link, branchedTurn: link.branchedTurn ?? null, createdAt: new Date().toISOString() };
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: [...(s.byWorkspace[workspaceId] ?? []).filter((l) => l.conversationId !== link.conversationId), row],
      },
    }));
    const ok = await chatLineageLink(link).catch(() => false);
    if (!ok) void get().load(workspaceId, { force: true });
  },

  forget: (conversationId) => {
    get().dropLocal(conversationId);
    void chatLineageForget(conversationId).catch(() => {});
  },

  dropLocal: (conversationId) => {
    set((s) => {
      const byWorkspace: Record<string, ChatLink[]> = {};
      for (const [ws, links] of Object.entries(s.byWorkspace)) {
        const gone = links.find((l) => l.conversationId === conversationId);
        byWorkspace[ws] = links
          .filter((l) => l.conversationId !== conversationId)
          .flatMap((l) => {
            if (l.parentId !== conversationId) return [l];
            return gone ? [{ ...l, parentId: gone.parentId }] : [];
          });
      }
      return { byWorkspace };
    });
  },
}));

/** Child → parent, for one workspace's links. */
export function parentMap(links: readonly ChatLink[]): Map<string, string> {
  return new Map(links.map((l) => [l.conversationId, l.parentId]));
}

/** How deep the UI indents; anything below is drawn at this depth. */
export const MAX_NEST_DEPTH = 3;

/**
 * Orders `items` so each one follows its parent (and the parent's earlier children), keeping the
 * given order among siblings and among roots. An item whose parent is not in the list is a root —
 * a subchat whose parent was deleted, or is filtered out of what is shown, is still shown. Pure.
 */
export function nestByLineage<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  parents: ReadonlyMap<string, string>,
): { item: T; depth: number; hasChildren: boolean }[] {
  const present = new Map(items.map((item) => [idOf(item), item]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parent = parents.get(idOf(item));
    if (parent && parent !== idOf(item) && present.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(item);
      children.set(parent, list);
    } else {
      roots.push(item);
    }
  }
  const out: { item: T; depth: number; hasChildren: boolean }[] = [];
  const seen = new Set<string>();
  const walk = (item: T, depth: number) => {
    const id = idOf(item);
    if (seen.has(id)) return;
    seen.add(id);
    const kids = children.get(id) ?? [];
    out.push({ item, depth: Math.min(depth, MAX_NEST_DEPTH), hasChildren: kids.length > 0 });
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // A cycle in the data leaves its members unreached from any root; still list them.
  for (const item of items) if (!seen.has(idOf(item))) walk(item, 0);
  return out;
}
