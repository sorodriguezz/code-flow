import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { computeGraphLayout, laneColor } from "../../lib/graphLayout";
import { useRepoStore } from "../../state/repoStore";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { DiffView } from "./DiffView";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { History, RotateCcw, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { SkeletonRows } from "../common/Skeleton";

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
                  <span style={{ width: colRefs }} className="flex shrink-0 gap-1 overflow-hidden">
                    {r.commit.refs.slice(0, 2).map((ref) => (
                      <span
                        key={ref}
                        className="truncate rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          background: "var(--cf-accent-soft)",
                          color: "var(--cf-accent)",
                        }}
                      >
                        {ref}
                      </span>
                    ))}
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
