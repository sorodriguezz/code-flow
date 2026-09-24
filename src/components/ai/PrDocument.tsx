import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Check,
  CheckCheck,
  ChevronUp,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  MessageSquareShare,
  RefreshCw,
  SkipForward,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react";
import { buttonClass, iconButtonClass } from "../common/Button";
import { chipClass, popoverClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { CONFIRM_POST_KEYS, POSTED_KEYS, VIEW_ON_KEYS } from "../../lib/providerLabels";
import { discardPrFinding, getReviewRun, notifyStateChange, REVIEW_SKIPPED } from "../../lib/tauri/commands";
import {
  listCommentThreads,
  resolveCommentThread,
  targetKey,
  targetPrKey,
  targetProjectId,
  type PrTarget,
} from "../../lib/prTarget";
import {
  buildFixpack,
  formatDecisionComment,
  formatFindingAsComment,
  formatSummaryComment,
  parseAnalysis,
  type AnalysisFinding,
  type SummaryMemory,
} from "../../lib/parseAnalysis";
import { jobPrUrl } from "../../lib/activityEntries";
import { useIsQueued } from "../../lib/repoQueue";
import { Checkbox } from "../common/Checkbox";
import { Markdown } from "../common/Markdown";
import {
  FindingCard,
  QualityGateBadges,
  SeverityCountBadges,
  SHORT_SUMMARY_MAX,
  isDiscarded,
  type DiscardOptions,
  type FindingMark,
} from "./FindingCard";
import { PrCommentCard, PrCommentsSkeleton } from "./PrCommentCard";
import { AiRunLog } from "./AiRunLog";
import { AiErrorBanner } from "./AiErrorBanner";
import { ReviewEngineTag } from "./ReviewEngineTag";
import { ReviewLevelSelector } from "./ReviewLevelSelector";
import {
  ActionBar,
  DocHeader,
  GroupLabel,
  PrDecisionState,
  PrStateChip,
  RunMenu,
  SegmentBar,
  SPLIT_MIN_WIDTH,
  menuRowClass,
  relativeTime,
  useCopy,
  useDismiss,
  useElementWidth,
  type RunChoice,
} from "./docParts";
import { EMPTY_JOBS, useJobsStore, type Job } from "../../state/jobsStore";
import { postedKey, usePrStore, type LinkPrSession, type ReviewLevel } from "../../state/prStore";
import { usePrWatchStore } from "../../state/prWatchStore";
import { EMPTY_RESOLUTIONS, useResolutionsStore } from "../../state/resolutionsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { useAiPanelStore, type DocSegment, type TabView } from "../../state/aiPanelStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { NotificationTarget } from "../../state/notificationStore";
import type { PrCommentThread, PullRequestSummary, SavedFinding } from "../../types/domain";

const EMPTY_VIEW: TabView = {};
const EMPTY_FLAGS: Record<string, boolean> = {};
const EMPTY_FINDINGS: AnalysisFinding[] = [];
const LEVELS: ReviewLevel[] = ["basico", "completo", "ultra"];

/** A stored JSON column (a run's `meta` / `findings`), or `null` when it can't be read — memory
 * written by an older version is context to do without, never a crash. */
function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * A run that finished without producing a review: the plan stopped to ask (a draft, a merged PR),
 * decided there was nothing to do, or saw the same head commit as last time. Each is an *answer*,
 * not a review — so it is said in a banner and never takes the place of the findings it would
 * otherwise have hidden.
 */
function runNote(job: Job): { kind: "confirm" | "note"; text: string } | null {
  const text = job.result;
  if (!text) return null;
  if (text.startsWith(REVIEW_SKIPPED)) return { kind: "confirm", text: text.slice(REVIEW_SKIPPED.length) };
  if (text.startsWith("🔁") || text.startsWith("⏭")) return { kind: "note", text };
  return null;
}

/**
 * One pull request's review, as a document.
 *
 * `target` is the whole difference between a PR from a project's own list and one opened from a
 * pasted link with nothing cloned: the operations that act on the *host* — comment threads,
 * decisions, publishing — are identical, and the two that need a working copy (a diff built from
 * local git, applying a fix to a file) are not offered without one.
 *
 * What changed from the section this replaces is the shape, and the three rules behind it:
 *
 * - **A run never hides a result.** A re-review used to become the thing on screen the moment it
 *   started, and for the minutes it ran the findings it was re-checking were gone. The run now sits
 *   above the last review, which stays readable (dimmed) until the new one lands — and then the
 *   strip says what changed. Every earlier review is one menu away.
 * - **One scroll, one step at a time.** Human comments and AI findings are segments, not a stack
 *   where one pushed the other below the fold, and the bottom bar offers what the current step
 *   allows: review, then publish, then decide — the checkboxes exist only while choosing what to
 *   publish, next to the button that uses them.
 * - **Nothing lives only in the component.** Which segment, which cards are open, what is ticked,
 *   the run being read: all in the tab's view state, so a tab switch costs nothing.
 */
export function PrDocument({
  tabKey,
  target,
  pr,
  session,
}: {
  tabKey: string;
  target: PrTarget;
  pr: PullRequestSummary;
  /** Set for a PR reviewed from its link — the repository label and clone URL it carries. */
  session: LinkPrSession | null;
}) {
  const t = useT();
  const projectId = targetProjectId(target);
  const bucket = targetKey(target);
  // What this document *addresses*, as opposed to the bucket it reads from: a link review's bucket
  // is its whole workspace, shared with every other repository reached by link.
  const prKey = targetPrKey(target, pr.id);
  const linkOnly = target.kind === "link";
  const linkUrl = target.kind === "link" ? target.url : null;

  const view = useAiPanelStore((s) => s.view[tabKey] ?? EMPTY_VIEW);
  const setView = useCallback((patch: Partial<TabView>) => useAiPanelStore.getState().setView(tabKey, patch), [tabKey]);
  const segment: DocSegment = view.segment ?? "findings";

  const reviewPr = usePrStore((s) => s.reviewPr);
  const reviewLevel = usePrStore((s) => s.reviewLevel);
  const setReviewLevel = usePrStore((s) => s.setReviewLevel);
  const postReview = usePrStore((s) => s.postReview);
  const actOnPr = usePrStore((s) => s.actOnPr);
  const posting = usePrStore((s) => s.postingByPr[prKey] ?? false);
  const prActionBusy = usePrStore((s) => s.prActionBusy[prKey] ?? null);
  const decision = usePrStore((s) => s.decisionByPr[prKey] ?? "none");
  const loadPrDecision = usePrStore((s) => s.loadPrDecision);
  const refreshPr = usePrStore((s) => s.refreshPr);

  // The workspace this review belongs to — the one holding the repository, not the one on screen:
  // everything downstream of it (the watchlist row, what a comment card starts) outlives the render.
  const projectWorkspaceId = useWorkspaceStore((s) => (projectId ? s.workspaceOfProject(projectId) : null));
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const watchWorkspaceId = target.kind === "link" ? target.workspaceId : (projectWorkspaceId ?? activeWorkspaceId);

  const resolutions = useResolutionsStore((s) =>
    projectId ? (s.byProject[projectId] ?? EMPTY_RESOLUTIONS) : EMPTY_RESOLUTIONS,
  );
  const loadResolutions = useResolutionsStore((s) => s.load);
  useEffect(() => {
    if (projectId) void loadResolutions(projectId);
  }, [projectId, loadResolutions]);

  // ── Runs ────────────────────────────────────────────────────────────────────────────────────
  const loadJobs = useJobsStore((s) => s.load);
  useEffect(() => {
    void loadJobs(bucket);
  }, [bucket, loadJobs]);
  const jobs = useJobsStore((s) => s.byProject[bucket] ?? EMPTY_JOBS);
  // Newest first, like the bucket. A link bucket holds every repository reached by link, so the
  // URL identifies this PR there; in a project bucket the number does.
  const runs = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.kind === "pr-review" && (linkUrl !== null ? jobPrUrl(j) === linkUrl : j.meta.prId === pr.id && jobPrUrl(j) === null),
      ),
    [jobs, linkUrl, pr.id],
  );
  const runningJob = runs.find((j) => j.status === "running") ?? null;
  const doneRuns = useMemo(() => runs.filter((j) => j.status === "done"), [runs]);
  const reviews = useMemo(() => doneRuns.filter((j) => !runNote(j)), [doneRuns]);
  const pinned = view.runId ? (reviews.find((j) => j.id === view.runId) ?? null) : null;
  const displayJob = pinned ?? reviews[0] ?? null;
  const previousReview = pinned ? null : (reviews[1] ?? null);
  // The newest run that did not produce a review, when it is newer than the one on screen: a failure,
  // a stop, or an answer like "nothing changed" — said above the review, never instead of it.
  const newestSettled = runs.find((j) => j.status !== "running") ?? null;
  const settledAfter =
    !pinned && newestSettled && newestSettled !== displayJob && (!displayJob || newestSettled.createdAt > displayJob.createdAt)
      ? newestSettled
      : null;
  const settledNote = settledAfter?.status === "done" ? runNote(settledAfter) : null;
  const queued = useIsQueued(runningJob?.id);

  // Rows past the first page arrive without their text; the ones this document reads fetch their own.
  const hydrateResult = useJobsStore((s) => s.hydrateResult);
  useEffect(() => {
    for (const job of [displayJob, previousReview, settledAfter]) {
      if (job && job.status === "done" && job.result === null) void hydrateResult(job.projectId, job.id);
    }
  }, [displayJob, previousReview, settledAfter, hydrateResult]);

  const hydrating = displayJob !== null && displayJob.result === null;
  const reviewText = displayJob?.result ?? null;
  const parsed = useMemo(() => (reviewText ? parseAnalysis(reviewText) : null), [reviewText]);
  const findings = parsed?.findings ?? EMPTY_FINDINGS;
  const summary = parsed?.summary ?? "";

  const iterations = useMemo<RunChoice[]>(() => {
    const oldestFirst = [...reviews].reverse();
    return oldestFirst
      .map((job, at) => ({
        id: job.id,
        label: t("doc.reviewN", { n: at + 1 }),
        detail: [
          relativeTime(job.createdAt, t),
          typeof job.meta.level === "string" ? t(`pr.level.${job.meta.level}` as never) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      }))
      .reverse();
  }, [reviews, t]);
  const displayNumber = displayJob ? iterations.length - iterations.findIndex((run) => run.id === displayJob.id) : 0;

  // ── The reviewer's memory of this PR ───────────────────────────────────────────────────────
  // Which findings earlier iterations closed, and the scope and depth this run ran at. Only a
  // project-backed review keeps memory (a link session has no run to save).
  const [runMemory, setRunMemory] = useState<SummaryMemory | null>(null);
  const runId = displayJob?.id ?? null;
  const memoryReqRef = useRef(0);
  const loadRunMemory = useCallback(async () => {
    const token = ++memoryReqRef.current;
    if (!runId || linkOnly) {
      setRunMemory(null);
      return;
    }
    try {
      const run = await getReviewRun(runId);
      if (!run || memoryReqRef.current !== token) return;
      const saved: SavedFinding[] = safeJson<SavedFinding[]>(run.findings) ?? [];
      const meta = safeJson<Record<string, unknown>>(run.meta) ?? {};
      setRunMemory({
        all: saved,
        resolved: saved.filter((f) => f.estado === "resuelto"),
        discarded: saved.filter((f) => f.estado === "falso_positivo" || f.estado === "ignorado"),
        iter: run.iter,
        level: run.level,
        engine: typeof meta.engine === "string" ? meta.engine : "",
        model: typeof meta.model === "string" ? meta.model : "",
        files: typeof meta.files === "number" ? meta.files : 0,
        additions: typeof meta.additions === "number" ? meta.additions : 0,
        deletions: typeof meta.deletions === "number" ? meta.deletions : 0,
      });
    } catch {
      // The summary simply loses its "already fixed" half — never a reason to break the review.
    }
  }, [runId, linkOnly]);
  useEffect(() => {
    setRunMemory(null);
    void loadRunMemory();
  }, [loadRunMemory]);

  const marks = useMemo(() => {
    const map = new Map<string, FindingMark>();
    for (const f of runMemory?.all ?? []) {
      map.set(f.id, { estado: f.estado, motivo: f.motivo_descarte, posted: f.thread_id != null });
    }
    return map;
  }, [runMemory]);
  /** The findings that still stand: what the gate judges, what gets published, what the summary
   * counts. Rejected ones stay in the list (dimmed, undoable) but stop counting. */
  const activeFindings = useMemo(() => findings.filter((f) => !isDiscarded(marks.get(f.id))), [findings, marks]);
  const activeParsed = useMemo(() => (parsed ? { ...parsed, findings: activeFindings } : null), [parsed, activeFindings]);

  // What changed since the review before this one. Only a project review keeps its finding ids
  // stable across iterations (the memory reconciles them), so only there is the comparison honest.
  const diff = useMemo(() => {
    if (linkOnly || !previousReview?.result || !parsed) return null;
    const before = parseAnalysis(previousReview.result).findings;
    const beforeIds = new Set(before.map((f) => f.id));
    const nowIds = new Set(findings.map((f) => f.id));
    const added = findings.filter((f) => !beforeIds.has(f.id)).length;
    const resolved = before.filter((f) => !nowIds.has(f.id)).length;
    if (added === 0 && resolved === 0) return null;
    return { added, resolved, kept: findings.length - added };
  }, [linkOnly, previousReview?.result, parsed, findings]);

  // ── Selection for publishing ──────────────────────────────────────────────────────────────
  const deselected = view.deselected ?? EMPTY_FLAGS;
  const selecting = Boolean(view.selecting) && !pinned && !runningJob;
  const includeSummary = view.includeSummary ?? true;
  const chosen = activeFindings.filter((f) => !deselected[f.id]);
  const postedRun = usePrStore((s) => (displayJob ? (s.postedByPr[postedKey(prKey, displayJob.id)] ?? false) : false));
  // What is left to publish: a project review knows per finding (its memory has the thread); a
  // link review only knows whether this run was published.
  const unpublished = linkOnly ? (postedRun ? 0 : activeFindings.length) : activeFindings.filter((f) => !marks.get(f.id)?.posted).length;
  // Nothing left to publish: every finding is on the PR, or this run was published. A clean run
  // that has not been published still offers its summary — the one thing worth posting then.
  const nothingLeft = unpublished === 0 && (postedRun || activeFindings.length > 0);

  // ── Discarding a finding ──────────────────────────────────────────────────────────────────
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const discardFinding = async (findingId: string, estado: string, opts: DiscardOptions) => {
    if (!displayJob || !projectId) return;
    setDiscardingId(findingId);
    try {
      const outcome = await discardPrFinding(
        projectId,
        pr.id,
        displayJob.id,
        findingId,
        estado,
        opts.motivo || undefined,
        opts.scopeRepo,
        opts.notifyHost,
      );
      // Publishing something just called a non-defect is exactly what the mark is meant to
      // prevent, so the selection follows the ruling.
      const next = { ...deselected };
      if (estado === "abierto") delete next[findingId];
      else next[findingId] = true;
      setView({ deselected: next });
      if (outcome.host_error) pushErrorToast(t("finding.discardHostFailed", { error: outcome.host_error }));
      else if (outcome.rule_added) useToastStore.getState().pushToast(t("finding.discardRuleAdded"), "success");
      else if (outcome.host_notified) useToastStore.getState().pushToast(t("finding.discardHostNotified"), "success");
      await loadRunMemory();
      // The only way another client (a paired phone) hears about the ruling.
      notifyStateChange("reviews", projectId);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setDiscardingId(null);
    }
  };

  const runReview = (level?: ReviewLevel, force = false) =>
    reviewPr(target, pr, { level, force, session });

  const publish = async () => {
    if (!activeParsed || !displayJob) return;
    if (chosen.length === 0 && !includeSummary) return;
    const confirmKey = chosen.length === 0 ? "pr.confirmPostSummaryOnly" : CONFIRM_POST_KEYS[pr.provider];
    if (!(await confirmAction(t(confirmKey, { id: pr.id, n: chosen.length }), false))) return;
    const items = chosen.map((f) => ({
      file: f.location?.file ?? null,
      category: f.category,
      content: formatFindingAsComment(f),
      location: f.location,
    }));
    // `chosen`, not every finding: the summary describes what actually gets posted — plus what the
    // memory says this PR already closed.
    const summaryBody = includeSummary
      ? formatSummaryComment(activeParsed, new Date().toISOString().slice(0, 10), chosen, runMemory)
      : null;
    try {
      await postReview(target, pr.id, displayJob.id, items, includeSummary, summaryBody);
    } catch {
      return; // Already said by the store; nothing was posted, nothing to reload.
    }
    setView({ selecting: false });
    // Posting gives each finding its thread, and the thread is what a later "false positive" replies on.
    await loadRunMemory();
  };

  // ── Deciding ──────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    void loadPrDecision(target, pr.id);
    // `target` is rebuilt by the caller; what matters is the pull request it addresses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPrDecision, prKey]);
  const prClosed = pr.status === "merged" || pr.status === "closed";
  const commentOnDecide = view.commentOnDecide ?? true;
  const willComment = commentOnDecide && Boolean(parsed) && Boolean(displayJob);

  const doPrAction = (action: "approve" | "request_changes" | "close") => {
    const note =
      willComment && displayJob
        ? {
            runId: displayJob.id,
            body: formatDecisionComment(
              action,
              new Date().toISOString().slice(0, 10),
              activeParsed,
              runMemory,
              // What was fixed from here since the review ran: corrected, not accepted.
              activeFindings.filter((f) => resolutions[`job:${displayJob.id}:${f.id}`]).map((f) => f.id),
            ),
          }
        : null;
    void actOnPr(target, pr.id, action, note);
  };

  // ── Waiting on me ─────────────────────────────────────────────────────────────────────────
  // Kept on the "needs you" list for as long as it waits on me, written on every look so the
  // snapshot stays current, and reconciled against the host so a settled PR leaves by itself.
  useEffect(() => {
    if (!watchWorkspaceId) return;
    const watch = usePrWatchStore.getState();
    if (prClosed || decision === "approved") {
      watch.untrack(watchWorkspaceId, prKey);
      return;
    }
    watch.track({
      key: prKey,
      kind: target.kind,
      projectId: target.kind === "project" ? target.projectId : undefined,
      url: target.kind === "link" ? target.url : undefined,
      cloneUrl: session?.cloneUrl,
      workspaceId: watchWorkspaceId,
      prId: pr.id,
      title: pr.title,
      repoLabel: session?.repoLabel ?? "",
      pr,
      decision: decision === "changes_requested" ? "changes_requested" : "none",
      reviewed: Boolean(displayJob),
      at: Date.now(),
    });
    // The snapshot only needs rewriting when one of the things it holds changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prKey, watchWorkspaceId, pr.status, pr.title, decision, prClosed, Boolean(displayJob)]);

  // ── The conversation on the host ──────────────────────────────────────────────────────────
  // Refetched every time the PR is opened rather than cached: it changes outside CodeFlow.
  const [threads, setThreads] = useState<PrCommentThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const threadsReqRef = useRef(0);
  const loadThreads = useCallback(() => {
    const token = ++threadsReqRef.current;
    setThreadsLoading(true);
    return listCommentThreads(target, pr.id)
      .then((list) => {
        if (threadsReqRef.current === token) setThreads(list);
      })
      .catch(() => {
        if (threadsReqRef.current === token) setThreads([]);
      })
      .finally(() => {
        if (threadsReqRef.current === token) setThreadsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prKey]);
  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  const resolveThread = async (threadId: number, reply: { body: string | null; wontFix: boolean }) => {
    try {
      const outcome = await resolveCommentThread(target, pr.id, threadId, reply);
      if (outcome.resolved) {
        setThreads((list) => list.filter((thread) => thread.id !== threadId));
        useToastStore.getState().pushToast(t(outcome.replied ? "pr.threadRepliedAndResolved" : "pr.threadResolved"), "success");
      } else {
        pushErrorToast(
          outcome.replied ? t("pr.threadRepliedNotResolved", { error: outcome.error ?? "" }) : (outcome.error ?? t("pr.threadNotResolved")),
        );
      }
      return outcome;
    } catch (e) {
      pushErrorToast(String(e));
      return null;
    }
  };

  // Everything this document reads from the host, re-read at once: the PR, your decision, and the
  // open conversation — one question ("what does it look like now"), stale together.
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshPr(target, pr.id), loadPrDecision(target, pr.id), loadThreads()]);
    } finally {
      setRefreshing(false);
    }
  };

  // Where the work this document starts leads back to: this PR's tab.
  const docTarget: NotificationTarget | undefined = projectId
    ? { openAiPanel: true, projectId, select: { kind: "pullRequest", id: `${projectId}::${pr.id}` } }
    : displayJob
      ? { openAiPanel: true, select: { kind: "job", id: displayJob.id } }
      : undefined;

  const openLocation = projectId
    ? (file: string, line: number) => {
        const workspace = useWorkspaceStore.getState();
        // A tab can show another repository's PR; the file to open is that repository's.
        if (workspace.activeProjectId !== projectId) workspace.setActiveProject(projectId);
        useUiStore.getState().openInEditor(file, line);
      }
    : undefined;

  // ── Layout ────────────────────────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(scrollRef);
  // Restored once, saved on the way out — never per scroll event, which would re-render on every
  // frame of a scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && view.scroll) el.scrollTop = view.scroll;
    return () => {
      const top = scrollRef.current?.scrollTop;
      if (top !== undefined) useAiPanelStore.getState().setView(tabKey, { scroll: top });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey]);

  const split = segment === "findings" && width >= SPLIT_MIN_WIDTH && findings.length > 0 && !hydrating;
  const expanded = view.expanded ?? EMPTY_FLAGS;
  const picked = findings.find((f) => f.id === view.picked) ?? findings[0] ?? null;
  const [logExpanded, setLogExpanded] = useState(false);
  const [fixpackCopied, copyFixpack] = useCopy();

  const cardProps = (finding: AnalysisFinding, at: number) => {
    const mark = marks.get(finding.id) ?? null;
    return {
      finding,
      at,
      defaultOpen: false,
      projectId,
      prSourceBranch: pr.source_branch,
      resolutionKey: displayJob ? `job:${displayJob.id}:${finding.id}` : undefined,
      mark,
      stale: Boolean(runningJob),
      onOpenLocation: openLocation,
      // Only a project-backed review has a run to record the ruling in; a link session would
      // take the click and forget it.
      onDiscard:
        projectId && displayJob && !linkOnly && !pinned
          ? (estado: string, opts: DiscardOptions) => void discardFinding(finding.id, estado, opts)
          : undefined,
      discarding: discardingId === finding.id,
    };
  };

  const selectBox = (finding: AnalysisFinding) =>
    selecting ? (
      <span className="mt-2 shrink-0" title={t("pr.selectToPost")}>
        {isDiscarded(marks.get(finding.id)) ? (
          <span className="block h-3.5 w-3.5" />
        ) : (
          <Checkbox
            checked={!deselected[finding.id]}
            onChange={() => {
              const next = { ...deselected };
              if (next[finding.id]) delete next[finding.id];
              else next[finding.id] = true;
              setView({ deselected: next });
            }}
          />
        )}
      </span>
    ) : null;

  const findingsBody = (() => {
    if (!displayJob) {
      if (runningJob) return null;
      return <p className="px-1 py-6 text-center text-[12px] text-[var(--cf-text-faint)]">{t("doc.noReviewYet")}</p>;
    }
    if (hydrating) {
      return (
        <p className="flex items-center justify-center gap-1.5 py-6 text-[12px] text-[var(--cf-text-muted)]">
          <Loader2 size={13} className="animate-spin" />
          {t("doc.loadingReview")}
        </p>
      );
    }
    if (findings.length === 0) {
      return (
        <div className="space-y-2">
          {(runMemory?.resolved.length ?? 0) > 0 && (
            <p className="flex items-center gap-2 rounded-lg border border-[color-mix(in_oklab,var(--cf-success)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-success)_9%,transparent)] px-3 py-2 text-[12px] text-[var(--cf-text)]">
              <CheckCheck size={14} className="shrink-0 text-[var(--cf-success)]" />
              {t("pr.allResolved", { n: runMemory?.resolved.length ?? 0 })}
            </p>
          )}
          {summary.length > SHORT_SUMMARY_MAX ? (
            <Markdown source={summary} className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] p-3.5" />
          ) : (
            <p className="select-text rounded-lg border border-[var(--cf-border)] p-3 text-[13px] leading-relaxed text-[var(--cf-text)]">
              {summary || t("analyze.noFindings")}
            </p>
          )}
        </div>
      );
    }
    if (split && picked) {
      return (
        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-3">
          <div className="space-y-2">
            {findings.map((finding, at) => (
              <div key={finding.id} className="flex items-start gap-2">
                {selectBox(finding)}
                <div className="min-w-0 flex-1">
                  <FindingCard
                    {...cardProps(finding, at)}
                    open={false}
                    highlighted={finding.id === picked.id}
                    onToggle={() => setView({ picked: finding.id })}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="sticky top-2">
            <FindingCard key={picked.id} {...cardProps(picked, 0)} open onToggle={() => undefined} />
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        {findings.map((finding, at) => (
          <div key={finding.id} className="flex items-start gap-2">
            {selectBox(finding)}
            <div className="min-w-0 flex-1">
              <FindingCard
                {...cardProps(finding, at)}
                open={Boolean(expanded[finding.id])}
                onToggle={() => setView({ expanded: { ...expanded, [finding.id]: !expanded[finding.id] } })}
              />
            </div>
          </div>
        ))}
      </div>
    );
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <DocHeader
          tabs={
            <SegmentBar
              layoutId={`doc-segment-${tabKey}`}
              value={segment}
              onChange={(next) => setView({ segment: next })}
              segments={[
                { id: "findings", label: t("doc.findings"), count: displayJob && !hydrating ? activeFindings.length : null },
                { id: "comments", label: t("doc.comments"), count: threadsLoading ? null : threads.length },
                { id: "summary", label: t("doc.summary") },
              ]}
            />
          }
        >
          <div className="flex items-start gap-1">
            <p className="min-w-0 flex-1 pt-0.5 text-[14px] font-semibold leading-snug">
              <span className="mr-1.5 font-mono text-[12px] font-medium tabular-nums text-[var(--cf-text-faint)]">#{pr.id}</span>
              <span className="select-text">{pr.title}</span>
            </p>
            <Tooltip label={t("pr.refreshAllHint")}>
              <button
                onClick={() => void refreshAll()}
                disabled={refreshing}
                aria-label={t("pr.refreshAllHint")}
                className={iconButtonClass({ size: "sm" })}
              >
                <RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} />
              </button>
            </Tooltip>
            <Tooltip label={t(VIEW_ON_KEYS[pr.provider])}>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                aria-label={t(VIEW_ON_KEYS[pr.provider])}
                className={iconButtonClass({ size: "sm" })}
              >
                <ExternalLink size={15} />
              </a>
            </Tooltip>
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-[var(--cf-text-faint)]">
            <PrStateChip status={pr.status} decision={decision} />
            <span>@{pr.author}</span>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate font-mono text-[11px]">
              {pr.source_branch} → {pr.target_branch}
            </span>
            {session && (
              <span className={chipClass("neutral", "min-w-0")}>
                <Link2 size={12} className="shrink-0" />
                <span className="truncate">{session.repoLabel}</span>
              </span>
            )}
          </div>
          {displayJob && parsed && !hydrating && (
            <div className="flex flex-wrap items-center gap-1.5">
              <QualityGateBadges grades={parsed.grades} findings={activeFindings} />
              <SeverityCountBadges findings={activeFindings} />
              <RunMenu
                runs={iterations}
                current={displayJob.id}
                latestId={reviews[0]?.id ?? null}
                onPick={(id) => setView({ runId: id, selecting: false })}
              />
            </div>
          )}
        </DocHeader>

        <div className="space-y-2.5 p-3">
          {linkOnly && session && <LinkReviewNotice session={session} />}

          {pinned && (
            <div className="flex items-center gap-2 rounded-lg bg-[color-mix(in_oklab,var(--cf-warning)_12%,transparent)] py-1.5 pl-3 pr-1.5 text-[12px] text-[var(--cf-text)]">
              <span className="min-w-0 flex-1">{t("doc.readOnlyReview", { n: displayNumber })}</span>
              <button onClick={() => setView({ runId: null })} className={buttonClass({ variant: "secondary", size: "sm" })}>
                {t("doc.backToLatest")}
              </button>
            </div>
          )}

          {runningJob && (
            <div className="space-y-1.5">
              {queued && (
                <p className="flex items-center gap-1.5 text-[11px] text-[var(--cf-warning)]">
                  <Loader2 size={12} className="animate-spin" />
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
              {displayJob && segment === "findings" && (
                <p className="px-0.5 text-[11px] text-[var(--cf-text-faint)]">{t("doc.whileRunning", { n: displayNumber })}</p>
              )}
            </div>
          )}

          {!runningJob && settledAfter?.status === "cancelled" && (
            <p className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--cf-border-strong)] px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">
              <Square size={12} className="shrink-0 fill-current" />
              {t("ai.runStopped")}
            </p>
          )}
          {!runningJob && settledAfter?.status === "error" && settledAfter.error && (
            <div className="space-y-1">
              <AiErrorBanner error={settledAfter.error} compact />
              {displayJob && <p className="px-0.5 text-[11px] text-[var(--cf-text-faint)]">{t("doc.showingEarlier")}</p>}
            </div>
          )}
          {!runningJob && settledNote && (
            <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_oklab,var(--cf-warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-warning)_9%,transparent)] px-3 py-2 text-[12px] text-[var(--cf-text)]">
              <SkipForward size={14} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
              <div className="min-w-0 flex-1">
                <p className="select-text break-words">{settledNote.text}</p>
                {settledNote.kind === "confirm" && !prClosed && (
                  <button onClick={() => runReview(undefined, true)} className="mt-1 text-[var(--cf-accent)] underline">
                    {t("pr.reviewAnyway")}
                  </button>
                )}
              </div>
            </div>
          )}

          {segment === "findings" && (
            <>
              {diff && !runningJob && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {diff.added > 0 && <span className={chipClass("accent")}>{t("doc.diffNew", { n: diff.added })}</span>}
                  {diff.resolved > 0 && <span className={chipClass("ok")}>{t("doc.diffResolved", { n: diff.resolved })}</span>}
                  {diff.kept > 0 && <span className={chipClass("neutral")}>{t("doc.diffKept", { n: diff.kept })}</span>}
                </div>
              )}
              {findingsBody}
            </>
          )}

          {segment === "comments" &&
            (threadsLoading ? (
              <PrCommentsSkeleton label={t("pr.loadingComments")} />
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <GroupLabel>{threads.length > 0 ? t("pr.openComments", { n: threads.length }) : t("pr.noComments")}</GroupLabel>
                  <Tooltip label={t("pr.refreshComments")}>
                    <button
                      onClick={() => void loadThreads()}
                      aria-label={t("pr.refreshComments")}
                      className={iconButtonClass({ size: "xs" })}
                    >
                      <RefreshCw size={13} />
                    </button>
                  </Tooltip>
                </div>
                {threads.map((thread) => (
                  <PrCommentCard
                    key={thread.id}
                    thread={thread}
                    projectId={projectId}
                    workspaceId={watchWorkspaceId}
                    prSourceBranch={pr.source_branch}
                    resolutionKey={`pr:${pr.id}:thread:${thread.id}`}
                    draftKey={`reply:${prKey}:${thread.id}`}
                    target={docTarget}
                    onResolveThread={(reply) => resolveThread(thread.id, reply)}
                  />
                ))}
              </div>
            ))}

          {segment === "summary" && (
            <div className="space-y-2.5">
              {!displayJob ? (
                <p className="px-1 py-6 text-center text-[12px] text-[var(--cf-text-faint)]">{t("doc.noReviewYet")}</p>
              ) : (
                <>
                  {summary ? (
                    <Markdown source={summary} className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] px-3.5 py-2.5" />
                  ) : (
                    <p className="text-[12px] text-[var(--cf-text-muted)]">{t("analyze.noFindings")}</p>
                  )}
                  {(runMemory?.resolved.length ?? 0) > 0 && (
                    <p className="flex items-center gap-2 text-[12px] text-[var(--cf-success)]">
                      <CheckCheck size={14} className="shrink-0" />
                      {t("pr.allResolved", { n: runMemory?.resolved.length ?? 0 })}
                    </p>
                  )}
                  {findings.length > 0 && activeParsed && (
                    <button
                      onClick={() => copyFixpack(buildFixpack(activeParsed, pr.id))}
                      title={t("pr.fixpackHint")}
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                    >
                      {fixpackCopied ? <Check size={13} className="text-[var(--cf-success)]" /> : <Copy size={13} />}
                      {t("pr.fixpack")}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* One layout for every step — see `ActionBar`: what qualifies the step on the left, its
          primary at the right edge. */}
      <ActionBar>
        {pinned ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text-muted)]">{t("doc.readOnly")}</span>
            <button onClick={() => setView({ runId: null })} className={buttonClass({ variant: "primary", size: "md" })}>
              {t("doc.backToLatest")}
            </button>
          </div>
        ) : prClosed ? (
          // Nothing left to decide, for anyone: the settled state stands where the decision was.
          <div className="flex justify-end">
            <PrDecisionState status={pr.status} decision={decision} />
          </div>
        ) : selecting ? (
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[12px] font-semibold tabular-nums">
              {t("doc.selectedOf", { n: chosen.length, total: activeFindings.length })}
            </span>
            <label className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]" title={t("pr.postSummaryHint")}>
              <Checkbox checked={includeSummary} onChange={(value) => setView({ includeSummary: value })} />
              <span className="truncate">{t("pr.postSummary")}</span>
            </label>
            <span className="flex-1" />
            <button onClick={() => setView({ selecting: false })} className={buttonClass({ variant: "ghost", size: "md" })}>
              {t("common.cancel")}
            </button>
            <button
              onClick={() => void publish()}
              disabled={posting || (chosen.length === 0 && !includeSummary)}
              className={buttonClass({ variant: "primary", size: "md" })}
            >
              {posting && <Loader2 size={14} className="animate-spin" />}
              {posting ? t("chat.posting") : t("chat.postToPr")}
            </button>
          </div>
        ) : !displayJob ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="shrink-0 text-[12px] text-[var(--cf-text-muted)]">{t("pr.levelLabel")}</span>
            <ReviewLevelSelector value={reviewLevel} onChange={setReviewLevel} disabled={Boolean(runningJob)} />
            <ReviewEngineTag />
            {/* `ml-auto` keeps it at the right edge when a narrow panel wraps it onto a line of
                its own, instead of letting it fall back under the selector. */}
            <button
              onClick={() => runReview()}
              disabled={Boolean(runningJob)}
              className={buttonClass({ variant: "primary", size: "md", className: "ml-auto" })}
            >
              {runningJob ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {runningJob ? t("chat.reviewing") : t("chat.reviewWithClaude")}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <ReReviewButton disabled={Boolean(runningJob)} level={reviewLevel} onRun={(level) => runReview(level)} />
            <span className="flex-1" />
            {/* The title rides on a wrapper: a disabled recipe button takes no pointer events, and
                "already on the pull request" is exactly what the disabled one has to say. */}
            <span className="flex min-w-0" title={nothingLeft ? t(POSTED_KEYS[pr.provider]) : t("doc.publishHint")}>
              <button
                onClick={() => setView({ selecting: true, segment: "findings" })}
                disabled={Boolean(runningJob) || posting || nothingLeft}
                className={buttonClass({ variant: "secondary", size: "md", className: "min-w-0" })}
              >
                {posting ? (
                  <Loader2 size={14} className="shrink-0 animate-spin" />
                ) : nothingLeft ? (
                  <Check size={14} className="shrink-0 text-[var(--cf-success)]" />
                ) : (
                  <MessageSquareShare size={14} className="shrink-0" />
                )}
                <span className="truncate">
                  {unpublished > 0 ? t("doc.publishN", { n: unpublished }) : nothingLeft ? t("doc.published") : t("doc.publish")}
                </span>
              </button>
            </span>
            {decision === "approved" ? (
              <PrDecisionState status={pr.status} decision={decision} />
            ) : (
              <DecideMenu
                decision={decision}
                busy={prActionBusy}
                willComment={commentOnDecide}
                canComment={Boolean(parsed)}
                onToggleComment={() => setView({ commentOnDecide: !commentOnDecide })}
                onAct={doPrAction}
              />
            )}
          </div>
        )}
      </ActionBar>
    </div>
  );
}

