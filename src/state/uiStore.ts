import { create } from "zustand";

export type MainView = "graph" | "changes" | "chat" | "editor" | "terminal";

export type SettingsSectionId =
  | "appearance"
  | "general"
  | "projects"
  | "git"
  | "azure"
  | "claude"
  | "context"
  | "skills";

interface UiState {
  sidebarCollapsed: boolean;
  activeView: MainView;
  /** Settings is a modal overlaid on top of the current view, not a view itself — closing
   * it just reveals whatever was already showing underneath. */
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  /** Repo-relative path the Editor tab should jump to open next; consumed once then cleared. */
  pendingEditorPath: string | null;
  toggleSidebar: () => void;
  setActiveView: (view: MainView) => void;
  openSettings: (section: SettingsSectionId) => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  openInEditor: (relPath: string) => void;
  clearPendingEditorPath: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  activeView: "graph",
  settingsOpen: false,
  settingsSection: "appearance",
  pendingEditorPath: null,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setActiveView: (view) => set({ activeView: view, settingsOpen: false }),
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  closeSettings: () => set({ settingsOpen: false }),
  openInEditor: (relPath) => set({ activeView: "editor", pendingEditorPath: relPath, settingsOpen: false }),
  clearPendingEditorPath: () => set({ pendingEditorPath: null }),
}));
