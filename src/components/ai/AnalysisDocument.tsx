import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { parseAnalysis, type AnalysisFinding } from "../../lib/parseAnalysis";
import { startAnalysis, useChangesToAnalyze } from "../../lib/aiPanelNav";
import { useIsQueued } from "../../lib/repoQueue";
import { Markdown } from "../common/Markdown";
import { FindingCard, QualityGateBadges, SeverityCountBadges, SHORT_SUMMARY_MAX } from "./FindingCard";
import { AiErrorBanner } from "./AiErrorBanner";
import { AiRunLog } from "./AiRunLog";
import { useTaskModelLabel } from "./ModelTag";
import { ActionBar, DocHeader, RunMenu, SPLIT_MIN_WIDTH, relativeTime, useElementWidth, type RunChoice } from "./docParts";
import { EMPTY_JOBS, useJobsStore } from "../../state/jobsStore";
import { useResolutionsStore } from "../../state/resolutionsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useAiPanelStore, type TabView } from "../../state/aiPanelStore";
import { useT } from "../../state/languageStore";

const EMPTY_VIEW: TabView = {};
const EMPTY_FLAGS: Record<string, boolean> = {};
const EMPTY_FINDINGS: AnalysisFinding[] = [];

/**
 * The pre-commit change analysis of one repository, as a document — the same shape as a pull
 * request's review, without publishing or deciding.
 *
 * It no longer starts on its own. Opening the section used to launch a run whenever the repository
 * had none on screen, guarded by a ref so StrictMode would not launch two; reopening a past run from
 * history is exactly when nobody wants a new one, and the guard's edge cases were a source of
 * "spins forever" bugs. A run now starts only when asked for — the Changes panel's button, or the
 * bar below — and the document shows whichever run its tab points at, or the newest.
 */
