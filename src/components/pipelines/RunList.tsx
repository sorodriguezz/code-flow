import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { openExternalUrl } from "../../lib/tauri/commands";
import { riseDelay } from "../../lib/rise";
import { useCiStore } from "../../state/ciStore";
import { useT } from "../../state/languageStore";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Tooltip } from "../common/Tooltip";
import { PIPELINE_STATUS, STATUS_ORDER, STATUS_TOKEN, elapsed, formatDuration, statusOf } from "./pipelineStatus";
import type { PipelineRun } from "../../types/domain";

/** The status glyph, or the orb — the one status this app never draws with a glyph. */
export function StatusGlyph({ status, size = 14 }: { status: string; size?: number }) {
  const t = useT();
  const bucket = statusOf(status);
  if (bucket === "running") return <ThinkingOrb size="sm" />;
  const Icon = PIPELINE_STATUS[bucket].icon;
  return (
    <Icon
      size={size}
      className={`shrink-0 ${PIPELINE_STATUS[bucket].color}`}
      aria-label={t(PIPELINE_STATUS[bucket].labelKey)}
    />
  );
}

/**
 * How many jobs this run had, and how they ended — one segment each.
 *
 * The strip is the smallest honest answer to the question this whole screen was rebuilt around:
 * a run is not a sequence of jobs, it is a handful of them mostly running at once. Reading four
 * red segments out of six tells you more about a failed build than the single verdict glyph does,
 * and it costs one row of three pixels.
 *
 * Only drawn once the run has been opened at least once — the list response carries no jobs, and
 * a strip that appears on click would read as the click having changed something.
 */
function ParallelStrip({ statuses }: { statuses: string[] }) {
  if (statuses.length === 0) return null;
  return (
    <span aria-hidden className="mt-1 flex gap-[1.5px]">
      {statuses.slice(0, 12).map((status, index) => (
        <i
          key={index}
          className="h-[3px] flex-1 rounded-[2px]"
          style={{ background: STATUS_TOKEN[statusOf(status)] }}
        />
      ))}
    </span>
  );
}

