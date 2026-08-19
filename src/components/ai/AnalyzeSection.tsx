import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, Square, X } from "lucide-react";
import { analyzeWorkingChanges } from "../../lib/tauri/commands";
import { parseAnalysis } from "../../lib/parseAnalysis";
import { useJobsStore, EMPTY_JOBS } from "../../state/jobsStore";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import { useT } from "../../state/languageStore";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Markdown } from "../common/Markdown";
import { FindingCard, QualityGateBadges, SHORT_SUMMARY_MAX } from "./FindingCard";
import { AiErrorBanner } from "./AiErrorBanner";
import { AiRunLog } from "./AiRunLog";
import { useTaskModelLabel } from "./ModelTag";

/** Pre-commit change analysis, shown inline in the AI panel (alongside chat and PR review)
 * instead of a separate modal — so it shares the same "Activity" job tracking and the same
 * always-available surface as everything else Claude does for this project. */
export function AnalyzeSection({ projectId }: { projectId: string }) {
  const t = useT();
  const hide = useAnalyzeUiStore((s) => s.hide);
  // This project's pin, never the app's: the section used to read one global id and look it up in
  // whichever project was active, so a run pinned in another repository resolved to nothing here
  // and the section spun for it forever. See `analyzeUiStore.selectedJobId`.
  const selectedJobId = useAnalyzeUiStore((s) => s.selectedJobId[projectId] ?? null);
  const jobs = useJobsStore((s) => s.byProject[projectId] ?? EMPTY_JOBS);
  /** Which engine the next run reaches, on the button that starts it. The panel this button lives
   *  in is also where the failure lands, and `failed to launch 'opencode'` names a binary that
   *  appears nowhere else on screen — so the name has to be readable *before* the click, not
   *  reverse-engineered from the error after it. */
  const analyzeModel = useTaskModelLabel("analyze");
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
    // Activity list highlights the right row. Named explicitly rather than left to be resolved:
    // the job is registered in the same tick and the project is right here in scope.
    useAnalyzeUiStore.getState().showJob(id, projectId);
  };

  // Guarded with a ref rather than just checking `job`: React StrictMode double-invokes effects
  // in dev, and both invocations would otherwise see the same (still-null) `job` and each start
  // their own analysis — producing two job entries for one open.
  const startedRef = useRef(false);
  useEffect(() => {
    // Armed on the first run of this effect whatever it decides to do, and *not* only when it
    // starts something. `starting` below reads this ref as "the auto-start has had its turn", and
    // arming it inside the branch made that false for any section that mounted with a run already
    // on screen — the common case. Delete that run from Activity afterwards and the section fell
    // into `starting` for good: an orb for a run nobody had started, with Refresh disabled by the
    // same flag and the empty state suppressed. The ref is per mount and this component is keyed by
    // project (`AiPanel`), so "first run" means first for this repository.
    if (startedRef.current) return;
    startedRef.current = true;
    // Auto-start only when landing on the section fresh (no pinned historical run) with nothing to
    // show yet — reopening, or selecting a past run, must never kick off a new Claude invocation.
    if (!selectedJobId && !job) runAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selectedJobId]);

  const [logExpanded, setLogExpanded] = useState(false);

  // Rows past the first page of Activity arrive without their analysis text — see
  // `jobsStore.fetchActivityPage` — so the one on screen fetches its own. No-op for a row that
  // already carries it, which is every run made this session and the whole first page.
  const hydrateResult = useJobsStore((s) => s.hydrateResult);
  useEffect(() => {
    if (job?.status === "done" && job.result === null) void hydrateResult(job.projectId, job.id);
  }, [job?.id, job?.status, job?.result, job?.projectId, hydrateResult]);

  // A finished run whose text has not arrived yet reads as still loading, rather than as an
  // analysis that found nothing.
  //
  // What is deliberately *not* part of this any more is `!job`. It was, and it is what turned one
  // repository's pinned run into every other repository's permanent spinner: the pin was global,
  // the lookup happened in the active project's history, and the miss came back as "still loading"
  // — with Refresh disabled by this same flag and the auto-start below suppressed by the pin, so
  // the section could neither finish nor be restarted. A job that isn't here is now an empty state
  // Refresh can act on.
  //
  // The one instant where nothing on screen is legitimate is the frame between mounting fresh and
  // the auto-start registering its run — the effect above runs after this render, so the first
  // paint has neither a job nor a pin to explain itself. `startedRef` is part of the condition and
  // not just of the effect: once the auto-start has had its turn, "no job" stops being something
  // that is about to resolve itself. Without that term this is the same unfinishable spinner in a
  // new place — open the section, delete its run from Activity, click Analyze again (which clears
  // the pin but cannot re-arm the latch) and the orb would spin for a run nobody is starting, with
  // Refresh disabled by this very flag.
  const starting = !job && !selectedJobId && !startedRef.current;
  const loading = job?.status === "running" || (job !== null && job.status === "done" && job.result === null);
  /** Nothing to show and nothing on the way: a pinned run deleted from Activity since, or a section
   *  whose auto-start has already run and has no analysis left to display. Either case is an empty
   *  state offering a fresh run — never a spinner, which is the whole defect being fixed here. */
  const nothingToShow = !job && !starting;
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
            disabled={loading || starting}
            title={[t("analyze.reanalyze"), analyzeModel].join("\n")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading || starting ? "animate-spin" : ""} />
          </button>
          <button
            onClick={() => hide(projectId)}
            title={t("chat.backToChat")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={14} />
          </button>
        </div>

        {/* The run card carries the orb, the state and the elapsed time itself — a second centred
            "Working…" above it was the same sentence twice. Without a job id (the run hasn't been
            registered yet) there is nothing to follow, so the orb stands alone for that instant. */}
        {(loading || starting) &&
          (job ? (
            <AiRunLog
              runId={job.id}
              running
              startedAt={job.createdAt}
              expanded={logExpanded}
              onToggle={() => setLogExpanded((v) => !v)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
              <ThinkingOrb size="lg" />
              <p className="text-[13px] text-[var(--cf-text-muted)]">{t("ai.working")}</p>
            </div>
          ))}

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

        {nothingToShow && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <p className="text-[13px] text-[var(--cf-text-muted)]">{t("analyze.nothingYet")}</p>
            <button onClick={runAnalysis} className="text-[12px] text-[var(--cf-accent)] underline">
              {t("analyze.reanalyze")}
            </button>
          </div>
        )}

        {!loading && !starting && !nothingToShow && !cancelled && !error && findings.length === 0 && (
          summary.length > 0 && summary.length > SHORT_SUMMARY_MAX ? (
            // Nothing matched the expected "### finding" format at all — rather than lose
            // the model's actual answer, render the raw response as markdown instead of a
            // wall of unstyled plain text.
            <Markdown
              source={summary}
              className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-4"
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <ShieldCheck size={28} className="text-[var(--cf-success)]" />
              {/* `summary` here is the model's own one-liner verdict, short enough to have
                  skipped the markdown treatment — still its words, so still selectable. */}
              <p className="max-w-xs select-text text-[13px] text-[var(--cf-text-muted)]">
                {summary || t("analyze.noFindings")}
              </p>
            </div>
          )
        )}

        {!loading && !cancelled && !error && findings.length > 0 && (
          <div className="space-y-3">
            {summary && (
              <Markdown
                source={summary}
                className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3.5 py-2.5"
              />
            )}
            <div className="space-y-2">
              {findings.map((finding, at) => (
                <FindingCard
                  key={finding.id}
                  finding={finding}
                  at={at}
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
