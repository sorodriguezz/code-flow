import { create } from "zustand";
import { listRemovedProjects } from "../lib/tauri/commands";
import type { RemovedProject } from "../types/domain";

/**
 * The repositories removed from each workspace whose chats are still kept
 * (`queries::remove_project_keeping_chats`): the Inbox lists their chats under the old name, and a
 * chat of one opens read-only.
 *
 * Its own store, and one that imports no other: `workspaceStore` reads it to answer which workspace
 * a project id belongs to, so a removed repository's chat tab still lands in its workspace.
 */
interface RemovedProjectsState {
  byWorkspace: Record<string, RemovedProject[]>;
  load: (workspaceId: string) => Promise<void>;
  /** The removed repository `projectId` was, wherever it is loaded. */
  find: (projectId: string) => RemovedProject | null;
}

const EMPTY: RemovedProject[] = [];

export const useRemovedProjectsStore = create<RemovedProjectsState>((set, get) => ({
  byWorkspace: {},
  load: async (workspaceId) => {
    const list = await listRemovedProjects(workspaceId).catch(() => null);
    if (list) set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: list } }));
  },
  find: (projectId) => {
    for (const list of Object.values(get().byWorkspace)) {
      const hit = list.find((p) => p.id === projectId);
      if (hit) return hit;
    }
    return null;
  },
}));

/** A workspace's removed repositories, stable when there are none. */
export function useRemovedProjects(workspaceId: string | null | undefined): RemovedProject[] {
  return useRemovedProjectsStore((s) => (workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY) : EMPTY));
}
