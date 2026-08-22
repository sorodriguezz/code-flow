import { useEffect, useMemo } from "react";
import { readFileText } from "../../lib/tauri/commands";
import { buildGraph, parseWorkflowNeeds, type GraphSource } from "../../lib/pipelineGraph";
import { useCiStore, runKey } from "../../state/ciStore";
import { useT } from "../../state/languageStore";
import { StatusGlyph } from "./RunList";
import { STATUS_TOKEN, at, elapsed, formatDuration, statusOf } from "./pipelineStatus";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { PipelineJob, PipelineRunDetail } from "../../types/domain";

/** Card and gutter geometry, fixed here so the connector lines can be positioned arithmetically
 *  rather than measured. A measured layout would need a resize observer per column to draw one
 *  vertical line, and the line would lag a frame behind every drag of the pane's seam. */
const CARD_H = 34;
const CARD_GAP = 7;
const HEADER_H = 25;
const STEP = CARD_H + CARD_GAP;

const SOURCE_LABEL: Record<GraphSource, TranslationKey> = {
  stage: "pipelines.sourceStage",
  needs: "pipelines.sourceNeeds",
  time: "pipelines.sourceTime",
  flat: "pipelines.sourceTime",
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
      style={{ height: CARD_H }}
      className={`relative flex w-[178px] shrink-0 items-center gap-2 rounded-[7px] border px-2 text-left transition-colors ${
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

/**
 * The run as columns: one per stage, everything inside a column ran at the same time.
 *
 * The connectors are two 17px stubs per card plus one vertical bus in each gutter — the classic
 * fan-out/fan-in, which is what says "these four all follow that one" without a legend. They are
 * positioned from the constants at the top of this file rather than measured, so nothing here
 * needs a layout effect.
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

  return (
    <div className="flex min-w-min items-start">
      {graph.columns.map((column, index) => {
        const previous = graph.columns[index - 1];
        // The bus spans the taller of the two columns it joins, so a fan-out from one card to four
        // reaches all four and a fan-in from four to one starts at all four.
        const span = previous ? Math.max(previous.jobs.length, column.jobs.length) : 0;
        return (
          <div key={column.key} className="flex items-start">
            {previous && (
              <div className="relative w-[34px] self-stretch" aria-hidden>
                <span
                  className="absolute left-1/2 w-px bg-[var(--cf-border)]"
                  style={{ top: HEADER_H + CARD_H / 2, height: Math.max(1, (span - 1) * STEP) }}
                />
              </div>
            )}
            <div className="flex flex-col" style={{ gap: CARD_GAP }}>
              <div className="flex items-center gap-1.5 px-0.5" style={{ height: HEADER_H }}>
                <span className="truncate text-[10px] font-bold uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {column.label}
                </span>
                {/* Said in words as well as drawn, because the drawing only works for people who
                    already know how to read it — and this is the one fact the screen exists for. */}
                {column.jobs.length > 1 && (
                  <span className="shrink-0 rounded-[3px] bg-[var(--cf-accent-soft)] px-1 text-[9px] font-bold uppercase tracking-wide text-[var(--cf-accent)]">
                    {t("pipelines.inParallel", { n: column.jobs.length })}
                  </span>
                )}
              </div>
              {column.jobs.map((job) => (
                <div key={job.id} className="relative">
                  {/* The stubs that reach the bus on either side. */}
                  {index > 0 && (
                    <span
                      aria-hidden
                      className="absolute -left-[17px] top-1/2 h-px w-[17px] bg-[var(--cf-border)]"
                    />
                  )}
                  {index < graph.columns.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute -right-[17px] top-1/2 h-px w-[17px] bg-[var(--cf-border)]"
                    />
                  )}
                  <JobCard
                    job={job}
                    now={now}
                    selected={selection?.jobId === job.id}
                    onSelect={() => void selectJob(job.id)}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}
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
                  <span
                    className="absolute top-[5px] text-[9.5px] tabular-nums text-[var(--cf-text-muted)]"
                    style={{ left: `calc(${left + width}% + 6px)` }}
                  >
                    {formatDuration(took)}
                    {took === longest && longest > 0 ? ` · ${t("pipelines.longest")}` : ""}
                  </span>
                </>
              )}
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
  now,
}: {
  projectId: string;
  localPath: string | null;
  detail: PipelineRunDetail | undefined;
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
            <span className="shrink-0 rounded border border-[var(--cf-border)] px-1 text-[9.5px] text-[var(--cf-text-muted)]">
              {t(mode === "waterfall" ? "pipelines.sourceMeasured" : SOURCE_LABEL[source])}
            </span>
          )}
        </span>
        <div className="flex shrink-0 gap-px rounded-[5px] bg-[var(--cf-border)] p-px">
          {(["graph", "waterfall"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setGraphMode(option)}
              aria-pressed={mode === option}
              className={`rounded-[4px] px-2 py-px text-[10.5px] font-semibold transition-colors ${
                mode === option
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "bg-[var(--cf-surface)] text-[var(--cf-text-muted)]"
              }`}
            >
              {t(option === "graph" ? "pipelines.modeGraph" : "pipelines.modeWaterfall")}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3.5">
        {!detail ? (
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
