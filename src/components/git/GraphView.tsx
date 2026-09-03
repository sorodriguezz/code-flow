import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { computeGraphLayout, laneColor } from "../../lib/graphLayout";
import { useRepoStore } from "../../state/repoStore";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import * as api from "../../lib/tauri/commands";
import { DiffView } from "./DiffView";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  GitBranch,
  History,
  Loader2,
  RotateCcw,
  Search,
  Tag,
  X,
  type LucideIcon,
} from "lucide-react";
import { useT } from "../../state/languageStore";
import { ContextMenu } from "../common/ContextMenu";
import { matchesCommit } from "../../lib/gitActions";
import { commitMenuItems } from "./commitMenu";
import type { CommitInfo } from "../../types/domain";
import { Skeleton, SkeletonRows } from "../common/Skeleton";
import { fileStatusColor, fileStatusLabelKey, fileStatusLetter } from "../../lib/fileStatus";
import type { CommitRef, FileDiffInfo, RefKind } from "../../types/domain";
import { useFrameThrottle } from "../../lib/frameThrottle";

const ROW_HEIGHT = 30;
const LANE_WIDTH = 16;
const DOT_RADIUS = 4;
const DIFF_MIN = 280;
const DIFF_MAX = 900;
const COL_MIN = 50;
const COL_MAX = 600;
const COLUMN_GAP = 8; // matches Tailwind gap-2

/** The disclosure triangle's column, left of the hash. Fixed, and part of `fixedColumnsWidth`, so
 *  the lane graph's offset stays a subtraction rather than a measurement. */
const CHEVRON_WIDTH = 14;
/** One file inside an expanded commit — shorter than a commit row, because it carries one line of
 *  monospace and no chips. */
const FILE_ROW_HEIGHT = 22;
/** Breathing room above and below an expanded commit's file list, so the first path doesn't sit
 *  flush against the row that owns it. */
const FILE_LIST_PAD = 4;
/** Where a file row's status letter starts: one step further in than the hash above it (`px-3` +
 *  the chevron + its gap), which is what makes the list read as *belonging to* that commit rather
 *  than as more rows in the same table. */
const FILE_INDENT = 12 + CHEVRON_WIDTH + COLUMN_GAP + 14;

/** Rows kept rendered above and below the viewport, so a fast scroll never lands on empty space.
 *  Same idea, same number as the result grid's — see `db/ResultGrid`. */
const OVERSCAN = 12;

/**
 * The two date formats this table draws, built once for the module.
 *
 * `toLocaleDateString(undefined, {…})` reads like it costs nothing and does not: every call hands
 * the engine a *fresh* options object, which it has to resolve into an `Intl.DateTimeFormat` from
 * scratch because it has no way to know it has seen these options before. This table draws two
 * dates per row and can hold five hundred rows, so that was a thousand format resolutions per
 * render — measured at 22-34ms, against 0.59ms with the two instances cached here.
 *
 * `undefined` as the locale is deliberate and must stay: these follow the *system* locale, not the
 * app's `languageStore`. Hoisting preserves that exactly; "fixing" it to the app language would be
 * a behaviour change nobody asked for.
 */
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const FULL_DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function formatDate(ts: number): string {
  return SHORT_DATE.format(new Date(ts * 1000));
}

function formatFullDateTime(ts: number): string {
  return FULL_DATE_TIME.format(new Date(ts * 1000));
}

/** How many chips a row shows before the rest become a counter. The column is ~200px and a chip
 *  with a glyph and a branch name in it is most of a hundred. */
const MAX_REF_CHIPS = 2;

/**
 * The glyph for each kind of ref — and the *only* thing that carries the kind.
 *
 * Colour used to do this job too: local branches accent, tags amber, remotes muted. That was an
 * improvement on the one soft-accent pill they all used to be, and it was still spending the
 * strongest channel on the question you can already answer from the shape. A tag looks like a tag.
 *
 * What colour is now spent on is the question the shape *cannot* answer: **which line in the graph
 * is this?** See [`RefChip`].
 */
const REF_GLYPH: Record<RefKind, LucideIcon> = { branch: GitBranch, remote: Cloud, tag: Tag };

/**
 * One ref, as a chip, in the colour of the lane its commit sits on.
 *
 * **That is the whole point.** The refs column is inches away from the graph and was telling you
 * nothing about it: `feat/thing` came out indigo whether its commit was the tip of the indigo line,
 * the green one or the orange one, so matching a name to a line meant tracing the row across by eye
 * and counting lanes. Painted in `laneColor(lane)` the chip *is* the line — the same hue as the dot
 * beside it and the stroke running out of it — and the match is made before you have finished
 * reading the name.
 *
 * The palette is safe to read as text: the eight lane colours sit in the same 55–70% lightness band
 * as the workspace colours, which is the band chosen precisely because one hex has to work on both
 * themes (see `lib/workspaceColors`).
 *
 * **Three channels, three questions, no overlap.**
 * - *Hue* — which line. From the graph, never from the kind.
 * - *Glyph* — what it is. A branch, a remote-tracking branch, a tag.
 * - *Fill* — how present it is. A remote is an outline with no fill, because it is a record of where
 *   a branch stood on the server rather than a thing in this working copy, and a column where
 *   `origin/*` shouts as loudly as `main` is the column this replaces. The branch you are actually
 *   *on* fills harder and goes semibold — the answer to "where am I", which can only ever be true
 *   on one row.
 *
 * Tags take the pill shape as well as the tag glyph. Cheap, and shape is the one channel that
 * survives both colour-blindness and 10px type, which is where two 9px icons start to converge.
 *
 * `title` rather than the app's own `Tooltip`: the name is *truncated*, not missing, so this is the
 * fallback case that `Tooltip`'s own note reserves for the platform's — and it is per-row in a list
 * that can run to a thousand commits, where a portalled component per chip is a cost with nothing
 * to show for it.
 */
