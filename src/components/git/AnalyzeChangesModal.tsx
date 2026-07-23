import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { analyzeWorkingChanges } from "../../lib/tauri/commands";
import { parseAnalysis, type AnalysisFinding } from "../../lib/parseAnalysis";
import { useJobsStore, EMPTY_JOBS } from "../../state/jobsStore";
import { useT } from "../../state/languageStore";

const SEVERITY_STYLE: Record<AnalysisFinding["severity"], { icon: typeof AlertOctagon; color: string }> = {
  critical: { icon: AlertOctagon, color: "var(--cf-danger)" },
  warning: { icon: AlertTriangle, color: "var(--cf-warning)" },
  info: { icon: Info, color: "var(--cf-accent)" },
};

function FindingCard({ finding, defaultOpen }: { finding: AnalysisFinding; defaultOpen: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const { icon: Icon, color } = SEVERITY_STYLE[finding.severity];

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
        style={{ borderLeft: `3px solid ${color}` }}
      >
        <Icon size={14} className="mt-0.5 shrink-0" style={{ color }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <span className="font-semibold uppercase tracking-wide" style={{ color }}>
              {finding.type}
            </span>
            <span>·</span>
            <span>{finding.category}</span>
            <span>·</span>
            <span className="font-mono">{finding.id}</span>
          </div>
          <p className="mt-0.5 text-[13px] font-medium text-[var(--cf-text)]">{finding.subtitle}</p>
        </div>
        {finding.confidence !== null && (
          <span
            className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
          >
            {finding.confidence}%
          </span>
        )}
        {open ? (
          <ChevronDown size={13} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={13} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--cf-border)] px-3 py-2.5 text-[12px]">
          {finding.why && (
            <p>
              <span className="font-medium text-[var(--cf-text)]">💭 {t("analyze.why")}: </span>
              <span className="text-[var(--cf-text-muted)]">{finding.why}</span>
            </p>
          )}
          {finding.suggestion && (
            <p>
              <span className="font-medium text-[var(--cf-text)]">💡 {t("analyze.suggestion")}: </span>
              <span className="text-[var(--cf-text-muted)]">{finding.suggestion}</span>
            </p>
          )}
          {finding.exampleCode && (
            <pre className="overflow-x-auto rounded-md bg-black/[0.04] p-2 font-mono text-[11px] leading-relaxed dark:bg-white/[0.06]">
              {finding.exampleCode}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function AnalyzeChangesModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useT();
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
  // reopening this modal (or landing on it from the AI panel's history) should show whatever
  // last ran, not silently kick off another Claude invocation. Guarded with a ref rather than
  // just checking `job`: React StrictMode double-invokes effects in dev, and both invocations
  // would otherwise see the same (still-null) `job` from the same render and each start their
  // own analysis — producing two job entries for one modal open.
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[75vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--cf-border)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} className="text-[var(--cf-accent)]" />
            <span className="text-[13px] font-semibold">{t("analyze.title")}</span>
            {!loading && !error && findings.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px]">
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
          <div className="flex items-center gap-1">
            <button
              onClick={runAnalysis}
              disabled={loading}
              title={t("analyze.reanalyze")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Loader2 size={20} className="animate-spin text-[var(--cf-accent)]" />
              <p className="text-[13px] text-[var(--cf-text-muted)]">{t("analyze.analyzing")}</p>
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
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <ShieldCheck size={28} className="text-[var(--cf-success)]" />
              <p className="max-w-xs text-[13px] text-[var(--cf-text-muted)]">
                {summary || t("analyze.noFindings")}
              </p>
            </div>
          )}

          {!loading && !error && findings.length > 0 && (
            <div className="space-y-2">
              {findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} defaultOpen={finding.severity !== "info"} />
              ))}
            </div>
          )}
        </div>

        {footer && !loading && (
          <div className="shrink-0 border-t border-[var(--cf-border)] px-4 py-2 text-[11px] text-[var(--cf-text-muted)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
