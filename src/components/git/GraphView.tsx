import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { Tooltip } from "../common/Tooltip";
import { buttonClass, iconButtonClass } from "../common/Button";
import { fieldClass, toolbarClass } from "../common/recipes";
import {
  ChevronsDown,
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
import {
  FILE_STATUS_LETTER_CLASS,
  fileStatusColor,
  fileStatusLabelKey,
  fileStatusLetter,
} from "../../lib/fileStatus";
import type { CommitRef, FileDiffInfo, RefKind } from "../../types/domain";
import { useFrameThrottle } from "../../lib/frameThrottle";

const ROW_HEIGHT = 30;
const LANE_WIDTH = 16;
const DOT_RADIUS = 4;
/** HEAD's dot: a ring, a step larger than the discs around it. "Where am I" is then answered by the
 *  graph itself and not only by a chip naming the checked-out branch — which on a detached HEAD no
 *  chip does. */
const HEAD_RADIUS = 5;
const DIFF_MIN = 280;
const DIFF_MAX = 900;
const COL_MIN = 50;
const COL_MAX = 600;
const COLUMN_GAP = 10; // matches Tailwind gap-2.5

/** Where lane 0 sits in from the table's left edge. The graph is the first column now, and a dot
 *  flush against the edge of the pane reads as clipped. */
const GRAPH_PAD = 10;
/** The narrowest the graph column gets: its own heading's width. A single-lane history needs about
 *  thirty pixels of lanes, and the heading squeezed into that spilled over the message's. */
const GRAPH_MIN = 44;
/** The rows' right padding (`pr-3`). Part of the fixed width, so the slack stays a subtraction. */
const ROW_PAD_RIGHT = 12;
/** One file inside an expanded commit — shorter than a commit row, because it carries one line of
 *  monospace and no chips. */
const FILE_ROW_HEIGHT = 22;
/** Breathing room above and below an expanded commit's file list, so the first path doesn't sit
 *  flush against the row that owns it. */
const FILE_LIST_PAD = 4;
/** Where a file row's status letter starts: one small step in from the message column it hangs
 *  under, which is what makes the list read as *belonging to* that commit rather than as more rows
 *  in the same table. */
const FILE_INDENT = 8;
/**
 * Below this much message, the tags step aside — see `RefChips`.
 *
 * About the width of a summary and its two chips with the summary still readable. Measured against
 * the message column rather than the window, because what it protects is the message: widening the
 * author column or opening the diff beside the table eats the same room a small window does.
 */
const NARROW_MESSAGE = 420;

/** A column heading: the app's section-label voice — 11px uppercase, faint — left-aligned over the
 *  cells it heads, where centred labels sat over left-aligned text and named the middle of nothing. */
const COLUMN_HEADING =
  "min-w-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

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

/** How many chips a row shows before the rest become a counter. They share the message's cell, and
 *  every chip past two is width the summary gives up for a name a hover can supply. */
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
 * **That is the whole point.** The refs used to be a column inches away from the graph that told you
 * nothing about it: `feat/thing` came out indigo whether its commit was the tip of the indigo line,
 * the teal one or the amber one, so matching a name to a line meant tracing the row across by eye
 * and counting lanes. Painted in `laneColor(lane)` the chip *is* the line — the same hue as the dot
 * at the start of the row and the stroke running out of it — and the match is made before you have
 * finished reading the name.
 *
 * The palette is safe to read as text: lane 0 is the accent, which already carries text everywhere
 * in the app, and the other five sit in the same 55–70% lightness band as the workspace colours —
 * the band chosen precisely because one hex has to work on both themes (see `lib/workspaceColors`).
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
 * survives both colour-blindness and small type, which is where two small icons start to converge.
 *
 * `title` rather than the app's own `Tooltip`: the name is *truncated*, not missing, so this is the
 * fallback case that `Tooltip`'s own note reserves for the platform's — and it is per-row in a list
 * that can run to a thousand commits, where a portalled component per chip is a cost with nothing
 * to show for it.
 *
 * `display` is the caller's, and it is the only display utility on the element: whether a chip is
 * drawn at all depends on how much room the message has (see [`RefChips`]), and two display classes
 * on one element are resolved by stylesheet order rather than by which one was meant.
 */
function RefChip({
  commitRef,
  lane,
  isCurrent,
  display,
}: {
  commitRef: CommitRef;
  lane: string;
  isCurrent: boolean;
  display: string;
}) {
  const Icon = REF_GLYPH[commitRef.kind];
  const outline = commitRef.kind === "remote";
  return (
    <span
      title={commitRef.name}
      className={`${display} h-[19px] min-w-0 max-w-[160px] shrink items-center gap-1 border px-1.5 font-mono text-[11px] ${
        commitRef.kind === "tag" ? "rounded-full" : "rounded-[4px]"
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
      <Icon size={11} className="shrink-0" />
      <span className="truncate">{commitRef.name}</span>
    </span>
  );
}

/** "+2", for the refs a row had no room to draw — named in its `title`. */
function RefOverflow({ refs, display }: { refs: CommitRef[]; display: string }) {
  return (
    <span
      title={refs.map((ref) => ref.name).join("\n")}
      className={`${display} shrink-0 items-center text-[11px] font-medium tabular-nums text-[var(--cf-text-faint)]`}
    >
      +{refs.length}
    </span>
  );
}

/**
 * A commit's refs, as chips at the end of its message.
 *
 * They used to have a column of their own: two hundred pixels on every row, empty on all but the
 * handful of commits that carry a branch or a tag, and taking that width from the one column with
 * something to say on every row. In the message's cell they cost nothing where there is nothing,
 * and where there is something they sit beside the words they label.
 *
 * **Tags step aside when the message runs short of room** — `data-narrow` on the scroll container,
 * set by the same observer that sizes the message (`NARROW_MESSAGE`). A branch is where work is
 * going on and a remote is where it was pushed; a tag is a milestone you already know about, and
 * of the three it is the one a cramped row can drop without hiding anything current. Nothing is
 * lost: the counter then includes them and its `title` names them.
 *
 * Both arrangements are rendered and CSS picks one, rather than the width being read into React:
 * the table is memoised precisely so that a drag of the pane beside it re-renders nothing, and a
 * width in state would hand every row a re-render per pointermove. Each chip carries the display
 * for its own case — drawn in both, drawn only while roomy, drawn only while narrow — and each
 * layout gets its own counter, so "+N" is always the number actually hidden.
 */
function RefChips({
  refs,
  lane,
  currentBranch,
}: {
  refs: CommitRef[];
  lane: string;
  currentBranch: string | null;
}) {
  if (refs.length === 0) return null;
  const narrowShown = refs.filter((ref) => ref.kind !== "tag").slice(0, MAX_REF_CHIPS);
  const roomyHidden = refs.slice(MAX_REF_CHIPS);
  const narrowHidden = refs.filter((ref) => !narrowShown.includes(ref));
  return (
    <span className="flex min-w-0 max-w-[60%] shrink items-center gap-1 overflow-hidden">
      {refs.map((ref, index) => {
        const roomy = index < MAX_REF_CHIPS;
        const narrow = narrowShown.includes(ref);
        if (!roomy && !narrow) return null;
        return (
          <RefChip
            key={`${ref.kind}:${ref.name}`}
            commitRef={ref}
            // The same call the dot at the start of the row makes, so chip and dot cannot disagree.
            lane={lane}
            isCurrent={ref.kind === "branch" && ref.name === currentBranch}
            display={
              roomy && narrow
                ? "inline-flex"
                : roomy
                  ? "inline-flex group-data-[narrow]/graph:hidden"
                  : "hidden group-data-[narrow]/graph:inline-flex"
            }
          />
        );
      })}
      {/* The overflow used to be silent: a commit with a branch, its remote and two tags on it
          showed two chips and no sign that it had four. A counter is smaller than a third chip and
          says the one thing the missing chips were there to say — that there is more here — with
          the names themselves a hover away. */}
      {roomyHidden.length > 0 && (
        <RefOverflow refs={roomyHidden} display="inline-flex group-data-[narrow]/graph:hidden" />
      )}
      {narrowHidden.length > 0 && (
        <RefOverflow refs={narrowHidden} display="hidden group-data-[narrow]/graph:inline-flex" />
      )}
    </span>
  );
}

/**
 * One changed path inside an expanded commit, as `git status --short` writes it: a letter, then the
 * file.
 *
 * The letter carries the status on its own — colour *and* glyph, `fileStatusColor` and
 * `fileStatusLetter` — rather than the chip of translated text the diff panel puts above the file.
 * That chip is right where one file is the subject and has a header to itself; here the path is the
 * subject and there can be four hundred of them, and four hundred "Modificado" chips would push
 * every filename they annotate past the right edge. The word is still there, in the `title`.
 *
 * A rename shows both halves with an arrow between them, because "R" beside the new path alone is
 * the one status you cannot act on: it tells you a file moved and hides where it moved *from*.
 */
function CommitFileRow({
  file,
  top,
  left,
  width,
  selected,
  onSelect,
  t,
}: {
  file: FileDiffInfo;
  top: number;
  /** The message column's left edge: the list hangs under the summary of the commit it belongs to,
   *  clear of the lanes, which run on through the block to the commits below. */
  left: number;
  /** From there to the end of the table. The lanes are the first column now, so a deep path has
   *  nothing to run into on its right and can take the width the author and date leave. */
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
      style={{ position: "absolute", left, top, width, height: FILE_ROW_HEIGHT, paddingLeft: FILE_INDENT }}
      // The list-row selection every other list in the app wears: the accent wash, text unchanged.
      className={`flex items-center gap-2 rounded-md pr-2 text-left text-[12px] transition-colors duration-100 ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
      }`}
    >
      <span style={{ color }} className={FILE_STATUS_LETTER_CLASS}>
        {fileStatusLetter(file.status)}
      </span>
      <span className="truncate font-mono text-[var(--cf-text)]">{label}</span>
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
  // `graphColRefs` is still in `layoutStore` and is simply no longer read: the refs are chips in the
  // message's cell now, not a column. A width saved for it by an older build sits there unused and
  // harmless — nothing else is keyed on it, so there is nothing to migrate.
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

  /**
   * The lane graph's column — the *first* column now, and the reason for most of this geometry.
   *
   * It used to be the last: the text columns ran left to right and the lanes came after the refs,
   * a message's width away from the summary they belong to — so reading "which line is this commit
   * on" meant carrying a row across the whole table by eye. Put first, lane and message read as one
   * thing, which is how every graph client people already know draws it. It also means the SVG sits
   * at a fixed `left: 0` instead of an offset `calc` that moved whenever a column was dragged.
   */
  const graphWidth = Math.max(GRAPH_MIN, GRAPH_PAD + layout.laneCount * LANE_WIDTH + 6);
  /** Every row plus whatever the open one added — the scroll height, and the height the lane graph
   *  has to span so an edge crossing the open row stretches over its files instead of stopping at
   *  them. */
  const contentHeight = layout.rows.length * ROW_HEIGHT + expandedHeight;
  // The graph, three fixed text columns to the right of the message (which takes the slack), four
  // `gap-2.5` seams between the five, and the rows' right padding.
  const fixedWidth = graphWidth + colAuthor + colDate + colHash + COLUMN_GAP * 4 + ROW_PAD_RIGHT;

  /**
   * Message takes whatever the lane graph and the other three columns don't.
   *
   * A single-lane repository needs about 30px of graph, and the table used to end at the sum of its
   * fixed columns and leave the rest of the panel as background — four hundred pixels of nothing to
   * the right of one line of dots, while every message was cut off with an ellipsis. The one column
   * with something to do with more room is the message, so it gets the slack.
   *
   * Published as a CSS variable rather than held in state. This table is memoized precisely so that
   * dragging the diff panel beside it doesn't re-render several hundred rows on every pointermove
   * tick, and re-rendering just to announce a width would hand that back; `calc` reads it instead.
   * `data-narrow` rides along for the same reason — it is what lets the tags step aside (see
   * `RefChips`) with a CSS selector rather than a render.
   *
   * Declared up here, above the empty-state returns, because it is a hook: below them it ran on a
   * repository with commits and not on one without, which is a different number of hooks per render
   * and the one thing React cannot survive. Re-run on `hasRows` for the reason the viewport observer
   * below gives: the table mounts behind a skeleton, and on a single-lane history nothing else in the
   * dependency list changes when the rows arrive — the message stayed at its base width, short of the
   * pane, until the first column drag.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasRows = commits.length > 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const publish = (available: number) => {
      // Floored, so the content can equal the viewport but never exceed it by a fraction and
      // summon a scrollbar that would change the width again.
      const slack = Math.max(0, Math.floor(available - fixedWidth - colMessage));
      el.style.setProperty("--cf-graph-msg", `${colMessage + slack}px`);
      el.toggleAttribute("data-narrow", colMessage + slack < NARROW_MESSAGE);
    };
    publish(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => publish(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [fixedWidth, colMessage, hasRows]);

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

  // Left-to-right order: the lane graph, Message (with the refs as chips at its end), then Author,
  // Date and Commit. The graph leads so that a commit's line and its summary read together; the
  // three columns after the message are the ones you look up rather than read, and each has a known
  // pixel width, so the message's share stays a subtraction instead of a flex measurement.
  const trailingColumns = [
    { key: "graphColAuthor" as const, width: colAuthor, label: t("graph.colAuthor") },
    { key: "graphColDate" as const, width: colDate, label: t("graph.colDate") },
    { key: "graphColHash" as const, width: colHash, label: t("graph.colCommit") },
  ];

  // Coordinates local to the graph SVG, which is the table's first column and sits at `left: 0`.
  // `rowY` goes through `rowTop`, so an open row's files push the lanes below it down with the rows
  // they belong to and the line into the parent simply grows longer across the gap — rather than
  // the dots drifting off their rows the moment anything expands.
  const laneX = (lane: number) => GRAPH_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
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
  const tableWidth = `calc(${fixedWidth}px + ${messageWidth})`;
  /** Where the message column starts — and so where an expanded commit's files hang from. */
  const messageLeft = graphWidth + COLUMN_GAP;

  return (
    <div
      ref={scrollRef}
      // `group/graph` is what the ref chips' `group-data-[narrow]/graph:` classes key on; the
      // attribute itself is set by the width observer above.
      className="group/graph flex-1 overflow-auto"
      // One state write per painted frame rather than one per scroll event. `scrollTop` drives the
      // row windowing below, so an unthrottled fling asked React for two or three renders per frame
      // and threw all but the last away before anything reached the screen.
      onScroll={(e) => onScrollTop(e.currentTarget.scrollTop)}
    >
      <div
        className="sticky top-0 z-10 flex h-[30px] min-w-full items-center gap-2.5 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] pr-3"
        style={{ width: tableWidth, willChange: "transform", contain: "paint" }}
      >
        {/* Allowed to run past its column rather than truncate: on a one-lane history the column is
            narrower than the word, and the gap after it is empty by construction. */}
        <div style={{ width: graphWidth }} className="shrink-0 pl-2">
          <span className={`${COLUMN_HEADING} whitespace-nowrap`}>{t("graph.colGraph")}</span>
        </div>
        {/* No handle on the column that fills: dragging it would change a base width that the slack
            immediately gives back, so the grip would move and nothing else would. Its width is set by
            the other three — widen Author and Message narrows to match. */}
        <div style={{ width: messageWidth }} className="flex min-w-0 shrink-0 items-center">
          <span className={`${COLUMN_HEADING} truncate`}>{t("graph.colMessage")}</span>
        </div>
        {trailingColumns.map((col) => (
          <div key={col.key} style={{ width: col.width }} className="flex min-w-0 shrink-0 items-center">
            {/* On the column's *left* edge, and inverted: these three are anchored to the right of
                the table, so the seam you pull is the one between a column and the message — drag
                it left and the column grows while the message gives the room back.

                `quiet`: these divide columns of a table, not panes of a layout. The default seam
                and grip are sized for the side of a panel, and in a header this short they came out
                as full-height bars heavier than the labels they sat between. */}
            <ResizeHandle
              quiet
              invert
              axis="x"
              value={col.width}
              min={COL_MIN}
              max={COL_MAX}
              onChange={(w) => setSize(col.key, w)}
              onCommit={(w) => commitSize(col.key, w)}
            />
            <span className={`${COLUMN_HEADING} truncate`}>{col.label}</span>
          </div>
        ))}
      </div>

      {/* The graph rises as one block rather than row by row: the lanes and the dots are a single
          SVG layer positioned against the rows, so a staggered row would slide out from under its
          own commit dot on the way in. */}
      <div
        className="cf-rise relative min-w-full"
        style={{ width: tableWidth, minHeight: contentHeight }}
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
          width={graphWidth}
          height={contentHeight}
          style={{ left: 0, top: 0 }}
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
                strokeLinecap="round"
                fill="none"
              />
            );
          })}
          {visibleRows.map((r) =>
            // HEAD as a ring filled with the sheet, so it reads as "you are here" rather than as one
            // more commit — and it stays a ring on a selected row, where the wash shows around it.
            r.commit.id === headCommitId ? (
              <circle
                key={r.commit.id}
                cx={laneX(r.lane)}
                cy={rowY(r.row)}
                r={HEAD_RADIUS}
                fill="var(--cf-surface)"
                stroke={laneColor(r.lane)}
                strokeWidth={2.5}
              />
            ) : (
              <circle key={r.commit.id} cx={laneX(r.lane)} cy={rowY(r.row)} r={DOT_RADIUS} fill={laneColor(r.lane)} />
            ),
          )}
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
                // and the row lands on its own dot in the SVG layer above.
                style={{ position: "absolute", left: 0, right: 0, top: rowTop(r.row), height: ROW_HEIGHT }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ commit: r.commit, x: event.clientX, y: event.clientY });
                }}
                // The open commit wears the selection every list in the app wears — the accent wash,
                // full bleed. It used to carry an accent ring as well, because the wash was a fixed
                // navy on the dark theme that could sit a few percent of lightness from the hover
                // tint; `--cf-accent-soft` follows the accent on both themes now, and a coloured
                // wash next to the neutral hover tint needs no second channel to be told apart.
                className={`group transition-colors duration-100 ${
                  isSelected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
                }`}
              >
                {/* The hit area is the row, not the text: the highlight says "this whole strip is
                    one commit", so the whole strip is the target — a few pixels below a line, or
                    past the last column, still lands on it. The graph's column is part of it too,
                    under the lanes (`pointer-events-none`), so clicking a dot opens its commit. */}
                <button
                  onClick={() => selectCommit(isSelected ? null : r.commit.id)}
                  // The row *is* the disclosure control, so it is the thing that has to announce
                  // itself as one — not a second button with its own tab stop and its own small hit
                  // area beside a target that already does the same job across the whole row.
                  aria-expanded={isSelected}
                  className="flex h-full w-full items-center gap-2.5 pr-3 text-left text-[13px]"
                >
                  <span style={{ width: graphWidth }} className="shrink-0" aria-hidden />
                  <span style={{ width: messageWidth }} className="flex min-w-0 shrink-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[var(--cf-text)]">{r.commit.summary}</span>
                    <RefChips refs={r.commit.refs} lane={laneColor(r.lane)} currentBranch={currentBranch} />
                  </span>
                  <span style={{ width: colAuthor }} className="shrink-0 truncate text-[12px] text-[var(--cf-text-muted)]">
                    {r.commit.author_name}
                  </span>
                  <span
                    style={{ width: colDate }}
                    className="shrink-0 truncate text-[12px] tabular-nums text-[var(--cf-text-faint)]"
                    title={formatFullDateTime(r.commit.timestamp)}
                  >
                    {formatDate(r.commit.timestamp)}
                  </span>
                  <span style={{ width: colHash }} className="shrink-0 truncate font-mono text-[12px] text-[var(--cf-text-faint)]">
                    {r.commit.short_id}
                  </span>
                </button>
                {/* Over the end of the row rather than beside it: the columns fill the table exactly,
                    so there is no spare width for it to take, and a control that appeared on hover
                    and *pushed* the hash would move the thing you were reading. The hash is left
                    aligned in its column, so the tail this sits over is empty. Revealed on hover and
                    on keyboard focus alike, which `hidden` could not do. */}
                {isHead && r.commit.parent_ids.length > 0 && (
                  <Tooltip label={t("graph.undoCommit")}>
                    <button
                      type="button"
                      aria-label={t("graph.undoCommit")}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (await confirmAction(t("graph.undoConfirm"))) {
                          void undoCommit(r.commit.id);
                        }
                      }}
                      className="absolute right-1.5 top-1/2 inline-flex h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-md bg-[var(--cf-surface-raised)] text-[var(--cf-text-muted)] opacity-0 shadow-[0_0_0_1px_var(--cf-border)] transition-opacity duration-100 hover:text-[var(--cf-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <RotateCcw size={13} />
                    </button>
                  </Tooltip>
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
                style={{
                  height: FILE_ROW_HEIGHT,
                  marginTop: FILE_LIST_PAD,
                  marginLeft: messageLeft,
                  paddingLeft: FILE_INDENT,
                }}
                className="flex items-center"
              >
                <Skeleton className="h-3 w-48 rounded" />
              </div>
            ) : commitDiff.length === 0 ? (
              // Reachable, and not a fallback for a slow fetch — `commitDiffLoading` above owns that
              // case. This is `git commit --allow-empty`, and a merge that resolved to no change.
              <div
                style={{
                  height: FILE_ROW_HEIGHT,
                  marginTop: FILE_LIST_PAD,
                  marginLeft: messageLeft,
                  paddingLeft: FILE_INDENT,
                }}
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
                  left={messageLeft}
                  width={`calc(${tableWidth} - ${messageLeft + ROW_PAD_RIGHT}px)`}
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
              className={buttonClass({ variant: "ghost", size: "sm" })}
            >
              {commitsLoadingMore ? <Loader2 size={13} className="animate-spin" /> : <ChevronsDown size={13} />}
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
    <div className={toolbarClass}>
      {/* Capped rather than full width: a filter box that runs the width of a wide pane is a long
          way to travel back from with the eye, and nothing typed into it is that long. */}
      <div className="relative w-full min-w-0 max-w-[460px]">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]"
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
          className={fieldClass({ size: "sm", className: "w-full pl-8 pr-7" })}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t("common.clear")}
            title={t("common.clear")}
            className="absolute right-0.5 top-1/2 flex h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-[5px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {/* Only while filtering, and it says both numbers: "12" alone leaves you wondering whether
          that is all the history or all the matches. */}
      {query.trim() && (
        <span className="shrink-0 text-[12px] tabular-nums text-[var(--cf-text-faint)]">
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

  // Both handed to the memoised `DiffView`, so both have to keep their identity across the renders
  // this component makes on every tick of a drag of the panel's seam — a fresh arrow or a fresh
  // element there would rebuild the whole diff per pointermove, which is what the memo is for.
  const closeFile = useCallback(() => void selectCommitFile(null), [selectCommitFile]);
  const shortId = selectedCommit?.short_id;
  const summary = selectedCommit?.summary;
  const commitContext = useMemo(
    () =>
      shortId === undefined ? undefined : (
        <>
          <span className="font-mono text-[var(--cf-text-muted)]">{shortId}</span> — {summary}
        </>
      ),
    [shortId, summary],
  );

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
            {commitFileDiffLoading ? (
              <>
                {/* While the file is on its way, a bar the height of the diff's own toolbar, holding
                    what is already known — the path and the way out — so the close button is where
                    it will be once the diff lands, and the path doesn't blink out for a round trip.
                    `dir="rtl"` on a truncating path so it loses the *front*: a column of
                    `src/components/git/Gra…` names nothing, `…/git/GraphView.tsx` names the file. */}
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-3 pr-2">
                  <span className="min-w-0 flex-1" title={selectedCommitPath}>
                    <span dir="rtl" className="block truncate text-left font-mono text-[12px] text-[var(--cf-text)]">
                      {`\u200e${selectedCommitPath}\u200e`}
                    </span>
                  </span>
                  <Tooltip label={t("graph.close")}>
                    <button
                      type="button"
                      onClick={closeFile}
                      aria-label={t("graph.close")}
                      className={iconButtonClass({ size: "xs" })}
                    >
                      <X size={14} />
                    </button>
                  </Tooltip>
                </div>
                <SkeletonRows count={10} className="cf-fade-in" />
              </>
            ) : (
              // `[]` and not "the file is missing": `DiffView`'s own empty state ("no changes") is
              // the honest reading of a delta with nothing in it, which is what a mode-only change
              // or a file the pathspec no longer matches comes back as.
              //
              // The diff's own toolbar carries the path, the view switch and the close button, and
              // the commit it came from rides on the line under it — one bar where there used to be
              // this panel's header, the diff's toolbar and a sticky file header, all three naming
              // the same file.
              <DiffView
                files={commitFileDiff ? [commitFileDiff] : []}
                onClose={closeFile}
                context={commitContext}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
