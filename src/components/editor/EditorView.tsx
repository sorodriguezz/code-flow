import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  Bookmark,
  Bug,
  Palette,
  FileCode,
  FileSearch,
  Files,
  FolderInput,
  GitBranch,
  Keyboard,
  PanelRightClose,
  Search,
  Tags,
} from "lucide-react";
import { FileTree, parentDir, type ExplorerCommand } from "./FileTree";
import { FilePalette } from "./FilePalette";
import { SearchPanel } from "./SearchPanel";
import { AnchorsPanel } from "./AnchorsPanel";
import { BookmarksPanel } from "./BookmarksPanel";
import { CodeSnapModal, type CodeSnapTarget } from "./CodeSnapModal";
import { DebugPanel } from "./DebugPanel";
import { IconRulesPanel } from "./IconRulesPanel";
import { EditorPane, type OpenTab, type RevealRequest, type ViewMode } from "./EditorPane";
import { ChangesPanel } from "../git/ChangesPanel";
import { MODEL_SCHEME, modelPathFor } from "../../lib/editorModel";
import { setDefinitionContext } from "../../lib/goToDefinition";
import {
  closeAllInGroups,
  closeGroupInGroups,
  closeTabInGroups,
  moveTabInGroups,
  newGroup,
  openInGroups,
  splitGroups,
  togglePinInGroups,
  type EditorGroup,
} from "../../lib/editorGroups";
import { copyIntoRepo, readFileText, writeFileText } from "../../lib/tauri/commands";
import { onRepoFsChanged } from "../../lib/tauri/events";
import { findTheme } from "../../lib/codeThemes";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useThemeStore } from "../../state/themeStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useDebugStore, normalizePath } from "../../state/debugStore";
import { useBookmarkStore } from "../../state/bookmarkStore";
import { useEditorCommandStore } from "../../state/editorCommandStore";
import type { TabDrag } from "../../state/tabDragStore";
import { useTreeDragStore } from "../../state/treeDragStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { ActivePill } from "../common/ActivePill";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { useT } from "../../state/languageStore";
import { useShortcutHint } from "../../lib/useShortcutHint";

const TREE_MIN = 200;
const TREE_MAX = 480;
/** The docked Changes panel. Wider floor than the file tree: its rows carry a status letter, a
 * path and three action buttons, and the commit box under them has to fit a message. */
const CHANGES_MIN = 240;
const CHANGES_MAX = 560;
const GROUP_MAX = 2000;
/** Matches the `w-px` on `ResizeHandle`, which the even-split maths has to account for. */
const HANDLE_WIDTH = 1;
/**
 * Hard floor on a group's width — the bug this fixes was worth the constant.
 *
 * A pane's tab strip can shrink to nothing, but the toolbar beside it (split, close group, save)
 * cannot: it's `shrink-0`, so once the pane is narrower than the toolbar the buttons overflow and
 * get clipped by the pane's own `overflow-hidden`. Splitting a few times used to produce panes
 * you could no longer split *or close* — the controls were still there, just painted outside the
 * box. Below this width the row scrolls horizontally instead, which keeps every control reachable
 * however many times you split.
 */
const GROUP_MIN = 320;

