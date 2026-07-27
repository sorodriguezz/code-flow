import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS, IRange } from "monaco-editor";
import {
  Camera,
  ChevronRight,
  Code2,
  Columns2,
  Eye,
  FileCode,
  Loader2,
  Save,
  SplitSquareHorizontal,
  X,
} from "lucide-react";
import { MarkdownPreview } from "./MarkdownPreview";
import { DbmlDiagram } from "./DbmlDiagram";
import { EditorTabs, type EditorTabItem } from "./EditorTabs";
import { InlineEditWidget } from "./InlineEditWidget";
import type { CodeSnapTarget } from "./CodeSnapModal";
import { languageForPath } from "../../lib/monacoLanguage";
import { fileIconFor } from "../../lib/fileIcon";
import { parseDbml } from "../../lib/dbml";
import { anchorColor, anchorTagClass, parseAnchors } from "../../lib/anchors";
import { useDebugStore, normalizePath } from "../../state/debugStore";
import { useTabDragStore, type TabDrag } from "../../state/tabDragStore";
import { useT } from "../../state/languageStore";
import { BouncingDots } from "../common/BouncingDots";
import { EmptyState } from "../common/EmptyState";
import type { FileDiffInfo, Project } from "../../types/domain";

const MODEL_SCHEME = "cf-editor";

export type PreviewKind = "markdown" | "dbml" | null;
export type ViewMode = "code" | "preview" | "split";

/** One open file, shared by every group showing it — content, dirtiness and load state belong to
 * the *file*, not to the pane looking at it, which is why splitting a file into two groups gives
 * two views of one buffer rather than two copies of it. */
