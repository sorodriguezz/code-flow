import { ArtifactsList } from "../chat/ArtifactCards";
import { useChatArtifactsStore } from "../../state/chatArtifactsStore";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useCrewPanel } from "../crew/panel/useCrewPanel";
import {
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronRight,
  Clock,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Layers,
  Link2,
  Loader2,
  MessageSquare,
  MessageSquareShare,
  Pencil,
  Search,
  ShieldCheck,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { buttonClass, iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import {
  entryIsGlobal,
  entryIsRunning,
  entryPr,
  entryKey,
  entryRunCount,
  entryTimestamp,
  entryTitle,
  entryVisual,
  isWorkspaceChat,
  mergeActivityEntries,
  WORKSPACE_CHAT_PROJECT,
  type ActivityEntry,
  type PrRowState,
} from "../../lib/activityEntries";
import { shortRepoNames } from "../../lib/repoShortNames";
import type { TranslationKey } from "../../lib/i18n/translations";
import { workspaceActivityKey } from "../../lib/prTarget";
import { moveChatToApp } from "../../lib/moveChatToApp";
import {
  openActivityEntry,
  openAnalysis,
  openChat,
  openJob,
  openTrackedPr,
  openWorkspaceChat,
  tabKeyForJob,
  useChangesToAnalyze,
} from "../../lib/aiPanelNav";
import { usePrStore } from "../../state/prStore";
import { useRepoQueueStore } from "../../lib/repoQueue";
import { InboxNewMenu } from "./PanelTabStrip";
import { ChatModelPicker } from "./ChatModelPicker";
import { EMPTY_JOBS, useJobsStore, type Job } from "../../state/jobsStore";
import { EMPTY_CONVERSATIONS, useChatHistoryStore } from "../../state/activityStore";
import { useWorkspaceChatStore } from "../../state/workspaceChatStore";
import { TreeGuide } from "../common/TreeGuide";
import { EMPTY_LINKS, nestByLineage, parentMap, useChatLineageStore } from "../../state/chatLineageStore";
import type { ChatConversation } from "../../lib/tauri/chatCommands";
import { liveSessionsOf, useChatStore, type ChatSession } from "../../state/chatStore";
import { EMPTY_TRACKED, usePrWatchStore } from "../../state/prWatchStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { chatTabKey, useAiPanelStore, wsChatTabKey, type UnreadMark } from "../../state/aiPanelStore";
import { followTarget } from "../../state/notificationStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { ChatConversationSummary, Project } from "../../types/domain";
import { searchAssistantChats, type AssistantChatHit } from "../../lib/tauri/commands";
import { useRemovedProjects, useRemovedProjectsStore } from "../../state/removedProjectsStore";
import { activitySearchMatch } from "../../lib/activitySearch";

type Filter = "all" | "chat" | "artifacts" | "pr" | "analysis" | "crew";

/** «Equipos»: the workspace's teams and agents, to chat with and to call from here. Its own chunk —
 *  it brings the avatars and the crew's kit, which a panel showing the history never needs. The
 *  count beside its tab comes from `useCrewPanel`, which is only the stores. */
const CrewPanel = lazy(() => import("../crew/panel/CrewPanel").then((m) => ({ default: m.CrewPanel })));
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
  const [chosenScope, setScope] = useState<Scope>("repo");
  // «This repo» is a choice only where there is one to make: more than one repository, one of them
  // open. Anywhere else the list is the workspace's — its own chats included, which belong to no
  // repository. Held at «repo» with no switch drawn, a workspace with one repository or none hid
  // every workspace chat, and closing its tab lost the way back to it (user report, 2026-11-24).
  const canChooseScope = projects.length > 1 && !!activeProject;
  const scope: Scope = canChooseScope ? chosenScope : "workspace";
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
  // Repositories removed from CodeFlow whose chats are kept: the workspace's list shows those chats
  // under the old name, until the user deletes them or the workspace goes.
  const removed = useRemovedProjects(workspaceId);
  const removedInScope = useMemo(() => (scope === "workspace" ? removed : []), [scope, removed]);
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
    void useRemovedProjectsStore.getState().load(workspaceId);
  }, [buckets, scopedProjects, loadJobs, loadHistory, workspaceId]);
  useEffect(() => {
    for (const project of removedInScope) void loadHistory(project.id);
  }, [removedInScope, loadHistory]);
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
      ...removedInScope.flatMap((project) => historyByProject[project.id] ?? EMPTY_CONVERSATIONS),
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
  }, [buckets, jobsByBucket, scope, scopedProjects, removedInScope, historyByProject, workspaceChats, byConversation]);

  const projectName = (id: string) => {
    const live = projects.find((p) => p.id === id);
    if (live) return live.name;
    const gone = removed.find((p) => p.id === id);
    if (!gone) return "";
    return gone.name ? t("assistant.removedRepoNamed", { name: gone.name }) : t("assistant.removedRepo");
  };
  const showRepo = scope === "workspace" && (projects.length > 1 || removedInScope.length > 0);

  // Needs you: pending decisions, then unread results — one row per thing.
  const needs = useMemo(() => {
    const rows: NeedRow[] = [];
    const seen = new Set<string>();
    const marks = Object.entries(unread).filter(([, mark]) => mark.workspaceId === workspaceId);
    // Looked up across everything loaded, not just the Recent scope: "needs you" is the whole
    // workspace's, and the badge on the Inbox tab counts it that way.
    const allJobs = Object.values(jobsByBucket).flat();
    for (const [key, mark] of marks.sort((a, b) => b[1].at - a[1].at)) {
      const row = unreadRow(key, mark, allJobs, historyByProject, byConversation, projectName, t, workspaceId, workspaceChats);
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
  }, [unread, tracked, jobsByBucket, historyByProject, byConversation, workspaceId, projects, workspaceChats]);

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

  const searchedProjects = useMemo(() => [...scopedProjects.map((p) => p.id), ...removedInScope.map((p) => p.id)], [scopedProjects, removedInScope]);
  const searchKey = JSON.stringify([searchedProjects, scope === "workspace" ? workspaceId : null, query.trim()]);
  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    setSearch({ key: searchKey, hits: [], pending: true, error: null });
    const timer = setTimeout(() => {
      void searchAssistantChats(searchedProjects, scope === "workspace" ? workspaceId : null, query.trim())
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

  // A workspace with artifacts and no activity left still has something under «Artefactos».
  const artifactCount = useChatArtifactsStore((s) => (workspaceId ? (s.byWorkspace[workspaceId]?.length ?? 0) : 0));
  /** How many rows each kind holds, of what the search leaves — the numbers on the filter tabs. */
  const kindCounts = useMemo(() => {
    const out: Record<Filter, number> = { all: 0, chat: 0, pr: 0, analysis: 0, artifacts: artifactCount, crew: 0 };
    for (const entry of entries) {
      if (entryIsRunning(entry) || matches.get(entryKey(entry)) === null) continue;
      out[kindOf(entry)] += 1;
    }
    return out;
  }, [entries, matches, artifactCount]);

  useEffect(() => {
    if (workspaceId) void useChatArtifactsStore.getState().loadWorkspace(workspaceId);
  }, [workspaceId]);
  // The teams and agents to talk to from here. They are not history: a workspace that has them
  // shows the tabs — and so the way to them — even before anything has been asked of the assistant.
  const crew = useCrewPanel(workspaceId);
  const hasCrew = crew.teams.length > 0;
  const lang = useLanguageStore((s) => s.language);
  const crewLabel = lang === "es" ? "Equipos" : "Teams";
  const crewTitle = lang === "es" ? "Equipos: conversa con ellos o llámalos desde aquí" : "Teams: chat with them or call them from here";
  const noHistory = needs.length === 0 && running.length === 0 && entries.length === 0 && artifactCount === 0;
  const empty = noHistory && !hasCrew;
  // With nothing else to show, the teams are what there is: the list opens on them.
  const shownFilter: Filter = noHistory && hasCrew && filter === "all" ? "crew" : filter;

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
      {/* One row: the scope, the search, the analysis with its engine, and «Nuevo ▾». It used to be
          three — the scope, a row of «Chat ▾ · Revisar PR ▾ · Analizar cambios ▾», and Recent's
          heading with the search under it — before the first chat showed (user ask, 2026-11-23).
          The search narrows Recent only, as it always did. */}
      <div className="@container flex shrink-0 items-center gap-2 px-3 pb-2 pt-2.5">
        {canChooseScope && activeProject && (
          <Segmented
            size="sm"
            className="shrink-0"
            layoutId={`inbox-scope-${workspaceId}`}
            value={chosenScope}
            onChange={setScope}
            options={[
              { value: "repo", label: t("assistant.scopeRepo"), title: activeProject.name },
              { value: "workspace", label: t("assistant.scopeWorkspace") },
            ]}
          />
        )}
        {empty ? (
          <span className="flex-1" />
        ) : (
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder={t("assistant.search")}
              aria-label={t("assistant.search")}
              // The recipe's padding, with room made on the left for the magnifier — inline, so it
              // wins over the recipe's own `px` without two classes fighting for the edge.
              style={{ paddingLeft: 26 }}
              className={fieldClass({ size: "sm", className: "w-full" })}
            />
          </div>
        )}
        {/* The run and its engine as one control, as the 🛡 in Changes is: the shield analyzes, the
            chevron changes the `analyze` routing — provider, model, account — right here (user: "no
            puedo elegir el modelo ni proveedor, pone la flechita al lado"). Outside «Nuevo ▾»
            because the engine menu opens on top of everything, and inside another menu a click on
            it would close that menu first. */}
        <ChatModelPicker
          task="analyze"
          variant="split"
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
        <InboxNewMenu workspaceId={workspaceId} />
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

      {empty && (
        <p className="px-6 py-10 text-center text-[12px] leading-relaxed text-[var(--cf-text-faint)]">{t("assistant.inboxEmpty")}</p>
      )}

      {!empty && (
        <section className="flex min-h-0 flex-1 flex-col">
          {/* The kinds as tabs, each with how many it holds — «Chats 14 · PRs 3» says at a glance what
              is there, where a row of grey buttons under a «RECIENTE» heading said nothing. */}
          <div role="tablist" aria-label={t("assistant.recent")} className="flex shrink-0 gap-3.5 overflow-x-auto border-b border-[var(--cf-border)] px-3.5 [scrollbar-width:none]">
            {(
              [
                ["all", t("assistant.filterAll")],
                ["chat", t("assistant.filterChats")],
                // Who else there is to talk to: the workspace's teams and agents. Beside «Chats»
                // and not at the end — the strip scrolls in a narrow panel, and the end is what
                // goes out of sight. Drawn with none too: its empty state is the way to make one.
                ["crew", crewLabel],
                ["pr", t("assistant.filterPrs")],
                ["analysis", t("assistant.filterAnalyses")],
                // The workspace's artifacts (`chat_refs::artifacts`), a list of their own rather
                // than a fold above Recent (user, 2026-11-09).
                ["artifacts", t("artifact.title")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={shownFilter === value}
                title={value === "crew" ? crewTitle : undefined}
                aria-label={value === "crew" ? crewLabel : undefined}
                onClick={() => setFilter(value)}
                className={`-mb-px inline-flex shrink-0 items-center gap-1 border-b-2 pb-1.5 pt-1 text-[12px] transition-colors duration-100 ${
                  shownFilter === value
                    ? "border-[var(--cf-accent)] font-semibold text-[var(--cf-text)]"
                    : "border-transparent text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                }`}
              >
                {label}
                {value !== "all" && <span className="text-[11px] font-normal tabular-nums text-[var(--cf-text-faint)]">{value === "crew" ? crew.teams.length : kindCounts[value]}</span>}
              </button>
            ))}
          </div>
          {/* The one part that moves. */}
          <div className="@container min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {shownFilter === "crew" ? (
              <Suspense fallback={null}>
                <CrewPanel workspaceId={workspaceId} query={query} />
              </Suspense>
            ) : shownFilter === "artifacts" ? (
              <ArtifactsList workspaceId={workspaceId} query={query} />
            ) : (
            <>
            {searching &&<p role="status" className="px-1 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("assistant.searchingMessages")}</p>}
            {searchError && (
              <div role="alert" className="flex items-start gap-2 px-1 py-2 text-[12px] text-[var(--cf-danger)]">
                <span className="min-w-0 flex-1 break-words">{t("assistant.searchFailed", { error: searchError })}</span>
                <button onClick={() => setSearchRetry((n) => n + 1)} className="shrink-0 text-[var(--cf-accent)]">{t("turnReview.retry")}</button>
              </div>
            )}
            <RecentList entries={recent} showRepo={showRepo} projectName={projectName} snippets={query.trim() ? matches : undefined} workspaceId={workspaceId} />
            {recent.length === 0 && !searching && !searchError && (
              // Nothing asked of the assistant yet is not a search that found nothing.
              <p className="px-1 py-3 text-center text-[12px] text-[var(--cf-text-faint)]">{noHistory && !query.trim() ? t("assistant.inboxEmpty") : t("ai.noMatches")}</p>
            )}
            {hasMore && (
              <p className="flex items-center justify-center gap-1.5 py-2 text-[12px] text-[var(--cf-text-muted)]">
                <Loader2 size={13} className="animate-spin" />
                {t("ai.loadingOlder")}
              </p>
            )}
            </>
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
  workspaceId: string,
  workspaceChats: ChatConversation[],
): NeedRow {
  const failed = mark.status === "error";
  const dismiss = () => useAiPanelStore.getState().markSeen(key);
  const base = { key, unread: true, dismiss, action: t("assistant.open") };
  // A mark this window cannot name still gets a row: the Inbox tab's badge counts every mark, and
  // one with no row was a number nobody could clear (user report, 2026-11-18). Opening it just
  // marks it seen — there is nothing left to open.
  const unnamed: NeedRow = {
    ...base,
    icon: failed ? AlertCircle : MessageSquare,
    tone: failed ? "danger" : "accent",
    title: t("assistant.newResult"),
    detail: failed ? t("assistant.failed") : "",
    open: dismiss,
  };

  // The workspace chat's answers — `wschat:<conversation>`, filed by `markAssistantUnread`.
  if (key.startsWith("wschat:")) {
    const conversationId = key.slice("wschat:".length);
    const listed = workspaceChats.find((c) => c.id === conversationId);
    return {
      ...base,
      icon: failed ? AlertCircle : MessageSquare,
      tone: failed ? "danger" : "accent",
      title: listed?.title || t("assistant.newChat"),
      detail: failed ? t("assistant.failed") : t("assistant.newReply"),
      open: () => void openWorkspaceChat(mark.workspaceId ?? workspaceId, { conversationId }),
    };
  }

  if (key.startsWith("chat:")) {
    const conversationId = key.slice("chat:".length);
    const session = byConversation[conversationId];
    let stored: ChatConversationSummary | undefined;
    for (const list of Object.values(historyByProject)) {
      stored = list.find((c) => c.session_id === conversationId);
      if (stored) break;
    }
    const projectId = stored?.project_id ?? session?.projectId;
    if (!projectId) return unnamed;
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
  return unnamed;
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

/** A day's heading: «Hoy», «Ayer», or «20 nov» with its weekday beside it. */
function dayLabel(ts: number, t: ReturnType<typeof useT>, locale: string): { day: string; weekday: string | null } {
  const day = new Date(ts);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return { day: t("assistant.today"), weekday: null };
  if (diff === 1) return { day: t("assistant.yesterday"), weekday: null };
  return { day: day.toLocaleDateString(locale, { day: "numeric", month: "short" }), weekday: day.toLocaleDateString(locale, { weekday: "long" }) };
}

function RecentList({
  entries,
  showRepo,
  projectName,
  snippets,
  workspaceId,
}: {
  entries: ActivityEntry[];
  showRepo: boolean;
  projectName: (id: string) => string;
  snippets?: Map<string, string | null>;
  workspaceId: string;
}) {
  const t = useT();
  // The app's language, not the OS's — a Spanish UI prints Spanish dates.
  const locale = useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US";
  const unread = useAiPanelStore((s) => s.unread);
  // Subchats under their chat (`chatLineageStore`), foldable. A subchat whose parent is not in the
  // list (deleted, or out of the filter) stands on its own.
  const links = useChatLineageStore((s) => s.byWorkspace[workspaceId] ?? EMPTY_LINKS);
  useEffect(() => {
    void useChatLineageStore.getState().load(workspaceId);
  }, [workspaceId]);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const nested = useMemo(
    () => nestByLineage(entries, (entry) => (entry.type === "chat" ? entry.conv.session_id : `job:${entryKey(entry)}`), parentMap(links)),
    [entries, links],
  );
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const link of links) out.set(link.parentId, (out.get(link.parentId) ?? 0) + 1);
    return out;
  }, [links]);
  // Every repository the list names, shortened against each other: «DataSync», not
  // «Dev.Agenda.Node.DataSync» — see `shortRepoNames`.
  const sources = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const entry of entries) out.set(entryKey(entry), sourceOf(entry, showRepo, projectName));
    return out;
    // `projectName` reads the projects `showRepo` already follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, showRepo]);
  const short = useMemo(() => shortRepoNames([...sources.values()].filter((name): name is string => !!name)), [sources]);
  // What is drawn: everything but the rows inside a folded parent.
  const visible = useMemo(() => {
    const out: { item: ActivityEntry; depth: number; hasChildren: boolean; isFolded: boolean }[] = [];
    let hiddenBelow = -1;
    for (const row of nested) {
      if (hiddenBelow >= 0 && row.depth > hiddenBelow) continue;
      hiddenBelow = -1;
      const id = row.item.type === "chat" ? row.item.conv.session_id : "";
      const isFolded = row.hasChildren && folded.has(id);
      if (isFolded) hiddenBelow = row.depth;
      out.push({ ...row, isFolded });
    }
    return out;
  }, [nested, folded]);
  /** Whether a row at `depth` has a sibling still to come after index `index`. */
  const continues = (index: number, depth: number) => {
    for (let j = index + 1; j < visible.length; j++) {
      if (visible[j].depth < depth) return false;
      if (visible[j].depth === depth) return true;
    }
    return false;
  };
  // Tree geometry: each level's line runs under the parent's icon (row padding 6 + half a 14px icon).
  const guideX = (level: number) => 13 + (level - 1) * 12;
  let lastDay = "";
  return (
    // The day headings are this list's own children, not wrapped with their first row: a sticky
    // element sticks only within its parent, and the list is the parent that spans the history.
    <div className="space-y-0.5">
      {visible.map(({ item: entry, depth, hasChildren, isFolded }, index) => {
        const id = entry.type === "chat" ? entry.conv.session_id : "";
        // A subchat sits under its parent, wherever its own day falls.
        const label = depth === 0 ? dayLabel(entryTimestamp(entry), t, locale) : null;
        const header = label && label.day !== lastDay ? label : null;
        if (label) lastDay = label.day;
        const ancestors: number[] = [];
        for (let level = 1; level < depth; level++) if (continues(index, level)) ancestors.push(guideX(level));
        const source = sources.get(entryKey(entry)) ?? null;
        return (
          <Fragment key={entryKey(entry)}>
            {header && (
              // Stays at the top while its day scrolls by, so a long history always says which day
              // you are in. It bleeds over the scroller's side padding so rows pass under it whole.
              <p className="sticky top-0 z-[2] -mx-2 flex items-baseline gap-1 bg-[var(--cf-surface)] px-3.5 pb-1 pt-2.5 text-[11px] font-semibold text-[var(--cf-text-muted)]">
                {header.day}
                {header.weekday && <span className="font-normal text-[var(--cf-text-faint)]">· {header.weekday}</span>}
              </p>
            )}
            <div className={depth > 0 ? "relative" : undefined} style={depth > 0 ? { paddingLeft: guideX(depth) + 4 } : undefined}>
              {depth > 0 && <TreeGuide x={guideX(depth)} last={!continues(index, depth)} ancestors={ancestors} bleed={2} />}
              <RecentRow
                entry={entry}
                source={source ? { full: source, short: short.get(source) ?? source } : null}
                unread={!!unreadKeyOf(entry) && !!unread[unreadKeyOf(entry)!]}
                locale={locale}
                snippet={snippets?.get(entryKey(entry)) ?? undefined}
                subchats={
                  hasChildren
                    ? {
                        count: counts.get(id) ?? 0,
                        open: !isFolded,
                        toggle: () =>
                          setFolded((was) => {
                            const next = new Set(was);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          }),
                      }
                    : undefined
                }
              />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The repository a row names, or `null`: in the whole workspace's list only, where rows come from
 * several — except a review from a link, which names its own repository even in «this repo», since
 * it belongs to no repository of the workspace.
 */
function sourceOf(entry: ActivityEntry, showRepo: boolean, projectName: (id: string) => string): string | null {
  const pr = entryPr(entry);
  if (pr?.repo) return pr.repo;
  if (!showRepo || isWorkspaceChat(entry)) return null;
  if (entry.type === "chat") return projectName(entry.conv.project_id) || null;
  return entryIsGlobal(entry) ? null : projectName(entry.job.projectId) || null;
}

/** The tab key an unread mark for this row would be filed under. */
function unreadKeyOf(entry: ActivityEntry): string | null {
  if (entry.type === "chat") return isWorkspaceChat(entry) ? wsChatTabKey(entry.conv.session_id) : chatTabKey(entry.conv.session_id);
  return tabKeyForJob(entry.job);
}

const PR_STATE: Record<PrRowState, { label: TranslationKey; icon: LucideIcon; tone: string }> = {
  reviewed: { label: "inbox.prReviewed", icon: Clock, tone: "var(--cf-text-muted)" },
  approved: { label: "inbox.prApproved", icon: ThumbsUp, tone: "var(--cf-success)" },
  changes: { label: "inbox.prChanges", icon: ThumbsDown, tone: "var(--cf-warning)" },
  closed: { label: "inbox.prClosed", icon: Ban, tone: "var(--cf-danger)" },
};

/** One row of history. Rename and delete happen here — no modal between the list and the action.
 *
 * Laid out by the list's width (`@container`): wide, one line in columns — title, repository, time —
 * so the time sits beside what it dates instead of across the screen and the history fits nearly
 * twice the rows; narrow, the repository drops under the title (user ask, 2026-11-23). The whole
 * row opens the activity: the title's button stretches over it, and the controls on it sit above. */
function RecentRow({
  entry,
  source,
  unread,
  locale,
  snippet,
  subchats,
}: {
  entry: ActivityEntry;
  source: { full: string; short: string } | null;
  unread: boolean;
  locale: string;
  snippet?: string;
  /** The row's subchats, when it has any: how many, and the fold. */
  subchats?: { count: number; open: boolean; toggle: () => void };
}) {
  const t = useT();
  const [mode, setMode] = useState<"idle" | "renaming" | "deleting">("idle");
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const visual = entryVisual(entry);
  const runs = entryRunCount(entry);
  const title = entryTitle(entry);
  const pr = entryPr(entry);
  const workspaceChat = isWorkspaceChat(entry);
  const bucket = entry.type === "job" ? entry.job.projectId : entry.conv.project_id;
  // The kind first, the outcome on top of it: a workspace chat has its own mark, so it need not say
  // «Espacio de trabajo» under every row; a finished PR reads as a PR, its decision in words beside.
  const failed = entry.type === "job" && entry.job.status === "error";
  const { icon: Icon, color } = visual.spinning || failed
    ? visual
    : workspaceChat
      ? { icon: Layers, color: "var(--cf-accent)" }
      : pr
        ? { icon: GitPullRequest, color: "var(--cf-accent)" }
        : visual;

  useEffect(() => {
    if (mode === "renaming") inputRef.current?.select();
  }, [mode]);

  const commitRename = async () => {
    const next = value.trim();
    setMode("idle");
    if (!next || next === title) return;
    if (entry.type === "chat") {
      // A workspace chat's row belongs to its own store, like its delete below.
      if (workspaceChat) await useWorkspaceChatStore.getState().rename(entry.conv.session_id, next);
      else await useChatHistoryStore.getState().rename(bucket, entry.conv.session_id, next);
      return;
    }
    await useJobsStore.getState().rename(bucket, entry.job.id, next);
  };

  const remove = async () => {
    setMode("idle");
    if (entry.type === "chat") {
      if (workspaceChat) {
        // Its own store owns the row, the tab and the transcript.
        if (await useWorkspaceChatStore.getState().remove(entry.conv.session_id)) {
          useChatLineageStore.getState().dropLocal(entry.conv.session_id);
        }
        return;
      }
      // Both halves at once: the persisted list and this session's memory — and the tab, since a
      // deleted conversation has nothing left to show.
      useChatStore.getState().discard(entry.conv.session_id);
      useAiPanelStore.getState().close(chatTabKey(entry.conv.session_id));
      await useChatHistoryStore.getState().remove(bucket, entry.conv.session_id);
      // The backend moved its subchats up a level; so does the copy here.
      useChatLineageStore.getState().dropLocal(entry.conv.session_id);
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

  const time = new Date(entryTimestamp(entry)).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const state = pr?.state ? PR_STATE[pr.state] : null;
  const action = "relative z-[1] inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]";
  return (
    <div className="group relative grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-px rounded-lg px-1.5 py-1 hover:bg-[var(--cf-hover)] @[34rem]:grid-cols-[14px_minmax(0,1fr)_minmax(0,11rem)_4.25rem]">
      {unread && (
        <span
          className="absolute left-0 top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-[var(--cf-accent-fill)]"
          aria-label={t("assistant.unread")}
        />
      )}
      <Icon size={14} className="row-span-2 mt-[3px] self-start @[34rem]:row-span-1 @[34rem]:mt-0 @[34rem]:self-center" style={{ color }} />
      <span className="col-start-2 row-start-1 min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          {pr && <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text-muted)]">#{pr.id}</span>}
          <button
            onClick={() => void openActivityEntry(entry)}
            title={title}
            // Stretched over the whole row: a click anywhere on it opens the activity.
            className="min-w-0 truncate text-left text-[13px] text-[var(--cf-text)] after:absolute after:inset-0 after:rounded-lg after:content-['']"
          >
            {pr ? pr.title : title}
          </button>
          {runs > 1 && (
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]" title={t("ai.runCount", { n: runs })}>
              ×{runs}
            </span>
          )}
          {state && (
            <span
              className="hidden shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10.5px] font-semibold @[34rem]:inline-flex"
              style={{ color: state.tone, background: `color-mix(in oklab, ${state.tone} 12%, transparent)` }}
            >
              <state.icon size={10} />
              {t(state.label)}
            </span>
          )}
          {subchats && (
            // Beside the title it counts, not by the time at the far edge.
            <button
              onClick={subchats.toggle}
              aria-expanded={subchats.open}
              title={subchats.open ? t("assistant.subchatsHide") : t("assistant.subchatsShow")}
              aria-label={subchats.open ? t("assistant.subchatsHide") : t("assistant.subchatsShow")}
              className="relative z-[1] inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-[5px] px-1 text-[11px] tabular-nums text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)] hover:text-[var(--cf-text)]"
            >
              <GitBranch size={10} />
              {subchats.count}
              {subchats.open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
          )}
        </span>
        {snippet && <span className="block truncate text-[11px] text-[var(--cf-text-muted)]" title={snippet}>{snippet}</span>}
      </span>
      {source ? (
        <span
          title={source.full}
          className="col-start-2 row-start-2 inline-flex min-w-0 max-w-full items-center gap-1 justify-self-start truncate text-[11px] text-[var(--cf-text-muted)] @[34rem]:col-start-3 @[34rem]:row-start-1 @[34rem]:rounded-full @[34rem]:bg-[var(--cf-hover)] @[34rem]:px-1.5 @[34rem]:py-px"
        >
          <FolderGit2 size={10} className="shrink-0" />
          <span className="truncate">{source.short}</span>
        </span>
      ) : (
        workspaceChat && (
          <span className="col-start-2 row-start-2 text-[11px] text-[var(--cf-text-faint)] @[34rem]:col-start-3 @[34rem]:row-start-1">
            {t("inbox.workspaceShort")}
          </span>
        )
      )}
      <span className="col-start-3 row-start-1 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)] group-hover:invisible @[34rem]:col-start-4">
        {time}
      </span>
      <span className="absolute right-1.5 top-1/2 z-[1] hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-[var(--cf-surface-raised)] p-0.5 shadow-[0_0_0_1px_var(--cf-border)] group-hover:flex">
        <button
          onClick={() => {
            setValue(title);
            setMode("renaming");
          }}
          title={t("ai.rename")}
          aria-label={t("ai.rename")}
          className={`${action} hover:text-[var(--cf-accent)]`}
        >
          <Pencil size={13} />
        </button>
        {/* A repository conversation can move to the chat workspace, for good. A workspace chat has
            no repository to move out of. */}
        {entry.type === "chat" && !workspaceChat && (
          <button
            onClick={() => void moveChatToApp(bucket, entry.conv.session_id)}
            title={t("assistant.moveToChat")}
            aria-label={t("assistant.moveToChat")}
            className={`${action} hover:text-[var(--cf-accent)]`}
          >
            <MessageSquareShare size={13} />
          </button>
        )}
        <button
          onClick={() => setMode("deleting")}
          title={t("chatHistory.delete")}
          aria-label={t("chatHistory.delete")}
          className={`${action} hover:text-[var(--cf-danger)]`}
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

