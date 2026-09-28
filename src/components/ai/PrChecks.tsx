import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  MinusCircle,
  RefreshCw,
  Workflow,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { chipClass } from "../common/recipes";
import { iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { checks as loadChecks, type PrTarget } from "../../lib/prTarget";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import type { PrCheck, PrChecks as PrChecksData, VcsProvider } from "../../types/domain";

/**
 * A pull request's CI checks — GitHub check runs and statuses, GitLab's head pipeline and its jobs,
 * Azure DevOps' statuses and branch policies — as a chip in the header and a compact list under it.
 *
 * Read when the document opens and again when the window regains focus: CI finishes while you are
 * elsewhere, and coming back to a stale "running" is the one moment the list is wrong in a way that
 * matters. Not polled — the Pipelines tab is the one screen in the app allowed to spend a rate limit
 * on a timer.
 */

/** The order a list is read in: what needs attention first. */
const RANK: Record<string, number> = { failed: 0, warning: 1, running: 2, queued: 3, cancelled: 4, skipped: 5, success: 6 };

const LOOK: Record<string, { icon: LucideIcon; tone: string; spin?: boolean }> = {
  success: { icon: CheckCircle2, tone: "text-[var(--cf-success)]" },
  failed: { icon: XCircle, tone: "text-[var(--cf-danger)]" },
  warning: { icon: AlertTriangle, tone: "text-[var(--cf-warning)]" },
  running: { icon: Loader2, tone: "text-[var(--cf-accent)]", spin: true },
  queued: { icon: Clock, tone: "text-[var(--cf-text-muted)]" },
  cancelled: { icon: MinusCircle, tone: "text-[var(--cf-text-faint)]" },
  skipped: { icon: MinusCircle, tone: "text-[var(--cf-text-faint)]" },
};

function look(state: string) {
  return LOOK[state] ?? LOOK.queued;
}

/** Failing first, then what is still running, then the rest — the host's order within each. */
export function sortChecks(checks: PrCheck[]): PrCheck[] {
  return checks
    .map((check, at) => ({ check, at }))
    .sort((a, b) => (RANK[a.check.state] ?? 3) - (RANK[b.check.state] ?? 3) || a.at - b.at)
    .map(({ check }) => check);
}

/** How a set of checks adds up: how many passed, how many are failing, how many still running. */
export function tallyChecks(checks: PrCheck[]): { total: number; passed: number; failing: number; pending: number } {
  let passed = 0;
  let failing = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.state === "success") passed++;
    else if (check.state === "failed") failing++;
    else if (check.state === "running" || check.state === "queued") pending++;
  }
  return { total: checks.length, passed, failing, pending };
}

/** Re-reading on focus is throttled to this: a window flicking in and out of focus is not news. */
const FOCUS_REFRESH_MS = 15_000;

/**
 * The checks of one pull request, kept current: read on mount, re-read when the window regains focus
 * while this document is the one on screen (`visibleRef` points at an element inside it — the
 * assistant keeps a few documents mounted but hidden, and those must not spend requests).
 */
