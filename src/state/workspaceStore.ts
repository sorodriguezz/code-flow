import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { WINDOW } from "../lib/windowIdentity";
import { pushErrorToast } from "./toastStore";
import type { NewProject, Project, Workspace } from "../types/domain";

const LAST_WORKSPACE_KEY = "last_active_workspace_id";

/// Name of the workspace seeded on a fresh install, on every platform. Only applies when the
/// database has no workspaces at all — an existing install keeps whatever it already has.
const DEFAULT_WORKSPACE_NAME = "Flow";
const LAST_PROJECT_KEY = "last_active_project_id";

/**
 * Where this window records what it is looking at.
 *
 * **One row per window, not one row per app.** Every window now chooses its own workspace, so a
 * single `last_active_workspace_id` would be three windows writing over each other — the last one
 * to switch decides where all of them open next time, which is the opposite of independent.
 *
 * The main window keeps the unsuffixed key. That is not only for compatibility with what is already
 * stored: it is also a satellite's fallback when it has nothing better — no opener, and no workspace
 * of its own that still exists. Where a window opens is decided by `opener` first.
 */
function windowKey(base: string): string {
  return WINDOW.main ? base : `${base}:${WINDOW.label}`;
}

/**
 * The workspace this window was opened from, until the first load has used it.
 *
 * **Opening a window is saying where it should be.** The window's own key alone made every app
 * window come back on whatever it was last switched to — so an app opened from "Tienda" showed the
 * workspace it was on a week ago, and one whose last workspace had since been deleted fell through
 * to the first in the list. The opener's workspace travels in the query string (see
 * `open_satellite`) and wins at boot; the window's own key is what a tray restore goes back to.
 *
 * Consumed rather than read each time: it answers "where does this window open", not "where does
 * it go when it switches".
 */
let opener: string | null = WINDOW.openedIn;

/** The first of `ids` that names something in `rows`. */
function firstKnown<T extends { id: string }>(rows: T[], ids: Array<string | null>): T | undefined {
  for (const id of ids) {
    const found = id ? rows.find((row) => row.id === id) : undefined;
    if (found) return found;
  }
  return undefined;
}

async function setting(key: string): Promise<string | null> {
  return api.getSetting(key).catch(() => null);
}

interface WorkspaceState {
  workspaces: Workspace[];
  projectsByWorkspace: Record<string, Project[]>;
  activeWorkspaceId: string | null;
  activeProjectId: string | null;
  loading: boolean;

