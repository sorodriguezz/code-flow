import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor, type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS, IRange } from "monaco-editor";
import {
  Camera,
  ChevronRight,
  Code2,
  Columns2,
  Eye,
  FileCode,
  GitCompare,
  Loader2,
  Save,
  SplitSquareHorizontal,
  X,
} from "lucide-react";
import { MarkdownPreview } from "./MarkdownPreview";
import { DbmlDiagram } from "./DbmlDiagram";
import { EditorTabs, type EditorTabItem, type TabMenuActions } from "./EditorTabs";
import { InlineEditWidget } from "./InlineEditWidget";
import type { CodeSnapTarget } from "./CodeSnapModal";
import { modelPathFor } from "../../lib/editorModel";
import { languageForPath } from "../../lib/monacoLanguage";
import { FileGlyph } from "../common/FileGlyph";
import type { DbmlSchema } from "../../lib/dbml";
import { reconstructSides } from "../../lib/diffText";
import { getFileDiff } from "../../lib/tauri/commands";
import { anchorColor, anchorTagClass, parseAnchors } from "../../lib/anchors";
import { useDebugStore, normalizePath } from "../../state/debugStore";
import { useBookmarkStore } from "../../state/bookmarkStore";
import { useTabDragStore, type TabDrag } from "../../state/tabDragStore";
import { useT } from "../../state/languageStore";
import { useShortcutHint } from "../../lib/useShortcutHint";
import { installEditorShortcuts } from "../../lib/editorKeybindings";
import { useShortcutsStore } from "../../state/shortcutsStore";
import { BouncingDots } from "../common/BouncingDots";
import { EmptyState } from "../common/EmptyState";
import type { FileDiffInfo, Project } from "../../types/domain";

/**
 * The DBML parser, once any pane has pulled it in.
 *
 * `@dbml/core` is by a wide margin the heaviest thing in this app — 21.3 MB on disk, ~15.6 MB
 * minified, two thirds of the whole bundle — and the *only* thing that ever calls into it is the
 * `parseDbml` below, for a file whose name ends in `.dbml`. Imported statically it landed in the
 * entry chunk and was parsed before the window painted, in every session, including the
 * overwhelming majority that never open one.
 *
 * So it is fetched on demand, and remembered here at module scope rather than per pane: the first
 * `.dbml` file opened in a session pays a chunk load, every one after it (and every keystroke in
 * the one that is open) parses synchronously exactly as before. Without this cache the diagram
 * would flash its loading state on every keystroke, since a fresh `import()` is still a promise.
 */
let dbmlParser: ((source: string) => DbmlSchema) | null = null;

/**
 * Full-context diffs of files the diff tab has shown, keyed by repo + path + the change's
 * signature, most recently added last.
 *
 * At module scope rather than in the component for two reasons: two editor groups showing the same
 * file each want it, and a group that is closed and reopened (or a tab switched away from and back)
 * should not re-cross IPC for a diff nothing has changed.
 *
 * Kept deliberately small. One entry is a whole file's worth of `DiffLine` objects — the very thing
 * this change stopped holding for every file at once — and a generated lockfile is tens of
 * megabytes of them on its own. Four is enough for "toggle the diff off and on" and "flip between
 * the two files you are working on" to be instant, which is what the cache is for; the fifth is a
 * single small IPC call, not a stall.
 */
const fullDiffCache = new Map<string, FileDiffInfo>();
const FULL_DIFF_CACHE_LIMIT = 4;

/**
 * A cheap identity for "this file's change, as git currently sees it right now" — every added and
 * removed line verbatim plus the hunk headers that place them.
 *
 * `fileDiffFor` reads the store's `workingDiff`/`stagedDiff`, which the filesystem watcher rebuilds
 * from scratch several times a second, so the diff object has a fresh identity on every tick even
 * when the file has not moved. Keying the fetch below on the object would put an IPC round trip on
 * every tick, which is the exact cost this is here to avoid; keying it on the content means a tick
 * that found the same change refetches nothing, and any real edit reloads the pane.
 *
 * Context lines are left out on purpose: they are precisely what the narrow list diff does not
 * carry, so a signature that included them would depend on what it cannot see.
 *
 * (`ChangesPanel` has its own copy of this for its diff pane. Worth lifting into `lib/diffText.ts`
 * if a third caller appears.)
 */
