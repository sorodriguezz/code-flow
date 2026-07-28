import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUp,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitMerge,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
  type LucideIcon,
} from "lucide-react";
import { renderMarkdown } from "../../lib/markdown";
import { parseClaudeError } from "../../lib/claudeError";
import { parseAnalysis, buildFixpack, formatFindingAsComment, formatSummaryComment } from "../../lib/parseAnalysis";
import { Checkbox } from "../common/Checkbox";
import { listPrCommentThreads } from "../../lib/tauri/commands";
import { FindingCard, QualityGateBadges, SeverityCountBadges, SHORT_SUMMARY_MAX } from "./FindingCard";
import { PrCommentCard, PrCommentsSkeleton } from "./PrCommentCard";
import {
  mergeActivityEntries,
  entryKey,
  entryTitle,
  entryTimestamp,
  entryVisual,
  entryRunCount,
  findActiveEntryKey,
  type ActivityEntry,
} from "../../lib/activityEntries";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLayoutStore } from "../../state/layoutStore";
import { usePrStore } from "../../state/prStore";
import { useJobsStore, EMPTY_JOBS } from "../../state/jobsStore";
import { useChatStore, EMPTY_CHAT, type ChatMessage } from "../../state/chatStore";
import { useChatHistoryStore, EMPTY_CONVERSATIONS } from "../../state/activityStore";
import { useResolutionsStore } from "../../state/resolutionsStore";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import { confirmAction } from "../../state/confirmStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import type { TranslationKey } from "../../lib/i18n/translations";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ActivityModal } from "./ActivityModal";
import { AiRunLog } from "./AiRunLog";
import { CheckpointsModal } from "./CheckpointsModal";
import { AnalyzeSection } from "./AnalyzeSection";
import { ChatModelPicker } from "./ChatModelPicker";
import { ChatAgentPicker } from "./ChatAgentPicker";
import { ReviewLevelSelector } from "./ReviewLevelSelector";
import { AiErrorBanner } from "./AiErrorBanner";
import type { PrDecision, PullRequestSummary, PrCommentThread } from "../../types/domain";

const PANEL_MIN = 280;
const PANEL_MAX = 520;

function relativeTime(ts: number, t: (key: TranslationKey, vars?: Record<string, string | number>) => string): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return t("ai.justNow");
  if (mins < 60) return t("ai.minutesAgo", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("ai.hoursAgo", { n: hours });
  return t("ai.daysAgo", { n: Math.round(hours / 24) });
}

/** Unified "Activity" list — background jobs (PR review / pre-commit analysis) and past
 * chat conversations combined and sorted by recency, so there's one place to reopen anything
 * Claude has done for this project instead of two separate sections. */