export function AnalysisDocument({ tabKey, projectId, jobId }: { tabKey: string; projectId: string; jobId: string | null }) {
  const t = useT();
  const view = useAiPanelStore((s) => s.view[tabKey] ?? EMPTY_VIEW);
  const setView = useCallback((patch: Partial<TabView>) => useAiPanelStore.getState().setView(tabKey, patch), [tabKey]);
  const project = useWorkspaceStore((s) =>
    Object.values(s.projectsByWorkspace)
      .flat()
      .find((p) => p.id === projectId) ?? null,
  );
  const analyzeModel = useTaskModelLabel("analyze");

  const loadJobs = useJobsStore((s) => s.load);
  useEffect(() => {
    void loadJobs(projectId);
  }, [projectId, loadJobs]);
  const loadResolutions = useResolutionsStore((s) => s.load);
  useEffect(() => {
    void loadResolutions(projectId);
  }, [projectId, loadResolutions]);

  const jobs = useJobsStore((s) => s.byProject[projectId] ?? EMPTY_JOBS);
  const runs = useMemo(() => jobs.filter((j) => j.kind === "analyze-changes"), [jobs]);
  const runningJob = runs.find((j) => j.status === "running") ?? null;
  const changes = useChangesToAnalyze(projectId);
  const doneRuns = useMemo(() => runs.filter((j) => j.status === "done"), [runs]);
  // The tab's own run when it names one that is finished; otherwise the newest finished one. A run
  // still going is shown *above* it rather than instead of it.
  const pinnedDone = jobId ? (doneRuns.find((j) => j.id === jobId) ?? null) : null;
  const displayJob = pinnedDone ?? doneRuns[0] ?? null;
  const isLatest = !pinnedDone || pinnedDone.id === doneRuns[0]?.id;
  const newestSettled = runs.find((j) => j.status !== "running") ?? null;
  const settledAfter =
    isLatest && newestSettled && newestSettled !== displayJob && (!displayJob || newestSettled.createdAt > displayJob.createdAt)
      ? newestSettled
      : null;
  const queued = useIsQueued(runningJob?.id);

  const hydrateResult = useJobsStore((s) => s.hydrateResult);
  useEffect(() => {
    if (displayJob && displayJob.result === null) void hydrateResult(displayJob.projectId, displayJob.id);
  }, [displayJob, hydrateResult]);
  const hydrating = displayJob !== null && displayJob.result === null;

  const parsed = useMemo(() => (displayJob?.result ? parseAnalysis(displayJob.result) : null), [displayJob?.result]);
  const findings = parsed?.findings ?? EMPTY_FINDINGS;
  const summary = parsed?.summary ?? "";
  const footer = parsed?.footer ?? null;

  const choices = useMemo<RunChoice[]>(
    () =>
      doneRuns.map((job) => ({
        id: job.id,
        label: new Date(job.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        detail: relativeTime(job.createdAt, t),
      })),
    [doneRuns, t],
  );

  const run = () => {
    startAnalysis(projectId);
    // The new run's card is at the top; that is where to look.
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const openLocation = (file: string, line: number) => {
    const workspace = useWorkspaceStore.getState();
    if (workspace.activeProjectId !== projectId) workspace.setActiveProject(projectId);
    useUiStore.getState().openInEditor(file, line);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(scrollRef);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && view.scroll) el.scrollTop = view.scroll;
    return () => {
      const top = scrollRef.current?.scrollTop;
      if (top !== undefined) useAiPanelStore.getState().setView(tabKey, { scroll: top });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey]);
  const [logExpanded, setLogExpanded] = useState(false);
  const expanded = view.expanded ?? EMPTY_FLAGS;
  const split = width >= SPLIT_MIN_WIDTH && findings.length > 0 && !hydrating;
  const picked = findings.find((f) => f.id === view.picked) ?? findings[0] ?? null;

  const cardProps = (finding: AnalysisFinding, at: number) => ({
    finding,
    at,
    defaultOpen: false,
    projectId,
    resolutionKey: displayJob ? `job:${displayJob.id}:${finding.id}` : undefined,
    stale: Boolean(runningJob),
    onOpenLocation: openLocation,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <DocHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="shrink-0 text-[var(--cf-accent)]" />
            <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t("analyze.title")}</p>
          </div>
          <p className="truncate text-[11px] text-[var(--cf-text-muted)]">
            {project?.name ?? ""}
            {displayJob ? ` · ${relativeTime(displayJob.createdAt, t)}` : ""}
          </p>
          {displayJob && parsed && !hydrating && (
            <div className="flex flex-wrap items-center gap-1.5">
              <QualityGateBadges grades={parsed.grades} findings={findings} />
              <SeverityCountBadges findings={findings} />
              <RunMenu
                runs={choices}
                current={displayJob.id}
                latestId={doneRuns[0]?.id ?? null}
                onPick={(id) => useAiPanelStore.getState().setAnalysisJob(projectId, id)}
              />
            </div>
          )}
        </DocHeader>

        <div className="space-y-2.5 p-3">
          {!isLatest && (
            <div className="flex items-center gap-2 rounded-lg bg-[color-mix(in_oklab,var(--cf-warning)_12%,transparent)] px-2.5 py-1.5 text-[11.5px]">
              <span className="min-w-0 flex-1">{t("doc.readOnlyAnalysis")}</span>
              <button
                onClick={() => useAiPanelStore.getState().setAnalysisJob(projectId, null)}
                className="shrink-0 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-0.5 text-[11px] font-medium"
              >
                {t("doc.backToLatest")}
              </button>
            </div>
          )}

          {runningJob && (
            <div className="space-y-1.5">
              {queued && (
                <p className="flex items-center gap-1.5 text-[11px] text-[var(--cf-warning)]">
                  <Loader2 size={11} className="animate-spin" />
                  {queued.holder ? t("assistant.queuedBehind", { holder: queued.holder }) : t("assistant.queuedUnknown")}
                </p>
              )}
              <AiRunLog
                runId={runningJob.id}
                running
                startedAt={runningJob.createdAt}
                expanded={logExpanded}
                onToggle={() => setLogExpanded((v) => !v)}
              />
              {displayJob && <p className="px-0.5 text-[11px] text-[var(--cf-text-muted)]">{t("doc.whileRunningAnalysis")}</p>}
            </div>
          )}

          {!runningJob && settledAfter?.status === "cancelled" && (
            <p className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--cf-border)] px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">
              <Square size={11} className="shrink-0 fill-current" />
              {t("ai.runStopped")}
            </p>
          )}
          {!runningJob && settledAfter?.status === "error" && settledAfter.error && (
            <div className="space-y-1">
              <AiErrorBanner error={settledAfter.error} />
              {displayJob && <p className="px-0.5 text-[11px] text-[var(--cf-text-muted)]">{t("doc.showingEarlierAnalysis")}</p>}
            </div>
          )}

          {!displayJob && !runningJob && (
            <p className="px-1 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">{t("analyze.nothingYet")}</p>
          )}

          {hydrating && (
            <p className="flex items-center justify-center gap-1.5 py-6 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              {t("doc.loadingReview")}
            </p>
          )}

          {displayJob && !hydrating && findings.length === 0 &&
            (summary.length > SHORT_SUMMARY_MAX ? (
              <Markdown source={summary} className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] p-3.5" />
            ) : (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <ShieldCheck size={26} className="text-[var(--cf-success)]" />
                <p className="max-w-xs select-text text-[12.5px] text-[var(--cf-text-muted)]">{summary || t("analyze.noFindings")}</p>
              </div>
            ))}

          {displayJob && !hydrating && findings.length > 0 && (
            <>
              {summary && (
                <Markdown source={summary} className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] px-3.5 py-2.5" />
              )}
              {split && picked ? (
                <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-3">
                  <div className="space-y-2">
                    {findings.map((finding, at) => (
                      <FindingCard
                        key={finding.id}
                        {...cardProps(finding, at)}
                        open={false}
                        highlighted={finding.id === picked.id}
                        onToggle={() => setView({ picked: finding.id })}
                      />
                    ))}
                  </div>
                  <div className="sticky top-2">
                    <FindingCard key={picked.id} {...cardProps(picked, 0)} open onToggle={() => undefined} />
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {findings.map((finding, at) => (
                    <FindingCard
                      key={finding.id}
                      {...cardProps(finding, at)}
                      open={Boolean(expanded[finding.id])}
                      onToggle={() => setView({ expanded: { ...expanded, [finding.id]: !expanded[finding.id] } })}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {footer && !hydrating && <p className="text-[11px] text-[var(--cf-text-muted)]">{footer}</p>}
        </div>
      </div>

      <ActionBar>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]" title={analyzeModel}>
            {analyzeModel}
          </span>
          <button
            onClick={run}
            disabled={Boolean(runningJob) || changes === 0}
            title={!runningJob && changes === 0 ? t("analyze.nothingToAnalyze") : undefined}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {runningJob ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {runningJob ? t("ai.working") : displayJob ? t("analyze.reanalyze") : t("doc.analyze")}
          </button>
        </div>
      </ActionBar>
    </div>
  );
}
