import { useEffect, useMemo, useState } from "react";
import { ExternalLink, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import { openExternalUrl } from "../../lib/tauri/commands";
import { riseDelay } from "../../lib/rise";
import { useCiStore } from "../../state/ciStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { Select, type SelectOption } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { Tooltip } from "../common/Tooltip";
import {
  PIPELINE_STATUS,
  STATUS_ORDER,
  STATUS_TOKEN,
  // Aliased: `RunRow` takes a prop called `at` — the rise-delay index — which shadows this
  // import inside the one component that needs it, and does so as a `number`, so the mistake
  // surfaces as "Type 'Number' has no call signatures" rather than as anything about names.
  at as epochOf,
  elapsed,
  formatDuration,
  statusOf,
} from "./pipelineStatus";
import type { PipelineRun } from "../../types/domain";

/**
 * A job or a run that is currently moving.
 *
 * **Deliberately not `ThinkingOrb`.** That mark means *an engine is thinking* — an agent turn, a
 * story generation, a review stage — and this app has spent it consistently enough that a reader
 * has learned it. A CI job is a build on somebody else's runner; there is no model in it, nothing
 * is being reasoned about, and nothing here is spending tokens. Wearing the orb, a `pnpm build`
 * claimed to be an AI run, which is the one thing a status glyph must never get wrong.
 *
 * A plain spinning arc instead — the same vocabulary as the refresh button two rows up, and the
 * one shape that means "in progress" in every tool the reader already uses.
 */
export function RunningGlyph({ size = 14 }: { size?: number }) {
  const t = useT();
  return (
    <LoaderCircle
      size={size}
      className="shrink-0 animate-spin text-[var(--cf-accent)]"
      aria-label={t("pipelines.statusRunning")}
    />
  );
}

/** The status glyph, or the spinner — the one status this app never draws with a static icon. */
export function StatusGlyph({ status, size = 14 }: { status: string; size?: number }) {
  const t = useT();
  const bucket = statusOf(status);
  if (bucket === "running") return <RunningGlyph size={size} />;
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
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const took = elapsed(run.started_at ?? run.created_at, run.finished_at, now);

  /**
   * When it ran, absolute.
   *
   * The row answered "how long" and never "when", and that is the question a list of runs is
   * actually read for: whether the red one at the top is from this morning's push or from last
   * Thursday. A duration cannot say it and neither can the order — the list is newest-first, which
   * tells you the sequence and nothing about the gaps.
   *
   * `started_at`, because that is when it *ran*; a queued run has not started, so it falls back to
   * when it was created — the same fallback `took` uses one line up, so the two can never describe
   * different moments.
   *
   * Date *and* time, both always, for the reason `NotificationBell` writes down: a list that mixes
   * today and yesterday needs the date to be readable, and "14:32" alone is a lie once the app has
   * been open overnight. The full stamp, seconds and timezone included, is in the title.
   */
  const stamp = epochOf(run.started_at ?? run.created_at);
  const ran = stamp === null ? null : new Date(stamp);

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
          {/* `ml-auto` and `shrink-0`, mirroring the duration one line up: the timestamp is a fixed
              width and the branch is not, so when the column is narrow the branch is what gives way
              — losing the tail of a branch name costs less than losing the date entirely. */}
          {ran !== null && (
            <span
              className="ml-auto shrink-0 pl-1.5 tabular-nums"
              title={ran.toLocaleString(locale)}
            >
              {ran.toLocaleDateString(locale, { day: "2-digit", month: "short" })}{" "}
              {ran.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
            </span>
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
  const branchesSeen = useCiStore((s) => s.branchesSeenByProject[projectId]);
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

  /**
   * Every branch that has run something here, with the one you are standing on lifted to the top.
   *
   * This used to be two chips: "all branches", and the checked-out branch. Which is the whole
   * story in a repository where CI only ever runs on `main`, and useless in one where it doesn't —
   * a release branch's runs were *in* the list, mixed in with everything else and identifiable
   * only by reading the second line of each row, and there was no way to ask for just them. The
   * options come from `branchesSeenByProject`, so this lists branches that have actually built
   * rather than every ref in the repository, most of which never will.
   *
   * The checked-out branch keeps its glyph and its place at the top even when a dozen others exist:
   * it is the one branch whose runs are about the code in the editor behind this panel.
   */
  const branchOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [{ value: "", label: t("pipelines.allBranches") }];
    const taken = new Set([""]);
    for (const branch of [currentBranch, branchFilter]) {
      if (branch && !taken.has(branch)) {
        taken.add(branch);
        options.push({ value: branch, label: branch, icon: branch === currentBranch ? GitBranch : undefined });
      }
    }
    for (const branch of branchesSeen ?? []) {
      if (!taken.has(branch)) {
        taken.add(branch);
        options.push({ value: branch, label: branch });
      }
    }
    return options;
  }, [branchesSeen, currentBranch, branchFilter, t]);

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

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
        <div className="min-w-[124px] flex-1">
          <Select
            size="compact"
            value={branchFilter ?? ""}
            onChange={(value) => setBranchFilter(projectId, value === "" ? null : value)}
            options={branchOptions}
            ariaLabel={t("pipelines.branchFilter")}
          />
        </div>
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
        {/* The first load used to leave this column completely blank — no rows, no message, no
            spinner — for as long as the host took to answer, which on a cold GitHub call is a
            couple of seconds of a screen that looks broken. Placeholders in the shape of the rows
            that are coming: two lines and a strip, the same 46px, so nothing shifts when they
            arrive. Only while there is nothing to show; a *refresh* keeps the rows it already has,
            because replacing a readable list with grey bars every poll would be worse. */}
        {loading && visible.length === 0 &&
          Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="flex items-start gap-2 px-2 py-1.5">
              <Skeleton className="mt-[2px] h-3.5 w-3.5 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3 rounded" style={{ width: `${52 + ((index * 17) % 34)}%` }} />
                <Skeleton className="mt-1.5 h-2 w-1/3 rounded" />
                <Skeleton className="mt-1.5 h-[3px] rounded" />
              </div>
            </div>
          ))}
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
      // `py-1` and not `py-px`: this chip now shares its row with the branch `Select`, whose
      // `compact` size is the same 11px text over the same vertical padding. A one-pixel pill next
      // to a 26px trigger read as two controls that had wandered in from different screens.
      className={`max-w-[130px] shrink-0 truncate rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
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