function diffSignature(file: FileDiffInfo): string {
  const parts: string[] = [file.status, file.new_path ?? "", file.old_path ?? ""];
  for (const hunk of file.hunks) {
    parts.push(hunk.header);
    for (const line of hunk.lines) {
      if (line.origin !== " ") parts.push(`${line.origin}${line.old_lineno ?? ""}:${line.new_lineno ?? ""}:${line.content}`);
    }
  }
  return parts.join(" ");
}

/**
 * One file's diff at whole-file context, which is the only thing `reconstructSides` can rebuild two
 * complete file texts out of — see `lib/diffText.ts`.
 *
 * Working tree first, index second: that is exactly the "unstaged wins, else staged" precedence
 * `EditorView`'s `fileDiffFor` uses to pick the entry this pane was handed. It gives us the merged
 * answer without saying which side it came from, so the order is reproduced here rather than
 * plumbed down as another prop. The second call only ever happens for a file whose only change is
 * staged, and only once per change thanks to the cache.
 */
async function loadFullFileDiff(repoPath: string, path: string, key: string): Promise<FileDiffInfo | null> {
  const cached = fullDiffCache.get(key);
  if (cached) return cached;
  const file = (await getFileDiff(repoPath, path, false)) ?? (await getFileDiff(repoPath, path, true));
  if (file) {
    fullDiffCache.set(key, file);
    // Map iteration is insertion-ordered, so the first key is the oldest.
    if (fullDiffCache.size > FULL_DIFF_CACHE_LIMIT) {
      const oldest = fullDiffCache.keys().next().value;
      if (oldest !== undefined) fullDiffCache.delete(oldest);
    }
  }
  return file;
}

export type PreviewKind = "markdown" | "dbml" | null;
/** `preview`/`split` are the rendered-output modes, and only mean anything for a file with a
 * `PreviewKind`. `diff` is orthogonal to both: any file with uncommitted changes can be shown as
 * before-vs-after, so it's offered on its own toggle rather than as a fourth button in that group. */
