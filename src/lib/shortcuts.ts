import { useUiStore, type MainView } from "../state/uiStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useTerminalStore } from "../state/terminalStore";
import { useNavigationStore } from "../state/navigationStore";
import { useEditorCommandStore } from "../state/editorCommandStore";
import { fetchNow, pullNow, pushNow } from "./gitActions";
import type { Chord } from "./keys";
import type { TranslationKey } from "./i18n/translations";

export type ShortcutGroup =
  | "general"
  | "panels"
  | "views"
  | "editor"
  | "navigation"
  | "workspace"
  | "git";

export type ShortcutId =
  | "app.commandPalette"
  | "app.settings"
  | "app.shortcuts"
  | "panel.sidebar"
  | "panel.ai"
  | "panel.terminal"
  | "view.graph"
  | "view.changes"
  | "view.editor"
  | "view.api"
  | "view.next"
  | "view.prev"
  | "editor.goToFile"
  | "editor.explorer"
  | "editor.findInProject"
  | "editor.anchors"
  | "editor.bookmarks"
  | "editor.debug"
  | "editor.bookmarkToggle"
  | "editor.splitRight"
  | "editor.codeSnap"
  | "nav.back"
  | "nav.forward"
  | "project.switcher"
  | "project.next"
  | "project.prev"
  | "workspace.switcher"
  | "workspace.next"
  | "workspace.prev"
  | "branch.switcher"
  | "git.fetch"
  | "git.pull"
  | "git.push"
  | "pr.fromLink";

export interface ShortcutCommand {
  id: ShortcutId;
  group: ShortcutGroup;
  labelKey: TranslationKey;
  /** Written with `Mod`, so one default serves both platforms (⌘ on macOS, Ctrl elsewhere). */
  defaultChord: Chord;
  run: () => void;
}

export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, TranslationKey> = {
  general: "shortcuts.groupGeneral",
  panels: "shortcuts.groupPanels",
  views: "shortcuts.groupViews",
  editor: "shortcuts.groupEditor",
  navigation: "shortcuts.navigation",
  workspace: "shortcuts.groupWorkspace",
  git: "shortcuts.groupGit",
};

/** The API client is in the cycle because it is a view like the others — it was reachable only by
 * clicking the workspace menu, which made it the one destination with no keyboard route at all. */
const VIEW_ORDER: MainView[] = ["graph", "changes", "editor", "api"];

function cycleView(delta: number): void {
  const { activeView, setActiveView } = useUiStore.getState();
  const index = VIEW_ORDER.indexOf(activeView);
  setActiveView(VIEW_ORDER[(index + delta + VIEW_ORDER.length) % VIEW_ORDER.length]);
}

/** Replays a history entry — shared with the title bar's back/forward chevrons so both routes
 * apply an entry the same way. */
export function goHistory(direction: "back" | "forward"): void {
  const entry = useNavigationStore.getState()[direction]();
  if (!entry) return;
  useUiStore.getState().setActiveView(entry.view);
  if (entry.projectId) useWorkspaceStore.getState().setActiveProject(entry.projectId);
}

function cycleProject(delta: number): void {
  const { activeWorkspaceId, projectsByWorkspace, activeProjectId, setActiveProject } =
    useWorkspaceStore.getState();
  const projects = activeWorkspaceId ? projectsByWorkspace[activeWorkspaceId] ?? [] : [];
  if (projects.length < 2) return;
  const index = projects.findIndex((p) => p.id === activeProjectId);
  const next = index < 0 ? 0 : (index + delta + projects.length) % projects.length;
  setActiveProject(projects[next].id);
}

