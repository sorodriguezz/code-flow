import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, Square, X } from "lucide-react";
import { analyzeWorkingChanges } from "../../lib/tauri/commands";
import { parseAnalysis } from "../../lib/parseAnalysis";
import { useJobsStore, EMPTY_JOBS } from "../../state/jobsStore";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import { useT } from "../../state/languageStore";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { renderMarkdown } from "../../lib/markdown";
import { FindingCard, QualityGateBadges, SHORT_SUMMARY_MAX } from "./FindingCard";
import { AiErrorBanner } from "./AiErrorBanner";
import { AiRunLog } from "./AiRunLog";

/** Pre-commit change analysis, shown inline in the AI panel (alongside chat and PR review)
 * instead of a separate modal — so it shares the same "Activity" job tracking and the same
 * always-available surface as everything else Claude does for this project. */
export function AnalyzeSection({ projectId }: { projectId: string }) {
  const t = useT();
  const hide = useAnalyzeUiStore((s) => s.hide);
  const selectedJobId = useAnalyzeUiStore((s) => s.selectedJobId);
  const jobs = useJobsStore((s) => s.byProject[projectId] ?? EMPTY_JOBS);
  // A specific past run is pinned by id when opened from the Activity list; otherwise show the
  // project's most recent analysis. Selecting by id is what stops every analyze entry from
  // aliasing onto the newest run.
  const job = useMemo(
    () =>
      (selectedJobId
        ? jobs.find((j) => j.id === selectedJobId)
        : jobs.find((j) => j.kind === "analyze-changes")) ?? null,
    [jobs, selectedJobId],
  );

  const runAnalysis = () => {
    const id = useJobsStore.getState().run({
      projectId,
      kind: "analyze-changes",
      // A per-run time stamp in the label so each analysis is identifiable in the Activity
      // list instead of every entry reading the same "Análisis de cambios".
      label: `${t("analyze.title")} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      task: (jobId) => analyzeWorkingChanges(projectId, jobId),
    });
    // Pin this section to the run it just started, so its own result shows here and the
    // Activity list highlights the right row.
    useAnalyzeUiStore.getState().showJob(id);
  };

  // Auto-start only when landing on the section fresh (no pinned historical run) with nothing to
  // show yet — reopening, or selecting a past run, must never kick off a new Claude invocation.
  // Guarded with a ref rather than just checking `job`: React StrictMode double-invokes effects
  // in dev, and both invocations would otherwise see the same (still-null) `job` and each start
  // their own analysis — producing two job entries for one open.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!selectedJobId && !job && !startedRef.current) {
      startedRef.current = true;
      runAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selectedJobId]);

  const [logExpanded, setLogExpanded] = useState(false);
  const loading = job?.status === "running" || !job;
  const cancelled = job?.status === "cancelled";
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
          <div className="space-y-3">
            <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
              <ThinkingOrb size="lg" />
              <p className="text-[13px] text-[var(--cf-text-muted)]">{t("ai.working")}</p>
            </div>
            {job && (
              <AiRunLog
                runId={job.id}
                running
                expanded={logExpanded}
                onToggle={() => setLogExpanded((v) => !v)}
              />
            )}
          </div>
        )}

        {cancelled && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Square size={20} className="fill-current text-[var(--cf-text-muted)]" />
            <p className="text-[13px] text-[var(--cf-text-muted)]">{t("ai.runStopped")}</p>
            <button onClick={runAnalysis} className="text-[12px] text-[var(--cf-accent)] underline">
              {t("analyze.reanalyze")}
            </button>
          </div>
        )}

        {!loading && error && <AiErrorBanner error={error} />}

        {!loading && !cancelled && !error && findings.length === 0 && (
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

        {!loading && !cancelled && !error && findings.length > 0 && (
          <div className="space-y-3">
            {summary && (
              <div
                className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3.5 py-2.5"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
              />
            )}
            <div className="space-y-2">
              {findings.map((finding) => (
                <FindingCard
                  key={finding.id}
                  finding={finding}
                  defaultOpen={false}
                  projectId={projectId}
                  resolutionKey={job ? `job:${job.id}:${finding.id}` : undefined}
                />
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