export function EditorView() {
  const t = useT();
  const shortcutHint = useShortcutHint();
  const project = useWorkspaceStore((s) => s.activeProject());
  const status = useRepoStore((s) => s.status);
  const changedPaths = useMemo(() => {
    const map = new Map<string, string>();
    if (status) {
      // Untracked/unstaged first, then staged overwrites — an already-staged edit that's
      // since changed further should show its current (unstaged) status, not the stale one.
      for (const e of status.untracked) map.set(e.path, e.status);
      for (const e of status.unstaged) map.set(e.path, e.status);
      for (const e of status.staged) if (!map.has(e.path)) map.set(e.path, e.status);
    }
    return map;
  }, [status]);
  const resolved = useThemeStore((s) => s.resolved);
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const darkThemeId = useThemeStore((s) => s.darkThemeId);
  const lightThemeId = useThemeStore((s) => s.lightThemeId);
  // The scheme Monaco is painting with, as data rather than as its registered name — the code
  // snapshot renders tokens itself and needs the palette, not the id.
  const activeCodeTheme = useMemo(
    () => findTheme(resolved === "dark" ? darkThemeId : lightThemeId, resolved),
    [resolved, darkThemeId, lightThemeId],
  );
  const workingDiff = useRepoStore((s) => s.workingDiff);
  const stagedDiff = useRepoStore((s) => s.stagedDiff);
  const activeView = useUiStore((s) => s.activeView);
  const pendingEditorPath = useUiStore((s) => s.pendingEditorPath);
  const pendingEditorLine = useUiStore((s) => s.pendingEditorLine);
  const clearPendingEditorPath = useUiStore((s) => s.clearPendingEditorPath);
  const treeWidth = useLayoutStore((s) => s.sizes.editorTreeWidth);
  const changesWidth = useLayoutStore((s) => s.sizes.editorChangesWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  /** Files with something uncommitted, counted the way the Changes tab counts them — one per
   * path, however many lists it appears in. Shown on the toggle so a closed panel still says
   * there's something in it. */
  const uncommittedCount = useMemo(() => {
    if (!status) return 0;
    const paths = new Set<string>();
    for (const list of [status.staged, status.unstaged, status.untracked, status.conflicted]) {
      for (const entry of list) paths.add(entry.path);
    }
    return paths.size;
  }, [status]);

  /** Every open file, once, however many groups are showing it. */
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [groups, setGroups] = useState<EditorGroup[]>(() => [newGroup()]);
  const [activeGroupId, setActiveGroupId] = useState<string>(() => groups[0].id);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidePanel, setSidePanel] = useState<
    "files" | "search" | "anchors" | "bookmarks" | "debug" | "icons"
  >("files");
  /** The docked Changes panel on the right. Closed by default and session-only: it's a mode you
   * step into while committing, not a layout preference — the editor's resting state is code. */
  const [changesOpen, setChangesOpen] = useState(false);
  /** The snapshot being composed, or `null` when the dialog is closed. */
  const [codeSnap, setCodeSnap] = useState<CodeSnapTarget | null>(null);
  /** Which group should jump where. Scoped to a group because "go to this search hit" means the
   * pane the user is working in, not every pane that happens to have the file open. */
  const [reveal, setReveal] = useState<{ groupId: string; request: RevealRequest } | null>(null);
  const revealNonce = useRef(0);
  /** A keybinding aimed at the explorer, on its way down to `FileTree` — same shape and same
   * reason as `reveal` above: the tree owns the focused row, so the request has to reach it. */
  const [explorerCommand, setExplorerCommand] = useState<{
    command: ExplorerCommand;
    nonce: number;
    path?: string;
  } | null>(null);
  /** The folder a drag out of Finder/Explorer is currently hovering, or `null` when there is no
   * drop in flight over the editor. `""` is the project root. */
  const [dropDir, setDropDir] = useState<string | null>(null);
  /** Width of every group but the last, which flexes. Session-only: a split is a transient
   * arrangement, not a setting. */
  const [groupWidths, setGroupWidths] = useState<number[]>([]);
  const groupsRowRef = useRef<HTMLDivElement>(null);
  /** The focused pane's "capture a snapshot" function, re-registered whenever focus moves, so
   * the keyboard shortcut reaches the group the user is looking at even from outside the code. */
  const captureRef = useRef<(() => void) | null>(null);
  /** Same idea for "bookmark the line the caret is on" — only the pane holding the caret can. */
  const bookmarkToggleRef = useRef<(() => void) | null>(null);

  // Assigned during render, not in an effect: the callbacks below read them to decide what to do
  // *now*, and a ref that lagged a render would act on the previous tab or group.
  const tabsRef = useRef<OpenTab[]>(tabs);
  tabsRef.current = tabs;
  const groupsRef = useRef<EditorGroup[]>(groups);
  groupsRef.current = groups;
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;
  // Read by the tab commands, which arrive from the shortcut registry rather than from a listener
  // this component re-registers whenever the visible view changes.
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  // Read by the file-drop listener, which is registered once and must not be torn down and
  // re-registered every time the open project changes.
  const projectRef = useRef(project);
  projectRef.current = project;
  /** Numbers this view's own requests to the explorer, which share a channel with the keybinding
   * store's — see the guard in `FileTree`. */
  const dropNonce = useRef(0);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? groups[0],
    [groups, activeGroupId],
  );
  const activePath = activeGroup?.activePath ?? null;
  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [tabs, activePath]);
  const activeContent = activeTab?.content ?? "";

  // `useT()` hands back a fresh function every render; callbacks that only need it to
  // build a message read it through this ref instead of taking it as a dependency and
  // re-identifying (and re-subscribing their listeners) on every keystroke.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  const activeAbsolutePath = useMemo(
    () => (project && activePath ? normalizePath(`${project.local_path}/${activePath}`) : null),
    [project, activePath],
  );
  const debugStatus = useDebugStore((s) => s.status);

  // Same "unstaged wins, else staged" priority as the file tree's own indicator, so the
  // gutter/minimap markers always match whatever status letter that file is showing there.
  const fileDiffFor = useCallback(
    (path: string) =>
      workingDiff.find((f) => (f.new_path ?? f.old_path) === path) ??
      stagedDiff.find((f) => (f.new_path ?? f.old_path) === path),
    [workingDiff, stagedDiff],
  );

  const patchTab = useCallback((path: string, patch: Partial<OpenTab>) => {
    setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)));
  }, []);

  const openFile = useCallback(
    async (path: string, opts?: { pin?: boolean; groupId?: string }) => {
      if (!project) return;
      const pin = opts?.pin ?? false;
      const targetId = opts?.groupId ?? activeGroupIdRef.current;
      const alreadyOpen = tabsRef.current.some((tab) => tab.path === path);

      const outcome = openInGroups(groupsRef.current, targetId, path, pin, (p) =>
        Boolean(tabsRef.current.find((tab) => tab.path === p)?.preview),
      );
      setGroups(outcome.groups);
      setActiveGroupId(targetId);

      setTabs((prev) => {
        // An evicted preview only leaves the registry if no other group was showing it too.
        const kept = outcome.evictedFully ? prev.filter((tab) => tab.path !== outcome.evicted) : prev;
        if (alreadyOpen) return pin ? kept.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)) : kept;
        return [...kept, { path, content: "", originalContent: "", loading: true, viewMode: "code", preview: !pin }];
      });
      if (alreadyOpen) return;

      try {
        const text = await readFileText(project.local_path, path);
        patchTab(path, { content: text, originalContent: text, loading: false });
      } catch (e) {
        const message = tRef.current("editor.failedToOpen", { error: String(e) });
        patchTab(path, { content: message, originalContent: message, loading: false });
      }
    },
    [project, patchTab],
  );

  const closeTab = useCallback(async (groupId: string, path: string) => {
    const tab = tabsRef.current.find((item) => item.path === path);
    if (!tab) return;
    // Only the *last* view of a file is a real close — shutting one of two panes onto the same
    // buffer loses nothing, so it has no business asking.
    const viewCount = groupsRef.current.filter((g) => g.paths.includes(path)).length;
    if (viewCount <= 1 && tab.content !== tab.originalContent) {
      const ok = await confirmAction(
        tRef.current("editor.closeDirtyConfirm", { name: path.split("/").pop() ?? path }),
        true,
      );
      if (!ok) return;
    }
    // Re-read after the (awaited) confirm — groups can have moved on while the modal was up.
    const next = closeTabInGroups(groupsRef.current, groupId, path);
    setGroups(next);
    if (!next.some((g) => g.id === activeGroupIdRef.current)) setActiveGroupId(next[0].id);
    // Out of every group means out of the registry — which is also what disposes its model.
    if (!next.some((g) => g.paths.includes(path))) setTabs((prev) => prev.filter((item) => item.path !== path));
  }, []);

  /** One handler for both gestures: dragging a tab along its own strip and dragging it into
   * another split are the same move, differing only in the target group. */
  const dropTab = useCallback((payload: TabDrag, targetGroupId: string, targetIndex: number) => {
    const outcome = moveTabInGroups(groupsRef.current, payload, targetGroupId, targetIndex);
    if (!outcome) return;
    setGroups(outcome.groups);
    setActiveGroupId(outcome.focusId);
  }, []);

  /** Splits a group's current file into a new group to its right and focuses it — see
   * `splitGroups` for why only the active file crosses over. */
  const splitGroup = useCallback((groupId?: string, path?: string) => {
    const outcome = splitGroups(groupsRef.current, groupId ?? activeGroupIdRef.current, path);
    if (!outcome) return;
    setGroups(outcome.groups);
    setActiveGroupId(outcome.focusId);
  }, []);

  /** Pinning is what makes a peeked file stay: it also promotes the preview tab, so the pinned
   * tab isn't the one the next single-click in the tree recycles. */
  const togglePinned = useCallback(
    (groupId: string, path: string) => {
      setGroups((prev) => togglePinInGroups(prev, groupId, path));
      patchTab(path, { preview: false });
    },
    [patchTab],
  );

  /** Closes a group's unpinned tabs, asking once for the whole set rather than once per file —
   * the same bargain `closeGroup` strikes, and for the same reason: a queue of modals is not a
   * question, it's an obstacle. */
  const closeAllTabs = useCallback(async (groupId: string) => {
    const group = groupsRef.current.find((g) => g.id === groupId);
    // Pinned tabs sit out the sweep (see `closeAllInGroups`), so a strip of nothing but pinned tabs
    // has nothing to close — and nothing to confirm.
    const closing = group?.paths.filter((p) => !group.pinned.includes(p)) ?? [];
    if (closing.length === 0) return;
    // Only files this group is the last to show can lose anything — the rest survive in another
    // split with their edits intact.
    const unsaved = closing.filter(
      (p) =>
        groupsRef.current.filter((g) => g.paths.includes(p)).length <= 1 &&
        tabsRef.current.some((tab) => tab.path === p && tab.content !== tab.originalContent),
    );
    if (unsaved.length > 0) {
      const ok = await confirmAction(tRef.current("editor.closeAllDirtyConfirm", { n: unsaved.length }), true);
      if (!ok) return;
    }
    // Re-read after the (awaited) confirm, exactly as `closeTab` does.
    const next = closeAllInGroups(groupsRef.current, groupId);
    setGroups(next);
    if (!next.some((g) => g.id === activeGroupIdRef.current)) setActiveGroupId(next[0].id);
    setTabs((prev) => prev.filter((tab) => next.some((g) => g.paths.includes(tab.path))));
  }, []);

  /** The absolute path, built the same way the file tree's own "Copy Path" builds it — the point
   * of copying one is to paste it outside this app, and two menus that disagree about what a path
   * looks like is one of them being wrong. */
  const copyPath = useCallback(
    (path: string) => {
      if (!project) return;
      void navigator.clipboard.writeText(`${project.local_path}/${path}`).catch((e) => pushErrorToast(String(e)));
    },
    [project],
  );

  const closeGroup = useCallback(async (groupId: string) => {
    const outcome = closeGroupInGroups(groupsRef.current, groupId);
    if (!outcome) return;
    // Files this group was the last to show go with it. Unsaved ones get the same question a
    // dirty tab gets — asked once for the group, rather than once per file.
    const unsaved = outcome.orphaned.filter((p) =>
      tabsRef.current.some((tab) => tab.path === p && tab.content !== tab.originalContent),
    );
    if (unsaved.length > 0) {
      const ok = await confirmAction(tRef.current("editor.closeGroupDirtyConfirm", { n: unsaved.length }), true);
      if (!ok) return;
    }
    setGroups(outcome.groups);
    setActiveGroupId(outcome.focusId);
    setTabs((prev) => prev.filter((tab) => outcome.groups.some((g) => g.paths.includes(tab.path))));
  }, []);

  const save = useCallback(
    async (path: string) => {
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!project || !tab || tab.content === tab.originalContent) return;
      const text = tab.content;
      setSaving(true);
      try {
        await writeFileText(project.local_path, path, text);
        setTabs((prev) => prev.map((item) => (item.path === path ? { ...item, originalContent: text } : item)));
        // The Changes tab (and any conflict-resolution flow) reads git status from
        // repoStore, which has no way to know a file changed on disk outside of a git
        // command — refresh it explicitly so a save here shows up immediately there.
        void useRepoStore.getState().refreshStatus();
      } finally {
        setSaving(false);
      }
    },
    [project],
  );

  /**
   * Save, close and the two tab moves used to be `keydown` listeners right here, comparing
   * `e.key` to `"s"`, `"w"` and `"PageUp"`. That is what made the four keys anyone uses most in
   * an editor the only ones in the app nobody could rebind — and it is the same shape this file
   * already moved away from once for the explorer's actions.
   *
   * They arrive through `editorCommandStore` now, from the same registry as everything else, so
   * the settings screen owns their chords and the duplicate check covers them. What is kept is the
   * gating: tab moves only mean something while the Editor is the visible view, because this panel
   * stays mounted in the background and closing an invisible file while somebody reads the graph
   * would be baffling.
   */
  const tabCommand = (command: "closeTab" | "nextTab" | "prevTab") => {
    if (activeViewRef.current !== "editor") return;
    const group = groupsRef.current.find((g) => g.id === activeGroupIdRef.current);
    if (!group) return;
    if (command === "closeTab") {
      if (group.activePath) void closeTab(group.id, group.activePath);
      return;
    }
    if (group.paths.length < 2 || !group.activePath) return;
    const index = group.paths.indexOf(group.activePath);
    const delta = command === "nextTab" ? 1 : -1;
    const target = group.paths[(index + delta + group.paths.length) % group.paths.length];
    setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, activePath: target } : g)));
  };

  // Otherwise switching projects leaves the previous repo's files open — everything else
  // (branch, file tree, status) points at the new repo. Done during render rather than in
  // an effect so the editor never paints one repo's tabs against another's tree.
  const [lastProjectPath, setLastProjectPath] = useState<string | null>(project?.local_path ?? null);
  if ((project?.local_path ?? null) !== lastProjectPath) {
    setLastProjectPath(project?.local_path ?? null);
    setTabs([]);
    const fresh = newGroup();
    setGroups([fresh]);
    setActiveGroupId(fresh.id);
  }

  // Models outlive the editor (see `keepCurrentModel`), so a file leaving the registry has to
  // dispose its model explicitly or everything ever opened stays in memory. Keyed on *which*
  // files are open rather than on `tabs` itself, so this isn't swept on every keystroke.
  // Newline is the one character a path can't contain.
  const openPathsKey = tabs.map((tab) => tab.path).join("\n");
  useEffect(() => {
    if (!project) return;
    // Both sides go through `Uri.parse().toString()` so the comparison is against Monaco's
    // own normalization of the path rather than the raw string we handed it.
    const open = new Set(tabsRef.current.map((tab) => monaco.Uri.parse(modelPathFor(project, tab.path)).toString()));
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme === MODEL_SCHEME && !open.has(model.uri.toString())) model.dispose();
    }
  }, [openPathsKey, project]);

  // Bookmarks are stored per project, so opening one is what decides which set is in force. The
  // store no-ops when the path hasn't changed, which is what makes this safe to run on a render
  // that only changed a tab.
  useEffect(() => {
    if (project) void useBookmarkStore.getState().load(project.local_path);
  }, [project]);

  // Reload open files from disk when they change externally — a terminal `git` command, an
  // edit in another editor, a branch checkout — instead of silently showing stale content
  // until the user happens to reopen them. Tabs with unsaved local edits are skipped so this
  // never clobbers work in progress; the user's own edit wins until they save or discard it.
  useEffect(() => {
    if (!project) return;
    const unlisten = onRepoFsChanged((e) => {
      if (e.repo_path !== project.local_path) return;
      for (const tab of tabsRef.current) {
        if (tab.loading || tab.content !== tab.originalContent) continue;
        void readFileText(project.local_path, tab.path)
          .then((text) => {
            setTabs((prev) =>
              prev.map((item) =>
                // Re-check dirtiness against the latest state: the read is async and the
                // user may have started typing in this tab while it was in flight.
                item.path === tab.path && item.content === item.originalContent
                  ? { ...item, content: text, originalContent: text }
                  : item,
              ),
            );
          })
          .catch(() => {});
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [project]);

  /** Opens a file in the focused group and jumps to a position in it. */
  const openHit = useCallback(
    (path: string, line: number, column?: number) => {
      revealNonce.current += 1;
      setReveal({
        groupId: activeGroupIdRef.current,
        request: { path, line, column, nonce: revealNonce.current },
      });
      void openFile(path, { pin: true });
    },
    [openFile],
  );

  /** Opens a changed file's before/after in the focused group. A real tab rather than a dialog:
   * it's the same file the code tab shows, in the other of the two ways of reading it, so the
   * toolbar's diff toggle is the way back and the tab can be left open beside the others. */
  const openDiffTab = useCallback(
    async (path: string) => {
      await openFile(path, { pin: true });
      patchTab(path, { viewMode: "diff" });
    },
    [openFile, patchTab],
  );

  /** A row click in the docked panel: the file, at its first change. Falls back to a plain open
   * for a file the diff couldn't place a line in — a new file, or one that's only been renamed. */
  const openChangedFile = useCallback(
    (path: string, line?: number) => {
      if (line) openHit(path, line);
      else void openFile(path, { pin: true });
    },
    [openHit, openFile],
  );

  // Ctrl/Cmd+click "go to definition" is registered globally on Monaco, so it needs telling which
  // repo it's looking at and how to open a file — both of which only the editor knows.
  useEffect(() => {
    if (!project) return;
    setDefinitionContext({ project, open: openHit });
    return () => setDefinitionContext(null);
  }, [project, openHit]);

  useEffect(() => {
    if (!pendingEditorPath) return;
    // An explicit "open this file" from elsewhere in the app is a deliberate navigation,
    // not a peek, so it gets a permanent tab rather than the preview slot.
    if (pendingEditorLine) openHit(pendingEditorPath, pendingEditorLine);
    else void openFile(pendingEditorPath, { pin: true });
    clearPendingEditorPath();
  }, [pendingEditorPath, pendingEditorLine, openFile, openHit, clearPendingEditorPath]);

  /**
   * The editor's own shortcuts, arriving as requests rather than as keystrokes.
   *
   * This was a `keydown` listener comparing `e.key` to literals, which is why these were the only
   * actions in the app that couldn't be rebound. The chords now live in the shortcut registry with
   * everything else and post an `EditorCommand`; what is left here is what each one does.
   *
   * `codeSnap` goes through the focused pane's registered capture rather than Monaco's own action,
   * so it also works in preview-only mode, where there is no editor instance to have registered
   * anything. `bookmarkToggle` reaches the caret the same way.
   */
  const editorCommand = useEditorCommandStore((s) => s.request);
  useEffect(() => {
    if (!editorCommand) return;
    useEditorCommandStore.getState().consume();
    switch (editorCommand.command) {
      case "goToFile":
        setPaletteOpen(true);
        break;
      case "explorer":
        setSidePanel("files");
        break;
      case "findInProject":
        setSidePanel("search");
        break;
      case "anchors":
        setSidePanel("anchors");
        break;
      case "bookmarks":
        setSidePanel("bookmarks");
        break;
      case "debug":
        setSidePanel("debug");
        break;
      case "splitRight":
        splitGroup();
        break;
      // The explorer's own commands: show the tree, then hand the request straight down. Nothing
      // up here knows which row is focused, and nothing up here should.
      case "newFile":
      case "newFolder":
      case "renamePath":
      case "deletePath":
        setSidePanel("files");
        setExplorerCommand({
          command:
            editorCommand.command === "renamePath"
              ? "rename"
              : editorCommand.command === "deletePath"
                ? "delete"
                : editorCommand.command,
          nonce: editorCommand.nonce,
        });
        break;
      case "codeSnap":
        captureRef.current?.();
        break;
      case "bookmarkToggle":
        bookmarkToggleRef.current?.();
        break;
      // Save is not gated on the Editor being visible: a file with unsaved edits is worth saving
      // from wherever you happen to be looking, which is what the old listener did too.
      case "save": {
        const current = groupsRef.current.find((g) => g.id === activeGroupIdRef.current)?.activePath;
        if (current) void save(current);
        break;
      }
      case "closeTab":
      case "nextTab":
      case "prevTab":
        tabCommand(editorCommand.command);
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorCommand, splitGroup]);

  /**
   * Dropping files and folders in from Finder or Explorer copies them into the project.
   *
   * The drop arrives on Tauri's native webview channel rather than as a DOM `drop` event: the
   * platform's own drag handler consumes those before the page ever sees them, which is the same
   * reason the tree's row dragging is pointer-driven. That channel is window-wide, so where the
   * files land is worked out here — the folder row under the pointer, a file row's folder, or the
   * project root anywhere else in the editor.
   *
   * A drop outside the editor resolves to nothing and is left alone. `elementFromPoint` is what
   * makes that hold without a list of exceptions: another tab isn't drawn, and a dialog over the
   * editor answers with its own backdrop rather than with the tree underneath it.
   */
  const importDropped = useCallback(
    async (destDir: string, sources: string[]) => {
      const repo = projectRef.current;
      if (!repo || sources.length === 0) return;
      try {
        const outcome = await copyIntoRepo(repo.local_path, destDir, sources);
        if (outcome.copied.length > 0) {
          // The tree is told where to look rather than asked to re-read itself: only one
          // directory changed, and it may well be one that was never expanded.
          setExplorerCommand({ command: "reveal", path: destDir, nonce: dropNonce.current++ });
          // Everything that landed is untracked, and both the tree's colouring and the Changes
          // tab read that from the store — refreshed here rather than waiting on the watcher.
          void useRepoStore.getState().refreshStatus();
          useToastStore.getState().pushToast(
            tRef.current("editor.dropCopied", {
              n: outcome.copied.length,
              dir: destDir || repo.name,
            }),
            "success",
          );
        }
        // Reported separately, and as an error: a name that was already taken is the one outcome
        // where what the user dropped is not what they now have.
        if (outcome.skipped.length > 0) {
          pushErrorToast(tRef.current("editor.dropSkipped", { names: outcome.skipped.join(", ") }));
        }
      } catch (e) {
        pushErrorToast(String(e));
      }
    },
    [],
  );
  const importDroppedRef = useRef(importDropped);
  importDroppedRef.current = importDropped;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    /** The destination for a drop at this point, or `null` if it isn't the editor's to take.
     * Positions come in physical pixels — the platform's, not the page's. */
    const dirAt = (px: number, py: number): string | null => {
      const ratio = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(px / ratio, py / ratio);
      if (!el?.closest("[data-cf-editor-drop]")) return null;
      const row = el.closest<HTMLElement>("[data-cf-treepath]");
      const path = row?.dataset.cfTreepath;
      if (path === undefined) return "";
      return row?.dataset.cfTreedir === "1" ? path : parentDir(path);
    };

    /** Both halves of the affordance move together: the banner below, and the ring the tree
     * already draws around a drop target — the same one its own row dragging lights up, so an
     * external drop aims exactly like an internal one. */
    const aimAt = (dir: string | null) => {
      setDropDir(dir);
      useTreeDragStore.getState().hover(dir);
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          aimAt(null);
          return;
        }
        const dir = dirAt(payload.position.x, payload.position.y);
        if (payload.type !== "drop") {
          aimAt(dir);
          return;
        }
        aimAt(null);
        if (dir !== null) void importDroppedRef.current(dir, payload.paths);
      })
      .then((fn) => {
        if (disposed) void fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      if (unlisten) void unlisten();
    };
  }, []);

  const registerCapture = useCallback((capture: () => void) => {
    captureRef.current = capture;
  }, []);

  const registerBookmarkToggle = useCallback((toggle: () => void) => {
    bookmarkToggleRef.current = toggle;
  }, []);

  const setGroupActive = useCallback((groupId: string, path: string) => {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, activePath: path } : g)));
    setActiveGroupId(groupId);
  }, []);

  const clearReveal = useCallback(() => setReveal(null), []);

  /** Re-points open tabs after the explorer moves a file or folder, so a moved file keeps its
   * tab (and its unsaved edits) instead of leaving one aimed at a path that no longer exists.
   * Moving a *folder* re-points everything under it. The old Monaco model is left behind and
   * swept by the disposal effect, since the path — and therefore the model URI — changed. */
  /** A path is gone from disk. Any tab showing it — or, for a folder, anything under it — closes
   * without asking: there is nothing left to save it back to. */
  const handlePathRemoved = useCallback((removed: string) => {
    const gone = (p: string) => p === removed || p.startsWith(`${removed}/`);
    const affected = tabsRef.current.map((tab) => tab.path).filter(gone);
    if (affected.length === 0) return;
    let next = groupsRef.current;
    for (const path of affected) {
      // A file open in two splits has to be closed in each of them.
      for (;;) {
        const holder = next.find((g) => g.paths.includes(path));
        if (!holder) break;
        next = closeTabInGroups(next, holder.id, path);
      }
    }
    setGroups(next);
    if (!next.some((g) => g.id === activeGroupIdRef.current)) setActiveGroupId(next[0].id);
    setTabs((prev) => prev.filter((tab) => !gone(tab.path)));
  }, []);

  const handlePathMoved = useCallback((from: string, to: string) => {
    const remap = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p);
    setTabs((prev) => prev.map((tab) => ({ ...tab, path: remap(tab.path) })));
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        paths: g.paths.map(remap),
        activePath: g.activePath ? remap(g.activePath) : null,
      })),
    );
  }, []);

  // Splitting (or closing) a group re-divides the row evenly, which is what VS Code does and the
  // only sane answer for an arbitrary number of panes: any other rule has to invent where the new
  // group's width came from. Widths are only reset when the *count* changes, so dragging a
  // boundary sticks until the next split.
  const groupCount = groups.length;
  useLayoutEffect(() => {
    const row = groupsRowRef.current;
    if (!row || groupCount < 2) {
      setGroupWidths([]);
      return;
    }
    // The drag handles sit between the panes and take real space out of the row.
    const share = (row.clientWidth - HANDLE_WIDTH * (groupCount - 1)) / groupCount;
    setGroupWidths(Array.from({ length: groupCount - 1 }, () => Math.max(GROUP_MIN, Math.floor(share))));
  }, [groupCount]);

  /** The tab width Monaco resolved for the file being snapped, so an indented snapshot lines up
   * the way the editor showed it. */
  const snapTabSize = useMemo(() => {
    if (!codeSnap || !project) return 2;
    const model = monaco.editor.getModel(monaco.Uri.parse(modelPathFor(project, codeSnap.path)));
    return model?.getOptions().tabSize ?? 2;
  }, [codeSnap, project]);

  if (!project) {
    return <EmptyState icon={FileCode} title={t("editor.noProject")} />;
  }

  const renderGroup = (group: EditorGroup) => (
    <EditorPane
      key={group.id}
      groupId={group.id}
      project={project}
      // Registry lookup per path: tab order belongs to the group, file state is shared.
      tabs={group.paths.flatMap((p) => tabs.find((tab) => tab.path === p) ?? [])}
      pinnedPaths={group.pinned}
      activePath={group.activePath}
      focused={group.id === activeGroupId}
      monacoTheme={monacoTheme}
      themeMode={resolved}
      fileDiffFor={fileDiffFor}
      saving={saving}
      reveal={reveal?.groupId === group.id ? reveal.request : null}
      onRevealDone={clearReveal}
      onFocus={() => setActiveGroupId(group.id)}
      onSelect={(path) => setGroupActive(group.id, path)}
      onClose={(path) => void closeTab(group.id, path)}
      onPin={(path) => patchTab(path, { preview: false })}
      onDropTab={dropTab}
      // Typing in a preview tab promotes it to a permanent one, exactly like VS Code.
      onChange={(path, value) => patchTab(path, { content: value, preview: false })}
      onViewMode={(path, mode: ViewMode) => patchTab(path, { viewMode: mode })}
      onSave={() => group.activePath && void save(group.activePath)}
      onCodeSnap={setCodeSnap}
      registerCapture={registerCapture}
      registerBookmarkToggle={registerBookmarkToggle}
      // Always available — VS Code lets you keep splitting, and each press splits *this* group
      // rather than whichever one happens to hold focus.
      onSplit={group.activePath ? () => splitGroup(group.id) : null}
      onCloseGroup={groups.length > 1 ? () => closeGroup(group.id) : null}
      // Right-clicking a tab acts on *that* tab and *this* group, which is why these close over
      // the group rather than reading whichever one happens to have focus.
      tabMenu={{
        togglePinned: (path) => togglePinned(group.id, path),
        closeAll: () => void closeAllTabs(group.id),
        copyPath,
        splitRight: (path) => splitGroup(group.id, path),
      }}
    />
  );

  return (
    // No header strip: the project and branch it used to repeat are already in the status bar,
    // and the row it occupied is worth more as editor.
    //
    // `data-cf-editor-drop` marks how far the file drop reaches: everything the editor draws, rail
    // and tree included. It is a marker rather than a handler because the drop is delivered by the
    // platform, off the DOM event path — see the listener above.
    <div data-cf-editor-drop className="relative flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Activity rail: the panel toggles up top, one-shot actions pinned to the bottom the
            way an editor keeps its settings gear there. */}
        <div
          data-tour="editor-rail"
          className="flex w-9 shrink-0 flex-col items-center gap-1 bg-[var(--cf-surface)] py-1.5"
        >
          {/* The chord in each tooltip comes from the binding registry, not from a string next to
              the label: two of these used to carry a hand-written "(Ctrl+Shift+F)" that said Ctrl
              on a Mac and went stale the moment anyone rebound it, and the other three said
              nothing at all. `aria-label` stays the bare name — a screen reader announces the
              key from the binding, not from the accessible name. */}
          {(
            [
              { id: "files", shortcut: "editor.explorer", icon: Files, label: t("editor.explorer") },
              { id: "search", shortcut: "editor.findInProject", icon: Search, label: t("editor.searchInProject") },
              { id: "anchors", shortcut: "editor.anchors", icon: Tags, label: t("anchors.title") },
              { id: "bookmarks", shortcut: "editor.bookmarks", icon: Bookmark, label: t("bookmarks.title") },
              { id: "debug", shortcut: "editor.debug", icon: Bug, label: t("debug.title") },
            ] as const
          ).map(({ id, icon: Icon, label, ...entry }) => (
            // `shortcut` is optional: the icon panel is opened by clicking it, not by a chord. One
            // more binding for a screen you visit twice a year would be a line in the cheat sheet
            // that costs everyone reading it more than it saves its user.
            <button
              key={id}
              onClick={() => setSidePanel(id)}
              title={"shortcut" in entry ? shortcutHint(entry.shortcut, label) : label}
              aria-label={label}
              className={`relative flex h-7 w-7 items-center justify-center rounded-md ${
                sidePanel === id
                  ? "text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
              }`}
            >
              {sidePanel === id && <ActivePill layoutId="cf-editor-rail-pill" />}
              <Icon size={15} className="relative" />
              {/* A live session is worth seeing from any panel — it's a running process. */}
              {id === "debug" && debugStatus !== "idle" && (
                <span
                  className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${
                    debugStatus === "paused" ? "bg-[var(--cf-warning)]" : "bg-[var(--cf-success)]"
                  }`}
                />
              )}
            </button>
          ))}
          {/* Below the panels, above the actions. The five above read the code; this one only
              changes how the tree draws it, so grouping it with them put a preference among five
              views of the repository. `mt-auto` moves here with it — this is now the first item of
              the bottom cluster. */}
          <button
            onClick={() => setSidePanel("icons")}
            title={t("icons.title")}
            aria-label={t("icons.title")}
            className={`mt-auto flex h-7 w-7 items-center justify-center rounded-md ${
              sidePanel === "icons"
                ? "text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
            }`}
          >
            <Palette size={15} />
          </button>
          {/* Go to file lives here rather than in a strip of its own: it's an action, not a
              panel, and it has to be reachable with no file open — which the tab bar isn't. */}
          <button
            onClick={() => setPaletteOpen(true)}
            title={shortcutHint("editor.goToFile", t("editor.goToFile"))}
            aria-label={t("editor.goToFile")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <FileSearch size={15} />
          </button>
          <button
            // Scoped: this button lives in the editor's own rail, so it answers for the editor.
            // The whole sheet is still a ⌘⌥K away.
            onClick={() => useUiStore.getState().toggleShortcutsModal(["editor"])}
            title={shortcutHint("app.shortcuts", t("shortcuts.title"))}
            aria-label={t("shortcuts.title")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <Keyboard size={15} />
          </button>
        </div>
        <div
          style={{ width: treeWidth }}
          data-tour="editor-tree"
          // The tree owns its own scroll area now (below its toolbar), so this wrapper only
          // clips — scrolling it too would carry the toolbar out of view.
          className="flex shrink-0 flex-col overflow-hidden bg-[var(--cf-surface)]"
        >
          {/* Explorer, find-in-project, anchors or the debugger — same column VS Code uses for
              all of them, since each wants the width more than a file tree does. */}
          {sidePanel === "search" ? (
            <SearchPanel repoPath={project.local_path} onOpenHit={openHit} onClose={() => setSidePanel("files")} />
          ) : sidePanel === "anchors" ? (
            <AnchorsPanel
              repoPath={project.local_path}
              activePath={activePath}
              activeContent={activeContent}
              onOpenAnchor={openHit}
            />
          ) : sidePanel === "bookmarks" ? (
            <BookmarksPanel repoPath={project.local_path} onOpen={openHit} />
          ) : sidePanel === "icons" ? (
            <IconRulesPanel />
          ) : sidePanel === "debug" ? (
            <DebugPanel
              repoPath={project.local_path}
              suggestedProgram={activeAbsolutePath}
              onOpenFrame={(file, line) => {
                // Frames carry absolute paths; the editor opens repo-relative ones.
                const root = normalizePath(`${project.local_path}/`);
                const normalized = normalizePath(file);
                if (normalized.startsWith(root)) openHit(normalized.slice(root.length), line);
              }}
            />
          ) : (
            <FileTree
              repoPath={project.local_path}
              selectedPath={activePath}
              onSelectFile={(path) => void openFile(path)}
              onOpenFile={(path) => void openFile(path, { pin: true })}
              onPathMoved={handlePathMoved}
              onPathRemoved={handlePathRemoved}
              command={explorerCommand}
              changedPaths={changedPaths}
            />
          )}
        </div>
        <ResizeHandle
          axis="x"
          value={treeWidth}
          min={TREE_MIN}
          max={TREE_MAX}
          onChange={(w) => setSize("editorTreeWidth", w)}
          onCommit={(w) => commitSize("editorTreeWidth", w)}
        />
        {/* Every group but the last carries an explicit width; the last takes the remainder, so
            the row fills exactly and a drag only ever moves one boundary. `GROUP_MIN` is a real
            floor — past the point where the panes stop fitting, the row scrolls rather than
            squeezing controls out of reach. */}
        <div ref={groupsRowRef} className="flex min-w-0 flex-1 overflow-x-auto">
          {groups.map((group, i) => {
            const last = i === groups.length - 1;
            return (
              <Fragment key={group.id}>
                {i > 0 && (
                  <ResizeHandle
                    axis="x"
                    value={groupWidths[i - 1] ?? GROUP_MIN}
                    min={GROUP_MIN}
                    max={GROUP_MAX}
                    onChange={(w) => setGroupWidths((prev) => prev.map((v, k) => (k === i - 1 ? w : v)))}
                    onCommit={() => {}}
                  />
                )}
                <div
                  style={
                    last
                      ? { minWidth: GROUP_MIN }
                      : { width: groupWidths[i] ?? GROUP_MIN, minWidth: GROUP_MIN }
                  }
                  className={last ? "flex flex-1" : "flex shrink-0"}
                >
                  {renderGroup(group)}
                </div>
              </Fragment>
            );
          })}
        </div>
        {/* The Changes dock: the same panel the Changes screen is, on the other side of the code.
            Its rows open files here instead of into a diff pane of their own — see `ChangesPanel`
            — which is what makes it a companion to the editor rather than a second copy of a
            screen the app already has.

            Open, it runs flush to the window edge and its close button rides in its own header.
            Shut, a narrow rail holds the button instead. One or the other, never both: a rail kept
            up alongside the open panel was a full-height column of empty surface that pushed the
            panel a button's width off the edge it is docked to. */}
        {changesOpen ? (
          <>
            <ResizeHandle
              axis="x"
              value={changesWidth}
              min={CHANGES_MIN}
              max={CHANGES_MAX}
              // Anchored to the right, so dragging left — toward the code — has to grow it.
              invert
              onChange={(w) => setSize("editorChangesWidth", w)}
              onCommit={(w) => commitSize("editorChangesWidth", w)}
            />
            <div
              style={{ width: changesWidth }}
              className="flex shrink-0 flex-col overflow-hidden bg-[var(--cf-surface)]"
            >
              <ChangesPanel
                onOpenFile={openChangedFile}
                onOpenDiff={(path) => void openDiffTab(path)}
                headerAction={
                  <button
                    onClick={() => setChangesOpen(false)}
                    title={t("editor.toggleChanges")}
                    aria-label={t("editor.toggleChanges")}
                    aria-expanded
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
                  >
                    <PanelRightClose size={13} />
                  </button>
                }
              />
            </div>
          </>
        ) : (
          <div className="flex w-9 shrink-0 flex-col items-center gap-1 bg-[var(--cf-surface)] py-1.5">
            <button
              onClick={() => setChangesOpen(true)}
              title={t("editor.toggleChanges")}
              aria-label={t("editor.toggleChanges")}
              aria-expanded={false}
              className="relative flex h-7 w-7 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
            >
              <GitBranch size={15} className="relative" />
              {/* Only while shut — which is the only state this rail has. Open, the panel itself is
                  the count, and a badge over it would be the same number twice. */}
              {uncommittedCount > 0 && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--cf-accent)]" />
              )}
            </button>
          </div>
        )}
      </div>
      {/* The drop affordance: an outline around what will take the files, and a banner naming the
          folder they will land in — named rather than merely lit, because the same gesture lands
          somewhere different depending on which row the pointer is over, and a copy that went to
          the wrong folder is only discovered later. Nothing is dimmed: the tree underneath is what
          the drop is being aimed with. `pointer-events-none` so this can never become what the
          next hit test finds under the cursor. */}
      {dropDir !== null && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-end justify-center pb-8 ring-2 ring-inset ring-[var(--cf-accent)]">
          <div className="flex items-center gap-2.5 rounded-xl border border-[var(--cf-accent)] bg-[var(--cf-surface-raised)] px-4 py-2.5 shadow-[var(--cf-shadow)]">
            <FolderInput size={16} className="shrink-0 text-[var(--cf-accent)]" />
            <span className="text-[13px] font-medium text-[var(--cf-text)]">
              {t("editor.dropHint", { dir: dropDir || project.name })}
            </span>
          </div>
        </div>
      )}
      {paletteOpen && (
        <FilePalette
          repoPath={project.local_path}
          onPick={(path) => void openFile(path, { pin: true })}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {codeSnap && (
        <CodeSnapModal
          target={codeSnap}
          theme={activeCodeTheme}
          tabSize={snapTabSize}
          onClose={() => setCodeSnap(null)}
        />
      )}
    </div>
  );
}
