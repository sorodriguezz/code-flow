import { create } from "zustand";
import type { VcsProvider } from "../types/domain";

export type MainView = "graph" | "changes" | "editor";

export type SettingsSectionId =
  | "appearance"
  | "general"
  | "projects"
  | "git"
  | "azure"
  | "claude"
  | "context"
  | "mdFiles"
  | "skills"
  | "mcps";

interface UiState {
  sidebarCollapsed: boolean;
  activeView: MainView;
  /** Settings is a modal overlaid on top of the current view, not a view itself — closing
   * it just reveals whatever was already showing underneath. */
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  /** Which provider tab the "Git hosting" settings section should open on — lets a "needs a
   * GitHub token" hint deep-link straight to the GitHub form instead of the default Azure one. */
  settingsHostingProvider: VcsProvider;
  /** Repo-relative path the Editor tab should jump to open next; consumed once then cleared. */
  pendingEditorPath: string | null;
  /** The AI panel (PRs / open questions / change analysis) is a persistent left-docked panel,
   * not a tab — it stays mounted and scoped to whatever project is active regardless of which
   * main view or project the user switches to. */
  aiPanelOpen: boolean;
  toggleSidebar: () => void;
  setActiveView: (view: MainView) => void;
  openSettings: (section: SettingsSectionId, hostingProvider?: VcsProvider) => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  openInEditor: (relPath: string) => void;
  clearPendingEditorPath: () => void;
  toggleAiPanel: () => void;
  openAiPanel: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  activeView: "graph",
  settingsOpen: false,
  settingsSection: "appearance",
  settingsHostingProvider: "azure",
  pendingEditorPath: null,
  aiPanelOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setActiveView: (view) => set({ activeView: view, settingsOpen: false }),
  openSettings: (section, hostingProvider) =>
    set((s) => ({
      settingsOpen: true,
      settingsSection: section,
      settingsHostingProvider: hostingProvider ?? s.settingsHostingProvider,
    })),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  closeSettings: () => set({ settingsOpen: false }),
  openInEditor: (relPath) => set({ activeView: "editor", pendingEditorPath: relPath, settingsOpen: false }),
  clearPendingEditorPath: () => set({ pendingEditorPath: null }),
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  openAiPanel: () => set({ aiPanelOpen: true }),
}));
