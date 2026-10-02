import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
// Stated here as well as in `EditorPane`, because this view reaches Monaco directly (model lookups
// for the code snapshot, below) and does so from module scope's point of view *before* any pane has
// mounted. Idempotent — see the note in `monacoSetup`.
import "../../lib/monacoSetup";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Bookmark,
  Bug,
  FileCode,
  Files,
  FileSearch,
  FolderInput,
  GitBranch,
  Keyboard,
  Palette,
  PanelRightClose,
  Search,
  Tags,
} from "lucide-react";
import { FileTree, parentDir, type ExplorerCommand } from "./FileTree";
import { IconProfilePanel } from "./IconProfilePanel";
import { FilePalette } from "./FilePalette";
import { SearchPanel } from "./SearchPanel";
import { AnchorsPanel } from "./AnchorsPanel";
import { BookmarksPanel } from "./BookmarksPanel";
import { CodeSnapModal, type CodeSnapTarget } from "./CodeSnapModal";
import { DebugPanel } from "./DebugPanel";
import {
  clearFullDiffCache,
  EditorPane,
  type DiskAction,
  type OpenTab,
  type RevealRequest,
  type ViewMode,
} from "./EditorPane";
import { EditorStatusLine } from "./EditorStatusLine";
import { EditorBottomPanel } from "./EditorBottomPanel";
import { formatModel } from "./formatDocument";
import { ChangesPanel } from "../git/ChangesPanel";
import { MODEL_SCHEME, modelPathFor } from "../../lib/editorModel";
import { setDefinitionContext } from "../../lib/goToDefinition";
import { syncSave } from "../../lib/lsp/client";
import {
  closeAllInGroups,
  closeGroupInGroups,
  closeTabInGroups,
  dropIntoSplit,
  moveTabInGroups,
  newGroup,
  openInGroups,
  splitGroups,
  togglePinInGroups,
  type EditorGroup,
} from "../../lib/editorGroups";
import {
  copyIntoRepo,
  readEditorFile,
  statEditorFile,
  writeEditorFile,
  writeFileBytes,
  type DiskVersion,
} from "../../lib/tauri/commands";
import { freeScratchPath, isScratchPath, scratchName, scratchPath } from "../../lib/scratchTabs";
import { clearDrafts, readDrafts, writeDrafts } from "../../lib/editorDrafts";
import {
  describePath,
  failedLoad,
  isChangedOnDisk,
  isWritable,
  loadedFrom,
  sameLoadedState,
  sweepStep,
  type LoadedFile,
} from "../../lib/editorFiles";
import { notifyUnsavedChanged, registerUnsavedProvider, type UnsavedItem } from "../../lib/unsavedWork";
import { applyTextEdits, registerWorkspaceEditHost } from "../../lib/workspaceEdit";
import { formatWithPrettier, prettierCanFormat } from "../../lib/formatting";
import { useProblemsStore } from "../../state/problemsStore";
import { useEditorPanelStore } from "../../state/editorPanelStore";
import { useEditorFormatStore } from "../../state/editorFormatStore";
import { isNotebookPath, registerNotebookHost } from "../../lib/notebook/host";
import { notebookActions } from "../../state/notebookStore";
import {
  editorAfterSwitch,
  isDirtyBuffer as isDirtyTab,
  parkedAfterSwitch,
  type ParkedEditor as ParkedEditorOf,
} from "../../lib/parkedEditors";
import { onRepoFsChanged } from "../../lib/tauri/events";
import { isDbmlPath, openDbmlInDiagrams } from "../../lib/dbmlBridge";
import { findTheme } from "../../lib/codeThemes";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useThemeStore } from "../../state/themeStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useDebugStore, normalizePath } from "../../state/debugStore";
import { useBookmarkStore } from "../../state/bookmarkStore";
import { useEditorCommandStore } from "../../state/editorCommandStore";
import type { TabDrag, TabDropTarget } from "../../state/tabDragStore";
import { useTreeDragStore } from "../../state/treeDragStore";
import { chooseAction, confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { ActiveMarker, ActivePill } from "../common/ActivePill";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass, Kbd } from "../common/Button";
import { explorerClass, inspectorClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useShortcutChord } from "../../lib/useShortcutHint";
import type { ShortcutId } from "../../lib/shortcuts";
import type { FileDiffInfo, Project } from "../../types/domain";

/**
 * How long after the last keystroke the unsaved buffers are journalled.
 *
 * Generous on purpose. This is crash recovery, not autosave: nobody is waiting on the write,
 * and the cost of losing the last two seconds of typing to a force-quit is nothing next to the
 * cost of a SQLite round trip per keystroke.
 */
const DRAFT_DEBOUNCE_MS = 2000;

const TREE_MIN = 200;
const TREE_MAX = 480;
/** The docked Changes panel. Wider floor than the file tree: its rows carry a status letter, a
 * path and three action buttons, and the commit box under them has to fit a message. */
const CHANGES_MIN = 240;
const CHANGES_MAX = 560;
/** The Problems / results panel under the groups: a few rows at least, and never more than the
 *  code it sits under could spare. */
const PANEL_MIN = 96;
const PANEL_MAX = 640;
/** The shut dock: one 28px button with a little air — the same width as the activity rail on the
 * other side of the code, so the two edges of the editor read as a pair. */
const RAIL_W = 40;

/**
 * An activity-rail button. At rest it is the shared icon button; the selected one hands its fill to
 * the `ActivePill` behind it, which is what slides between the five instead of blinking — so it
 * keeps only the accent ink, and the pill is the whole of its background.
 */
function railButtonClass(selected: boolean): string {
  return selected
    ? "relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--cf-accent)]"
    : iconButtonClass({ size: "md", className: "relative" });
}
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

/**
 * The shortest a stacked pane gets.
 *
 * Its width twin above is about controls being reachable; this one is about the pane still being an
 * editor: a tab strip, the breadcrumb under it, and enough lines left over to read. Below that a
 * split is a worse way of showing nothing.
 */
const ROW_MIN = 140;

/** A tab for a file whose text is still on its way. */
function loadingTab(path: string, preview: boolean): OpenTab {
  return {
    path,
    content: "",
    originalContent: "",
    loading: true,
    viewMode: "code",
    preview,
    compare: null,
    version: null,
    notice: null,
    readOnly: null,
    diskChanged: false,
    diskText: null,
  };
}

/**
 * A read laid over a tab: the buffer becomes what is on disk and every mark of a difference goes. A
 * diff that was comparing the buffer against the disk falls back to the code — there is nothing
 * left between the two to show.
 */
function withLoaded(tab: OpenTab, loaded: LoadedFile): OpenTab {
  return {
    ...tab,
    content: loaded.content,
    originalContent: loaded.content,
    version: loaded.version,
    notice: loaded.notice,
    readOnly: loaded.readOnly,
    loading: false,
    diskChanged: false,
    diskText: null,
    viewMode: tab.diskText !== null && tab.viewMode === "diff" ? "code" : tab.viewMode,
  };
}

/**
 * A project's editor, set aside when the window moved to another project with unsaved tabs in it —
 * see `lib/parkedEditors` for the rules.
 *
 * Switching projects used to empty the editor outright — dirty buffers included, without a word, and
 * with the draft journal's pending write cancelled by the same switch. The switch cannot be refused
 * from here: it arrives from the sidebar, the palette, a shortcut, a PR link, a workspace change, all
 * through the workspace store. So nothing is thrown away when it happens. The tabs are parked, exactly
 * as they were, the journal is written at once, and the user is asked right after: save them all,
 * discard them, or cancel — which takes the window back to where the work is, and the parked editor
 * comes back with it, groups, splits and undo history intact.
 */
type ParkedEditor = ParkedEditorOf<OpenTab, Project>;

/**
 * How a save went. `conflict`: the file changed on disk since it was read, and nothing was written.
 * `skipped`: not a writable buffer — a notice, read-only text, a tab still loading.
 */
type SaveOutcome = "saved" | "clean" | "conflict" | "failed" | "skipped";