export interface OpenTab {
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

/** A jump requested from outside the editor — a search hit, an anchor, a stack frame. Carries a
 * `nonce` so asking for the *same* position twice still fires: the second request is a real
 * user action, not a re-render. */
export interface RevealRequest {
  path: string;
  line: number;
  column?: number;
  nonce: number;
}

/** One Monaco model per open file (instead of one shared model whose text gets swapped)
 * so each tab keeps its own undo history, cursor and scroll position. Namespaced by
 * project so two repos with a `src/main.ts` never collide on the same model.
 *
 * Two groups showing the same file resolve to the same URI on purpose — that is what makes an
 * edit on the left appear on the right, exactly like VS Code. */
export function modelPathFor(project: Project, relPath: string): string {
  return `${MODEL_SCHEME}:/${encodeURIComponent(project.id)}/${encodeURIComponent(relPath)}`;
}

export function previewKindFor(path: string | null): PreviewKind {
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

/**
 * One editor group: a tab strip, a breadcrumb and a Monaco instance, with everything that has to
 * be per-instance living here — decorations, the inline-edit widget, cursor and scroll.
 *
 * Split out of `EditorView` precisely so there can be more than one. The parent owns the *files*
 * (their text, dirtiness, load state) and this owns the *view* of them, which is the split that
 * makes two groups showing one file share a buffer instead of diverging.
 */
export function EditorPane({
  groupId,
  project,
  tabs,
  activePath,
  focused,
  monacoTheme,
  themeMode,
  fileDiffFor,
  saving,
  reveal,
  onRevealDone,
  onFocus,
  onSelect,
  onClose,
  onPin,
  onDropTab,
  onChange,
  onViewMode,
  onSave,
  onCodeSnap,
  registerCapture,
  onSplit,
  onCloseGroup,
}: {
  groupId: string;
  project: Project;
  tabs: OpenTab[];
  activePath: string | null;
  /** The group with focus — drives the highlight and which pane app-level shortcuts act on. */
  focused: boolean;
  monacoTheme: string;
  /** Only a signal that CSS variables were repainted, so colour-reading decorations re-resolve. */
  themeMode: "light" | "dark";
  fileDiffFor: (path: string) => FileDiffInfo | undefined;
  saving: boolean;
  reveal: RevealRequest | null;
  onRevealDone: () => void;
  onFocus: () => void;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onPin: (path: string) => void;
  /** A tab was dropped somewhere — passed straight through to the strip, which owns the gesture
   * and therefore knows which group the drop landed in. */
  onDropTab: (payload: TabDrag, targetGroupId: string, targetIndex: number) => void;
  onChange: (path: string, value: string) => void;
  onViewMode: (path: string, mode: ViewMode) => void;
  onSave: () => void;
  onCodeSnap: (target: CodeSnapTarget) => void;
  /** Hands the parent a way to trigger this pane's snapshot capture, so the shortcut works even
   * when focus is somewhere else in the Editor tab. */
  registerCapture: (capture: () => void) => void;
  /** `null` hides the split button — there's already a second group. */
  onSplit: (() => void) | null;
  /** `null` for the only group; a group you can't close is one without a close button. */
  onCloseGroup: (() => void) | null;
}) {
  const t = useT();
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // Decoration ids are per *model*, so they have to be tracked per open file — reusing one
  // list across tabs would try to replace ids that belong to another tab's model.
  const decorationIdsRef = useRef<Map<string, string[]>>(new Map());
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSyncGuardRef = useRef<"editor" | "preview" | null>(null);
  const pendingRevealRef = useRef<RevealRequest | null>(null);
  /** The selection Ctrl+I was pressed on, captured at that moment: the widget's own input steals
   * focus, and Monaco's selection is gone by the time the instruction is submitted. */
  const [inlineEdit, setInlineEdit] = useState<{ selection: string; range: IRange } | null>(null);
  // Bumped every time a Monaco instance actually finishes mounting — the code panel remounts
  // Monaco whenever it toggles away and back (preview-only mode), which would otherwise leave
  // effects keyed on `[ranges]`/`[viewMode]` alone reading a stale/disposed `editorRef.current`
  // if they happened to fire before the new instance was ready.
  const [editorReady, setEditorReady] = useState(0);

  const activeTab = useMemo(() => tabs.find((tab) => tab.path === activePath) ?? null, [tabs, activePath]);
  const content = activeTab?.content ?? "";
  const dirty = activeTab ? activeTab.content !== activeTab.originalContent : false;
  const viewMode = activeTab?.viewMode ?? "code";
  const previewKind = previewKindFor(activePath);
  const dbmlSchema = useMemo(() => (previewKind === "dbml" ? parseDbml(content) : null), [previewKind, content]);

  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  const activeAbsolutePath = useMemo(
    () => (activePath ? normalizePath(`${project.local_path}/${activePath}`) : null),
    [project.local_path, activePath],
  );
  const breakpoints = useDebugStore((s) => s.breakpoints);
  // Monaco's mouse handler is registered once, at mount; a ref is how it sees the *current*
  // file rather than whichever one was open when it was wired up.
  const activeAbsolutePathRef = useRef<string | null>(null);
  activeAbsolutePathRef.current = activeAbsolutePath;
  const pausedFrame = useDebugStore((s) => (s.status === "paused" ? s.frames[s.selectedFrame] : undefined));

  // Same "unstaged wins, else staged" priority as the file tree's own indicator, so the
  // gutter/minimap markers always match whatever status letter that file is showing there.
  const ranges = useMemo(
    () => changedLineRanges(activePath ? fileDiffFor(activePath) : undefined),
    [activePath, fileDiffFor],
  );

  // Marks changed lines directly on Monaco's own minimap + overview ruler + gutter, rather
  // than a bespoke strip — this *is* the "code map" the Changes tab has, just reused where
  // Monaco already renders one.
  useEffect(() => {
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
  }, [ranges, activePath, themeMode, editorReady]);

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
    const pausedHere = pausedFrame && activeAbsolutePath && normalizePath(pausedFrame.file) === activeAbsolutePath;
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

  // Tagged comments in the open buffer — recomputed as you type, so an anchor you just wrote is
  // navigable before the file is even saved.
  const fileAnchors = useMemo(() => parseAnchors(content), [content]);

  // A third decoration set, for the same reason the debug one is separate: anchors change on
  // every keystroke while the others don't, and one shared id list would make each update
  // clobber the rest. These deliberately colour the *tag word* rather than the gutter — the
  // margin is already carrying git change bars and breakpoints — and add a tick on the overview
  // ruler so a long file's anchors are visible without scrolling to them.
  const anchorDecorationsRef = useRef<string[]>([]);
  useEffect(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon || !ed.getModel()) return;
    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = fileAnchors.map((anchor) => {
      const color = anchorColor(anchor.tag);
      return {
        range: new mon.Range(anchor.line, anchor.column, anchor.line, anchor.column + anchor.tag.length),
        options: {
          inlineClassName: anchorTagClass(anchor.tag),
          hoverMessage: { value: anchor.text ? `**${anchor.tag}** — ${anchor.text}` : `**${anchor.tag}**` },
          overviewRuler: { color, position: mon.editor.OverviewRulerLane.Right },
          minimap: { color, position: mon.editor.MinimapPosition.Inline },
        },
      };
    });
    anchorDecorationsRef.current = ed.deltaDecorations(anchorDecorationsRef.current, decorations);
  }, [fileAnchors, activePath, editorReady, activeTab?.loading]);

