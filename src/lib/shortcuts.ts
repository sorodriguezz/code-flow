import { useUiStore, type ApiWorkspace, type MainView } from "../state/uiStore";
import { useLayoutStore } from "../state/layoutStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useTerminalStore } from "../state/terminalStore";
import { useNavigationStore } from "../state/navigationStore";
import { useEditorCommandStore } from "../state/editorCommandStore";
import { useApiCommandStore } from "../state/apiCommandStore";
import { useDbCommandStore } from "../state/dbCommandStore";
import { useDbStore } from "../state/dbStore";
import { useDbModalStore } from "../state/dbModalStore";
import { fetchNow, pullNow, pushNow } from "./gitActions";
import type { Chord } from "./keys";
import type { TranslationKey } from "./i18n/translations";

export type ShortcutGroup =
  | "general"
  | "panels"
  | "views"
  | "editor"
  | "database"
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
  | "terminal.new"
  | "view.graph"
  | "view.changes"
  | "view.editor"
  | "view.api"
  | "view.database"
  | "view.agents"
  | "view.stories"
  | "db.newConsole"
  | "db.connections"
  | "db.refresh"
  | "db.filter"
  | "db.apply"
  | "db.askAi"
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
  | "editor.nextChange"
  | "editor.prevChange"
  | "editor.newFile"
  | "editor.newFolder"
  | "editor.renamePath"
  | "editor.deletePath"
  | "editor.save"
  | "editor.closeTab"
  | "editor.nextTab"
  | "editor.prevTab"
  | "editor.inlineEdit"
  | "editor.find"
  | "editor.goToLine"
  | "editor.toggleComment"
  | "editor.selectNextOccurrence"
  | "editor.moveLineUp"
  | "editor.moveLineDown"
  | "editor.deleteLine"
  | "editor.undo"
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
  /**
   * The Monaco action this chord fires, for the commands whose behaviour lives inside the editor.
   *
   * These used to be `EDITOR_RESERVED`: a list of chords the settings screen could only *warn*
   * about, because the actions behind them are Monaco's and the app had no way to move them. It
   * does now — `applyEditorKeybindings` rewrites Monaco's own keybinding table from this registry —
   * so they are ordinary rebindable commands, and the special case they needed is gone. That also
   * means collisions between an editor chord and an app chord are caught by the same duplicate
   * check as every other pair, instead of by a second mechanism that only knew about a fixed list.
   *
   * A command with one of these has **no `run`**: pressing it inside the editor is handled by
   * Monaco, and outside the editor there is nothing to handle.
   */
  monacoCommand?: string;
  run?: () => void;
}

export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, TranslationKey> = {
  general: "shortcuts.groupGeneral",
  panels: "shortcuts.groupPanels",
  views: "shortcuts.groupViews",
  editor: "shortcuts.groupEditor",
  database: "shortcuts.groupDatabase",
  navigation: "shortcuts.navigation",
  workspace: "shortcuts.groupWorkspace",
  git: "shortcuts.groupGit",
};

/**
 * The screens, in the order the keyboard walks them.
 *
 * A destination is a view *and*, for the two that share one, which workspace inside it — the API
 * client and the database are both `activeView: "api"`, so naming only the view isn't enough to say
 * where to go. It used to be a plain `MainView[]`, which meant `setActiveView("api")` from the
 * database left `apiWorkspace` where it was and the screen didn't move: ⌘4 and ⌘5 were two numbers
 * for whichever of the two you had open last.
 */
const VIEW_ORDER: { view: MainView; workspace?: ApiWorkspace }[] = [
  { view: "graph" },
  { view: "changes" },
  { view: "editor" },
  { view: "api", workspace: "requests" },
  { view: "api", workspace: "database" },
  { view: "agents" },
  { view: "stories" },
];

/** Goes to a destination, using whichever setter can express it. */
function goTo(destination: { view: MainView; workspace?: ApiWorkspace }): void {
  const ui = useUiStore.getState();
  if (destination.workspace) ui.openApiWorkspace(destination.workspace);
  else ui.setActiveView(destination.view);
}