export type ViewMode = "code" | "preview" | "split" | "diff";

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
  return (
    <div className="flex h-6 shrink-0 items-center gap-0.5 overflow-hidden border-b border-[var(--cf-border)] px-3 text-[11px] text-[var(--cf-text-muted)]">
      {segments.map((segment, i) => (
        <span key={`${segment}-${i}`} className="flex shrink-0 items-center gap-0.5">
          <span className="truncate">{segment}</span>
          <ChevronRight size={11} className="opacity-60" />
        </span>
      ))}
      <span className="mr-1 flex shrink-0 items-center">
        <FileGlyph path={path} size={11} />
      </span>
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
  pinnedPaths,
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
  registerBookmarkToggle,
  onSplit,
  onCloseGroup,
  tabMenu,
}: {
  groupId: string;
  project: Project;
  tabs: OpenTab[];
  /** Which of them are pinned *here*. Comes from the group rather than from the tab, since the
   * registry entries above are shared by every pane showing the same file. */
  pinnedPaths: string[];
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
  /** Same channel as `registerCapture`, for "bookmark the caret's line" — see `EditorView`. */
  registerBookmarkToggle: (toggle: () => void) => void;
  /** `null` hides the split button — there's already a second group. */
  onSplit: (() => void) | null;
  /** `null` for the only group; a group you can't close is one without a close button. */
  onCloseGroup: (() => void) | null;
  /** The tab strip's right-click actions, passed straight through. */
  tabMenu: TabMenuActions;
}) {
  const t = useT();
  const shortcutHint = useShortcutHint();
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
  const previewKind = previewKindFor(activePath);
  /** The parser, held in state so its arrival re-renders. `useState`'s initialiser form is what
   * stores a *function* rather than calling it — same for `setParseDbml` below. */
  const [parseDbml, setParseDbml] = useState<((source: string) => DbmlSchema) | null>(() => dbmlParser);
  /** A chunk that failed to load. Surfaced through the diagram's own error box rather than
   * swallowed: an empty diagram would read as a `.dbml` file with nothing in it. */
  const [dbmlLoadError, setDbmlLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (previewKind !== "dbml") return;
    const loaded = dbmlParser;
    if (loaded) {
      // Another pane pulled the chunk in while this one was showing something else, so there is
      // no load left to wait on — adopt it. Setting the same function back is a no-op re-render
      // React bails out of, which is what makes this safe to run on every switch to a `.dbml` tab.
      setParseDbml(() => loaded);
      return;
    }
    let cancelled = false;
    void import("../../lib/dbml")
      .then((module) => {
        dbmlParser = module.parseDbml;
        if (!cancelled) setParseDbml(() => module.parseDbml);
      })
      .catch((e) => {
        if (!cancelled) setDbmlLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [previewKind]);

  const dbmlSchema = useMemo<DbmlSchema | null>(() => {
    if (previewKind !== "dbml") return null;
    // A parser that arrived wins over an earlier failure: opening a second `.dbml` file retries
    // the chunk, and a retry that succeeded must not keep showing the error from the one before.
    if (parseDbml) return parseDbml(content);
    if (dbmlLoadError) return { tables: [], refs: [], error: dbmlLoadError };
    return null;
  }, [previewKind, content, parseDbml, dbmlLoadError]);
  /** `null` schema on a `.dbml` file means the parser hasn't landed yet — the one case the diagram
   * must show as a wait rather than as an empty schema. */
  const dbmlLoading = previewKind === "dbml" && dbmlSchema === null;
  /** Whether the file has an uncommitted change at all, and where its changed lines are. Comes from
   * the store's narrow list diff, which answers both of those exactly as it always did — what it
   * cannot answer is what the *whole file* looked like before, which is `fullActiveDiff` below. */
  const activeDiff = activePath ? fileDiffFor(activePath) : undefined;
  // A tab left in diff mode whose change then goes away — committed, discarded, staged from
  // under it — falls back to the code rather than to an empty pane.
  const viewMode: ViewMode =
    activeTab?.viewMode === "diff" && !activeDiff ? "code" : (activeTab?.viewMode ?? "code");

  /** The active file's change, identified by content — see `diffSignature`. `null` when the file
   * has no change to show. */
  const activeDiffKey = useMemo(
    () =>
      activePath && activeDiff ? `${project.local_path} ${activePath} ${diffSignature(activeDiff)}` : null,
    [project.local_path, activePath, activeDiff],
  );
  const [fullDiff, setFullDiff] = useState<{ path: string; key: string; file: FileDiffInfo } | null>(null);

  /**
   * Fetches the whole-file copy as soon as the active file has a change, **not** when the diff
   * toggle is pressed.
   *
   * The toggle used to be instant because the store already held every file at full context; that
   * is the thing that cost ~1.8 MB of JSON per watcher tick. Loading it for the one file that is
   * open keeps the press instant for what it costs to open a changed file once — and if the user
   * never presses it, that is a single small IPC call against a per-tick megabyte.
   */
  useEffect(() => {
    if (!activeDiffKey || !activePath) return;
    const cached = fullDiffCache.get(activeDiffKey);
    if (cached) {
      setFullDiff({ path: activePath, key: activeDiffKey, file: cached });
      return;
    }
    let cancelled = false;
    const path = activePath;
    void loadFullFileDiff(project.local_path, path, activeDiffKey).then((file) => {
      if (!cancelled && file) setFullDiff({ path, key: activeDiffKey, file });
    });
    return () => {
      cancelled = true;
    };
  }, [activeDiffKey, activePath, project.local_path]);

  /**
   * What the side-by-side actually renders.
   *
   * Matched on the *path*, not on the key: while a refetch triggered by an edit is in flight the
   * pane keeps showing the copy from a moment ago rather than blanking, which is no more stale than
   * a diff already is between two watcher ticks. Matching on the key would drop the whole editor on
   * every keystroke that reached disk.
   */
  const fullActiveDiff = fullDiff && fullDiff.path === activePath ? fullDiff.file : null;
  const diffSides = useMemo(
    () => (viewMode === "diff" && fullActiveDiff ? reconstructSides(fullActiveDiff) : null),
    [viewMode, fullActiveDiff],
  );

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
  // Bookmarks are filed repo-relative, the way the editor and its panel address a file; the
  // breakpoint above is absolute because that is what a debug adapter speaks.
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = activePath;
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

  /**
   * Bookmarked lines, in the lines-decorations lane rather than the glyph margin.
   *
   * The glyph margin is the breakpoint's, and the two land on the same line often enough — you
   * bookmark what you are debugging — that sharing it would mean one silently hiding the other.
   * The overview ruler tick is what makes a mark in a 2000-line file findable without scrolling
   * to it.
   */
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const bookmarkDecorationsRef = useRef<string[]>([]);
  useEffect(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon || !ed.getModel()) return;
    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = bookmarks
      .filter((mark) => mark.path === activePath)
      .map((mark) => ({
        range: new mon.Range(mark.line, 1, mark.line, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: "cf-bookmark-mark",
          overviewRuler: { color: "#f59e0b", position: mon.editor.OverviewRulerLane.Right },
        },
      }));
    bookmarkDecorationsRef.current = ed.deltaDecorations(bookmarkDecorationsRef.current, decorations);
  }, [bookmarks, activePath, editorReady, activeTab?.loading]);

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

  /**
   * Marks the caret's line, for the app-level shortcut.
   *
   * The context-menu entry below runs the same thing through Monaco, which is the path that has
   * the caret to hand. This one exists because the keybinding is configurable and therefore lives
   * in the app's registry, not in Monaco's — and a registry command has no idea which of several
   * panes the caret is in. The focused pane answering that is the same arrangement the snapshot
   * shortcut already uses.
   */
  const toggleBookmarkAtCaret = useCallback(() => {
    const model = editorRef.current?.getModel();
    const line = editorRef.current?.getPosition()?.lineNumber;
    if (!model || !line || !activePath) return;
    useBookmarkStore.getState().toggle(activePath, line, model.getLineContent(line));
  }, [activePath]);

  const bookmarkToggleRef = useRef(toggleBookmarkAtCaret);
  bookmarkToggleRef.current = toggleBookmarkAtCaret;
  useEffect(() => {
    if (focused) registerBookmarkToggle(() => bookmarkToggleRef.current());
  }, [focused, registerBookmarkToggle]);

  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  const handleMount: OnMount = (editorInstance, monacoInstance) => {
    editorRef.current = editorInstance;
    monacoRef.current = monacoInstance;
    // Typing or clicking in a pane is what makes it the active group — the same "focus follows
    // the editor you touched" rule VS Code uses to decide where the next file opens.
    editorInstance.onDidFocusEditorWidget(() => onFocusRef.current());
    // An action with an id rather than `addCommand` with a chord baked in. Still registered on the
    // editor, so it only ever fires with the caret in the code and Monaco swallows it before the
    // browser or another panel sees it — but the *key* now comes from the shortcut registry via
    // `applyEditorKeybindings`, which is what makes it rebindable like everything else.
    editorInstance.addAction({
      id: "cf-inline-edit",
      label: tRef.current("shortcuts.inlineEdit"),
      run: () => {
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
      },
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
    // Right-click on the line, next to the other navigation entries — a bookmark is about *where*
    // you are, so `navigation` is the group it belongs in. No keybinding here: that one is in the
    // app's shortcut registry, where it can be rebound, and two owners of one chord is how they
    // drift apart.
    editorInstance.addAction({
      id: "cf-bookmark-toggle",
      label: tRef.current("bookmarks.toggle"),
      contextMenuGroupId: "navigation",
      contextMenuOrder: 5,
      run: (ed) => {
        const model = ed.getModel();
        const line = ed.getPosition()?.lineNumber;
        const path = activePathRef.current;
        if (!model || !line || !path) return;
        // The line's text becomes the label, so the panel shows what was marked rather than a
        // file name and a number.
        useBookmarkStore.getState().toggle(path, line, model.getLineContent(line));
      },
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

  // Re-installed on every change to the overrides rather than once at mount: rebinding ⌘D in
  // settings has to reach an editor that is already open, and the disposable is what takes the
  // previous handler back out before the next one goes in.
  const overrides = useShortcutsStore((s) => s.overrides);
  useEffect(() => {
    const monacoInstance = monacoRef.current;
    if (!monacoInstance) return;
    const applied = installEditorShortcuts(monacoInstance, overrides);
    return () => applied.dispose();
  }, [overrides, editorReady]);

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
        pinned: pinnedPaths.includes(tab.path),
      })),
    [tabs, pinnedPaths],
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
          /**
           * Ctrl/Cmd+click jumps, it never opens the peek list.
           *
           * Monaco's default is `peek`: one result navigates, several pop the peek panel open and
           * make you choose. But the choice is Monaco's to offer only because our lookup is a
           * ranked guess (see `rankDefinitions`) that returns every survivor — and the first one is
           * the jump a developer would have made, so making them confirm it is a click for nothing.
           * `goto` takes the top-ranked result and moves the caret there, same as VS Code with
           * `editor.gotoLocation.multipleDefinitions` set to `goto`. Peek is still reachable
           * deliberately, via Alt+F12 / the context menu, which is where it belongs.
           */
          gotoLocation: {
            multipleDefinitions: "goto",
            multipleDeclarations: "goto",
            multipleTypeDefinitions: "goto",
            multipleImplementations: "goto",
          },
          // Without a glyph margin there is nowhere to click for a breakpoint, and nowhere to
          // draw one.
          glyphMargin: true,
          /**
           * Room for the bookmark icon beside the folding chevron.
           *
           * Every `linesDecorationsClassName` Monaco draws lands in one lane, at the same `left`
           * and the same width (`linesDecorations.js` renders them all with one shared style), and
           * the folding chevron is one of them — centred in the lane. So the lane's width is the
           * only thing that decides whether a second mark in it has anywhere to go, and at the
           * default it does not: a bookmark almost always sits on a foldable line, being the top
           * of whatever was worth marking. Monaco adds 16px of its own when folding is on, so this
           * is a 36px lane: the chevron centred in it, the icon flush left, no overlap.
           */
          lineDecorationsWidth: 20,
        }}
      />
    ) : null;

  return (
    <div
      // Capture-phase, so clicking anywhere in the group — a tab, the breadcrumb, the code —
      // makes it the active one before whatever was clicked handles the event.
      onMouseDownCapture={onFocus}
      className={`flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--cf-surface)] ${
        // An inset ring rather than a border, now that the layout is flush: a resting border on
        // every pane would sit against the seam between two of them and draw a second line. The
        // ring takes no layout, so it appears only on the group that has focus — and only when
        // there's another group for it to be distinguished from.
        focused && onCloseGroup ? "ring-1 ring-inset ring-[var(--cf-accent)]" : ""
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
            menu={tabMenu}
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
                {/* Only for a file that has something to compare. A toggle rather than a mode in
                    the group above it: the answer to "and back to what?" is always the code, so
                    pressing it twice is the way out. */}
                {activeDiff && (
                  <button
                    onClick={() => onViewMode(activeTab.path, viewMode === "diff" ? "code" : "diff")}
                    title={t("editor.viewDiff")}
                    aria-label={t("editor.viewDiff")}
                    className={`flex h-5 w-5 items-center justify-center rounded-md ${
                      viewMode === "diff"
                        ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                        : "text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
                    }`}
                  >
                    <GitCompare size={12} />
                  </button>
                )}
                <button
                  onClick={captureSnapshot}
                  disabled={activeTab.loading}
                  title={shortcutHint("editor.codeSnap", t("codesnap.action"))}
                  aria-label={t("codesnap.action")}
                  className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-40 dark:hover:bg-white/[0.08]"
                >
                  <Camera size={12} />
                </button>
                {onSplit && (
                  <button
                    onClick={onSplit}
                    title={shortcutHint("editor.splitRight", t("editor.splitRight"))}
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
            ) : viewMode === "diff" ? (
              diffSides ? (
                /* Read-only on purpose: this is the change as git has it, and the editable copy is
                   one click away on the same toolbar. `renderSideBySide` is the whole request —
                   before on the left, now on the right — so it never falls back to inline. */
                <DiffEditor
                  height="100%"
                  language={languageForPath(activeTab.path)}
                  original={diffSides.original}
                  modified={diffSides.modified}
                  theme={monacoTheme}
                  options={{
                    readOnly: true,
                    fontSize: 13,
                    renderSideBySide: true,
                    useInlineViewWhenSpaceIsLimited: false,
                    automaticLayout: true,
                    maxComputationTime: 2000,
                    scrollBeyondLastLine: false,
                  }}
                />
              ) : (
                /* Whole-file context is a fetch now (see `loadFullFileDiff`), and `viewMode` has
                   already established the file *has* a change — so this is the brief gap before it
                   lands, and it gets the same wait the file's own load does. Falling through to the
                   code editor here would flash the file in and straight back out. */
                <div className="flex h-full items-center justify-center">
                  <BouncingDots />
                </div>
              )
            ) : viewMode === "preview" ? (
              previewKind === "markdown" ? (
                <MarkdownPreview content={content} />
              ) : (
                <DbmlDiagram schema={dbmlSchema} loading={dbmlLoading} />
              )
            ) : viewMode === "split" ? (
              <div className="flex h-full">
                <div className="min-w-0 flex-1 border-r border-[var(--cf-border)]">{editorPane}</div>
                <div className="min-w-0 flex-1">
                  {previewKind === "markdown" ? (
                    <MarkdownPreview content={content} ref={previewScrollRef} />
                  ) : (
                    <DbmlDiagram schema={dbmlSchema} loading={dbmlLoading} ref={previewScrollRef} />
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