function ActivitySection({ projectId }: { projectId: string }) {
  const t = useT();
  const jobs = useJobsStore((s) => s.byProject[projectId] ?? EMPTY_JOBS);
  const jobsLoaded = useJobsStore((s) => s.loaded[projectId]);
  const loadJobHistory = useJobsStore((s) => s.load);
  const prsByProject = usePrStore((s) => s.prsByProject);
  const selectedPr = usePrStore((s) => s.selectedPr);
  const selectPr = usePrStore((s) => s.selectPr);
  const analyzeOpen = useAnalyzeUiStore((s) => s.open);
  const analyzeJobId = useAnalyzeUiStore((s) => s.selectedJobId);
  const conversations = useChatHistoryStore((s) => s.byProject[projectId] ?? EMPTY_CONVERSATIONS);
  const chatLoaded = useChatHistoryStore((s) => s.loaded[projectId]);
  const loadChatHistory = useChatHistoryStore((s) => s.load);
  const loadResolutions = useResolutionsStore((s) => s.load);
  const activeSessionId = useChatStore((s) => s.byProject[projectId]?.conversationId ?? null);
  const switchTo = useChatStore((s) => s.switchTo);
  const [collapsed, setCollapsed] = useState(true);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!chatLoaded) void loadChatHistory(projectId);
    if (!jobsLoaded) void loadJobHistory(projectId);
    // Hydrate persisted "resolve with AI" outcomes so an already-resolved finding/comment shows
    // its ✓ state immediately when a PR/analysis is opened, instead of looking un-actioned.
    void loadResolutions(projectId);
  }, [projectId, chatLoaded, loadChatHistory, jobsLoaded, loadJobHistory, loadResolutions]);

  const entries = useMemo(() => mergeActivityEntries(jobs, conversations), [jobs, conversations]);
  if (entries.length === 0) return null;

  const activeEntryKey = findActiveEntryKey(entries, {
    selectedPrId: selectedPr?.id ?? null,
    analyzeOpen,
    analyzeJobId,
    activeSessionId,
  });

  const runningCount = jobs.filter((j) => j.status === "running").length;
  const topFive = entries.slice(0, 5);

  const openEntry = (entry: ActivityEntry) => {
    if (entry.type === "chat") {
      // Clear whatever else the panel might currently be showing — otherwise the chat
      // switches underneath a still-visible PR review or analysis section.
      selectPr(null);
      useAnalyzeUiStore.getState().hide();
      void switchTo(projectId, entry.conv.session_id);
      return;
    }
    // A recorded decision opens the PR it was taken on, same as a review of it would.
    if (entry.job.kind === "pr-review" || entry.job.kind === "pr-action") {
      const pr = prsByProject[projectId]?.find((p) => p.id === entry.job.meta.prId);
      if (pr) {
        useAnalyzeUiStore.getState().hide();
        selectPr(pr);
      }
    } else if (entry.job.kind === "analyze-changes") {
      selectPr(null);
      useAnalyzeUiStore.getState().showJob(entry.job.id);
    }
  };

  return (
    <div className="shrink-0 border-b border-[var(--cf-border)]">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <History size={11} />
        {t("ai.history")}
        {runningCount > 0 && (
          <span className="rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-bold text-[var(--cf-accent)]">
            {runningCount}
          </span>
        )}
        <span className="ml-auto">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-0.5 px-1.5 pb-2">
          {topFive.map((entry) => {
            const { icon: Icon, color, spinning } = entryVisual(entry);
            const isActive = entryKey(entry) === activeEntryKey;
            const runCount = entryRunCount(entry);
            return (
              <button
                key={entryKey(entry)}
                title={entryTitle(entry)}
                onClick={() => openEntry(entry)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  isActive ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <Icon size={12} className={spinning ? "shrink-0 animate-spin" : "shrink-0"} style={{ color }} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">{entryTitle(entry)}</span>
                {runCount > 1 && (
                  <span
                    title={t("ai.runCount", { n: runCount })}
                    className="shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] font-semibold text-[var(--cf-text-muted)] dark:bg-white/[0.1]"
                  >
                    ×{runCount}
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">
                  {relativeTime(entryTimestamp(entry), t)}
                </span>
              </button>
            );
          })}
          <button
            onClick={() => setShowModal(true)}
            className="w-full rounded-md px-2 py-1 text-center text-[11px] font-medium text-[var(--cf-accent)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            {t("ai.viewAll")}
          </button>
        </div>
      )}
      {showModal && <ActivityModal projectId={projectId} onClose={() => setShowModal(false)} />}
    </div>
  );
}

