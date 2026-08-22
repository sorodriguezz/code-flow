import { useEffect, useMemo } from "react";
import { Info } from "lucide-react";
import { readFileText } from "../../lib/tauri/commands";
import { buildGraph, parseWorkflowNeeds, type GraphEdge, type GraphSource } from "../../lib/pipelineGraph";
import { useCiStore, runKey } from "../../state/ciStore";
import { useT } from "../../state/languageStore";
import { Skeleton } from "../common/Skeleton";
import { Tooltip } from "../common/Tooltip";
import { StatusGlyph } from "./RunList";
import { STATUS_TOKEN, at, elapsed, formatDuration, statusOf } from "./pipelineStatus";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { PipelineJob, PipelineRunDetail } from "../../types/domain";

/** Card and gutter geometry, fixed here so the connectors can be positioned arithmetically rather
 *  than measured. A measured layout would need a resize observer per card to place one arrowhead,
 *  and every arrow would lag a frame behind each drag of the pane's seam. */
const CARD_W = 178;
const CARD_H = 34;
const CARD_GAP = 7;
const GUTTER = 40;
const HEADER_H = 25;
const STEP = CARD_H + CARD_GAP;
/** Vertical room under the card block before the first bypass lane, and between lanes. */
const LANE_GAP = 13;
const LANE_STEP = 11;
/** Corner rounding on a bypass route's two right angles. */
const CORNER = 6;
/** Length of an arrowhead, so the stroke can stop short of its own point. */
const HEAD = 6;

const columnX = (column: number) => column * (CARD_W + GUTTER);
const cardMidY = (row: number) => HEADER_H + row * STEP + CARD_H / 2;
const cardBottom = (row: number) => HEADER_H + row * STEP + CARD_H;

const SOURCE_LABEL: Record<GraphSource, TranslationKey> = {
  stage: "pipelines.sourceStage",
  needs: "pipelines.sourceNeeds",
  time: "pipelines.sourceTime",
  flat: "pipelines.sourceTime",
};

/** The long version of each badge, for the tooltip — what the source *means*, and what it is worth.
 *  The badge itself has room for four words; "needs: from the workflow" is not self-explanatory to
 *  anyone who has not read `pipelineGraph.ts`, and this is the screen where it matters most that
 *  the reader knows how much to trust the drawing. */
const SOURCE_HINT: Record<GraphSource, TranslationKey> = {
  stage: "pipelines.sourceStageHint",
  needs: "pipelines.sourceNeedsHint",
  time: "pipelines.sourceTimeHint",
  flat: "pipelines.sourceTimeHint",
};

/**
 * Reads a GitHub run's workflow file out of the working copy so the graph has columns.
 *
 * This is the whole reason `PipelineRun.definition_path` exists. GitHub's jobs endpoint returns no
 * relation between jobs — not `needs`, not a stage, nothing — so without this the graph would have
 * to fall back to grouping by overlapping time for every GitHub run, which is the one grouping
 * that can be wrong.
 *
 * The two pieces were already here: `readFileText` and the `yaml` package the API client uses. No
 * request, no dependency.
 *
 * It can legitimately fail — the workflow may have been renamed since, or the working copy may sit
 * on a different commit than the run, in which case what we read is *a* workflow but not
 * necessarily *this run's*. Failure is recorded as `null` rather than left absent, so it is tried
 * once per run rather than on every render, and the panel then says its structure was measured
 * rather than declared.
 */
