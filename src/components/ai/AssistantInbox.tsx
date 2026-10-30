import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Clock,
  GitPullRequest,
  Globe,
  Link2,
  Loader2,
  MessageSquare,
  MessageSquareShare,
  Pencil,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { buttonClass, iconButtonClass } from "../common/Button";
import { chipClass, fieldClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import {
  entryIsGlobal,
  entryIsRunning,
  entryKey,
  entryRunCount,
  entryTimestamp,
  entryTitle,
  entryVisual,
  isWorkspaceChat,
  mergeActivityEntries,
  WORKSPACE_CHAT_PROJECT,
  type ActivityEntry,
} from "../../lib/activityEntries";
import { workspaceActivityKey } from "../../lib/prTarget";
import { moveChatToApp } from "../../lib/moveChatToApp";
import {
  openActivityEntry,
  openAnalysis,
  openChat,
  openJob,
  openTrackedPr,
  tabKeyForJob,
  useChangesToAnalyze,
} from "../../lib/aiPanelNav";
import { usePrStore } from "../../state/prStore";
import { useRepoQueueStore } from "../../lib/repoQueue";
import { NewChatMenu, ReviewPrMenu } from "./PanelTabStrip";
import { ChatModelPicker } from "./ChatModelPicker";
import { EMPTY_JOBS, useJobsStore, type Job } from "../../state/jobsStore";
import { EMPTY_CONVERSATIONS, useChatHistoryStore } from "../../state/activityStore";
import { useWorkspaceChatStore } from "../../state/workspaceChatStore";
import type { ChatConversation } from "../../lib/tauri/chatCommands";
import { liveSessionsOf, useChatStore, type ChatSession } from "../../state/chatStore";
import { EMPTY_TRACKED, usePrWatchStore } from "../../state/prWatchStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { chatTabKey, useAiPanelStore, type UnreadMark } from "../../state/aiPanelStore";
import { followTarget } from "../../state/notificationStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { translate, useLanguageStore, useT } from "../../state/languageStore";
import type { ChatConversationSummary, Project } from "../../types/domain";
import { searchAssistantChats, type AssistantChatHit } from "../../lib/tauri/commands";
import { activitySearchMatch } from "../../lib/activitySearch";

type Filter = "all" | "chat" | "pr" | "analysis";
type Scope = "repo" | "workspace";

const EMPTY_PROJECTS: Project[] = [];
/** Stable empty, so a workspace with no chats of its own does not re-render the list every tick. */
const EMPTY_WS_CHATS: ChatConversation[] = [];

/**
 * The assistant's Inbox — the first tab, and the one place that answers "what is the AI doing, and
 * what is waiting for me" for this workspace.
 *
 * It replaces three lists that answered overlapping questions from different corners of the panel:
 * "waiting on you" (a collapsible above everything), Activity (collapsed by default, five rows) and
 * the "view all" modal that covered the panel it controlled. Here they are three sections of one
 * page, in the order they matter:
 *
 * - **Needs you** — pull requests waiting on a decision, and results that landed while you were
 *   looking at something else (the unread marks), failures included.
 * - **Running** — every assistant run of this workspace, from the same registry the status bar
 *   reads, with the queue behind a busy repository made visible.
 * - **Recent** — the history, grouped by day, searchable, filterable; rename and delete happen on
 *   the row.
 *
 * Opening any row goes through `aiPanelNav`, the one implementation of "open this".
 */
export function AssistantInbox({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const projects = useWorkspaceStore((s) => s.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const changes = useChangesToAnalyze(activeProject?.id ?? null);
  const [scope, setScope] = useState<Scope>("repo");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ key: string; hits: AssistantChatHit[]; pending: boolean; error: string | null }>({
    key: "", hits: [], pending: false, error: null,
  });
  const [searchRetry, setSearchRetry] = useState(0);
  const scopedProjects = useMemo(
    () => (scope === "workspace" || !activeProject ? projects : [activeProject]),
    [scope, activeProject, projects],
  );
  const workspaceBucket = workspaceActivityKey(workspaceId);
  const buckets = useMemo(() => [...scopedProjects.map((p) => p.id), workspaceBucket], [scopedProjects, workspaceBucket]);

  // ── Loading ───────────────────────────────────────────────────────────────────────────────
  const loadJobs = useJobsStore((s) => s.load);
  const loadHistory = useChatHistoryStore((s) => s.load);
  const loadWatch = usePrWatchStore((s) => s.load);
  useEffect(() => {
    for (const bucket of buckets) void loadJobs(bucket);
    for (const project of scopedProjects) void loadHistory(project.id);
    // The workspace's own chats, which belong to no repository and are therefore in none of the
    // buckets above — see `WORKSPACE_CHAT_PROJECT`.
    void useWorkspaceChatStore.getState().loadList(workspaceId);
  }, [buckets, scopedProjects, loadJobs, loadHistory, workspaceId]);
  useEffect(() => {
    void loadWatch(workspaceId);
  }, [workspaceId, loadWatch]);

  // ── Data ──────────────────────────────────────────────────────────────────────────────────
  const jobsByBucket = useJobsStore((s) => s.byProject);
  const hasMore = useJobsStore((s) => buckets.some((b) => s.hasMore[b] === true));
  const historyByProject = useChatHistoryStore((s) => s.byProject);
  const workspaceChats = useWorkspaceChatStore((s) => s.listByWorkspace[workspaceId] ?? EMPTY_WS_CHATS);
  const byConversation = useChatStore((s) => s.byConversation);
  const tracked = usePrWatchStore((s) => s.byWorkspace[workspaceId] ?? EMPTY_TRACKED);
  const unread = useAiPanelStore((s) => s.unread);

  const entries = useMemo(() => {
    const jobs: Job[] = buckets.flatMap((bucket) => jobsByBucket[bucket] ?? EMPTY_JOBS);
    const conversations: ChatConversationSummary[] = [
      ...scopedProjects.flatMap((project) => historyByProject[project.id] ?? EMPTY_CONVERSATIONS),
      // The workspace's own, as the same row shape — and only in the workspace scope: «this repo»
      // is a question about a repository, and a chat that belongs to none is not an answer to it.
      // `turn_count` is not kept for these (the list they come from is the sidebar's, which counts
      // nothing) and a chat row does not draw it.
      ...(scope === "workspace" ? workspaceChats : []).map((row) => ({
        session_id: row.id,
        project_id: WORKSPACE_CHAT_PROJECT,
        title: row.title,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        turn_count: 0,
      })),
    ];
    const live: ChatSession[] = scopedProjects.flatMap((project) => liveSessionsOf(byConversation, project.id));
    return mergeActivityEntries(jobs, conversations, live);
  }, [buckets, jobsByBucket, scope, scopedProjects, historyByProject, workspaceChats, byConversation]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
  const showRepo = scope === "workspace" && projects.length > 1;

  // Needs you: pending decisions, then unread results — one row per thing.
  const needs = useMemo(() => {
    const rows: NeedRow[] = [];
    const seen = new Set<string>();
    const marks = Object.entries(unread).filter(([, mark]) => mark.workspaceId === workspaceId);
    // Looked up across everything loaded, not just the Recent scope: "needs you" is the whole
    // workspace's, and the badge on the Inbox tab counts it that way.
    const allJobs = Object.values(jobsByBucket).flat();
    for (const [key, mark] of marks.sort((a, b) => b[1].at - a[1].at)) {
      const row = unreadRow(key, mark, allJobs, historyByProject, byConversation, projectName, t);
      if (!row) continue;
      seen.add(key);
      rows.push(row);
    }
    for (const pr of tracked) {
      const key = pr.kind === "link" && pr.url ? `prlink:${pr.url}` : pr.projectId ? `pr:${pr.projectId}:${pr.prId}` : null;
      if (!key || seen.has(key)) continue;
      rows.push({
        key,
        icon: pr.kind === "link" ? Link2 : GitPullRequest,
        tone: "accent",
        title: `#${pr.prId} ${pr.title}`,
        detail: [
          pr.kind === "link" ? pr.repoLabel : projects.length > 1 && pr.projectId ? projectName(pr.projectId) : null,
          pr.decision === "changes_requested"
            ? t("pr.pendingChangesRequested")
            : pr.reviewed
              ? t("assistant.waitingDecision")
              : t("pr.pendingUnreviewed"),
        ]
          .filter(Boolean)
          .join(" · "),
        action: pr.reviewed || pr.decision === "changes_requested" ? t("assistant.open") : t("assistant.review"),
        open: () => void openTrackedPr(pr),
        dismiss: () => usePrWatchStore.getState().untrack(workspaceId, pr.key),
      });
    }
    return rows;
    // `projectName` and `t` read state that the other dependencies already cover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread, tracked, jobsByBucket, historyByProject, byConversation, workspaceId, projects]);

  // Running: the same registry the status bar reads, narrowed to this workspace's assistant work.
  const runs = useAiRunStore((s) => s.active);
  const about = useAiRunStore((s) => s.aboutByRun);
  const queuedRuns = useRepoQueueStore((s) => s.queued);
  const running = useMemo(
    () =>
      Object.keys(runs)
        .filter((id) => runs[id] && about[id]?.target?.openAiPanel && about[id]?.workspaceId === workspaceId)
        .map((id) => ({ id, about: about[id]!, queued: queuedRuns[id] ?? null })),
    [runs, about, queuedRuns, workspaceId],
  );

  const searchKey = JSON.stringify([scopedProjects.map((p) => p.id), scope === "workspace" ? workspaceId : null, query.trim()]);
  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    setSearch({ key: searchKey, hits: [], pending: true, error: null });
    const timer = setTimeout(() => {
      void searchAssistantChats(scopedProjects.map((p) => p.id), scope === "workspace" ? workspaceId : null, query.trim())
        .then((hits) => { if (!cancelled) setSearch({ key: searchKey, hits, pending: false, error: null }); })
        .catch((error: unknown) => { if (!cancelled) setSearch({ key: searchKey, hits: [], pending: false, error: String(error) }); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // The key includes query and scope; changes to the loaded history re-run a live search too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, entries, searchRetry]);
  const searching = !!query.trim() && (search.key !== searchKey || search.pending);
  const searchError = query.trim() && search.key === searchKey ? search.error : null;
  const matches = useMemo(() => new Map(entries.map((entry) => [entryKey(entry), activitySearchMatch(
    entry, query, search.key === searchKey ? search.hits : [],
  )])), [entries, query, search, searchKey]);
  const recent = useMemo(() => {
    return entries.filter((entry) => {
      if (entryIsRunning(entry)) return false;
      if (filter !== "all" && kindOf(entry) !== filter) return false;
      return matches.get(entryKey(entry)) !== null;
    });
  }, [entries, filter, matches]);

  const empty = needs.length === 0 && running.length === 0 && entries.length === 0;

  return (
    // Three bands, and only the history scrolls. The scope and the actions, the live rows and
    // Recent's heading with its search box and filters stay put; this used to be one scroller, so
    // going down a long history carried the search and the filters away with it — the two things
    // you want in hand exactly then (user report).
    <div className="flex h-full flex-col">
      {/* The scope leads. "This repo or the whole workspace" is a bigger choice than any action or
          filter under it, so it sits above them all (it narrows Recent only — what needs you and
          what is running are the whole workspace's either way). It is also drawn whatever the
          history holds: at the end of Recent's heading it went away with the heading whenever there
          was nothing to list, so a repository with no activity left you on "This repo", looking at
          nothing, with no way back to a workspace that had plenty (user report). With one
          repository, or none open, both would show the same list, so there is nothing to choose. */}
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-1 pt-3">
        {projects.length > 1 && activeProject && (
          <Segmented
            size="sm"
            className="self-start"
            layoutId={`inbox-scope-${workspaceId}`}
            value={scope}
            onChange={setScope}
            options={[
              { value: "repo", label: t("assistant.scopeRepo"), title: activeProject.name },
              { value: "workspace", label: t("assistant.scopeWorkspace") },
            ]}
          />
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* One door to both chats: this repository, or every repository of the workspace and the
              agents' work in flight — asked on click. */}
          <NewChatMenu
            workspaceId={workspaceId}
            project={activeProject ?? null}
            disabled={!activeProject && projects.length === 0}
          />
          {activeProject && <ReviewPrMenu projectId={activeProject.id} variant="button" />}
          {/* The run and its engine as one button, as the 🛡 in Changes is: the words analyze, the
              chevron changes the `analyze` routing — provider, model, account — right here (user:
              "no puedo elegir el modelo ni proveedor, pone la flechita al lado"). The chevron works
              with nothing to analyze, too: choosing the engine first is a fair order. */}
          <ChatModelPicker
            task="analyze"
            variant="button"
            liveModel={null}
            chatActive={false}
            title={t("changes.analyzeModelHint")}
            action={{
              icon: <ShieldCheck size={13} />,
              label: t("assistant.analyze"),
              disabled: !activeProject || changes === 0,
              title: changes === 0 ? t("analyze.nothingToAnalyze") : undefined,
              onClick: () => activeProject && openAnalysis(activeProject.id, { run: true }),
            }}
          />
        </div>
      </div>

      {(needs.length > 0 || running.length > 0) && (
        // Capped, so a pile of pending decisions can never squeeze Recent out of the panel — past the
        // cap this band scrolls on its own.
        <div className="max-h-[45%] shrink-0 overflow-y-auto px-2">
          {needs.length > 0 && (
            <section>
              <SectionLabel label={t("assistant.needsYou")} count={needs.length} />
              {needs.map((row) => (
                <NeedsRow key={row.key} row={row} />
              ))}
            </section>
          )}

          {running.length > 0 && (
            <section>
              <SectionLabel label={t("assistant.running")} count={running.length} />
              {running.map((run) => (
                <RunningRow key={run.id} runId={run.id} workspaceId={workspaceId} about={run.about} queued={run.queued} />
              ))}
            </section>
          )}
        </div>
      )}

      {!empty && (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-2">
            {/* Still as tall as the scope toggle that sat at its end, so moving the toggle to the top
                left this heading and the search box under it where they were. */}
            <div className="flex min-h-[26px] items-center">
              <SectionLabel label={t("assistant.recent")} />
            </div>
            <div className="space-y-1.5 px-0.5 pb-1">
              <div className="relative">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  placeholder={t("assistant.search")}
                  aria-label={t("assistant.search")}
                  // The recipe's padding, with room made on the left for the magnifier — inline, so
                  // it wins over the recipe's own `px` without two classes fighting for the edge.
                  style={{ paddingLeft: 26 }}
                  className={fieldClass({ size: "sm", className: "w-full" })}
                />
              </div>
              <div className="flex flex-wrap gap-1" role="group">
                {(
                  [
                    ["all", t("assistant.filterAll")],
                    ["chat", t("assistant.filterChats")],
                    ["pr", t("assistant.filterPrs")],
                    ["analysis", t("assistant.filterAnalyses")],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setFilter(value)}
                    aria-pressed={filter === value}
                    className={
                      filter === value
                        ? chipClass("accent")
                        : chipClass("neutral", "transition-colors duration-100 hover:text-[var(--cf-text)]")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {/* The one part that moves. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {searching && <p role="status" className="px-1 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("assistant.searchingMessages")}</p>}
            {searchError && (
              <div role="alert" className="flex items-start gap-2 px-1 py-2 text-[12px] text-[var(--cf-danger)]">
                <span className="min-w-0 flex-1 break-words">{t("assistant.searchFailed", { error: searchError })}</span>
                <button onClick={() => setSearchRetry((n) => n + 1)} className="shrink-0 text-[var(--cf-accent)]">{t("turnReview.retry")}</button>
              </div>
            )}
            <RecentList entries={recent} showRepo={showRepo} projectName={projectName} snippets={query.trim() ? matches : undefined} />
            {recent.length === 0 && !searching && !searchError && (
              <p className="px-1 py-3 text-center text-[12px] text-[var(--cf-text-faint)]">{t("ai.noMatches")}</p>
            )}
            {hasMore && (
              <p className="flex items-center justify-center gap-1.5 py-2 text-[12px] text-[var(--cf-text-muted)]">
                <Loader2 size={13} className="animate-spin" />
                {t("ai.loadingOlder")}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function kindOf(entry: ActivityEntry): Filter {
  if (entry.type === "chat") return "chat";
  if (entry.job.kind === "analyze-changes") return "analysis";
  if (entry.job.kind === "pr-review" || entry.job.kind === "pr-action") return "pr";
  return "all";
}

interface NeedRow {
  key: string;
  icon: typeof GitPullRequest;
  tone: "accent" | "danger" | "success";
  title: string;
  detail: string;
  action: string;
  open: () => void;
  dismiss?: () => void;
  unread?: boolean;
}

/**
 * An unread mark as a row, named from whatever this window holds about it — and still a row when it
 * holds nothing (a result from before a restart, in a repository whose history is not loaded): the
 * mark alone says what kind of thing it is and where it lives, which is enough to open it.
 */
function unreadRow(
  key: string,
  mark: UnreadMark,
  allJobs: Job[],
  historyByProject: Record<string, ChatConversationSummary[]>,
  byConversation: Record<string, ChatSession>,
  projectName: (id: string) => string,
  t: ReturnType<typeof useT>,
): NeedRow | null {
  const failed = mark.status === "error";
  const dismiss = () => useAiPanelStore.getState().markSeen(key);
  const base = { key, unread: true, dismiss, action: t("assistant.open") };

  if (key.startsWith("chat:")) {
    const conversationId = key.slice("chat:".length);
    const session = byConversation[conversationId];
    let stored: ChatConversationSummary | undefined;
    for (const list of Object.values(historyByProject)) {
      stored = list.find((c) => c.session_id === conversationId);
      if (stored) break;
    }
    const projectId = stored?.project_id ?? session?.projectId;
    if (!projectId) return null;
    return {
      ...base,
      icon: failed ? AlertCircle : MessageSquare,
      tone: failed ? "danger" : "accent",
      title: stored?.title || session?.title || t("assistant.newChat"),
      detail: [projectName(projectId), failed ? t("assistant.failed") : t("assistant.newReply")].filter(Boolean).join(" · "),
      open: () => void openChat(projectId, conversationId),
    };
  }

  // The newest run behind the tab this mark is filed under.
  const job = allJobs
    .filter((candidate) => tabKeyForJob(candidate) === key)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const analysis = key.startsWith("analysis:");
  const detail = failed ? t("assistant.failed") : t("assistant.newResult");
  if (job) {
    return {
      ...base,
      icon: failed ? AlertCircle : analysis ? ShieldCheck : GitPullRequest,
      tone: failed ? "danger" : analysis ? "success" : "accent",
      title: analysis ? `${job.label} · ${projectName(job.projectId)}` : job.label,
      detail,
      open: () => void openJob(job),
    };
  }
  if (analysis) {
    const projectId = key.slice("analysis:".length);
    return {
      ...base,
      icon: failed ? AlertCircle : ShieldCheck,
      tone: failed ? "danger" : "success",
      title: `${t("analyze.title")} · ${projectName(projectId)}`,
      detail,
      open: () => openAnalysis(projectId),
    };
  }
  const pr = key.match(/^pr:(.+):(\d+)$/);
  if (pr) {
    const [, projectId, number] = pr;
    return {
      ...base,
      icon: failed ? AlertCircle : GitPullRequest,
      tone: failed ? "danger" : "accent",
      title: `#${number} · ${projectName(projectId)}`,
      detail,
      open: () =>
        void usePrStore
          .getState()
          .ensureProjectPr(projectId, Number(number))
          .then((found) => found && useAiPanelStore.getState().open({ kind: "pr", projectId, pr: found })),
    };
  }
  return null;
}

const TONES = {
  accent: "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]",
  danger: "bg-[color-mix(in_oklab,var(--cf-danger)_14%,transparent)] text-[var(--cf-danger)]",
  success: "bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] text-[var(--cf-success)]",
} as const;

function NeedsRow({ row }: { row: NeedRow }) {
  const t = useT();
  const Icon = row.icon;
  return (
    <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-[var(--cf-hover)]">
      <button onClick={row.open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${TONES[row.tone]}`}>
          <Icon size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--cf-text)]">{row.title}</span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{row.detail}</span>
        </span>
        {row.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cf-accent-fill)]" aria-label={t("assistant.unread")} />}
      </button>
      <button
        onClick={row.open}
        className={buttonClass({ variant: "secondary", size: "sm" })}
      >
        {row.action}
      </button>
      {row.dismiss && (
        <Tooltip label={t("assistant.dismiss")}>
          <button
            onClick={row.dismiss}
            aria-label={t("assistant.dismiss")}
            className={iconButtonClass({
              size: "xs",
              className: "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
            })}
          >
            <X size={13} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function RunningRow({
  runId,
  workspaceId,
  about,
  queued,
}: {
  runId: string;
  workspaceId: string;
  about: NonNullable<ReturnType<typeof useAiRunStore.getState>["aboutByRun"][string]>;
  queued: { holder: string | null } | null;
}) {
  const t = useT();
  const cancel = useAiRunStore((s) => s.cancel);
  const cancelling = useAiRunStore((s) => s.cancelling[runId] ?? false);
  const open = () => {
    if (about.target) void followTarget(workspaceId, about.target);
  };
  return (
    <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-[var(--cf-hover)]">
      <button onClick={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">
          {queued ? <Clock size={14} className="text-[var(--cf-warning)]" /> : <ThinkingOrb size="sm" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--cf-text)]">{about.detail || t(about.kindKey)}</span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
            {queued
              ? queued.holder
                ? t("assistant.queuedBehind", { holder: queued.holder })
                : t("assistant.queuedUnknown")
              : t(about.kindKey)}
          </span>
        </span>
      </button>
      <button
        onClick={() => void cancel(runId)}
        disabled={cancelling}
        title={t("ai.stopRun")}
        aria-label={t("ai.stopRun")}
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-[var(--cf-text-muted)] opacity-0 shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:text-[var(--cf-danger)] hover:shadow-[inset_0_0_0_1px_var(--cf-danger)] focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100"
      >
        <Square size={9} className="fill-current" />
        {cancelling ? t("ai.stopping") : t("ai.stop")}
      </button>
    </div>
  );
}

function dayLabel(ts: number, t: ReturnType<typeof useT>, locale: string): string {
  const day = new Date(ts);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return t("assistant.today");
  if (diff === 1) return t("assistant.yesterday");
  return day.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

function RecentList({
  entries,
  showRepo,
  projectName,
  snippets,
}: {
  entries: ActivityEntry[];
  showRepo: boolean;
  projectName: (id: string) => string;
  snippets?: Map<string, string | null>;
}) {
  const t = useT();
  // The app's language, not the OS's — a Spanish UI prints Spanish dates.
  const locale = useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US";
  let lastDay = "";
  return (
    <div className="space-y-0.5">
      {entries.map((entry) => {
        const day = dayLabel(entryTimestamp(entry), t, locale);
        const header = day !== lastDay ? day : null;
        lastDay = day;
        return (
          <div key={entryKey(entry)}>
            {header && <p className="px-1.5 pb-1 pt-2 text-[11px] font-semibold text-[var(--cf-text-faint)]">{header}</p>}
            <RecentRow entry={entry} repo={showRepo ? projectOf(entry, projectName) : null} snippet={snippets?.get(entryKey(entry)) ?? undefined} />
          </div>
        );
      })}
    </div>
  );
}

function projectOf(entry: ActivityEntry, projectName: (id: string) => string): string | null {
  // Named after the workspace rather than left blank: a row with no sub-label in a list where every
  // other row has one reads as a chat whose repository could not be found.
  if (isWorkspaceChat(entry)) return translate("inbox.workspaceChat");
  if (entry.type === "chat") return projectName(entry.conv.project_id) || null;
  return entryIsGlobal(entry) ? null : projectName(entry.job.projectId) || null;
}

/** One row of history. Rename and delete happen here — no modal between the list and the action. */
function RecentRow({ entry, repo, snippet }: { entry: ActivityEntry; repo: string | null; snippet?: string }) {
  const t = useT();
  const [mode, setMode] = useState<"idle" | "renaming" | "deleting">("idle");
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { icon: Icon, color } = entryVisual(entry);
  const runs = entryRunCount(entry);
  const title = entryTitle(entry);
  const bucket = entry.type === "job" ? entry.job.projectId : entry.conv.project_id;

  useEffect(() => {
    if (mode === "renaming") inputRef.current?.select();
  }, [mode]);

  const commitRename = async () => {
    const next = value.trim();
    setMode("idle");
    if (!next || next === title) return;
    if (entry.type === "chat") {
      // A workspace chat's row belongs to its own store, like its delete below.
      if (isWorkspaceChat(entry)) await useWorkspaceChatStore.getState().rename(entry.conv.session_id, next);
      else await useChatHistoryStore.getState().rename(bucket, entry.conv.session_id, next);
      return;
    }
    await useJobsStore.getState().rename(bucket, entry.job.id, next);
  };

  const remove = async () => {
    setMode("idle");
    if (entry.type === "chat") {
      if (isWorkspaceChat(entry)) {
        // Its own store owns the row, the tab and the transcript.
        await useWorkspaceChatStore.getState().remove(entry.conv.session_id);
        return;
      }
      // Both halves at once: the persisted list and this session's memory — and the tab, since a
      // deleted conversation has nothing left to show.
      useChatStore.getState().discard(entry.conv.session_id);
      useAiPanelStore.getState().close(chatTabKey(entry.conv.session_id));
      await useChatHistoryStore.getState().remove(bucket, entry.conv.session_id);
      return;
    }
    // A job row owns every run of that activity — they all go, not just the newest.
    await Promise.all(entry.runs.map((job) => useJobsStore.getState().remove(job.projectId, job.id)));
  };

  if (mode === "renaming") {
    return (
      <div className="flex items-center gap-2 rounded-lg px-1.5 py-1">
        <Icon size={13} className="shrink-0" style={{ color }} />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            else if (e.key === "Escape") setMode("idle");
          }}
          aria-label={t("ai.rename")}
          className={fieldClass({ size: "sm", className: "flex-1" })}
        />
      </div>
    );
  }

  if (mode === "deleting") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] px-1.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--cf-text)]">
          {runs > 1 ? t("assistant.deleteWithRuns", { n: runs }) : t("assistant.deleteOne")}
        </span>
        <button onClick={() => setMode("idle")} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("common.cancel")}
        </button>
        <button onClick={() => void remove()} className={buttonClass({ variant: "danger", size: "sm" })}>
          {t("chatHistory.delete")}
        </button>
      </div>
    );
  }

  const time = new Date(entryTimestamp(entry)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-[var(--cf-hover)]">
      <button onClick={() => void openActivityEntry(entry)} title={title} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon size={14} className="shrink-0" style={{ color }} />
        {entryIsGlobal(entry) && <Globe size={12} className="shrink-0 text-[var(--cf-text-muted)]" aria-label={t("activity.workspaceWide")} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-[var(--cf-text)]">{title}</span>
          {snippet && <span className="block truncate text-[11px] text-[var(--cf-text-muted)]" title={snippet}>{snippet}</span>}
          {(repo || runs > 1) && (
            <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
              {[repo, runs > 1 ? t("ai.runCount", { n: runs }) : null].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)] group-hover:hidden">{time}</span>
      </button>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          onClick={() => {
            setValue(title);
            setMode("renaming");
          }}
          title={t("ai.rename")}
          aria-label={t("ai.rename")}
          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-accent)]"
        >
          <Pencil size={13} />
        </button>
        {/* A repository conversation can move to the chat workspace, for good. A workspace chat has
            no repository to move out of. */}
        {entry.type === "chat" && !isWorkspaceChat(entry) && (
          <button
            onClick={() => void moveChatToApp(bucket, entry.conv.session_id)}
            title={t("assistant.moveToChat")}
            aria-label={t("assistant.moveToChat")}
            className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-accent)]"
          >
            <MessageSquareShare size={13} />
          </button>
        )}
        <button
          onClick={() => setMode("deleting")}
          title={t("chatHistory.delete")}
          aria-label={t("chatHistory.delete")}
          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  );
}

function SectionLabel({ label, count }: { label: string; count?: number }) {
  return (
    <p className="flex items-center gap-1.5 px-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
      {label}
      {count !== undefined && <span className="tabular-nums tracking-normal">{count}</span>}
    </p>
  );
}

