import { create } from "zustand";
import * as api from "../lib/tauri/commands";
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
  addProject: (input: NewProject) => Promise<Project>;
  removeProject: (id: string, workspaceId: string) => Promise<void>;
  setProjectColor: (id: string, workspaceId: string, color: string) => Promise<void>;
  moveProject: (id: string, fromWorkspaceId: string, toWorkspaceId: string) => Promise<void>;
  setActiveWorkspace: (id: string) => void;
  setActiveProject: (id: string) => void;

  activeProject: () => Project | null;
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

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id, activeProjectId: null });
    void api.setSetting(LAST_WORKSPACE_KEY, id);
    void get().loadProjects(id);
  },

  setActiveProject: (id) => {
    set({ activeProjectId: id });
    void api.setSetting(LAST_PROJECT_KEY, id);
  },

  activeProject: () => {
    const { activeWorkspaceId, activeProjectId, projectsByWorkspace } = get();
    if (!activeWorkspaceId || !activeProjectId) return null;
    return projectsByWorkspace[activeWorkspaceId]?.find((p) => p.id === activeProjectId) ?? null;
  },
}));
