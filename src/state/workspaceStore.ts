import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { pushErrorToast } from "./toastStore";
import type { NewProject, Project, Workspace } from "../types/domain";

const LAST_WORKSPACE_KEY = "last_active_workspace_id";

/// Name of the workspace seeded on a fresh install, on every platform. Only applies when the
/// database has no workspaces at all — an existing install keeps whatever it already has.
const DEFAULT_WORKSPACE_NAME = "Flow";
const LAST_PROJECT_KEY = "last_active_project_id";

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
  moveProject: (id: string, fromWorkspaceId: string, toWorkspaceId: string) => Promise<void>;
  /** Moves one repository to a new position in its workspace's list. Optimistic: the row is where
   *  the user dropped it before the write goes out, because a list that snaps back for a moment
   *  reads as a failed drag. */
  reorderProject: (workspaceId: string, id: string, toIndex: number) => Promise<void>;
  /** The same gesture one level up, for the workspaces themselves. Optimistic for the same reason. */
  reorderWorkspace: (id: string, toIndex: number) => Promise<void>;
  setActiveWorkspace: (id: string) => void;
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
        const lastId = await api.getSetting(LAST_WORKSPACE_KEY).catch(() => null);
        const restored = lastId ? workspaces.find((w) => w.id === lastId) : undefined;
        const target = restored ?? workspaces[0];
        set({ activeWorkspaceId: target.id });
        await get().loadProjects(target.id);
      }
    } finally {
      set({ loading: false });
    }
  },

  loadProjects: async (workspaceId) => {
    const projects = await api.listProjects(workspaceId);
    set((s) => ({ projectsByWorkspace: { ...s.projectsByWorkspace, [workspaceId]: projects } }));
    if (!get().activeProjectId && projects.length > 0) {
      const lastId = await api.getSetting(LAST_PROJECT_KEY).catch(() => null);
      const restored = lastId ? projects.find((p) => p.id === lastId) : undefined;
      set({ activeProjectId: (restored ?? projects[0]).id });
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
    void api.setSetting(LAST_PROJECT_KEY, project.id);
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
    void api.setSetting(LAST_WORKSPACE_KEY, id);
    void get().loadProjects(id);
  },

  setActiveProject: (id) => {
    set({ activeProjectId: id });
    void api.setSetting(LAST_PROJECT_KEY, id);
  },

  focusProject: async (workspaceId, projectId) => {
    if (get().activeWorkspaceId !== workspaceId) {
      // Same effect as setActiveWorkspace, except the projects load is awaited rather than
      // fired and forgotten — the caller's next step depends on this workspace's list.
      set({ activeWorkspaceId: workspaceId, activeProjectId: null });
      void api.setSetting(LAST_WORKSPACE_KEY, workspaceId);
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
