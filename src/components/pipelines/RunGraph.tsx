import { useEffect, useMemo } from "react";
import { Info } from "lucide-react";
import { readFileText } from "../../lib/tauri/commands";
import {
  buildGraph,
  isSettled,
  layerDeclared,
  layerSpans,
  orderLayers,
  parseAzureStages,
  parseWorkflowNeeds,
  type DeclaredStages,
  type GraphEdge,
  type GraphSource,
  type PipelineGraph,
  type StageLayout,
} from "../../lib/pipelineGraph";
import { useCiStore, runKey } from "../../state/ciStore";
import { useT } from "../../state/languageStore";
import { Skeleton } from "../common/Skeleton";
import { Tooltip } from "../common/Tooltip";
import { StatusGlyph } from "./RunList";
import { STATUS_TOKEN, at, elapsed, formatDuration, statusOf } from "./pipelineStatus";
import type { TranslationKey } from "../../lib/i18n/translations";
import type {
  PipelineJob,
  PipelineRunDetail,
  PipelineStage,
  PipelineStatus,
} from "../../types/domain";

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

/**
 * The `dependsOn:` of an Azure run's pipeline file, read off disk once per run.
 *
 * A second hook rather than a branch inside [`useWorkflowNeeds`]: two providers, two file formats,
 * two caches, and — the part that matters — two *opposite* defaults for a missing declaration. One
 * function serving both is how the wrong default gets applied to the wrong provider.
 */