function RefChip({ commitRef, lane, isCurrent }: { commitRef: CommitRef; lane: string; isCurrent: boolean }) {
  const Icon = REF_GLYPH[commitRef.kind];
  const outline = commitRef.kind === "remote";
  return (
    <span
      title={commitRef.name}
      className={`flex min-w-0 shrink items-center gap-1 border px-1.5 py-0.5 text-[10px] ${
        commitRef.kind === "tag" ? "rounded-full" : "rounded"
      } ${isCurrent ? "font-semibold" : "font-medium"}`}
      style={{
        // The lane's own hue for the text, and washes of it for the box. Not a solid fill with
        // white on top, which is what the checked-out branch used to get: at these lightnesses
        // white is comfortable on the indigo and unreadable on the amber, and a treatment that
        // depends on which lane you happen to be on is not a treatment.
        color: lane,
        background: outline ? "transparent" : `color-mix(in oklab, ${lane} ${isCurrent ? 26 : 14}%, transparent)`,
        borderColor: `color-mix(in oklab, ${lane} ${outline || isCurrent ? 55 : 28}%, transparent)`,
      }}
    >
      <Icon size={9} className="shrink-0" />
      <span className="truncate">{commitRef.name}</span>
    </span>
  );
}

/**
 * One changed path inside an expanded commit, as `git status --short` writes it: a letter, then the
 * file.
 *
 * The letter carries the status on its own — colour *and* glyph, `fileStatusColor` and
 * `fileStatusLetter` — rather than the pill of translated text the diff panel puts above each file.
 * That pill is right where one file is the subject and has a header to itself; here the path is the
 * subject and there can be four hundred of them, and four hundred "Modificado" pills would push
 * every filename they annotate past the right edge. The word is still there, in the `title`.
 *
 * A rename shows both halves with an arrow between them, because "R" beside the new path alone is
 * the one status you cannot act on: it tells you a file moved and hides where it moved *from*.
 */
