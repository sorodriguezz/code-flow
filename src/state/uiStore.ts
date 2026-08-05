import { create } from "zustand";
import type { HostingProvider } from "../lib/vcsProviders";
import type { ApiSettingsTab } from "./apiModalStore";
// Type-only, so this does not close the loop with `lib/shortcuts`, which imports this store to run
// its commands. Erased at compile time; there is no runtime cycle.
import type { ShortcutGroup } from "../lib/shortcuts";

/** `api`, `agents`, `stories` and `remote` are the odd ones out: the built-in API client, the agent
 * console, the user-stories workspace and the SSH host manager are scoped to the *workspace* rather
 * than to a repo, so they render whether or not a project is open (see `App.tsx`). All four are
 * reached from the workspace menu rather than from the tab bar. */
export type MainView = "graph" | "changes" | "editor" | "api" | "agents" | "stories" | "remote";

/** The three directions the stories section works in. Its own sub-tab, one level under the view. */
export type StoriesMode = "batches" | "review" | "wiki";

export type SettingsSectionId =
  | "appearance"
  | "general"
  | "keybindings"
  | "projects"
  | "git"
  | "terminal"
  | "azure"
  | "claude"
  | "backup"
  | "review"
  | "skills"
  | "api";

/**
 * The two workspaces inside the API tab.
 *
 * `requests` is the Postman-style client, `database` the DataGrip-style one. They share a tab
 * because they share a *scope*: both belong to the workspace and neither follows the selected
 * repository, which is exactly what the note at the top of `TabBar` is about. Splitting them into
 * two main tabs would put a workspace-scoped tab next to three repo-scoped ones twice over.
 */
export type ApiWorkspace = "requests" | "database";

/** Which group the command palette lists. Scoped openings come from the keyboard shortcuts —
 * "switch repository" wants a list of repositories, not everything the app can do. */
export type PaletteScope = "all" | "workspaces" | "projects";

interface UiState {
  sidebarCollapsed: boolean;
  activeView: MainView;
  /**
   * Which stories sub-tab is showing.
   *
   * Here rather than in the view's own `useState` because something outside it has to be able to
   * open it: a notification saying the wiki page finished has to land the user *on the wiki*, and
   * a completion that drops you on whichever tab you happened to leave open is a completion you
   * have to go looking for.
   */
  storiesMode: StoriesMode;
  /** Settings is a modal overlaid on top of the current view, not a view itself — closing
   * it just reveals whatever was already showing underneath. */
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  /** Which provider tab the "Integrations" settings section should open on — lets a "needs a
   * GitHub token" hint deep-link straight to the GitHub form instead of the default Azure one.
   * Wider than `VcsProvider` because Jira lives on that screen too without hosting any code. */
  settingsHostingProvider: HostingProvider;
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
  /**
   * Which groups the cheat sheet should list, or `null` for all of them.
   *
   * Opened with ⌘⌥K it is the whole keyboard — every group, which is what a cheat sheet asked for
   * from nowhere in particular should be. Opened from a button that belongs to one screen it is a
   * question about *that* screen, and answering it with six sections means scrolling past five to
   * reach the one you asked about.
   */
  shortcutsModalGroups: ShortcutGroup[] | null;
  /** Branch picking has its own modal (it checks out, rather than just navigating), so it gets
   * its own flag instead of a palette scope. */
  branchSwitcherOpen: boolean;
  /** "Review a PR from its link" — reachable from the title bar, the command palette, the
   * sidebar and a shortcut, none of which own the modal, so it lives here and is rendered once
   * at the app root. */
  prLinkModalOpen: boolean;
  /** Which sub-tab the API client's settings section should open on, when asked for a specific one. */
  apiSettingsTab: ApiSettingsTab | undefined;
  /** Which of the API tab's two workspaces is on screen. */
  apiWorkspace: ApiWorkspace;
  toggleSidebar: () => void;
  setActiveView: (view: MainView) => void;
  setStoriesMode: (mode: StoriesMode) => void;
  /** Opens the stories section on a given sub-tab, in one move. */
  openStories: (mode: StoriesMode) => void;
  openSettings: (section: SettingsSectionId, hostingProvider?: HostingProvider) => void;
  /**
   * Opens the settings window on the API client's section, optionally on one of its sub-tabs.
   *
   * Its own action rather than a second argument to `openSettings`, because the sub-tab only means
   * anything for one section and threading it through the general opener would put an `api`-shaped
   * parameter on every call site that has nothing to do with the API client.
   */
  openApiSettings: (tab?: ApiSettingsTab) => void;
  setApiWorkspace: (workspace: ApiWorkspace) => void;
  /** Opens the API tab straight onto one of its workspaces — for the command palette and shortcuts,
   * which have to both switch view and pick a side. */
  openApiWorkspace: (workspace: ApiWorkspace) => void;
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
  /** `groups` narrows the sheet to those sections; omitted, it shows the whole keyboard. */
  toggleShortcutsModal: (groups?: ShortcutGroup[]) => void;
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
  storiesMode: "batches",
  settingsOpen: false,
  settingsSection: "appearance",
  settingsHostingProvider: "azure",
  apiSettingsTab: undefined,
  apiWorkspace: "requests",
  pendingEditorPath: null,
  pendingEditorLine: null,
  aiPanelOpen: false,
  commandPaletteOpen: false,
  commandPaletteScope: "all",
  shortcutsModalOpen: false,
  shortcutsModalGroups: null,
  branchSwitcherOpen: false,
  prLinkModalOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setActiveView: (view) => set({ activeView: view, settingsOpen: false }),
  setStoriesMode: (mode) => set({ storiesMode: mode }),
  // Settings closed too: it covers the whole app, and landing behind it looks like nothing
  // happened. Same reason `setActiveView` does it.
  openStories: (mode) => set({ activeView: "stories", storiesMode: mode, settingsOpen: false }),
  openSettings: (section, hostingProvider) =>
    set((s) => ({
      settingsOpen: true,
      settingsSection: section,
      settingsHostingProvider: hostingProvider ?? s.settingsHostingProvider,
    })),
  openApiSettings: (tab) =>
    set({ settingsOpen: true, settingsSection: "api", apiSettingsTab: tab }),
  setApiWorkspace: (apiWorkspace) => set({ apiWorkspace }),
  openApiWorkspace: (apiWorkspace) =>
    set({ activeView: "api", apiWorkspace, settingsOpen: false }),
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
  // The scope is set on the way *open*, so reopening from a different button re-scopes rather than
  // inheriting where it was last opened from.
  toggleShortcutsModal: (groups) =>
    set((s) => ({
      shortcutsModalOpen: !s.shortcutsModalOpen,
      shortcutsModalGroups: s.shortcutsModalOpen ? null : (groups ?? null),
    })),
  closeShortcutsModal: () => set({ shortcutsModalOpen: false, shortcutsModalGroups: null }),
  toggleBranchSwitcher: () => set((s) => ({ branchSwitcherOpen: !s.branchSwitcherOpen })),
  closeBranchSwitcher: () => set({ branchSwitcherOpen: false }),
  openPrLinkModal: () => set({ prLinkModalOpen: true }),
  togglePrLinkModal: () => set((s) => ({ prLinkModalOpen: !s.prLinkModalOpen })),
  closePrLinkModal: () => set({ prLinkModalOpen: false }),
}));