function cycleWorkspace(delta: number): void {
  const { workspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore.getState();
  if (workspaces.length < 2) return;
  const index = workspaces.findIndex((w) => w.id === activeWorkspaceId);
  const next = index < 0 ? 0 : (index + delta + workspaces.length) % workspaces.length;
  setActiveWorkspace(workspaces[next].id);
}

/**
 * Every keyboard-reachable app action, with the default binding it ships with.
 *
 * The defaults deliberately avoid everything Monaco itself claims (⌘F, ⌘G, ⌘D, ⌘/, ⌘Z, ⇧⌘K, ⇧⌘L,
 * ⌥↑/↓, ⌃⌥↑/↓, ⇧⌘←/→) and the handful the editor chrome owns (⌘S, ⌘W, ⌘I, ⌘PgUp/PgDn) — all of
 * them listed in `EDITOR_RESERVED` below, which is now only what is genuinely not ours to rebind.
 * Nothing here is a bare letter with only ⌘/Ctrl either, so copy/paste/select-all stay untouched.
 */
export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  {
    id: "app.commandPalette",
    group: "general",
    labelKey: "shortcuts.cmdCommandPalette",
    defaultChord: "Mod+Shift+P",
    run: () => useUiStore.getState().toggleCommandPalette("all"),
  },
  {
    id: "app.settings",
    group: "general",
    labelKey: "shortcuts.cmdSettings",
    defaultChord: "Mod+,",
    run: () => useUiStore.getState().toggleSettings(),
  },
  {
    id: "app.shortcuts",
    group: "general",
    labelKey: "shortcuts.cmdShortcuts",
    defaultChord: "Mod+Alt+K",
    run: () => useUiStore.getState().toggleShortcutsModal(),
  },

  {
    id: "panel.sidebar",
    group: "panels",
    labelKey: "shortcuts.cmdSidebar",
    defaultChord: "Mod+B",
    run: () => useUiStore.getState().toggleSidebar(),
  },
  {
    id: "panel.ai",
    group: "panels",
    labelKey: "shortcuts.cmdAiPanel",
    defaultChord: "Mod+Shift+A",
    run: () => useUiStore.getState().toggleAiPanel(),
  },
  {
    id: "panel.terminal",
    group: "panels",
    labelKey: "shortcuts.cmdTerminal",
    defaultChord: "Mod+J",
    run: () => useTerminalStore.getState().togglePanel(),
  },

  {
    id: "view.graph",
    group: "views",
    labelKey: "shortcuts.cmdViewGraph",
    defaultChord: "Mod+1",
    run: () => useUiStore.getState().setActiveView("graph"),
  },
  {
    id: "view.changes",
    group: "views",
    labelKey: "shortcuts.cmdViewChanges",
    defaultChord: "Mod+2",
    run: () => useUiStore.getState().setActiveView("changes"),
  },
  {
    id: "view.editor",
    group: "views",
    labelKey: "shortcuts.cmdViewEditor",
    defaultChord: "Mod+3",
    run: () => useUiStore.getState().setActiveView("editor"),
  },
  {
    id: "view.api",
    group: "views",
    labelKey: "tabbar.api",
    defaultChord: "Mod+4",
    run: () => useUiStore.getState().setActiveView("api"),
  },
  {
    id: "view.next",
    group: "views",
    labelKey: "shortcuts.cmdViewNext",
    defaultChord: "Mod+Alt+ArrowRight",
    run: () => cycleView(1),
  },
  {
    id: "view.prev",
    group: "views",
    labelKey: "shortcuts.cmdViewPrev",
    defaultChord: "Mod+Alt+ArrowLeft",
    run: () => cycleView(-1),
  },

  /*
   * The Editor's own actions.
   *
   * These used to be a `keydown` listener inside `EditorView` comparing `e.key` to literals, which
   * meant the four most-used things in the editor were the only shortcuts in the app nobody could
   * rebind — and they were listed under "reserved" as though they belonged to Monaco, which they
   * never did. They run through the same registry as everything else now; what is still genuinely
   * Monaco's is what remains in `EDITOR_RESERVED`.
   *
   * Every default here carries Mod deliberately. A chord without it is suppressed while the caret
   * is in a text field — Monaco included — which is exactly where an editor shortcut is pressed.
   * F-keys are the exception the handler makes, so F11 is bindable by hand if that is the habit.
   */
  {
    id: "editor.goToFile",
    group: "editor",
    labelKey: "editor.goToFile",
    defaultChord: "Mod+P",
    run: () => useEditorCommandStore.getState().send("goToFile"),
  },
  {
    id: "editor.explorer",
    group: "editor",
    labelKey: "editor.explorer",
    defaultChord: "Mod+Shift+E",
    run: () => useEditorCommandStore.getState().send("explorer"),
  },
  {
    id: "editor.findInProject",
    group: "editor",
    labelKey: "editor.searchInProject",
    defaultChord: "Mod+Shift+F",
    run: () => useEditorCommandStore.getState().send("findInProject"),
  },
  {
    id: "editor.anchors",
    group: "editor",
    labelKey: "anchors.title",
    defaultChord: "Mod+Shift+M",
    run: () => useEditorCommandStore.getState().send("anchors"),
  },
  {
    id: "editor.bookmarks",
    group: "editor",
    labelKey: "bookmarks.title",
    defaultChord: "Mod+Alt+Shift+B",
    run: () => useEditorCommandStore.getState().send("bookmarks"),
  },
  {
    id: "editor.debug",
    group: "editor",
    labelKey: "debug.title",
    // Not ⇧⌘D, which VS Code uses for this — that is `git.pull` here, and a shortcut people press
    // all day outranks matching another app's letter.
    defaultChord: "Mod+Alt+D",
    run: () => useEditorCommandStore.getState().send("debug"),
  },
  {
    id: "editor.bookmarkToggle",
    group: "editor",
    labelKey: "bookmarks.toggle",
    defaultChord: "Mod+Alt+B",
    run: () => useEditorCommandStore.getState().send("bookmarkToggle"),
  },
  {
    id: "editor.splitRight",
    group: "editor",
    labelKey: "editor.splitRight",
    defaultChord: "Mod+\\",
    run: () => useEditorCommandStore.getState().send("splitRight"),
  },
  {
    id: "editor.codeSnap",
    group: "editor",
    labelKey: "codesnap.action",
    defaultChord: "Mod+Shift+C",
    run: () => useEditorCommandStore.getState().send("codeSnap"),
  },

  {
    id: "nav.back",
    group: "navigation",
    labelKey: "titlebar.goBack",
    defaultChord: "Alt+ArrowLeft",
    run: () => goHistory("back"),
  },
  {
    id: "nav.forward",
    group: "navigation",
    labelKey: "titlebar.goForward",
    defaultChord: "Alt+ArrowRight",
    run: () => goHistory("forward"),
  },

  {
    id: "project.switcher",
    group: "workspace",
    labelKey: "shortcuts.cmdProjectSwitcher",
    defaultChord: "Mod+O",
    run: () => useUiStore.getState().toggleCommandPalette("projects"),
  },
  {
    id: "project.next",
    group: "workspace",
    labelKey: "shortcuts.cmdProjectNext",
    defaultChord: "Mod+Shift+PageDown",
    run: () => cycleProject(1),
  },
  {
    id: "project.prev",
    group: "workspace",
    labelKey: "shortcuts.cmdProjectPrev",
    defaultChord: "Mod+Shift+PageUp",
    run: () => cycleProject(-1),
  },
  {
    id: "workspace.switcher",
    group: "workspace",
    labelKey: "shortcuts.cmdWorkspaceSwitcher",
    defaultChord: "Mod+Shift+O",
    run: () => useUiStore.getState().toggleCommandPalette("workspaces"),
  },
  {
    id: "workspace.next",
    group: "workspace",
    labelKey: "shortcuts.cmdWorkspaceNext",
    defaultChord: "Mod+Alt+PageDown",
    run: () => cycleWorkspace(1),
  },
  {
    id: "workspace.prev",
    group: "workspace",
    labelKey: "shortcuts.cmdWorkspacePrev",
    defaultChord: "Mod+Alt+PageUp",
    run: () => cycleWorkspace(-1),
  },
  {
    id: "branch.switcher",
    group: "workspace",
    labelKey: "shortcuts.cmdBranchSwitcher",
    defaultChord: "Mod+Shift+B",
    run: () => useUiStore.getState().toggleBranchSwitcher(),
  },

  {
    id: "git.fetch",
    group: "git",
    labelKey: "statusbar.fetch",
    defaultChord: "Mod+Shift+R",
    run: fetchNow,
  },
  {
    id: "git.pull",
    group: "git",
    labelKey: "statusbar.pull",
    defaultChord: "Mod+Shift+D",
    run: pullNow,
  },
  {
    id: "git.push",
    group: "git",
    labelKey: "statusbar.push",
    defaultChord: "Mod+Shift+U",
    run: pushNow,
  },
  {
    id: "pr.fromLink",
    group: "git",
    labelKey: "prLink.menuItem",
    defaultChord: "Mod+Shift+L",
    run: () => useUiStore.getState().togglePrLinkModal(),
  },
];