export function usePrChecks(target: PrTarget, prId: number, prKey: string, visibleRef: RefObject<HTMLElement | null>) {
  const [data, setData] = useState<PrChecksData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const lastLoad = useRef(0);

  const reload = useCallback(() => {
    const token = ++request.current;
    lastLoad.current = Date.now();
    setLoading(true);
    return loadChecks(target, prId)
      .then((next) => {
        if (request.current !== token) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (request.current === token) setError(String(e));
      })
      .finally(() => {
        if (request.current === token) setLoading(false);
      });
    // `target` is rebuilt by the caller on every render; what matters is the pull request it names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prKey]);

  useEffect(() => {
    setData(null);
    setError(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = () => {
      const el = visibleRef.current;
      if (!el || el.offsetParent === null) return;
      if (Date.now() - lastLoad.current < FOCUS_REFRESH_MS) return;
      void reload();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload, visibleRef]);

  return { data, loading, error, reload };
}

/** The header's chip: the worst state's glyph and "passed of total". Nothing at all until the first
 * answer, and nothing for a pull request without checks — an empty chip says nothing useful. */
export function PrChecksChip({
  data,
  error,
  open,
  onToggle,
}: {
  data: PrChecksData | null;
  error: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  if (error && !data) {
    return (
      <Tooltip label={t("pr.checksFailed", { error })}>
        <span className={chipClass("neutral")}>
          <AlertTriangle size={11} className="text-[var(--cf-warning)]" />
          {t("pr.checks")}
        </span>
      </Tooltip>
    );
  }
  if (!data || data.checks.length === 0) return null;
  const tally = tallyChecks(data.checks);
  const worst = tally.failing > 0 ? "failed" : tally.pending > 0 ? "running" : tally.passed === tally.total ? "success" : "warning";
  const { icon: Icon, tone, spin } = look(worst);
  const detail = [
    t("pr.checksSummary", { passed: tally.passed, total: tally.total }),
    tally.failing > 0 ? t("pr.checksFailing", { n: tally.failing }) : null,
    tally.pending > 0 ? t("pr.checksRunning", { n: tally.pending }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip label={detail}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={chipClass(worst === "failed" ? "bad" : worst === "success" ? "ok" : "neutral", "cursor-pointer")}
      >
        <Icon size={11} className={`${tone} ${spin ? "animate-spin" : ""}`} />
        <span className="tabular-nums">
          {tally.passed}/{tally.total}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The checks, one line each: state, name, whether the host requires it, and where to open it — the
 * Pipelines tab when the check is a run CodeFlow can show (a project's own CI), the host otherwise.
 */
export function PrChecksList({
  data,
  loading,
  onRefresh,
  projectId,
  provider,
}: {
  data: PrChecksData;
  loading: boolean;
  onRefresh: () => void;
  /** Only a project has a Pipelines tab to open a run in. */
  projectId?: string;
  provider: VcsProvider;
}) {
  const t = useT();
  const openInPipelines = async (runId: string) => {
    if (!projectId) return;
    try {
      const { openPipelineAnalysis, runKey } = await import("../../state/ciStore");
      await openPipelineAnalysis({ projectId, meta: { pipelineRunKey: runKey(projectId, { provider, id: runId }) } });
    } catch (e) {
      pushErrorToast(String(e));
    }
  };
  return (
    <div className="rounded-lg border border-[var(--cf-border)] py-1">
      <div className="flex items-center gap-1 px-2.5 pb-0.5">
        <span className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
          {t("pr.checks")}
        </span>
        <Tooltip label={t("pr.checksRefresh")}>
          <button onClick={onRefresh} disabled={loading} aria-label={t("pr.checksRefresh")} className={iconButtonClass({ size: "xs" })}>
            <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
          </button>
        </Tooltip>
      </div>
      {sortChecks(data.checks).map((check, at) => {
        const { icon: Icon, tone, spin } = look(check.state);
        const runId = check.pipeline_run_id;
        return (
          <div key={`${check.kind}:${check.name}:${at}`} className="flex h-7 items-center gap-2 px-2.5 text-[12px]">
            <Icon size={13} className={`shrink-0 ${tone} ${spin ? "animate-spin" : ""}`} aria-label={check.raw_state} />
            <span className="min-w-0 truncate text-[var(--cf-text)]" title={check.description ?? check.raw_state}>
              {check.name}
            </span>
            {check.description && (
              <span className="min-w-0 shrink truncate text-[11px] text-[var(--cf-text-faint)]">{check.description}</span>
            )}
            {check.required && <span className={chipClass("neutral", "!h-4 !px-1 text-[10.5px]")}>{t("pr.checkRequired")}</span>}
            <span className="flex-1" />
            {runId && projectId && (
              <Tooltip label={t("pr.checkOpenInPipelines")}>
                <button
                  onClick={() => void openInPipelines(runId)}
                  aria-label={t("pr.checkOpenInPipelines")}
                  className={iconButtonClass({ size: "xs" })}
                >
                  <Workflow size={12} />
                </button>
              </Tooltip>
            )}
            {check.url && (
              <Tooltip label={t("pr.checkOpenOnHost")}>
                <a
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("pr.checkOpenOnHost")}
                  className={iconButtonClass({ size: "xs" })}
                >
                  <ExternalLink size={12} />
                </a>
              </Tooltip>
            )}
          </div>
        );
      })}
    </div>
  );
}
