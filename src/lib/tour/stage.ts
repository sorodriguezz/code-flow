import type { ApiSettingsTab } from "../../state/apiModalStore";
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
}

export function captureAppState(): AppSnapshot {
  const ui = useUiStore.getState();
  return {
    sidebarCollapsed: ui.sidebarCollapsed,
    activeView: ui.activeView,
    apiWorkspace: ui.apiWorkspace,
    storiesMode: ui.storiesMode,
    aiPanelOpen: ui.aiPanelOpen,
    settingsOpen: ui.settingsOpen,
    settingsSection: ui.settingsSection,
    apiSettingsTab: ui.apiSettingsTab,
    terminalOpen: useTerminalStore.getState().panelOpen,
  };
}

export function restoreAppState(snapshot: AppSnapshot): void {
  useUiStore.setState({
    sidebarCollapsed: snapshot.sidebarCollapsed,
    activeView: snapshot.activeView,
    apiWorkspace: snapshot.apiWorkspace,
    storiesMode: snapshot.storiesMode,
    aiPanelOpen: snapshot.aiPanelOpen,
    settingsOpen: snapshot.settingsOpen,
    settingsSection: snapshot.settingsSection,
    apiSettingsTab: snapshot.apiSettingsTab,
  });
  useTerminalStore.setState({ panelOpen: snapshot.terminalOpen });
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
  useUiStore.setState({
    sidebarCollapsed: !(stage?.sidebar ?? true),
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
}