export function EditorView() {
  const t = useT();
  const chord = useShortcutChord();
  /** A registry chord as a key cap, for a tooltip's trailing slot — `undefined` when unbound. */
  const keyCap = (id: ShortcutId) => {
    const keys = chord(id);
    return keys ? <Kbd>{keys}</Kbd> : undefined;
  };
  const project = useWorkspaceStore((s) => s.activeProject());
  const status = useRepoStore((s) => s.status);
  const { changedPaths, changedDirs } = useMemo(() => {
    const map = new Map<string, string>();
    if (status) {
      // Untracked/unstaged first, then staged overwrites — an already-staged edit that's
      // since changed further should show its current (unstaged) status, not the stale one.
      for (const e of status.untracked) map.set(e.path, e.status);
      for (const e of status.unstaged) map.set(e.path, e.status);
      for (const e of status.staged) if (!map.has(e.path)) map.set(e.path, e.status);
    }
    // Every ancestor directory of a changed path, walked once here rather than rediscovered by
    // each directory row. The tree used to answer "does anything inside me differ?" by spreading
    // this map's keys into an array and scanning it — per directory row, per render — which on a
    // repo with a few hundred changed files was the most expensive thing the explorer did.
    const dirs = new Set<string>();
    for (const path of map.keys()) {
      let cut = path.lastIndexOf("/");
      while (cut > 0) {
        const dir = path.slice(0, cut);
        // Everything above an ancestor already in the set is in it too — the walk that put it
        // there went all the way up.
        if (dirs.has(dir)) break;
        dirs.add(dir);
        cut = dir.lastIndexOf("/");
      }
    }
    return { changedPaths: map, changedDirs: dirs };
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
  const panelHeight = useLayoutStore((s) => s.sizes.editorPanelHeight);
  const panelOpen = useEditorPanelStore((s) => s.open);
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
  /** Editors set aside in projects this window has left with unsaved tabs — see `ParkedEditor`.
   *  Keyed by the project's local path, the key the draft journal files them under too. */
  const [parked, setParked] = useState<Record<string, ParkedEditor>>({});
  /** A project just left with unsaved tabs, waiting for the question the switch owes the user. */
  const [leaving, setLeaving] = useState<{ repoPath: string; to: string | null } | null>(null);
  /** Bumped when a parked editor comes back — see the effect that re-reads its unfinished tabs. */
  const [restoredParked, setRestoredParked] = useState(0);
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
  /** Heights inside each column, keyed by column id: one entry per group except the last, which
   *  takes what is left. The row-wise twin of `groupWidths`. */
  const [groupHeights, setGroupHeights] = useState<Record<string, number[]>>({});
  const groupsRowRef = useRef<HTMLDivElement>(null);
  /** The focused pane's "capture a snapshot" function, re-registered whenever focus moves, so
   * the keyboard shortcut reaches the group the user is looking at even from outside the code. */
  const captureRef = useRef<(() => void) | null>(null);
  /** Same idea for "bookmark the line the caret is on" — only the pane holding the caret can. */
  const bookmarkToggleRef = useRef<(() => void) | null>(null);
  /** And for "go to the next/previous change": the hunks belong to the file, but the peek that shows
   *  one belongs to a pane, and two splits on the same file can be parked on different hunks. */
  const changeNavRef = useRef<((delta: number) => void) | null>(null);

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
  const parkedRef = useRef(parked);
  parkedRef.current = parked;
  /**
   * The save in flight per path. A second ⌘S before the first has answered carried the version the
   * first one was about to replace, and the backend — rightly — refused it as a file changed on disk:
   * by our own hand. Saves of one file now queue behind each other, and the disk sweep leaves a file
   * alone while one is running.
   */
  const savesInFlight = useRef(new Map<string, Promise<SaveOutcome>>());
  /** Set once the user chose to quit without saving: the journal is cleared then, and nothing may
   *  write it again in the moment before the process ends. */
  const discardedRef = useRef(false);
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

  /**
   * Every open file whose buffer has drifted from disk, as `{ path, content }`.
   *
   * The project search greps disk and this editor has no autosave, so between typing a word and
   * pressing save there is a window where the file the user is looking at is the one file the
   * search describes wrongly — at line numbers that have already moved. `SearchPanel` closes that
   * window by matching these itself and letting them override the backend's hits for the same path.
   *
   * This re-identifies on every keystroke, which is exactly why it is handed down as *data* and
   * never as a refresh trigger: the panel folds it into a `useMemo`, never into the effect that
   * calls `searchRepo`. Clean tabs are left out on purpose — for those, disk *is* the buffer, and
   * matching them here would re-scan every open file to arrive at the answer the backend just gave.
   */
  const dirtyBuffers = useMemo(
    () =>
      tabs
        // Not a scratch tab (`lib/scratchTabs`): it is no file of the project, so it is nothing the
        // project search describes, and nothing the drafts journal below could restore — a draft is
        // offered back only against the file it belongs to.
        .filter((tab) => !tab.loading && tab.content !== tab.originalContent && !isScratchPath(tab.path))
        .map((tab) => ({ path: tab.path, content: tab.content })),
    [tabs],
  );

  // `useT()` hands back a fresh function every render; callbacks that only need it to
  // build a message read it through this ref instead of taking it as a dependency and
  // re-identifying (and re-subscribing their listeners) on every keystroke.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  /**
   * The crash-recovery journal for unsaved buffers.
   *
   * Debounced, and deliberately generously: this exists so a force-quit after a hang costs nothing,
   * not so every keystroke reaches SQLite. `DRAFT_DEBOUNCE_MS` after the last edit the whole dirty
   * set is written as one row — a write nobody is waiting on, which is why it is fire-and-forget.
   *
   * Note what is written: every dirty buffer, every time. A file that has just been saved is no
   * longer dirty, so it leaves the list on the next write and stops being offered back — which is
   * the only correct way to express "this one is done" in a whole-list row.
   */
  useEffect(() => {
    if (!project) return;
    const repoPath = project.local_path;
    const id = window.setTimeout(() => {
      if (discardedRef.current) return;
      void writeDrafts(
        repoPath,
        dirtyBuffers.map((buffer) => ({ path: buffer.path, content: buffer.content, at: Date.now() })),
      );
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [project, dirtyBuffers]);


  const activeAbsolutePath = useMemo(
    () => (project && activePath ? normalizePath(`${project.local_path}/${activePath}`) : null),
    [project, activePath],
  );
  const debugStatus = useDebugStore((s) => s.status);

  /**
   * Same "unstaged wins, else staged" priority as the file tree's own indicator, so the gutter/minimap
   * markers always match whatever status letter that file is showing there.
   *
   * It now says *which* side it found the file on, because the change peek has to: the same panel means
   * "stage this" over a working hunk and "unstage this" over a staged one, and offering to discard a
   * staged hunk would be two operations behind one button with a scope nobody can predict. Returning
   * the merged answer without saying where it came from is what made that unanswerable.
   */
  const fileDiffFor = useCallback(
    (path: string): { file: FileDiffInfo; staged: boolean } | undefined => {
      const working = workingDiff.find((f) => (f.new_path ?? f.old_path) === path);
      if (working) return { file: working, staged: false };
      const staged = stagedDiff.find((f) => (f.new_path ?? f.old_path) === path);
      return staged ? { file: staged, staged: true } : undefined;
    },
    [workingDiff, stagedDiff],
  );

  const patchTab = useCallback((path: string, patch: Partial<OpenTab>) => {
    setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)));
  }, []);

  /** A keystroke in a pane. Refused for a tab that is not a writable buffer — read-only text is
   *  read-only in Monaco too, so this is the backstop, not the gate. */
  const changeTab = useCallback((path: string, value: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.path === path && isWritable(tab) ? { ...tab, content: value, preview: false } : tab)),
    );
  }, []);

  /**
   * Reads a file into its tab — what opening one does, and what a parked editor coming back does for
   * a tab it left in the middle of a read.
   *
   * What came back decides what the tab is: text to edit, or a notice — an error, a binary file, an
   * image, a file too large — with no buffer in it. An unreadable file used to open as an editable tab
   * *holding the error message*, one keystroke and a ⌘S away from writing that message over the file
   * it could not read.
   */
  const readInto = useCallback(async (path: string) => {
    const current = projectRef.current;
    if (!current) return;
    let loaded: LoadedFile;
    try {
      loaded = loadedFrom(await readEditorFile(current.local_path, path));
    } catch (e) {
      loaded = failedLoad(e);
    }
    // Another project's tab of the same name is not this file.
    if (projectRef.current?.local_path !== current.local_path) return;
    setTabs((prev) => prev.map((tab) => (tab.path === path ? withLoaded(tab, loaded) : tab)));
  }, []);

  const openFile = useCallback(
    async (path: string, opts?: { pin?: boolean; groupId?: string }) => {
      if (!project) return;
      const pin = opts?.pin ?? false;
      const targetId = opts?.groupId ?? activeGroupIdRef.current;
      const alreadyOpen = tabsRef.current.some((tab) => tab.path === path);
      // A scratch buffer that has been closed is gone — there is no file to read it back from, so
      // a bookmark or a stale link aimed at one opens nothing rather than an error tab.
      if (isScratchPath(path) && !alreadyOpen) return;

      const outcome = openInGroups(groupsRef.current, targetId, path, pin, (p) =>
        Boolean(tabsRef.current.find((tab) => tab.path === p)?.preview),
      );
      setGroups(outcome.groups);
      setActiveGroupId(targetId);

      setTabs((prev) => {
        // An evicted preview only leaves the registry if no other group was showing it too.
        const kept = outcome.evictedFully ? prev.filter((tab) => tab.path !== outcome.evicted) : prev;
        if (alreadyOpen) return pin ? kept.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)) : kept;
        return [...kept, loadingTab(path, !pin)];
      });
      if (alreadyOpen) return;
      await readInto(path);
    },
    [project, readInto],
  );

  /**
   * Opens `content` in a tab that is no file of the project — see `lib/scratchTabs`. Where the
   * explorer's "Generate Tree" puts its text.
   *
   * Pinned, never a preview: it is something the user asked to read, and a preview tab is recycled by
   * the next single click in the tree — which would take the only copy of the text with it. Asked for
   * the same name again, it refreshes that tab if the user has not typed in it, and opens a numbered
   * one beside it if they have.
   */
  const openScratch = useCallback((name: string, content: string) => {
    const targetId = activeGroupIdRef.current;
    const reusable = tabsRef.current.some(
      (tab) => tab.path === scratchPath(name) && tab.content === tab.originalContent,
    );
    const path = reusable
      ? scratchPath(name)
      : freeScratchPath(name, (candidate) => tabsRef.current.some((tab) => tab.path === candidate));
    const outcome = openInGroups(groupsRef.current, targetId, path, true, () => false);
    setGroups(outcome.groups);
    setActiveGroupId(targetId);
    const fresh: OpenTab = { ...loadingTab(path, false), content, originalContent: content, loading: false };
    setTabs((prev) =>
      prev.some((tab) => tab.path === path)
        ? prev.map((tab) => (tab.path === path ? fresh : tab))
        : [...prev, fresh],
    );
  }, []);

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
    // Closing a notebook stops its kernel (see the effect over `notebookPaths`), and one that is
    // still running something is asked about first.
    const repoPath = projectRef.current?.local_path;
    if (viewCount <= 1 && repoPath && isNotebookPath(path) && notebookActions.isBusy(repoPath, path)) {
      const ok = await confirmAction(
        tRef.current("notebook.closeBusyConfirm", { name: path.split("/").pop() ?? path }),
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

  /**
   * Where a dragged tab lands.
   *
   * Three gestures, one handler, because the drag is one gesture and only the *aim* differs:
   * along its own strip is a reorder, onto another strip or the middle of a pane is a move, and
   * onto an **edge** is a split — the file opens beside or under what you aimed at. See `edgeOf`
   * in `EditorTabs` for how the bands are cut, and `dropIntoSplit` for the arithmetic.
   */
  const dropTab = useCallback((payload: TabDrag, target: TabDropTarget) => {
    const outcome =
      target.zone === "strip" || target.zone === "body"
        ? moveTabInGroups(groupsRef.current, payload, target.groupId, target.index)
        : dropIntoSplit(groupsRef.current, payload, target.groupId, target.zone);
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

  /**
   * "Reveal in Explorer" on a tab: show the tree, then hand it the file.
   *
   * Two steps because the tree may not even be the panel on screen — the same pair the explorer's
   * keybindings make a few hundred lines down, for the same reason. It deliberately does *not*
   * make the file the active tab: the question the action answers is "where does this live",
   * which is one you can ask about a file you are not currently editing.
   */
  /**
   * What the last session was in the middle of, offered back on the way in.
   *
   * Restored *as dirty tabs*, never written to the files themselves: the buffer comes back exactly
   * as it was typed, the tab shows its unsaved dot, and saving it is still the user's decision. A
   * draft whose content now matches what is on disk is dropped silently — the work landed, and
   * re-opening a tab to show no change would be noise.
   *
   * Once per project, guarded by a ref rather than by a dependency list: `openFile` re-identifies
   * whenever the project does, and re-running this would re-open tabs the user had closed.
   */
  const restoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    const repoPath = project.local_path;
    if (restoredRef.current === repoPath) return;
    restoredRef.current = repoPath;
    let cancelled = false;
    void (async () => {
      const drafts = await readDrafts(repoPath, Date.now());
      if (cancelled || drafts.length === 0) return;
      const restored: string[] = [];
      for (const draft of drafts) {
        // Already open: a parked editor came back with this very buffer in it (see `ParkedEditor`),
        // and re-applying the journal over it would at best change nothing and announce it anyway.
        if (tabsRef.current.some((tab) => tab.path === draft.path)) continue;
        // What the file holds now — which may have moved on, or may already be this exact text. A
        // file that is no longer text is not one a text draft can be laid over.
        const onDisk = await readEditorFile(repoPath, draft.path).catch(() => null);
        if (cancelled) return;
        if (onDisk?.kind !== "text" || onDisk.text === draft.content) continue;
        await openFile(draft.path, { pin: true });
        if (cancelled) return;
        // `originalContent` stays whatever the file holds, so the tab is dirty against disk and the
        // diff gutter tells the truth about what would be written.
        patchTab(draft.path, { content: draft.content, preview: false });
        restored.push(draft.path);
      }
      if (cancelled || restored.length === 0) return;
      useToastStore
        .getState()
        .pushToast(tRef.current("editor.draftsRestored", { n: restored.length }), "info");
    })();
    return () => {
      cancelled = true;
    };
  }, [project, openFile, patchTab]);

  const revealInTree = useCallback((path: string) => {
    setSidePanel("files");
    setExplorerCommand({ command: "revealFile", path, nonce: dropNonce.current++ });
  }, []);

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

  /**
   * Save, on a scratch tab, is Save As: there is no file behind it to write back to, so the user picks
   * one — offered in the project's folder, which is where a tree of the project usually ends up. The
   * tab stays a buffer, now clean; what was written is an ordinary file wherever it landed, and the
   * explorer shows it when that is inside the project.
   */
  const saveScratchAs = useCallback(async (repoPath: string, path: string, text: string) => {
    try {
      const target = await saveDialog({ defaultPath: `${repoPath}/${scratchName(path)}` });
      if (!target) return;
      await writeFileBytes(target, new TextEncoder().encode(text));
      // Against the text that was written, not the tab's latest: typing done while the dialog was up
      // is still unsaved, and the dot has to go on saying so.
      setTabs((prev) => prev.map((item) => (item.path === path ? { ...item, originalContent: text } : item)));
      void useRepoStore.getState().refreshStatus();
    } catch (e) {
      pushErrorToast(String(e));
    }
  }, []);

  /**
   * `setTabs`, with `tabsRef` brought up to date at once instead of at the next render — for writes
   * whose follow-up can run before React renders. A save queued behind another reads the version the
   * first one just wrote; the render's copy would still hold the old one, and the disk would refuse
   * the second save as a change nobody else made.
   */
  const commitTabs = useCallback((update: (prev: OpenTab[]) => OpenTab[]) => {
    tabsRef.current = update(tabsRef.current);
    setTabs(update);
  }, []);

  /** The question for a file that changed under its buffer. A ref because `save` asks it and the
   *  question's answers call `save` back — see `resolveDiskConflict`, assigned below. */
  const diskQuestionRef = useRef<(path: string) => void>(() => {});

  const saveNow = useCallback(
    async (path: string, force: boolean, interactive: boolean): Promise<SaveOutcome> => {
      // A save that waited behind another can run after the window moved to another project, where
      // `tabsRef` holds that project's tabs — and a tab of the same name there is not this file.
      if (!project || projectRef.current?.local_path !== project.local_path) return "skipped";
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!tab) return "skipped";
      // Before the "nothing changed" check, not after it: a tree fresh out of "Generate Tree" is clean,
      // and saving it as a file is exactly what someone pressing ⌘S on it wants. It needs a person to
      // pick where, so a save nobody is watching (the quit's "save all") cannot do it.
      if (isScratchPath(path)) {
        if (!interactive) return "failed";
        await saveScratchAs(project.local_path, path, tab.content);
        return "saved";
      }
      // A notice or read-only text has nothing of the user's to write — and writing a decoded Latin-1
      // file back as UTF-8 would change every accent in it.
      if (tab.loading || !isWritable(tab)) return "skipped";
      if (tab.content === tab.originalContent) return "clean";
      const text = tab.content;
      setSaving(true);
      try {
        // Checked against the version the buffer started from, so a file an agent, a pull or a
        // replace rewrote meanwhile is not silently overwritten. `force` is the user's "overwrite".
        const version = await writeEditorFile(project.local_path, path, text, force ? null : tab.version);
        // The language servers are told too. `client_capabilities` asks for `didSave` and this is
        // the only place that can send it — without it `checkOnSave`, which the rust-analyzer entry
        // declares twice, never fires: the user gets one round of real cargo errors on workspace
        // load and never another, however often they save. gopls and Ruff lose their on-save pass
        // the same way.
        syncSave(path, text);
        commitTabs((prev) =>
          prev.map((item) =>
            item.path === path
              ? {
                  ...item,
                  originalContent: text,
                  version,
                  diskChanged: false,
                  diskText: null,
                  viewMode: item.diskText !== null && item.viewMode === "diff" ? "code" : item.viewMode,
                }
              : item,
          ),
        );
        // The Changes tab (and any conflict-resolution flow) reads git status from
        // repoStore, which has no way to know a file changed on disk outside of a git
        // command — refresh it explicitly so a save here shows up immediately there.
        void useRepoStore.getState().refreshStatus();
        return "saved";
      } catch (e) {
        if (isChangedOnDisk(e)) {
          commitTabs((prev) => prev.map((item) => (item.path === path ? { ...item, diskChanged: true } : item)));
          if (interactive) diskQuestionRef.current(path);
          return "conflict";
        }
        // Said out loud, and the buffer stays dirty: a save that failed quietly — a full disk, a
        // permission, a folder deleted under the file — looked exactly like one that worked.
        if (interactive) {
          pushErrorToast(tRef.current("editor.saveFailed", { name: describePath(path).name, error: String(e) }));
        }
        return "failed";
      } finally {
        setSaving(false);
      }
    },
    [project, saveScratchAs, commitTabs],
  );

  /**
   * "Formatear al guardar": the buffer formatted — the repository's Prettier, else the language's
   * formatter (`formatDocument`) — right before the checked save below writes it. Only a dirty,
   * writable file of the project: formatting a clean file on ⌘S would turn a save that writes
   * nothing into one that rewrites the file.
   */
  const formatBeforeSave = useCallback(
    async (path: string) => {
      if (!useEditorFormatStore.getState().formatOnSave) return;
      const current = projectRef.current;
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!current || !tab || tab.loading || !isWritable(tab) || !isDirtyTab(tab)) return;
      // A scratch buffer is no file to be formatted as, and a notebook is written in Jupyter's own
      // layout (see `lib/notebook`), which a JSON formatter would rewrite on every save.
      if (isScratchPath(path) || isNotebookPath(path)) return;
      try {
        const model = monaco.editor.getModel(monaco.Uri.parse(modelPathFor(current, path)));
        let text: string | null = null;
        if (model) {
          await formatModel(model, current.local_path, path);
          if (!model.isDisposed()) text = model.getValue();
        } else if (prettierCanFormat(path)) {
          // A tab that has never been on screen has no model, and a bare text is Prettier's alone.
          const outcome = await formatWithPrettier(current.local_path, path, tab.content);
          if (outcome.kind === "formatted") text = outcome.text;
        }
        if (text === null || projectRef.current?.local_path !== current.local_path) return;
        const formatted = text;
        // Into the tab now rather than at the next render: the save that follows reads `tabsRef`.
        // Without a model, only over the text that was formatted — typing since then wins.
        commitTabs((prev) =>
          prev.map((item) =>
            item.path === path && isWritable(item) && (model !== null || item.content === tab.content)
              ? { ...item, content: formatted }
              : item,
          ),
        );
      } catch {
        // A formatter that failed has said so (`formatDocument`); the save goes ahead as typed.
      }
    },
    [commitTabs],
  );

  /** Saves one file — after any save of it already running, see `savesInFlight`. `interactive:
   *  false` is a save nobody is watching (the quit's "save all"): it reports, it never asks.
   *  `format` defaults to `interactive`: the quit's save writes what is there, and an overwrite of a
   *  file that changed on disk writes exactly the buffer the user chose to keep. */
  const save = useCallback(
    async (
      path: string,
      opts: { force?: boolean; interactive?: boolean; format?: boolean } = {},
    ): Promise<SaveOutcome> => {
      const before = savesInFlight.current.get(path);
      const interactive = opts.interactive ?? true;
      const run = (async () => {
        if (before) await before.catch(() => "failed");
        if (!opts.force && (opts.format ?? interactive)) await formatBeforeSave(path);
        return saveNow(path, opts.force ?? false, interactive);
      })();
      savesInFlight.current.set(path, run);
      try {
        return await run;
      } finally {
        if (savesInFlight.current.get(path) === run) savesInFlight.current.delete(path);
      }
    },
    [saveNow, formatBeforeSave],
  );

  /**
   * Reads a tab's file again and makes the tab whatever came back: a notice's Retry, "open anyway"
   * (`allowLarge`), "reload from disk" — which is the buffer thrown away, on purpose — and the disk
   * sweep's refresh of a clean tab (`onlyIfClean`, which never touches unsaved edits).
   */
  const reloadTab = useCallback(
    async (path: string, opts: { allowLarge?: boolean; onlyIfClean?: boolean } = {}) => {
      const current = projectRef.current;
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!current || !tab || isScratchPath(path)) return;
      // A notice has nothing on screen worth keeping while the read runs; text stays where it is
      // until the new text lands.
      if (tab.notice && !opts.onlyIfClean) patchTab(path, { loading: true });
      let loaded: LoadedFile;
      try {
        loaded = loadedFrom(
          await readEditorFile(current.local_path, path, opts.allowLarge ?? tab.readOnly?.kind === "large"),
        );
      } catch (e) {
        if (tab.notice) {
          loaded = failedLoad(e);
        } else {
          // Text stays as it is — a file deleted since is a reason to keep the buffer, not to lose it.
          if (!opts.onlyIfClean) pushErrorToast(String(e));
          return;
        }
      }
      // The window moved to another project while this was read, whose tab of the same name is not
      // this file.
      if (projectRef.current?.local_path !== current.local_path) return;
      const latest = tabsRef.current.find((item) => item.path === path);
      if (!latest) return;
      if (opts.onlyIfClean && (isDirtyTab(latest) || sameLoadedState(latest, loaded))) return;
      commitTabs((prev) =>
        prev.map((item) =>
          item.path === path && !(opts.onlyIfClean && isDirtyTab(item)) ? withLoaded(item, loaded) : item,
        ),
      );
    },
    [patchTab, commitTabs],
  );

  /** "Compare": the file as it is on disk now, beside the buffer, in the diff view. */
  const compareWithDisk = useCallback(
    async (path: string) => {
      const current = projectRef.current;
      if (!current) return;
      let text: string | null;
      try {
        const file = await readEditorFile(current.local_path, path);
        text = file.kind === "text" || file.kind === "legacy" ? file.text : null;
      } catch (e) {
        // Deleted since it was read: the disk side is nothing, which is exactly what to show.
        const now = await statEditorFile(current.local_path, path, null).catch(() => undefined);
        if (now !== null) {
          pushErrorToast(String(e));
          return;
        }
        text = "";
      }
      if (text === null) {
        pushErrorToast(tRef.current("editor.diskCompareUnavailable"));
        return;
      }
      if (projectRef.current?.local_path !== current.local_path) return;
      patchTab(path, { diskText: text, viewMode: "diff", compare: null, diskChanged: true });
    },
    [patchTab],
  );

  const diskAction = useCallback(
    (path: string, action: DiskAction) => {
      if (action === "overwrite") void save(path, { force: true });
      else if (action === "reload") void reloadTab(path);
      else void compareWithDisk(path);
    },
    [save, reloadTab, compareWithDisk],
  );

  /**
   * What a save the disk refused asks: compare the two, take the disk's copy (the buffer goes), or
   * write the buffer over it. Cancel leaves both as they are — the tab keeps its "changed on disk"
   * strip, with the same three answers on it for later.
   */
  const resolveDiskConflict = useCallback(
    async (path: string) => {
      const askedIn = projectRef.current?.local_path;
      const answer = await chooseAction({
        message: tRef.current("editor.diskConflict", { name: describePath(path).name }),
        danger: true,
        choices: [
          { id: "compare", label: tRef.current("editor.diskCompare"), variant: "primary" },
          { id: "reload", label: tRef.current("editor.diskReload") },
          { id: "overwrite", label: tRef.current("editor.diskOverwrite"), variant: "danger" },
        ],
      });
      // Answered after the window moved to another project: the tab is parked with its strip, and
      // the answer can wait for it — acting now would act on the other project's file of this name.
      if (projectRef.current?.local_path !== askedIn) return;
      if (answer === "compare" || answer === "reload" || answer === "overwrite") diskAction(path, answer);
    },
    [diskAction],
  );
  diskQuestionRef.current = (path) => void resolveDiskConflict(path);

  /**
   * "Guardar todo": every unsaved tab of this project — notebooks included, whose tab text *is* the
   * notebook — through the same checked save ⌘S uses, formatting and all.
   *
   * Nothing is asked per file on the way, so one conflict does not stop the rest: a file that
   * changed on disk is left unsaved with its strip on (Comparar / Recargar / Sobrescribir), and the
   * files that ended up that way are listed together once everything else is written. Scratch
   * buffers are left out — their save is a Save As, a dialog per tab — and so is read-only text,
   * which has nothing of the user's to write.
   */
  const saveAll = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const dirty = tabsRef.current.filter((tab) => isDirtyTab(tab) && isWritable(tab) && !isScratchPath(tab.path));
    if (dirty.length === 0) return;
    const conflicts: string[] = [];
    const failed: string[] = [];
    for (const tab of dirty) {
      const outcome = await save(tab.path, { interactive: false, format: true });
      if (outcome === "conflict") conflicts.push(tab.path);
      else if (outcome === "failed") failed.push(tab.path);
    }
    if (projectRef.current?.local_path !== current.local_path) return;
    if (failed.length > 0) pushErrorToast(tRef.current("editor.saveAllFailed", { names: failed.join(", ") }));
    if (conflicts.length === 0) return;
    const answer = await chooseAction({
      message: tRef.current("editor.saveAllConflicts", { n: conflicts.length }),
      items: conflicts,
      danger: true,
      choices: [
        { id: "review", label: tRef.current("editor.saveAllReview"), variant: "primary" },
        { id: "overwrite", label: tRef.current("editor.saveAllOverwrite"), variant: "danger" },
      ],
    });
    if (projectRef.current?.local_path !== current.local_path) return;
    // Review: the first of them, whose strip holds the three answers — the others keep theirs.
    if (answer === "review") void openFile(conflicts[0], { pin: true });
    else if (answer === "overwrite") for (const path of conflicts) await save(path, { force: true, interactive: false });
  }, [save, openFile]);

  /**
   * Hands a `.dbml` file to the Diagrams app as a diagram that stays in step with it.
   *
   * **Saved first, deliberately.** The diagram is a view of the file on disk, so opening it over an
   * unsaved buffer would show a schema the editor is not showing — and the first thing the diagram
   * autosaved would then be the *older* text, back over the user's edits. `save` is a no-op on a
   * clean tab, so the common press costs nothing. The button's tooltip says the file is saved.
   *
   * The workspace comes from the project rather than from whichever one the window is looking at:
   * the diagram belongs beside its repository, and a repository lives in exactly one workspace.
   */
  const openInDiagrams = useCallback(
    async (path: string) => {
      const current = projectRef.current;
      if (!current) return;
      const workspaceId =
        useWorkspaceStore.getState().workspaceOfProject(current.id) ??
        useWorkspaceStore.getState().activeWorkspaceId;
      if (!workspaceId) return;
      // Not over a save that did not happen: the diagram would open on the older text on disk.
      const saved = await save(path);
      if (saved === "conflict" || saved === "failed") return;
      await openDbmlInDiagrams({ workspaceId, projectId: current.id, relPath: path });
    },
    [save],
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
  //
  // A project left with unsaved tabs is parked rather than emptied, and asked about right after (the
  // `leaving` effect below) — see `ParkedEditor` for why it cannot be asked before. A project coming
  // back gets its parked editor back, exactly as it was left.
  const [lastProject, setLastProject] = useState<Project | null>(project);
  const projectPath = project?.local_path ?? null;
  if (projectPath !== (lastProject?.local_path ?? null)) {
    const left = lastProject;
    const current = { tabs, groups, activeGroupId };
    const { editor, restored } = editorAfterSwitch(parked, projectPath, () => newGroup());
    setLastProject(project);
    setParked((prev) => parkedAfterSwitch(prev, current, left, projectPath));
    setTabs(editor.tabs);
    setGroups(editor.groups);
    setActiveGroupId(editor.activeGroupId);
    if (restored) setRestoredParked((n) => n + 1);
    if (left && tabs.some(isDirtyTab)) setLeaving({ repoPath: left.local_path, to: projectPath });
  } else if (project && project !== lastProject) {
    // The same repository under a fresher row (a rename, a link written by the backend): kept, so a
    // project parked later is named as it is called now.
    setLastProject(project);
  }

  // The diff cache is per repository by key, so once the project has changed nothing in it can be
  // hit again — it is pure residency, and an entry is a whole file's worth of `DiffLine` objects.
  // In an effect rather than in the render branch above: that branch runs during a render React may
  // discard, and twice under StrictMode.
  useEffect(() => clearFullDiffCache, [project?.local_path]);

  // Models outlive the editor (see `keepCurrentModel`), so a file leaving the registry has to
  // dispose its model explicitly or everything ever opened stays in memory. Keyed on *which*
  // files are open rather than on `tabs` itself, so this isn't swept on every keystroke.
  // Newline is the one character a path can't contain.
  const openPathsKey = tabs.map((tab) => tab.path).join("\n");
  const parkedKey = Object.entries(parked)
    .map(([repoPath, entry]) => `${repoPath}\n${entry.tabs.map((tab) => tab.path).join("\n")}`)
    .join("\n\n");
  useEffect(() => {
    if (!project) return;
    // Both sides go through `Uri.parse().toString()` so the comparison is against Monaco's
    // own normalization of the path rather than the raw string we handed it.
    const open = new Set(tabsRef.current.map((tab) => monaco.Uri.parse(modelPathFor(project, tab.path)).toString()));
    // A parked editor keeps its models: they are its undo history, and it comes back with it.
    for (const entry of Object.values(parkedRef.current)) {
      for (const tab of entry.tabs) open.add(monaco.Uri.parse(modelPathFor(entry.project, tab.path)).toString());
    }
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme === MODEL_SCHEME && !open.has(model.uri.toString())) model.dispose();
    }
  }, [openPathsKey, parkedKey, project]);

  /** Forgets a parked editor — its tabs saved, or thrown away. */
  const dropParked = useCallback((repoPath: string) => {
    setParked((prev) => {
      if (!(repoPath in prev)) return prev;
      const next = { ...prev };
      delete next[repoPath];
      return next;
    });
  }, []);

  /**
   * Saves a parked editor's unsaved tabs where they are, without going back to the project — each
   * checked against the version it was read at, like any save. Resolves to what could not be saved: a
   * file that changed on disk meanwhile (marked, for when the project is opened again), a scratch
   * buffer (which only a Save As can place), a write that failed. Those stay parked.
   */
  const saveParked = useCallback(async (repoPath: string): Promise<string[]> => {
    const entry = parkedRef.current[repoPath];
    if (!entry) return [];
    const failed: string[] = [];
    const saved = new Map<string, { text: string; version: DiskVersion }>();
    const changed = new Set<string>();
    for (const tab of entry.tabs.filter(isDirtyTab)) {
      if (isScratchPath(tab.path) || !isWritable(tab)) {
        failed.push(isScratchPath(tab.path) ? scratchName(tab.path) : tab.path);
        continue;
      }
      try {
        const version = await writeEditorFile(repoPath, tab.path, tab.content, tab.version);
        saved.set(tab.path, { text: tab.content, version });
      } catch (e) {
        if (isChangedOnDisk(e)) changed.add(tab.path);
        failed.push(tab.path);
      }
    }
    setParked((prev) => {
      const current = prev[repoPath];
      if (!current) return prev;
      const tabs = current.tabs.map((tab) => {
        const done = saved.get(tab.path);
        if (done && tab.content === done.text) {
          return { ...tab, originalContent: done.text, version: done.version, diskChanged: false };
        }
        return changed.has(tab.path) ? { ...tab, diskChanged: true } : tab;
      });
      const next = { ...prev };
      if (tabs.some(isDirtyTab)) next[repoPath] = { ...current, tabs };
      else delete next[repoPath];
      return next;
    });
    // The journal row says what is still unsaved there — which is only what just failed.
    if (!discardedRef.current) {
      void writeDrafts(
        repoPath,
        entry.tabs
          .filter((tab) => isDirtyTab(tab) && !saved.has(tab.path) && !isScratchPath(tab.path))
          .map((tab) => ({ path: tab.path, content: tab.content, at: Date.now() })),
      );
    }
    return failed;
  }, []);

  /**
   * The question a project switch owes the user when it left unsaved tabs behind: save them all
   * where they are, discard them, or cancel — which goes back to the project, where the parked
   * editor is waiting. Cancel only goes back while the window is still on the project it switched
   * to: if the user has moved on again since, the tabs simply stay parked (nothing is lost, and the
   * quit question still knows about them).
   */
  const askAboutParked = useCallback(
    async (repoPath: string, switchedTo: string | null) => {
      const entry = parkedRef.current[repoPath];
      if (!entry) return;
      const dirty = entry.tabs.filter(isDirtyTab);
      // Journalled now: the switch cancelled the debounced write that would have covered these.
      if (!discardedRef.current) {
        void writeDrafts(
          repoPath,
          dirty
            .filter((tab) => !isScratchPath(tab.path))
            .map((tab) => ({ path: tab.path, content: tab.content, at: Date.now() })),
        );
      }
      const answer = await chooseAction({
        message: tRef.current("editor.leaveDirty", { n: dirty.length, project: entry.project.name }),
        items: dirty.map((tab) => (isScratchPath(tab.path) ? scratchName(tab.path) : tab.path)),
        danger: true,
        choices: [
          { id: "save", label: tRef.current("editor.saveAll"), variant: "primary" },
          { id: "discard", label: tRef.current("editor.discardAll"), variant: "danger" },
        ],
      });
      if (answer === "save") {
        const failed = await saveParked(repoPath);
        if (failed.length > 0) {
          pushErrorToast(tRef.current("editor.saveAllFailed", { names: failed.join(", ") }));
        }
      } else if (answer === "discard") {
        dropParked(repoPath);
        void clearDrafts(repoPath);
      } else if (switchedTo === null || projectRef.current?.local_path === switchedTo) {
        // `null` is a workspace switch: it passes through "no project" before the workspace's own last
        // project is picked for it, and that pick is part of the same move, not the user moving on.
        const workspaces = useWorkspaceStore.getState();
        const workspaceId = workspaces.workspaceOfProject(entry.project.id);
        // A project removed since has nowhere to go back to; its tabs stay parked.
        if (workspaceId) void workspaces.focusProject(workspaceId, entry.project.id);
      }
    },
    [saveParked, dropParked],
  );

  useEffect(() => {
    if (!leaving) return;
    setLeaving(null);
    void askAboutParked(leaving.repoPath, leaving.to);
  }, [leaving, askAboutParked]);

  // A parked editor can come back holding a tab that was still being read when the window left: that
  // read finished while another project was showing and was dropped (see `readInto`). Read it again,
  // or the tab would wait on it forever.
  useEffect(() => {
    if (restoredParked === 0) return;
    for (const tab of tabsRef.current) if (tab.loading) void readInto(tab.path);
  }, [restoredParked, readInto]);

  /**
   * What a quit asks about — see `lib/unsavedWork.ts`: every dirty tab, this project's and every
   * parked one's. Registered once and read through refs, so the answer is the editor as it is when
   * the question comes.
   *
   * `saveAll` saves without asking anything (it runs inside the quit's own question): a file that
   * changed on disk is reported as not saved, and the app stays open with the buffer intact.
   */
  const saveRef = useRef(save);
  saveRef.current = save;
  const saveParkedRef = useRef(saveParked);
  saveParkedRef.current = saveParked;
  useEffect(
    () =>
      registerUnsavedProvider({
        id: "editor",
        unsaved: () => {
          const items: UnsavedItem[] = [];
          const add = (tab: OpenTab, projectName: string) => {
            if (!isDirtyTab(tab)) return;
            items.push({ label: isScratchPath(tab.path) ? scratchName(tab.path) : tab.path, detail: projectName });
          };
          const here = projectRef.current;
          if (here) for (const tab of tabsRef.current) add(tab, here.name);
          for (const entry of Object.values(parkedRef.current)) {
            for (const tab of entry.tabs) add(tab, entry.project.name);
          }
          return items;
        },
        saveAll: async () => {
          const failed: string[] = [];
          for (const tab of tabsRef.current.filter(isDirtyTab)) {
            const outcome = await saveRef.current(tab.path, { interactive: false });
            if (outcome !== "saved" && outcome !== "clean") {
              failed.push(isScratchPath(tab.path) ? scratchName(tab.path) : tab.path);
            }
          }
          for (const repoPath of Object.keys(parkedRef.current)) {
            failed.push(...(await saveParkedRef.current(repoPath)));
          }
          return failed;
        },
        discard: async () => {
          discardedRef.current = true;
          const repos = new Set(Object.keys(parkedRef.current));
          if (projectRef.current) repos.add(projectRef.current.local_path);
          await Promise.all([...repos].map((repoPath) => clearDrafts(repoPath)));
        },
      }),
    [],
  );
  // Which files are dirty, as one string: what changes when a file becomes dirty or clean — not on
  // every keystroke — which is when a satellite's report to the main window has to go out.
  const unsavedKey = [
    ...tabs.filter(isDirtyTab).map((tab) => tab.path),
    ...Object.entries(parked).flatMap(([repoPath, entry]) =>
      entry.tabs.filter(isDirtyTab).map((tab) => `${repoPath}:${tab.path}`),
    ),
  ].join("\n");
  useEffect(() => notifyUnsavedChanged(), [unsavedKey]);

  // The notebooks' way into their tabs — see `lib/notebook/host`. Through `commitTabs`, so a read
  // right after a write already sees it: a kernel's output and a keystroke can land in one tick.
  useEffect(() => {
    if (!project) return;
    return registerNotebookHost(project.local_path, {
      read: (path) => {
        const tab = tabsRef.current.find((item) => item.path === path);
        return tab && !tab.loading && isWritable(tab) ? tab.content : null;
      },
      write: (path, text) =>
        commitTabs((prev) =>
          prev.map((tab) => (tab.path === path && isWritable(tab) ? { ...tab, content: text, preview: false } : tab)),
        ),
    });
  }, [project, commitTabs]);

  /**
   * How a rename reaches the tabs — see `lib/workspaceEdit`. A file with a model is edited through
   * it, so the change is one Ctrl+Z away and every server hears about it through the document sync;
   * a tab that was never on screen has no model and takes the edit as text. Either way the tab goes
   * dirty, and nothing is written: the rename sits in the buffer like anything typed there.
   *
   * A dirty tab with no model is refused. The server planned the edit against a copy of the file it
   * was given, and it is only ever given models — so for that tab it read the disk, and the buffer
   * says something else.
   */
  useEffect(() => {
    if (!project) return;
    return registerWorkspaceEditHost(project.local_path, {
      isOpen: (path) => tabsRef.current.some((tab) => tab.path === path),
      applyToOpen: (path, edits) => {
        const tab = tabsRef.current.find((item) => item.path === path);
        if (!tab) throw new Error(tRef.current("editor.renameNotOpen"));
        if (tab.loading || !isWritable(tab)) throw new Error(tRef.current("editor.renameReadOnly"));
        const model = monaco.editor.getModel(monaco.Uri.parse(modelPathFor(project, path)));
        let text: string;
        if (model) {
          model.pushStackElement();
          model.pushEditOperations(
            [],
            edits.map((edit) => ({ range: edit.range, text: edit.text })),
            () => null,
          );
          model.pushStackElement();
          text = model.getValue();
        } else {
          if (isDirtyTab(tab)) throw new Error(tRef.current("editor.renameUnseenBuffer"));
          text = applyTextEdits(tab.content, edits);
        }
        const next = text;
        commitTabs((prev) =>
          prev.map((item) => (item.path === path && isWritable(item) ? { ...item, content: next, preview: false } : item)),
        );
        return next;
      },
    });
  }, [project, commitTabs]);

  // Problems and the project check are about one project; a window that moved on has none of the
  // previous one's, and every server they came from was stopped with it.
  useEffect(() => {
    useProblemsStore.getState().clear();
    useEditorPanelStore.getState().setProjectCheck({ canCheckProject: false, checkingProject: false });
  }, [project?.local_path]);

  // "Formatear al guardar" is read when the editor first needs it rather than at boot.
  useEffect(() => {
    void useEditorFormatStore.getState().init();
  }, []);

  // A notebook whose last tab closed has its kernel stopped. Keyed on the notebooks' paths alone, so
  // typing never runs it; a project the window left keeps its notebooks (they are parked).
  const notebookPaths = tabs
    .filter((tab) => isNotebookPath(tab.path))
    .map((tab) => tab.path)
    .join("\n");
  useEffect(() => {
    if (!project) return;
    notebookActions.syncOpenNotebooks(project.local_path, notebookPaths ? notebookPaths.split("\n") : []);
  }, [project, notebookPaths]);

  // Bookmarks are stored per project, so opening one is what decides which set is in force. The
  // store no-ops when the path hasn't changed, which is what makes this safe to run on a render
  // that only changed a tab.
  useEffect(() => {
    if (project) void useBookmarkStore.getState().load(project.local_path);
  }, [project]);

  // Reload open files from disk when they change externally — a terminal `git` command, an
  // edit in another editor, a branch checkout — instead of silently showing stale content
  // until the user happens to reopen them. Tabs with unsaved local edits are never reloaded, so
  // this never clobbers work in progress; the user's own edit wins until they save or discard it.
  //
  // Nor are they ignored any more. An agent, a pull or a project-wide replace rewriting a file under
  // a dirty tab used to leave no trace until ⌘S put the old buffer back over their work. Such a tab is
  // now marked (`diskChanged`), and the save itself is checked against the disk (see `saveNow`).
  //
  // Each tab is asked about with the version it holds, so a file whose timestamp and size have not
  // moved costs one `stat` and no read — this runs for every open tab on every watcher event.
  const syncOpenTabs = useCallback(() => {
    if (!project) return;
    const repoPath = project.local_path;
    for (const tab of tabsRef.current) {
      // A scratch tab has no file on disk to fall behind — see `lib/scratchTabs`. A file being saved
      // is about to move under its own tab, which is not news.
      if (tab.loading || isScratchPath(tab.path) || savesInFlight.current.has(tab.path)) continue;
      void statEditorFile(repoPath, tab.path, tab.version)
        .then((now) => {
          if (projectRef.current?.local_path !== repoPath || savesInFlight.current.has(tab.path)) return;
          const latest = tabsRef.current.find((item) => item.path === tab.path);
          if (!latest || latest.loading) return;
          // See `sweepStep`. `none` is the overwhelmingly common answer — the watcher fired for
          // *some* file in the repo and this one is byte for byte what the tab holds — and it must
          // not write state: rebuilding the `tabs` array re-renders this view, every `EditorPane`
          // (each holding a live Monaco instance) and the whole file tree, for no change.
          const step = sweepStep(latest, isDirtyTab(latest), now);
          if (step.kind === "mark") {
            commitTabs((prev) =>
              prev.map((item) =>
                // Against the latest state: a save may have landed while this was in flight.
                item.path === tab.path && isDirtyTab(item) && item.version === latest.version
                  ? { ...item, diskChanged: step.diskChanged, version: step.version }
                  : item,
              ),
            );
          } else if (step.kind === "stamp") {
            commitTabs((prev) =>
              prev.map((item) =>
                item.path === tab.path && item.version === latest.version ? { ...item, version: step.version } : item,
              ),
            );
          } else if (step.kind === "reload") {
            void reloadTab(tab.path, { onlyIfClean: true });
          }
        })
        .catch(() => {});
    }
  }, [project, commitTabs, reloadTab]);

  /** Set when the watcher fired for this repo while the Editor was off screen, so the sweep can be
   * deferred to the moment it comes back rather than run behind another view. */
  const missedFsChangeRef = useRef(false);
  /**
   * Bumped on every sweep, and handed to the tree so it re-lists too.
   *
   * The watcher only ever moved the *open tabs*. The explorer beside them was refreshed by one
   * thing — its own toolbar button — so a branch switch, a `git pull`, a generated file or an agent
   * writing into the working tree left the tree showing the directory as it used to be, and the
   * only way out was to keep pressing refresh. Same event, same deferral, one more consumer.
   */
  const [fsNonce, setFsNonce] = useState(0);
  const noteFsChange = useCallback(() => {
    syncOpenTabs();
    setFsNonce((n) => n + 1);
  }, [syncOpenTabs]);

  /**
   * The same sweep, asked for rather than observed.
   *
   * Three things go stale together here and three different mechanisms refresh them: the open
   * buffers by `syncOpenTabs`, the explorer's listings by the nonce, and every change decoration —
   * the tree's badges, the gutter markers, the diff tab — by `repoStore.status`/`workingDiff`,
   * which only `refreshStatus` rebuilds. The explorer's Refresh button used to drive the middle
   * one alone, so pressing it on a screen that looked stale left two thirds of it exactly as stale
   * as before, which is most of what "refresh does nothing" meant.
   *
   * Not silent: this one was asked for, unlike the watcher's.
   */
  const forceReload = useCallback(() => {
    noteFsChange();
    void useRepoStore.getState().refreshStatus();
  }, [noteFsChange]);

  useEffect(() => {
    if (!project) return;
    const unlisten = onRepoFsChanged((e) => {
      if (e.repo_path !== project.local_path) return;
      // This panel stays mounted behind every other view (that is what keeps its Monaco
      // instances and their undo stacks alive), so a `git` command run from the terminal tab
      // would otherwise re-read every open file while nobody is looking at any of them.
      if (activeViewRef.current !== "editor") {
        missedFsChangeRef.current = true;
        return;
      }
      noteFsChange();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [project, noteFsChange]);

  // The catch-up, and the reason the skip above is safe: coming back to the Editor runs the sweep
  // that was deferred while it was hidden. Without this, a file changed on disk from another tab
  // would sit stale in its pane until it was closed and reopened — which is exactly the bug the
  // sweep exists to prevent.
  useEffect(() => {
    if (activeView !== "editor" || !missedFsChangeRef.current) return;
    missedFsChangeRef.current = false;
    noteFsChange();
  }, [activeView, noteFsChange]);

  /** The tree's two open gestures, as stable identities. Inline arrows here would re-identify on
   * every render of this view and defeat the `memo` on every row of `FileTree`. */
  const selectFileInTree = useCallback((path: string) => void openFile(path), [openFile]);
  const openFileInTree = useCallback((path: string) => void openFile(path, { pin: true }), [openFile]);

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
   * toolbar's diff toggle is the way back and the tab can be left open beside the others.
   *
   * `compare` picks *which* before/after: a commit's change to the file when a blame annotation was
   * clicked, or `null` — the default, and what the Changes panel means — for the working change.
   * Written explicitly rather than left alone, so opening the working diff of a file that is still
   * pointed at a commit from an earlier click shows the working change and not that commit. */
  const openDiffTab = useCallback(
    async (path: string, compare: OpenTab["compare"] = null) => {
      await openFile(path, { pin: true });
      patchTab(path, { viewMode: "diff", compare });
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
      // Handed to the focused pane for the same reason the two above are: the peek is per-pane, so
      // only the pane the user is looking at can say which hunk "next" is next from.
      case "nextChange":
        changeNavRef.current?.(1);
        break;
      case "prevChange":
        changeNavRef.current?.(-1);
        break;
      // Save is not gated on the Editor being visible: a file with unsaved edits is worth saving
      // from wherever you happen to be looking, which is what the old listener did too.
      case "save": {
        const current = groupsRef.current.find((g) => g.id === activeGroupIdRef.current)?.activePath;
        if (current) void save(current);
        break;
      }
      case "saveAll":
        void saveAll();
        break;
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

  const registerChangeNav = useCallback((nav: (delta: number) => void) => {
    changeNavRef.current = nav;
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

  /**
   * The flat group list as the grid it describes: columns in order, each holding its stack.
   *
   * Groups of one column are contiguous — `editorGroups` maintains that — so this is a single pass
   * that starts a new column whenever the id changes, and the list stays the single source of order
   * for everything else in this file.
   */
  const columns = useMemo(() => {
    const out: { id: string; groups: EditorGroup[] }[] = [];
    for (const group of groups) {
      const current = out[out.length - 1];
      if (current && current.id === group.column) current.groups.push(group);
      else out.push({ id: group.column, groups: [group] });
    }
    return out;
  }, [groups]);

  // Splitting (or closing) a group re-divides the row evenly, which is what VS Code does and the
  // only sane answer for an arbitrary number of panes: any other rule has to invent where the new
  // group's width came from. Widths are only reset when the *count* changes, so dragging a
  // boundary sticks until the next split.
  const columnCount = columns.length;
  useLayoutEffect(() => {
    const row = groupsRowRef.current;
    if (!row || columnCount < 2) {
      setGroupWidths([]);
      return;
    }
    // The drag handles sit between the panes and take real space out of the row.
    const share = (row.clientWidth - HANDLE_WIDTH * (columnCount - 1)) / columnCount;
    setGroupWidths(Array.from({ length: columnCount - 1 }, () => Math.max(GROUP_MIN, Math.floor(share))));
  }, [columnCount]);

  /**
   * The same even division down each column, and for the same reason.
   *
   * Keyed by *how the columns are stacked* rather than by the group count: a tab moving between two
   * panes that are already there changes neither, so the heights somebody dragged stay put, while
   * splitting or closing a pane re-divides the column it happened in.
   */
  const stacking = columns.map((column) => `${column.id}:${column.groups.length}`).join("|");
  useLayoutEffect(() => {
    const row = groupsRowRef.current;
    if (!row) return;
    const next: Record<string, number[]> = {};
    for (const column of columns) {
      if (column.groups.length < 2) continue;
      const share = (row.clientHeight - HANDLE_WIDTH * (column.groups.length - 1)) / column.groups.length;
      next[column.id] = Array.from({ length: column.groups.length - 1 }, () =>
        Math.max(ROW_MIN, Math.floor(share)),
      );
    }
    setGroupHeights(next);
    // `columns` is rebuilt on every group change; `stacking` is the part of it this cares about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stacking]);

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
      onChange={changeTab}
      // Leaving diff view forgets which commit was being compared. One rule in one place: without it,
      // a tab that once showed a commit's change would keep showing *that* commit every time the diff
      // toggle was pressed again, for the rest of the tab's life — and the toggle's promise is "the
      // change this file has", not "the last thing you clicked on in it". A comparison with the disk
      // is forgotten the same way.
      onViewMode={(path, mode: ViewMode) =>
        patchTab(path, mode === "diff" ? { viewMode: mode } : { viewMode: mode, compare: null, diskText: null })
      }
      onSave={() => group.activePath && void save(group.activePath)}
      onReload={(path, opts) => void reloadTab(path, opts)}
      onDiskAction={diskAction}
      // Only for a schema. Not a disabled button on every other file — there is nothing to explain
      // about a bridge that does not apply, and a permanently greyed-out icon in a five-icon
      // toolbar is worse than an absent one.
      onOpenInDiagrams={
        isDbmlPath(group.activePath)
          ? () => group.activePath && void openInDiagrams(group.activePath)
          : null
      }
      onCodeSnap={setCodeSnap}
      // Lands in the pane that was clicked without being told which: the pane's capture-phase
      // `onMouseDown` made it the active group before Monaco's own mousedown ran, and `openDiffTab`
      // opens into the active group.
      onOpenCommitDiff={(path, compare) => void openDiffTab(path, compare)}
      registerCapture={registerCapture}
      registerBookmarkToggle={registerBookmarkToggle}
      registerChangeNav={registerChangeNav}
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
        revealInTree,
        splitRight: (path) => splitGroup(group.id, path),
        saveAll: () => void saveAll(),
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
          className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))] py-2"
        >
          {/* The chord in each tooltip comes from the binding registry, drawn as a key cap beside
              the name, never from a string next to the label: two of these used to carry a
              hand-written "(Ctrl+Shift+F)" that said Ctrl on a Mac and went stale the moment anyone
              rebound it. All five panels have a binding now, so every tooltip carries one — a rail
              where some glyphs answer "and the key?" and some don't is the surprise this avoids. (The icon
              panel is the one exception, and says why where it is listed.)
              `aria-label` stays the bare name — a screen reader announces the key from the
              binding, not from the accessible name. */}
          {(
            [
              { id: "files", shortcut: "editor.explorer", icon: Files, label: t("editor.explorer") },
              { id: "search", shortcut: "editor.findInProject", icon: Search, label: t("editor.searchInProject") },
              { id: "anchors", shortcut: "editor.anchors", icon: Tags, label: t("anchors.title") },
              { id: "bookmarks", shortcut: "editor.bookmarks", icon: Bookmark, label: t("bookmarks.title") },
              { id: "debug", shortcut: "editor.debug", icon: Bug, label: t("debug.title") },
              // Under the debugger, as asked: which icon pack this repository is drawn with. The one
              // panel with no chord of its own — a choice made now and then, not a place to go to.
              { id: "icons", shortcut: null, icon: Palette, label: t("icons.panelTitle") },
            ] as const
          ).map(({ id, icon: Icon, label, shortcut }) => (
            // A full-width row around the button, so the marker can stand on the rail's own left
            // edge, where VS Code's activity bar marks the open view.
            <div key={id} className="relative flex w-full justify-center">
              {/* A bar in the accent beside the open panel, on top of its fill (user ask, 2026-10-01:
                  a vertical bar saying which one is selected) — the mark the view tabs and the
                  projects panel wear. Outside the tooltip: its `contents` wrapper takes its first
                  child for the control. The one-shot actions below are never "open" and get none. */}
              {sidePanel === id && (
                <ActiveMarker layoutId="cf-editor-rail-mark" color="var(--cf-accent-fill)" className="left-0 inset-y-1.5" />
              )}
              <Tooltip side="right" label={label} trailing={shortcut ? keyCap(shortcut) : undefined}>
                <button
                  onClick={() => setSidePanel(id)}
                  aria-label={label}
                  aria-pressed={sidePanel === id}
                  className={railButtonClass(sidePanel === id)}
                >
                  {sidePanel === id && <ActivePill layoutId="cf-editor-rail-pill" />}
                  <Icon size={16} className="relative" />
                  {/* A live session is worth seeing from any panel — it's a running process. */}
                  {id === "debug" && debugStatus !== "idle" && (
                    <span
                      className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${
                        debugStatus === "paused" ? "bg-[var(--cf-warning)]" : "bg-[var(--cf-success)]"
                      }`}
                    />
                  )}
                </button>
              </Tooltip>
            </div>
          ))}
          {/* The actions, below the panels. `mt-auto` is on the first of them and nowhere else —
              it is what opens the gap that separates them from the five views above, and a second
              one would split the cluster in half.

              Go to file leads them rather than getting a strip of its own: it's an action, not a
              panel, and it has to be reachable with no file open — which the tab bar isn't.

              Editing the icon rules stays a tab under Settings → Editor: the profiles are global
              (see `iconRulesStore`), a preference every repository shares. *Choosing* one is about
              this repository, which is why that part is back in the rail — the Icons panel above. */}
          <Tooltip side="right" label={t("editor.goToFile")} trailing={keyCap("editor.goToFile")}>
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label={t("editor.goToFile")}
              className={iconButtonClass({ size: "md", className: "mt-auto" })}
            >
              <FileSearch size={16} />
            </button>
          </Tooltip>
          <Tooltip side="right" label={t("shortcuts.title")} trailing={keyCap("app.shortcuts")}>
            <button
              // Scoped: this button lives in the editor's own rail, so it answers for the editor.
              // The whole sheet is still a ⌘⌥K away.
              onClick={() => useUiStore.getState().toggleShortcutsModal(["editor"])}
              aria-label={t("shortcuts.title")}
              className={iconButtonClass({ size: "md" })}
            >
              <Keyboard size={16} />
            </button>
          </Tooltip>
        </div>
        <div
          style={{ width: treeWidth }}
          data-tour="editor-tree"
          // The explorer column of the shared anatomy: a half-step into the sunken tone, with its
          // own hairline on the right — which is why the handle beside it draws none. The tree owns
          // its own scroll area (below its toolbar), so this wrapper only clips — scrolling it too
          // would carry the toolbar out of view.
          className={`${explorerClass} overflow-hidden`}
        >
          {/* Explorer, find-in-project, anchors or the debugger — same column VS Code uses for
              all of them, since each wants the width more than a file tree does. */}
          {sidePanel === "search" ? (
            <SearchPanel
              repoPath={project.local_path}
              fsNonce={fsNonce}
              dirtyBuffers={dirtyBuffers}
              onOpenHit={openHit}
              onClose={() => setSidePanel("files")}
            />
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
            <IconProfilePanel />
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
              projectId={project.id}
              selectedPath={activePath}
              onSelectFile={selectFileInTree}
              onOpenFile={openFileInTree}
              onPathMoved={handlePathMoved}
              onPathRemoved={handlePathRemoved}
              command={explorerCommand}
              changedPaths={changedPaths}
              changedDirs={changedDirs}
              fsNonce={fsNonce}
              onRefresh={forceReload}
              onOpenScratch={openScratch}
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
          seamless
        />
        {/* Every group but the last carries an explicit width; the last takes the remainder, so
            the row fills exactly and a drag only ever moves one boundary. `GROUP_MIN` is a real
            floor — past the point where the panes stop fitting, the row scrolls rather than
            squeezing controls out of reach. */}
        {/* The groups over the Problems / results panel, which spans the groups and nothing else:
            what it lists is about the code, and the tree beside it keeps its full height. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={groupsRowRef} className="flex min-h-0 min-w-0 flex-1 overflow-x-auto">
            {/* A row of columns, each a stack of panes — the two axes a tab can be dropped against.
                A column with one group in it is exactly the old layout, which is what every split
                made before this existed still looks like. */}
            {columns.map((column, i) => {
              const lastColumn = i === columns.length - 1;
              const heights = groupHeights[column.id] ?? [];
              return (
                <Fragment key={column.id}>
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
                      lastColumn
                        ? { minWidth: GROUP_MIN }
                        : { width: groupWidths[i] ?? GROUP_MIN, minWidth: GROUP_MIN }
                    }
                    className={`flex min-w-0 flex-col ${lastColumn ? "flex-1" : "shrink-0"}`}
                  >
                    {column.groups.map((group, j) => {
                      const lastRow = j === column.groups.length - 1;
                      return (
                        <Fragment key={group.id}>
                          {j > 0 && (
                            <ResizeHandle
                              axis="y"
                              value={heights[j - 1] ?? ROW_MIN}
                              min={ROW_MIN}
                              max={GROUP_MAX}
                              onChange={(h) =>
                                setGroupHeights((prev) => ({
                                  ...prev,
                                  [column.id]: (prev[column.id] ?? []).map((v, k) => (k === j - 1 ? h : v)),
                                }))
                              }
                              onCommit={() => {}}
                            />
                          )}
                          <div
                            style={
                              lastRow
                                ? { minHeight: ROW_MIN }
                                : { height: heights[j] ?? ROW_MIN, minHeight: ROW_MIN }
                            }
                            className={`flex min-h-0 ${lastRow ? "flex-1" : "shrink-0"}`}
                          >
                            {renderGroup(group)}
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                </Fragment>
              );
            })}
          </div>
          {panelOpen && (
            <>
              <ResizeHandle
                axis="y"
                value={panelHeight}
                min={PANEL_MIN}
                max={PANEL_MAX}
                // Anchored to the bottom, so dragging up — toward the code — has to grow it.
                invert
                onChange={(h) => setSize("editorPanelHeight", h)}
                onCommit={(h) => commitSize("editorPanelHeight", h)}
              />
              <div style={{ height: panelHeight }} className="flex min-h-0 shrink-0 flex-col">
                <EditorBottomPanel onOpen={openHit} />
              </div>
            </>
          )}
        </div>
        {/* The Changes dock: the same panel the Changes screen is, on the other side of the code.
            Its rows open files here instead of into a diff pane of their own — see `ChangesPanel`
            — which is what makes it a companion to the editor rather than a second copy of a
            screen the app already has.

            Open, it runs flush to the window edge and its close button rides in its own header.
            Shut, a narrow rail holds the button instead. One or the other, never both: a rail kept
            up alongside the open panel was a full-height column of empty surface that pushed the
            panel a button's width off the edge it is docked to. */}
        {/* The two trade places, and neither animates its width: a width tween relaid out the
            whole window — Monaco included — on every frame of it. The panel appears at its width
            with its contents fading in (`cf-panel-in`, opacity only), and the rail simply comes
            back when it shuts. Growing and shrinking by the difference between the two is the one
            jump left, and it is a single layout rather than a hundred and eighty milliseconds of
            them. */}
        {changesOpen ? (
          <div className="cf-panel-in flex min-h-0 shrink-0">
            <ResizeHandle
              axis="x"
              value={changesWidth}
              min={CHANGES_MIN}
              max={CHANGES_MAX}
              // Anchored to the right, so dragging left — toward the code — has to grow it.
              invert
              onChange={(w) => setSize("editorChangesWidth", w)}
              onCommit={(w) => commitSize("editorChangesWidth", w)}
              // The inspector draws its own hairline on the left; a second one here, a pixel away,
              // read as a doubled edge.
              seamless
            />
            <div style={{ width: changesWidth }} className={`${inspectorClass} overflow-hidden`}>
              <ChangesPanel
                onOpenFile={openChangedFile}
                onOpenDiff={(path) => void openDiffTab(path)}
                headerAction={
                  <Tooltip side="bottom" label={t("editor.toggleChanges")}>
                    <button
                      onClick={() => setChangesOpen(false)}
                      aria-label={t("editor.toggleChanges")}
                      aria-expanded
                      className={iconButtonClass({ size: "xs" })}
                    >
                      <PanelRightClose size={14} />
                    </button>
                  </Tooltip>
                }
              />
            </div>
          </div>
        ) : (
          <div
            style={{ width: RAIL_W }}
            className="flex shrink-0 flex-col items-center gap-1 border-l border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))] py-2"
          >
            <Tooltip side="left" label={t("editor.toggleChanges")}>
              <button
                onClick={() => setChangesOpen(true)}
                aria-label={t("editor.toggleChanges")}
                aria-expanded={false}
                className={iconButtonClass({ size: "md", className: "relative" })}
              >
                <GitBranch size={16} />
                {/* Only while shut — which is the only state this rail has. Open, the panel itself
                    is the count, and a badge over it would be the same number twice. */}
                {uncommittedCount > 0 && (
                  <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--cf-accent-fill)]" />
                )}
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      {/* The Editor's own status line — see `EditorStatusLine`. A row of this view, not of the app's
          status bar, because everything on it is about the file in front of you. */}
      <EditorStatusLine />
      {/* The drop affordance: an outline around what will take the files, and a banner naming the
          folder they will land in — named rather than merely lit, because the same gesture lands
          somewhere different depending on which row the pointer is over, and a copy that went to
          the wrong folder is only discovered later. Nothing is dimmed: the tree underneath is what
          the drop is being aimed with. `pointer-events-none` so this can never become what the
          next hit test finds under the cursor. */}
      {dropDir !== null && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-end justify-center pb-8 ring-2 ring-inset ring-[var(--cf-accent)]">
          <div className="flex items-center gap-2.5 rounded-lg border border-[var(--cf-accent)] bg-[var(--cf-surface-raised)] px-4 py-2.5 shadow-[var(--cf-shadow)]">
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
