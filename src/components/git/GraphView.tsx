import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { computeGraphLayout, laneColor } from "../../lib/graphLayout";
import { useRepoStore } from "../../state/repoStore";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { DiffView } from "./DiffView";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { Cloud, GitBranch, History, RotateCcw, Tag, X, type LucideIcon } from "lucide-react";
import { useT } from "../../state/languageStore";
import { SkeletonRows } from "../common/Skeleton";
import type { CommitRef, RefKind } from "../../types/domain";

const ROW_HEIGHT = 30;
const LANE_WIDTH = 16;
const DOT_RADIUS = 4;
const DIFF_MIN = 280;
const DIFF_MAX = 900;
const COL_MIN = 50;
const COL_MAX = 600;
const COLUMN_GAP = 8; // matches Tailwind gap-2

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatFullDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
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

/** Everything left of the diff panel: sticky column headers + the commit rows/graph SVG.
 * Memoized (and reading its own store slices rather than taking props) so dragging the diff
 * panel's resize handle — which only touches `graphDiffWidth` — doesn't force this
 * potentially long commit list to re-render on every pointermove tick. */
const CommitTable = memo(function CommitTable() {
  const commits = useRepoStore((s) => s.commits);
  const commitsLoading = useRepoStore((s) => s.commitsLoading);
  const status = useRepoStore((s) => s.status);
  const selectedCommitId = useRepoStore((s) => s.selectedCommitId);
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

  const layout = useMemo(() => computeGraphLayout(commits), [commits]);
  // From HEAD itself, not from whichever branch claims to be head: on a detached HEAD no branch
  // does, and deriving it from the branch list dropped the marker off the graph entirely just
  // when knowing where you are matters most.
  const headCommitId = status?.head_oid ?? null;
  // Null on a detached HEAD, which is the right answer rather than a missing one: no branch is
  // checked out, so no chip should be claiming to be the one you are on.
  const currentBranch = status?.is_detached ? null : (status?.current_branch ?? null);

  const svgWidth = layout.laneCount * LANE_WIDTH + 12;
  const svgHeight = layout.rows.length * ROW_HEIGHT;
  // Four fixed text columns (message is the fifth and takes the slack), and five `gap-2` seams:
  // one between each pair of the six children, the last of them before the lane graph.
  const fixedColumnsWidth = colHash + colDate + colAuthor + colRefs + COLUMN_GAP * 5;

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

  if (commits.length === 0 && commitsLoading) {
    return <SkeletonRows count={12} className="cf-fade-in" />;
  }

  if (commits.length === 0) {
    return <EmptyState icon={History} title={t("graph.noCommits")} subtitle={t("graph.noCommitsHint")} />;
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
  const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const rowY = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

  /** The fallback keeps the first paint honest, before the observer has run once. */
  const messageWidth = `var(--cf-graph-msg, ${colMessage}px)`;
  const textColumnsWidth = `calc(${fixedColumnsWidth}px + ${messageWidth})`;
  const totalWidth = `calc(${fixedColumnsWidth + svgWidth + 24}px + ${messageWidth})`;

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto">
      <div
        className="sticky top-0 z-10 flex h-6 min-w-full items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 text-[10px]"
        style={{ width: totalWidth, willChange: "transform", contain: "paint" }}
      >
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
        style={{ width: totalWidth, minHeight: svgHeight }}
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          style={{ left: textColumnsWidth, top: 0 }}
          className="pointer-events-none absolute"
        >
          {layout.edges.map((edge, i) => {
            const x1 = laneX(edge.fromLane);
            const y1 = rowY(edge.fromRow);
            const x2 = laneX(edge.toLane);
            const y2 = rowY(edge.toRow);
            const color = laneColor(edge.fromLane);
            if (x1 === x2) {
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2} />;
            }
            const midY = (y1 + y2) / 2;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                stroke={color}
                strokeWidth={2}
                fill="none"
              />
            );
          })}
          {layout.rows.map((r) => (
            <circle key={r.commit.id} cx={laneX(r.lane)} cy={rowY(r.row)} r={DOT_RADIUS} fill={laneColor(r.lane)} />
          ))}
        </svg>

        <div>
          {layout.rows.map((r) => {
            const isSelected = r.commit.id === selectedCommitId;
            const isHead = r.commit.id === headCommitId;
            return (
              <div
                key={r.commit.id}
                style={{ height: ROW_HEIGHT }}
                className={`group flex w-full items-center gap-2 px-3 text-[13px] ${
                  isSelected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
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
                  className="flex h-full flex-1 items-center gap-2 text-left"
                >
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
      </div>
    </div>
  );
});

export function GraphView() {
  const commits = useRepoStore((s) => s.commits);
  const selectedCommitId = useRepoStore((s) => s.selectedCommitId);
  const commitDiff = useRepoStore((s) => s.commitDiff);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const diffWidth = useLayoutStore((s) => s.sizes.graphDiffWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const t = useT();

  const selectedCommit = commits.find((c) => c.id === selectedCommitId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--cf-surface)]">
        <CommitTable />
      </div>

      {selectedCommit && (
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
            <div className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-1.5">
              <span className="truncate text-[12px] font-medium text-[var(--cf-text-muted)]">
                {selectedCommit.short_id} — {selectedCommit.summary}
              </span>
              <button
                onClick={() => selectCommit(null)}
                title={t("graph.close")}
                className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={14} />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <DiffView files={commitDiff} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
