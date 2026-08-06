import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUp,
  Ban,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitMerge,
  Globe,
  History,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
  type LucideIcon,
} from "lucide-react";
import { renderMarkdown } from "../../lib/markdown";
import { CONFIRM_POST_KEYS, POSTED_KEYS, VIEW_ON_KEYS } from "../../lib/providerLabels";
import { discardPrFinding, getReviewRun, REVIEW_SKIPPED } from "../../lib/tauri/commands";
import { parseClaudeError } from "../../lib/claudeError";
import {
  listCommentThreads,
  resolveCommentThread,
  targetKey,
  targetPrKey,
  targetProjectId,
  workspaceActivityKey,
  workspaceIdFromBucket,
  type PrTarget,
} from "../../lib/prTarget";
import {
  parseAnalysis,
  buildFixpack,
  formatFindingAsComment,
  formatSummaryComment,
  formatDecisionComment,
  type SummaryMemory,
} from "../../lib/parseAnalysis";
import { Checkbox } from "../common/Checkbox";
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
import {
  mergeActivityEntries,
  entryKey,
  entryTitle,
  entryTimestamp,
  entryVisual,
  entryRunCount,
  entryIsGlobal,
  entryIsRunning,
  findActiveEntryKey,
  jobPrUrl,
  type ActivityEntry,
} from "../../lib/activityEntries";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLayoutStore } from "../../state/layoutStore";
import { usePrStore } from "../../state/prStore";
import { usePrWatchStore, EMPTY_TRACKED, type TrackedPr } from "../../state/prWatchStore";
import { useJobsStore, EMPTY_JOBS } from "../../state/jobsStore";
import { useChatStore, liveSessionsOf, EMPTY_CHAT, type ChatMessage } from "../../state/chatStore";
import { useChatHistoryStore, EMPTY_CONVERSATIONS } from "../../state/activityStore";
import { useResolutionsStore, EMPTY_RESOLUTIONS } from "../../state/resolutionsStore";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import type { TranslationKey } from "../../lib/i18n/translations";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { ActivityModal } from "./ActivityModal";
import { AiRunLog } from "./AiRunLog";
import { CheckpointsModal } from "./CheckpointsModal";
import { AnalyzeSection } from "./AnalyzeSection";
import { ChatModelPicker } from "./ChatModelPicker";
import { ReviewLevelSelector } from "./ReviewLevelSelector";
import { AiErrorBanner } from "./AiErrorBanner";
import type { PrDecision, PullRequestSummary, PrCommentThread, SavedFinding } from "../../types/domain";

const PANEL_MIN = 280;

/**
 * How wide the panel is allowed to get: half the window, and no more.
 *
 * It used to be a flat 520px, which was a reasonable *default* mistaken for a ceiling — fine for
 * glancing at a chat beside your code, too narrow for the things this panel grew into. A PR review
 * with findings, diffs and comment threads is a document, not a sidebar, and on a wide monitor 520
 * was leaving two thirds of the screen to a file tree.
 *
 * Half is where it stops because past half it stops being a panel: the view it is docked beside
 * becomes the smaller of the two, and the thing the user came to look at is the one that gets
 * squeezed. Anyone who wants the review to have the whole window can close the panel and open the
 * PR from its link instead.
 *
 * The floor keeps the ceiling above `PANEL_MIN` on a window too narrow for both — without it the
 * clamp inverts and the panel is pinned to something smaller than its own minimum.
 */
const maxPanelWidth = () => Math.max(PANEL_MIN, Math.round(window.innerWidth / 2));

/**
 * That ceiling, kept current as the window is resized.
 *
 * A stored width outliving the window it was chosen in is the case this exists for: drag the panel
 * out to 900 on an external display, unplug it, and a static maximum would leave the panel wider
 * than the laptop screen with the app behind it squeezed to nothing. The clamp is applied to what
 * is *rendered*, never written back — plug the display in again and the 900 the user chose is still
 * what they get.
 */