function cycleView(delta: number): void {
  const { activeView, apiWorkspace } = useUiStore.getState();
  const index = VIEW_ORDER.findIndex(
    (entry) =>
      entry.view === activeView &&
      (entry.workspace === undefined || entry.workspace === apiWorkspace),
  );
  goTo(VIEW_ORDER[(index + delta + VIEW_ORDER.length) % VIEW_ORDER.length]);
}

/** Replays a history entry — shared with the title bar's back/forward chevrons so both routes
 * apply an entry the same way. */
export function goHistory(direction: "back" | "forward"): void {
  const entry = useNavigationStore.getState()[direction]();
  if (!entry) return;
  useUiStore.getState().setActiveView(entry.view);
  if (entry.projectId) useWorkspaceStore.getState().setActiveProject(entry.projectId);
}

/**
 * Opens a SQL console on the connection the keystroke most likely meant.
 *
 * In order: the one behind the tab you are looking at, then any connection that is already open,
 * then the first one configured. With none at all the console would have nothing to run against, so
 * the shortcut opens the data sources dialog instead — landing somewhere useful beats doing nothing
 * and looking broken.
 */
function newDbConsole(): void {
  const db = useDbStore.getState();
  const active = db.tabs.find((tab) => tab.id === db.activeTabId);
  const connectionId =
    active?.connectionId ?? db.connected[0] ?? db.connections[0]?.id ?? null;
  useUiStore.getState().openApiWorkspace("database");
  if (!connectionId) {
    useDbModalStore.getState().openDbModal({ kind: "connections" });
    return;
  }
  db.newConsole(connectionId);
}

/**
 * Saves whatever the screen is showing: the open request in the API client, otherwise the file in
 * the editor.
 *
 * One chord, two owners, because ⌘S means the same thing in both and `activeChords` only keeps one
 * command per chord — a second registry entry for the API client would silently lose the binding to
 * this one, and the settings screen would list two rows fighting over ⌘S.
 *
 * The API client is offered it first and answers whether it took it, so the fallback is not a guess
 * about which view is up. The editor's own bus does the same check on its side (see
 * `editorCommandStore.send`), which is why a ⌘S pressed anywhere else stays a no-op rather than
 * saving a file nobody is looking at.
 */
