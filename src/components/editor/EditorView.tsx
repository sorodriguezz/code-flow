import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS, IRange } from "monaco-editor";
import {
  ChevronRight,
  Code2,
  Columns2,
  Eye,
  Bug,
  FileCode,
  FileSearch,
  Files,
  Keyboard,
  Loader2,
  Save,
  Search,
} from "lucide-react";
import { FileTree } from "./FileTree";
import { MarkdownPreview } from "./MarkdownPreview";
import { DbmlDiagram } from "./DbmlDiagram";
import { EditorTabs, type EditorTabItem } from "./EditorTabs";
import { FilePalette } from "./FilePalette";
import { SearchPanel } from "./SearchPanel";
import { InlineEditWidget } from "./InlineEditWidget";
import { DebugPanel } from "./DebugPanel";
import { readFileText, writeFileText } from "../../lib/tauri/commands";
import { onRepoFsChanged } from "../../lib/tauri/events";
import { languageForPath } from "../../lib/monacoLanguage";
import { fileIconFor } from "../../lib/fileIcon";
import { parseDbml } from "../../lib/dbml";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useThemeStore } from "../../state/themeStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useDebugStore, normalizePath } from "../../state/debugStore";
import { confirmAction } from "../../state/confirmStore";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { BouncingDots } from "../common/BouncingDots";
import { useT } from "../../state/languageStore";
import type { FileDiffInfo, Project } from "../../types/domain";

const TREE_MIN = 200;
const TREE_MAX = 480;
const MODEL_SCHEME = "cf-editor";

type PreviewKind = "markdown" | "dbml" | null;
type ViewMode = "code" | "preview" | "split";

interface OpenTab {
  path: string;
  content: string;
  originalContent: string;
  loading: boolean;
  viewMode: ViewMode;
  /** Ephemeral tab: opened by a single click in the tree and reused by the next single
   * click, so browsing a repo doesn't leave a trail of tabs behind. Editing it, or
   * double-clicking either the file or the tab, makes it permanent. */
  preview: boolean;
}

/** One Monaco model per open file (instead of one shared model whose text gets swapped)
 * so each tab keeps its own undo history, cursor and scroll position. Namespaced by
 * project so two repos with a `src/main.ts` never collide on the same model. */
function modelPathFor(project: Project, relPath: string): string {
  return `${MODEL_SCHEME}:/${encodeURIComponent(project.id)}/${encodeURIComponent(relPath)}`;
}

function previewKindFor(path: string | null): PreviewKind {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".dbml")) return "dbml";
  return null;
}

function resolveCssColor(varName: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

/** Groups a file diff's added/current lines (origin "+", which for a modified line is its
 * *new* content — exactly what the editor is currently showing) into contiguous ranges, so
 * a 40-line block of changes becomes one decoration instead of 40. */
function changedLineRanges(fileDiff: FileDiffInfo | undefined): { start: number; end: number }[] {
  if (!fileDiff) return [];
  const lines: number[] = [];
  for (const hunk of fileDiff.hunks) {
    for (const line of hunk.lines) {
      if (line.origin === "+" && line.new_lineno) lines.push(line.new_lineno);
    }
  }
  lines.sort((a, b) => a - b);
  const ranges: { start: number; end: number }[] = [];
  for (const n of lines) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.end + 1) last.end = n;
    else ranges.push({ start: n, end: n });
  }
  return ranges;
}

/** VS Code-style path bar under the tabs: the folders leading to the open file, then the
 * file itself in its language color. */