function useStageDeps(
  projectId: string,
  localPath: string | null,
  detail: PipelineRunDetail | undefined,
): DeclaredStages | null {
  const rememberStages = useCiStore((s) => s.rememberStages);
  const stagesByRun = useCiStore((s) => s.stagesByRun);
  const run = detail?.run;
  const key = run ? runKey(projectId, run) : null;
  const known = key !== null && key in stagesByRun;

  useEffect(() => {
    if (!run || !key || known) return;
    if (run.provider !== "azure" || !run.definition_path || !localPath) return;
    let cancelled = false;
    void (async () => {
      const text = await readFileText(localPath, run.definition_path!).catch(() => null);
      if (cancelled) return;
      rememberStages(key, text ? parseAzureStages(text) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [run, key, known, localPath, rememberStages]);

  return key ? (stagesByRun[key] ?? null) : null;
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

/** Where something sits, for the two routers below. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The route for an arrow that skips a column: out of the source's right edge, down the gutter,
 * along a lane beneath everything, up the gutter before the target and into its left edge.
 *
 * It used to drop straight out of the source card's **underside** and climb into the target's, and
 * that was fine while a column held one card per row with clear space below the block. It stopped
 * being fine the moment a column could hold a *stack*: the drop leg then ran behind whatever card
 * sat underneath the source, so the arrow appeared to leave the card below the one it actually
 * belongs to — an arrow attributed to the wrong stage is worse than no arrow, which is the same
 * argument that put these routes down here in the first place.
 *
 * The gutters are the fix because they are empty by construction: no card is ever drawn in one. So
 * both vertical legs run in open space, and the arrowhead arrives horizontally at the target's left
 * edge exactly like every other arrow on the drawing.
 */
function bypassRoute(from: Box, to: Box, gutter: number, laneY: number): { d: string; head: string } {
  const y1 = from.top + from.height / 2;
  const y2 = to.top + to.height / 2;
  const x1 = from.left + from.width;
  const x2 = to.left - HEAD;
  // The middle of the gutter on either side. Half a gutter is 20px at its narrowest, comfortably
  // more than the corner radius, so the arcs never overrun the straight they turn out of.
  const down = x1 + gutter / 2;
  const up = to.left - gutter / 2;
  return {
    d:
      `M ${x1} ${y1} H ${down - CORNER} Q ${down} ${y1} ${down} ${y1 + CORNER} ` +
      `V ${laneY - CORNER} Q ${down} ${laneY} ${down + CORNER} ${laneY} ` +
      `H ${up - CORNER} Q ${up} ${laneY} ${up} ${laneY - CORNER} ` +
      `V ${y2 + CORNER} Q ${up} ${y2} ${up + CORNER} ${y2} H ${x2}`,
    head: `M ${x2 + HEAD} ${y2} L ${x2 - 1} ${y2 - 3.6} L ${x2 - 1} ${y2 + 3.6} Z`,
  };
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
    const left = columnX(from.column) + CARD_W + GUTTER / 2;
    const right = columnX(to.column) - GUTTER / 2;
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

    return {
      key,
      lit,
      ...bypassRoute(
        { left: columnX(from.column), top: HEADER_H + from.row * STEP, width: CARD_W, height: CARD_H },
        { left: columnX(to.column), top: HEADER_H + to.row * STEP, width: CARD_W, height: CARD_H },
        GUTTER,
        blockBottom + LANE_GAP + lane * LANE_STEP,
      ),
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
 * The run as columns of **jobs**, for the two sources that have no stages to draw.
 *
 * This is the GitHub picture: levels read out of `needs:`, or waves measured off the clock. Neither
 * has a container to put a card around — a `needs:` level is not a thing the pipeline declares, it
 * is a thing we computed — so the drawing stays at the job level and the arrows carry the meaning.
 * A run whose provider *did* declare stages gets [`StageBoard`] instead.
 *
 * Every card is placed by arithmetic — `columnX` and `cardMidY` — rather than by flow, because the
 * arrows behind them are drawn from the same two functions and a layout the SVG has to *measure*
 * is a layout the SVG gets wrong for one frame after every resize.
 */
function JobColumns({ graph, now }: { graph: PipelineGraph; now: number }) {
  const selection = useCiStore((s) => s.selection);
  const selectJob = useCiStore((s) => s.selectJob);
  const t = useT();

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

/* ---------------------------------------------------------------------------
 * The stage board
 *
 * What a run looks like when its provider named its own stages — Azure Pipelines and GitLab. The
 * host's run page draws a **card per stage** with the jobs listed inside it, and so does this,
 * because a reader arrives here having just looked at that page and the two have to be the same
 * picture. What was here before drew the stage as a nine-pixel caption over a column of loose
 * pills: the stage's own status, its own clock and its own progress were nowhere on screen, and
 * five stages read as five jobs.
 * ------------------------------------------------------------------------- */

/** Stage card geometry. Fixed for the same reason the job cards' is: the connectors between the
 *  cards are drawn from these numbers, and a layout the SVG has to measure is one it draws wrong
 *  for a frame after every drag of the pane's seam. */
const STAGE_W = 224;
const STAGE_GUTTER = 46;
/** The header block: the stage's name over its summary line. */
const STAGE_HEAD_H = 45;
const STAGE_PAD = 5;
const STAGE_ROW_H = 25;
const STAGE_ROW_GAP = 3;

const stageX = (column: number) => column * (STAGE_W + STAGE_GUTTER);

/** A card's height from its row count. One row minimum: a stage the provider has not expanded yet
 *  still has a line to draw, and a card that collapsed to its header would read as a stage with
 *  nothing in it rather than one with nothing *yet*.
 *
 *  `+ 2` is the card's own border. Tailwind's preflight sets `box-sizing: border-box`, so a height
 *  written without it is two pixels short of what the contents need, and the body — the one child
 *  with no explicit height — is what gives them up: the rows then sat 5px below the header and 3px
 *  above the card's floor on every stage on the board. */
const stageHeight = (rows: number) => {
  const drawn = Math.max(1, rows);
  return 2 + STAGE_HEAD_H + STAGE_PAD * 2 + drawn * STAGE_ROW_H + (drawn - 1) * STAGE_ROW_GAP;
};

/** Border tint per stage status: only the three worth finding without reading — what is running,
 *  what is broken, what is nearly broken. A card per stage is a big enough object that colouring
 *  all seven would turn the board into a paint chart and none of them would stand out. */
const STAGE_BORDER: Record<PipelineStatus, string> = {
  queued: "border-[var(--cf-border)]",
  running: "border-[color-mix(in_oklab,var(--cf-accent)_50%,var(--cf-border))]",
  success: "border-[var(--cf-border)]",
  warning: "border-[color-mix(in_oklab,var(--cf-warning)_45%,var(--cf-border))]",
  failed: "border-[color-mix(in_oklab,var(--cf-danger)_50%,var(--cf-border))]",
  cancelled: "border-[var(--cf-border)]",
  skipped: "border-[var(--cf-border)]",
};

/**
 * A stage's status when the provider didn't send one — GitLab, and Azure's classic phases.
 *
 * Order is the argument. `running` comes first because a stage with one job burning and one job
 * already broken is a stage that is *still going*: calling it failed while it runs would be a
 * verdict the pipeline has not reached. A stage that has jobs waiting *and* jobs already finished
 * is the same fact from the other side, and one whose jobs are all still waiting is queued.
 *
 * "Already finished" pointedly excludes `skipped`, and that exclusion is the whole subtlety: a
 * GitLab job with `when: manual` is reported as skipped the moment its stage is processed, before
 * anything in the stage has run. Counting it as progress drew a spinner and an accent border over
 * a stage no job had entered, next to an empty duration, because nothing had started to measure.
 */
function deriveStageStatus(jobs: PipelineJob[]): PipelineStatus {
  const seen = new Set(jobs.map((job) => statusOf(job.status)));
  if (seen.size === 0) return "queued";
  if (seen.has("running")) return "running";
  if (seen.has("queued")) {
    const moved = jobs.some((job) => {
      const bucket = statusOf(job.status);
      return bucket !== "queued" && bucket !== "skipped";
    });
    return moved ? "running" : "queued";
  }
  if (seen.has("failed")) return "failed";
  if (seen.has("warning")) return "warning";
  if (seen.has("cancelled")) return "cancelled";
  if (seen.has("success")) return "success";
  return "skipped";
}

/**
 * The most jobs that were running at the same *instant*.
 *
 * The badge this feeds used to say "×N in parallel" about every job in a column, which for a stage
 * is not true and was never checked: a stage's jobs may declare `dependsOn` between themselves, and
 * two of them printed one under the other is not evidence they overlapped. This is evidence — a
 * sweep over the intervals, and the badge only appears when the answer is at least two.
 *
 * Ties are resolved end-before-start so that a job finishing at the exact moment the next one
 * starts — the ordinary shape of a sequential stage — counts as one, not two. Zero-length spans are
 * dropped rather than swept: they cannot overlap anything, and they would make the running count
 * dip below what is actually open.
 */
function peakOverlap(jobs: PipelineJob[], now: number): number {
  const events: { at: number; delta: number }[] = [];
  for (const job of jobs) {
    const start = at(job.started_at);
    if (start === null) continue;
    const end = at(job.finished_at) ?? now;
    if (end <= start) continue;
    events.push({ at: start, delta: 1 }, { at: end, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let open = 0;
  let peak = 0;
  for (const event of events) {
    open += event.delta;
    peak = Math.max(peak, open);
  }
  return peak;
}

/** Everything a card shows that isn't the job rows themselves. */
interface StageSummary {
  /** The provider's id for this stage, or `null` when the column had no record to match. Carried
   *  so the board can reach the stage's `ref_name` without re-deriving the lookup. */
  stageId: string | null;
  status: PipelineStatus;
  /** The provider's own word for it, for the header's `title`. Empty when nothing was quoted. */
  rawStatus: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The jobs to draw. Empty for a stage whose jobs the host has not expanded yet. */
  jobs: PipelineJob[];
  /**
   * The stage's stand-in job when `jobs` is empty — the thing the log pane can actually be pointed
   * at. Kept rather than discarded because `ciStore.pickInterestingJob` selects out of the raw job
   * list and will happily land on it: an Azure stage that failed at its approval gate is a `failed`
   * job with no card of its own, so the log pane opened on "Deploy" while the board above it
   * highlighted nothing.
   */
  placeholder: PipelineJob | null;
  /**
   * The job names the pipeline file declares under this stage, filled only when `jobs` is empty.
   *
   * Azure expands a stage's jobs into the timeline only when the stage *begins* — job expansion can
   * depend on runtime expressions — so a stage skipped by a condition arrives with its `Stage`
   * record and no `Job` records at all. Azure's own page still lists three jobs because it renders
   * the compiled plan; this is the same information, read from the file, and drawn as ghost rows
   * that say plainly they never ran. Empty when the file could not be read, and the card then says
   * what it has always said.
   */
  declaredJobs: string[];
  settled: number;
  overlap: number;
}

/**
 * One column of the graph, read as a stage.
 *
 * Three sources, in descending order of authority, and the order is the point:
 *
 *  1. the provider's own `Stage` record, when it sent one — see `PipelineStage`, which exists
 *     precisely because a stage's state and clock are not recoverable from its jobs;
 *  2. the **placeholder** job the Azure client emits for a stage it has not expanded yet, which is
 *     that stage's record wearing a job's shape and is identified by sharing its id;
 *  3. a roll-up of the jobs, which is all GitLab leaves us and is honest as far as it goes.
 *
 * Once (1) answers it answers completely — status *and* both timestamps. Mixing a record's status
 * with a rolled-up duration would produce a card whose number contradicts its icon on exactly the
 * builds where the difference matters: a stage held at an approval reads as `running` for minutes
 * during which no job is running at all.
 *
 * The record is looked up by **stage id**, never by the name on the card: see
 * `PipelineJob.stage_id` for the two stages called `Deploy` that made the difference matter.
 */
function summarise(
  stageId: string | null,
  columnJobs: PipelineJob[],
  stagesById: Map<string, PipelineStage>,
  declared: DeclaredStages | null,
  now: number,
): StageSummary {
  const record = (stageId !== null ? stagesById.get(stageId) : undefined) ?? null;
  // The placeholder is a column of exactly one "job" that is really the stage record — it shares
  // its id. Drawing it as a job row would print the stage's name twice, once as the card and once
  // inside it.
  const placeholder =
    columnJobs.length === 1 && stagesById.has(columnJobs[0].id) ? columnJobs[0] : null;
  const jobs = placeholder ? [] : columnJobs;
  const settled = jobs.filter((job) => isSettled(job.status)).length;
  const overlap = peakOverlap(jobs, now);
  const ref = (record ?? (placeholder ? stagesById.get(placeholder.id) : undefined))?.ref_name;
  // Only for a stage the host never expanded: where there are real jobs, they are the truth.
  const declaredJobs =
    jobs.length === 0 && ref ? (declared?.jobs.get(ref.toLowerCase()) ?? []) : [];

  const own = record ?? placeholder;
  if (own) {
    return {
      stageId,
      status: statusOf(own.status),
      rawStatus: own.raw_status,
      startedAt: own.started_at,
      finishedAt: own.finished_at,
      jobs,
      placeholder,
      declaredJobs,
      settled,
      overlap,
    };
  }

  const starts = jobs.map((job) => at(job.started_at)).filter((ms): ms is number => ms !== null);
  const ends = jobs.map((job) => at(job.finished_at)).filter((ms): ms is number => ms !== null);
  return {
    stageId,
    status: deriveStageStatus(jobs),
    rawStatus: "",
    startedAt: starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : null,
    // Only once every job has landed. While one is still going the stage has no end, and
    // `elapsed` measures it to now — which is what a stage in flight is actually doing.
    finishedAt:
      jobs.length > 0 && settled === jobs.length && ends.length > 0
        ? new Date(Math.max(...ends)).toISOString()
        : null,
    jobs,
    placeholder,
    declaredJobs,
    settled,
    overlap,
  };
}

/** One job, as a row inside its stage's card. */
function StageJobRow({
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
  const pending = job.started_at === null;
  const took = elapsed(job.started_at, job.finished_at, now);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      style={{ height: STAGE_ROW_H }}
      className={`flex w-full shrink-0 items-center gap-1.5 rounded-[5px] px-1.5 text-left transition-colors ${
        selected
          ? "bg-[var(--cf-accent-soft)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--cf-accent)_40%,transparent)]"
          : "hover:bg-black/[0.035] dark:hover:bg-white/[0.05]"
      } ${pending ? "opacity-55" : ""}`}
    >
      <StatusGlyph status={job.status} size={12} />
      <span className="min-w-0 flex-1 truncate text-[11px]">{job.name}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
        {pending ? "" : formatDuration(took)}
      </span>
    </button>
  );
}

/**
 * One stage: a header carrying the stage's own verdict, clock and progress, over its jobs.
 *
 * The header is the whole change. A stage is a thing with a state — it succeeds, it fails, it sits
 * on an approval — and the host's run page says so on every card. Reading it off the caption of a
 * column of pills was not possible, which is why the two screens didn't look like the same run.
 */
function StageCard({
  name,
  summary,
  left,
  top,
  selectedId,
  now,
  onSelect,
}: {
  name: string;
  summary: StageSummary;
  left: number;
  top: number;
  selectedId: string | null | undefined;
  now: number;
  onSelect: (jobId: string) => void;
}) {
  const t = useT();
  const took = elapsed(summary.startedAt, summary.finishedAt, now);
  const total = summary.jobs.length;
  const progress =
    total === 0
      ? ""
      : summary.settled === total
        ? total === 1
          ? t("pipelines.stageDoneOne")
          : t("pipelines.stageDone", { n: total })
        : t("pipelines.stageProgress", { done: summary.settled, total });

  return (
    <div
      style={{ left, top, width: STAGE_W, height: stageHeight(total) }}
      className={`absolute flex flex-col overflow-hidden rounded-[10px] border bg-[var(--cf-surface)] shadow-[var(--cf-shadow)] ${
        STAGE_BORDER[summary.status]
      } ${summary.status === "skipped" ? "opacity-[0.72]" : ""}`}
    >
      <div
        style={{ height: STAGE_HEAD_H }}
        title={summary.rawStatus || undefined}
        /* A tint of the text colour into the surface rather than `--cf-surface-raised`: that token
           is `#ffffff` in the light theme, identical to `--cf-surface`, so the header separated from
           the body in dark mode and vanished into it in light. Mixing against `--cf-text` moves the
           right way in both. */
        className="flex shrink-0 flex-col justify-center gap-[3px] border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-text)_4%,var(--cf-surface))] px-2"
      >
        <span className="flex items-center gap-1.5">
          <StatusGlyph status={summary.status} size={13} />
          {/* Its own `title`, because the wrapper's is the provider's raw status word: without
              this, hovering a stage name cut off at 13 characters answered "succeeded". */}
          <span title={name} className="min-w-0 flex-1 truncate text-[12px] font-semibold">
            {name}
          </span>
          {/* Measured, not assumed. Two jobs listed under one stage are not two jobs that ran
              together — a stage's jobs can depend on each other — so this only appears when their
              intervals genuinely overlapped, and the tooltip says that is what it means.

              On the name's row rather than under it: stage names are short and progress lines are
              not, and sharing the lower row left "2 jobs completed" truncated to "2 jobs com…" on
              every stage that had any parallelism at all — which is the stage the badge is for. */}
          {summary.overlap > 1 && (
            <span
              title={t("pipelines.overlapHint", { n: summary.overlap })}
              className="shrink-0 rounded-[3px] border border-[var(--cf-border)] px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]"
            >
              {t("pipelines.inParallel", { n: summary.overlap })}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-[var(--cf-text-muted)]">
          <span className="min-w-0 truncate">{progress}</span>
          <span className="ml-auto shrink-0 tabular-nums">{formatDuration(took)}</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-col" style={{ padding: STAGE_PAD, gap: STAGE_ROW_GAP }}>
        {summary.jobs.length === 0 ? (
          // Not an invented job list: the timeline does not say what this stage's jobs will be
          // called, and a guessed name on a CI screen is worse than an honest blank.
          //
          // Still a button, though, and bound to the placeholder job. That "job" is reachable
          // without it — `pickInterestingJob` picks the most alarming job in the run, and a stage
          // that failed at its approval gate *is* the most alarming — so a plain span left the log
          // pane opened on a job the board could neither highlight nor let you return to.
          <button
            type="button"
            disabled={summary.placeholder === null}
            onClick={() => summary.placeholder && onSelect(summary.placeholder.id)}
            aria-current={
              summary.placeholder && selectedId === summary.placeholder.id ? "page" : undefined
            }
            style={{ height: STAGE_ROW_H }}
            className={`flex w-full shrink-0 items-center rounded-[5px] px-1.5 text-left text-[10.5px] italic text-[var(--cf-text-muted)] transition-colors ${
              summary.placeholder && selectedId === summary.placeholder.id
                ? "bg-[var(--cf-accent-soft)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--cf-accent)_40%,transparent)]"
                : "enabled:hover:bg-black/[0.035] dark:enabled:hover:bg-white/[0.05]"
            }`}
          >
            {summary.declaredJobs.length > 0
              ? t("pipelines.stageJobDeclared")
              : t("pipelines.stageNotExpanded")}
          </button>
        ) : (
          summary.jobs.map((job) => (
            <StageJobRow
              key={job.id}
              job={job}
              now={now}
              selected={selectedId === job.id}
              onSelect={() => onSelect(job.id)}
            />
          ))
        )}

        {/* The jobs this stage *would* have run, when the pipeline file could be read.

            The objection the blank above answers — "a guessed name on a CI screen is worse than an
            honest blank" — is satisfied here: these are not guesses, they are the names written in
            the file, and the row says out loud that none of them happened. Non-interactive, because
            there is no log to open: the host reported nothing for them. */}
        {summary.jobs.length === 0 &&
          summary.declaredJobs.map((name, at) => (
            <div
              key={`${name}:${at}`}
              title={t("pipelines.stageJobDeclaredHint")}
              style={{ height: STAGE_ROW_H }}
              className="flex w-full shrink-0 items-center gap-1.5 rounded-[5px] border border-dashed border-[var(--cf-border)] px-1.5 text-[10.5px] italic text-[var(--cf-text-muted)] opacity-55"
            >
              <span className="h-2 w-2 shrink-0 rounded-full border border-current" />
              <span className="truncate">{name}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

/**
 * The elbow between two stage cards: out of the right edge, across the gutter, into the left edge.
 *
 * Orthogonal rather than the bezier the job graph uses, and deliberately: cards of different job
 * counts have their mid-points at different heights, and a curve between two of them reads as a
 * flourish. A right angle with a rounded corner reads as a route — which is also what the host's
 * own run page draws, so the two pictures agree down to the joinery.
 */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y2 - y1) < 1) return `M ${x1} ${y1} H ${x2}`;
  const midX = (x1 + x2) / 2;
  const dir = y2 > y1 ? 1 : -1;
  // Never round more than half of either leg, or the two arcs meet and cross.
  const r = Math.max(1, Math.min(CORNER, Math.abs(y2 - y1) / 2, (x2 - x1) / 2));
  return (
    `M ${x1} ${y1} H ${midX - r} Q ${midX} ${y1} ${midX} ${y1 + dir * r} ` +
    `V ${y2 - dir * r} Q ${midX} ${y2} ${midX + r} ${y2} H ${x2}`
  );
}

/** Vertical room between two stage cards sharing a column. Wider than the gap between job rows
 *  inside a card, so a column of two stages never reads as one tall stage. */
const STAGE_LANE_GAP = 16;

/** One stage, placed. */
interface PlacedStage {
  key: string;
  name: string;
  summary: StageSummary;
  /** Which column it sits in — its depth in the gating order, not its position in the file. */
  lane: number;
  left: number;
  top: number;
  height: number;
}

export interface StageBoardModel {
  placed: PlacedStage[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** Whether anything actually runs beside anything else. */
  branched: boolean;
  /** Which of the two arrangements drew it — a declaration, or the clocks. Drives the badge. */
  layout: StageLayout;
}

/**
 * The board: which stage sits where, and what points at what.
 *
 * The columns are **not** the stages in file order, and that is the whole point of this function.
 * Stages do not queue up one behind another — the build in the screenshot that started this ran
 * `Testing` and `Build` at the same time and then `Quality Code` beside `Deploy` — and drawn as a
 * row of five the picture said the opposite of what the host's own page showed.
 *
 * Nothing here is guessed at from scratch: [`layerSpans`] places each stage at the end of the
 * longest chain of stages that could have gated it, out of the stage clocks the provider already
 * gave us, and hands back the covering pairs as the arrows. What it cannot know is a `dependsOn`
 * that the clock does not betray — two stages that genuinely ran back to back for want of an agent
 * look like a dependency — which is what the header badge is for.
 */
function buildStageBoard(
  graph: PipelineGraph,
  stages: PipelineStage[],
  declared: DeclaredStages | null,
  now: number,
): StageBoardModel {
  // By id, not by name: `byStage` already groups the jobs by `stage_id`, and two stages sharing a
  // `displayName` have to find their own record rather than the last one to claim the string.
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  const cards = graph.columns.map((column) => ({
    key: column.key,
    name: column.label,
    summary: summarise(column.jobs[0]?.stage_id ?? null, column.jobs, stagesById, declared, now),
  }));

  // What the pipeline file said, when it could be read — and only then. Everything else falls
  // through to the clocks, which is what this board has always used.
  const refByKey = new Map(
    cards.map((card) => [
      card.key,
      (card.summary.stageId !== null ? stagesById.get(card.summary.stageId)?.ref_name : null) ?? null,
    ]),
  );
  const fromFile = declared
    ? layerDeclared(
        cards.map((card) => card.key),
        (key) => refByKey.get(key) ?? null,
        declared.deps,
      )
    : null;
  const measured = fromFile
    ? null
    : layerSpans(
        cards.map((card) => ({
          key: card.key,
          startedAt: card.summary.startedAt,
          finishedAt: card.summary.finishedAt,
          settled: isSettled(card.summary.status),
        })),
      );
  const spans = fromFile ?? measured!;
  const layout: StageLayout = fromFile ? "dependsOn" : "clocks";
  const { edges, branched } = spans;
  // Cross as few arrows as possible, with declaration order as the tie-break so the board cannot
  // reshuffle itself between two polls of identical data.
  const layers = orderLayers(spans.layers, edges);

  const byKey = new Map(cards.map((card) => [card.key, card]));
  const heightOf = (key: string) => {
    const card = byKey.get(key)!;
    // A stage that never expanded shows the jobs its file declares instead, so the card has to be
    // tall enough for whichever list it ends up drawing.
    return stageHeight(Math.max(card.summary.jobs.length, card.summary.declaredJobs.length));
  };

  /**
   * Each card pulled toward the centre of what points at it, then pushed clear of its neighbour.
   *
   * A plain `top += height` stack per column is what drew the old chain, and it is wrong the moment
   * a column holds more than one card: `Quality Code` waits on `Testing` alone, so it belongs level
   * with `Testing` and not at the top of its column beside nothing. Predecessors always sit in a
   * strictly earlier lane — longest-path layering guarantees it — so one forward pass is exact.
   */
  const preds = new Map<string, string[]>();
  for (const edge of edges) {
    const existing = preds.get(edge.toId);
    if (existing) existing.push(edge.fromId);
    else preds.set(edge.toId, [edge.fromId]);
  }
  const top = new Map<string, number>();
  const centre = (key: string) => top.get(key)! + heightOf(key) / 2;
  layers.forEach((layer, lane) => {
    let cursor: number | null = null;
    for (const key of layer) {
      const parents = (preds.get(key) ?? []).filter((parent) => top.has(parent));
      const want =
        lane === 0 || parents.length === 0
          ? null
          : parents.reduce((sum, parent) => sum + centre(parent), 0) / parents.length -
            heightOf(key) / 2;
      const y: number = want === null ? (cursor ?? 0) : cursor === null ? want : Math.max(cursor, want);
      top.set(key, y);
      cursor = y + heightOf(key) + STAGE_LANE_GAP;
    }
  });
  // Normalised once at the end rather than clamped per card: the pull toward a parent's centre can
  // legitimately push a later column above the first one, and clamping would flatten exactly the
  // alignment this pass exists to produce.
  const shift = Math.min(...top.values());
  const placed: PlacedStage[] = [];
  let height = 0;
  layers.forEach((layer, lane) => {
    for (const key of layer) {
      const card = byKey.get(key)!;
      const cardHeight = heightOf(key);
      const y = top.get(key)! - shift;
      placed.push({ ...card, lane, left: stageX(lane), top: y, height: cardHeight });
      height = Math.max(height, y + cardHeight);
    }
  });

  return {
    placed,
    edges,
    width: Math.max(1, layers.length * (STAGE_W + STAGE_GUTTER) - STAGE_GUTTER),
    height: Math.max(1, height),
    branched,
    layout,
  };
}

/**
 * Every arrow on the board, and how much room the routes underneath it need.
 *
 * Two shapes, for the same reason the job graph has two. An arrow between **neighbouring columns**
 * is an elbow across the gutter, which is empty space by construction. An arrow that **skips a
 * column** — which the layering does produce, when the thing it points at was pushed deeper by a
 * longer chain elsewhere — cannot go straight: it would pass behind the cards in between and
 * surface only as an arrowhead, attached in the reader's eye to whichever short arrow it happens to
 * be lying on. Those drop below the whole board, run along a lane of their own and come back up
 * into the target's underside, which is a shape that says "this one goes around".
 */
function boardEdges(
  board: StageBoardModel,
  selectedId: string | null | undefined,
): { drawn: DrawnEdge[]; laneCount: number } {
  const rect = new Map(board.placed.map((stage) => [stage.key, stage]));
  const holdsSelection = (stage: PlacedStage) =>
    Boolean(selectedId) && stage.summary.jobs.some((job) => job.id === selectedId);

  const routed = board.edges.flatMap((edge) => {
    const from = rect.get(edge.fromId);
    const to = rect.get(edge.toId);
    if (!from || !to || from.lane >= to.lane) return [];
    return [{ edge, from, to }];
  });

  // How many arrows leave each card and arrive at each card, so a fan can be told from a chain.
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();
  for (const { edge } of routed) {
    fanOut.set(edge.fromId, (fanOut.get(edge.fromId) ?? 0) + 1);
    fanIn.set(edge.toId, (fanIn.get(edge.toId) ?? 0) + 1);
  }

  // Longest span first, so the arrow that has to travel furthest takes the lane nearest the board
  // and the shorter ones nest under it instead of crossing it. Same packing as `layoutEdges`.
  const laneOf = new Map<string, number>();
  const laneEnd: number[] = [];
  for (const { edge, from, to } of routed
    .filter(({ from, to }) => to.lane > from.lane + 1)
    .sort((a, b) => b.to.lane - b.from.lane - (a.to.lane - a.from.lane))) {
    const left = from.left + STAGE_W + STAGE_GUTTER / 2;
    const right = to.left - STAGE_GUTTER / 2;
    let lane = laneEnd.findIndex((occupied) => occupied < left - 10);
    if (lane === -1) {
      laneEnd.push(right);
      lane = laneEnd.length - 1;
    } else {
      laneEnd[lane] = right;
    }
    laneOf.set(`${edge.fromId}>${edge.toId}`, lane);
  }

  const drawn = routed.map(({ edge, from, to }) => {
    const key = `${edge.fromId}>${edge.toId}`;
    const lit = holdsSelection(from) || holdsSelection(to);
    const lane = laneOf.get(key);

    if (lane === undefined) {
      const x1 = from.left + STAGE_W;
      const y1 = from.top + from.height / 2;
      const x2 = to.left - HEAD;
      const y2 = to.top + to.height / 2;
      // A chain stays an elbow; a fan curves.
      //
      // `elbow` puts every arrow's vertical leg on the same `midX`, which is right when one card
      // points at one card and unreadable the moment three siblings leave together: the three legs
      // land on one corridor and the result is a ladder nobody can trace back. The curve separates
      // them by construction, and it is the shape Azure's own board draws in exactly this case.
      const fanning = (fanOut.get(edge.fromId) ?? 0) > 1 || (fanIn.get(edge.toId) ?? 0) > 1;
      // All N arrows still leave a card from the *same* point. Spreading the exits would imply the
      // arrows belong to N different things inside the card, and they do not — they belong to it.
      const pull = Math.max(18, (x2 - x1) * 0.45);
      return {
        key,
        lit,
        d: fanning
          ? `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`
          : elbow(x1, y1, x2, y2),
        // Both routes arrive horizontal, so one fixed right-pointing triangle serves either.
        head: `M ${x2 + HEAD} ${y2} L ${x2 - 1} ${y2 - 3.6} L ${x2 - 1} ${y2 + 3.6} Z`,
      };
    }

    return {
      key,
      lit,
      ...bypassRoute(
        { left: from.left, top: from.top, width: STAGE_W, height: from.height },
        { left: to.left, top: to.top, width: STAGE_W, height: to.height },
        STAGE_GUTTER,
        board.height + LANE_GAP + lane * LANE_STEP,
      ),
    };
  });

  return { drawn, laneCount: laneEnd.length };
}

/**
 * The run as a board of stage cards, laid out by what ran beside what.
 *
 * The joins are between *cards* and not between jobs on purpose: a stage name says which jobs ran
 * under it and nothing whatever about which of them fed which, and an arrow from one job to another
 * would be claiming a dependency nobody reported. Between stages there is something to claim —
 * see [`buildStageBoard`].
 */
function StageBoard({ board, now }: { board: StageBoardModel; now: number }) {
  const selection = useCiStore((s) => s.selection);
  const selectJob = useCiStore((s) => s.selectJob);

  const { drawn, laneCount } = useMemo(
    () => boardEdges(board, selection?.jobId),
    [board, selection?.jobId],
  );
  // The bypass lanes are part of the drawing, so they are part of its height: without this the
  // block would be exactly as tall as its cards and every route under them would be clipped.
  const height = board.height + (laneCount > 0 ? LANE_GAP + laneCount * LANE_STEP : 0);

  return (
    <div className="relative" style={{ width: board.width, height }}>
      <Connectors drawn={drawn} width={board.width} height={height} />
      {board.placed.map((stage) => (
        <StageCard
          key={stage.key}
          name={stage.name}
          summary={stage.summary}
          left={stage.left}
          top={stage.top}
          selectedId={selection?.jobId}
          now={now}
          onSelect={(jobId) => void selectJob(jobId)}
        />
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
  const declaredStages = useStageDeps(projectId, localPath, detail);

  // Built once and handed down rather than rebuilt inside each drawing, which is what the two used
  // to do.
  const graph = useMemo(() => (detail ? buildGraph(detail.jobs, { needs }) : null), [detail, needs]);
  const board = useMemo(
    () =>
      detail && graph?.source === "stage"
        ? buildStageBoard(graph, detail.stages, declaredStages, now)
        : null,
    [graph, detail, declaredStages, now],
  );
  const source: GraphSource = graph?.source ?? "flat";
  // Keyed on where the *arrangement* came from, not on whether it happened to come out branched.
  //
  // It used to say `sourceStage` — whose hint promises "nothing here is inferred" — for any board
  // that drew as a chain. But a chain is a result, not a source: the columns were measured off the
  // stage clocks either way, and a measurement that lands on a straight line is still a
  // measurement. So a clock-drawn board says so whatever shape it took, and only a board drawn from
  // a `dependsOn:` read out of the pipeline file gets to claim it was declared.
  const label: TranslationKey =
    mode === "waterfall"
      ? "pipelines.sourceMeasured"
      : board
        ? board.layout === "dependsOn"
          ? "pipelines.sourceStageDeps"
          : "pipelines.sourceStageOrder"
        : SOURCE_LABEL[source];
  const hint: TranslationKey =
    mode === "waterfall"
      ? "pipelines.sourceMeasuredHint"
      : board
        ? board.layout === "dependsOn"
          ? "pipelines.sourceStageDepsHint"
          : "pipelines.sourceStageOrderHint"
        : SOURCE_HINT[source];

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
            <Tooltip label={t(label)} description={t(hint)}>
              <span className="flex shrink-0 items-center gap-1 rounded border border-[var(--cf-border)] px-1 text-[9.5px] text-[var(--cf-text-muted)]">
                <Info size={9} className="shrink-0 opacity-70" />
                {t(label)}
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
        ) : mode !== "graph" ? (
          <Waterfall detail={detail} now={now} />
        ) : board ? (
          /* The provider named its stages, so the drawing is made of stages — the same shape the
             host's own run page uses, because that is the shape the reader arrived with. */
          <StageBoard board={board} now={now} />
        ) : graph ? (
          <JobColumns graph={graph} now={now} />
        ) : null}
      </div>
    </>
  );
}