function PrReviewSection({ projectId, pr }: { projectId: string; pr: PullRequestSummary }) {
  const t = useT();
  const reviewPr = usePrStore((s) => s.reviewPr);
  const reviewLevel = usePrStore((s) => s.reviewLevel);
  const setReviewLevel = usePrStore((s) => s.setReviewLevel);
  const postReview = usePrStore((s) => s.postReview);
  const selectPr = usePrStore((s) => s.selectPr);
  const posting = usePrStore((s) => s.posting);
  const posted = usePrStore((s) => s.posted);
  const actOnPr = usePrStore((s) => s.actOnPr);
  const prActionBusy = usePrStore((s) => s.prActionBusy);
  const jobs = useJobsStore((s) => s.byProject[projectId] ?? EMPTY_JOBS);
  const job = useMemo(
    () => jobs.find((j) => j.kind === "pr-review" && j.meta.prId === pr.id) ?? null,
    [jobs, pr.id],
  );

  const [logExpanded, setLogExpanded] = useState(false);
  const loading = job?.status === "running";
  const error = job?.status === "error" ? job.error : null;
  const reviewText = job?.status === "done" ? job.result : null;
  const parsed = useMemo(() => (reviewText ? parseAnalysis(reviewText) : null), [reviewText]);
  const findings = parsed?.findings ?? [];
  const summary = parsed?.summary ?? "";

  // Human selection of which findings to post (default: all), plus whether to post the summary
  // thread. Reset whenever a new review result arrives.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [postSummary, setPostSummary] = useState(true);
  useEffect(() => {
    setSelectedIds(new Set(findings.map((f) => f.id)));
  }, [reviewText]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [fixpackCopied, copyFixpack] = useCopy();
  const runReview = () => reviewPr(projectId, pr.id);
  const publish = async () => {
    if (!parsed || !job) return;
    const chosen = findings.filter((f) => selectedIds.has(f.id));
    if (chosen.length === 0 && !postSummary) return;
    const confirmKey = pr.provider === "github" ? "chat.confirmPostGithub" : "chat.confirmPost";
    if (!(await confirmAction(t(confirmKey, { id: pr.id, n: chosen.length }), false))) return;
    const items = chosen.map((f) => ({
      file: f.location?.file ?? null,
      category: f.category,
      content: formatFindingAsComment(f),
      location: f.location,
    }));
    // `chosen`, not every finding: the summary describes what actually gets posted.
    const summary = postSummary ? formatSummaryComment(parsed, new Date().toISOString().slice(0, 10), chosen) : null;
    void postReview(projectId, pr.id, job.id, items, postSummary, summary);
  };

  // A decision already on the record (here or on the website) retires the button that would take
  // it again — and a merged/closed PR retires all three, since there's nothing left to decide.
  const decision = usePrStore((s) => s.decisionByPr[`${projectId}:${pr.id}`] ?? "none");
  const loadPrDecision = usePrStore((s) => s.loadPrDecision);
  useEffect(() => {
    void loadPrDecision(projectId, pr.id);
  }, [loadPrDecision, projectId, pr.id]);

  const prClosed = pr.status === "merged" || pr.status === "closed";
  const doPrAction = async (action: "approve" | "request_changes" | "close") => {
    const confirmKey =
      action === "approve"
        ? "pr.confirmApprove"
        : action === "request_changes"
          ? "pr.confirmRequestChanges"
          : "pr.confirmClose";
    // Request-changes and close are destructive-ish (they push a state the author sees), so they
    // get the emphasized confirm; approve gets the plain one.
    if (!(await confirmAction(t(confirmKey, { id: pr.id }), action !== "approve"))) return;
    void actOnPr(projectId, pr.id, action);
  };

  // Existing comment threads on the PR — e.g. from a human reviewer — refetched fresh every
  // time this PR is opened rather than cached, since they can change outside of CodeFlow at
  // any time (someone replies, resolves a thread, etc.).
  const [openThreads, setOpenThreads] = useState<PrCommentThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  // A monotonic token so only the newest fetch writes state: switching PRs or hitting the manual
  // reload while a request is still in flight bumps the token, and the stale response is ignored.
  const threadsReqRef = useRef(0);
  const loadThreads = useCallback(() => {
    const token = ++threadsReqRef.current;
    setThreadsLoading(true);
    return listPrCommentThreads(projectId, pr.id)
      .then((threads) => {
        if (threadsReqRef.current === token) setOpenThreads(threads);
      })
      .catch(() => {
        if (threadsReqRef.current === token) setOpenThreads([]);
      })
      .finally(() => {
        if (threadsReqRef.current === token) setThreadsLoading(false);
      });
  }, [projectId, pr.id]);
  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // Footer buttons truncate when the panel is narrow, so their label doubles as the tooltip.
  const publishLabel = posted
    ? pr.provider === "github"
      ? t("chat.postedGithub")
      : t("chat.posted")
    : posting
      ? t("chat.posting")
      : t("chat.postToPr");
  const reviewLabel = loading ? t("chat.reviewing") : reviewText ? t("chat.reviewAgain") : t("chat.reviewWithClaude");

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4">
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3">
          <div className="min-w-0 flex-1">
            <p className="mb-0.5 truncate text-[13px] font-semibold">
              #{pr.id} {pr.title}
            </p>
            <p className="text-[11px] text-[var(--cf-text-muted)]">
              {t("chat.prBy", { author: pr.author })} · {t("chat.prBranches", { source: pr.source_branch, target: pr.target_branch })}
            </p>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline"
            >
              <ExternalLink size={10} />
              {pr.provider === "github" ? t("chat.viewOnGithub") : t("chat.viewOnAdo")}
            </a>
            {!loading && !error && parsed && (
              <div className="mt-1.5">
                <QualityGateBadges grades={parsed.grades} findings={findings} />
              </div>
            )}
          </div>
          <button
            onClick={() => selectPr(null)}
            title={t("chat.backToChat")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={14} />
          </button>
        </div>

        {threadsLoading ? (
          <PrCommentsSkeleton label={t("pr.loadingComments")} />
        ) : (
          <div className="mb-4 space-y-2">
            <div className="flex items-center gap-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {openThreads.length > 0 ? t("pr.openComments", { n: openThreads.length }) : t("pr.noComments")}
              </p>
              {/* The git host is the source of truth for comments and it changes outside CodeFlow
                  (someone replies or resolves a thread), so this lets the user pull the latest
                  without reopening the PR. */}
              <button
                onClick={() => void loadThreads()}
                title={t("pr.refreshComments")}
                className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
              >
                <RefreshCw size={11} />
              </button>
            </div>
            {openThreads.map((thread) => (
              <PrCommentCard
                key={thread.id}
                thread={thread}
                projectId={projectId}
                prSourceBranch={pr.source_branch}
                resolutionKey={`pr:${pr.id}:thread:${thread.id}`}
              />
            ))}
          </div>
        )}

        {loading && job && (
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-4 text-[12px] text-[var(--cf-text-muted)]">
              <ThinkingOrb size="sm" />
              {t("ai.working")}
            </div>
            <AiRunLog
              runId={job.id}
              running
              expanded={logExpanded}
              onToggle={() => setLogExpanded((v) => !v)}
            />
          </div>
        )}

        {job?.status === "cancelled" && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--cf-border)] p-3 text-[12px] text-[var(--cf-text-muted)]">
            <Square size={11} className="fill-current" />
            {t("ai.runStopped")}
            {/* No re-run offered on a settled PR — same rule as the footer. */}
            {!prClosed && (
              <button onClick={runReview} className="ml-auto text-[var(--cf-accent)] underline">
                {t("pr.reviewAgain")}
              </button>
            )}
          </div>
        )}

        {!loading && error && <AiErrorBanner error={error} compact />}

        {!loading && !error && reviewText && findings.length === 0 && (
          summary.length > SHORT_SUMMARY_MAX ? (
            <div
              className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
            />
          ) : (
            <p className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 text-[12px] leading-relaxed text-[var(--cf-text)]">
              {summary}
            </p>
          )
        )}

        {!loading && !error && reviewText && findings.length > 0 && (
          <div className="space-y-3">
            {summary && (
              <div
                className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3.5 py-2.5"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
              />
            )}
            {/* Explicit "Claude's findings" header (with a severity tally) so the AI-generated
                findings read as a distinct section from the human "Open comments" above them —
                previously they ran together with no divider and looked like one blurry list. */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2 border-t border-[var(--cf-border)] pt-3">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                  <Sparkles size={11} className="text-[var(--cf-accent)]" />
                  {t("pr.findingsHeader", { n: findings.length })}
                </p>
                <SeverityCountBadges findings={findings} />
              </div>
              <div className="space-y-2">
                {findings.map((finding) => (
                  <div key={finding.id} className="flex items-start gap-2">
                    <span className="mt-2 shrink-0" title={t("pr.selectToPost")}>
                      <Checkbox checked={selectedIds.has(finding.id)} onChange={() => toggleSelected(finding.id)} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <FindingCard
                        finding={finding}
                        defaultOpen={false}
                        projectId={projectId}
                        prSourceBranch={pr.source_branch}
                        resolutionKey={job ? `job:${job.id}:${finding.id}` : undefined}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {!loading && !error && !reviewText && (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("chat.awaitingReview")}</p>
        )}
      </div>

      {/* Footer laid out as stacked rows (PR decision → review options → primary actions) instead of
          one packed strip: the panel can be as narrow as PANEL_MIN, and cramming the level selector,
          the toggles and both call-to-actions into a single line wrapped their labels onto two lines,
          which rendered as oversized buttons. Every label here stays one line and truncates. */}
      <div className="@container shrink-0 space-y-2 border-t border-[var(--cf-border)] p-2.5">
        {(prClosed || decision !== "none") && <PrDecisionState status={pr.status} decision={decision} />}
        {!prClosed && decision !== "approved" && (
          <div className="flex items-center gap-1.5">
            <PrActionButton
              tone="success"
              icon={ThumbsUp}
              label={t("pr.approve")}
              busy={prActionBusy === "approve"}
              disabled={prActionBusy !== null}
              onClick={() => doPrAction("approve")}
            />
            <PrActionButton
              tone="warning"
              icon={ThumbsDown}
              // Already asked for changes: asking again says nothing new. Approving stays open,
              // because approving once the author has pushed the fixes is the point of the flow.
              label={t("pr.requestChanges")}
              busy={prActionBusy === "request_changes"}
              disabled={prActionBusy !== null || decision === "changes_requested"}
              onClick={() => doPrAction("request_changes")}
            />
            <PrActionButton
              tone="danger"
              icon={Ban}
              label={t("pr.close")}
              busy={prActionBusy === "close"}
              disabled={prActionBusy !== null}
              onClick={() => doPrAction("close")}
            />
          </div>
        )}
        {/* Everything below acts *on* the pull request — running a review of it, publishing to it.
            A merged or closed PR is settled, so none of it is offered: the state chip above is the
            whole footer. Its findings stay readable above, they just have nowhere left to go. */}
        {!prClosed && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <ReviewLevelSelector value={reviewLevel} onChange={setReviewLevel} disabled={loading} />
              <ChatAgentPicker projectId={projectId} />
              {reviewText && !loading && findings.length > 0 && (
                <>
                  <button
                    onClick={() => parsed && copyFixpack(buildFixpack(parsed, pr.id))}
                    title={t("pr.fixpackHint")}
                    className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                  >
                    {fixpackCopied ? <Check size={11} /> : <Copy size={11} />}
                    {t("pr.fixpack")}
                  </button>
                  <label
                    className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]"
                    title={t("pr.postSummaryHint")}
                  >
                    <Checkbox checked={postSummary} onChange={setPostSummary} />
                    {t("pr.postSummary")}
                  </label>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {reviewText && !loading && (
                <button
                  onClick={publish}
                  disabled={posting || posted}
                  title={publishLabel}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
                >
                  {posting ? (
                    <Loader2 size={12} className="shrink-0 animate-spin" />
                  ) : posted ? (
                    <Check size={12} className="shrink-0 text-[var(--cf-success)]" />
                  ) : null}
                  <span className="truncate">{publishLabel}</span>
                </button>
              )}
              <button
                onClick={runReview}
                disabled={loading}
                title={reviewLabel}
                className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 size={12} className="shrink-0 animate-spin" />
                ) : (
                  <Sparkles size={12} className="shrink-0" />
                )}
                <span className="truncate">{reviewLabel}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What this pull request has settled into, shown in place of the decision it no longer takes:
 * merged or closed (nothing left to decide, for anyone), or approved by this user (they already
 * decided). Rendered as a statement rather than a disabled button row, because a row of greyed-out
 * buttons says "this is broken" where a state chip says "this is done".
 *
 * The PR's own end state outranks the personal vote — once it's merged, "you approved it" stopped
 * being the useful thing to say.
 */
function PrDecisionState({ status, decision }: { status: PullRequestSummary["status"]; decision: PrDecision }) {
  const t = useT();
  const state =
    status === "merged"
      ? { icon: GitMerge, tone: PR_STATE_TONES.accent, label: t("pr.stateMerged"), hint: t("pr.stateLockedHint") }
      : status === "closed"
        ? { icon: Ban, tone: PR_STATE_TONES.danger, label: t("pr.stateClosed"), hint: t("pr.stateLockedHint") }
        : decision === "approved"
          ? { icon: ThumbsUp, tone: PR_STATE_TONES.success, label: t("pr.stateApproved"), hint: t("pr.stateApprovedHint") }
          : {
              icon: ThumbsDown,
              tone: PR_STATE_TONES.warning,
              label: t("pr.stateChangesRequested"),
              hint: t("pr.stateChangesRequestedHint"),
            };
  const Icon = state.icon;
  return (
    <div
      title={state.hint}
      className={`flex items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--cf-border)] px-2 py-1.5 text-[11px] font-medium ${state.tone}`}
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{state.label}</span>
    </div>
  );
}

/** Static tone classes, for the same reason as `PR_ACTION_TONES` below. */
const PR_STATE_TONES = {
  accent: "text-[var(--cf-accent)]",
  success: "text-[var(--cf-success)]",
  warning: "text-[var(--cf-warning)]",
  danger: "text-[var(--cf-danger)]",
} as const;

/** Tone classes spelled out statically so Tailwind picks them up (an interpolated `--cf-${tone}`
 * arbitrary value would never be generated). */
const PR_ACTION_TONES = {
  success: "text-[var(--cf-success)] hover:bg-[color-mix(in_oklab,var(--cf-success)_10%,transparent)]",
  warning: "text-[var(--cf-warning)] hover:bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)]",
  danger: "text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)]",
} as const;

/** One of the three PR decision buttons (approve / request changes / close). They share the footer
 * row evenly and truncate their label rather than wrapping, so the row keeps a single-line height
 * even at the panel's minimum width. */
function PrActionButton({
  tone,
  icon: Icon,
  label,
  busy,
  disabled,
  onClick,
}: {
  tone: keyof typeof PR_ACTION_TONES;
  icon: LucideIcon;
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-1.5 text-[11px] font-medium disabled:opacity-40 ${PR_ACTION_TONES[tone]}`}
    >
      {busy ? <Loader2 size={12} className="shrink-0 animate-spin" /> : <Icon size={12} className="shrink-0" />}
      {/* Below ~300px of footer the three labels can only render as stubs ("Solicitar cam…"), so the
          row falls back to icons — the tooltip still names the action. */}
      <span className="truncate @max-[300px]:hidden">{label}</span>
    </button>
  );
}

/** Copies `text`, flashing a checkmark for a moment — same "copied" feedback pattern used
 * elsewhere in the app (e.g. the project path copy in Settings). */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return [copied, copy];
}

const formatResponseTime = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/** The app's own language decides how timestamps read, not the OS locale — otherwise a chat in a
 * Spanish UI would print English dates. */
const useLocale = () => (useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US");

/** Parses a stored RFC 3339 stamp, tolerating the `undefined` of turns recorded before timestamps
 * were kept and the (theoretical) unparseable value rather than rendering "Invalid Date". */
function parseStamp(iso: string | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One muted 10px line under a turn: when it happened and, for an answer, what produced it —
 * engine, model, CLI version, and how long it took.
 *
 * Deliberately a single row rather than a chip or a header. The process log sitting right above
 * it is already a box, and this is reference information you go looking for ("which model wrote
 * this?"), not something the transcript should be announcing. Only the time is shown; the day is
 * carried by the divider between days, and the full date is on hover. */
function ChatStamp({ message }: { message: ChatMessage }) {
  const t = useT();
  const locale = useLocale();
  const when = parseStamp(message.createdAt);

  const parts: string[] = [];
  if (message.role === "assistant") {
    if (message.responseTimeMs !== undefined) parts.push(`⏱ ${formatResponseTime(message.responseTimeMs)}`);
    if (message.provider) parts.push(providerDisplayLabel(message.provider, t));
    // An empty provider still yields the raw model id, which is the honest answer for a turn
    // recorded before the provider was tracked.
    if (message.model) parts.push(modelDisplayLabel(message.provider ?? "", message.model, t));
    if (message.engineVersion) parts.push(`v${message.engineVersion}`);
  }
  if (when) parts.push(when.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
  if (parts.length === 0) return null;

  return (
    <div
      title={when?.toLocaleString(locale)}
      className={`px-0.5 text-[10px] leading-tight text-[var(--cf-text-muted)] ${
        message.role === "user" ? "text-right" : ""
      }`}
    >
      {parts.join(" · ")}
    </div>
  );
}

/** The date to announce before `message`, or `null` when it falls on the same day as the one
 * before it. Carrying the day here keeps every per-message stamp down to a bare time. */
function dayDivider(message: ChatMessage, previous: ChatMessage | undefined, locale: string): string | null {
  const when = parseStamp(message.createdAt);
  if (!when) return null;
  const before = parseStamp(previous?.createdAt);
  if (before && before.toDateString() === when.toDateString()) return null;
  return when.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const t = useT();
  const [copied, copy] = useCopy();
  const [traceOpen, setTraceOpen] = useState(false);
  // The recorded process behind this answer. Rendered under every kind of assistant turn —
  // including the failed and the stopped ones, where "what was it doing when it died?" is the
  // whole question.
  const trace = message.trace;
  const traceLog = trace && trace.length > 0 && (
    <div className="mr-auto max-w-[95%] pt-1">
      <AiRunLog
        lines={trace}
        running={false}
        label={t("ai.traceSteps", { n: trace.length })}
        expanded={traceOpen}
        onToggle={() => setTraceOpen((v) => !v)}
      />
    </div>
  );
  const html = useMemo(
    () => (message.role === "assistant" && !message.isError ? renderMarkdown(message.content) : null),
    [message.role, message.content, message.isError],
  );
  // Parsed at render, not stored: a reopened conversation gets the same billing link and retry
  // advice as the moment it failed, from the raw text kept in the transcript.
  const parsedError = useMemo(
    () => (message.isError ? parseClaudeError(message.content) : null),
    [message.isError, message.content],
  );

  if (parsedError) {
    return (
      <div className="mr-auto max-w-[95%] space-y-1">
        <AiErrorBanner error={parsedError} compact />
        {traceLog}
        <ChatStamp message={message} />
      </div>
    );
  }

  if (message.isCancelled) {
    return (
      <div className="mr-auto max-w-[85%] space-y-1">
        <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--cf-border)] px-2.5 py-1 text-[11px] text-[var(--cf-text-muted)]">
          <Square size={9} className="fill-current" />
          {t("ai.runStopped")}
        </div>
        {traceLog}
        <ChatStamp message={message} />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div
        className={`group relative rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed ${
          message.role === "user"
            ? "ml-auto max-w-[85%] whitespace-pre-wrap bg-[var(--cf-accent)] text-white"
            : "mr-auto max-w-[85%] bg-[color-mix(in_oklab,var(--cf-accent)_6%,var(--cf-surface))] text-[var(--cf-text)]"
        }`}
      >
        {html !== null ? (
          <div className="cf-markdown-preview cf-markdown-chat" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          message.content
        )}
        <button
          onClick={() => copy(message.content)}
          title={t("chat.copyMessage")}
          className={`absolute -top-2 flex h-5 w-5 items-center justify-center rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] opacity-0 shadow-sm group-hover:opacity-100 ${
            message.role === "user" ? "-left-2" : "-right-2"
          }`}
        >
          {copied ? <Check size={11} className="text-[var(--cf-success)]" /> : <Copy size={11} className="text-[var(--cf-text-muted)]" />}
        </button>
      </div>
      {traceLog}
      <ChatStamp message={message} />
    </div>
  );
}

function ChatSection({ projectId }: { projectId: string }) {
  const t = useT();
  const locale = useLocale();
  const chat = useChatStore((s) => s.byProject[projectId] ?? EMPTY_CHAT);
  const send = useChatStore((s) => s.send);
  const clearChat = useChatStore((s) => s.clear);
  const conversations = useChatHistoryStore((s) => s.byProject[projectId] ?? EMPTY_CONVERSATIONS);
  const chatLoaded = useChatHistoryStore((s) => s.loaded[projectId] ?? false);
  const [input, setInput] = useState("");
  // Collapsed by default: the newest line is enough to know it's alive, and the full log is one
  // click away for when it isn't going well.
  const [logExpanded, setLogExpanded] = useState(false);
  const openSettings = useUiStore((s) => s.openSettings);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages.length, chat.sending]);

  // Self-heal a chat whose conversation was deleted from history: once the persisted list is
  // loaded and this chat's conversation is no longer in it, it's gone — reset the panel so a
  // deleted chat can't keep showing (or get re-created on the next message). Keyed on
  // `conversations` (not on `chat`) so it evaluates against the freshest list and never races a
  // just-arrived reply whose conversation hasn't been reloaded into the list yet.
  useEffect(() => {
    if (!chatLoaded) return;
    const current = useChatStore.getState().byProject[projectId];
    if (!current || current.sending || current.messages.length === 0) return;
    if (!current.conversationId) return;
    const stillExists = conversations.some((c) => c.session_id === current.conversationId);
    if (!stillExists) clearChat(projectId);
  }, [conversations, chatLoaded, clearChat, projectId]);

  const submit = () => {
    if (!input.trim() || chat.sending) return;
    send(projectId, input);
    setInput("");
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto p-4">
        {chat.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
              <Sparkles size={18} />
            </div>
            <p className="text-[14px] font-semibold">{t("chat.title")}</p>
            <p className="max-w-[220px] text-[12px] text-[var(--cf-text-muted)]">
              {t("chat.hint")}{" "}
              <button onClick={() => openSettings("review")} className="text-[var(--cf-accent)] underline">
                {t("chat.configure")}
              </button>
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {chat.messages.map((m, i) => {
              // The day is announced once, between turns that fall on different dates, so each
              // message's own stamp stays a bare time instead of repeating the date all the way
              // down the transcript.
              const day = dayDivider(m, chat.messages[i - 1], locale);
              return (
                <Fragment key={i}>
                  {day && (
                    <div className="flex items-center gap-2 pt-1.5">
                      <div className="h-px flex-1 bg-[var(--cf-border)]" />
                      <span className="text-[10px] text-[var(--cf-text-muted)]">{day}</span>
                      <div className="h-px flex-1 bg-[var(--cf-border)]" />
                    </div>
                  )}
                  <ChatBubble message={m} />
                </Fragment>
              );
            })}
            {chat.sending && chat.runId && (
              // Replaces the old "thinking…" bubble: same reassurance, except now it says what
              // the engine is actually doing and can be stopped.
              <AiRunLog
                runId={chat.runId}
                running
                expanded={logExpanded}
                onToggle={() => setLogExpanded((v) => !v)}
              />
            )}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--cf-border)] p-2.5">
        <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t("chat.placeholder")}
            rows={2}
            className="resize-none bg-transparent px-1.5 py-1 text-[12px] outline-none"
          />
          <div className="flex items-center gap-1.5 px-0.5">
            {/* Which engine this chat talks to — and the control that changes it. Picking here
                rewrites the *chat* task's routing, so it's a real settings change, not a
                per-conversation override. Once there are turns on screen the picker locks to the
                current provider's versions: sessions don't transfer between CLIs. */}
            <ChatModelPicker liveModel={chat.model} chatActive={chat.messages.length > 0} />
            <ChatAgentPicker projectId={projectId} />
            <button
              onClick={submit}
              disabled={!input.trim() || chat.sending}
              className="ml-auto flex h-5 w-5 items-center justify-center rounded-md bg-[var(--cf-accent)] text-white disabled:opacity-40"
            >
              {chat.sending ? <Loader2 size={12} className="animate-spin" /> : <ArrowUp size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Rendered by App.tsx inside an `AnimatePresence` so mount/unmount slides the panel in/out
 * instead of popping — width is what's animated, so the resize handle's own drag updates
 * (which set inline width directly) aren't fighting a CSS transition mid-drag. */
export function AiPanel() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const selectedPr = usePrStore((s) => s.selectedPr);
  const analyzeOpen = useAnalyzeUiStore((s) => s.open);
  const toggle = useUiStore((s) => s.toggleAiPanel);
  const width = useLayoutStore((s) => s.sizes.aiPanelWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  // "New chat" from the panel header works from *any* view: reviewing a PR or looking at an
  // analysis, one click drops those and lands on a fresh, empty free-form conversation — so the
  // user isn't stuck hunting for the little × on the PR card (which only closed the PR, it didn't
  // start a new chat) to get back to open-ended chat.
  const startNewChat = () => {
    if (!project) return;
    usePrStore.getState().selectPr(null);
    useAnalyzeUiStore.getState().hide();
    useChatStore.getState().clear(project.id);
  };

  const [checkpointsOpen, setCheckpointsOpen] = useState(false);

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex shrink-0 overflow-hidden"
    >
      <ResizeHandle
        axis="x"
        value={width}
        min={PANEL_MIN}
        max={PANEL_MAX}
        invert
        onChange={(w) => setSize("aiPanelWidth", w)}
        onCommit={(w) => commitSize("aiPanelWidth", w)}
      />
      <aside
        style={{ width }}
        className="flex shrink-0 flex-col overflow-hidden border-l border-[var(--cf-border)] bg-[var(--cf-surface)]"
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-3">
          <Sparkles size={13} className="text-[var(--cf-accent)]" />
          <span className="text-[12px] font-semibold">{t("chat.title")}</span>
          <div className="ml-auto flex items-center gap-1">
            {project && (
              <button
                onClick={() => setCheckpointsOpen(true)}
                title={t("checkpoints.title")}
                className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
              >
                <RotateCcw size={12} />
              </button>
            )}
            {project && (
              <button
                onClick={startNewChat}
                title={t("chatHistory.newChat")}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
              >
                <Plus size={12} />
                {t("chatHistory.newChat")}
              </button>
            )}
            <button
              onClick={toggle}
              title={t("ai.closePanel")}
              className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
            >
              <X size={13} />
            </button>
          </div>
        </div>
        {!project ? (
          <EmptyState icon={Sparkles} title={t("ai.noProject")} />
        ) : (
          <>
            <ActivitySection projectId={project.id} />
            <div className="min-h-0 flex-1">
              {selectedPr ? (
                <PrReviewSection projectId={project.id} pr={selectedPr} />
              ) : analyzeOpen ? (
                <AnalyzeSection projectId={project.id} />
              ) : (
                <ChatSection projectId={project.id} />
              )}
            </div>
          </>
        )}
      </aside>
      {checkpointsOpen && project && (
        <CheckpointsModal repoPath={project.local_path} onClose={() => setCheckpointsOpen(false)} />
      )}
    </motion.div>
  );
}
