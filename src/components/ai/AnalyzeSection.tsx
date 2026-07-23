import { useEffect, useMemo, useRef } from "react";
import { RefreshCw, ShieldCheck, X } from "lucide-react";
import { analyzeWorkingChanges } from "../../lib/tauri/commands";
import { parseAnalysis } from "../../lib/parseAnalysis";
import { useJobsStore, EMPTY_JOBS } from "../../state/jobsStore";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import { useT } from "../../state/languageStore";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { renderMarkdown } from "../../lib/markdown";
import { FindingCard, QualityGateBadges, SHORT_SUMMARY_MAX } from "./FindingCard";

/** Pre-commit change analysis, shown inline in the AI panel (alongside chat and PR review)
 * instead of a separate modal — so it shares the same "Activity" job tracking and the same
 * always-available surface as everything else Claude does for this project. */
export function AnalyzeSection({ projectId }: { projectId: string }) {
  const t = useT();
  const hide = useAnalyzeUiStore((s) => s.hide);
  const jobs = useJobsStore((s) => s.byProject[projectId] ?? EMPTY_JOBS);
  const job = useMemo(() => jobs.find((j) => j.kind === "analyze-changes") ?? null, [jobs]);

  const runAnalysis = () => {
    useJobsStore.getState().run({
      projectId,
      kind: "analyze-changes",
      label: t("analyze.title"),
      task: () => analyzeWorkingChanges(projectId),
    });
  };

  // Reuses the project's existing analyze-changes job instead of always starting a new one —
  // reopening this section (or landing on it from the AI panel's Activity list) should show
  // whatever last ran, not silently kick off another Claude invocation. Guarded with a ref
  // rather than just checking `job`: React StrictMode double-invokes effects in dev, and both
  // invocations would otherwise see the same (still-null) `job` and each start their own
  // analysis — producing two job entries for one open.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!job && !startedRef.current) {
      startedRef.current = true;
      runAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const loading = job?.status === "running" || !job;
  const error = job?.status === "error" ? job.error : null;
  const parsed = useMemo(() => (job?.status === "done" && job.result ? parseAnalysis(job.result) : null), [job]);
  const findings = parsed?.findings ?? [];
  const summary = parsed?.summary ?? "";
  const footer = parsed?.footer ?? null;

  const counts = {
    critical: findings.filter((f) => f.severity === "critical").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4">
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
          <div className="min-w-0 flex-1">
            <p className="mb-0.5 text-[13px] font-semibold">{t("analyze.title")}</p>
            {!loading && !error && parsed && <QualityGateBadges grades={parsed.grades} findings={findings} />}
            {!loading && !error && findings.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                {counts.critical > 0 && (
                  <span className="rounded-full px-1.5 py-0.5 font-medium" style={{ background: "color-mix(in oklab, var(--cf-danger) 16%, transparent)", color: "var(--cf-danger)" }}>
                    {counts.critical} {t("analyze.critical")}
                  </span>
                )}
                {counts.warning > 0 && (
                  <span className="rounded-full px-1.5 py-0.5 font-medium" style={{ background: "color-mix(in oklab, var(--cf-warning) 16%, transparent)", color: "var(--cf-warning)" }}>
                    {counts.warning} {t("analyze.warning")}
                  </span>
                )}
                {counts.info > 0 && (
                  <span className="rounded-full px-1.5 py-0.5 font-medium" style={{ background: "color-mix(in oklab, var(--cf-accent) 16%, transparent)", color: "var(--cf-accent)" }}>
                    {counts.info} {t("analyze.info")}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={runAnalysis}
            disabled={loading}
            title={t("analyze.reanalyze")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={hide}
            title={t("chat.backToChat")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={14} />
          </button>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <ThinkingOrb size="lg" />
            <p className="text-[13px] text-[var(--cf-text-muted)]">{t("ai.working")}</p>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-[var(--cf-danger)]/30 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] p-4">
            <p className="text-[13px] text-[var(--cf-danger)]">
              {error.isQuotaExceeded ? t("changes.quotaMessage") : error.message}
            </p>
            {error.isQuotaExceeded && (
              <p className="mt-1 text-[12px] text-[var(--cf-text-muted)]">
                {error.resetHint ? t("changes.quotaRetry", { hint: error.resetHint }) : t("changes.quotaRetryLater")}
              </p>
            )}
          </div>
        )}

        {!loading && !error && findings.length === 0 && (
          summary.length > 0 && summary.length > SHORT_SUMMARY_MAX ? (
            // Nothing matched the expected "### finding" format at all — rather than lose
            // the model's actual answer, render the raw response as markdown instead of a
            // wall of unstyled plain text.
            <div
              className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-4"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <ShieldCheck size={28} className="text-[var(--cf-success)]" />
              <p className="max-w-xs text-[13px] text-[var(--cf-text-muted)]">
                {summary || t("analyze.noFindings")}
              </p>
            </div>
          )
        )}

        {!loading && !error && findings.length > 0 && (
          <div className="space-y-3">
            {summary && (
              <div
                className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3.5 py-2.5"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
              />
            )}
            <div className="space-y-2">
              {findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} defaultOpen={finding.severity !== "info"} projectId={projectId} />
              ))}
            </div>
          </div>
        )}

        {footer && !loading && (
          <p className="mt-3 text-[11px] text-[var(--cf-text-muted)]">{footer}</p>
        )}
      </div>
    </div>
  );
}