function useMaxPanelWidth(): number {
  const [max, setMax] = useState(maxPanelWidth);
  useEffect(() => {
    const onResize = () => setMax(maxPanelWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return max;
}

/** A stored JSON column (a run's `meta` / `findings`), or `null` when it can't be read — memory
 * written by an older version is context to do without, never a crash. */
function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function relativeTime(ts: number, t: (key: TranslationKey, vars?: Record<string, string | number>) => string): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return t("ai.justNow");
  if (mins < 60) return t("ai.minutesAgo", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("ai.hoursAgo", { n: hours });
  return t("ai.daysAgo", { n: Math.round(hours / 24) });
}

/**
 * The pull requests still waiting on a decision — the way back into any of them.
 *
 * It grew out of the link-sessions list, which solved half the problem: a PR reviewed from a link
 * belongs to no project, so it appears in no sidebar and no list, and the panel showing it was the
 * only handle on it — closing that stranded the whole review. But the other half is just as real
 * and outlived any one session: a PR you reviewed on Friday, left undecided, and could only find
 * again by remembering it existed.
 *
 * So the list is now everything **you have opened here and not yet settled**, project PRs
 * included, kept on disk per workspace (see `prWatchStore`). Entries leave it the moment they stop
 * waiting: you approve, you close, or the host reports it merged. "Changes requested" stays —
 * that PR is still yours to look at again.
 *
 * Each row says what it is waiting for: whether a review has run, and whether changes were already
 * asked for. That is the whole question the list answers — "which of these have I not looked at?"
 */
function PendingPrsSection({ workspaceId }: { workspaceId: string | null }) {
  const t = useT();
  const openLinkPr = usePrStore((s) => s.openLinkPr);
  const selectPr = usePrStore((s) => s.selectPr);
  const tracked = usePrWatchStore((s) => (workspaceId ? s.byWorkspace[workspaceId] ?? EMPTY_TRACKED : EMPTY_TRACKED));
  const load = usePrWatchStore((s) => s.load);
  const untrack = usePrWatchStore((s) => s.untrack);
  const jobsByBucket = useJobsStore((s) => s.byProject);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (workspaceId) void load(workspaceId);
  }, [workspaceId, load]);

  const workspaceJobs = workspaceId ? jobsByBucket[workspaceActivityKey(workspaceId)] ?? EMPTY_JOBS : EMPTY_JOBS;

  const open = (entry: TrackedPr) => {
    useAnalyzeUiStore.getState().hide();
    if (entry.kind === "link" && entry.url) {
      openLinkPr({
        url: entry.url,
        pr: entry.pr,
        repoLabel: entry.repoLabel,
        cloneUrl: entry.cloneUrl ?? "",
        workspaceId: entry.workspaceId,
      });
      return;
    }
    // A project PR is addressed *by the open project* — the panel builds its target from whichever
    // repository is active — so reopening one that belongs to another project has to move there
    // first, or the review would be pointed at the wrong repository. A project that no longer
    // exists takes its entry with it: there is nothing left to point at.
    const workspace = useWorkspaceStore.getState();
    if (entry.projectId && entry.projectId !== workspace.activeProjectId) {
      const exists = (workspace.projectsByWorkspace[entry.workspaceId] ?? []).some(
        (project) => project.id === entry.projectId,
      );
      if (!exists) {
        untrack(entry.workspaceId, entry.key);
        return;
      }
      workspace.setActiveProject(entry.projectId);
    }
    // From the snapshot: the panel refreshes it from the host anyway, and waiting for the list to
    // load would make the click do nothing for a second.
    selectPr(entry.pr);
  };

  if (tracked.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-[var(--cf-border)]">
      <button
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      >
        {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        {t("pr.pendingTitle")}
        <span className="tabular-nums opacity-70">({tracked.length})</span>
      </button>
      {!collapsed && (
        <div className="max-h-52 overflow-auto px-1.5 pb-1.5">
          {tracked.map((entry) => {
            const runs = entry.url
              ? workspaceJobs.filter((job) => jobPrUrl(job) === entry.url).length
              : 0;
            const marks = [
              entry.repoLabel,
              entry.decision === "changes_requested"
                ? t("pr.pendingChangesRequested")
                : entry.reviewed || runs > 0
                  ? t("pr.pendingReviewed")
                  : t("pr.pendingUnreviewed"),
            ].filter(Boolean);
            return (
              <div key={entry.key} className="group flex items-center gap-1">
                <button
                  onClick={() => open(entry)}
                  className="min-w-0 flex-1 rounded-md px-1.5 py-1 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  <span className="flex items-center gap-1.5">
                    {/* A link PR is the one with no repository here — worth marking, because it is
                        also the one nothing else in the app can lead you back to. */}
                    {entry.kind === "link" && <Link2 size={10} className="shrink-0 text-[var(--cf-text-muted)]" />}
                    <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">
                      #{entry.prId} {entry.title}
                    </span>
                  </span>
                  <span className="block truncate text-[10px] text-[var(--cf-text-muted)]">
                    {marks.join(" · ")}
                  </span>
                </button>
                <button
                  onClick={() => workspaceId && untrack(workspaceId, entry.key)}
                  title={t("pr.pendingDismiss")}
                  aria-label={t("pr.pendingDismiss")}
                  className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] opacity-0 hover:bg-black/[0.05] hover:text-[var(--cf-text)] group-hover:opacity-100 dark:hover:bg-white/[0.08]"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Unified "Activity" list — background jobs (PR review / pre-commit analysis) and past chat
 * conversations combined and sorted by recency, so there's one place to reopen anything Claude has
 * done instead of several separate sections.
 *
 * Two buckets feed it. The project's own history is the obvious one. The other is the
 * *workspace's*: a PR reviewed from a link belongs to a repository this machine doesn't have, so
 * it can't be filed against a project — but it still happened, and it's still worth reopening. It
 * is therefore shown whichever repository of the workspace is open (marked with a globe, since it
 * belongs to none of them) and stops showing on switching to another workspace.
 */
function ActivitySection({ projectId, workspaceId }: { projectId: string | null; workspaceId: string | null }) {
  const t = useT();
  const workspaceBucket = workspaceId ? workspaceActivityKey(workspaceId) : null;
  const projectJobs = useJobsStore((s) => (projectId ? s.byProject[projectId] : undefined) ?? EMPTY_JOBS);
  const workspaceJobs = useJobsStore((s) => (workspaceBucket ? s.byProject[workspaceBucket] : undefined) ?? EMPTY_JOBS);
  const jobsLoaded = useJobsStore((s) => (projectId ? s.loaded[projectId] : true));
  const workspaceLoaded = useJobsStore((s) => (workspaceBucket ? s.loaded[workspaceBucket] : true));
  const loadJobHistory = useJobsStore((s) => s.load);
  const selectedPr = usePrStore((s) => s.selectedPr);
  const linkPr = usePrStore((s) => s.linkPr);
  const selectPr = usePrStore((s) => s.selectPr);
  const analyzeOpen = useAnalyzeUiStore((s) => s.open);
  const analyzeJobId = useAnalyzeUiStore((s) => s.selectedJobId);
  const conversations = useChatHistoryStore((s) => (projectId ? s.byProject[projectId] : undefined) ?? EMPTY_CONVERSATIONS);
  const chatLoaded = useChatHistoryStore((s) => (projectId ? s.loaded[projectId] : true));
  const loadChatHistory = useChatHistoryStore((s) => s.load);
  const loadResolutions = useResolutionsStore((s) => s.load);
  const activeSessionId = useChatStore((s) => (projectId ? s.activeByProject[projectId] : null) ?? null);
  const byConversation = useChatStore((s) => s.byConversation);
  const switchTo = useChatStore((s) => s.switchTo);
  const [collapsed, setCollapsed] = useState(true);
  const [showModal, setShowModal] = useState(false);
  /** Which row-opening is the current one. See `openEntry` — same monotonic-token idea as
   * `memoryReqRef` further down, for the same reason: an answer that arrives after the question
   * stopped being the one on screen has to be dropped, not applied. */
  const openReqRef = useRef(0);

  useEffect(() => {
    if (!projectId) return;
    if (!chatLoaded) void loadChatHistory(projectId);
    if (!jobsLoaded) void loadJobHistory(projectId);
    // Hydrate persisted "resolve with AI" outcomes so an already-resolved finding/comment shows
    // its ✓ state immediately when a PR/analysis is opened, instead of looking un-actioned.
    void loadResolutions(projectId);
  }, [projectId, chatLoaded, loadChatHistory, jobsLoaded, loadJobHistory, loadResolutions]);

  useEffect(() => {
    if (workspaceBucket && !workspaceLoaded) void loadJobHistory(workspaceBucket);
  }, [workspaceBucket, workspaceLoaded, loadJobHistory]);

  const jobs = useMemo(
    () => (workspaceJobs.length === 0 ? projectJobs : [...projectJobs, ...workspaceJobs]),
    [projectJobs, workspaceJobs],
  );
  const liveChats = useMemo(() => liveSessionsOf(byConversation, projectId), [byConversation, projectId]);
  const entries = useMemo(
    () => mergeActivityEntries(jobs, conversations, liveChats),
    [jobs, conversations, liveChats],
  );
  if (entries.length === 0) return null;

  const activeEntryKey = findActiveEntryKey(entries, {
    selectedPrId: selectedPr?.id ?? null,
    // A link session's PR is shown the same way a selected one is, so its row highlights too —
    // matched by URL, since its number belongs to a repository the other rows know nothing about.
    // Only when it's this workspace's: one parked under another isn't on screen to highlight.
    linkPrUrl: linkPr?.workspaceId === workspaceId ? linkPr.url : null,
    analyzeOpen,
    analyzeJobId,
    activeSessionId,
  });

  // Counted over entries rather than over jobs, so a chat waiting on an answer is included — it's
  // a background run like any other, and the badge is what tells the user it's still alive after
  // they've navigated away from it.
  const runningCount = entries.filter(entryIsRunning).length;
  const topFive = entries.slice(0, 5);

  const openEntry = (entry: ActivityEntry) => {
    // Every row taken from here counts, whichever kind it is: the pull-request branch below can
    // finish *after* the click that came next, and what makes that safe is knowing it was
    // superseded. Bumped before any branch runs so a chat or an analysis opened in the meantime is
    // enough to disown a review still in flight.
    const token = ++openReqRef.current;
    if (entry.type === "chat") {
      if (!projectId) return;
      // Clear whatever else the panel might currently be showing — otherwise the chat
      // switches underneath a still-visible PR review or analysis section.
      selectPr(null);
      useAnalyzeUiStore.getState().hide();
      void switchTo(projectId, entry.conv.session_id);
      return;
    }
    // A workspace row rebuilds its whole link session from the row itself: after a restart there
    // is no parked session to bring back, and no project list to look the PR up in.
    const rowWorkspaceId = workspaceIdFromBucket(entry.job.projectId);
    if (rowWorkspaceId) {
      useAnalyzeUiStore.getState().hide();
      usePrStore.getState().openLinkPrFromMeta(entry.job.meta, rowWorkspaceId);
      return;
    }
    // A recorded decision opens the PR it was taken on, same as a review of it would. The list it
    // is looked up in is fetched on demand: the sidebar section that used to load it eagerly now
    // waits to be unfolded, and this row has to work whether or not it ever was.
    if (entry.job.kind === "pr-review" || entry.job.kind === "pr-action") {
      const prId = entry.job.meta.prId;
      if (!projectId || typeof prId !== "number") return;
      void usePrStore
        .getState()
        .ensureProjectPr(projectId, prId)
        .then((pr) => {
          // The click that started this is no longer the one the user is waiting on — a row opened
          // since owns the panel now, and taking it over from behind is how a chat someone just
          // opened turns back into a pull request under their hands.
          if (openReqRef.current !== token || !pr) return;
          useAnalyzeUiStore.getState().hide();
          selectPr(pr);
        });
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
                {entryIsGlobal(entry) && (
                  <Globe
                    size={11}
                    className="shrink-0 text-[var(--cf-text-muted)]"
                    aria-label={t("activity.workspaceWide")}
                  />
                )}
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
      {showModal && (
        <ActivityModal projectId={projectId} workspaceId={workspaceId} onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}

/**
 * One PR review, whatever it's backed by.
 *
 * `target` is the whole difference between a PR from a project's own list and one opened from a
 * pasted link with nothing cloned: the operations that act on the *host* — comment threads,
 * decisions, publishing — are identical, and the two that need a working copy (a diff built from
 * local git, applying a fix to a file) simply aren't offered when there isn't one.
 */
function PrReviewSection({ target, pr }: { target: PrTarget; pr: PullRequestSummary }) {
  const t = useT();
  const projectId = targetProjectId(target);
  const bucket = targetKey(target);
  // What this section *addresses*, as opposed to which bucket it reads from: the bucket of a link
  // review is its whole workspace, shared with every other repository reached by link, so it
  // doesn't change when the panel moves from one such PR to another — and effects keyed on it
  // would skip their refetch between two repositories that both happen to have a "#42".
  const prKey = targetPrKey(target, pr.id);
  const linkOnly = target.kind === "link";
  const reviewPr = usePrStore((s) => s.reviewPr);
  const reviewLevel = usePrStore((s) => s.reviewLevel);
  const setReviewLevel = usePrStore((s) => s.setReviewLevel);
  const postReview = usePrStore((s) => s.postReview);
  const selectPr = usePrStore((s) => s.selectPr);
  const closeLinkPr = usePrStore((s) => s.closeLinkPr);
  const posting = usePrStore((s) => s.posting);
  const posted = usePrStore((s) => s.posted);
  const actOnPr = usePrStore((s) => s.actOnPr);
  const prActionBusy = usePrStore((s) => s.prActionBusy);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // The open link session, when this PR *is* one: it carries the repository label and clone URL
  // that a link PR has and a project PR doesn't need.
  const openLinkSession = usePrStore((s) => s.linkPr);
  const linkSession =
    target.kind === "link" && openLinkSession?.url === target.url ? openLinkSession : null;
  // What has been fixed from here since the review ran — the "Resolve with AI" outcomes, keyed the
  // same way the finding cards key them. A link session has no project to file them under.
  const resolutions = useResolutionsStore((s) =>
    projectId ? (s.byProject[projectId] ?? EMPTY_RESOLUTIONS) : EMPTY_RESOLUTIONS,
  );
  const jobs = useJobsStore((s) => s.byProject[bucket] ?? EMPTY_JOBS);
  // A workspace bucket holds the reviews of every repository reached by link, so the PR number
  // alone would happily match some other repo's "#42" — the URL is what identifies this one.
  const linkUrl = target.kind === "link" ? target.url : null;
  const job = useMemo(
    () =>
      jobs.find((j) =>
        j.kind === "pr-review" && (linkUrl !== null ? jobPrUrl(j) === linkUrl : j.meta.prId === pr.id),
      ) ?? null,
    [jobs, pr.id, linkUrl],
  );

  const [logExpanded, setLogExpanded] = useState(false);
  const loading = job?.status === "running";
  const error = job?.status === "error" ? job.error : null;
  const rawReviewText = job?.status === "done" ? job.result : null;
  // A review the plan stopped to ask about — a draft, a merged PR. It comes back as a *successful*
  // run carrying a marker rather than as an error, because nothing failed: the review simply
  // hasn't been authorised yet. Kept out of `reviewText` so the findings parse never sees it.
  const skipReason = rawReviewText?.startsWith(REVIEW_SKIPPED)
    ? rawReviewText.slice(REVIEW_SKIPPED.length)
    : null;
  const reviewText = skipReason ? null : rawReviewText;
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

  // The reviewer's own record of this PR: which findings earlier iterations closed, and the scope
  // and depth this run happened under. It's what lets the published summary say "one finding, now
  // fixed" instead of an unqualified "nothing found" — a clean run reads identically whether the
  // PR never had a defect or had three that were all corrected. Only project-backed reviews keep
  // memory (a link session has no run to save), so it stays null for those.
  const [runMemory, setRunMemory] = useState<SummaryMemory | null>(null);
  const runId = job?.status === "done" ? job.id : null;
  // Same monotonic-token guard the comment threads use: this is awaited both from an effect (which
  // re-fires on every PR switch) and from a discard, so without it a slow read of the PR just left
  // can land after the new one and put another pull request's rulings on these cards.
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
      // The summary simply loses its "already fixed" half — never a reason to break the panel.
    }
  }, [runId, linkOnly]);
  useEffect(() => {
    setRunMemory(null);
    void loadRunMemory();
  }, [loadRunMemory]);

  // What a human has already ruled about each finding. The cards render findings parsed out of the
  // review markdown, which predates every one of those rulings — so the verdict is looked up
  // alongside, by the stable `F-NNN` id both halves agree on.
  const marks = useMemo(() => {
    const map = new Map<string, FindingMark>();
    for (const f of runMemory?.all ?? []) {
      map.set(f.id, { estado: f.estado, motivo: f.motivo_descarte, posted: f.thread_id != null });
    }
    return map;
  }, [runMemory]);
  /** The findings that still stand: what the Quality Gate judges, what gets published, and what the
   * summary counts. Rejected ones stay in the list below (dimmed, undoable) but stop counting —
   * a false positive that still fails the gate is a false positive nobody actually dismissed. */
  const activeFindings = useMemo(
    () => findings.filter((f) => !isDiscarded(marks.get(f.id))),
    [findings, marks],
  );
  /** `parsed` narrowed to those, so the gate, the tally and the tables in a published comment can't
   * disagree with what the panel shows. */
  const activeParsed = useMemo(
    () => (parsed ? { ...parsed, findings: activeFindings } : null),
    [parsed, activeFindings],
  );

  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const discardFinding = async (findingId: string, estado: string, opts: DiscardOptions) => {
    if (!job || !projectId) return;
    setDiscardingId(findingId);
    try {
      const outcome = await discardPrFinding(
        projectId,
        pr.id,
        job.id,
        findingId,
        estado,
        opts.motivo || undefined,
        opts.scopeRepo,
        opts.notifyHost,
      );
      // Publishing something just called a non-defect is exactly what the mark is meant to prevent,
      // so the selection follows the ruling instead of waiting to be corrected by hand.
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (estado === "abierto") next.add(findingId);
        else next.delete(findingId);
        return next;
      });
      // The host half is best-effort by design: the mark is already durable, so a refused reply is
      // a warning about the pull request, not a failed action.
      if (outcome.host_error) pushErrorToast(t("finding.discardHostFailed", { error: outcome.host_error }));
      else if (outcome.rule_added) useToastStore.getState().pushToast(t("finding.discardRuleAdded"), "success");
      else if (outcome.host_notified) useToastStore.getState().pushToast(t("finding.discardHostNotified"), "success");
      await loadRunMemory();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setDiscardingId(null);
    }
  };

  const [fixpackCopied, copyFixpack] = useCopy();
  const runReview = () => reviewPr(target, pr.id);
  const publish = async () => {
    if (!activeParsed || !job) return;
    const chosen = activeFindings.filter((f) => selectedIds.has(f.id));
    if (chosen.length === 0 && !postSummary) return;
    // Publishing only the summary is its own sentence: "post 0 comment(s)" describes nothing.
    const confirmKey =
      chosen.length === 0 ? "pr.confirmPostSummaryOnly" : CONFIRM_POST_KEYS[pr.provider];
    if (!(await confirmAction(t(confirmKey, { id: pr.id, n: chosen.length }), false))) return;
    const items = chosen.map((f) => ({
      file: f.location?.file ?? null,
      category: f.category,
      content: formatFindingAsComment(f),
      location: f.location,
    }));
    // `chosen`, not every finding: the summary describes what actually gets posted — plus what the
    // memory says this PR already closed, which is the whole point of publishing a summary on a
    // re-review that found nothing left.
    const summary = postSummary
      ? formatSummaryComment(activeParsed, new Date().toISOString().slice(0, 10), chosen, runMemory)
      : null;
    try {
      await postReview(target, pr.id, job.id, items, postSummary, summary);
    } catch {
      // Already surfaced as a toast by the store; nothing to reload if nothing was posted.
      return;
    }
    // Posting is what gives each finding its thread id, and the thread is what a later "false
    // positive" replies on. Without this the option to answer on the PR only appears after the
    // panel is reopened — exactly when the finding is freshest is when it would be missing.
    await loadRunMemory();
  };

  // A decision already on the record (here or on the website) retires the button that would take
  // it again — and a merged/closed PR retires all three, since there's nothing left to decide.
  const decision = usePrStore((s) => s.decisionByPr[prKey] ?? "none");
  const loadPrDecision = usePrStore((s) => s.loadPrDecision);
  useEffect(() => {
    void loadPrDecision(target, pr.id);
    // `target` is rebuilt on every render by the caller, so the identity that matters is what it
    // addresses — the pull request itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPrDecision, prKey]);

  const prClosed = pr.status === "merged" || pr.status === "closed";

  // Kept on the "waiting on me" list for as long as it is waiting on me. Written on every look at
  // the PR (so the snapshot stays current) and reconciled against what the host says, which is
  // what takes an approved, merged or closed one off the list without anyone having to remember.
  const watchWorkspaceId = target.kind === "link" ? target.workspaceId : activeWorkspaceId;
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
      cloneUrl: linkSession?.cloneUrl,
      workspaceId: watchWorkspaceId,
      prId: pr.id,
      title: pr.title,
      repoLabel: linkSession?.repoLabel ?? "",
      pr,
      decision: decision === "changes_requested" ? "changes_requested" : "none",
      reviewed: Boolean(reviewText),
      at: Date.now(),
    });
    // The snapshot only needs rewriting when one of the things it holds changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prKey, watchWorkspaceId, pr.status, pr.title, decision, prClosed, Boolean(reviewText)]);

  /**
   * Whether settling the PR also publishes the summary of what the review found, what was fixed
   * and what was accepted anyway.
   *
   * On by default, because the decision is the moment that record is worth anything — and a
   * checkbox rather than a rule, because the person approving is the one who knows whether this
   * PR wants that comment. Only offered when there is a review to summarise: a "decision comment"
   * with nothing in it would be noise on someone else's pull request.
   */
  const [commentOnDecision, setCommentOnDecision] = useState(true);
  const willComment = commentOnDecision && Boolean(parsed) && Boolean(job);

  const doPrAction = async (action: "approve" | "request_changes" | "close") => {
    const confirmKey =
      action === "approve"
        ? "pr.confirmApprove"
        : action === "request_changes"
          ? "pr.confirmRequestChanges"
          : "pr.confirmClose";
    // Request-changes and close are destructive-ish (they push a state the author sees), so they
    // get the emphasized confirm; approve gets the plain one. When a comment rides along, the
    // confirm says so — publishing to a PR is not something to discover afterwards.
    const question = willComment
      ? `${t(confirmKey, { id: pr.id })}\n\n${t("pr.decisionCommentNotice")}`
      : t(confirmKey, { id: pr.id });
    if (!(await confirmAction(question, action !== "approve"))) return;
    const note =
      willComment && job
        ? {
            runId: job.id,
            body: formatDecisionComment(
              action,
              new Date().toISOString().slice(0, 10),
              activeParsed,
              runMemory,
              // What was fixed from here since the review ran — those findings are corrected, not
              // accepted, and the note would otherwise file them under the wrong heading.
              activeFindings.filter((f) => resolutions[`job:${job.id}:${f.id}`]).map((f) => f.id),
            ),
          }
        : null;
    void actOnPr(target, pr.id, action, note);
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
    return listCommentThreads(target, pr.id)
      .then((threads) => {
        if (threadsReqRef.current === token) setOpenThreads(threads);
      })
      .catch(() => {
        if (threadsReqRef.current === token) setOpenThreads([]);
      })
      .finally(() => {
        if (threadsReqRef.current === token) setThreadsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prKey]);
  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  /** Answers a conversation on the host and closes it, then drops it from the list — the host's own
   * listing already excludes resolved threads, so keeping the card around would just be a row that
   * reappears as gone on the next refresh.
   *
   * Returns what each half managed to do, `null` when the call itself failed. Reply and close are
   * separate host calls: GitHub takes a reply on a conversation-level comment it then refuses to
   * resolve (only review threads can be resolved), and in that case the card has to stay — knowing
   * the reply is already on the pull request, so a retry doesn't write it twice. */
  const resolveThread = async (threadId: number, reply: { body: string | null; wontFix: boolean }) => {
    try {
      const outcome = await resolveCommentThread(target, pr.id, threadId, reply);
      if (outcome.resolved) {
        setOpenThreads((threads) => threads.filter((thread) => thread.id !== threadId));
        useToastStore.getState().pushToast(t(outcome.replied ? "pr.threadRepliedAndResolved" : "pr.threadResolved"), "success");
      } else {
        pushErrorToast(
          outcome.replied
            ? t("pr.threadRepliedNotResolved", { error: outcome.error ?? "" })
            : outcome.error ?? t("pr.threadNotResolved"),
        );
      }
      return outcome;
    } catch (e) {
      pushErrorToast(String(e));
      return null;
    }
  };

  /**
   * Everything this panel reads from the host, re-read at once: the pull request itself (state,
   * title, head), the decision the signed-in user has on record, and the open conversation.
   *
   * The three are fetched together rather than behind three buttons because they are one question —
   * "what does the PR look like right now" — and they go stale together. Notably the decision: a
   * vote reset on the website used to keep the panel showing the buttons as spent until the PR was
   * closed and reopened.
   *
   * Failures are each side's own business (all three are silent or toast on their own), so this
   * only tracks that a refresh is in flight, to keep the button honest.
   */
  const refreshPr = usePrStore((s) => s.refreshPr);
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshPr(target, pr.id), loadPrDecision(target, pr.id), loadThreads()]);
    } finally {
      setRefreshing(false);
    }
  };

  // Footer buttons truncate when the panel is narrow, so their label doubles as the tooltip.
  const publishLabel = posted
    ? t(POSTED_KEYS[pr.provider])
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
              {t(VIEW_ON_KEYS[pr.provider])}
            </a>
            {!loading && !error && parsed && (
              <div className="mt-1.5">
                <QualityGateBadges grades={parsed.grades} findings={activeFindings} />
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* The pull request goes on living outside this panel: a vote is reset on the website,
                a commit is pushed, someone comments. Until now the panel only read all of that when
                it was opened, so the way to see it was to close the PR and open it again. This is
                that, without the round trip. */}
            <button
              onClick={() => void refreshAll()}
              disabled={refreshing}
              title={t("pr.refreshAllHint")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-50 dark:hover:bg-white/[0.08]"
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
            </button>
            <button
              onClick={() => (linkOnly ? closeLinkPr() : selectPr(null))}
              title={t("chat.backToChat")}
              className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Says which repository this PR belongs to — no project in the sidebar is naming it —
            and what the missing clone costs, since the difference shows up in the findings. */}
        {linkOnly && <LinkReviewNotice />}

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
                onResolveThread={(reply) => resolveThread(thread.id, reply)}
              />
            ))}
          </div>
        )}

        {/* One card, not two: the run's state, what it is printing, how long it has been going and
            the way to stop it all belong to the same thing. See `AiRunLog`. */}
        {loading && job && (
          <AiRunLog
            runId={job.id}
            running
            startedAt={job.createdAt}
            expanded={logExpanded}
            onToggle={() => setLogExpanded((v) => !v)}
          />
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

        {/* The plan declined to spend anything and said why. An answer, not a failure — so it is
            offered as a question with the override next to it, and the override is the only thing
            that sets `force`. */}
        {!loading && skipReason && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-[color-mix(in_oklab,var(--cf-warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-warning)_9%,transparent)] px-3 py-2 text-[12px] text-[var(--cf-text)]">
            <SkipForward size={13} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
            <div className="min-w-0 flex-1">
              <p className="break-words">{skipReason}</p>
              {!prClosed && (
                <button
                  onClick={() => reviewPr(target, pr.id, undefined, true)}
                  className="mt-1 text-[var(--cf-accent)] underline"
                >
                  {t("pr.reviewAnyway")}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Nothing open, and the memory says this PR closed things along the way. Without this the
            panel shows a bare "no issues" that reads the same on a PR that never had one. */}
        {!loading && !error && reviewText && findings.length === 0 && (runMemory?.resolved.length ?? 0) > 0 && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-[color-mix(in_oklab,var(--cf-success)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-success)_9%,transparent)] px-3 py-2 text-[12px] text-[var(--cf-text)]">
            <CheckCheck size={13} className="shrink-0 text-[var(--cf-success)]" />
            {t("pr.allResolved", { n: runMemory?.resolved.length ?? 0 })}
          </div>
        )}

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
                  {t("pr.findingsHeader", { n: activeFindings.length })}
                </p>
                <SeverityCountBadges findings={activeFindings} />
              </div>
              <div className="space-y-2">
                {findings.map((finding, at) => {
                  const mark = marks.get(finding.id) ?? null;
                  return (
                    <div key={finding.id} className="flex items-start gap-2">
                      {/* A rejected finding has nothing left to publish, so its checkbox goes —
                          leaving a live, unticked box would read as "you could still post this". */}
                      <span className="mt-2 shrink-0" title={t("pr.selectToPost")}>
                        {isDiscarded(mark) ? (
                          <span className="block h-3.5 w-3.5" />
                        ) : (
                          <Checkbox checked={selectedIds.has(finding.id)} onChange={() => toggleSelected(finding.id)} />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <FindingCard
                          finding={finding}
                          at={at}
                          defaultOpen={false}
                          projectId={projectId}
                          prSourceBranch={pr.source_branch}
                          resolutionKey={job ? `job:${job.id}:${finding.id}` : undefined}
                          mark={mark}
                          // Only a project-backed review has a run to record the ruling in; a link
                          // session would take the click and forget it.
                          onDiscard={
                            projectId && job && !linkOnly
                              ? (estado, opts) => void discardFinding(finding.id, estado, opts)
                              : undefined
                          }
                          discarding={discardingId === finding.id}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {!loading && !error && !reviewText && (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("chat.awaitingReview")}</p>
        )}
      </div>

      {/* Footer laid out as two labelled blocks — *reviewing* the PR, then *deciding* it — instead
          of one stack of rows. They were already separate jobs (one runs an agent and publishes
          what it found, the other records a verdict on the host), but read as a single pile of
          controls where the level selector, two checkboxes and five buttons all looked equally
          related. Each block now reads action-row first, then the toggles that modify it.

          Order is the order of the work: you review, you publish, and only then do you decide.

          Rows stay stacked rather than packed into one strip because the panel can be as narrow as
          PANEL_MIN, where a single line wrapped labels onto two and rendered oversized buttons.
          Every label here stays on one line and truncates. */}
      <div className="@container shrink-0 space-y-2.5 border-t border-[var(--cf-border)] p-2.5">
        {(prClosed || decision !== "none") && <PrDecisionState status={pr.status} decision={decision} />}
        {/* Everything in this block acts *on* the pull request — running a review of it, publishing
            to it. A merged or closed PR is settled, so none of it is offered: the state chip above
            is the whole footer. Its findings stay readable above, they just have nowhere left to
            go. */}
        {!prClosed && (
          <section className="space-y-1.5">
            <FooterSectionLabel text={t("pr.sectionReview")} />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              {/* Named, because "Básico · Completo · Ultra" on its own says nothing about what the
                  three words select. */}
              <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{t("pr.levelLabel")}</span>
              <ReviewLevelSelector value={reviewLevel} onChange={setReviewLevel} disabled={loading} />
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
            {/* Under the buttons they qualify: what publishing also carries, and the one thing here
                that leaves the app rather than acting on the PR. Both only exist once a review has
                actually produced something. */}
            {reviewText && !loading && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {/* Offered for a clean run too, not just one with findings: a re-review that finds
                    nothing left is exactly when the summary — what was covered, what got fixed — is
                    the only thing worth publishing. */}
                <label
                  className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]"
                  title={t("pr.postSummaryHint")}
                >
                  <Checkbox checked={postSummary} onChange={setPostSummary} />
                  {t("pr.postSummary")}
                </label>
                {findings.length > 0 && (
                  <button
                    // Built from what stands: a fix-pack is a work order for another agent, and
                    // handing it a finding a human just rejected would have it "fix" a non-defect.
                    onClick={() => activeParsed && copyFixpack(buildFixpack(activeParsed, pr.id))}
                    title={t("pr.fixpackHint")}
                    className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                  >
                    {fixpackCopied ? <Check size={11} /> : <Copy size={11} />}
                    {t("pr.fixpack")}
                  </button>
                )}
              </div>
            )}
          </section>
        )}
        {!prClosed && decision !== "approved" && (
          <section className="space-y-1.5 border-t border-[var(--cf-border)] pt-2.5">
            <FooterSectionLabel text={t("pr.sectionDecision")} />
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
            {/* Whichever of the three buttons above is pressed also leaves the review's verdict on
                the PR — what was found, what got fixed, and what is being accepted anyway. Only
                offered when there is a review to summarise; a decision note with nothing in it is
                noise on someone else's PR. */}
            {parsed && job && (
              <label
                className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]"
                title={t("pr.commentOnDecisionHint")}
              >
                <Checkbox checked={commentOnDecision} onChange={setCommentOnDecision} />
                {t("pr.commentOnDecision")}
              </label>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** Names one block of the footer. Same treatment as the "open comments" heading in the panel body,
 * so the two read as the same kind of divider rather than two different ideas of a section. */
function FooterSectionLabel({ text }: { text: string }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{text}</p>
  );
}

/**
 * The banner a link-only review wears: which repository the PR is in (nothing else on screen says
 * so), what this review can't see, and the way out of that — cloning it, which turns the same PR
 * into a project-backed review with no loss of place.
 */
function LinkReviewNotice() {
  const t = useT();
  const linkPr = usePrStore((s) => s.linkPr);
  const openCloneOffer = useUiStore((s) => s.openPrLinkModal);
  if (!linkPr) return null;
  return (
    <div className="mb-4 rounded-lg border border-dashed border-[var(--cf-border)] px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--cf-text)]">
        <Link2 size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 truncate">{linkPr.repoLabel}</span>
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("prLink.quickNote")}</p>
      <button
        onClick={openCloneOffer}
        className="mt-1 text-[11px] font-medium text-[var(--cf-accent)] hover:underline"
      >
        {t("prLink.cloneInstead")}
      </button>
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

/** How long a turn took, in the largest unit that still reads as a duration. Past a minute the
 * seconds count stops being one — an agentic turn can run for ten of them, and "616.7s" makes the
 * reader do the division. Mirrors `formatElapsed` in `AiRunLog`, so the timer that ran during the
 * turn and the stamp left behind afterwards agree on how to spell the same span. */
const formatResponseTime = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${(ms / 1000).toFixed(1)}s`;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (total < 3600) return `${Math.floor(total / 60)}:${pad(total % 60)}`;
  return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};

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
        // Selectable as a bubble rather than only through the markdown class inside it: a plain
        // (non-markdown) message — a user's own turn, a cancelled run's text — renders as a bare
        // string here and would otherwise be the one kind of message you couldn't quote back.
        className={`group relative select-text rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed ${
          message.role === "user"
            ? "ml-auto max-w-[85%] whitespace-pre-wrap border border-[color-mix(in_oklab,var(--cf-accent)_30%,transparent)] bg-[color-mix(in_oklab,var(--cf-accent)_14%,var(--cf-surface))] text-[var(--cf-text)]"
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
  const activeId = useChatStore((s) => s.activeByProject[projectId] ?? null);
  const chat = useChatStore((s) => (activeId ? s.byConversation[activeId] : undefined) ?? EMPTY_CHAT);
  const send = useChatStore((s) => s.send);
  const discardChat = useChatStore((s) => s.discard);
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
  // loaded and this chat's conversation is no longer in it, it's gone — drop it so a deleted chat
  // can't keep showing (or get re-created on the next message). Keyed on `conversations` (not on
  // `chat`) so it evaluates against the freshest list and never races a just-arrived reply whose
  // conversation hasn't been reloaded into the list yet.
  //
  // Only a *persisted* conversation is reconciled: one whose first turn is still running, or was
  // stopped, has no row on disk by design and would otherwise be deleted out from under the user.
  useEffect(() => {
    if (!chatLoaded || !activeId) return;
    const current = useChatStore.getState().byConversation[activeId];
    if (!current || current.sending || !current.persisted || current.messages.length === 0) return;
    const stillExists = conversations.some((c) => c.session_id === activeId);
    if (!stillExists) discardChat(activeId);
  }, [conversations, chatLoaded, discardChat, activeId]);

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
                startedAt={chat.runStartedAt}
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
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const selectedPr = usePrStore((s) => s.selectedPr);
  const openLinkPr = usePrStore((s) => s.linkPr);
  // A link review is a review *of this workspace* — it runs under its review standard, contexts
  // and skills, and it's filed in its Activity. Moving to another workspace therefore takes
  // it off screen, exactly as it takes that workspace's Activity off screen. The session isn't
  // dropped, only hidden: coming back shows it again.
  const linkPr = openLinkPr?.workspaceId === activeWorkspaceId ? openLinkPr : null;
  const linkTarget = useMemo<PrTarget | null>(
    () => (linkPr ? { kind: "link", url: linkPr.url, workspaceId: linkPr.workspaceId } : null),
    [linkPr],
  );
  const analyzeOpen = useAnalyzeUiStore((s) => s.open);
  const toggle = useUiStore((s) => s.toggleAiPanel);
  const storedWidth = useLayoutStore((s) => s.sizes.aiPanelWidth);
  const maxWidth = useMaxPanelWidth();
  // What the panel is actually drawn at. Only ever narrower than what is stored, and only while the
  // window is too small to honour it — see `useMaxPanelWidth`.
  const width = Math.min(storedWidth, maxWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  // "New chat" from the panel header works from *any* view: reviewing a PR or looking at an
  // analysis, one click drops those and lands on a fresh, empty free-form conversation — so the
  // user isn't stuck hunting for the little × on the PR card (which only closed the PR, it didn't
  // start a new chat) to get back to open-ended chat.
  //
  // None of it is destructive: a selected PR is still in the sidebar, anything left undecided
  // — link sessions included — is on the "waiting on you" list above Activity, and a chat that was
  // mid-answer keeps answering in the background. `clear` only detaches the view; the conversation
  // stays in Activity with its spinner and is one click away.
  const startNewChat = () => {
    if (!project) return;
    usePrStore.getState().selectPr(null);
    usePrStore.getState().closeLinkPr();
    useAnalyzeUiStore.getState().hide();
    useChatStore.getState().clear(project.id);
  };

  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  /**
   * The easing that opens and closes this panel has to be off while it is being dragged.
   *
   * `animate` treats every width it is handed as a target to ease toward, and a drag hands it a new
   * one on every pointer move — so the edge eased for 180ms toward a width the pointer had already
   * left, and the panel swam after the cursor instead of tracking it. Zero duration while dragging
   * makes the width land in the same frame the pointer moved; the transition is back for the open
   * and close, which is the only place it was ever meant to apply.
   */
  const [resizing, setResizing] = useState(false);

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={resizing ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
      className="flex shrink-0 overflow-hidden"
    >
      <ResizeHandle
        axis="x"
        value={width}
        min={PANEL_MIN}
        max={maxWidth}
        invert
        onChange={(w) => setSize("aiPanelWidth", w)}
        onCommit={(w) => commitSize("aiPanelWidth", w)}
        onDragChange={setResizing}
      />
      <aside
        style={{ width }}
        // No `border-l`: the handle to its left is already the seam, and the border was a second
        // line beside it — see the note in `TerminalDock`.
        className="flex shrink-0 flex-col overflow-hidden bg-[var(--cf-surface)]"
      >
        {/* `h-10`, matching `TabBar` — the two sit side by side at the top of the same row, so
            their bottom borders are read as one line across the window and any difference shows
            up as a step at the seam. */}
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-3">
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
        {/* A PR opened from a link outranks the project view and works without one — that's the
            whole point: it belongs to a repository this machine may not have. */}
        {/* Activity is the same list in every case: the active project's history plus the
            workspace's own — the reviews of PRs that belong to no repository here. It renders
            above whatever the panel is showing, including a link review, which is exactly where
            the way back to the other ones has to be. */}
        {linkPr ? (
          <>
            <ActivitySection projectId={project?.id ?? null} workspaceId={activeWorkspaceId} />
            <div className="min-h-0 flex-1">
              <PrReviewSection target={linkTarget!} pr={linkPr.pr} />
            </div>
          </>
        ) : !project ? (
          // Still offer the way back into a parked link review — with no project open this used
          // to be a dead end, which is exactly where "New chat" landed the user.
          <>
            <PendingPrsSection workspaceId={activeWorkspaceId} />
            <ActivitySection projectId={null} workspaceId={activeWorkspaceId} />
            <EmptyState icon={Sparkles} title={t("ai.noProject")} />
          </>
        ) : (
          <>
            <PendingPrsSection workspaceId={activeWorkspaceId} />
            <ActivitySection projectId={project.id} workspaceId={activeWorkspaceId} />
            <div className="min-h-0 flex-1">
              {selectedPr ? (
                <PrReviewSection target={{ kind: "project", projectId: project.id }} pr={selectedPr} />
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