function RunRow({
  run,
  projectId,
  selected,
  at,
  now,
  jobStatuses,
}: {
  run: PipelineRun;
  projectId: string;
  selected: boolean;
  at: number;
  now: number;
  jobStatuses: string[];
}) {
  const selectRun = useCiStore((s) => s.selectRun);
  const t = useT();
  const took = elapsed(run.started_at ?? run.created_at, run.finished_at, now);

  return (
    <button
      type="button"
      style={riseDelay(at)}
      onClick={() => void selectRun(projectId, run)}
      aria-current={selected ? "page" : undefined}
      className={`cf-rise flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
        selected
          ? "bg-[var(--cf-accent-soft)]"
          : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <span className="mt-[1px] shrink-0">
        <StatusGlyph status={run.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[12.5px] font-medium">{run.name}</span>
          {run.number !== null && (
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              #{run.number}
            </span>
          )}
          <span className="ml-auto shrink-0 pl-1.5 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
            {formatDuration(took)}
          </span>
        </span>
        <span className="mt-px flex items-center gap-1 overflow-hidden text-[11px] text-[var(--cf-text-muted)]">
          <span className="font-mono text-[10.5px]">{run.commit_sha.slice(0, 7)}</span>
          <span className="opacity-45">·</span>
          <span className="truncate">{run.branch}</span>
          {jobStatuses.length > 0 && (
            <>
              <span className="opacity-45">·</span>
              <span className="shrink-0">{t("pipelines.jobCount", { n: jobStatuses.length })}</span>
            </>
          )}
        </span>
        <ParallelStrip statuses={jobStatuses} />
      </span>
    </button>
  );
}

/**
 * The left column: this repository's runs, newest first.
 *
 * Filtering is split on purpose. The **branch** filter is applied by the host — it is a query
 * parameter, so narrowing to one branch fetches that branch's history rather than showing whatever
 * of it happened to be on the first page. The **status** filter is applied here, because no
 * provider offers "only the failures" as a query and asking for five pages to find three red runs
 * would spend a rate limit to do badly what a client-side filter does instantly.
 */
export function RunList({ projectId, currentBranch }: { projectId: string; currentBranch: string | null }) {
  const runs = useCiStore((s) => s.runsByProject[projectId]);
  const loading = useCiStore((s) => s.loadingProjectId === projectId);
  const selection = useCiStore((s) => s.selection);
  const detailByRun = useCiStore((s) => s.detailByRun);
  const branchFilter = useCiStore((s) => s.branchFilterByProject[projectId] ?? null);
  const statusFilter = useCiStore((s) => s.statusFilter);
  const setBranchFilter = useCiStore((s) => s.setBranchFilter);
  const setStatusFilter = useCiStore((s) => s.setStatusFilter);
  const load = useCiStore((s) => s.load);
  const t = useT();

  // One clock for every row, ticked by the poll rather than by a timer of its own: a running run's
  // elapsed time only has to be as fresh as the data behind it. It does have to be *ticked*,
  // though — read once at mount it froze, so a run that started after the tab was opened showed a
  // negative age and a running one stopped counting.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
  }, [runs]);

  const visible = useMemo(() => {
    const list = runs ?? [];
    return statusFilter ? list.filter((run) => run.status === statusFilter) : list;
  }, [runs, statusFilter]);

  return (
    <>
      <div className="flex h-[29px] shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("pipelines.runs")}
        </span>
        <Tooltip label={t("pipelines.refresh")}>
          <button
            type="button"
            onClick={() => void load(projectId)}
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          </button>
        </Tooltip>
        {visible.length > 0 && (
          <Tooltip label={t("pipelines.openOnHost")}>
            <button
              type="button"
              onClick={() => void openExternalUrl(visible[0].web_url)}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
            >
              <ExternalLink size={13} />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
        <FilterChip active={branchFilter === null} onClick={() => setBranchFilter(projectId, null)}>
          {t("pipelines.allBranches")}
        </FilterChip>
        {currentBranch && (
          <FilterChip
            active={branchFilter === currentBranch}
            onClick={() => setBranchFilter(projectId, branchFilter === currentBranch ? null : currentBranch)}
          >
            {currentBranch}
          </FilterChip>
        )}
        <FilterChip
          active={statusFilter === "failed"}
          onClick={() => setStatusFilter(statusFilter === "failed" ? null : "failed")}
        >
          {t(PIPELINE_STATUS.failed.labelKey)}
        </FilterChip>
        {statusFilter !== null && statusFilter !== "failed" && (
          <FilterChip active onClick={() => setStatusFilter(null)}>
            {t(PIPELINE_STATUS[statusFilter].labelKey)}
          </FilterChip>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1">
        {visible.map((run, index) => {
          const key = `${projectId}:${run.provider}:${run.id}`;
          return (
            <RunRow
              key={key}
              run={run}
              projectId={projectId}
              at={index}
              now={now}
              selected={
                selection?.projectId === projectId &&
                selection.runId === run.id &&
                selection.provider === run.provider
              }
              jobStatuses={detailByRun[key]?.jobs.map((job) => job.status) ?? []}
            />
          );
        })}
        {visible.length === 0 && statusFilter !== null && (
          <p className="px-2 py-3 text-[11.5px] text-[var(--cf-text-muted)]">
            {t("pipelines.noneWithStatus", { status: t(PIPELINE_STATUS[statusFilter].labelKey) })}
          </p>
        )}
      </div>
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`max-w-[130px] truncate rounded-full border px-2 py-px text-[11px] transition-colors ${
        active
          ? "border-[color-mix(in_oklab,var(--cf-accent)_30%,transparent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      {children}
    </button>
  );
}

/** Exported for the status filter's menu, which the header renders. */
export { STATUS_ORDER };
