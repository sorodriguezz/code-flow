import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Editor, { DiffEditor, type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
// This is the one editor in the app that does not spread `OVERFLOW_SAFE_OPTIONS` (see the note at
// the `fixedOverflowWidgets` line far below), so it is also the one that would otherwise never
// reach `monacoSetup` — which since `main.tsx` stopped importing it is what points the loader at
// the bundled editor, wires the language workers and defines the themes.
import "../../lib/monacoSetup";
import {
  Camera,
  ChevronRight,
  Code2,
  Columns2,
  Copy,
  Eye,
  FileCode,
  GitCompare,
  Loader2,
  Play,
  Save,
  SplitSquareHorizontal,
  X,
} from "lucide-react";
import { MarkdownPreview } from "./MarkdownPreview";
import { DbmlDiagram } from "./DbmlDiagram";
import { EditorTabs, type EditorTabItem, type TabMenuActions } from "./EditorTabs";
import { InlineEditWidget } from "./InlineEditWidget";
import { ChangePeek, peekHeightOf } from "./ChangePeek";
import type { CodeSnapTarget } from "./CodeSnapModal";
import { modelPathFor } from "../../lib/editorModel";
import { languageForPath } from "../../lib/monacoLanguage";
import { FileGlyph } from "../common/FileGlyph";
import { EMPTY_SCHEMA, type DbmlSchema } from "../../lib/dbml/types";
import { changeBlocksOf, sameHunk, type ChangeBlock, type GutterMark } from "../../lib/diffBlocks";
import { diffSignature, reconstructSides } from "../../lib/diffText";
import { getCommitFileDiff, getFileDiff } from "../../lib/tauri/commands";
import { anchorColor, anchorTagClass, parseAnchors } from "../../lib/anchors";
import { blameLabel, blameStatusText } from "../../lib/blameText";
import { formatWhen } from "../remote/remoteChrome";
import { useDebugStore, normalizePath } from "../../state/debugStore";
import { useBookmarkStore } from "../../state/bookmarkStore";
import { useBlameStore } from "../../state/blameStore";
import { useCursorBlameStore } from "../../state/cursorBlameStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useRepoStore } from "../../state/repoStore";
import { useTabDragStore, type TabDrag, type TabDropTarget } from "../../state/tabDragStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useShortcutHint } from "../../lib/useShortcutHint";
import { installEditorShortcuts } from "../../lib/editorKeybindings";
import { useShortcutsStore } from "../../state/shortcutsStore";
import { BouncingDots } from "../common/BouncingDots";
import { EmptyState } from "../common/EmptyState";
import type { BlameHunkInfo, FileDiffInfo, Project } from "../../types/domain";
import { usePackageJsonLens } from "./usePackageJsonLens";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { useTypeScript } from "./useTypeScript";
import { useLanguageServer } from "./useLanguageServer";
import { useInlineCompletion } from "./useInlineCompletion";
import { useImportCost } from "./useImportCost";
import { useManagerFor } from "../../lib/useManagerFor";
import {
  PACKAGE_JSON,
  PACKAGE_MANAGERS,
  scriptCommandLine,
  type PackageManager,
} from "../../lib/packageScripts";
import { usePackageManagerStore } from "../../state/packageManagerStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useNpmInstallStore } from "../../state/npmInstallStore";
import { pushErrorToast } from "../../state/toastStore";

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
 * megabytes of them on its own. Four was enough for "toggle the diff off and on" and "flip between
 * the two files you are working on" to be instant, which is what the cache is for; the fifth is a
 * single small IPC call, not a stall.
 *
 * Eight since the blame annotation gained a click-through: the same cache now also holds *commit*
 * diffs (`OpenTab.compare`), and following a line's history is a sequence of them — click the label,
 * read the change, come back, click the label on the line above. At four, a three-commit walk was
 * already evicting the working diff of the file being read. Both kinds share one cache because they
 * are the same payload for the same viewer; what differs is only how the key is built, and a commit's
 * diff is immutable so its key needs no signature.
 */
const fullDiffCache = new Map<string, { file: FileDiffInfo; lines: number }>();
const FULL_DIFF_CACHE_LIMIT = 8;

/**
 * The other bound, and the one the count alone could not give: eight entries is eight *files*,
 * regardless of what a file weighs.
 *
 * An entry is one `DiffLine` object plus one `content` string per line of the file, so eight
 * ordinary source files is around 16,000 lines and nothing worth thinking about — while eight
 * generated lockfiles is several hundred thousand, tens of megabytes, held at module scope for the
 * life of the process because this cache outlives every pane, every group and every project switch.
 * Opening the diff tab on a lockfile eight times is not an exotic thing to do.
 *
 * 200,000 lines is roughly 30–40 MB and is deliberately far above anything the count limit can
 * reach with normal files, so the eight-entry behaviour this cache was tuned for is untouched; it
 * only binds on the case that had no bound at all.
 */
const FULL_DIFF_LINE_BUDGET = 200_000;

/** Lines currently held across every entry. Maintained on insert and eviction rather than summed
 * on lookup — recomputing it per read would trade a memory problem for a CPU one. */
let cachedLines = 0;

function diffLineCount(file: FileDiffInfo): number {
  let lines = 0;
  for (const hunk of file.hunks) lines += hunk.lines.length;
  return lines;
}

/**
 * Drops everything. Called when the project changes, for the reason `App` clears the blame cache on
 * watcher teardown: the keys are per repository, so entries for a repo nobody is looking at can
 * never be hit again and are pure residency.
 */
export function clearFullDiffCache(): void {
  fullDiffCache.clear();
  cachedLines = 0;
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
 *
 * `compareOid` switches it to the other question the diff tab can now be asked: not "how does this
 * file differ from HEAD" but "what did *this commit* do to it", which is where a click on a blame
 * annotation lands. One function rather than two because everything around the fetch — the cache, the
 * eviction, the `null` for "nothing to show" — is identical; only the command differs, and the two
 * commands were written to return the same shape at the same context width precisely so this could be
 * one branch instead of a second pipeline.
 */
async function loadFullFileDiff(
  repoPath: string,
  path: string,
  key: string,
  compareOid?: string,
): Promise<FileDiffInfo | null> {
  const cached = fullDiffCache.get(key);
  if (cached) return cached.file;
  const file = compareOid
    ? await getCommitFileDiff(repoPath, compareOid, path)
    : ((await getFileDiff(repoPath, path, false)) ?? (await getFileDiff(repoPath, path, true)));
  if (file) {
    const lines = diffLineCount(file);
    fullDiffCache.set(key, { file, lines });
    cachedLines += lines;
    // Map iteration is insertion-ordered, so the first key is the oldest. Evicts on either bound:
    // too many entries, or too many lines across them. The `size > 1` guard is what keeps the entry
    // that was just inserted — a single file bigger than the whole budget is still cached, so the
    // feature never fails for the one case that most wants it.
    while (
      fullDiffCache.size > FULL_DIFF_CACHE_LIMIT ||
      (cachedLines > FULL_DIFF_LINE_BUDGET && fullDiffCache.size > 1)
    ) {
      const oldest = fullDiffCache.keys().next().value;
      if (oldest === undefined) break;
      cachedLines -= fullDiffCache.get(oldest)?.lines ?? 0;
      fullDiffCache.delete(oldest);
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
  /**
   * Which *commit's* change to this file the diff view should show, or `null` for the ordinary
   * "working tree vs HEAD" diff. Set by clicking a blame annotation.
   *
   * On the file rather than on the pane, because that is where `viewMode` already lives: two panes
   * showing one file already share which of the two ways they read it, and a per-pane compare target
   * would be the first thing in this registry that didn't. The consequence is named rather than fixed —
   * opening a commit diff for a file that is also open in another split flips that pane too. Making it
   * per-pane would mean moving it onto `EditorGroup`, which has no view state at all today, and
   * teaching `openDiffTab` about groups.
   */
  compare: { oid: string; short_id: string; summary: string } | null;
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

/**
 * What Ctrl+I was aimed at, captured the instant it was pressed.
 *
 * `selection` is captured because the widget's own input steals focus, and Monaco's selection is
 * long gone by the time an instruction is typed and submitted. Everything beside it is captured for
 * the opposite reason: the rewrite comes back whenever the provider answers, which can be a minute
 * later and several tab switches away, so the reply has to be checked against the buffer it was
 * asked about rather than applied to whatever the pane is showing when it lands.
 *
 * `path` and `modelUri` are that identity. The URI is kept as a string rather than as a model
 * reference so holding onto it can never keep a disposed buffer alive, and so the comparison is
 * against the one thing that names a buffer uniquely — two projects both have a `src/main.ts`, and
 * only the URI tells them apart.
 */
/**
 * What became of an inline rewrite when its reply arrived.
 *
 * Three answers rather than a boolean, because "it landed" and "it landed somewhere you are not
 * looking" need to be reported differently: the first is visible on its own, the second has to be
 * announced or the user never finds out the work happened at all.
 */
export type InlineEditOutcome = "applied" | "applied-offscreen" | "refused";

interface InlineEditTarget {
  /**
   * Which press of Ctrl+I this is, the way [`RevealRequest`] counts its own.
   *
   * Path and URI say *which buffer*; they say nothing about *which request*, and two presses in
   * one file are identical under both. That is a reachable pair: the widget's input greys out
   * while a rewrite is in flight, so the natural next move is to click back into the code and keep
   * working — select something else, press Ctrl+I again — and the first reply then lands on the
   * second selection's decoration. Same corruption as the tab-switch bug, one file in.
   */
  nonce: number;
  path: string;
  modelUri: string;
  selection: string;
  /** A styling-free decoration over the selected range, which Monaco carries along as the text
   *  above it changes. Stored instead of the plain `IRange` it was made from: a range is a pair of
   *  line numbers, and line numbers mean whatever happens to be sitting at them when the reply
   *  arrives, which after a minute of typing is not what was asked about. */
  decorationId: string;
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

/**
 * Gives a change peek's view-zone node a width, which Monaco does **not** do for it.
 *
 * `ViewZones.render` sets each zone's `top`, `height` and `display`, and sets a width only on the
 * *container* (`Math.max(scrollWidth, contentWidth)`). A zone node is absolutely positioned, so with no
 * width of its own it shrinks to its content — a panel as narrow as its longest diff line, with the
 * button row jammed up against it. Inheriting the container's width instead would be worse: on a file
 * with any long line that is the scroll width, and the buttons would sit off the right edge of the
 * viewport.
 *
 * So it is measured from the layout, which is what VS Code's own `ZoneWidget` does for the same reason.
 * `contentWidth` and not `width`: the node already sits inside the content container, past the margin.
 *
 * **`contentWidth` alone is too wide, by exactly the vertical scrollbar.** Monaco lays the editor out as
 * `[glyph][line numbers][decorations][content …][minimap][scrollbar]`, and its arithmetic is
 * `remainingWidth = outerWidth - glyphMarginWidth - lineNumbersWidth - lineDecorationsWidth` followed by
 * `contentWidth = remainingWidth - minimapWidth` (`editorOptions.js:1239`, `:1276`) — so the scrollbar's
 * width is still inside `contentWidth`, while `minimapLeft` is `outerWidth - minimapWidth -
 * verticalScrollbarWidth`. A panel sized to `contentWidth` therefore runs past the minimap's left edge
 * by the scrollbar's width, which is enough to tuck the close button underneath the minimap.
 * Subtracting it, plus a gap, is what puts the button row back in the clear.
 *
 * **Call this *after* `addZone`, never before.** `ViewZones._addZone` writes
 * `domNode.style.width = '100%'` itself, synchronously, from inside the `changeViewZones` callback
 * (`viewZones.js:182`) — so a call that ran first is silently overwritten and the panel opens at the
 * container's *scroll* width, which is the exact failure this function exists to prevent and is visible
 * on any file with a line wider than the viewport. `render` never touches the node's width again, so
 * one call after the batch is enough until the next layout change.
 */
/** Clear air between the panel's right edge and the minimap, so the close button reads as being in its
 *  own space rather than crammed against the map. Small enough that the panel still spans the code. */
const PEEK_MINIMAP_GAP = 10;

function sizePeekDom(ed: MonacoEditorNS.IStandaloneCodeEditor, dom: HTMLDivElement): void {
  const layout = ed.getLayoutInfo();
  dom.style.width = `${Math.max(0, layout.contentWidth - layout.verticalScrollbarWidth - PEEK_MINIMAP_GAP)}px`;
  // And a z-index, or **none of the panel's buttons can be clicked**.
  //
  // `.view-zones` is appended to `.lines-content` *before* `.view-lines` (`view.js:178-179`), and both
  // are absolutely positioned siblings with no z-index of their own — so the text layer wins the
  // stacking order and hit-tests above every zone. The panel is still fully visible, because nothing in
  // `.view-lines` paints over it; the click simply lands on the text layer instead of on the button,
  // which is a bug that looks like a dead control rather than like a layering mistake.
  //
  // 10 is Monaco's own answer to this: `.monaco-editor .zone-widget { position: absolute; z-index: 10 }`
  // (`zoneWidget.css:5-8`), which is how the built-in peek views sit above the code they interrupt.
  // Matching the number rather than inventing one keeps us below the content widgets and cursors that
  // Monaco appends after the lines.
  dom.style.zIndex = "10";
}

/**
 * The CSS classes each kind of gutter mark wears, and the token whose value the minimap and overview
 * ruler get as a hex.
 *
 * A table rather than three branches inside the effect because the two halves have to stay in step:
 * `linesDecorationsClassName`/`className` take a class and are themed by `index.css`, while
 * `minimap.color`/`overviewRuler.color` take a colour value and therefore have to be *read* out of
 * CSS — which is the whole reason that effect carries a `themeMode` dependency and the blame one does
 * not. Keeping the pair adjacent is what stops a fourth kind being added in one place only.
 *
 * `deleted` has no line class: there is no changed line to tint, and tinting the line that survived
 * would blame it for the deletion.
 */
const MARK_STYLES = {
  added: {
    gutter: "cf-editor-gutter-added",
    line: "cf-editor-changed-line-added",
    token: "--cf-success",
    fallback: "#22c55e",
  },
  modified: {
    gutter: "cf-editor-gutter-modified",
    line: "cf-editor-changed-line-modified",
    token: "--cf-warning",
    fallback: "#d97706",
  },
  deleted: {
    gutter: "cf-editor-gutter-deleted",
    line: null,
    token: "--cf-danger",
    fallback: "#dc2626",
  },
} as const;

/**
 * How long the caret has to sit still before the line is annotated. **250 ms, trailing.**
 *
 * A held arrow key fires at the platform's key-repeat rate; without this, every one of those events
 * would look up a hunk, rewrite a decoration and write the status-bar entry. Trailing rather than
 * leading, and this long, for a reason that is the point of the feature rather than a compromise:
 * holding a key now scrolls through the file without ever drawing a label, and the label appears when
 * you stop — which is when you are actually asking the question. A quarter second is under the
 * threshold at which a late annotation reads as lag.
 *
 * Hand-rolled, like the one in `apiStore` (a module constant plus a timer plus a re-arm) rather than a
 * shared `debounce` helper: there is no such helper in `lib/` today, one caller does not earn one, and
 * the house position on reflexive debouncing is the comment in `ObjectBrowser`.
 */
const BLAME_DEBOUNCE_MS = 250;

/**
 * Which hunk owns a line — a binary search, which is the entire reason the backend returns runs of
 * lines rather than one entry per line.
 *
 * The hunk list is ascending by `start_line` and gap-free (guaranteed by `git/blame.rs`), so the
 * answer is the last hunk whose `start_line` is at or below the line. O(log n) per caret move with no
 * expansion and no allocation — the per-line form would have been an array lookup, but only after
 * building an array as long as the file on every blame.
 *
 * `null` for a line past the end of the blame, which is the normal state of an unsaved buffer whose
 * blame is still in flight.
 */
function hunkForLine(hunks: BlameHunkInfo[], line: number): BlameHunkInfo | null {
  let low = 0;
  let high = hunks.length - 1;
  let found: BlameHunkInfo | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (hunks[mid].start_line <= line) {
      found = hunks[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // The blame was computed against a different text than the one on screen — a buffer blame whose
  // request is still in flight, most often. Better to say nothing than to credit the wrong commit.
  if (found && line >= found.start_line + found.line_count) return null;
  return found;
}

/**
 * The hover behind the annotation: the full author, the absolute date, the oid and the untruncated
 * summary — everything the inline label had to drop to stay one short line.
 *
 * Monaco's own hover widget rather than the app's `Tooltip`, which is not usable here at all: it
 * portals to `document.body`, is `pointer-events-none`, and would need an anchor element inside
 * Monaco's line DOM that this decoration does not own. The widget it does use is themed from
 * `editorWidget.background`/`border`, so it already matches every code theme.
 *
 * `formatWhen` returns `""` for a zero stamp, which is exactly the uncommitted case — so that branch
 * needs no special handling beyond not having a commit to name.
 */
function blameHoverMarkdown(hunk: BlameHunkInfo, t: ReturnType<typeof useT>, language: string): string {
  if (hunk.uncommitted) return t("blame.uncommitted");
  const lines = [`**${hunk.author_name}** <${hunk.author_email}>`];
  lines.push(t("blame.commitLine", { short: hunk.short_id, date: formatWhen(hunk.timestamp, language) }));
  if (hunk.summary) lines.push(hunk.summary);
  lines.push(`_${t("blame.openDiff")}_`);
  // Two newlines: Monaco renders the value as markdown, where a single one is not a break.
  return lines.join("\n\n");
}

/**
 * A mousedown that landed on text inside a line, or `null` for anything else — the gutter, empty space
 * past the end of a line, a widget, outside the editor.
 *
 * `IMouseTarget` is a discriminated union on `type`, so `if (t.type !== CONTENT_TEXT) return` ought to
 * narrow it and give `detail`/`position` for free. It does not, and the reason is worth writing down
 * because the next person will hit it: `@monaco-editor/react` types its `Monaco` as `typeof monaco`,
 * and reading `MouseTargetType.CONTENT_TEXT` off *that* yields the enum type rather than the unit type
 * the narrowing needs. (Comparing against the literal `6` narrows perfectly, which is how this was
 * diagnosed and is obviously not the fix.) So the cast is made once, here, behind a real check —
 * rather than at each of the three fields the handler then wants to read.
 */
function contentTextTarget(
  target: MonacoEditorNS.IMouseTarget,
  mon: Monaco,
): MonacoEditorNS.IMouseTargetContentText | null {
  return target.type === mon.editor.MouseTargetType.CONTENT_TEXT
    ? (target as MonacoEditorNS.IMouseTargetContentText)
    : null;
}

/** VS Code-style path bar under the tabs: the folders leading to the open file, then the
 * file itself in its language color. */
function Breadcrumb({
  path,
  dirty,
  loading,
  compare,
}: {
  path: string;
  dirty: boolean;
  loading: boolean;
  /** Set while the tab is showing one commit's change rather than the working one — named here so a
   *  commit diff is not visually identical to a working diff, which is the only place the two could
   *  be confused. */
  compare: OpenTab["compare"];
}) {
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
      {compare && (
        <span className="ml-1.5 flex min-w-0 items-center gap-1">
          <GitCompare size={10} className="shrink-0 opacity-70" />
          <span className="shrink-0 font-mono">{compare.short_id}</span>
          <span className="truncate opacity-80">{compare.summary}</span>
        </span>
      )}
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
  onOpenCommitDiff,
  registerCapture,
  registerBookmarkToggle,
  registerChangeNav,
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
  /** The file's uncommitted change and which side it came from — see `EditorView`'s `fileDiffFor`.
   *  The side is what the change peek needs to decide between "stage" and "unstage". */
  fileDiffFor: (path: string) => { file: FileDiffInfo; staged: boolean } | undefined;
  saving: boolean;
  reveal: RevealRequest | null;
  onRevealDone: () => void;
  onFocus: () => void;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onPin: (path: string) => void;
  /** A tab was dropped somewhere — passed straight through to the strip, which owns the gesture
   * and therefore knows which group the drop landed in. */
  onDropTab: (payload: TabDrag, target: TabDropTarget) => void;
  onChange: (path: string, value: string) => void;
  onViewMode: (path: string, mode: ViewMode) => void;
  onSave: () => void;
  onCodeSnap: (target: CodeSnapTarget) => void;
  /**
   * Clicking a blame annotation: show this file's change in that commit, side by side.
   *
   * Goes up to the parent rather than being handled here because the *file registry* is the parent's —
   * `compare` lives on `OpenTab` beside `viewMode`, so setting it is a `patchTab`. It lands in the pane
   * that was clicked for free: `onMouseDownCapture` on this box made the group active before Monaco's
   * own mousedown ran, and `openFile` with no group targets the active one.
   *
   * `compare: null` is a real argument, not an omission: it means "the working change", which is what
   * clicking the label of a line nobody has committed yet should open.
   */
  onOpenCommitDiff: (path: string, compare: OpenTab["compare"]) => void;
  /** Hands the parent a way to trigger this pane's snapshot capture, so the shortcut works even
   * when focus is somewhere else in the Editor tab. */
  registerCapture: (capture: () => void) => void;
  /** Same channel as `registerCapture`, for "bookmark the caret's line" — see `EditorView`. */
  registerBookmarkToggle: (toggle: () => void) => void;
  /** Same channel again, for ⌥F5 / ⇧⌥F5: `+1` for the next hunk, `-1` for the previous one. Per-pane
   *  because the peek is, so two splits on one file can be parked on different hunks. */
  registerChangeNav: (nav: (delta: number) => void) => void;
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
  /**
   * The directory the open `package.json` lives in, or `null` for any other file.
   *
   * **Its own directory, not the project root.** In a monorepo those are different places, and a
   * `dev` script from `packages/web` started at the root runs the root's script of the same name or
   * nothing at all — the one failure a play button beside a script name must not have. Same reason
   * the tree computes it this way.
   */
  const manifestDir = useMemo(() => {
    if (!activePath) return null;
    const parts = activePath.split(/[/\\]/);
    if (parts.pop() !== PACKAGE_JSON) return null;
    return parts.join("/");
  }, [activePath]);
  const managerFor = useManagerFor(project.local_path, manifestDir);
  /** The manager at the repository root, for installs that are not about a manifest on screen — the
   *  quick fix on a missing import. Detected the same way, from the root's own lockfile. */
  const rootManager = useManagerFor(project.local_path, "");
  /** The menu a gutter arrow opened, and the script it belongs to. Positioned at the arrow, so the
   *  answer is given where the question was asked — see `scriptMenuItems` for what is in it. */
  const [scriptMenu, setScriptMenu] = useState<{ x: number; y: number; script: string } | null>(null);
  const manager = managerFor.manager;
  // Decoration ids are per *model*, so they have to be tracked per open file — reusing one
  // list across tabs would try to replace ids that belong to another tab's model.
  const decorationIdsRef = useRef<Map<string, string[]>>(new Map());
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSyncGuardRef = useRef<"editor" | "preview" | null>(null);
  const pendingRevealRef = useRef<RevealRequest | null>(null);
  /** What Ctrl+I was pressed on — see [`InlineEditTarget`]. Drives the widget's rendering. */
  const [inlineEdit, setInlineEdit] = useState<InlineEditTarget | null>(null);
  /**
   * The same value, but readable from a closure that was built before it changed.
   *
   * `applyInlineEdit` is handed to the widget as a prop, and the widget hangs onto it inside the
   * `submit` closure that is already awaiting the model. Reading the `inlineEdit` *state* from
   * there reads whatever it was when the request went out — which is exactly the thing the guard
   * exists to catch having moved on, so the guard would be checking the answer against itself. The
   * ref is written eagerly by the two functions below rather than mirrored during render (the way
   * `activePathRef` above is), because a reply can land and be checked in the same tick the widget
   * was closed in, before React has re-rendered anything.
   */
  const inlineEditRef = useRef<InlineEditTarget | null>(null);
  /** Mints [`InlineEditTarget.nonce`]. A ref rather than state: nothing renders from it, and it has
   *  to be readable and bumped inside `openInlineEdit` without scheduling a pass of its own. */
  const inlineEditNonceRef = useRef(0);
  /** The file this pane was showing the last time the guard below looked, so a change of file can
   *  be told apart from the pane simply going away. */
  const inlineEditPathRef = useRef(activePath);
  /** Whether the widget has a rewrite in flight — see the unmount effect. */
  const inlineEditRunningRef = useRef(false);

  /**
   * Takes the widget down and, with it, the decoration that was following its selection around.
   *
   * The decoration has to go explicitly: it lives on the *model*, which outlives both the widget
   * and the tab being switched away from, so leaving it behind would quietly accumulate one hidden
   * tracked range per Ctrl+I for as long as the file stays open.
   */
  const closeInlineEdit = useCallback((nonce?: number) => {
    const target = inlineEditRef.current;
    // A close owed to a press that is already over.
    //
    // The widget is keyed by nonce, so a second Ctrl+I unmounts the first one — but its in-flight
    // `submit` is a promise React cannot cancel, and when the reply lands that dead closure still
    // runs its `onClose`. Unguarded, an old rewrite arriving a second after a new press tore down
    // the widget the user was typing into and dropped its tracked range with it: `applyInlineEdit`
    // correctly refused the stale *edit*, and then this correctly-refused reply closed the request
    // that superseded it. `openInlineEdit` has already retired the old decoration, so there is
    // genuinely nothing left for that call to do. Callers with no press to name (the escape key,
    // the ✕, the tab-change cleanup) pass nothing and always close what is open.
    if (nonce !== undefined && target?.nonce !== nonce) return;
    const mon = monacoRef.current;
    if (target && mon) {
      // Resolved rather than assumed: the model this decoration belongs to is the one the selection
      // came from, which by now may not be the one on screen — and may have been disposed with its
      // tab, in which case there is nothing left to clean up and `getModel` says so.
      mon.editor.getModel(mon.Uri.parse(target.modelUri))?.deltaDecorations([target.decorationId], []);
    }
    inlineEditRef.current = null;
    setInlineEdit(null);
  }, []);

  /** Opens the widget on a fresh target, retiring whatever the previous Ctrl+I left behind — two
   *  presses without an apply in between would otherwise strand the first decoration — and stamping
   *  the new one so a reply still owed to the previous press can be told apart from this one's. */
  const openInlineEdit = useCallback(
    (target: Omit<InlineEditTarget, "nonce">) => {
      closeInlineEdit();
      const next = { ...target, nonce: ++inlineEditNonceRef.current };
      inlineEditRef.current = next;
      setInlineEdit(next);
    },
    [closeInlineEdit],
  );
  // Bumped every time a Monaco instance actually finishes mounting — the code panel remounts
  // Monaco whenever it toggles away and back (preview-only mode), which would otherwise leave
  // effects keyed on `[ranges]`/`[viewMode]` alone reading a stale/disposed `editorRef.current`
  // if they happened to fire before the new instance was ready.
  const [editorReady, setEditorReady] = useState(0);

  /**
   * The `package.json` annotations: a run arrow beside every script, a box over each dependency
   * block.
   *
   * `editorReady` is what gates the instances rather than the refs being read directly. A ref does
   * not re-render when it is filled, so on the pass where Monaco mounts these would still be null
   * and the hook would register nothing; `editorReady` is bumped in `handleMount` precisely so
   * effects like this one get a pass with the instance in hand. Every other Monaco add-on in this
   * file already depends on it for the same reason.
   */
  /**
   * TypeScript's own language service, for every JS/TS file this pane shows.
   *
   * Same `editorReady` gate and for the same reason as the lens below. It registers its providers
   * against the Monaco *instance*, so they serve every model this editor opens rather than only the
   * active one — which is what a go-to-definition landing in a file you had not opened needs.
   */
  // Everything tsserver does not cover — see the header of `useLanguageServer` for why they are
  // two hooks and not one. No editor instance: its providers are global to Monaco.
  useLanguageServer(editorReady ? monacoRef.current : null, {
    repoPath: project.local_path,
    projectId: project.id,
  });

  // Ghost text from the local model, when the user has turned it on and downloaded one. Also no
  // editor instance and for the same reason: `registerInlineCompletionsProvider` is global.
  useInlineCompletion(editorReady ? monacoRef.current : null);

  useTypeScript(editorReady ? editorRef.current : null, editorReady ? monacoRef.current : null, {
    repoPath: project.local_path,
    projectId: project.id,
    activePath,
    /**
     * "Install it" on an import the project does not have — the quick fix's other half.
     *
     * Opens the same picker the dependency lens opens, with the name already searched, rather than
     * running an install straight from a lightbulb: the package may not be the one meant, may not
     * exist, and writing a lockfile is a thing to be looked at before it happens.
     *
     * **The root manifest**, not the nearest one. A file deep in `src` has no manifest of its own,
     * and picking one by walking up would be a second, quieter answer to the question
     * `useManagerFor` already answers for the lens — the dialog says where it will install, so the
     * one case this gets wrong in a monorepo is visible before anything is written.
     */
    onInstallPackage: (name, dev) =>
      useNpmInstallStore.getState().open({
        projectId: project.id,
        repoPath: project.local_path,
        manifestPath: PACKAGE_JSON,
        dir: "",
        block: dev ? "devDependencies" : "dependencies",
        manager: rootManager.manager,
        query: name,
      }),
    t,
  });

  // The weight of each imported package, at the end of its import line.
  useImportCost(editorReady ? editorRef.current : null, editorReady ? monacoRef.current : null, {
    repoPath: project.local_path,
    activePath,
  });

  usePackageJsonLens(editorReady ? editorRef.current : null, editorReady ? monacoRef.current : null, {
    activePath,
    // The arrow opens the menu below rather than starting anything. Everything about *how* to run
    // — which manager, or just give me the line — lives there, and `runScriptWith` is the one path
    // from a script name to a shell.
    onScriptArrow: (name, at) => setScriptMenu({ x: at.x, y: at.y, script: name }),
    manager: managerFor,
    onChooseManager: (next) => usePackageManagerStore.getState().choose(next as PackageManager | null),
    onAddDependency: (block) => {
      if (manifestDir === null || !activePath) return;
      useNpmInstallStore.getState().open({
        projectId: project.id,
        repoPath: project.local_path,
        manifestPath: activePath,
        dir: manifestDir,
        block,
        manager,
      });
    },
    t,
  });

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
    void import("../../lib/dbml/parse")
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
    if (dbmlLoadError) return { ...EMPTY_SCHEMA, error: dbmlLoadError };
    return null;
  }, [previewKind, content, parseDbml, dbmlLoadError]);
  /** `null` schema on a `.dbml` file means the parser hasn't landed yet — the one case the diagram
   * must show as a wait rather than as an empty schema. */
  const dbmlLoading = previewKind === "dbml" && dbmlSchema === null;
  /** Whether the file has an uncommitted change at all, where its changed lines are, and which side
   * that change is on. Comes from the store's narrow list diff, which answers all three exactly as it
   * always did — what it cannot answer is what the *whole file* looked like before, which is
   * `fullActiveDiff` below. */
  const activeDiffEntry = activePath ? fileDiffFor(activePath) : undefined;
  const activeDiff = activeDiffEntry?.file;
  /** Which commit's change this tab is showing, or `null` for the working one. */
  const compare = activeTab?.compare ?? null;
  // A tab left in diff mode whose change then goes away — committed, discarded, staged from
  // under it — falls back to the code rather than to an empty pane. A tab aimed at a *commit* is
  // exempt: that change exists whether or not the file is currently dirty, and without this clause a
  // commit diff of a clean file would close itself the moment it opened.
  const viewMode: ViewMode =
    activeTab?.viewMode === "diff" && !activeDiff && !compare ? "code" : (activeTab?.viewMode ?? "code");

  /**
   * What the side-by-side is a view of, as a cache key.
   *
   * Two shapes, because the two questions are invalidated by different things. A working diff is keyed
   * on its *content* (see `diffSignature`), since git rebuilds it several times a second and the object
   * identity is worthless. A commit diff is keyed on the oid alone: a commit is immutable, so there is
   * nothing for a signature to notice — and the `compare` branch deliberately wins, because a tab
   * aimed at a commit should not refetch every time the working copy of the file moves under it.
   *
   * `\0` is the escape, not a raw NUL byte. This line used to hold two literal NULs, which is enough to
   * make `file` report the source as binary data and make the toolchain's `grep -I` skip it entirely.
   */
  const activeDiffKey = useMemo(() => {
    if (!activePath) return null;
    if (compare) return `${project.local_path}\0${activePath}\0${compare.oid}`;
    return activeDiff ? `${project.local_path}\0${activePath}\0${diffSignature(activeDiff)}` : null;
  }, [project.local_path, activePath, activeDiff, compare]);
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
      setFullDiff({ path: activePath, key: activeDiffKey, file: cached.file });
      return;
    }
    let cancelled = false;
    const path = activePath;
    void loadFullFileDiff(project.local_path, path, activeDiffKey, compare?.oid).then((file) => {
      if (!cancelled && file) setFullDiff({ path, key: activeDiffKey, file });
    });
    return () => {
      cancelled = true;
    };
  }, [activeDiffKey, activePath, project.local_path, compare?.oid]);

  /**
   * What the side-by-side actually renders.
   *
   * Matched on the *path*, not on the key: while a refetch triggered by an edit is in flight the
   * pane keeps showing the copy from a moment ago rather than blanking, which is no more stale than
   * a diff already is between two watcher ticks. Matching on the key would drop the whole editor on
   * every keystroke that reached disk.
   *
   * A *commit* diff is the exception and is matched on the key as well: the stale copy in that case is
   * a different question's answer — the working change, or another commit's — sitting under a
   * breadcrumb naming this one, which is not "slightly out of date" but wrong. There is nothing to
   * lose by waiting, either, since a commit diff is fetched once and then cached forever.
   */
  const fullActiveDiff =
    fullDiff && fullDiff.path === activePath && (!compare || fullDiff.key === activeDiffKey)
      ? fullDiff.file
      : null;
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

  /**
   * The file's change, cut into hunks (what the peek pages through) and gutter marks (what opens it).
   *
   * Keyed on the diff's *content* rather than on the object, and that is not an optimisation:
   * `fileDiffFor` re-identifies on every `refreshStatus` and the watcher fires several times a second,
   * so an object dependency would rebuild both arrays — and re-lay the peek's view zone — on every tick
   * of a build touching an unrelated file. Same device, same reason, as `activeDiffKey` above.
   *
   * Three lines of context is all this needs: every `+`/`-` with its line numbers is present at any
   * context width (see `LIST_DIFF_CONTEXT_LINES`), which is the markers, the hunk boundaries and the
   * peek's body. It is *also* why the store's narrow arrays are used rather than `fullActiveDiff` —
   * the whole-file fetch is pinned at a million context lines, which collapses a modified file into one
   * hunk covering everything and would leave the counter permanently reading "1 of 1".
   */
  const diffKey = activeDiff ? diffSignature(activeDiff) : null;
  const { blocks, marks } = useMemo(
    () => changeBlocksOf(activeDiff),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diffKey],
  );

  // Marks changed lines directly on Monaco's own minimap + overview ruler + gutter, rather
  // than a bespoke strip — this *is* the "code map" the Changes tab has, just reused where
  // Monaco already renders one.
  //
  // Three colours where there was one, and a wedge for the case that used to draw nothing at all —
  // see `MARK_STYLES` and `lib/diffBlocks.ts`. `themeMode` stays in the dependency list because the
  // minimap and ruler entries take a colour value rather than a class, so they have to be re-read from
  // CSS after a theme repaint; the overview-ruler lane stays `Left` because `Right` is bookmarks' and
  // anchors'.
  useEffect(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    // A disposed editor (Monaco unmounted for preview-only mode, or between tab closes)
    // reports no model — bail instead of poking at its internals.
    const model = ed?.getModel();
    if (!ed || !mon || !activePath || !model) return;
    const lineCount = model.getLineCount();
    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = marks.map((mark) => {
      const style = MARK_STYLES[mark.kind];
      const color = resolveCssColor(style.token, style.fallback);
      // A deletion at the end of the file anchors one line past the last one there is — clamp, or the
      // decoration is silently dropped and the only change with no line of its own becomes invisible
      // again. Both ends, because a hunk's marks are computed from the diff rather than from the buffer
      // and an unsaved edit can shorten the file under them.
      const start = Math.min(Math.max(mark.start, 1), lineCount);
      const end = Math.min(Math.max(mark.end, start), lineCount);
      return {
        range: new mon.Range(start, 1, end, 1),
        options: {
          // Only for the two kinds that have a line to tint: `isWholeLine` on a deletion's anchor
          // would wash the surviving line in red.
          isWholeLine: style.line !== null,
          ...(style.line ? { className: style.line } : {}),
          linesDecorationsClassName: style.gutter,
          minimap: { color, position: mon.editor.MinimapPosition.Inline },
          overviewRuler: { color, position: mon.editor.OverviewRulerLane.Left },
        },
      };
    });
    const previous = decorationIdsRef.current.get(activePath) ?? [];
    decorationIdsRef.current.set(activePath, ed.deltaDecorations(previous, decorations));
  }, [marks, activePath, themeMode, editorReady, activeTab?.loading]);

  // ---------------------------------------------------------------------------
  // Inline change peek
  // ---------------------------------------------------------------------------

  /**
   * The zone currently up in this pane, mirrored in a ref because everything that has to take it down
   * runs from a listener or a cleanup rather than from a render.
   *
   * `block` is kept alongside the index so the survive-a-tick effect below has something to compare
   * against: the index alone cannot tell "the same hunk, three lines lower" from "a different hunk that
   * happens to be fourth now", and staging the second when the user pointed at the first is the failure
   * this whole design is arranged around.
   *
   * Per-pane, not per-model — two splits on one file share a Monaco model by design
   * (`lib/editorModel.ts`), so a peek keyed by model would be shared and closing one would blank the
   * other. Two panes reading two different hunks of one file is the correct answer, and it is the same
   * call the blame decoration makes one section down.
   */
  const peekRef = useRef<{ blockIndex: number; block: ChangeBlock; zoneId: string; dom: HTMLDivElement } | null>(
    null,
  );
  /** The same thing as state, so React has somewhere to portal into. */
  const [peek, setPeek] = useState<{ blockIndex: number; dom: HTMLDivElement } | null>(null);
  /** A **sixth** decoration id list, for the wash over the hunk being peeked. Its own list for the
   *  reason each of the other five has one: it changes on a click, which is neither a watcher tick nor
   *  a keystroke nor a caret move. */
  const peekDecorationsRef = useRef<string[]>([]);

  // Read by the gutter listener and by the shortcut nav, both of which are registered once and would
  // otherwise close over whichever change was on screen at mount.
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const marksRef = useRef<GutterMark[]>(marks);
  marksRef.current = marks;

  /**
   * Takes the panel down: the zone, the highlight, both copies of the state.
   *
   * Re-reads `editorRef.current` and its model rather than trusting anything captured, which is the
   * guard triple every effect in this file opens with. It matters more here than for the decorations:
   * this also runs as an unmount cleanup, when the editor underneath may already be on its way out.
   *
   * Stable — no dependencies — so the listener below can be registered once per editor instance and the
   * re-arm effect never re-fires for a reason that is really just a moved prop.
   */
  const closePeek = useCallback(() => {
    const ed = editorRef.current;
    const current = peekRef.current;
    if (ed && current && ed.getModel()) {
      ed.changeViewZones((accessor) => accessor.removeZone(current.zoneId));
      if (peekDecorationsRef.current.length > 0) {
        peekDecorationsRef.current = ed.deltaDecorations(peekDecorationsRef.current, []);
      }
    }
    peekRef.current = null;
    setPeek(null);
  }, []);

  /**
   * Puts the panel up at a hunk, or moves it to another one.
   *
   * One function for open, navigate and re-lay, because all three are "the zone should now be at block
   * N": the previous zone is removed and a new one added inside a single `changeViewZones` batch, so
   * there is never a frame with two panels or none. `layoutZone` would have been the narrower tool for
   * the re-lay case, but it only rescans the anchor — a hunk that grew also needs a new height, and two
   * code paths for one operation is how the height and the anchor end up disagreeing.
   *
   * The DOM node is deliberately **reused** across calls. It is what React is portalling into, so
   * creating a fresh one would unmount and remount the panel — flashing it on every watcher tick that
   * touched an unrelated file, and throwing away the spinner state of an action in flight.
   *
   * `afterLineNumber = firstLine - 1` puts the panel *above* the hunk with the changed lines still
   * visible under it; `0` is legal and means "before line 1", which is what a change at the top of the
   * file needs.
   */
  const openPeek = useCallback((blockIndex: number, opts?: { reveal?: boolean }) => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !mon || !model) return;
    const block = blocksRef.current[blockIndex];
    if (!block) return;
    const previous = peekRef.current;
    const dom = previous?.dom ?? document.createElement("div");
    const lineCount = model.getLineCount();
    const anchor = Math.min(Math.max(block.firstLine, 1), lineCount);
    let zoneId = "";
    ed.changeViewZones((accessor) => {
      if (previous) accessor.removeZone(previous.zoneId);
      zoneId = accessor.addZone({
        afterLineNumber: Math.max(0, anchor - 1),
        heightInPx: peekHeightOf(block.lines.length),
        domNode: dom,
      });
    });
    // After the batch, not before: `addZone` writes `width: 100%` onto the node itself — see
    // `sizePeekDom`, which is where that costs a wrong-width panel if this line moves back up.
    sizePeekDom(ed, dom);
    peekRef.current = { blockIndex, block, zoneId, dom };
    setPeek({ blockIndex, dom });
    peekDecorationsRef.current = ed.deltaDecorations(peekDecorationsRef.current, [
      {
        range: new mon.Range(anchor, 1, Math.min(Math.max(block.lastLine, anchor), lineCount), 1),
        options: { isWholeLine: true, className: "cf-editor-peek-hunk" },
      },
    ]);
    // Only when the user asked to be here. A relayout triggered by the watcher must not scroll the file
    // out from under them, and `IfOutsideViewport` would still do exactly that when a hunk that was
    // partly visible stopped being so.
    if (opts?.reveal !== false) ed.revealLineInCenterIfOutsideViewport(anchor);
  }, []);

  const openPeekRef = useRef(openPeek);
  openPeekRef.current = openPeek;

  /**
   * Next/previous change, wrapping — the buttons in the panel and ⌥F5/⇧⌥F5 both land here so the two
   * can never disagree about where "next" goes.
   *
   * With a peek already up it steps from that hunk. With none it steps from the **caret**, which is
   * what makes the shortcut mean "the next change from where I am" rather than "the first change in the
   * file" every time it is pressed — the difference between navigation and a reset.
   *
   * The caret is never moved. Moving it would fire the blame pass and rewrite the status bar for what
   * was, from the user's side, a mouse click on an arrow.
   */
  const gotoBlock = useCallback((delta: number) => {
    const list = blocksRef.current;
    if (list.length === 0) return;
    const current = peekRef.current?.blockIndex;
    if (current !== undefined) {
      openPeekRef.current((current + delta + list.length) % list.length);
      return;
    }
    const caret = editorRef.current?.getPosition()?.lineNumber ?? 1;
    // Hand-rolled rather than `findLastIndex`, which needs the ES2023 lib this project does not target.
    let found = -1;
    if (delta > 0) {
      found = list.findIndex((block) => block.firstLine > caret);
    } else {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].lastLine < caret) {
          found = i;
          break;
        }
      }
    }
    // Nothing ahead (or behind) means wrap to the other end, which is what the counter in the header is
    // there to make legible.
    openPeekRef.current(found >= 0 ? found : delta > 0 ? 0 : list.length - 1);
  }, []);

  const gotoBlockRef = useRef(gotoBlock);
  gotoBlockRef.current = gotoBlock;
  // Re-registered whenever focus moves here, exactly as the snapshot and bookmark channels are, so
  // ⌥F5 reaches the pane the user is looking at rather than whichever one was mounted last.
  useEffect(() => {
    if (focused) registerChangeNav((delta) => gotoBlockRef.current(delta));
  }, [focused, registerChangeNav]);

  /**
   * A **third** `onMouseDown`, for the lines-decorations lane.
   *
   * Its own listener rather than a branch inside either of the other two, which is the shape this file
   * already establishes and argues for: separate concern, separate lifetime, and Monaco is happy to have
   * all three. Registered on `editorReady` and explicitly disposed, because toggling preview/diff mode
   * unmounts Monaco and re-runs `handleMount` on a new instance.
   *
   * The lane, **not** the glyph margin: that one is already the breakpoint's, and the lane widths were
   * tuned so exactly two marks fit in the decorations lane. Nothing else in the app listens for
   * `GUTTER_LINE_DECORATIONS` — a bookmark on the same line is no conflict, since bookmarks are toggled
   * from the context menu and a chord, never from a gutter click.
   */
  useEffect(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon) return;
    const click = ed.onMouseDown((event) => {
      if (event.target.type !== mon.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const line = event.target.position?.lineNumber;
      if (!line) return;
      // A line carrying a script's run arrow belongs to the arrow. Monaco notifies every
      // `onMouseDown` subscriber independently — there is no stopping one from another — so the
      // yielding has to be explicit, and it is done here because this lane was the peek's first
      // and the arrow is the newcomer. Without it, pressing run on a script line you had also
      // edited would start the script *and* open the diff over it.
      const owned = ed
        .getLineDecorations(line)
        ?.some((d) => d.options.linesDecorationsClassName === "cf-script-glyph");
      if (owned) return;
      const mark = marksRef.current.find((m) => line >= m.start && line <= m.end);
      if (mark) openPeekRef.current(mark.blockIndex);
    });
    // Dragging a split's boundary, opening the Changes dock, toggling the sidebar: `automaticLayout`
    // relays the editor, but the zone's width is ours to maintain — see `sizePeekDom`. Cheap enough to
    // do unconditionally, and it does nothing at all while no peek is open.
    const layout = ed.onDidLayoutChange(() => {
      const current = peekRef.current;
      if (current) sizePeekDom(ed, current.dom);
    });
    return () => {
      click.dispose();
      layout.dispose();
    };
  }, [editorReady]);

  /**
   * Closes the peek on the way out of anything that could leave it pointing somewhere else, and does it
   * **first** — the same discipline the blame re-arm effect below opens with.
   *
   * View zones belong to the editor rather than the model, so the peek does not inherit the orphaned-id
   * bug a model-keyed decoration list would have. But `afterLineNumber` is a line number in whatever
   * file is now on screen, so leaving the panel up for even one frame after a tab switch would draw the
   * previous file's hunk over an unrelated one — with buttons that would then act on the file named in
   * the header rather than the one under it. Hence unconditional, and hence a cleanup as well, which is
   * what covers this pane being closed or the whole group unmounting.
   *
   * `viewMode` covers the way out of code mode (diff and preview unmount Monaco entirely) and
   * `editorReady` the way back in — the two dependencies the blame effect names for the same reason.
   */
  useEffect(() => {
    closePeek();
    return closePeek;
  }, [activePath, editorReady, viewMode, closePeek]);

  /**
   * Whether the panel survives a watcher tick.
   *
   * A tick that found the same change re-lays nothing — the memo above returned the same arrays, so this
   * does not run. A tick that found a *different* change is the case that matters: the hunk on screen may
   * not exist any more, and a panel offering to stage a hunk git no longer has is a button that will
   * fail. So the peek survives only when the block at its index is still the same hunk, and otherwise
   * closes — which is also what happens when the user stages it from the panel itself.
   *
   * When it does survive it is re-laid rather than left alone: the same hunk one line longer needs a
   * taller zone, and the same hunk after an edit above it needs a different anchor.
   */
  useEffect(() => {
    const current = peekRef.current;
    if (!current) return;
    const block = blocks[current.blockIndex];
    if (!block || !sameHunk(block, current.block)) {
      closePeek();
      return;
    }
    openPeekRef.current(current.blockIndex, { reveal: false });
  }, [blocks, closePeek]);

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

  // ---------------------------------------------------------------------------
  // Line blame
  // ---------------------------------------------------------------------------

  /**
   * A **fifth** decoration id list, and the fastest-moving of the five.
   *
   * The rule the other four already state applies hardest here: a concern with its own rhythm gets its
   * own id list, or every update clobbers the others. The git markers change on a watcher tick, the
   * anchors on a keystroke, this one on a *caret move*. Per-pane rather than per-model on purpose —
   * two panes showing one file share a single Monaco model by design (`lib/editorModel.ts`), so a set
   * keyed by model would be shared and one pane clearing it would blank the other's annotation. Two
   * panes with carets on different lines showing two annotations is the correct answer, and it is why
   * the decoration cannot live on the file.
   */
  const blameDecorationsRef = useRef<string[]>([]);
  /** The line the annotation is currently drawn on, so the click can tell "the label" from "some text
   *  that happens to be on another line". `null` when nothing is annotated. */
  const annotatedLineRef = useRef<number | null>(null);
  /** The hunk behind that annotation — what the click opens. `null` for a file with no blame to give
   *  (untracked, no HEAD), which is a label the click has to treat as inert-ish; see the handler. */
  const annotatedHunkRef = useRef<BlameHunkInfo | null>(null);
  const blameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Numbers the passes, so a blame that resolves after the caret has moved on is dropped rather than
   *  drawn. Overlap is rare behind a 250 ms debounce but a slow first blame plus a keypress is enough. */
  const blamePassRef = useRef(0);

  const blameEnabled = usePreferencesStore((s) => s.blameAnnotationEnabled);
  /**
   * The commit the blame cache is keyed against.
   *
   * Selected as a *string* rather than as `s.status`, which matters: the watcher rebuilds `status`
   * several times a second, and subscribing to the object would re-render every editor pane on every
   * tick. The oid only changes on a commit, amend, checkout, reset, merge or rebase — which is exactly
   * when a blame stops being true — so zustand bails out of the render the rest of the time. This is
   * also the whole of the invalidation story: no event to listen for, no timer, no extra IPC call.
   */
  const headOid = useRepoStore((s) => s.status?.head_oid ?? null);
  /** For the hover's absolute date. The label's relative one goes through `t`. */
  const language = useLanguageStore((s) => s.language);

  // Read by the mouse handler and by the pass, both of which are wired once and would otherwise close
  // over whichever file/state was current at mount.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  /** Whether git sees *any* change to this file — staged or unstaged. A boolean rather than the diff
   *  object, so it can be a dependency without re-arming on every watcher tick (see the effect below);
   *  it decides both which blame is asked for and whether the label has anywhere to click through to. */
  const hasWorkingDiff = Boolean(activeDiff);
  const hasWorkingDiffRef = useRef(false);
  hasWorkingDiffRef.current = hasWorkingDiff;
  const onOpenCommitDiffRef = useRef(onOpenCommitDiff);
  onOpenCommitDiffRef.current = onOpenCommitDiff;

  /**
   * Takes the annotation down and gives up the status-bar slot.
   *
   * The focused pane *claims* the slot with an empty string rather than clearing it, which is the
   * difference between "this pane has nothing to say" and "some other pane owns this": a plain guarded
   * `clear` would leave the previously focused pane's answer on the bar until this one's first pass
   * landed 250 ms later, which reads as the bar lying about which line you are on.
   */
  const clearBlame = useCallback(() => {
    const ed = editorRef.current;
    if (ed && ed.getModel() && blameDecorationsRef.current.length > 0) {
      blameDecorationsRef.current = ed.deltaDecorations(blameDecorationsRef.current, []);
    }
    annotatedLineRef.current = null;
    annotatedHunkRef.current = null;
    const store = useCursorBlameStore.getState();
    if (focusedRef.current) store.set(groupId, "");
    else store.clear(groupId);
  }, [groupId]);

  /**
   * Annotates the caret's line — the body of the debounce, and the only thing here that can cost IPC.
   *
   * The order of the bails is the design. Each one is a case where *no* label is the right answer, and
   * each is cheaper than the one below it:
   *
   * 1. the setting, read imperatively rather than through the subscribed value, for the same reason
   *    `activePathRef` exists — this runs from a listener wired at mount. "Off" means no blame call at
   *    all, so this is deliberately the first statement;
   * 2. **multiple carets** — N carets are N answers, and the annotation is a sentence about "the line
   *    you are on"; N grey labels turn a file into a wall of them. Same call GitLens makes;
   * 3. **a non-empty selection** — a drag-select would flicker the label from line to line, and a
   *    multi-line selection has no single author. The mirror of the convention `cf-inline-edit`
   *    already uses, where an empty selection is what implies the current line;
   * 4. **a binary file** — nothing to annotate;
   * 5. a hunk that does not cover the caret, which is how a blame computed against a different text
   *    than the one on screen presents itself. Saying nothing beats crediting the wrong commit.
   *
   * A cache miss draws **nothing** while the blame is in flight: no spinner, no placeholder. A label
   * that flickers in and is then replaced is worse than one that appears 200 ms later, and this is the
   * end of a line of code rather than a panel with room for a loading state.
   */
  const runBlamePass = useCallback(async () => {
    if (!usePreferencesStore.getState().blameAnnotationEnabled) return;
    const ed = editorRef.current;
    const mon = monacoRef.current;
    const model = ed?.getModel();
    const path = activePathRef.current;
    if (!ed || !mon || !model || !path || !activeTab || activeTab.loading) {
      clearBlame();
      return;
    }
    const selections = ed.getSelections();
    const position = ed.getPosition();
    if (!selections || !position || selections.length > 1 || !selections[0].isEmpty()) {
      clearBlame();
      return;
    }
    const line = position.lineNumber;

    // The annotation must never be left sitting on a line the caret has left, so it comes down *before*
    // the fetch rather than being replaced after it — otherwise a blame that isn't cached (which is
    // every blame of an unsaved buffer, by design) would leave the previous line's label up, reading as
    // an annotation that has got stuck. Only the decoration: the status bar keeps the last answer for
    // the moment the blame is in flight, because a bar that blanks between keystrokes flickers, where a
    // label on the wrong line misinforms. On the cached path the replacement lands in the same
    // microtask, before paint, so this costs nothing there.
    if (annotatedLineRef.current !== null && annotatedLineRef.current !== line) {
      blameDecorationsRef.current = ed.deltaDecorations(blameDecorationsRef.current, []);
      annotatedLineRef.current = null;
      annotatedHunkRef.current = null;
    }

    /**
     * What actually gets blamed: the text on screen whenever it can differ from HEAD, and the
     * committed file only when it cannot.
     *
     * The buffer path is `blame_buffer`, i.e. `git blame --contents -`, so a line the user just
     * inserted comes back `uncommitted` instead of inheriting whatever used to sit at that line
     * number. It bypasses the cache in both directions: the answer is a function of the buffer, so
     * caching it would mean one entry per keystroke, all but the last already wrong.
     *
     * **The condition is not `dirty`, and that is the whole point of this comment.** `originalContent`
     * is the file as it was read *from disk*, not as it is in HEAD, and libgit2's committed blame reads
     * the blob at `newest_commit` and never looks at the working copy — pinned by
     * `the_committed_blame_is_of_head_and_never_of_the_working_copy` in `git/blame.rs`. So keying on
     * `dirty` alone annotated every file with uncommitted changes that the user had merely *opened*
     * against HEAD's line numbering: each line after the first divergence credited to whichever commit
     * owns the line now at that number, and the tail past HEAD's line count silently unlabelled by
     * `hunkForLine`. Plain `git blame` reports those lines as "Not Committed Yet", which is exactly
     * what the buffer path produces.
     *
     * `hasWorkingDiffRef` covers the rest of "can differ from HEAD": a change git can see, staged or
     * unstaged, both of which put the on-screen text out of step with the commit. The cost is that a
     * modified file is never served from the cache and pays a blame per pass — that is the price of the
     * annotation being true, it is one text diff on top of a revwalk libgit2 has to do either way, and
     * it lands only on files a terminal `git blame` would also have to re-read. A clean file is
     * untouched: still the cached, whole-file, purely-committed path.
     */
    const buffer =
      activeTab.content !== activeTab.originalContent || hasWorkingDiffRef.current
        ? activeTab.content
        : undefined;
    const token = ++blamePassRef.current;
    let blame;
    try {
      blame = await useBlameStore.getState().load(project.local_path, path, headOid ?? "", buffer);
    } catch {
      // A blame that failed is not worth a toast: the user asked to read code, not to run git. The
      // label simply doesn't appear, and the next caret move retries.
      clearBlame();
      return;
    }
    // Superseded, or the pane moved on while this was in flight. The model is re-read rather than
    // reused from before the await: toggling preview/diff mode disposes the instance and mounts a new
    // one, and measuring a column against a model that has been replaced is how a decoration ends up
    // on a line that no longer exists.
    if (token !== blamePassRef.current) return;
    const current = editorRef.current;
    const liveModel = current?.getModel();
    if (!current || !liveModel || activePathRef.current !== path) return;
    if (current.getPosition()?.lineNumber !== line || line > liveModel.getLineCount()) return;
    if (blame.state === "binary") {
      clearBlame();
      return;
    }

    const hunk = blame.state === "ok" ? hunkForLine(blame.hunks, line) : null;
    if (blame.state === "ok" && blame.hunks.length > 0 && !hunk) {
      clearBlame();
      return;
    }
    // No blame to give: a file HEAD has never seen, a repository with no commits, or an empty file.
    // Every line of it reads the same, and that is a more useful thing to say than nothing — it is the
    // case `changedLineRanges` cannot see at all, since an untracked file has no working-diff entry.
    const label = hunk ? blameLabel(hunk, t) : t("blame.notCommitted");
    const statusText = hunk ? blameStatusText(hunk, t) : t("blame.notCommitted");
    const hover = hunk ? blameHoverMarkdown(hunk, t, language) : label;
    /**
     * Nothing for a click to open — which is *not* the same as "no commit behind this line".
     *
     * The handler's fallback for a line with no commit is the file's working change, so an uncommitted
     * line in a file git can see a change in does open something. Read the same ref the handler reads,
     * or the cursor promises the opposite of what the click does: with the buffer path now taken for
     * every modified file (see `buffer` above), uncommitted hunks are the common case rather than the
     * rare one, and a `default` cursor over the label of a changed line would be wrong far more often
     * than it was right.
     */
    const inert = (!hunk || hunk.uncommitted || !hunk.commit_id) && !hasWorkingDiffRef.current;
    const column = liveModel.getLineMaxColumn(line);

    blameDecorationsRef.current = current.deltaDecorations(blameDecorationsRef.current, [
      {
        // A zero-width range at the line's last column: the annotation is *injected*, so it renders
        // past the last character and nothing to its left moves. This is the whole reason for choosing
        // injected text over a view zone (which reserves a row and pushes the file down) or a content
        // widget (which would need hand-computed coordinates and would be clipped — this is the one
        // editor in the app that does not spread `OVERFLOW_SAFE_OPTIONS`, inside an `overflow-hidden`
        // pane). It is also what keeps the text out of the document: a decoration is not model content,
        // so `getValue`, `getValueInRange`, Ctrl+C and the code-snapshot capture never see it.
        range: new mon.Range(line, column, line, column),
        options: {
          after: {
            content: `    ${label}`,
            inlineClassName: inert ? "cf-blame-annotation cf-blame-annotation-plain" : "cf-blame-annotation",
            // Otherwise End and the arrow keys step *into* the label, which would make a decoration
            // feel like text you can put a cursor in.
            cursorStops: mon.editor.InjectedTextCursorStops.None,
          },
          // The range above is zero-width, and Monaco drops injected text on an empty range unless
          // this says otherwise — `getInjectedTextInInterval` filters on exactly
          // `showIfCollapsed || !range.isEmpty()`. Without it the decoration is created, survives
          // `getAllDecorations`, and never reaches the view: the annotation simply never appeared.
          // See the long note in `usePackageJsonLens`, where the same omission cost the dependency
          // versions.
          showIfCollapsed: true,
          // Typing at the end of the annotated line is the exact common case, and the default
          // stickiness would drag the decoration along with the insertion.
          stickiness: mon.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          hoverMessage: { value: hover },
          // No `minimap`/`overviewRuler` entry: the caret's line is where the eye already is, and both
          // of those take a hex rather than a class — which is the only reason the git-marker effect
          // above has to carry `themeMode` and read CSS. This decoration is pure CSS, so it doesn't.
        },
      },
    ]);
    annotatedLineRef.current = line;
    annotatedHunkRef.current = hunk;
    if (focusedRef.current) useCursorBlameStore.getState().set(groupId, statusText);
  }, [activeTab, project.local_path, headOid, t, language, groupId, clearBlame]);

  const runBlameRef = useRef(runBlamePass);
  runBlameRef.current = runBlamePass;

  /**
   * Re-arms the trailing timer. Stable — no dependencies — which is what lets the caret listener below
   * be registered once per editor instance instead of re-registered whenever a prop moves.
   *
   * The setting is read here as well as at the top of the pass, so that with blame off a caret move
   * costs a single boolean read and nothing else: no timer armed, no timer cleared, no pass queued.
   * Read imperatively for the same reason the pass does — this runs from a listener wired at mount.
   */
  const scheduleBlame = useCallback(() => {
    if (!usePreferencesStore.getState().blameAnnotationEnabled) return;
    if (blameTimerRef.current !== null) clearTimeout(blameTimerRef.current);
    blameTimerRef.current = setTimeout(() => {
      blameTimerRef.current = null;
      void runBlameRef.current();
    }, BLAME_DEBOUNCE_MS);
  }, []);

  const cancelBlame = useCallback(() => {
    if (blameTimerRef.current !== null) {
      clearTimeout(blameTimerRef.current);
      blameTimerRef.current = null;
    }
    // Anything still in flight resolves into a stale token and is dropped.
    blamePassRef.current += 1;
  }, []);

  /**
   * The caret listener and the click, both registered in an effect keyed on `editorReady` and both
   * explicitly disposed.
   *
   * Deliberately **not** in `handleMount` beside `onDidFocusEditorWidget` and the gutter `onMouseDown`,
   * which are the only other editor listeners in this file and are left to Monaco's own teardown. Those
   * two are self-contained — one calls a ref, the other toggles a breakpoint. This pair drives a timer
   * and writes to a store shared with the status bar, and toggling preview/diff mode unmounts Monaco
   * and re-runs `handleMount` on a *new* instance, so "Monaco will clean it up eventually" is not a
   * strong enough guarantee for something that can outlive the editor it was reading. The
   * `installEditorShortcuts` effect below already establishes this shape: register on `editorReady`,
   * dispose in the cleanup.
   *
   * A second `onMouseDown` rather than a branch inside the existing one, for the same reason: it is a
   * separate concern with a separate lifetime, and Monaco is happy to have both.
   */
  useEffect(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon) return;

    const caret = ed.onDidChangeCursorPosition(() => scheduleBlame());

    const click = ed.onMouseDown((event) => {
      const target = contentTextTarget(event.target, mon);
      if (!target) return;
      /**
       * True precisely when the hit landed on something injected into the line rather than on the
       * line's own text. It is public API (`IMouseTargetContentTextData`), unlike the sibling
       * `detail.injectedText` which exists at runtime but is absent from the typings.
       *
       * **This is unambiguous only because the blame annotation is the sole injected text in this
       * editor.** Adding another `before`/`after` decoration later would break this guard silently, so
       * a second one has to come with a way of telling them apart — `after.attachedData` is there for
       * exactly that, and reading it needs `getInjectedTextAt`, which the public typings do not expose.
       */
      if (!target.detail.mightBeForeignElement) return;
      if (target.position.lineNumber !== annotatedLineRef.current) return;
      const path = activePathRef.current;
      if (!path) return;
      const hunk = annotatedHunkRef.current;
      if (hunk && !hunk.uncommitted && hunk.commit_id) {
        onOpenCommitDiffRef.current(path, {
          oid: hunk.commit_id,
          short_id: hunk.short_id,
          summary: hunk.summary,
        });
        return;
      }
      // No commit behind the line. When the file has a working change, that change *is* what produced
      // this line, so opening it is more useful than a dead label; when there isn't one — a merely
      // unsaved buffer — the click does nothing, which is what `cf-blame-annotation-plain` promises by
      // not showing a pointer.
      if (hasWorkingDiffRef.current) onOpenCommitDiffRef.current(path, null);
    });

    return () => {
      caret.dispose();
      click.dispose();
    };
  }, [editorReady, scheduleBlame]);

  /**
   * Arms a pass without waiting for the caret to move — opening a file, switching tabs, flipping the
   * setting on, taking focus, or HEAD moving under the file all change the answer while the caret sits
   * still. And it clears first, so a tab switch never shows the previous file's author for a frame.
   *
   * `dirty` and `hasWorkingDiff` are in the list because crossing either boundary changes *which* blame
   * is asked for — the committed file or the text on screen, see `buffer` in the pass. Both are
   * booleans on purpose: `activeDiff` itself is rebuilt by the watcher several times a second, so
   * depending on the object would re-arm a pass on every tick. Ordinary keystrokes need no dependency
   * of their own, since typing moves the caret and the listener above catches it.
   *
   * `viewMode` is in the list for the *other* direction: diff and preview mode unmount Monaco entirely
   * (`editorPane` is only rendered for code and split), and nothing else here notices. `editorReady`
   * only counts up, on mount, so without this the pane left the status bar reporting a caret that was
   * no longer on screen — the exact thing `cursorBlameStore`'s one-entry shape exists to bound — with
   * no listener left alive to ever correct it. Clearing on the way out is the whole fix; the pass this
   * also arms finds no model and clears again, which is free.
   */
  useEffect(() => {
    clearBlame();
    if (!blameEnabled) return;
    scheduleBlame();
    return cancelBlame;
  }, [
    blameEnabled,
    activePath,
    editorReady,
    activeTab?.loading,
    dirty,
    hasWorkingDiff,
    viewMode,
    focused,
    headOid,
    language,
    clearBlame,
    scheduleBlame,
    cancelBlame,
  ]);

  // Unmounting a split has to give the slot up, or the bar keeps reporting a caret in a pane that is
  // no longer on screen. Guarded inside the store, so a pane closing after another has already taken
  // the slot leaves that one alone.
  useEffect(() => () => useCursorBlameStore.getState().clear(groupId), [groupId]);

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
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  /** Runs one script with a given manager. Shared by the arrow and by the chooser below. */
  const runScriptWith = (name: string, chosen: PackageManager) => {
    const command = scriptCommandLine(chosen, name);
    if (!command || manifestDir === null) return;
    const cwd = manifestDir ? `${project.local_path}/${manifestDir}` : project.local_path;
    const leaf = manifestDir.split("/").pop();
    void useTerminalStore
      .getState()
      .runCommand(project.id, {
        cwd,
        command,
        reuseKey: `scripts:${activePath}:${name}`,
        title: leaf ? `${leaf} · ${name}` : name,
      })
      .catch((e: unknown) => pushErrorToast(String(e)));
  };

  /**
   * What the arrow beside a script opens.
   *
   * # Why a menu, when one of its entries is what the click used to do on its own
   *
   * Because the arrow had one behaviour and no way to ask for another. Running `dev` with the
   * repository's manager is the common case and is still one item away — but "run this one with
   * yarn to check something", and "give me the line so I can paste it somewhere with a flag on the
   * end", had no answer at all, and *which* manager the arrow would use was only visible in the lens
   * over the block, which scrolls off. This is the shape every editor with a gutter arrow settles
   * on, and for the same reasons.
   *
   * # Two shapes, because one question is genuinely open
   *
   * With the manager settled — a single lockfile, or a choice already made — the first item runs it
   * and the rest are alternatives to it.
   *
   * With more than one lockfile and nothing chosen, there is no right answer available to the app,
   * so the menu asks instead: the candidates are the only entries, and picking one *records* the
   * choice, because being asked the same question on every script in the same repository is its own
   * kind of wrong. `detectPackageManagers` returns them in a fixed order, so taking the first would
   * at least be consistent — and consistently wrong half the time, in a way whose cost is not a
   * wasted click but the wrong tool rewriting a lockfile.
   */
  const scriptMenuItems = (script: string): MenuItem[] => {
    if (managerFor.candidates.length > 1) {
      return managerFor.candidates.map((option) => ({
        label: t("npm.runWith", { manager: option }),
        icon: Play,
        onClick: () => {
          usePackageManagerStore.getState().choose(option);
          runScriptWith(script, option);
        },
      }));
    }
    const items: MenuItem[] = [
      {
        label: t("scripts.menuRun", { name: script }),
        icon: Play,
        onClick: () => runScriptWith(script, manager),
      },
      // A one-off, and deliberately not recorded: `run` rewrites no lockfile, so there is nothing to
      // undo, and wanting one script run another way is not a statement about which manager the
      // repository belongs to. That is what the lens over the `scripts` block is for.
      ...PACKAGE_MANAGERS.filter((option) => option !== manager).map((option, at) => ({
        label: t("npm.runWith", { manager: option }),
        separated: at === 0,
        onClick: () => runScriptWith(script, option),
      })),
    ];
    const command = scriptCommandLine(manager, script);
    // `null` only for a name the whitelist refuses — which the arrow is never drawn for, so this is
    // the same second lock `runScriptWith` applies, not a case anyone will meet.
    if (command) {
      items.push({
        label: t("scripts.menuCopy"),
        icon: Copy,
        separated: true,
        onClick: () => {
          void navigator.clipboard.writeText(command).catch((e: unknown) => pushErrorToast(String(e)));
        },
      });
    }
    return items;
  };

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
    /**
     * Save, as an action on this editor.
     *
     * No keybinding of its own: the chord comes from the registry through
     * `installEditorShortcuts`, like every other editor key. What it buys is that a ⌘S pressed with
     * the caret in the code saves *this* pane's file directly, instead of travelling through a
     * store and a guess about which group is active.
     */
    editorInstance.addAction({
      id: "cf-save",
      label: tRef.current("editor.save"),
      run: () => onSaveRef.current(),
    });
    /**
     * Format the document — and say so when nothing can.
     *
     * `isSupported()` is Monaco's own answer to "is there a formatter for this language": it is the
     * precondition on the built-in action. Without this branch, ⇧⌥F in a `.rs`, `.py` or `.yml`
     * file does nothing at all and gives no reason, which is indistinguishable from a broken
     * keybinding — and it is why the key "doesn't always work". It always works; there is not always
     * a formatter behind it, and now it says which of the two you are looking at.
     */
    editorInstance.addAction({
      id: "cf-format",
      label: tRef.current("shortcuts.formatDocument"),
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 1.5,
      run: (ed) => {
        const action = ed.getAction("editor.action.formatDocument");
        if (!action || !action.isSupported()) {
          pushErrorToast(tRef.current("editor.noFormatter", { language: ed.getModel()?.getLanguageId() ?? "" }));
          return;
        }
        void action.run();
      },
    });
    editorInstance.addAction({
      id: "cf-inline-edit",
      label: tRef.current("shortcuts.inlineEdit"),
      run: () => {
        const model = editorInstance.getModel();
        const selection = editorInstance.getSelection();
        const path = activePathRef.current;
        if (!model || !selection || !path) return;
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
        // The range is handed to Monaco to track rather than kept as the plain `IRange` it came in
        // as. The answer can be a minute away, and anything typed above the selection while it is
        // in flight — by the user once the widget's input greys out, or in the other split showing
        // this same buffer — shifts those lines down; a decoration is carried along with its text,
        // so the replacement still lands on what was selected instead of on whatever slid into its
        // line numbers. `NeverGrowsWhenTypingAtEdges` keeps a character typed against either end
        // outside the range: it was not part of what the model was asked to rewrite.
        const [decorationId] = model.deltaDecorations(
          [],
          [
            {
              range,
              options: {
                stickiness: monacoInstance.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            },
          ],
        );
        openInlineEdit({ path, modelUri: model.uri.toString(), selection: text, decorationId });
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

  /**
   * Applies an AI rewrite through Monaco's edit stack, so it joins the undo history and shows up as
   * an ordinary unsaved change instead of appearing from nowhere.
   *
   * Everything before that is a proof that the rewrite is landing in the buffer it was asked about.
   * The reply arrives whenever the provider answers, and by then this pane may be showing a
   * different file: the widget is gone, but the `submit` closure still in flight holds this
   * callback and calls it regardless. Applying it to `editorRef.current` at that point wrote one
   * file's replacement over another file's lines — Monaco *clamps* an out-of-range edit instead of
   * rejecting it, `onChange` then marked the innocent tab dirty, and the undo stack presented the
   * corruption as something the user had typed. So the model is resolved from the URI captured at
   * Ctrl+I, and anything short of "still the same buffer, still the one on screen" is refused.
   *
   * Refusing rather than writing to the off-screen model on purpose. The right buffer is reachable
   * either way, but a rewrite the user never saw arrive, in a file they are no longer looking at,
   * is an unexplained dirty tab waiting for them — and the parent's `onChange` only follows the
   * model a mounted `Editor` is bound to, so the tab registry would not even agree with it.
   *
   * Returns whether the rewrite actually landed, so the widget can report a discarded edit as
   * discarded instead of claiming a success no buffer ever received.
   *
   * `nonce` is the request's own half of that proof, handed back by the caller from the target it
   * was started against. Path and URI only establish the buffer; a second Ctrl+I in the same file
   * while the first is still running passes both of those and would take the first reply onto the
   * second selection.
   */
  const applyInlineEdit = useCallback((replacement: string, nonce: number): InlineEditOutcome => {
    const target = inlineEditRef.current;
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!target || !mon) return "refused";
    if (target.nonce !== nonce || target.path !== activePathRef.current) return "refused";
    // `getModel` answers with the one buffer that URI names, so a hit here is the buffer the
    // selection came out of rather than merely a file with the same name somewhere else.
    const model = mon.editor.getModel(mon.Uri.parse(target.modelUri));
    if (!model || model.isDisposed()) return "refused";
    /**
     * Whether the buffer being rewritten is also the one currently on screen.
     *
     * It used to be a *precondition*, and that is what threw the work away. Leaving the editor for
     * another view — Pipelines, Cambios, the graph — unmounts the pane and with it the Monaco
     * instance, while the model itself survives in Monaco's registry. So a rewrite that was still
     * running came back to `ed` being gone, was refused, and the user returned to the file to find
     * their edit had never happened and a line in the notification centre saying it was discarded.
     *
     * The check the identity test was really making is "is this the right *file*", and the two
     * lines above make it: same request, same path, same model URI. Being on screen is not part of
     * that — it only decides whether the user is *watching* it land, which is what the caller uses
     * this answer for.
     */
    const onScreen = ed !== null && model === ed.getModel();
    // Where the selection is *now*. A missing answer is a refusal rather than a fall back on the
    // range Ctrl+I was pressed on: the only thing that drops a decoration is the model being reset
    // wholesale under us (a `setValue`, a reload from disk), which is precisely the case where the
    // original line numbers point at somebody else's code. Falling back would fire only when it is
    // wrong.
    const range = model.getDecorationRange(target.decorationId);
    if (!range) return "refused";
    // Bracketed by stack elements so Ctrl+Z takes the whole rewrite back in one press, and so the
    // user's own typing before and after it stays separately undoable.
    model.pushStackElement();
    model.pushEditOperations([], [{ range, text: replacement, forceMoveMarkers: true }], () => null);
    model.pushStackElement();
    // Only when there is something to focus, and only when it is this buffer: stealing focus back
    // into an editor the user has navigated away from would yank them out of whatever they moved on
    // to in order to show them a change they can find whenever they like.
    if (onScreen) ed?.focus();
    return onScreen ? "applied" : "applied-offscreen";
  }, []);

  /**
   * A file leaving the screen takes its inline edit with it.
   *
   * Not tidiness. The widget floats over the pane and offers to rewrite "these N lines", so leaving
   * it up across a tab switch offers to rewrite a selection that is nowhere on screen — and its
   * `fileContent` prop follows the *new* tab, so submitting it would ask the model to rewrite a
   * fragment of one file in the context of another. A run already in flight is deliberately left
   * alone: it finishes, `applyInlineEdit` refuses it, and the notification centre says the edit was
   * discarded, which is the honest outcome and a far better one than the silent corruption it
   * replaced.
   *
   * Keyed on `activePath` because that is what every way in reduces to — clicking another tab,
   * opening a file from the tree, closing the active tab, Ctrl+Tab, jumping to a search hit. The
   * reveal effect just below has always made the same check for the same reason; this call site was
   * the one that skipped it.
   *
   * Also returned as the cleanup, the way the peek effect above does it and for the same reason:
   * that is what covers this pane being closed or the whole group unmounting, neither of which is a
   * change of `activePath` and both of which would otherwise leave a tracked range on a model that
   * is still open in the other split.
   */
  useEffect(() => {
    if (inlineEditPathRef.current === activePath) return;
    inlineEditPathRef.current = activePath;
    closeInlineEdit();
  }, [activePath, closeInlineEdit]);

  /**
   * The pane going away, which is **not** the same thing as the file changing.
   *
   * Leaving the editor for another view — Pipelines, Cambios, the graph — unmounts this pane and
   * disposes its Monaco instance, while the models themselves stay in Monaco's registry. The
   * cleanup used to be `closeInlineEdit` for both cases, so a rewrite the user had started and then
   * navigated away from was refused when it came back: the work was thrown away, and the only trace
   * was a line in the notification centre calling it discarded. `applyInlineEdit` now takes an
   * off-screen buffer, so all this has to do is *not* destroy the request on the way out.
   *
   * Only while something is actually running, though. A widget the user opened and abandoned
   * without submitting is a text box with a tracked range attached, and leaving that behind is the
   * decoration leak `closeInlineEdit` was written to prevent — one hidden range per Ctrl+I, for as
   * long as the file stays open.
   */
  useEffect(
    () => () => {
      if (!inlineEditRunningRef.current) closeInlineEdit();
    },
    [closeInlineEdit],
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
  const dropZone = dropOver?.groupId === groupId && dropOver.zone !== "strip" ? dropOver.zone : null;
  const bodyDropProps = { "data-cf-panebody": groupId };

  /**
   * Where the file would land, drawn on the pane it would land in.
   *
   * The middle keeps the outline it always had — the whole pane, meaning "into this group". An edge
   * paints the *half* the new pane would occupy, because that is the only part of the answer that
   * is not obvious: which side, and how much of the screen it takes. Half is not an approximation;
   * a new column or a new row starts at an even share (see `EditorView`), so the shape shown is the
   * shape you get.
   */
  const dropOverlay = dropZone ? (
    <div
      className={`pointer-events-none absolute z-20 rounded-lg border-2 border-dashed border-[var(--cf-accent)] bg-[var(--cf-accent)]/10 ${
        dropZone === "body"
          ? "inset-1"
          : dropZone === "left"
            ? "bottom-1 left-1 top-1 w-1/2"
            : dropZone === "right"
              ? "bottom-1 right-1 top-1 w-1/2"
              : dropZone === "top"
                ? "left-1 right-1 top-1 h-1/2"
                : "bottom-1 left-1 right-1 h-1/2"
      }`}
    />
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
           * Ghost text. On for every editor, because the provider — not this flag — is what decides
           * whether there is anything to draw: with the feature off, no model downloaded, or a
           * buffer belonging to none of the surfaces it serves, `lib/inlineCompletion` returns
           * nothing and this costs a branch. (Those surfaces are this editor, the DBML workbench
           * and the database console — see `SURFACES` there.)
           *
           * `subwordSmart` rather than the `prefix` default: it keeps the suggestion on screen when
           * the user types a character the model also predicted but in a different position within
           * the word, which with a small model is most of the time. `keepOnBlur` is deliberately
           * left off — a suggestion still hanging there after you click away is a suggestion you
           * accept by accident.
           */
          inlineSuggest: { enabled: true, mode: "subwordSmart", showToolbar: "onHover" },
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
                    pressing it twice is the way out.

                    `compare` is the second way a file can have something to compare — a commit reached
                    from a blame annotation, which exists whether or not the working copy is dirty.
                    Leaving diff view is what forgets the commit (see `onViewMode` in `EditorView`), so
                    pressing this twice from a commit diff lands on the ordinary working diff rather than
                    on the same commit for the rest of the tab's life. */}
                {(activeDiff || compare) && (
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
          <Breadcrumb
            path={activeTab.path}
            dirty={dirty}
            loading={activeTab.loading}
            // Keyed on what is on screen rather than on what the tab remembers. Today the two cannot
            // disagree — every exit from diff view goes through `onViewMode`, which clears `compare` —
            // but the breadcrumb's job is to name the thing being read, and a commit named over the
            // editable file would be the worst possible way to find that invariant had broken.
            compare={viewMode === "diff" ? compare : null}
          />
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
            {/* The path check is what the effect above enforces, asserted here so the render can
                never disagree with it: the effect runs *after* the commit that changed `activePath`,
                so for exactly one frame `inlineEdit` still names the file that just left while
                `content` is already the new one's. One frame is enough to hand the widget a
                mismatched path/content pair, which is the pair it would submit. */}
            {inlineEdit && inlineEdit.path === activeTab.path && (
              <InlineEditWidget
                // A press is a new widget, not the old one re-pointed. Without this, pressing Ctrl+I
                // again while a rewrite is in flight leaves the previous instance's state in place —
                // its `running` flag still set, so the input for the *new* selection is greyed out
                // and unusable until an answer nobody is waiting for arrives.
                key={inlineEdit.nonce}
                editNonce={inlineEdit.nonce}
                filePath={inlineEdit.path}
                fileContent={content}
                selection={inlineEdit.selection}
                workspaceId={project.workspace_id}
                onApply={applyInlineEdit}
                onRunningChange={(running) => {
                  inlineEditRunningRef.current = running;
                }}
                // Bound to *this* press. An unmounted widget keeps the props of its last render,
                // so the reply a superseded request is still owed closes itself by a nonce that no
                // longer matches — and `closeInlineEdit` ignores it instead of closing its
                // successor. See the guard there.
                onClose={() => closeInlineEdit(inlineEdit.nonce)}
              />
            )}
            {/* The change peek lives *inside* Monaco — a view zone's DOM node, reached by a portal — so
                unlike the widget above it is not positioned by this box at all. It is rendered from here
                anyway because that is where the React tree is: the panel wants `useT`, the confirm store
                and `lineClasses`, none of which hand-built DOM would have.

                Both guards are load-bearing rather than defensive. `peek` is only ever set while Monaco
                is mounted, but a render can land between a diff arriving and the survive-a-tick effect
                running, and the block behind the index may have gone in that gap. */}
            {peek &&
              activeDiffEntry &&
              blocks[peek.blockIndex] &&
              createPortal(
                <ChangePeek
                  path={activeTab.path}
                  status={activeDiffEntry.file.status}
                  staged={activeDiffEntry.staged}
                  block={blocks[peek.blockIndex]}
                  blockIndex={peek.blockIndex}
                  total={blocks.length}
                  onNext={() => gotoBlock(1)}
                  onPrev={() => gotoBlock(-1)}
                  onClose={closePeek}
                />,
                peek.dom,
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
      {/* The script menu, at the arrow that opened it. Its heading is the ambiguity when there is
          one — with a settled manager the items name themselves and a heading would only repeat
          them. */}
      {scriptMenu && (
        <ContextMenu
          x={scriptMenu.x}
          y={scriptMenu.y}
          heading={managerFor.candidates.length > 1 ? t("npm.whichManager") : undefined}
          items={scriptMenuItems(scriptMenu.script)}
          onClose={() => setScriptMenu(null)}
        />
      )}
    </div>
  );
}