function saveActive(): void {
  if (useApiCommandStore.getState().send("save")) return;
  useEditorCommandStore.getState().send("save");
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
    // Through the store's action rather than a raw `setState`: this is the user asking for the
    // panel to be a given size, which is exactly the decision `toggleFlag` writes to disk. The
    // tour moves the same flag and deliberately does *not* go through here — see `applyStage`.
    run: () => useLayoutStore.getState().toggleFlag("sidebarCollapsed"),
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
    id: "terminal.new",
    group: "panels",
    labelKey: "shortcuts.cmdTerminalNew",
    // What VS Code binds "Create New Terminal" to, and distinct from Mod+J above: that one shows
    // and hides the dock, this one puts a shell in it.
    defaultChord: "Mod+Shift+`",
    run: () => {
      // A shell is opened *in* a repository — there's no sensible cwd without one, and the `+`
      // button in the dock is disabled for the same reason.
      const project = useWorkspaceStore.getState().activeProject();
      if (!project) return;
      // No profile id: that's what makes this honour the default chosen in Settings › Terminal,
      // resolved back in `shell_profiles::choose` (requested → configured → platform default).
      // `openNew` raises the dock itself, so this works with the panel closed.
      void useTerminalStore.getState().openNew(project.id, project.local_path);
    },
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
    run: () => useUiStore.getState().openApiWorkspace("requests"),
  },
  {
    id: "view.database",
    group: "views",
    labelKey: "db.title",
    defaultChord: "Mod+5",
    run: () => useUiStore.getState().openApiWorkspace("database"),
  },
  {
    id: "view.agents",
    group: "views",
    labelKey: "tabbar.agents",
    defaultChord: "Mod+6",
    run: () => useUiStore.getState().setActiveView("agents"),
  },
  {
    id: "view.stories",
    group: "views",
    labelKey: "tabbar.stories",
    defaultChord: "Mod+7",
    run: () => useUiStore.getState().setActiveView("stories"),
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

  /*
   * Walk the open file's uncommitted hunks — ⌥F5 forward, ⇧⌥F5 back — opening the inline change peek
   * at each stop, which is what VS Code binds Go to Next/Previous Change to. Matching it is the same
   * argument `F2` above makes: the muscle memory is already there.
   *
   * A function key because the two places it has to work are the two hardest to bind for. Monaco ships
   * `F7`/`F8`/`F12` and their shifted variants, and Monaco handles its own chord first and
   * `preventDefault`s it — so a bare function key it claims is silently dead in the editor, which is
   * the only place "next change" means anything. And a chord without ⌘/Ctrl is otherwise suppressed
   * while the caret is in a text field, which `isTypingTarget` counts the code editor as; `Alt` plus a
   * function key clears that twice over.
   *
   * ⌥F5 is free on both counts — the whole registry has exactly one function key today (`F2`), and
   * Monaco's own table does not reach F5.
   *
   * `Alt+Shift+F5`, not `Shift+Alt+F5`: modifiers are stored in `eventToChord`'s order (Mod, Ctrl, Alt,
   * Shift) and a chord written any other way is a string no keypress will ever produce.
   */
  {
    id: "editor.nextChange",
    group: "editor",
    labelKey: "shortcuts.nextChange",
    defaultChord: "Alt+F5",
    run: () => useEditorCommandStore.getState().send("nextChange"),
  },
  {
    id: "editor.prevChange",
    group: "editor",
    labelKey: "shortcuts.prevChange",
    defaultChord: "Alt+Shift+F5",
    run: () => useEditorCommandStore.getState().send("prevChange"),
  },

  /*
   * The explorer's four, all acting on the row the tree has focused.
   *
   * ⇧⌘N and ⌥⇧⌘N pair on purpose — one letter, the folder variant wearing the extra modifier — and
   * neither is taken. `F2` is the rename key in every file manager and IDE worth matching, and it
   * is the one kind of chord that can be bound bare: a function key produces no text, so it fires
   * with the caret in a field instead of typing into it. ⌘⌫ is the platform's own "move to trash",
   * which is exactly what this does.
   */
  {
    id: "editor.newFile",
    group: "editor",
    labelKey: "editor.newFile",
    defaultChord: "Mod+Shift+N",
    run: () => useEditorCommandStore.getState().send("newFile"),
  },
  {
    id: "editor.newFolder",
    group: "editor",
    labelKey: "editor.newFolder",
    defaultChord: "Mod+Alt+Shift+N",
    run: () => useEditorCommandStore.getState().send("newFolder"),
  },
  {
    id: "editor.renamePath",
    group: "editor",
    labelKey: "editor.rename",
    defaultChord: "F2",
    run: () => useEditorCommandStore.getState().send("renamePath"),
  },
  {
    id: "editor.deletePath",
    group: "editor",
    labelKey: "editor.delete",
    defaultChord: "Mod+Backspace",
    run: () => useEditorCommandStore.getState().send("deletePath"),
  },

  /*
   * The editor's own keys — everything that used to be `EDITOR_RESERVED`.
   *
   * They were unrebindable for two different reasons, and both are now dealt with rather than
   * documented. The first four were hard-coded `keydown` listeners inside `EditorView` comparing
   * `e.key` to literals — the same shape this file already replaced once for the file-tree actions,
   * and the same fix: they send through `editorCommandStore` like every other editor action. The
   * rest are **Monaco's**, and are carried by `monacoCommand` into `applyEditorKeybindings`, which
   * rewrites the editor's own keybinding table to match whatever the user set here.
   *
   * The defaults are unchanged, and deliberately: they are VS Code's, which is the point of them.
   * What changes is that somebody who wants their JetBrains or Vim muscle memory back can now have
   * it, and the settings screen tells them when a choice collides instead of a fixed list of chords
   * nobody could move.
   */
  {
    id: "editor.save",
    group: "editor",
    labelKey: "editor.save",
    defaultChord: "Mod+S",
    // Not the editor's alone, despite the group it is listed under: see `saveActive`.
    run: saveActive,
  },
  {
    id: "editor.closeTab",
    group: "editor",
    labelKey: "editor.closeTab",
    defaultChord: "Mod+W",
    run: () => useEditorCommandStore.getState().send("closeTab"),
  },
  {
    id: "editor.nextTab",
    group: "editor",
    labelKey: "shortcuts.nextTab",
    defaultChord: "Mod+PageDown",
    run: () => useEditorCommandStore.getState().send("nextTab"),
  },
  {
    id: "editor.prevTab",
    group: "editor",
    labelKey: "shortcuts.prevTab",
    defaultChord: "Mod+PageUp",
    run: () => useEditorCommandStore.getState().send("prevTab"),
  },
  // Registered on the Monaco instance rather than on `window`, so it only fires with the caret in
  // the code — but the chord it is registered *with* now comes from here.
  {
    id: "editor.inlineEdit",
    group: "editor",
    labelKey: "shortcuts.inlineEdit",
    defaultChord: "Mod+I",
    monacoCommand: "cf-inline-edit",
  },
  { id: "editor.find", group: "editor", labelKey: "shortcuts.findInFile", defaultChord: "Mod+F", monacoCommand: "actions.find" },
  { id: "editor.goToLine", group: "editor", labelKey: "shortcuts.goToLine", defaultChord: "Mod+G", monacoCommand: "editor.action.gotoLine" },
  { id: "editor.toggleComment", group: "editor", labelKey: "shortcuts.toggleComment", defaultChord: "Mod+/", monacoCommand: "editor.action.commentLine" },
  {
    id: "editor.selectNextOccurrence",
    group: "editor",
    labelKey: "shortcuts.selectNextOccurrence",
    defaultChord: "Mod+D",
    monacoCommand: "editor.action.addSelectionToNextFindMatch",
  },
  {
    id: "editor.moveLineUp",
    group: "editor",
    labelKey: "shortcuts.moveLineUp",
    defaultChord: "Alt+ArrowUp",
    monacoCommand: "editor.action.moveLinesUpAction",
  },
  {
    id: "editor.moveLineDown",
    group: "editor",
    labelKey: "shortcuts.moveLineDown",
    defaultChord: "Alt+ArrowDown",
    monacoCommand: "editor.action.moveLinesDownAction",
  },
  {
    id: "editor.deleteLine",
    group: "editor",
    labelKey: "shortcuts.deleteLine",
    defaultChord: "Mod+Shift+K",
    monacoCommand: "editor.action.deleteLines",
  },
  { id: "editor.undo", group: "editor", labelKey: "shortcuts.undo", defaultChord: "Mod+Z", monacoCommand: "undo" },

  /*
   * The database workspace's actions.
   *
   * `Mod+Alt+…` throughout, because the unmodified pairs are taken by things people press far more
   * often — ⇧⌘R is fetch, ⌘F is Monaco's find — and a database shortcut that stole one of those
   * would be a bad trade for a workspace you are not always in.
   */
  {
    id: "db.newConsole",
    group: "database",
    labelKey: "db.newConsole",
    defaultChord: "Mod+Alt+N",
    run: newDbConsole,
  },
  {
    id: "db.connections",
    group: "database",
    labelKey: "db.dataSources",
    defaultChord: "Mod+Alt+C",
    run: () => {
      useUiStore.getState().openApiWorkspace("database");
      useDbModalStore.getState().openDbModal({ kind: "connections" });
    },
  },
  {
    id: "db.refresh",
    group: "database",
    labelKey: "db.refresh",
    defaultChord: "Mod+Alt+R",
    run: () => useDbCommandStore.getState().send("refresh"),
  },
  {
    id: "db.filter",
    group: "database",
    labelKey: "db.filter",
    defaultChord: "Mod+Alt+F",
    run: () => useDbCommandStore.getState().send("filter"),
  },
  {
    id: "db.apply",
    group: "database",
    labelKey: "db.apply",
    defaultChord: "Mod+Alt+Enter",
    run: () => useDbCommandStore.getState().send("apply"),
  },
  // `Mod+Alt+I` and not the editor's `Mod+I`, which is the same idea one screen over. Two registry
  // entries on one chord would be flagged by the settings screen's duplicate check — correctly, as
  // far as it can see — even though the two are scoped to different editors. The database group's
  // own convention is `Mod+Alt+…` anyway.
  {
    id: "db.askAi",
    group: "database",
    labelKey: "db.askAi",
    defaultChord: "Mod+Alt+I",
    run: () => useDbCommandStore.getState().send("askAi"),
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