  loadWorkspaces: () => Promise<void>;
  loadProjects: (workspaceId: string) => Promise<void>;
  addWorkspace: (name: string, icon: string, color: string) => Promise<Workspace>;
  removeWorkspace: (id: string) => Promise<void>;
  setWorkspaceColor: (id: string, color: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  addProject: (input: NewProject) => Promise<Project>;
  removeProject: (id: string, workspaceId: string) => Promise<void>;
  setProjectColor: (id: string, workspaceId: string, color: string) => Promise<void>;
  /**
   * Replaces one project row with a fresher copy the backend just handed back.
   *
   * The gap this closes: nothing else in this store ever updates a project's *link* columns
   * (`github_owner`, `gitlab_project`, `ado_*`). They are written on the Rust side — by
   * `auto_link_project`, which runs the first time a repository's pull requests are unfolded, and
   * by the three connect modals — and until now the frontend never heard about it. So a repository
   * that had just been linked went on looking unlinked here until the next `loadProjects`, which
   * in practice meant until the app was restarted.
   *
   * That was invisible while nothing rendered off those columns. The Pipelines tab renders off
   * them: it appears exactly when a project is linked to a connected host, so a stale row is a tab
   * that does not show up after you connect. `auto_link_project` already returns the refreshed
   * `Project` in its `Linked` result — it was simply being discarded.
   *
   * Local only; the row it takes has already been written.
   */
  patchProject: (project: Project) => void;
  moveProject: (id: string, fromWorkspaceId: string, toWorkspaceId: string) => Promise<void>;
  /** Moves one repository to a new position in its workspace's list. Optimistic: the row is where
   *  the user dropped it before the write goes out, because a list that snaps back for a moment
   *  reads as a failed drag. */
  reorderProject: (workspaceId: string, id: string, toIndex: number) => Promise<void>;
  /** The same gesture one level up, for the workspaces themselves. Optimistic for the same reason. */
  reorderWorkspace: (id: string, toIndex: number) => Promise<void>;
  setActiveWorkspace: (id: string) => void;
  /**
   * Points this window at a workspace **without recording it as a choice**.
   *
   * The difference from `setActiveWorkspace` is the whole reason this exists: that one persists
   * "this is where this window opens next time", which is only true when a person picked it. This
   * one is for a workspace that was *derived* — a repository window resolving the workspace its own
   * project belongs to. Writing that down would mean re-attaching and re-detaching a repo window
   * silently rewrote where it opens.
   *
   * `null` is a real argument: a workspace can be deleted out from under a window, and one left
   * pointing at it would be showing rows that are gone.
   */
  followWorkspace: (id: string | null) => Promise<void>;
  setActiveProject: (id: string) => void;
  /** Brings a project into focus from anywhere, crossing workspaces if it lives in another one —
   * awaitable, so a caller that needs `activeProject()` to already resolve (opening a PR from a
   * pasted link) can wait for the workspace's projects to load instead of racing them. */
  focusProject: (workspaceId: string, projectId: string) => Promise<void>;

  activeProject: () => Project | null;
  /** Which workspace a repository belongs to, for work that outlives the screen it was started
   * from — a review filed against a project has to name that project's workspace, not whichever
   * one the user has wandered into by the time it finishes. `null` for a project of a workspace
   * whose list was never loaded, which in practice means one the user has not opened. */
  workspaceOfProject: (projectId: string) => string | null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  projectsByWorkspace: {},
  activeWorkspaceId: null,
  activeProjectId: null,
  loading: false,

  loadWorkspaces: async () => {
    set({ loading: true });
    try {
      // Atomic: query then (only if truly empty) create the default, all in one async
      // flow. This used to be a separate effect keyed on workspaces.length, which raced
      // with this load and created a duplicate default workspace on every app start.
      let workspaces = await api.listWorkspaces();
      if (workspaces.length === 0) {
        const defaultWorkspace = await api.createWorkspace(DEFAULT_WORKSPACE_NAME, "briefcase", "#6366f1");
        workspaces = [defaultWorkspace];
      }
      set({ workspaces });
      if (!get().activeWorkspaceId && workspaces.length > 0) {
        // The main window: where it was. A satellite: where it was opened from (see `opener`),
        // else its own last choice (a tray restore), else where the main window is — and only
        // then the first workspace, which is a fallback, not a default. Each candidate is checked
        // against the list, so a recorded workspace that has since been deleted moves on to the
        // next one instead of straight to the first.
        const ids = WINDOW.main
          ? [await setting(LAST_WORKSPACE_KEY)]
          : [opener, await setting(windowKey(LAST_WORKSPACE_KEY)), await setting(LAST_WORKSPACE_KEY)];
        const target = firstKnown(workspaces, ids) ?? workspaces[0];
        set({ activeWorkspaceId: target.id });
        if (!WINDOW.main && target.id === opener) {
          // Recorded, so that putting this window away and back brings it here rather than to
          // wherever it was before it was opened this time.
          void api.setSetting(windowKey(LAST_WORKSPACE_KEY), target.id);
        } else {
          opener = null;
        }
        await get().loadProjects(target.id);
      }
    } finally {
      set({ loading: false });
    }
  },

  loadProjects: async (workspaceId) => {
    const projects = await api.listProjects(workspaceId);
    set((s) => ({ projectsByWorkspace: { ...s.projectsByWorkspace, [workspaceId]: projects } }));
    // A window just opened from another lands on that window's repository too, when it is in this
    // workspace. Apps are detached from the main window, so the main window's key is the opener's.
    const fromOpener = !WINDOW.main && opener === workspaceId;
    if (fromOpener) opener = null;
    if (!get().activeProjectId && projects.length > 0) {
      const ids = fromOpener
        ? [await setting(LAST_PROJECT_KEY), await setting(windowKey(LAST_PROJECT_KEY))]
        : [await setting(windowKey(LAST_PROJECT_KEY))];
      set({ activeProjectId: (firstKnown(projects, ids) ?? projects[0]).id });
    }
  },

  addWorkspace: async (name, icon, color) => {
    const ws = await api.createWorkspace(name, icon, color);
    set((s) => ({ workspaces: [...s.workspaces, ws] }));
    return ws;
  },

  removeWorkspace: async (id) => {
    await api.deleteWorkspace(id);
    set((s) => {
      const { [id]: _removed, ...restProjects } = s.projectsByWorkspace;
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const wasActive = s.activeWorkspaceId === id;
      return {
        workspaces,
        projectsByWorkspace: restProjects,
        activeWorkspaceId: wasActive ? null : s.activeWorkspaceId,
        activeProjectId: wasActive ? null : s.activeProjectId,
      };
    });
    if (get().activeWorkspaceId === null && get().workspaces.length > 0) {
      get().setActiveWorkspace(get().workspaces[0].id);
    }
  },

  setWorkspaceColor: async (id, color) => {
    await api.updateWorkspaceColor(id, color);
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, color } : w)) }));
  },

  // Written first, then mirrored into state — the backend is what rejects a blank name, and
  // updating the list before it answered would leave the sidebar showing a name the db refused.
  renameWorkspace: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await api.renameWorkspace(id, trimmed);
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w)) }));
  },

  addProject: async (input) => {
    const project = await api.createProject(input);
    set((s) => ({
      projectsByWorkspace: {
        ...s.projectsByWorkspace,
        [input.workspace_id]: [...(s.projectsByWorkspace[input.workspace_id] ?? []), project],
      },
      activeProjectId: project.id,
    }));
    void api.setSetting(windowKey(LAST_PROJECT_KEY), project.id);
    return project;
  },

  removeProject: async (id, workspaceId) => {
    // Before the delete, and imported dynamically on purpose: `chainStore` subscribes to *this*
    // store at module scope, so a static import here would be a cycle whose initialisation order
    // decides whether the subscription exists. Deleting the repository first would leave an engine
    // writing into a directory the app has already forgotten.
    const { useChainStore } = await import("./chainStore");
    await useChainStore.getState().abortForProject(id);
    await api.deleteProject(id);
    // *After* the delete, which is the only order that can work: the row is what triggers the
    // cascade — `agent_chains.project_id` is `ON DELETE CASCADE` — so a re-read issued beforehand
    // sees the chains that are about to disappear and files them as still waiting. That mattered
    // for exactly one case, which is also the case the cross-workspace gate list exists for: a plan
    // parked in a workspace this window has not loaded is invisible to `abortForProject`'s own
    // sweep, so nothing else would ever take its amber row out of the status bar.
    void useChainStore.getState().refreshGates();
    set((s) => ({
      projectsByWorkspace: {
        ...s.projectsByWorkspace,
        [workspaceId]: (s.projectsByWorkspace[workspaceId] ?? []).filter((p) => p.id !== id),
      },
      activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
    }));
  },

  setProjectColor: async (id, workspaceId, color) => {
    await api.updateProjectColor(id, color);
    set((s) => ({
      projectsByWorkspace: {
        ...s.projectsByWorkspace,
        [workspaceId]: (s.projectsByWorkspace[workspaceId] ?? []).map((p) =>
          p.id === id ? { ...p, color } : p,
        ),
      },
    }));
  },

  patchProject: (project) => {
    set((s) => {
      const current = s.projectsByWorkspace[project.workspace_id];
      // A project whose workspace isn't loaded has no row to refresh, and inventing one here
      // would put a repository in a list the user hasn't opened.
      if (!current?.some((p) => p.id === project.id)) return {};
      return {
        projectsByWorkspace: {
          ...s.projectsByWorkspace,
          [project.workspace_id]: current.map((p) => (p.id === project.id ? project : p)),
        },
      };
    });
  },

  moveProject: async (id, fromWorkspaceId, toWorkspaceId) => {
    if (fromWorkspaceId === toWorkspaceId) return;
    await api.moveProjectToWorkspace(id, toWorkspaceId);
    set((s) => {
      const project = s.projectsByWorkspace[fromWorkspaceId]?.find((p) => p.id === id);
      if (!project) return s;
      const moved = { ...project, workspace_id: toWorkspaceId };
      return {
        projectsByWorkspace: {
          ...s.projectsByWorkspace,
          [fromWorkspaceId]: s.projectsByWorkspace[fromWorkspaceId].filter((p) => p.id !== id),
          [toWorkspaceId]: [...(s.projectsByWorkspace[toWorkspaceId] ?? []), moved],
        },
      };
    });
  },

  reorderProject: async (workspaceId, id, toIndex) => {
    const current = get().projectsByWorkspace[workspaceId];
    if (!current) return;
    const from = current.findIndex((p) => p.id === id);
    if (from === -1) return;
    // `toIndex` is a gap in the list *as it is now*, with the dragged row still in it. Taking the
    // row out shifts every gap after it down by one, so a drop below the row's own position has to
    // come down with them — without this, dragging A into the A|B gap of [A,B,C] lands it after C.
    const target = from < toIndex ? toIndex - 1 : toIndex;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    // Clamped, so a drop past the end lands on the end rather than nowhere.
    next.splice(Math.max(0, Math.min(target, next.length)), 0, moved);
    if (next.every((p, at) => p.id === current[at].id)) return;

    set((s) => ({ projectsByWorkspace: { ...s.projectsByWorkspace, [workspaceId]: next } }));
    await api.reorderProjects(workspaceId, next.map((p) => p.id)).catch((e: unknown) => {
      pushErrorToast(String(e));
      // Back to what the database still holds — the optimistic list is now a lie.
      set((s) => ({ projectsByWorkspace: { ...s.projectsByWorkspace, [workspaceId]: current } }));
    });
  },

  reorderWorkspace: async (id, toIndex) => {
    const current = get().workspaces;
    const from = current.findIndex((w) => w.id === id);
    if (from === -1) return;
    // Same off-by-one as `reorderProject`: `toIndex` is a gap in the list with the dragged row
    // still in it, so a drop below the row's own position shifts down by one when it is removed.
    const target = from < toIndex ? toIndex - 1 : toIndex;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(target, next.length)), 0, moved);
    if (next.every((w, at) => w.id === current[at].id)) return;

    set({ workspaces: next });
    await api.reorderWorkspaces(next.map((w) => w.id)).catch((e: unknown) => {
      pushErrorToast(String(e));
      set({ workspaces: current });
    });
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id, activeProjectId: null });
    void api.setSetting(windowKey(LAST_WORKSPACE_KEY), id);
    void get().loadProjects(id);
    // Nothing is announced. **Windows no longer follow each other** — each holds the workspace its
    // user pointed it at, which is the whole reason the key above is per window. A freshly detached
    // window still opens where the app is, but by reading the setting this line just wrote, not by
    // being told; see `windowKey` and `SatelliteApp`.
  },

  setActiveProject: (id) => {
    set({ activeProjectId: id });
    void api.setSetting(windowKey(LAST_PROJECT_KEY), id);
  },

  followWorkspace: async (id) => {
    if (get().activeWorkspaceId === id) return;
    set({ activeWorkspaceId: id, activeProjectId: null });
    if (id) await get().loadProjects(id);
  },

  focusProject: async (workspaceId, projectId) => {
    if (get().activeWorkspaceId !== workspaceId) {
      // Same effect as setActiveWorkspace, except the projects load is awaited rather than
      // fired and forgotten — the caller's next step depends on this workspace's list.
      set({ activeWorkspaceId: workspaceId, activeProjectId: null });
      void api.setSetting(windowKey(LAST_WORKSPACE_KEY), workspaceId);
      await get().loadProjects(workspaceId);
    } else if (!get().projectsByWorkspace[workspaceId]) {
      await get().loadProjects(workspaceId);
    }
    get().setActiveProject(projectId);
  },

  activeProject: () => {
    const { activeWorkspaceId, activeProjectId, projectsByWorkspace } = get();
    if (!activeWorkspaceId || !activeProjectId) return null;
    return projectsByWorkspace[activeWorkspaceId]?.find((p) => p.id === activeProjectId) ?? null;
  },

  workspaceOfProject: (projectId) => {
    for (const [workspaceId, projects] of Object.entries(get().projectsByWorkspace)) {
      if (projects.some((p) => p.id === projectId)) return workspaceId;
    }
    return null;
  },
}));

/** A stable empty list. A selector that builds `[]` on the fly hands back a new reference on every
 * call, and `useSyncExternalStore` reads a new reference as "the store changed" — which re-renders,
 * which calls the selector again. React only reports it ("The result of getSnapshot should be
 * cached") once the loop has already taken the view down. */
const NO_PROJECTS: Project[] = [];

/** The active workspace's repositories. Use this rather than reaching into `projectsByWorkspace`
 * from a component selector — see [`NO_PROJECTS`]. */
export const useActiveProjects = (): Project[] =>
  useWorkspaceStore((s) =>
    s.activeWorkspaceId ? (s.projectsByWorkspace[s.activeWorkspaceId] ?? NO_PROJECTS) : NO_PROJECTS,
  );