/** The secondary button's surface, for the two halves of the split button below. */
const SPLIT_HALF =
  "inline-flex h-7 items-center bg-[var(--cf-surface)] text-[var(--cf-text)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-text)_4%,var(--cf-surface))] disabled:pointer-events-none disabled:opacity-45";

/**
 * Re-runs the review at the current depth; the chevron picks another depth for this run. Its words
 * show once the bar has room for them — a panel at its narrowest keeps the glyph and the tooltip.
 */
function ReReviewButton({
  disabled,
  level,
  onRun,
}: {
  disabled: boolean;
  level: ReviewLevel;
  onRun: (level: ReviewLevel) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        onClick={() => onRun(level)}
        disabled={disabled}
        title={`${t("pr.reviewAgain")} · ${t(`pr.level.${level}` as never)}`}
        aria-label={t("pr.reviewAgain")}
        className={`${SPLIT_HALF} gap-1.5 rounded-l-md px-2.5 text-[13px] font-medium`}
      >
        <RefreshCw size={14} className="shrink-0" />
        <span className="hidden @[28rem]:inline">{t("pr.reviewAgain")}</span>
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("pr.levelLabel")}
        className={`${SPLIT_HALF} -ml-px w-6 justify-center rounded-r-md text-[var(--cf-text-muted)]`}
      >
        <ChevronUp size={13} />
      </button>
      {open && (
        <div role="menu" className={`absolute bottom-full left-0 z-30 mb-1.5 w-52 ${popoverClass}`}>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
            {t("pr.reviewAgain")}
          </p>
          {LEVELS.map((choice) => (
            <button
              key={choice}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onRun(choice);
              }}
              className="flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-[var(--cf-text)] transition-colors duration-100 hover:bg-[var(--cf-hover)]"
            >
              <span className="w-3.5 shrink-0 text-[var(--cf-accent)]">{choice === level && <Check size={14} />}</span>
              {t(`pr.level.${choice}` as never)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ACTION_TONES = {
  success: "text-[var(--cf-success)]",
  warning: "text-[var(--cf-warning)]",
  danger: "text-[var(--cf-danger)]",
} as const;

/**
 * Approve · request changes · close, as one menu — confirmed inside it.
 *
 * Three buttons sat in the footer at all times, each behind a modal confirm. The decision is the
 * last step, not a permanent strip of chrome, and a second step inside the menu is confirmation
 * enough without covering the review with a dialog. What rides along — the summary comment — is a
 * toggle right there, so publishing to someone else's PR is never a surprise.
 *
 * The first click arms the option; the armed option opens into a block that says what is about to
 * happen — what the host will record, and whether the summary goes with it — with its own Confirm.
 * It used to arm by rewording the item in place and wait for a second click on the same spot, which
 * looked like nothing had happened until the words were read.
 */
function DecideMenu({
  decision,
  busy,
  willComment,
  canComment,
  onToggleComment,
  onAct,
}: {
  decision: string;
  busy: string | null;
  willComment: boolean;
  canComment: boolean;
  onToggleComment: () => void;
  onAct: (action: "approve" | "request_changes" | "close") => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setConfirming(null);
  }, []);
  useDismiss(ref, open, close);

  const items: { action: "approve" | "request_changes" | "close"; icon: LucideIcon; tone: keyof typeof ACTION_TONES; label: string; hint: string }[] = [
    { action: "approve", icon: ThumbsUp, tone: "success", label: t("pr.approve"), hint: t("doc.approveHint") },
    ...(decision === "changes_requested"
      ? []
      : [{ action: "request_changes" as const, icon: ThumbsDown, tone: "warning" as const, label: t("pr.requestChanges"), hint: t("doc.requestChangesHint") }]),
    { action: "close", icon: Ban, tone: "danger", label: t("pr.close"), hint: t("doc.closeHint") },
  ];

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        className={buttonClass({ variant: "primary", size: "md" })}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : null}
        {t("doc.decide")}
        {/* Up, because that is where the menu opens: the bar is at the bottom of the panel. */}
        <ChevronUp size={13} />
      </button>
      {open && (
        <div role="menu" className={`absolute bottom-full right-0 z-30 mb-1.5 w-[280px] ${popoverClass}`}>
          {decision === "changes_requested" && (
            <p className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-[var(--cf-warning)]">
              <ThumbsDown size={12} className="shrink-0" />
              {t("pr.stateChangesRequested")}
            </p>
          )}
          {items.map((item) => {
            const Icon = item.icon;
            if (confirming === item.action) {
              return (
                <div
                  key={item.action}
                  role="group"
                  aria-label={item.label}
                  className="my-0.5 rounded-md bg-[var(--cf-accent-soft)] px-2.5 py-2"
                >
                  <p className="flex items-center gap-2.5 text-[13px] font-semibold text-[var(--cf-text)]">
                    <Icon size={15} className={`shrink-0 ${ACTION_TONES[item.tone]}`} />
                    {item.label}
                  </p>
                  <p className="ml-[25px] mt-1 text-[12px] leading-snug text-[var(--cf-text-muted)]">
                    {item.hint}
                    {willComment && canComment && ` · ${t("doc.confirmWithComment")}`}
                  </p>
                  <div className="ml-[25px] mt-2 flex items-center gap-1.5">
                    {/* Focus lands here, so the keyboard path is what it always was: Enter to
                        arm, Enter again to act. */}
                    <button
                      autoFocus
                      onClick={() => {
                        close();
                        onAct(item.action);
                      }}
                      aria-label={t("doc.confirmAction", { action: item.label.toLowerCase() })}
                      className={buttonClass({ variant: "primary", size: "sm" })}
                    >
                      {t("common.confirm")}
                    </button>
                    <button onClick={() => setConfirming(null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <button key={item.action} role="menuitem" onClick={() => setConfirming(item.action)} className={menuRowClass()}>
                <Icon size={15} className={`mt-0.5 shrink-0 ${ACTION_TONES[item.tone]}`} />
                <span className="min-w-0">
                  <span className="block text-[13px] text-[var(--cf-text)]">{item.label}</span>
                  <span className="block text-[12px] text-[var(--cf-text-muted)]">{item.hint}</span>
                </span>
              </button>
            );
          })}
          {canComment && (
            <>
              <div className="mx-1 my-1 h-px bg-[var(--cf-border)]" />
              <label
                className="flex h-[30px] cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[12px] text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                title={t("pr.commentOnDecisionHint")}
              >
                <Checkbox checked={willComment} onChange={onToggleComment} />
                {t("pr.commentOnDecision")}
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What a link-only review says about itself: which repository the PR is in (nothing else on screen
 * says so), what it cannot see, and the way out — cloning it.
 */
function LinkReviewNotice({ session }: { session: LinkPrSession }) {
  const t = useT();
  const openCloneOffer = useUiStore((s) => s.openPrLinkModal);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--cf-border-strong)] py-1.5 pl-3 pr-1.5">
      <Link2 size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
      <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-[var(--cf-text-muted)]" title={t("prLink.quickNote")}>
        <span className="font-medium text-[var(--cf-text)]">{session.repoLabel}</span> · {t("doc.noLocalClone")}
      </p>
      <button
        onClick={openCloneOffer}
        className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-[12px] font-medium text-[var(--cf-accent)] transition-colors duration-100 hover:bg-[var(--cf-accent-soft)]"
      >
        {t("prLink.cloneInstead")}
      </button>
    </div>
  );
}