function Breadcrumb({ path, dirty, loading }: { path: string; dirty: boolean; loading: boolean }) {
  const segments = path.split("/");
  const name = segments.pop()!;
  const { Icon, color } = fileIconFor(path);
  return (
    <div className="flex h-6 shrink-0 items-center gap-0.5 overflow-hidden border-b border-[var(--cf-border)] px-3 text-[11px] text-[var(--cf-text-muted)]">
      {segments.map((segment, i) => (
        <span key={`${segment}-${i}`} className="flex shrink-0 items-center gap-0.5">
          <span className="truncate">{segment}</span>
          <ChevronRight size={11} className="opacity-60" />
        </span>
      ))}
      <Icon size={11} className="mr-1 shrink-0" style={{ color }} />
      <span className="truncate text-[var(--cf-text)]">{name}</span>
      {dirty && <span className="ml-1 shrink-0 text-[var(--cf-warning)]">•</span>}
      {loading && <Loader2 size={11} className="ml-1 shrink-0 animate-spin" />}
    </div>
  );
}

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
  const workingDiff = useRepoStore((s) => s.workingDiff);
  const stagedDiff = useRepoStore((s) => s.stagedDiff);
  const activeView = useUiStore((s) => s.activeView);
  const pendingEditorPath = useUiStore((s) => s.pendingEditorPath);
  const pendingEditorLine = useUiStore((s) => s.pendingEditorLine);
  const clearPendingEditorPath = useUiStore((s) => s.clearPendingEditorPath);
  const treeWidth = useLayoutStore((s) => s.sizes.editorTreeWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidePanel, setSidePanel] = useState<"files" | "search" | "debug">("files");
  /** The selection Ctrl+I was pressed on, captured at that moment: the widget's own input steals
   * focus, and Monaco's selection is gone by the time the instruction is submitted. */
  const [inlineEdit, setInlineEdit] = useState<{
    selection: string;
    range: IRange;
  } | null>(null);
  /** A line to reveal once the file is open and Monaco has mounted — set by a search hit. */
  const pendingRevealRef = useRef<{ path: string; line: number } | null>(null);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // Decoration ids are per *model*, so they have to be tracked per open file — reusing one
  // list across tabs would try to replace ids that belong to another tab's model.
  const decorationIdsRef = useRef<Map<string, string[]>>(new Map());
  const tabsRef = useRef<OpenTab[]>([]);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSyncGuardRef = useRef<"editor" | "preview" | null>(null);
  // Bumped every time a Monaco instance actually finishes mounting — the code panel remounts
  // Monaco whenever it toggles away and back (preview-only mode), which would otherwise leave
  // effects keyed on `[ranges]`/`[viewMode]` alone reading a stale/disposed `editorRef.current`
  // if they happened to fire before the new instance was ready.
  const [editorReady, setEditorReady] = useState(0);

  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [tabs, activePath]);
  const content = activeTab?.content ?? "";
  const dirty = activeTab ? activeTab.content !== activeTab.originalContent : false;
  const viewMode = activeTab?.viewMode ?? "code";

  // `useT()` hands back a fresh function every render; callbacks that only need it to
  // build a message read it through this ref instead of taking it as a dependency and
  // re-identifying (and re-subscribing their listeners) on every keystroke.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeAbsolutePath = useMemo(
    () => (project && activePath ? normalizePath(`${project.local_path}/${activePath}`) : null),
    [project, activePath],
  );
  const breakpoints = useDebugStore((s) => s.breakpoints);
  // Monaco's mouse handler is registered once, at mount; a ref is how it sees the *current*
  // file rather than whichever one was open when it was wired up.
  const activeAbsolutePathRef = useRef<string | null>(null);
  activeAbsolutePathRef.current = activeAbsolutePath;
  const debugStatus = useDebugStore((s) => s.status);
  const pausedFrame = useDebugStore((s) => (s.status === "paused" ? s.frames[s.selectedFrame] : undefined));

  const previewKind = previewKindFor(activePath);
  const dbmlSchema = useMemo(() => (previewKind === "dbml" ? parseDbml(content) : null), [previewKind, content]);

  const patchTab = useCallback((path: string, patch: Partial<OpenTab>) => {
    setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)));
  }, []);

  // Same "unstaged wins, else staged" priority as the file tree's own indicator, so the
  // gutter/minimap markers always match whatever status letter that file is showing there.
  const fileDiff = useMemo(() => {
    if (!activePath) return undefined;
    return (
      workingDiff.find((f) => (f.new_path ?? f.old_path) === activePath) ??
      stagedDiff.find((f) => (f.new_path ?? f.old_path) === activePath)
    );
  }, [activePath, workingDiff, stagedDiff]);

  const ranges = useMemo(() => changedLineRanges(fileDiff), [fileDiff]);

  // Marks changed lines directly on Monaco's own minimap + overview ruler + gutter, rather
  // than a bespoke strip — this *is* the "code map" the Changes tab has, just reused where
  // Monaco already renders one.
  const applyDecorations = useCallback(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    // A disposed editor (Monaco unmounted for preview-only mode, or between tab closes)
    // reports no model — bail instead of poking at its internals.
    if (!ed || !mon || !activePath || !ed.getModel()) return;
    const color = resolveCssColor("--cf-success", "#22c55e");
    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = ranges.map((r) => ({
      range: new mon.Range(r.start, 1, r.end, 1),
      options: {
        isWholeLine: true,
        className: "cf-editor-changed-line",
        linesDecorationsClassName: "cf-editor-changed-gutter",
        minimap: { color, position: mon.editor.MinimapPosition.Inline },
        overviewRuler: { color, position: mon.editor.OverviewRulerLane.Left },
      },
    }));
    const previous = decorationIdsRef.current.get(activePath) ?? [];
    decorationIdsRef.current.set(activePath, ed.deltaDecorations(previous, decorations));
  }, [ranges, activePath]);

  // Breakpoints and the stopped line are their own decoration set: they change on a completely
  // different rhythm from the git markers, and mixing them would make each update clobber the
  // other's ids.
  const debugDecorationsRef = useRef<string[]>([]);
  useEffect(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon || !ed.getModel()) return;
    const lines = activeAbsolutePath ? (breakpoints[activeAbsolutePath] ?? []) : [];
    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = lines.map((line) => ({
      range: new mon.Range(line, 1, line, 1),
      options: { isWholeLine: false, glyphMarginClassName: "cf-breakpoint-glyph" },
    }));
    // Only when the *selected* frame is this file: stepping through a call shows where you are,
    // not a stale highlight in a file you happen to have open.
    const pausedHere =
      pausedFrame && activeAbsolutePath && normalizePath(pausedFrame.file) === activeAbsolutePath;
    if (pausedHere && pausedFrame) {
      decorations.push({
        range: new mon.Range(pausedFrame.line, 1, pausedFrame.line, 1),
        options: {
          isWholeLine: true,
          className: "cf-debug-current-line",
          glyphMarginClassName: "cf-debug-current-glyph",
        },
      });
    }
    debugDecorationsRef.current = ed.deltaDecorations(debugDecorationsRef.current, decorations);
  }, [breakpoints, activeAbsolutePath, pausedFrame, editorReady, activeTab?.loading]);

  const handleMount: OnMount = (editorInstance, monacoInstance) => {
    editorRef.current = editorInstance;
    monacoRef.current = monacoInstance;
    // Ctrl+I is registered on the editor rather than on `window` so it only ever fires with the
    // caret in the code — and so Monaco's own keybinding service swallows it before the browser
    // or another panel sees it.
    editorInstance.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyI, () => {
      const model = editorInstance.getModel();
      const selection = editorInstance.getSelection();
      if (!model || !selection) return;
      // With nothing selected, the current line is the implied target — asking someone to select
      // a line before rewriting it is a step the editor can take for them.
      const range = selection.isEmpty()
        ? new monacoInstance.Range(
            selection.startLineNumber,
            1,
            selection.startLineNumber,
            model.getLineMaxColumn(selection.startLineNumber),
          )
        : selection;
      const text = model.getValueInRange(range);
      if (!text.trim()) return;
      setInlineEdit({ selection: text, range });
    });
    // Clicking the gutter toggles a breakpoint — the only way anyone expects to set one.
    editorInstance.onMouseDown((event) => {
      if (event.target.type !== monacoInstance.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      const path = activeAbsolutePathRef.current;
      if (line && path) useDebugStore.getState().toggleBreakpoint(path, line);
    });
    applyDecorations();
    setEditorReady((n) => n + 1);
  };

  /** Applies an AI rewrite through Monaco's edit stack, so it joins the undo history and shows
   * up as an ordinary unsaved change instead of appearing from nowhere. */
  const applyInlineEdit = useCallback(
    (replacement: string) => {
      const ed = editorRef.current;
      const target = inlineEdit;
      if (!ed || !target || !ed.getModel()) return;
      ed.executeEdits("cf-inline-edit", [{ range: target.range, text: replacement, forceMoveMarkers: true }]);
      ed.pushUndoStop();
      ed.focus();
    },
    [inlineEdit],
  );

  // Re-applies decorations when the diff/theme changes, and when the active tab changes
  // (each tab has its own model, so the new one starts undecorated).
  useEffect(() => {
    applyDecorations();
  }, [applyDecorations, resolved, editorReady]);

  const openFile = useCallback(
    async (path: string, opts?: { pin?: boolean }) => {
      if (!project) return;
      const pin = opts?.pin ?? false;
      const existing = tabs.find((tab) => tab.path === path);
      if (existing) {
        if (pin && existing.preview) patchTab(path, { preview: false });
        setActivePath(path);
        return;
      }

      const fresh: OpenTab = {
        path,
        content: "",
        originalContent: "",
        loading: true,
        viewMode: "code",
        preview: !pin,
      };
      setTabs((prev) => {
        // A new preview open takes over the existing preview tab's slot instead of adding
        // one, which is what keeps click-through-the-tree from flooding the strip.
        const previewIndex = pin ? -1 : prev.findIndex((tab) => tab.preview);
        if (previewIndex < 0) return [...prev, fresh];
        const next = [...prev];
        next[previewIndex] = fresh;
        return next;
      });
      setActivePath(path);

      try {
        const text = await readFileText(project.local_path, path);
        patchTab(path, { content: text, originalContent: text, loading: false });
      } catch (e) {
        const message = tRef.current("editor.failedToOpen", { error: String(e) });
        patchTab(path, { content: message, originalContent: message, loading: false });
      }
    },
    [project, tabs, patchTab],
  );

  const closeTab = useCallback(async (path: string) => {
    const tab = tabsRef.current.find((item) => item.path === path);
    if (!tab) return;
    if (tab.content !== tab.originalContent) {
      const ok = await confirmAction(
        tRef.current("editor.closeDirtyConfirm", { name: path.split("/").pop() ?? path }),
        true,
      );
      if (!ok) return;
    }
    // Re-read after the (awaited) confirm — the tab list can have moved on while the
    // modal was up.
    const current = tabsRef.current;
    const index = current.findIndex((item) => item.path === path);
    if (index < 0) return;
    const next = current.filter((item) => item.path !== path);
    decorationIdsRef.current.delete(path);
    setTabs(next);
    // Falls back to the tab that slid into the closed one's slot, then to its left
    // neighbour — the same "keep looking at something adjacent" rule editors use.
    setActivePath((prev) => (prev === path ? ((next[index] ?? next[index - 1])?.path ?? null) : prev));
  }, []);

  const reorderTabs = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const tabItems = useMemo<EditorTabItem[]>(
    () =>
      tabs.map((tab) => ({
        path: tab.path,
        dirty: tab.content !== tab.originalContent,
        preview: tab.preview,
      })),
    [tabs],
  );

  const save = useCallback(async () => {
    if (!project || !activeTab || activeTab.content === activeTab.originalContent) return;
    const { path, content: text } = activeTab;
    setSaving(true);
    try {
      await writeFileText(project.local_path, path, text);
      setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, originalContent: text } : tab)));
      // The Changes tab (and any conflict-resolution flow) reads git status from
      // repoStore, which has no way to know a file changed on disk outside of a git
      // command — refresh it explicitly so a save here shows up immediately there.
      void useRepoStore.getState().refreshStatus();
    } finally {
      setSaving(false);
    }
  }, [project, activeTab]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  // Tab shortcuts are gated on the Editor tab actually being the visible view — this panel
  // stays mounted in the background once opened, and Ctrl+W closing an invisible file while
  // the user is reading the graph would be baffling.
  useEffect(() => {
    if (activeView !== "editor") return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const current = tabsRef.current;
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (activePath) void closeTab(activePath);
        return;
      }
      if (e.key === "PageDown" || e.key === "PageUp") {
        if (current.length < 2 || !activePath) return;
        e.preventDefault();
        const index = current.findIndex((tab) => tab.path === activePath);
        const delta = e.key === "PageDown" ? 1 : -1;
        const target = current[(index + delta + current.length) % current.length];
        setActivePath(target.path);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, activePath, closeTab]);

  // Otherwise switching projects leaves the previous repo's files open — everything else
  // (branch, file tree, status) points at the new repo. Done during render rather than in
  // an effect so the editor never paints one repo's tabs against another's tree.
  const [lastProjectPath, setLastProjectPath] = useState<string | null>(project?.local_path ?? null);
  if ((project?.local_path ?? null) !== lastProjectPath) {
    setLastProjectPath(project?.local_path ?? null);
    setTabs([]);
    setActivePath(null);
    decorationIdsRef.current.clear();
  }

  // Models outlive the editor (see `keepCurrentModel` below), so closing a tab has to
  // dispose its model explicitly or every file ever opened stays in memory. Runs after the
  // commit that already switched Monaco to the surviving tab, so the model being disposed
  // is never the attached one.
  // Keyed on *which* files are open rather than on `tabs` itself, so the model registry
  // isn't swept on every keystroke. Newline is the one character a path can't contain.
  const openPathsKey = tabs.map((tab) => tab.path).join("\n");
  useEffect(() => {
    const mon = monacoRef.current;
    if (!mon || !project) return;
    // Both sides go through `Uri.parse().toString()` so the comparison is against Monaco's
    // own normalization of the path rather than the raw string we handed it.
    const open = new Set(
      tabsRef.current.map((tab) => mon.Uri.parse(modelPathFor(project, tab.path)).toString()),
    );
    for (const model of mon.editor.getModels()) {
      if (model.uri.scheme === MODEL_SCHEME && !open.has(model.uri.toString())) model.dispose();
    }
  }, [openPathsKey, project]);

  // Split view: keep the Monaco pane and the rendered preview pane scrolling together,
  // proportionally (their line heights don't correspond 1:1, so this syncs by scroll ratio
  // rather than by line number). Re-attaches whenever Monaco (re)mounts.
  useEffect(() => {
    if (viewMode !== "split") return;
    const ed = editorRef.current;
    const previewEl = previewScrollRef.current;
    if (!ed || !previewEl) return;

    const fromEditor = () => {
      if (scrollSyncGuardRef.current === "preview") {
        scrollSyncGuardRef.current = null;
        return;
      }
      const denom = ed.getScrollHeight() - ed.getLayoutInfo().height;
      const ratio = denom > 0 ? ed.getScrollTop() / denom : 0;
      scrollSyncGuardRef.current = "editor";
      previewEl.scrollTop = ratio * (previewEl.scrollHeight - previewEl.clientHeight);
    };
    const fromPreview = () => {
      if (scrollSyncGuardRef.current === "editor") {
        scrollSyncGuardRef.current = null;
        return;
      }
      const denom = previewEl.scrollHeight - previewEl.clientHeight;
      const ratio = denom > 0 ? previewEl.scrollTop / denom : 0;
      const editorDenom = ed.getScrollHeight() - ed.getLayoutInfo().height;
      scrollSyncGuardRef.current = "preview";
      ed.setScrollTop(ratio * editorDenom);
    };

    const disposable = ed.onDidScrollChange(fromEditor);
    previewEl.addEventListener("scroll", fromPreview);
    return () => {
      disposable.dispose();
      previewEl.removeEventListener("scroll", fromPreview);
    };
  }, [viewMode, activePath, editorReady]);

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

  useEffect(() => {
    if (pendingEditorPath) {
      // An explicit "open this file" from elsewhere in the app is a deliberate navigation,
      // not a peek, so it gets a permanent tab rather than the preview slot.
      if (pendingEditorLine) pendingRevealRef.current = { path: pendingEditorPath, line: pendingEditorLine };
      void openFile(pendingEditorPath, { pin: true });
      clearPendingEditorPath();
    }
  }, [pendingEditorPath, pendingEditorLine, openFile, clearPendingEditorPath]);

  // Jumping to a search hit can't reveal the line until the file has finished loading *and*
  // Monaco has (re)mounted on it, which is several renders after the click — so the request is
  // parked in a ref and consumed by whichever pass first has an editor able to honour it.
  useEffect(() => {
    const target = pendingRevealRef.current;
    const ed = editorRef.current;
    if (!target || !ed || target.path !== activePath || activeTab?.loading || !ed.getModel()) return;
    pendingRevealRef.current = null;
    ed.revealLineInCenter(target.line);
    ed.setPosition({ lineNumber: target.line, column: 1 });
    ed.focus();
  }, [activePath, activeTab?.loading, editorReady]);

  const openHit = useCallback(
    (path: string, line: number) => {
      pendingRevealRef.current = { path, line };
      void openFile(path, { pin: true });
    },
    [openFile],
  );

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
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView]);

  if (!project) {
    return <EmptyState icon={FileCode} title={t("editor.noProject")} />;
  }

  // Deliberately not rendered until the file's text has arrived: Monaco would otherwise
  // create the model empty and the subsequent fill would land in the undo stack, one
  // Ctrl+Z away from blanking the file.
  const editorPane = activeTab && !activeTab.loading ? (
    <Editor
      height="100%"
      path={modelPathFor(project, activeTab.path)}
      language={languageForPath(activeTab.path)}
      value={content}
      theme={monacoTheme}
      // Each tab keeps its own model, so Monaco must not throw it away when this component
      // unmounts (preview-only mode) — tab closing is what disposes models here.
      keepCurrentModel
      onChange={(value) => {
        if (!activeTab) return;
        // Typing in a preview tab promotes it to a permanent one, exactly like VS Code.
        patchTab(activeTab.path, { content: value ?? "", preview: false });
      }}
      onMount={handleMount}
      options={{
        minimap: { enabled: true },
        fontSize: 13,
        automaticLayout: true,
        // Without a glyph margin there is nowhere to click for a breakpoint, and nowhere to
        // draw one.
        glyphMargin: true,
      }}
    />
  ) : null;

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
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
              }`}
            >
              <Icon size={15} />
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
          {/* Explorer, find-in-project or the debugger — same column VS Code uses for all three,
              since each of them wants the width more than a file tree does. */}
          {sidePanel === "search" ? (
            <SearchPanel
              repoPath={project.local_path}
              onOpenHit={openHit}
              onClose={() => setSidePanel("files")}
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
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]">
          {activeTab ? (
            <>
              <EditorTabs
                tabs={tabItems}
                activePath={activePath}
                onSelect={setActivePath}
                onClose={(path) => void closeTab(path)}
                onPin={(path) => patchTab(path, { preview: false })}
                onReorder={reorderTabs}
                actions={
                  <>
                    {previewKind && (
                      <div className="flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] p-0.5">
                        <button
                          onClick={() => patchTab(activeTab.path, { viewMode: "code" })}
                          title={t("editor.viewCode")}
                          className={`flex h-5 w-5 items-center justify-center rounded ${
                            viewMode === "code"
                              ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                              : "text-[var(--cf-text-muted)]"
                          }`}
                        >
                          <Code2 size={12} />
                        </button>
                        <button
                          onClick={() => patchTab(activeTab.path, { viewMode: "split" })}
                          title={t("editor.viewSplit")}
                          className={`flex h-5 w-5 items-center justify-center rounded ${
                            viewMode === "split"
                              ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                              : "text-[var(--cf-text-muted)]"
                          }`}
                        >
                          <Columns2 size={12} />
                        </button>
                        <button
                          onClick={() => patchTab(activeTab.path, { viewMode: "preview" })}
                          title={t("editor.viewPreview")}
                          className={`flex h-5 w-5 items-center justify-center rounded ${
                            viewMode === "preview"
                              ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                              : "text-[var(--cf-text-muted)]"
                          }`}
                        >
                          <Eye size={12} />
                        </button>
                      </div>
                    )}
                    <button
                      onClick={save}
                      disabled={!dirty || saving}
                      className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-0.5 text-[12px] text-white disabled:opacity-40"
                    >
                      {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                      {t("editor.save")}
                    </button>
                  </>
                }
              />
              <Breadcrumb path={activeTab.path} dirty={dirty} loading={activeTab.loading} />
              {/* `relative` anchors the inline-edit widget over the code, the way an editor
                  floats its own peek widgets. */}
              <div className="relative min-h-0 flex-1">
                {activeTab.loading ? (
                  <div className="flex h-full items-center justify-center">
                    <BouncingDots />
                  </div>
                ) : viewMode === "preview" ? (
                  previewKind === "markdown" ? (
                    <MarkdownPreview content={content} />
                  ) : (
                    <DbmlDiagram schema={dbmlSchema!} />
                  )
                ) : viewMode === "split" ? (
                  <div className="flex h-full">
                    <div className="min-w-0 flex-1 border-r border-[var(--cf-border)]">{editorPane}</div>
                    <div className="min-w-0 flex-1">
                      {previewKind === "markdown" ? (
                        <MarkdownPreview content={content} ref={previewScrollRef} />
                      ) : (
                        <DbmlDiagram schema={dbmlSchema!} ref={previewScrollRef} />
                      )}
                    </div>
                  </div>
                ) : (
                  editorPane
                )}
                {inlineEdit && activeTab && (
                  <InlineEditWidget
                    filePath={activeTab.path}
                    fileContent={content}
                    selection={inlineEdit.selection}
                    onApply={applyInlineEdit}
                    onClose={() => setInlineEdit(null)}
                  />
                )}
              </div>
            </>
          ) : (
            <EmptyState icon={FileCode} title={t("editor.selectFile")} subtitle={t("editor.selectFileHint")} />
          )}
        </div>
      </div>
      {paletteOpen && (
        <FilePalette
          repoPath={project.local_path}
          onPick={(path) => void openFile(path, { pin: true })}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}
