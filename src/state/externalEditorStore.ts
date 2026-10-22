import { create } from "zustand";
import { setSetting } from "../lib/tauri/commands";
import { externalEditorState, openInExternalEditor, type ExternalEditor, type ExternalEditorState } from "../lib/tauri/externalEditorCommands";
import { pushErrorToast } from "./toastStore";

/**
 * The editor «Abrir en …» opens a repository in — chosen for the app, and again per workspace or
 * per repository (`external_editor` in Rust, which keeps the same rule and does the opening).
 * The choices are settings: `external_editor`, `external_editor_ws:<id>`, `external_editor_repo:<id>`;
 * an empty one follows the level above it.
 */

const DEFAULT_KEY = "external_editor";
const WORKSPACE_PREFIX = "external_editor_ws:";
const PROJECT_PREFIX = "external_editor_repo:";

export type EditorScope = { kind: "default" } | { kind: "workspace"; id: string } | { kind: "project"; id: string };

/** The editor id that applies — the repository's choice, its workspace's, the app's, or
 *  automatic's — the rule `external_editor::resolve` keeps. */
export function resolveEditor(state: ExternalEditorState, projectId?: string | null, workspaceId?: string | null): string {
  const known = (id: string | undefined) => !!id && id !== "auto" && state.editors.some((editor) => editor.id === id);
  const picks = [projectId ? state.projects[projectId] : undefined, workspaceId ? state.workspaces[workspaceId] : undefined, state.default];
  return picks.find(known) ?? state.auto;
}

interface ExternalEditorStore {
  state: ExternalEditorState | null;
  load: () => Promise<void>;
  /** The editor that opens this repository — for the button's name. */
  editorFor: (projectId?: string | null, workspaceId?: string | null) => ExternalEditor | null;
  /** The editors this machine has, for «Abrir con» and the pickers. */
  installed: () => ExternalEditor[];
  open: (path: string, scope: { projectId?: string | null; workspaceId?: string | null; editor?: string | null }) => Promise<void>;
  /** `null` follows the level above. */
  choose: (scope: EditorScope, editor: string | null) => Promise<void>;
}

export const useExternalEditorStore = create<ExternalEditorStore>((set, get) => ({
  state: null,

  load: async () => {
    try {
      set({ state: await externalEditorState() });
    } catch {
      // The button still opens: the backend resolves on its own.
    }
  },

  editorFor: (projectId, workspaceId) => {
    const state = get().state;
    if (!state) return null;
    const id = resolveEditor(state, projectId, workspaceId);
    return state.editors.find((editor) => editor.id === id) ?? null;
  },

  installed: () => get().state?.editors.filter((editor) => editor.installed) ?? [],

  open: async (path, scope) => {
    try {
      await openInExternalEditor(path, scope);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  choose: async (scope, editor) => {
    const key = scope.kind === "default" ? DEFAULT_KEY : `${scope.kind === "workspace" ? WORKSPACE_PREFIX : PROJECT_PREFIX}${scope.id}`;
    const value = editor ?? "";
    set((s) => {
      if (!s.state) return {};
      if (scope.kind === "default") return { state: { ...s.state, default: value } };
      const field = scope.kind === "workspace" ? "workspaces" : "projects";
      const { [scope.id]: _was, ...rest } = s.state[field];
      return { state: { ...s.state, [field]: value ? { ...rest, [scope.id]: value } : rest } };
    });
    try {
      await setSetting(key, value);
    } catch (error) {
      pushErrorToast(String(error));
      void get().load();
    }
  },
}));
