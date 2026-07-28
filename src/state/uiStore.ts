import { create } from "zustand";
import type { VcsProvider } from "../types/domain";

/** `api` is the odd one out: it's the built-in API client, which is app-global rather than
 * scoped to a repo, so it renders whether or not a project is open (see `App.tsx`). */
export type MainView = "graph" | "changes" | "editor" | "api";

export type SettingsSectionId =
  | "appearance"
  | "general"
  | "keybindings"
  | "projects"
  | "git"
  | "terminal"
  | "azure"
  | "claude"
  | "review"
  | "sdd"
  | "skills"
  | "mcps"
  | "api";

/** Which group the command palette lists. Scoped openings come from the keyboard shortcuts —
 * "switch repository" wants a list of repositories, not everything the app can do. */
export type PaletteScope = "all" | "workspaces" | "projects";

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
  /** 1-based line to reveal in that file — set when the jump came from a search hit, so the
   * editor lands on the match instead of at the top of the file. */
  pendingEditorLine: number | null;
  /** The AI panel (PRs / open questions / change analysis) is a persistent left-docked panel,
   * not a tab — it stays mounted and scoped to whatever project is active regardless of which
   * main view or project the user switches to. */
  aiPanelOpen: boolean;
  /** The command palette and the shortcuts cheat sheet live here rather than as local state in
   * the title bar / editor, because keyboard shortcuts have to reach them from anywhere. */
  commandPaletteOpen: boolean;
  commandPaletteScope: PaletteScope;
  shortcutsModalOpen: boolean;
  /** Branch picking has its own modal (it checks out, rather than just navigating), so it gets
   * its own flag instead of a palette scope. */
  branchSwitcherOpen: boolean;
  /** "Review a PR from its link" — reachable from the title bar, the command palette, the
   * sidebar and a shortcut, none of which own the modal, so it lives here and is rendered once
   * at the app root. */
  prLinkModalOpen: boolean;
  toggleSidebar: () => void;
  setActiveView: (view: MainView) => void;
  openSettings: (section: SettingsSectionId, hostingProvider?: VcsProvider) => void;
  toggleSettings: () => void;
  closeSettings: () => void;
  openInEditor: (relPath: string, line?: number) => void;
  clearPendingEditorPath: () => void;
  toggleAiPanel: () => void;
  openAiPanel: () => void;
  openCommandPalette: (scope?: PaletteScope) => void;
  /** Re-pressing the same shortcut closes the palette; a *different* scope re-scopes the open
   * one instead, so ⌘O → ⌘⇧O doesn't require closing it in between. */
  toggleCommandPalette: (scope?: PaletteScope) => void;
  closeCommandPalette: () => void;
  toggleShortcutsModal: () => void;
  closeShortcutsModal: () => void;
  toggleBranchSwitcher: () => void;
  closeBranchSwitcher: () => void;
  openPrLinkModal: () => void;
  togglePrLinkModal: () => void;
  closePrLinkModal: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  activeView: "graph",
  settingsOpen: false,
  settingsSection: "appearance",
  settingsHostingProvider: "azure",
  pendingEditorPath: null,
  pendingEditorLine: null,
  aiPanelOpen: false,
  commandPaletteOpen: false,
  commandPaletteScope: "all",
  shortcutsModalOpen: false,
  branchSwitcherOpen: false,
  prLinkModalOpen: false,
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
  openInEditor: (relPath, line) =>
    set({
      activeView: "editor",
      pendingEditorPath: relPath,
      pendingEditorLine: line ?? null,
      settingsOpen: false,
    }),
  clearPendingEditorPath: () => set({ pendingEditorPath: null, pendingEditorLine: null }),
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  openAiPanel: () => set({ aiPanelOpen: true }),
  openCommandPalette: (scope = "all") => set({ commandPaletteOpen: true, commandPaletteScope: scope }),
  toggleCommandPalette: (scope = "all") =>
    set((s) => ({
      commandPaletteOpen: !(s.commandPaletteOpen && s.commandPaletteScope === scope),
      commandPaletteScope: scope,
    })),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleShortcutsModal: () => set((s) => ({ shortcutsModalOpen: !s.shortcutsModalOpen })),
  closeShortcutsModal: () => set({ shortcutsModalOpen: false }),
  toggleBranchSwitcher: () => set((s) => ({ branchSwitcherOpen: !s.branchSwitcherOpen })),
  closeBranchSwitcher: () => set({ branchSwitcherOpen: false }),
  openPrLinkModal: () => set({ prLinkModalOpen: true }),
  togglePrLinkModal: () => set((s) => ({ prLinkModalOpen: !s.prLinkModalOpen })),
  closePrLinkModal: () => set({ prLinkModalOpen: false }),
}));