function CommitFileRow({
  file,
  top,
  width,
  selected,
  onSelect,
  t,
}: {
  file: FileDiffInfo;
  top: number;
  /**
   * Where the path stops truncating — the same place the message column above it stops.
   *
   * Without it the row ran the full width of the table and a deep path went straight on under the
   * lane graph, which is a strip this list has no business drawing into: the lanes are painted over
   * the rows (`z-[1]`, so selection can't erase them), so the two would simply overlap.
   */
  width: string;
  selected: boolean;
  /** Opens this file in the diff panel. Passed the path the backend can find it by — see the note
   *  on `path` below. */
  onSelect: (path: string) => void;
  t: ReturnType<typeof useT>;
}) {
  // `new_path` first, `old_path` for a deletion. Either is enough: `get_commit_file_diff` matches
  // a delta on whichever side names the path, which is what makes a deleted file openable at all.
  const path = file.new_path ?? file.old_path ?? "";
  const label =
    file.status === "renamed" && file.old_path && file.new_path && file.old_path !== file.new_path
      ? `${file.old_path} → ${file.new_path}`
      : path;
  const color = fileStatusColor(file.status);
  return (
    <button
      type="button"
      onClick={() => onSelect(path)}
      aria-current={selected ? "page" : undefined}
      title={`${t(fileStatusLabelKey(file.status))} — ${label}`}
      style={{ position: "absolute", left: 0, top, width, height: FILE_ROW_HEIGHT, paddingLeft: FILE_INDENT }}
      className={`flex items-center gap-2 rounded-[5px] text-left text-[12px] transition-colors ${
        selected
          ? "bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)]"
          : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
      }`}
    >
      <span style={{ color }} className="w-3 shrink-0 text-center font-mono text-[11px] font-bold">
        {fileStatusLetter(file.status)}
      </span>
      <span
        className={`truncate font-mono ${
          selected ? "text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

/** Everything left of the diff panel: sticky column headers + the commit rows/graph SVG.
 * Memoized (and reading its own store slices rather than taking props) so dragging the diff
 * panel's resize handle — which only touches `graphDiffWidth` — doesn't force this
 * potentially long commit list to re-render on every pointermove tick. */
const CommitTable = memo(function CommitTable() {
  const allCommits = useRepoStore((s) => s.commits);
  const commitQuery = useRepoStore((s) => s.commitQuery);
  const commitsLoading = useRepoStore((s) => s.commitsLoading);
  const commitsHasMore = useRepoStore((s) => s.commitsHasMore);
  const commitsLoadingMore = useRepoStore((s) => s.commitsLoadingMore);
  const loadMoreCommits = useRepoStore((s) => s.loadMoreCommits);
  const status = useRepoStore((s) => s.status);
  const selectedCommitId = useRepoStore((s) => s.selectedCommitId);
  // The expanded row's file list, and the reason it costs nothing extra: selecting a commit already
  // fetches its diff for the panel on the right, so the inline list is the *paths* out of a payload
  // that is on its way regardless. No second command, no second round trip.
  const commitDiff = useRepoStore((s) => s.commitDiff);
  const commitDiffLoading = useRepoStore((s) => s.commitDiffLoading);
  const selectedCommitPath = useRepoStore((s) => s.selectedCommitPath);
  const selectCommitFile = useRepoStore((s) => s.selectCommitFile);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const undoCommit = useRepoStore((s) => s.undoCommit);
  const colHash = useLayoutStore((s) => s.sizes.graphColHash);
  const colDate = useLayoutStore((s) => s.sizes.graphColDate);
  const colAuthor = useLayoutStore((s) => s.sizes.graphColAuthor);
  const colMessage = useLayoutStore((s) => s.sizes.graphColMessage);
  const colRefs = useLayoutStore((s) => s.sizes.graphColRefs);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const t = useT();

  /**
   * The rows the filter box leaves.
   *
   * Filtered here rather than in the store so the full history stays loaded — clearing the box has
   * to be instant, and re-fetching four pages because somebody deleted a character would be a
   * second of blank table for no reason. `computeGraphLayout` already drops an edge whose parent is
   * outside the list it was given, so a filtered graph loses its lines rather than drawing wrong
   * ones.
   */
  const commits = useMemo(
    () => (commitQuery.trim() ? allCommits.filter((c) => matchesCommit(c, commitQuery)) : allCommits),
    [allCommits, commitQuery],
  );
  const filtering = commitQuery.trim().length > 0;

  /** The row the context menu was opened on, and where to draw it. */
  const [menu, setMenu] = useState<{ commit: CommitInfo; x: number; y: number } | null>(null);

  /**
   * Anything staged or modified. Revert and cherry-pick refuse it — the backend does too, and this
   * is only so the menu can grey the entry and say why rather than failing a second after the click.
   */
  const dirty =
    (status?.staged.length ?? 0) > 0 ||
    (status?.unstaged.length ?? 0) > 0 ||
    (status?.conflicted.length ?? 0) > 0;

  /**
   * The four write operations behind the menu.
   *
   * Each one refreshes the history afterwards rather than mutating the list here: amend and revert
   * both change what HEAD is, and half the screen (the branch strip, the unpushed count, the status
   * bar) reads that from the same refresh.
   */
  const runAndRefresh = async (work: () => Promise<unknown>, done: string) => {
    const repoPath = useRepoStore.getState().repoPath;
    if (!repoPath) return;
    try {
      await work();
      await useRepoStore.getState().refreshAll();
      pushSuccessToast(done);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const openAmend = () => {
    void (async () => {
      const repoPath = useRepoStore.getState().repoPath;
      if (!repoPath) return;
      // Opens on the existing message rather than on an empty box: an amend is almost always a
      // correction to what is already there, and retyping it from memory is how the rest of it
      // gets lost.
      const current = await api.headCommitMessage(repoPath).catch(() => "");
      const message = await promptAction(t("graph.amendPrompt"), {
        initial: current.trim(),
        confirmLabel: t("graph.menuAmend"),
        validate: (value) => (value.trim() ? null : t("graph.amendEmpty")),
      });
      if (message === null) return;
      await runAndRefresh(() => api.amendCommit(repoPath, message), t("graph.amendDone"));
    })();
  };

  const openCreateBranch = (oid: string) => {
    void (async () => {
      const repoPath = useRepoStore.getState().repoPath;
      if (!repoPath) return;
      const name = await promptAction(t("graph.branchHerePrompt"), {
        placeholder: t("graph.branchHerePlaceholder"),
        confirmLabel: t("graph.menuBranchHere"),
        validate: (value) => (value.trim() ? null : t("graph.branchHereEmpty")),
      });
      if (!name) return;
      await runAndRefresh(
        () => useRepoStore.getState().createBranch(name, oid),
        t("graph.branchHereDone", { name }),
      );
    })();
  };

  const openTagModal = (oid: string) => {
    void (async () => {
      const repoPath = useRepoStore.getState().repoPath;
      if (!repoPath) return;
      const name = await promptAction(t("graph.tagPrompt"), {
        placeholder: t("graph.tagPlaceholder"),
        confirmLabel: t("graph.menuTag"),
        validate: (value) => (value.trim() ? null : t("graph.tagEmpty")),
      });
      if (!name) return;
      // A second box rather than one with a convention in it: an annotated tag and a lightweight
      // one are different objects, and "leave it blank for a plain tag" is the honest way to offer
      // the choice without a checkbox nobody reads.
      const message = await promptAction(t("graph.tagMessagePrompt", { name }), {
        placeholder: t("graph.tagMessagePlaceholder"),
        confirmLabel: t("graph.menuTag"),
      });
      if (message === null) return;
      await runAndRefresh(
        () => api.createTag(repoPath, name, oid, message),
        t("graph.tagDone", { name }),
      );
    })();
  };

  const revertHere = async (commit: CommitInfo) => {
    const repoPath = useRepoStore.getState().repoPath;
    if (!repoPath) return;
    const summary = commit.summary;
    if (!(await confirmAction(t("graph.revertConfirm", { summary }), false, t("graph.menuRevert")))) return;
    await runAndRefresh(() => api.revertCommit(repoPath, commit.id), t("graph.revertDone"));
  };

  const cherryPickHere = async (commit: CommitInfo) => {
    const repoPath = useRepoStore.getState().repoPath;
    if (!repoPath) return;
    const summary = commit.summary;
    if (!(await confirmAction(t("graph.cherryPickConfirm", { summary }), false, t("graph.menuCherryPick"))))
      return;
    await runAndRefresh(
      () => api.cherryPickCommit(repoPath, commit.id, true),
      t("graph.cherryPickDone"),
    );
  };

  /** Clipboard, with the same toast every other copy in the app uses. */
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushSuccessToast(t("common.copied"));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const layout = useMemo(() => computeGraphLayout(commits), [commits]);

  /**
   * Which row is open, and how much room its files take under it.
   *
   * **Expansion is selection.** There is deliberately no second piece of state for "which rows are
   * open": the row you have selected is the row whose files are on screen, which is also the row
   * whose diff is in the panel to the right, and clicking it again closes all three at once. One
   * open row is also what keeps the geometry below a subtraction — see `rowTop`.
   *
   * `Math.max(1, …)` because the block always has *something* to say. Zero files is two different
   * answers — the fetch is still out, or the commit really is empty (`--allow-empty`) — and both of
   * them are a line of text, so reserving a row for it means the list doesn't jump by one row's
   * height the moment the diff lands.
   */
  const expandedRow = useMemo(() => {
    if (!selectedCommitId) return null;
    const index = layout.rows.findIndex((r) => r.commit.id === selectedCommitId);
    return index === -1 ? null : index;
  }, [layout.rows, selectedCommitId]);
  const fileCount = expandedRow === null ? 0 : Math.max(1, commitDiff.length);
  const expandedHeight = expandedRow === null ? 0 : fileCount * FILE_ROW_HEIGHT + FILE_LIST_PAD * 2;
  /** Top of the file block: immediately under the commit row that owns it. */
  const blockTop = expandedRow === null ? 0 : (expandedRow + 1) * ROW_HEIGHT;
  /**
   * Where a row sits, once one of them has grown a list underneath it.
   *
   * Everything above the open row is exactly where it was; everything below is pushed down by the
   * whole block. That is the entire cost of variable-height rows here, and it is why only one row
   * may be open at a time: with two, this stops being an if and becomes a prefix sum, and the row
   * lookup below stops being a division and becomes a binary search.
   */
  const rowTop = (row: number) =>
    row * ROW_HEIGHT + (expandedRow !== null && row > expandedRow ? expandedHeight : 0);
  // From HEAD itself, not from whichever branch claims to be head: on a detached HEAD no branch
  // does, and deriving it from the branch list dropped the marker off the graph entirely just
  // when knowing where you are matters most.
  const headCommitId = status?.head_oid ?? null;
  // Null on a detached HEAD, which is the right answer rather than a missing one: no branch is
  // checked out, so no chip should be claiming to be the one you are on.
  const currentBranch = status?.is_detached ? null : (status?.current_branch ?? null);

  const svgWidth = layout.laneCount * LANE_WIDTH + 12;
  /** Every row plus whatever the open one added — the scroll height, and the height the lane graph
   *  has to span so an edge crossing the open row stretches over its files instead of stopping at
   *  them. */
  const contentHeight = layout.rows.length * ROW_HEIGHT + expandedHeight;
  // The chevron, four fixed text columns (message is the fifth and takes the slack), and six
  // `gap-2` seams: one between each pair of the seven children, the last of them before the graph.
  const fixedColumnsWidth = CHEVRON_WIDTH + colHash + colDate + colAuthor + colRefs + COLUMN_GAP * 6;

  /**
   * Message takes whatever the other five columns and the lane graph don't.
   *
   * A single-lane repository needs about 28px of graph, and the table used to end at the sum of its
   * fixed columns and leave the rest of the panel as background — four hundred pixels of nothing to
   * the right of one line of dots, while every message was cut off with an ellipsis. The one column
   * with something to do with more room is the message, so it gets the slack.
   *
   * Published as a CSS variable rather than held in state. This table is memoized precisely so that
   * dragging the diff panel beside it doesn't re-render several hundred rows on every pointermove
   * tick, and re-rendering just to announce a width would hand that back; `calc` reads it instead.
   *
   * Declared up here, above the empty-state returns, because it is a hook: below them it ran on a
   * repository with commits and not on one without, which is a different number of hooks per render
   * and the one thing React cannot survive.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const publish = (available: number) => {
      // `- 24` for the rows' own `px-3`. Floored, so the content can equal the viewport but never
      // exceed it by a fraction and summon a scrollbar that would change the width again.
      const slack = Math.max(
        0,
        Math.floor(available - 24 - fixedColumnsWidth - svgWidth - colMessage),
      );
      el.style.setProperty("--cf-graph-msg", `${colMessage + slack}px`);
    };
    publish(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => publish(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [fixedColumnsWidth, svgWidth, colMessage]);

  /**
   * The window: which slice of the 500 rows is actually built.
   *
   * The table used to render every row the moment Graph was first opened — 500 rows of nine to
   * thirteen elements each, plus a circle and one to three SVG paths per row, all in one synchronous
   * pass, and then held for the rest of the session because `App` never unmounts a visited view.
   * A fixed row height means the slice around the scroll position is a subtraction, so this is the
   * same ~15 lines the result grid uses (`db/ResultGrid`) rather than a virtualization library.
   *
   * Deliberately *not* `content-visibility` here: that would skip the overscan rows too, which are
   * the entire point of the overscan.
   */
  const [scrollTop, setScrollTop] = useState(0);
  const onScrollTop = useFrameThrottle(setScrollTop);
  const [viewportHeight, setViewportHeight] = useState(600);
  // Re-runs on `hasRows` and not on `[]`: the empty and loading states return before the scroll
  // container exists, so on the first pass there is no element for the ref to have caught and an
  // observer created then would be observing nothing for the rest of the session — the window
  // would be stuck at the fallback height on a tall monitor and leave the bottom of the list blank.
  const hasRows = commits.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, [hasRows]);

  // Clamped the way the browser clamps its own `scrollTop`, because a shorter list can arrive
  // (switching to a repository with forty commits while parked at row 400) before the scroll event
  // that would correct the state. Without this the slice comes out empty and the graph reads as
  // broken for a frame.
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  const clampedScrollTop = Math.min(scrollTop, maxScrollTop);
  /**
   * The inverse of `rowTop`: which row is under a given offset.
   *
   * Three cases rather than one division, and the middle one is the interesting one — every offset
   * *inside* the open row's file block answers with the open row itself. That is what keeps the
   * commit whose files you are reading mounted while you scroll through them: a block taller than
   * the viewport would otherwise put its own header outside the window and unmount the row the
   * files hang from.
   */
  const rowAtOffset = (y: number) => {
    if (expandedRow === null || y < blockTop) return Math.floor(y / ROW_HEIGHT);
    if (y < blockTop + expandedHeight) return expandedRow;
    return Math.floor((y - expandedHeight) / ROW_HEIGHT);
  };
  const firstRow = Math.max(0, rowAtOffset(clampedScrollTop) - OVERSCAN);
  const lastRow = Math.min(
    layout.rows.length,
    rowAtOffset(clampedScrollTop + viewportHeight) + 1 + OVERSCAN,
  );
  const visibleRows = useMemo(
    () => layout.rows.slice(firstRow, lastRow),
    [layout.rows, firstRow, lastRow],
  );
  /**
   * Edges are windowed by *span*, not by endpoint — and that is the whole correctness question.
   *
   * A merge's curve can run from row 4 to row 380. Filtering on "does an endpoint fall inside the
   * window" would drop it while you are looking at row 200 and the line would simply stop in mid
   * air; keeping every edge whose row range *overlaps* the window keeps exactly the ones with any
   * ink on screen. The SVG itself stays full height, so every path keeps its absolute coordinates
   * and nothing has to be re-based against the window's first row.
   */
  const visibleEdges = useMemo(
    () =>
      layout.edges.filter(
        (edge) =>
          Math.max(edge.fromRow, edge.toRow) >= firstRow && Math.min(edge.fromRow, edge.toRow) < lastRow,
      ),
    [layout.edges, firstRow, lastRow],
  );

  if (commits.length === 0 && commitsLoading) {
    return <SkeletonRows count={12} className="cf-fade-in" />;
  }

  if (commits.length === 0) {
    // Two different empty states, because they mean opposite things: an empty repository is a fact
    // about the repository, and an empty filter result is a fact about what you typed.
    return filtering ? (
      <EmptyState
        icon={Search}
        title={t("graph.noMatches", { query: commitQuery.trim() })}
        subtitle={t("graph.noMatchesHint")}
      />
    ) : (
      <EmptyState icon={History} title={t("graph.noCommits")} subtitle={t("graph.noCommitsHint")} />
    );
  }

  // Left-to-right order: Commit, Date, Author, Message, Refs, then the lane graph —
  // keeping the graph fixed-width and last avoids it colliding with the sticky header
  // when the row is very wide, and every text column has a known pixel width so the
  // graph's offset can be computed exactly instead of relying on flex measurement.
  const columns = [
    { key: "graphColHash" as const, width: colHash, label: t("graph.colCommit") },
    { key: "graphColDate" as const, width: colDate, label: t("graph.colDate") },
    { key: "graphColAuthor" as const, width: colAuthor, label: t("graph.colAuthor") },
    // The one that takes up the slack, and so the one with no handle of its own — see below.
    { key: "graphColMessage" as const, width: colMessage, label: t("graph.colMessage"), fills: true },
    { key: "graphColRefs" as const, width: colRefs, label: t("graph.colRefs") },
  ];

  // Coordinates local to the graph SVG itself, which is offset past the text columns via `left`.
  // `rowY` goes through `rowTop`, so an open row's files push the lanes below it down with the rows
  // they belong to and the line into the parent simply grows longer across the gap — rather than
  // the dots drifting off their rows the moment anything expands.
  const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const rowY = (row: number) => rowTop(row) + ROW_HEIGHT / 2;

  /**
   * The file block's own window, on the same principle as the rows'.
   *
   * A commit that touches four hundred files is a block nine thousand pixels tall, and expanding
   * one used to be a fair description of "build four hundred rows nobody asked to see". The block
   * keeps its full reserved height either way — only what is near the viewport is built. When the
   * block is nowhere near, `lastFile` lands at or below `firstFile` and the slice is empty.
   */
  const fileListTop = blockTop + FILE_LIST_PAD;
  const firstFile = Math.max(0, Math.floor((clampedScrollTop - fileListTop) / FILE_ROW_HEIGHT) - OVERSCAN);
  const lastFile = Math.min(
    commitDiff.length,
    Math.ceil((clampedScrollTop + viewportHeight - fileListTop) / FILE_ROW_HEIGHT) + OVERSCAN,
  );

  /** The fallback keeps the first paint honest, before the observer has run once. */
  const messageWidth = `var(--cf-graph-msg, ${colMessage}px)`;
  const textColumnsWidth = `calc(${fixedColumnsWidth}px + ${messageWidth})`;
  const totalWidth = `calc(${fixedColumnsWidth + svgWidth + 24}px + ${messageWidth})`;

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-auto"
      // One state write per painted frame rather than one per scroll event. `scrollTop` drives the
      // row windowing below, so an unthrottled fling asked React for two or three renders per frame
      // and threw all but the last away before anything reached the screen.
      onScroll={(e) => onScrollTop(e.currentTarget.scrollTop)}
    >
      <div
        className="sticky top-0 z-10 flex h-6 min-w-full items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 text-[10px]"
        style={{ width: totalWidth, willChange: "transform", contain: "paint" }}
      >
        {/* The chevron's column has no label — a header over a column of disclosure triangles names
            nothing — but it has to exist here, or every heading sits fourteen pixels left of the
            column it heads. */}
        <div style={{ width: CHEVRON_WIDTH }} className="shrink-0" />
        {columns.map((col) => (
          <div
            key={col.key}
            style={{ width: col.fills ? messageWidth : col.width }}
            className="flex shrink-0 items-center"
          >
            <span className="min-w-0 flex-1 truncate text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {col.label}
            </span>
            {/* No handle on the column that fills: dragging it would change a base width that the
                slack immediately gives back, so the grip would move and nothing else would. Its
                width is set by the other four — widen Author and Message narrows to match.

                `quiet` on the rest: these divide columns of a table, not panes of a layout. The
                default seam and grip are sized for the side of a panel, and in a 24px header they
                came out as full-height bars heavier than the labels they sat between. */}
            {!col.fills && (
              <ResizeHandle
                quiet
                axis="x"
                value={col.width}
                min={COL_MIN}
                max={COL_MAX}
                onChange={(w) => setSize(col.key, w)}
                onCommit={(w) => commitSize(col.key, w)}
              />
            )}
          </div>
        ))}
        <span className="flex-1 text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("graph.colGraph")}
        </span>
      </div>

      {/* The graph rises as one block rather than row by row: the lanes and the dots are a single
          SVG layer positioned against the rows, so a staggered row would slide out from under its
          own commit dot on the way in. */}
      <div
        className="cf-rise relative min-w-full"
        style={{ width: totalWidth, minHeight: contentHeight }}
      >
        {/* Above the rows, which is not where it was.
            Both layers are absolutely positioned at `z-index: auto`, so they painted in DOM order —
            and the rows are written after this, so every row background landed on top of the graph.
            Hovering got away with it because that wash is 3% black; selection did not, because
            `--cf-accent-soft` is an opaque colour, and it erased the lane and the dot of the one
            commit the user had just pointed at. The line stopping exactly where you are looking is
            the worst place for it to stop.
            `z-[1]` rather than a larger number: it only has to clear the rows beside it, and the
            column header above is `z-10` and has to keep winning when the list scrolls under it.
            Safe to raise precisely because it is `pointer-events-none` and transparent between its
            strokes — the row underneath is still the click target across its whole width, including
            the part of it this covers. */}
        <svg
          width={svgWidth}
          height={contentHeight}
          style={{ left: textColumnsWidth, top: 0 }}
          className="pointer-events-none absolute z-[1]"
        >
          {visibleEdges.map((edge) => {
            const x1 = laneX(edge.fromLane);
            const y1 = rowY(edge.fromRow);
            const x2 = laneX(edge.toLane);
            const y2 = rowY(edge.toRow);
            const color = laneColor(edge.fromLane);
            // Keyed by the four coordinates that *are* the edge rather than by its index in the
            // slice: the slice's indices shift under the window as you scroll, which would make
            // React rewrite every path on every scroll tick instead of the handful that changed.
            const key = `${edge.fromRow}:${edge.fromLane}>${edge.toRow}:${edge.toLane}`;
            if (x1 === x2) {
              return <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2} />;
            }
            const midY = (y1 + y2) / 2;
            return (
              <path
                key={key}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                stroke={color}
                strokeWidth={2}
                fill="none"
              />
            );
          })}
          {visibleRows.map((r) => (
            <circle key={r.commit.id} cx={laneX(r.lane)} cy={rowY(r.row)} r={DOT_RADIUS} fill={laneColor(r.lane)} />
          ))}
        </svg>

        <div>
          {visibleRows.map((r) => {
            const isSelected = r.commit.id === selectedCommitId;
            const isHead = r.commit.id === headCommitId;
            return (
              <div
                key={r.commit.id}
                // Absolutely placed at its own row offset rather than stacked in flow, because the
                // rows either side of the window are not built at all — the parent already reserves
                // the full `contentHeight`, so the scrollbar is the same length it has always been
                // and the row lands under its own dot in the SVG layer above.
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: rowTop(r.row),
                  height: ROW_HEIGHT,
                  // The selected row is *outlined*, not just washed. The wash alone had to carry
                  // both "this is the open commit" and "this is the row under the pointer", and on
                  // the dark theme those two are a few percent of lightness apart; the ring says it
                  // in a channel hover has no claim on. An inset shadow rather than a border,
                  // because a border would be a pixel of layout and shift every column in the row
                  // by it the moment you clicked.
                  //
                  // The fill is mixed from `--cf-accent` rather than taken from `--cf-accent-soft`
                  // so that it agrees with the ring around it. On the light theme that changes
                  // nothing worth seeing — `--cf-accent-soft` is the same 14% mix, against the
                  // surface instead of against transparent. On the dark theme it is a hardcoded
                  // navy: it happens to land on the *default* indigo and does not follow
                  // `accentStore`, so a user on teal would have got a teal ring around a blue fill.
                  ...(isSelected
                    ? {
                        background: "color-mix(in oklab, var(--cf-accent) 14%, transparent)",
                        boxShadow: "inset 0 0 0 1px var(--cf-accent)",
                      }
                    : null),
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ commit: r.commit, x: event.clientX, y: event.clientY });
                }}
                className={`group flex w-full items-center gap-2 px-3 text-[13px] ${
                  isSelected ? "rounded-md" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                {/* The hit area is the row, not the text. It used to be exactly `textColumnsWidth`
                    wide and only as tall as its own content, so the highlight said "this whole
                    strip is one commit" while the click target was the words alone — aiming a few
                    pixels below a line, or to the right of the last column, hit nothing. `h-full`
                    claims the row's height; `flex-1` over a `minWidth` claims whatever the columns
                    don't use, without letting them be squeezed when the graph is wider than the
                    pane and the row is already at its minimum. */}
                <button
                  onClick={() => selectCommit(isSelected ? null : r.commit.id)}
                  style={{ minWidth: textColumnsWidth }}
                  // The row *is* the disclosure control, so it is the thing that has to announce
                  // itself as one: the triangle beside the hash is a glyph inside this button, not a
                  // second button with its own tab stop and its own 14px hit area next to a target
                  // that already does the same job across the full width of the row.
                  aria-expanded={isSelected}
                  className="flex h-full flex-1 items-center gap-2 text-left"
                >
                  <span
                    style={{ width: CHEVRON_WIDTH }}
                    className={`flex shrink-0 items-center justify-center ${
                      isSelected ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
                    }`}
                  >
                    {isSelected ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                  <span style={{ width: colHash }} className="shrink-0 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                    {r.commit.short_id}
                  </span>
                  <span
                    style={{ width: colDate }}
                    className="shrink-0 truncate text-[var(--cf-text-muted)]"
                    title={formatFullDateTime(r.commit.timestamp)}
                  >
                    {formatDate(r.commit.timestamp)}
                  </span>
                  <span style={{ width: colAuthor }} className="shrink-0 truncate text-[var(--cf-text-muted)]">
                    {r.commit.author_name}
                  </span>
                  <span style={{ width: messageWidth }} className="shrink-0 truncate text-[var(--cf-text)]">
                    {r.commit.summary}
                  </span>
                  <span style={{ width: colRefs }} className="flex shrink-0 items-center gap-1 overflow-hidden">
                    {r.commit.refs.slice(0, MAX_REF_CHIPS).map((ref) => (
                      <RefChip
                        key={`${ref.kind}:${ref.name}`}
                        commitRef={ref}
                        // The same call the dot beside it makes, so chip and dot cannot disagree.
                        lane={laneColor(r.lane)}
                        isCurrent={ref.kind === "branch" && ref.name === currentBranch}
                      />
                    ))}
                    {/* The overflow used to be silent: a commit with a branch, its remote and two
                        tags on it showed two chips and no sign that it had four. A counter is
                        smaller than a third chip and says the one thing the missing chips were
                        there to say — that there is more here — with the names themselves a hover
                        away. */}
                    {r.commit.refs.length > MAX_REF_CHIPS && (
                      <span
                        title={r.commit.refs.slice(MAX_REF_CHIPS).map((ref) => ref.name).join("\n")}
                        className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-[var(--cf-text-muted)]"
                      >
                        +{r.commit.refs.length - MAX_REF_CHIPS}
                      </span>
                    )}
                  </span>
                </button>
                {isHead && r.commit.parent_ids.length > 0 && (
                  <button
                    title={t("graph.undoCommit")}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await confirmAction(t("graph.undoConfirm"))) {
                        void undoCommit(r.commit.id);
                      }
                    }}
                    className="hidden shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] group-hover:block"
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* The open commit's files, in the gap `rowTop` opened for them.
            A sibling of the rows rather than a child of the one it belongs to, because that row is
            a fixed 30px box positioned by the same arithmetic as every other row, and nesting a
            variable-height list inside it would make its height a measurement instead. */}
        {expandedRow !== null && (
          <div style={{ position: "absolute", left: 0, right: 0, top: blockTop, height: expandedHeight }}>
            {commitDiffLoading ? (
              <div
                style={{ height: FILE_ROW_HEIGHT, marginTop: FILE_LIST_PAD, paddingLeft: FILE_INDENT }}
                className="flex items-center"
              >
                <Skeleton className="h-3 w-48 rounded" />
              </div>
            ) : commitDiff.length === 0 ? (
              // Reachable, and not a fallback for a slow fetch — `commitDiffLoading` above owns that
              // case. This is `git commit --allow-empty`, and a merge that resolved to no change.
              <div
                style={{ height: FILE_ROW_HEIGHT, marginTop: FILE_LIST_PAD, paddingLeft: FILE_INDENT }}
                className="flex items-center text-[12px] text-[var(--cf-text-muted)]"
              >
                {t("graph.noFilesChanged")}
              </div>
            ) : (
              commitDiff.slice(firstFile, lastFile).map((file, i) => (
                <CommitFileRow
                  // Keyed by the path, not by the index in the slice: the slice's indices shift
                  // under the window as you scroll, on the same reasoning as the edges' keys above.
                  key={`${file.old_path ?? ""}>${file.new_path ?? ""}`}
                  file={file}
                  top={FILE_LIST_PAD + (firstFile + i) * FILE_ROW_HEIGHT}
                  width={`calc(12px + ${textColumnsWidth})`}
                  selected={(file.new_path ?? file.old_path) === selectedCommitPath}
                  // Clicking the open file again closes the panel, the same toggle the commit row
                  // itself has — otherwise the only way out of a diff is the panel's × button,
                  // which is nowhere near the thing you clicked to get there.
                  onSelect={(path) =>
                    void selectCommitFile(path === selectedCommitPath ? null : path)
                  }
                  t={t}
                />
              ))
            )}
          </div>
        )}

        {/* The end of the history, or the way to more of it.
            Inside the scrolling content and after the absolutely-positioned rows, so it sits below
            the last one at `contentHeight` — a button that floated over row four hundred would be
            unreachable without scrolling past everything. Hidden while filtering: "load more" next
            to a filtered list implies the next page is more matches, and it is not. */}
        {!filtering && commitsHasMore && (
          <div
            style={{ position: "absolute", left: 0, right: 0, top: contentHeight }}
            className="flex justify-center py-3"
          >
            <button
              type="button"
              onClick={() => void loadMoreCommits()}
              disabled={commitsLoadingMore}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-60"
            >
              {commitsLoadingMore && <Loader2 size={12} className="animate-spin" />}
              {commitsLoadingMore ? t("graph.loadingMore") : t("graph.loadMore")}
            </button>
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={commitMenuItems({
            commit: menu.commit,
            headCommitId,
            dirty,
            t,
            onCopyHash: (commit) => void copyText(commit.id),
            onCopyMessage: (commit) => void copyText(commit.summary),
            onBranchHere: (commit) => openCreateBranch(commit.id),
            onTag: (commit) => openTagModal(commit.id),
            onAmend: openAmend,
            onRevert: (commit) => void revertHere(commit),
            onCherryPick: (commit) => void cherryPickHere(commit),
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
});

/**
 * The whole screen: the commit table, and the diff of **one** file beside it.
 *
 * The panel used to open on the commit and show every file it touched, stacked. That is the view
 * for "read this commit end to end" and the wrong one for every other question — a release commit
 * put four hundred sticky headers in a 440px column and the file you wanted was somewhere in it.
 * Now the commit expands into its file list in the table, and the panel opens on the file you
 * click. One file, full context, nothing to scroll past.
 */
/**
 * The filter box above the history.
 *
 * Its own component so it can own the input's focus and still not re-render `CommitTable` on every
 * keystroke — the table is memoised and reads the query from the store, so typing costs one render
 * of this bar and one of the table, rather than one of everything between them.
 *
 * A filter rather than a jump-to-match: "which commits mention login" is the question people
 * actually have, and highlighting one match at a time in a list of four thousand answers a
 * different one.
 */
function GraphToolbar() {
  const t = useT();
  const query = useRepoStore((s) => s.commitQuery);
  const setQuery = useRepoStore((s) => s.setCommitQuery);
  const total = useRepoStore((s) => s.commits.length);
  const shown = useRepoStore((s) =>
    s.commitQuery.trim() ? s.commits.filter((c) => matchesCommit(c, s.commitQuery)).length : s.commits.length,
  );

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
      <div className="relative min-w-0 flex-1">
        <Search
          size={12}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape clears rather than blurs: the box is one field on a screen with no other
            // keyboard mode, so the only thing Escape can usefully mean here is "never mind".
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder={t("graph.searchPlaceholder")}
          aria-label={t("graph.searchPlaceholder")}
          className="w-full rounded-md border border-[var(--cf-border)] bg-transparent py-1 pl-7 pr-6 text-[12px] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t("common.clear")}
            className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={11} />
          </button>
        )}
      </div>
      {/* Only while filtering, and it says both numbers: "12" alone leaves you wondering whether
          that is all the history or all the matches. */}
      {query.trim() && (
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {t("graph.searchCount", { shown, total })}
        </span>
      )}
    </div>
  );
}

export function GraphView() {
  const commits = useRepoStore((s) => s.commits);
  const selectedCommitId = useRepoStore((s) => s.selectedCommitId);
  const selectedCommitPath = useRepoStore((s) => s.selectedCommitPath);
  const commitFileDiff = useRepoStore((s) => s.commitFileDiff);
  const commitFileDiffLoading = useRepoStore((s) => s.commitFileDiffLoading);
  const selectCommitFile = useRepoStore((s) => s.selectCommitFile);
  const diffWidth = useLayoutStore((s) => s.sizes.graphDiffWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const t = useT();

  const selectedCommit = commits.find((c) => c.id === selectedCommitId) ?? null;
  const open = selectedCommit !== null && selectedCommitPath !== null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--cf-surface)]">
        <GraphToolbar />
        <CommitTable />
      </div>

      {open && (
        <>
          <ResizeHandle
            axis="x"
            value={diffWidth}
            min={DIFF_MIN}
            max={DIFF_MAX}
            invert
            onChange={(w) => setSize("graphDiffWidth", w)}
            onCommit={(w) => commitSize("graphDiffWidth", w)}
          />
          <div
            style={{ width: diffWidth }}
            className="flex shrink-0 flex-col overflow-hidden bg-[var(--cf-surface)]"
          >
            <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
              {/* The path leads and the commit follows it, because the path is what changed when
                  you clicked and the commit is the context you already have on screen. `dir="rtl"`
                  on a truncating path so it loses the *front* — a column of
                  `src/components/git/Gra…` names nothing, `…/git/GraphView.tsx` names the file. */}
              <span className="min-w-0 flex-1" title={selectedCommitPath}>
                <span
                  dir="rtl"
                  className="block truncate text-left font-mono text-[12px] text-[var(--cf-text)]"
                >
                  {selectedCommitPath}
                </span>
                <span className="block truncate text-[10.5px] text-[var(--cf-text-muted)]">
                  <span className="font-mono">{selectedCommit.short_id}</span> — {selectedCommit.summary}
                </span>
              </span>
              <button
                onClick={() => void selectCommitFile(null)}
                title={t("graph.close")}
                className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={14} />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {commitFileDiffLoading ? (
                <SkeletonRows count={10} className="cf-fade-in" />
              ) : (
                // `[]` and not "the file is missing": `DiffView`'s own empty state ("no changes")
                // is the honest reading of a delta with nothing in it, which is what a mode-only
                // change or a file the pathspec no longer matches comes back as.
                <DiffView files={commitFileDiff ? [commitFileDiff] : []} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
