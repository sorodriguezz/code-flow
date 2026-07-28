import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { Bug, FileCode, FileSearch, Files, Keyboard, Search, Tags } from "lucide-react";
import { FileTree } from "./FileTree";
import { FilePalette } from "./FilePalette";
import { SearchPanel } from "./SearchPanel";
import { AnchorsPanel } from "./AnchorsPanel";
import { CodeSnapModal, type CodeSnapTarget } from "./CodeSnapModal";
import { DebugPanel } from "./DebugPanel";
import { EditorPane, type OpenTab, type RevealRequest, type ViewMode } from "./EditorPane";
import { MODEL_SCHEME, modelPathFor } from "../../lib/editorModel";
import { setDefinitionContext } from "../../lib/goToDefinition";
import {
  closeGroupInGroups,
  closeTabInGroups,
  moveTabInGroups,
  newGroup,
  openInGroups,
  splitGroups,
  type EditorGroup,
} from "../../lib/editorGroups";
import { readFileText, writeFileText } from "../../lib/tauri/commands";
import { onRepoFsChanged } from "../../lib/tauri/events";
import { findTheme } from "../../lib/codeThemes";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useThemeStore } from "../../state/themeStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useDebugStore, normalizePath } from "../../state/debugStore";
import type { TabDrag } from "../../state/tabDragStore";
import { confirmAction } from "../../state/confirmStore";
import { ActivePill } from "../common/ActivePill";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { useT } from "../../state/languageStore";

const TREE_MIN = 200;
const TREE_MAX = 480;
const GROUP_MAX = 2000;
/** Matches the `w-1.5` on `ResizeHandle`, which the even-split maths has to account for. */
const HANDLE_WIDTH = 6;
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
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  /** Every open file, once, however many groups are showing it. */
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [groups, setGroups] = useState<EditorGroup[]>(() => [newGroup()]);
  const [activeGroupId, setActiveGroupId] = useState<string>(() => groups[0].id);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidePanel, setSidePanel] = useState<"files" | "search" | "anchors" | "debug">("files");
  /** The snapshot being composed, or `null` when the dialog is closed. */
  const [codeSnap, setCodeSnap] = useState<CodeSnapTarget | null>(null);
  /** Which group should jump where. Scoped to a group because "go to this search hit" means the
   * pane the user is working in, not every pane that happens to have the file open. */
  const [reveal, setReveal] = useState<{ groupId: string; request: RevealRequest } | null>(null);
  const revealNonce = useRef(0);
  /** Width of every group but the last, which flexes. Session-only: a split is a transient
   * arrangement, not a setting. */
  const [groupWidths, setGroupWidths] = useState<number[]>([]);
  const groupsRowRef = useRef<HTMLDivElement>(null);
  /** The focused pane's "capture a snapshot" function, re-registered whenever focus moves, so
   * the keyboard shortcut reaches the group the user is looking at even from outside the code. */
  const captureRef = useRef<(() => void) | null>(null);

  // Assigned during render, not in an effect: the callbacks below read them to decide what to do
  // *now*, and a ref that lagged a render would act on the previous tab or group.
  const tabsRef = useRef<OpenTab[]>(tabs);
  tabsRef.current = tabs;
  const groupsRef = useRef<EditorGroup[]>(groups);
  groupsRef.current = groups;
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;

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
  const splitGroup = useCallback((groupId?: string) => {
    const outcome = splitGroups(groupsRef.current, groupId ?? activeGroupIdRef.current);
    if (!outcome) return;
    setGroups(outcome.groups);
    setActiveGroupId(outcome.focusId);
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        const current = groupsRef.current.find((g) => g.id === activeGroupIdRef.current)?.activePath;
        if (current) void save(current);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  // Tab shortcuts are gated on the Editor tab actually being the visible view — this panel
  // stays mounted in the background once opened, and Ctrl+W closing an invisible file while
  // the user is reading the graph would be baffling. They act on the focused group.
  useEffect(() => {
    if (activeView !== "editor") return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const group = groupsRef.current.find((g) => g.id === activeGroupIdRef.current);
      if (!group) return;
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (group.activePath) void closeTab(group.id, group.activePath);
        return;
      }
      if (e.key === "PageDown" || e.key === "PageUp") {
        if (group.paths.length < 2 || !group.activePath) return;
        e.preventDefault();
        const index = group.paths.indexOf(group.activePath);
        const delta = e.key === "PageDown" ? 1 : -1;
        const target = group.paths[(index + delta + group.paths.length) % group.paths.length];
        setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, activePath: target } : g)));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, closeTab]);

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

  // Editor-wide shortcuts, gated on the Editor being the visible view (this panel stays mounted
  // in the background once opened).
  useEffect(() => {
    if (activeView !== "editor") return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "p" && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (key === "f" && e.shiftKey) {
        e.preventDefault();
        setSidePanel("search");
      } else if (key === "m" && e.shiftKey) {
        e.preventDefault();
        setSidePanel("anchors");
      } else if (key === "\\") {
        // VS Code's own split binding, so muscle memory carries over.
        e.preventDefault();
        splitGroup();
      } else if (key === "c" && e.shiftKey) {
        // Monaco's own binding covers the case where the caret is in the code; this one makes
        // the shortcut work from anywhere in the Editor tab, including preview-only mode where
        // there is no editor instance to have registered it.
        e.preventDefault();
        captureRef.current?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, splitGroup]);

  const registerCapture = useCallback((capture: () => void) => {
    captureRef.current = capture;
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
      // Always available — VS Code lets you keep splitting, and each press splits *this* group
      // rather than whichever one happens to hold focus.
      onSplit={group.activePath ? () => splitGroup(group.id) : null}
      onCloseGroup={groups.length > 1 ? () => closeGroup(group.id) : null}
    />
  );

  return (
    // No header strip: the project and branch it used to repeat are already in the status bar,
    // and the row it occupied is worth more as editor.
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 gap-1.5 p-2">
        {/* Activity rail: the panel toggles up top, one-shot actions pinned to the bottom the
            way an editor keeps its settings gear there. */}
        <div className="flex w-9 shrink-0 flex-col items-center gap-1 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] py-1.5 shadow-[var(--cf-shadow)]">
          {(
            [
              { id: "files", icon: Files, label: t("editor.explorer"), hint: "" },
              { id: "search", icon: Search, label: t("editor.searchInProject"), hint: " (Ctrl+Shift+F)" },
              { id: "anchors", icon: Tags, label: t("anchors.title"), hint: " (Ctrl+Shift+M)" },
              { id: "debug", icon: Bug, label: t("debug.title"), hint: "" },
            ] as const
          ).map(({ id, icon: Icon, label, hint }) => (
            <button
              key={id}
              onClick={() => setSidePanel(id)}
              title={`${label}${hint}`}
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
          {/* Go to file lives here rather than in a strip of its own: it's an action, not a
              panel, and it has to be reachable with no file open — which the tab bar isn't. */}
          <button
            onClick={() => setPaletteOpen(true)}
            title={`${t("editor.goToFile")} (Ctrl+P)`}
            aria-label={t("editor.goToFile")}
            className="mt-auto flex h-7 w-7 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <FileSearch size={15} />
          </button>
          <button
            onClick={() => useUiStore.getState().toggleShortcutsModal()}
            title={t("shortcuts.title")}
            aria-label={t("shortcuts.title")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <Keyboard size={15} />
          </button>
        </div>
        <div
          style={{ width: treeWidth }}
          // The tree owns its own scroll area now (below its toolbar), so this wrapper only
          // clips — scrolling it too would carry the toolbar out of view.
          className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
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
      </div>
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