function useWorkflowNeeds(projectId: string, localPath: string | null, detail: PipelineRunDetail | undefined) {
  const rememberNeeds = useCiStore((s) => s.rememberNeeds);
  const needsByRun = useCiStore((s) => s.needsByRun);
  const run = detail?.run;
  const key = run ? runKey(projectId, run) : null;
  const known = key !== null && key in needsByRun;

  useEffect(() => {
    if (!run || !key || known) return;
    if (run.provider !== "github" || !run.definition_path || !localPath) return;
    let cancelled = false;
    void (async () => {
      const text = await readFileText(localPath, run.definition_path!).catch(() => null);
      if (cancelled) return;
      rememberNeeds(key, text ? parseWorkflowNeeds(text) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [run, key, known, localPath, rememberNeeds]);

  return key ? (needsByRun[key] ?? null) : null;
}

function JobCard({
  job,
  selected,
  now,
  onSelect,
}: {
  job: PipelineJob;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  // A job with no start time has not run: drawn as an outline rather than left out, because a
  // pipeline half way through has to show what is still coming.
  const pending = job.started_at === null;
  const took = elapsed(job.started_at, job.finished_at, now);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      style={{ height: CARD_H, width: CARD_W }}
      className={`relative flex shrink-0 items-center gap-2 rounded-[7px] border px-2 text-left transition-colors ${
        selected
          ? "border-[color-mix(in_oklab,var(--cf-accent)_55%,transparent)] bg-[var(--cf-accent-soft)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--cf-accent)_32%,transparent)]"
          : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[color-mix(in_oklab,var(--cf-accent)_40%,var(--cf-border))]"
      } ${pending ? "border-dashed opacity-60" : ""}`}
    >
      <StatusGlyph status={job.status} size={13} />
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{job.name}</span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
        {formatDuration(took)}
      </span>
    </button>
  );
}

interface DrawnEdge {
  key: string;
  /** The stroked route. */
  d: string;
  /** The filled triangle at its end. */
  head: string;
  lit: boolean;
}

/**
 * Every arrow's path, and how many bypass lanes the drawing needs under the cards.
 *
 * Two routes, because there are two kinds of arrow and drawing them the same way is what made the
 * old picture lie.
 *
 * **Between neighbouring columns** — the overwhelming majority, and all of them once
 * `transitiveReduction` has run — a bezier straight across the gutter. It leaves and arrives
 * horizontal, so a fixed right-pointing triangle is exact: no `<marker>`, no `orient="auto"`, and
 * none of the `context-stroke` inconsistencies markers still have across engines.
 *
 * **Skipping a column** — a dependency the layout genuinely doesn't already imply — down out of the
 * source's bottom edge, along a lane below the whole block, and back up into the target's bottom
 * edge with the head pointing *up*. Drawn straight, it would run behind the cards in between and
 * surface only as an arrowhead in the last gutter, where the reader attaches it to whichever short
 * arrow it happens to be lying on: an arrow you cannot trace back to its own tail is worse than no
 * arrow. Down here it has empty space to itself and a shape that says "this one goes around".
 *
 * Lanes are packed greedily on the horizontal span, so two bypasses that don't overlap share one
 * and the block only grows by what it has to.
 */
function layoutEdges(
  edges: GraphEdge[],
  position: Map<string, { column: number; row: number }>,
  blockBottom: number,
  selectedId: string | null | undefined,
): { drawn: DrawnEdge[]; laneCount: number } {
  const placed = edges.flatMap((edge) => {
    const from = position.get(edge.fromId);
    const to = position.get(edge.toId);
    if (!from || !to || from.column >= to.column) return [];
    return [{ edge, from, to }];
  });

  // Longest span first, so the arrow that has to travel furthest gets the lane nearest the cards
  // and the shorter ones nest under it instead of crossing it.
  const bypasses = placed
    .filter(({ from, to }) => to.column > from.column + 1)
    .sort((a, b) => b.to.column - b.from.column - (a.to.column - a.from.column));
  const laneOf = new Map<string, number>();
  const laneEnd: number[] = [];
  for (const { edge, from, to } of bypasses) {
    const left = columnX(from.column) + CARD_W - 22;
    const right = columnX(to.column) + 22;
    let lane = laneEnd.findIndex((end) => end < left - 10);
    if (lane === -1) {
      laneEnd.push(right);
      lane = laneEnd.length - 1;
    } else {
      laneEnd[lane] = right;
    }
    laneOf.set(`${edge.fromId}>${edge.toId}`, lane);
  }

  const drawn = placed.map(({ edge, from, to }) => {
    const key = `${edge.fromId}>${edge.toId}`;
    const lit = Boolean(selectedId) && (edge.fromId === selectedId || edge.toId === selectedId);
    const lane = laneOf.get(key);

    if (lane === undefined) {
      const x1 = columnX(from.column) + CARD_W;
      const y1 = cardMidY(from.row);
      const x2 = columnX(to.column) - HEAD;
      const y2 = cardMidY(to.row);
      // Enough horizontal pull that the curve leaves and arrives flat even when the two cards are
      // rows apart.
      const pull = Math.max(16, (x2 - x1) * 0.42);
      return {
        key,
        lit,
        d: `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`,
        head: `M ${x2 + HEAD} ${y2} L ${x2 - 1} ${y2 - 3.6} L ${x2 - 1} ${y2 + 3.6} Z`,
      };
    }

    const sx = columnX(from.column) + CARD_W - 22;
    const sy = cardBottom(from.row);
    const tx = columnX(to.column) + 22;
    const ty = cardBottom(to.row);
    const ly = blockBottom + LANE_GAP + lane * LANE_STEP;
    return {
      key,
      lit,
      d:
        `M ${sx} ${sy} V ${ly - CORNER} Q ${sx} ${ly} ${sx + CORNER} ${ly} ` +
        `H ${tx - CORNER} Q ${tx} ${ly} ${tx} ${ly - CORNER} V ${ty + HEAD}`,
      head: `M ${tx} ${ty} L ${tx - 3.6} ${ty + HEAD} L ${tx + 3.6} ${ty + HEAD} Z`,
    };
  });

  return { drawn, laneCount: laneEnd.length };
}

/**
 * The arrows, as one SVG behind the whole grid.
 *
 * What this replaces was a vertical bus in each gutter with a 17px stub off either side of every
 * card — a shape that says "these are connected" and refuses to say which way, and which falls
 * apart precisely where it matters most. Two parallel jobs produced one bus crossed by four stubs
 * and a T-junction in the middle of it, and nothing in that drawing distinguished the fan-*out*
 * into the pair from the fan-*in* out of it. Directed arrows do: four leaving one card read as
 * four, not as one line with notches.
 *
 * Under the cards, which only matters for the bezier route — the bypass lanes are in empty space
 * below the block and nothing can cover them.
 */
function Connectors({
  drawn,
  width,
  height,
}: {
  drawn: DrawnEdge[];
  width: number;
  height: number;
}) {
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      className="pointer-events-none absolute left-0 top-0"
    >
      {/* Lit edges last, so the arrows touching the job you have open are drawn over the ones that
          don't — the selection has to survive a crossing. */}
      {[...drawn.filter((edge) => !edge.lit), ...drawn.filter((edge) => edge.lit)].map((edge) => {
        const color = edge.lit ? "var(--cf-accent)" : "var(--cf-border)";
        return (
          <g key={edge.key}>
            <path d={edge.d} fill="none" stroke={color} strokeWidth={edge.lit ? 1.6 : 1.2} />
            <path d={edge.head} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The run as columns: one per stage, everything inside a column ran at the same time.
 *
 * Every card is placed by arithmetic — `columnX` and `cardMidY` — rather than by flow, because the
 * arrows behind them are drawn from the same two functions and a layout the SVG has to *measure*
 * is a layout the SVG gets wrong for one frame after every resize.
 */
function StageColumns({
  detail,
  now,
  needs,
}: {
  detail: PipelineRunDetail;
  now: number;
  needs: Map<string, string[]> | null;
}) {
  const selection = useCiStore((s) => s.selection);
  const selectJob = useCiStore((s) => s.selectJob);
  const t = useT();
  const graph = useMemo(() => buildGraph(detail.jobs, { needs }), [detail.jobs, needs]);

  const { drawn, width, height } = useMemo(() => {
    const position = new Map<string, { column: number; row: number }>();
    graph.columns.forEach((column, c) =>
      column.jobs.forEach((job, r) => position.set(job.id, { column: c, row: r })),
    );
    // Real dependencies when the workflow declared them; otherwise every card in a column to every
    // card in the next, which is all "these ran, then those ran" entitles anyone to draw.
    const edges =
      graph.edges.length > 0
        ? graph.edges
        : graph.columns.flatMap((column, c) =>
            c === 0
              ? []
              : graph.columns[c - 1].jobs.flatMap((from) =>
                  column.jobs.map((to) => ({ fromId: from.id, toId: to.id })),
                ),
          );
    const blockBottom = HEADER_H + Math.max(1, graph.maxParallel) * STEP - CARD_GAP;
    const { drawn, laneCount } = layoutEdges(edges, position, blockBottom, selection?.jobId);
    return {
      drawn,
      width: Math.max(1, graph.columns.length * (CARD_W + GUTTER) - GUTTER),
      // The lanes are part of the drawing, so they are part of its height: without this the block
      // would be exactly as tall as its cards and every bypass would be clipped by the scroller.
      height: blockBottom + (laneCount > 0 ? LANE_GAP + laneCount * LANE_STEP : 0),
    };
  }, [graph, selection?.jobId]);

  return (
    <div className="relative" style={{ width, height }}>
      <Connectors drawn={drawn} width={width} height={height} />
      {graph.columns.map((column, index) => (
        <div
          key={column.key}
          className="absolute top-0"
          style={{ left: columnX(index), width: CARD_W }}
        >
          <div className="flex items-center gap-1.5 px-0.5" style={{ height: HEADER_H }}>
            {/* Empty for a column of unrelated jobs — see `declaredLabel`. The badge then carries
                the header on its own, which is the one fact that column has to offer. */}
            {column.label && (
              <span className="truncate text-[10px] font-bold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {column.label}
              </span>
            )}
            {/* Said in words as well as drawn, because the drawing only works for people who
                already know how to read it — and this is the one fact the screen exists for. */}
            {column.jobs.length > 1 && (
              <span className="shrink-0 rounded-[3px] bg-[var(--cf-accent-soft)] px-1 text-[9px] font-bold uppercase tracking-wide text-[var(--cf-accent)]">
                {t("pipelines.inParallel", { n: column.jobs.length })}
              </span>
            )}
          </div>
          {column.jobs.map((job, row) => (
            <div key={job.id} className="absolute" style={{ top: HEADER_H + row * STEP }}>
              <JobCard
                job={job}
                now={now}
                selected={selection?.jobId === job.id}
                onSelect={() => void selectJob(job.id)}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The same run on a time axis.
 *
 * The graph shows what the pipeline *declares*; this shows what it *did*. Two bars that overlap
 * ran at the same time — there is no inference in it at all — which makes it the honest view
 * whenever the columns had to be guessed, and the useful one whenever the question is "what is
 * making this slow" rather than "what depends on what".
 */
function Waterfall({ detail, now }: { detail: PipelineRunDetail; now: number }) {
  const selection = useCiStore((s) => s.selection);
  const selectJob = useCiStore((s) => s.selectJob);
  const t = useT();

  const { start, total, longest } = useMemo(() => {
    const starts = detail.jobs.map((job) => at(job.started_at)).filter((n): n is number => n !== null);
    const ends = detail.jobs.map((job) => at(job.finished_at) ?? now);
    const start = starts.length ? Math.min(...starts) : (at(detail.run.created_at) ?? now);
    const end = ends.length ? Math.max(...ends, start) : start;
    const longest = detail.jobs.reduce(
      (most, job) => Math.max(most, elapsed(job.started_at, job.finished_at, now) ?? 0),
      0,
    );
    return { start, total: Math.max(end - start, 1000), longest };
  }, [detail, now]);

  return (
    <div className="min-w-[420px]">
      {detail.jobs.map((job) => {
        const jobStart = at(job.started_at);
        const took = elapsed(job.started_at, job.finished_at, now);
        const selected = selection?.jobId === job.id;
        const left = jobStart === null ? 0 : ((jobStart - start) / total) * 100;
        const width = took === null ? 0 : Math.max(0.8, (took / total) * 100);
        return (
          <button
            key={job.id}
            type="button"
            onClick={() => void selectJob(job.id)}
            aria-current={selected ? "page" : undefined}
            className={`flex h-6 w-full items-center rounded-[5px] text-left transition-colors ${
              selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            }`}
          >
            <span className="flex w-[152px] shrink-0 items-center gap-1.5 overflow-hidden pl-1.5">
              <StatusGlyph status={job.status} size={12} />
              <span className="truncate text-[11px]">{job.name}</span>
            </span>
            <span className="relative h-full flex-1">
              {jobStart === null ? (
                <span className="absolute left-0 top-[5px] text-[10px] text-[var(--cf-text-muted)]">
                  {t("pipelines.notStarted")}
                </span>
              ) : (
                <>
                  {/* The wait before it started — the part of a slow pipeline nobody is looking at
                      and half the answer most of the time. */}
                  {left > 0.4 && (
                    <span
                      aria-hidden
                      className="absolute top-[7px] h-3 rounded-l-[3px] opacity-45"
                      style={{
                        left: 0,
                        width: `${left}%`,
                        background:
                          "repeating-linear-gradient(115deg, var(--cf-border) 0 4px, transparent 4px 8px)",
                      }}
                    />
                  )}
                  <span
                    className="absolute top-[7px] h-3 rounded-[3px]"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      background: STATUS_TOKEN[statusOf(job.status)],
                    }}
                  />
                </>
              )}
            </span>
            {/* The duration in a column of its own, right-aligned.
                It used to be absolutely positioned just past the end of its own bar, which works
                until the bar is the longest one in the run — and the longest one is the whole point
                of this view. At 19m of a 19m pipeline the bar ends at ~100%, so the label started
                six pixels off the right edge, wrapped onto a second line and then a third, and
                spilled out of a 24px row into the two rows underneath it. A fixed column cannot
                collide with anything, and it has a second, better effect: the times line up, so
                they can be compared by reading straight down instead of by chasing them across.

                "The longest" is no longer spelled out beside the number — that is the phrase that
                made the label long enough to overflow in the one row where it appears. It is said
                in weight and colour instead, which survives any bar length, with the words kept in
                the `title`. Nothing is lost: the longest bar is also, by construction, the longest
                bar. */}
            <span
              title={took === longest && longest > 0 ? t("pipelines.longest") : undefined}
              className={`w-[72px] shrink-0 whitespace-nowrap pr-1.5 text-right text-[9.5px] tabular-nums ${
                took === longest && longest > 0
                  ? "font-semibold text-[var(--cf-text)]"
                  : "text-[var(--cf-text-muted)]"
              }`}
            >
              {jobStart === null ? "" : formatDuration(took)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The top half of the detail pane: the run's shape, in whichever of the two readings is selected.
 */
export function RunGraph({
  projectId,
  localPath,
  detail,
  loading,
  error,
  now,
}: {
  projectId: string;
  localPath: string | null;
  detail: PipelineRunDetail | undefined;
  /** The run's detail is in flight. Distinct from `detail === undefined`, which on its own cannot
   *  tell a pane that nothing has been picked apart from one whose pick has not arrived. */
  loading: boolean;
  /** Why it isn't coming. `""` for no error, the convention this store uses throughout. */
  error: string;
  now: number;
}) {
  const mode = useCiStore((s) => s.graphMode);
  const setGraphMode = useCiStore((s) => s.setGraphMode);
  const t = useT();
  const needs = useWorkflowNeeds(projectId, localPath, detail);

  const source: GraphSource = useMemo(() => {
    if (!detail) return "flat";
    return buildGraph(detail.jobs, { needs }).source;
  }, [detail, needs]);

  return (
    <>
      <div className="flex h-[29px] shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5">
        <span className="mr-auto flex min-w-0 items-center gap-2">
          <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {detail
              ? t("pipelines.structureOf", { name: detail.run.name })
              : t("pipelines.structure")}
          </span>
          {/* Where the columns came from, said out loud. The graph is only as trustworthy as its
              source, and "measured from timestamps" is a materially weaker claim than "declared by
              the pipeline" — a reader who can't tell them apart will believe the wrong one. */}
          {detail && (
            <Tooltip
              label={t(mode === "waterfall" ? "pipelines.sourceMeasured" : SOURCE_LABEL[source])}
              description={t(mode === "waterfall" ? "pipelines.sourceMeasuredHint" : SOURCE_HINT[source])}
            >
              <span className="flex shrink-0 items-center gap-1 rounded border border-[var(--cf-border)] px-1 text-[9.5px] text-[var(--cf-text-muted)]">
                <Info size={9} className="shrink-0 opacity-70" />
                {t(mode === "waterfall" ? "pipelines.sourceMeasured" : SOURCE_LABEL[source])}
              </span>
            </Tooltip>
          )}
        </span>
        {/* A segmented control, with room to be one.
            It used to be two buttons separated by a one-pixel seam of `--cf-border` inside a
            one-pixel frame of the same colour, which at 10.5px made "Grafo Cascada" read as a
            single smudged word: the gap between the two labels was smaller than the gap between
            the letters in either of them. What separates them now is space — a track two pixels
            wider than its thumbs, and 10px of padding inside each — plus a raised thumb on the
            selected one, so the pair reads as one control with one of its halves pressed. */}
        <div className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] p-[2px]">
          {(["graph", "waterfall"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setGraphMode(option)}
              aria-pressed={mode === option}
              className={`flex h-[19px] items-center rounded-[5px] px-2.5 text-[10.5px] font-semibold transition-colors ${
                mode === option
                  ? "bg-[var(--cf-surface)] text-[var(--cf-accent)] shadow-[0_1px_2px_rgba(0,0,0,0.16)]"
                  : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              }`}
            >
              {t(option === "graph" ? "pipelines.modeGraph" : "pipelines.modeWaterfall")}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3.5">
        {!detail && loading ? (
          /* Cards, not a spinner: the shape of what is coming is itself information, and a pane
             that keeps its geometry while it fills doesn't jump when it does. */
          <div className="flex items-start gap-10">
            {[0, 1, 2].map((column) => (
              <div key={column} className="flex flex-col" style={{ gap: CARD_GAP }}>
                <Skeleton className="h-2 w-20 rounded" style={{ marginBottom: HEADER_H - 8 }} />
                <Skeleton style={{ height: CARD_H, width: CARD_W }} className="rounded-[7px]" />
                {column === 1 && (
                  <Skeleton style={{ height: CARD_H, width: CARD_W }} className="rounded-[7px]" />
                )}
              </div>
            ))}
          </div>
        ) : !detail && error ? (
          <p className="text-[11.5px] text-[var(--cf-danger)]">{error}</p>
        ) : !detail ? (
          <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("pipelines.pickRun")}</p>
        ) : detail.jobs.length === 0 ? (
          <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("pipelines.noJobs")}</p>
        ) : mode === "graph" ? (
          <StageColumns detail={detail} now={now} needs={needs} />
        ) : (
          <Waterfall detail={detail} now={now} />
        )}
      </div>
    </>
  );
}
