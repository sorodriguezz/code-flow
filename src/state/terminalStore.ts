import { create } from "zustand";
import { closeTerminal, getSetting, openTerminal, setSetting } from "../lib/tauri/commands";

export interface TerminalTab {
  id: string;
  /** `Terminal N` until the user renames it. Deliberately *not* persisted anywhere: a title
   * describes a live shell, so it's meaningless once that shell is gone. It therefore lives
   * exactly as long as this store does — until the tab is closed or the app exits. */
  title: string;
}

interface ProjectTerminals {
  tabs: TerminalTab[];
  /** Each entry is a "split group" — terminal ids shown side by side together. A terminal
   * belongs to exactly one group. Only the group containing `focusedId` is ever shown in the
   * dock, so switching to any terminal in a split reveals the whole split, VS Code–style,
   * instead of collapsing it down to just that one pane. */
  groups: string[][];
  focusedId: string | null;
  nextNumber: number;
}

function emptyProject(): ProjectTerminals {
  return { tabs: [], groups: [], focusedId: null, nextNumber: 1 };
}

/** The group currently shown in the dock: whichever one contains `focusedId`, falling back to
 * the most recently created group if that id is stale (e.g. right after its terminal closed). */
export function activeGroup(proj: ProjectTerminals | undefined): string[] {
  if (!proj) return [];
  const found = proj.focusedId ? proj.groups.find((g) => g.includes(proj.focusedId!)) : undefined;
  return found ?? proj.groups[proj.groups.length - 1] ?? [];
}

const PANEL_OPEN_KEY = "terminal_panel_open";

interface TerminalState {
  /** Hidden by default — only opens when the user asks for it (or a new terminal is created). */
  panelOpen: boolean;
  byProject: Record<string, ProjectTerminals>;
  init: () => Promise<void>;
  togglePanel: () => void;
  /** With `split: true`, adds the new terminal to whichever group is currently active instead
   * of starting a new one — otherwise every new terminal gets its own group. */
  openNew: (projectId: string, cwd: string, opts?: { split?: boolean }) => Promise<void>;
  close: (projectId: string, id: string) => Promise<void>;
  /** Shows the group `id` belongs to — never changes group membership by itself. */
  focus: (projectId: string, id: string) => void;
  /** Retitles a tab. A blank/whitespace-only title is ignored rather than blanking the tab,
   * so cancelling out of the inline editor with an empty field is harmless. */
  rename: (projectId: string, id: string, title: string) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  panelOpen: false,
  byProject: {},

  init: async () => {
    const raw = await getSetting(PANEL_OPEN_KEY).catch(() => null);
    set({ panelOpen: raw === "1" });
  },

  togglePanel: () => {
    const next = !get().panelOpen;
    set({ panelOpen: next });
    void setSetting(PANEL_OPEN_KEY, next ? "1" : "0");
  },

  openNew: async (projectId, cwd, opts) => {
    const id = await openTerminal(cwd);
    set((s) => {
      const proj = s.byProject[projectId] ?? emptyProject();
      const title = `Terminal ${proj.nextNumber}`;
      const tabs = [...proj.tabs, { id, title }];
      const current = activeGroup(proj);
      const groups =
        opts?.split && current.length > 0
          ? proj.groups.map((g) => (g === current ? [...g, id] : g))
          : [...proj.groups, [id]];
      return {
        panelOpen: true,
        byProject: { ...s.byProject, [projectId]: { tabs, groups, focusedId: id, nextNumber: proj.nextNumber + 1 } },
      };
    });
    void setSetting(PANEL_OPEN_KEY, "1");
  },

  close: async (projectId, id) => {
    await closeTerminal(id).catch(() => {});
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const closedGroup = proj.groups.find((g) => g.includes(id));
      const tabs = proj.tabs.filter((tab) => tab.id !== id);
      const groups = proj.groups.map((g) => g.filter((gid) => gid !== id)).filter((g) => g.length > 0);

      let focusedId = proj.focusedId;
      if (focusedId === id) {
        // Prefer staying in the same split if other panes remain in it, otherwise fall back
        // to whatever group is now last.
        const remainingSiblings = closedGroup?.filter((gid) => gid !== id) ?? [];
        focusedId = remainingSiblings[0] ?? groups[groups.length - 1]?.[0] ?? null;
      }

      return { byProject: { ...s.byProject, [projectId]: { ...proj, tabs, groups, focusedId } } };
    });
  },

  focus: (projectId, id) => {
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      return { byProject: { ...s.byProject, [projectId]: { ...proj, focusedId: id } } };
    });
  },

  rename: (projectId, id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((s) => {
      const proj = s.byProject[projectId];
      if (!proj) return s;
      const tabs = proj.tabs.map((tab) => (tab.id === id ? { ...tab, title: trimmed } : tab));
      return { byProject: { ...s.byProject, [projectId]: { ...proj, tabs } } };
    });
  },
}));
