import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";
import type { Project } from "../types/domain";

/**
 * How a workspace's repositories are arranged in the projects panel beyond their order: which are
 * **pinned** to the top, and which **groups** — named, foldable sections — the rest are filed in.
 *
 * One settings row per workspace (`sidebar_layout:<id>`), not columns on `projects`: it is how one
 * panel draws a list, the same kind of thing `sidebar_folded_sections` is, and it reaches every
 * window through `watchSettings`. The order *within* a section is still `sort_order`, the one
 * Settings drags — so the two screens keep agreeing about it.
 *
 * Ids that no longer name a project (removed, moved to another workspace) are simply ignored where
 * they are read, and dropped on the next write.
 */
export interface SidebarGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface SidebarLayout {
  pinned: string[];
  groups: SidebarGroup[];
  /** Project id → group id. */
  groupOf: Record<string, string>;
}

const EMPTY: SidebarLayout = { pinned: [], groups: [], groupOf: {} };
const PREFIX = "sidebar_layout:";
const keyOf = (workspaceId: string) => `${PREFIX}${workspaceId}`;

function parse(raw: string | null): SidebarLayout {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<SidebarLayout> | null;
    if (!value || typeof value !== "object") return EMPTY;
    return {
      pinned: Array.isArray(value.pinned) ? value.pinned.filter((id): id is string => typeof id === "string") : [],
      groups: Array.isArray(value.groups)
        ? value.groups
            .filter((g): g is SidebarGroup => !!g && typeof g.id === "string" && typeof g.name === "string")
            .map((g) => ({ id: g.id, name: g.name, collapsed: g.collapsed === true }))
        : [],
      groupOf: value.groupOf && typeof value.groupOf === "object" ? (value.groupOf as Record<string, string>) : {},
    };
  } catch {
    return EMPTY;
  }
}

/** A section of the panel, top to bottom: the pinned ones, each group, then everything else. */
export type SidebarSection =
  | { kind: "pinned"; projects: Project[] }
  | { kind: "group"; group: SidebarGroup; projects: Project[] }
  | { kind: "rest"; projects: Project[] };

/**
 * `projects` (in `sort_order`) laid out by `layout`. A pinned project is in the pinned section even
 * when it is also filed in a group — pinning is "keep this one in sight". Every group is listed,
 * empty ones too, so a group just made has somewhere to drop a repository into.
 */
export function sectionsOf(projects: Project[], layout: SidebarLayout): SidebarSection[] {
  const known = new Set(layout.groups.map((g) => g.id));
  const pinned = projects.filter((p) => layout.pinned.includes(p.id));
  const rest = projects.filter((p) => !layout.pinned.includes(p.id));
  const sections: SidebarSection[] = [];
  if (pinned.length > 0) sections.push({ kind: "pinned", projects: pinned });
  for (const group of layout.groups) {
    sections.push({ kind: "group", group, projects: rest.filter((p) => layout.groupOf[p.id] === group.id) });
  }
  sections.push({ kind: "rest", projects: rest.filter((p) => !known.has(layout.groupOf[p.id] ?? "")) });
  return sections;
}

interface SidebarLayoutState {
  byWorkspace: Record<string, SidebarLayout>;
  load: (workspaceId: string) => Promise<void>;
  togglePinned: (workspaceId: string, projectId: string) => void;
  setPinned: (workspaceId: string, projectId: string, pinned: boolean) => void;
  /** Answers the new group's id. */
  createGroup: (workspaceId: string, name: string) => string;
  renameGroup: (workspaceId: string, groupId: string, name: string) => void;
  /** The group goes; its repositories go back to the ungrouped list. */
  deleteGroup: (workspaceId: string, groupId: string) => void;
  toggleGroup: (workspaceId: string, groupId: string) => void;
  /** `null` takes it out of any group. */
  setGroup: (workspaceId: string, projectId: string, groupId: string | null) => void;
}

export const useSidebarLayoutStore = create<SidebarLayoutState>((set, get) => {
  const write = (workspaceId: string, next: SidebarLayout) => {
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: next } }));
    void setSetting(keyOf(workspaceId), JSON.stringify(next)).catch(() => {});
  };
  const current = (workspaceId: string) => get().byWorkspace[workspaceId] ?? EMPTY;

  return {
    byWorkspace: {},

    load: async (workspaceId) => {
      const layout = parse(await getSetting(keyOf(workspaceId)).catch(() => null));
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: layout } }));
    },

    togglePinned: (workspaceId, projectId) => {
      get().setPinned(workspaceId, projectId, !current(workspaceId).pinned.includes(projectId));
    },

    setPinned: (workspaceId, projectId, pinned) => {
      const layout = current(workspaceId);
      if (layout.pinned.includes(projectId) === pinned) return;
      write(workspaceId, {
        ...layout,
        pinned: pinned ? [...layout.pinned, projectId] : layout.pinned.filter((id) => id !== projectId),
      });
    },

    createGroup: (workspaceId, name) => {
      const layout = current(workspaceId);
      const id = `g-${crypto.randomUUID()}`;
      write(workspaceId, { ...layout, groups: [...layout.groups, { id, name: name.trim() || "—", collapsed: false }] });
      return id;
    },

    renameGroup: (workspaceId, groupId, name) => {
      const layout = current(workspaceId);
      const trimmed = name.trim();
      if (!trimmed) return;
      write(workspaceId, { ...layout, groups: layout.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)) });
    },

    deleteGroup: (workspaceId, groupId) => {
      const layout = current(workspaceId);
      write(workspaceId, {
        ...layout,
        groups: layout.groups.filter((g) => g.id !== groupId),
        groupOf: Object.fromEntries(Object.entries(layout.groupOf).filter(([, g]) => g !== groupId)),
      });
    },

    toggleGroup: (workspaceId, groupId) => {
      const layout = current(workspaceId);
      write(workspaceId, {
        ...layout,
        groups: layout.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)),
      });
    },

    setGroup: (workspaceId, projectId, groupId) => {
      const layout = current(workspaceId);
      const groupOf = { ...layout.groupOf };
      if (groupId) groupOf[projectId] = groupId;
      else delete groupOf[projectId];
      write(workspaceId, { ...layout, groupOf });
    },
  };
});

export function useSidebarLayout(workspaceId: string | null): SidebarLayout {
  return useSidebarLayoutStore((s) => (workspaceId ? s.byWorkspace[workspaceId] ?? EMPTY : EMPTY));
}

// Another window rearranged it: read again what is loaded here.
watchSettings(
  (key) => key.startsWith(PREFIX),
  () => {
    for (const workspaceId of Object.keys(useSidebarLayoutStore.getState().byWorkspace)) {
      void useSidebarLayoutStore.getState().load(workspaceId);
    }
  },
);