  /** Captures what should end up in the image: the selection when there is one (expanded to whole
   * lines, so a snapshot never starts mid-token), otherwise the entire file. */
  const captureSnapshot = useCallback(() => {
    if (!activeTab || activeTab.loading) return;
    const ed = editorRef.current;
    const model = ed?.getModel();
    const selection = ed?.getSelection();
    const shared = { language: languageForPath(activeTab.path), path: activeTab.path };

    if (model && selection && !selection.isEmpty()) {
      const startLine = selection.startLineNumber;
      const endLine = selection.endLineNumber;
      onCodeSnap({
        ...shared,
        code: model.getValueInRange({
          startLineNumber: startLine,
          startColumn: 1,
          endLineNumber: endLine,
          endColumn: model.getLineMaxColumn(endLine),
        }),
        startLine,
        endLine,
      });
      return;
    }
    // No selection — the whole file. Read from the tab rather than the model so this also works
    // in preview-only mode, where Monaco isn't mounted at all.
    onCodeSnap({ ...shared, code: activeTab.content, startLine: 1, endLine: activeTab.content.split("\n").length });
  }, [activeTab, onCodeSnap]);

  const captureRef = useRef(captureSnapshot);
  captureRef.current = captureSnapshot;
  // Re-registered whenever focus moves here, so the parent's shortcut always reaches the group
  // the user is actually looking at.
  useEffect(() => {
    if (focused) registerCapture(() => captureRef.current());
  }, [focused, registerCapture]);

  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  const handleMount: OnMount = (editorInstance, monacoInstance) => {
    editorRef.current = editorInstance;
    monacoRef.current = monacoInstance;
    // Typing or clicking in a pane is what makes it the active group — the same "focus follows
    // the editor you touched" rule VS Code uses to decide where the next file opens.
    editorInstance.onDidFocusEditorWidget(() => onFocusRef.current());
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
    // Registered as a Monaco action rather than a plain command so it also appears in the
    // right-click menu, next to copy — which is where anyone looking for "copy this as an
    // image" will reach for it first.
    editorInstance.addAction({
      id: "cf-codesnap",
      label: tRef.current("codesnap.action"),
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 4,
      keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyC],
      run: () => captureRef.current(),
    });
    // Clicking the gutter toggles a breakpoint — the only way anyone expects to set one.
    editorInstance.onMouseDown((event) => {
      if (event.target.type !== monacoInstance.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      const path = activeAbsolutePathRef.current;
      if (line && path) useDebugStore.getState().toggleBreakpoint(path, line);
    });
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

  // Jumping to a search hit can't reveal the line until the file has finished loading *and*
  // Monaco has (re)mounted on it, which is several renders after the click — so the request is
  // parked in a ref and consumed by whichever pass first has an editor able to honour it.
  useEffect(() => {
    if (reveal) pendingRevealRef.current = reveal;
  }, [reveal]);

  useEffect(() => {
    const target = pendingRevealRef.current;
    const ed = editorRef.current;
    if (!target || !ed || target.path !== activePath || activeTab?.loading || !ed.getModel()) return;
    pendingRevealRef.current = null;
    ed.revealLineInCenter(target.line);
    ed.setPosition({ lineNumber: target.line, column: target.column ?? 1 });
    ed.focus();
    onRevealDone();
  }, [reveal, activePath, activeTab?.loading, editorReady, onRevealDone]);

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

  /** Dropping a tab on the *body* of a pane puts it in that group — VS Code's "throw it over
   * there" gesture, and the only one available when the target strip is scrolled out of reach.
   *
   * The pane is only a passive target: the strip that started the drag hit-tests against this
   * `data-` attribute (see `dropTargetAt`), so there is nothing to wire up here beyond marking
   * the box and reacting to the shared drag state. */
  const dropOver = useTabDragStore((s) => s.over);
  const dropActive = dropOver?.groupId === groupId && dropOver.zone === "body";
  const bodyDropProps = { "data-cf-panebody": groupId };

  const dropOverlay = dropActive ? (
    <div className="pointer-events-none absolute inset-1 z-20 rounded-lg border-2 border-dashed border-[var(--cf-accent)] bg-[var(--cf-accent)]/10" />
  ) : null;

  const tabItems = useMemo<EditorTabItem[]>(
    () =>
      tabs.map((tab) => ({
        path: tab.path,
        dirty: tab.content !== tab.originalContent,
        preview: tab.preview,
      })),
    [tabs],
  );

  // Deliberately not rendered until the file's text has arrived: Monaco would otherwise
  // create the model empty and the subsequent fill would land in the undo stack, one
  // Ctrl+Z away from blanking the file.
  const editorPane =
    activeTab && !activeTab.loading ? (
      <Editor
        height="100%"
        path={modelPathFor(project, activeTab.path)}
        language={languageForPath(activeTab.path)}
        value={content}
        theme={monacoTheme}
        // Each tab keeps its own model, so Monaco must not throw it away when this component
        // unmounts (preview-only mode, or this whole group closing) — tab closing is what
        // disposes models here, and only once no group is still showing the file.
        keepCurrentModel
        onChange={(value) => onChange(activeTab.path, value ?? "")}
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
    <div
      // Capture-phase, so clicking anywhere in the group — a tab, the breadcrumb, the code —
      // makes it the active one before whatever was clicked handles the event.
      onMouseDownCapture={onFocus}
      className={`flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-[var(--cf-surface)] shadow-[var(--cf-shadow)] ${
        // Only worth highlighting when there's another group to be distinguished from.
        focused && onCloseGroup ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"
      }`}
    >
      {activeTab ? (
        <>
          <EditorTabs
            groupId={groupId}
            tabs={tabItems}
            activePath={activePath}
            onSelect={onSelect}
            onClose={onClose}
            onPin={onPin}
            onDropTab={onDropTab}
            actions={
              <>
                {previewKind && (
                  <div className="flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] p-0.5">
                    {(
                      [
                        { mode: "code", icon: Code2, label: t("editor.viewCode") },
                        { mode: "split", icon: Columns2, label: t("editor.viewSplit") },
                        { mode: "preview", icon: Eye, label: t("editor.viewPreview") },
                      ] as const
                    ).map(({ mode, icon: Icon, label }) => (
                      <button
                        key={mode}
                        onClick={() => onViewMode(activeTab.path, mode)}
                        title={label}
                        className={`flex h-5 w-5 items-center justify-center rounded ${
                          viewMode === mode
                            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                            : "text-[var(--cf-text-muted)]"
                        }`}
                      >
                        <Icon size={12} />
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={captureSnapshot}
                  disabled={activeTab.loading}
                  title={`${t("codesnap.action")} (Ctrl+Shift+C)`}
                  aria-label={t("codesnap.action")}
                  className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-40 dark:hover:bg-white/[0.08]"
                >
                  <Camera size={12} />
                </button>
                {onSplit && (
                  <button
                    onClick={onSplit}
                    title={`${t("editor.splitRight")} (Ctrl+\\)`}
                    aria-label={t("editor.splitRight")}
                    className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
                  >
                    <SplitSquareHorizontal size={12} />
                  </button>
                )}
                {onCloseGroup && (
                  <button
                    onClick={onCloseGroup}
                    title={t("editor.closeGroup")}
                    aria-label={t("editor.closeGroup")}
                    className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
                  >
                    <X size={12} />
                  </button>
                )}
                <button
                  onClick={onSave}
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
          <div className="relative min-h-0 flex-1" {...bodyDropProps}>
            {dropOverlay}
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
            {inlineEdit && (
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
        // An emptied group is still a drop target — otherwise the only way to refill it would be
        // to open a file, and dragging one over is the obvious gesture. Plain block, *not* a flex
        // row: `EmptyState` centres itself inside whatever box it's given, so as a row child it
        // would shrink to its text and sit against the left edge instead of the middle.
        <div className="relative min-h-0 flex-1" {...bodyDropProps}>
          {dropOverlay}
          <EmptyState icon={FileCode} title={t("editor.selectFile")} subtitle={t("editor.selectFileHint")} />
        </div>
      )}
    </div>
  );
}