export const SHORTCUT_BY_ID = new Map(SHORTCUT_COMMANDS.map((c) => [c.id, c]));

/**
 * Chords the editor owns. They aren't configurable here — some belong to Monaco itself — but the
 * settings screen warns before a user assigns one of them to an app action, since the app action
 * would only ever fire outside the editor and feel broken inside it.
 */
export const EDITOR_RESERVED: { chord: Chord; labelKey: TranslationKey }[] = [
  { chord: "Mod+F", labelKey: "shortcuts.findInFile" },
  { chord: "Mod+G", labelKey: "shortcuts.goToLine" },
  { chord: "Mod+S", labelKey: "editor.save" },
  { chord: "Mod+W", labelKey: "editor.closeTab" },
  { chord: "Mod+PageDown", labelKey: "shortcuts.nextTab" },
  { chord: "Mod+PageUp", labelKey: "shortcuts.prevTab" },
  { chord: "Mod+I", labelKey: "shortcuts.inlineEdit" },
  { chord: "Mod+/", labelKey: "shortcuts.toggleComment" },
  { chord: "Mod+D", labelKey: "shortcuts.selectNextOccurrence" },
  { chord: "Alt+ArrowUp", labelKey: "shortcuts.moveLine" },
  { chord: "Alt+ArrowDown", labelKey: "shortcuts.moveLine" },
  { chord: "Mod+Shift+K", labelKey: "shortcuts.deleteLine" },
  { chord: "Mod+Z", labelKey: "shortcuts.undo" },
];

export function reservedBy(chord: Chord): TranslationKey | null {
  return EDITOR_RESERVED.find((r) => r.chord === chord)?.labelKey ?? null;
}
