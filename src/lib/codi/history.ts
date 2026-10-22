import { useUiStore, type ApiWorkspace, type MainView, type SettingsSectionId } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { WINDOW } from "../windowIdentity";
import type { ScreenHistory } from "./registry";

/**
 * What "the screen" is for `nav.undo`: the workspace and repository this window is on, the view, the
 * API tab's side, Settings and the AI panel. The registry records one of these before every
 * navigation Codi runs and hands it back here to restore — see `ScreenHistory` there.
 *
 * Only what a navigation moves. A navigation that also *did* something (a note opened is the note's
 * store, a branch checked out is git) has that part left alone: undoing "open Notes" closes nothing
 * and reopens nothing, it just takes the window back to where it was.
 */
export interface Screen {
  workspaceId: string | null;
  projectId: string | null;
  view: MainView;
  apiWorkspace: ApiWorkspace;
  settings: { section: SettingsSectionId; tab: string | null } | null;
  aiPanelOpen: boolean;
}

export function captureScreen(): Screen {
  const ui = useUiStore.getState();
  const ws = useWorkspaceStore.getState();
  return {
    workspaceId: ws.activeWorkspaceId,
    projectId: ws.activeProjectId,
    view: ui.activeView,
    apiWorkspace: ui.apiWorkspace,
    settings: ui.settingsOpen ? { section: ui.settingsSection, tab: ui.settingsTab } : null,
    aiPanelOpen: ui.aiPanelOpen,
  };
}

export async function restoreScreen(screen: Screen): Promise<void> {
  const ws = useWorkspaceStore.getState();
  if (screen.workspaceId && screen.workspaceId !== ws.activeWorkspaceId) {
    // Back across a workspace: onto its repository too when there was one, awaited so the view below
    // lands on a repository that is loaded.
    if (screen.projectId) await ws.focusProject(screen.workspaceId, screen.projectId);
    else ws.setActiveWorkspace(screen.workspaceId);
  } else if (screen.projectId && screen.projectId !== ws.activeProjectId) {
    ws.setActiveProject(screen.projectId);
  }
  const ui = useUiStore.getState();
  // An island holds one app or one repository; its view is what it is, and is not moved.
  if (WINDOW.main && (screen.view !== ui.activeView || (screen.view === "api" && screen.apiWorkspace !== ui.apiWorkspace))) {
    if (screen.view === "api") ui.openApiWorkspace(screen.apiWorkspace);
    else ui.setActiveView(screen.view);
  }
  // The API tab's side too, off screen: «abre las bases de datos», «vuelve» must not leave the next
  // ⌘4 landing on the databases.
  if (WINDOW.main && useUiStore.getState().apiWorkspace !== screen.apiWorkspace) useUiStore.getState().setApiWorkspace(screen.apiWorkspace);
  if (screen.settings) {
    if (screen.settings.tab) useUiStore.getState().openSettingsAt(screen.settings.section, screen.settings.tab);
    else useUiStore.getState().openSettings(screen.settings.section);
  } else if (useUiStore.getState().settingsOpen) {
    useUiStore.getState().closeSettings();
  }
  if (useUiStore.getState().aiPanelOpen !== screen.aiPanelOpen) useUiStore.getState().toggleAiPanel();
}

export const screenHistory: ScreenHistory<Screen> = { capture: captureScreen, restore: restoreScreen };
