import { useMemo } from "react";
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

export function GraphView() {
  const commits = useRepoStore((s) => s.commits);
  const commitsLoading = useRepoStore((s) => s.commitsLoading);
  const branches = useRepoStore((s) => s.branches);
  const selectedCommitId = useRepoStore((s) => s.selectedCommitId);
  const commitDiff = useRepoStore((s) => s.commitDiff);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const undoCommit = useRepoStore((s) => s.undoCommit);
  const diffWidth = useLayoutStore((s) => s.sizes.graphDiffWidth);
  const colHash = useLayoutStore((s) => s.sizes.graphColHash);
  const colDate = useLayoutStore((s) => s.sizes.graphColDate);
  const colAuthor = useLayoutStore((s) => s.sizes.graphColAuthor);
  const colMessage = useLayoutStore((s) => s.sizes.graphColMessage);
  const colRefs = useLayoutStore((s) => s.sizes.graphColRefs);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const t = useT();

  const layout = useMemo(() => computeGraphLayout(commits), [commits]);
  const headCommitId = branches.find((b) => b.is_head)?.target ?? null;
  const selectedCommit = commits.find((c) => c.id === selectedCommitId) ?? null;

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
    { key: "graphColMessage" as const, width: colMessage, label: t("graph.colMessage") },
    { key: "graphColRefs" as const, width: colRefs, label: t("graph.colRefs") },
  ];
  const textColumnsWidth = columns.reduce((sum, c) => sum + c.width, 0) + COLUMN_GAP * columns.length;

  const svgWidth = layout.laneCount * LANE_WIDTH + 12;
  const svgHeight = layout.rows.length * ROW_HEIGHT;
  // Coordinates local to the graph SVG itself, which is offset by textColumnsWidth via `left`.
  const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const rowY = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const totalWidth = textColumnsWidth + svgWidth;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 overflow-auto">
        <div
          className="sticky top-0 z-10 flex h-6 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 text-[10px]"
          style={{ width: totalWidth + 24, willChange: "transform", contain: "paint" }}
        >
          {columns.map((col) => (
            <div key={col.key} style={{ width: col.width }} className="flex shrink-0 items-center">
              <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {col.label}
              </span>
              <ResizeHandle
                axis="x"
                value={col.width}
                min={COL_MIN}
                max={COL_MAX}
                onChange={(w) => setSize(col.key, w)}
                onCommit={(w) => commitSize(col.key, w)}
              />
            </div>
          ))}
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("graph.colGraph")}
          </span>
        </div>

        <div className="relative" style={{ width: totalWidth + 24, minHeight: svgHeight }}>
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
                  <button
                    onClick={() => selectCommit(isSelected ? null : r.commit.id)}
                    style={{ width: textColumnsWidth }}
                    className="flex shrink-0 items-center gap-2 text-left"
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
                    <span style={{ width: colMessage }} className="shrink-0 truncate text-[var(--cf-text)]">
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
          <div style={{ width: diffWidth }} className="flex shrink-0 flex-col overflow-hidden border-l border-[var(--cf-border)]">
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
