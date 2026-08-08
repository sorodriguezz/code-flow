import { useAgentsStore } from "../../state/agentsStore";
import type { ApiSettingsTab } from "../../state/apiModalStore";
import { useDbModalStore, type DbModal } from "../../state/dbModalStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useTerminalStore } from "../../state/terminalStore";
import {
  useUiStore,
  type ApiWorkspace,
  type MainView,
  type SettingsSectionId,
  type StoriesMode,
} from "../../state/uiStore";

/**
 * The shape of the app a tour step needs on screen before it can point at anything.
 *
 * Declarative rather than a `before()` callback, and that is the whole design: the tour is walked
 * **in both directions**, so every step has to put the app into its state *and* undo whatever the
 * step before it did. A callback per step gets that right going forward and wrong going back — the
 * settings dialog opened by step 19 would still be covering the screen when Back landed on step 18.
 * A stage is applied whole, with a default for every field it doesn't mention, so arriving at a
 * step from either direction produces exactly the same screen.
 */
export interface TourStage {
  /** Sidebar expanded. Default `true` — most steps want the repository list visible. */
  sidebar?: boolean;
  /** Which main view. Default `"graph"`, the app's own landing view. */
  view?: MainView;
  /** Which side of the API tab, for the one view that holds two. */
  apiWorkspace?: ApiWorkspace;
  /** Which of the Specs view's three sub-tabs. Left alone when a step doesn't name one — it is a
   * choice inside one view, and resetting it from a step about the terminal would move a tab
   * nothing on screen is pointing at. */
  storiesMode?: StoriesMode;
  /** The agent console's roster rail, for the one step that is about defining an agent rather than
   * about running one. Default `false`, like the other two panels — a stage is applied whole, so a
   * rail opened by one step has to be closed again by every step that doesn't ask for it. */
  agentsRoster?: boolean;
  /**
   * The database workspace's Data sources dialog, open on the whole set.
   *
   * The only dialog any tour opens, and it earns it: connections are the one thing in that app that
   * is configured nowhere else — not in Settings, not in a panel — so a tour that only points at
   * the gear that opens this has described the door and not the room. Default `false`, so every
   * other step closes it again.
   */
  dbDataSources?: boolean;
  /** AI panel docked open. Default `false`. */
  ai?: boolean;
  /** Terminal dock open. Default `false`. */
  terminal?: boolean;
  /** Settings open on a section, or `null` for closed. Default `null`. */
  settings?: SettingsSectionId | null;
  /** Which sub-tab of the API client's settings section, for the step about collaboration —
   * that screen is two levels deep and `settings: "api"` alone lands on the wrong one. */
  apiSettingsTab?: ApiSettingsTab;
}

/**
 * Everything the tour is allowed to move, recorded before it starts moving it.
 *
 * The tour opens panels, switches views and pushes the settings dialog around — none of which the
 * user asked for. Putting it all back on the way out is what makes running the tour free: you end
 * up looking at the screen you left, not at wherever step 21 happened to stop.
 */
export interface AppSnapshot {
  sidebarCollapsed: boolean;
  activeView: MainView;
  apiWorkspace: ApiWorkspace;
  storiesMode: StoriesMode;
  aiPanelOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  apiSettingsTab: ApiSettingsTab | undefined;
  terminalOpen: boolean;
  agentsRosterOpen: boolean;
  dbModal: DbModal | null;
}

/**
 * Folds or unfolds the sidebar *without* remembering it.
 *
 * `toggleFlag` is the store's own way in and writes the flag to disk, which is right for the user
 * pressing ⌘B and wrong for a tour that folds the panel for one step and puts it back at the end —
 * that would leave the tour having quietly rewritten a preference nobody changed. Straight onto the
 * store, like every other write in this file, for exactly that reason.
 */
function setSidebarCollapsed(collapsed: boolean): void {
  useLayoutStore.setState((s) => ({ flags: { ...s.flags, sidebarCollapsed: collapsed } }));
}

export function captureAppState(): AppSnapshot {
  const ui = useUiStore.getState();
  return {
    // In `layoutStore` rather than `uiStore` since the sidebar started collapsing to a rail instead
    // of vanishing — it is a remembered size now, which is the whole reason the writes below go
    // through `setState` and not through `toggleFlag`.
    sidebarCollapsed: useLayoutStore.getState().flags.sidebarCollapsed,
    activeView: ui.activeView,
    apiWorkspace: ui.apiWorkspace,
    storiesMode: ui.storiesMode,
    aiPanelOpen: ui.aiPanelOpen,
    settingsOpen: ui.settingsOpen,
    settingsSection: ui.settingsSection,
    apiSettingsTab: ui.apiSettingsTab,
    terminalOpen: useTerminalStore.getState().panelOpen,
    agentsRosterOpen: useAgentsStore.getState().rosterOpen,
    dbModal: useDbModalStore.getState().modal,
  };
}

export function restoreAppState(snapshot: AppSnapshot): void {
  setSidebarCollapsed(snapshot.sidebarCollapsed);
  useUiStore.setState({
    activeView: snapshot.activeView,
    apiWorkspace: snapshot.apiWorkspace,
    storiesMode: snapshot.storiesMode,
    aiPanelOpen: snapshot.aiPanelOpen,
    settingsOpen: snapshot.settingsOpen,
    settingsSection: snapshot.settingsSection,
    apiSettingsTab: snapshot.apiSettingsTab,
  });
  useTerminalStore.setState({ panelOpen: snapshot.terminalOpen });
  useAgentsStore.setState({ rosterOpen: snapshot.agentsRosterOpen });
  useDbModalStore.setState({ modal: snapshot.dbModal });
}

/**
 * Puts the app into the state a step describes.
 *
 * Written straight onto the stores rather than through their actions, deliberately. `togglePanel`
 * and friends persist what they set, and a tour that flips the terminal dock open for eight seconds
 * has no business rewriting the preference the user chose for it — the snapshot above is what puts
 * the dock back, and it would be putting back a value that had already been written to disk.
 */
export function applyStage(stage: TourStage | undefined): void {
  const current = useUiStore.getState();
  const settings = stage?.settings ?? null;
  setSidebarCollapsed(!(stage?.sidebar ?? true));
  useUiStore.setState({
    activeView: stage?.view ?? "graph",
    apiWorkspace: stage?.apiWorkspace ?? current.apiWorkspace,
    storiesMode: stage?.storiesMode ?? current.storiesMode,
    aiPanelOpen: stage?.ai ?? false,
    settingsOpen: settings !== null,
    // Left where it was when the dialog is closed: switching the section under a hidden dialog
    // would make the *next* manual visit to settings land somewhere the user never chose.
    settingsSection: settings ?? current.settingsSection,
    apiSettingsTab: stage?.apiSettingsTab ?? current.apiSettingsTab,
  });
  useTerminalStore.setState({ panelOpen: stage?.terminal ?? false });
  useAgentsStore.setState({ rosterOpen: stage?.agentsRoster ?? false });
  // `kind: "connections"` is the dialog opened from the workspace rather than from one connection's
  // menu — nothing preselected, which is the state a tour wants: the list first, then the form.
  useDbModalStore.setState({ modal: stage?.dbDataSources ? { kind: "connections" } : null });
}
