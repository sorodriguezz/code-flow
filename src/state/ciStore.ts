import { create } from "zustand";
import * as api from "../lib/tauri/commands";
import { notify } from "./notificationStore";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { JobLog, PipelineJob, PipelineRun, PipelineRunDetail } from "../types/domain";

/**
 * The Pipelines tab's state: runs, their jobs, their logs, and the polling that keeps the live
 * ones live.
 *
 * Two things about this store are worth reading before changing it.
 *
 * **Everything is keyed by more than an id.** A run number repeats across repositories exactly the
 * way a pull request's `#42` does — `prStore` documents that bug at length after a `#42` in one
 * repository lit up the `#42` in another — and with three providers in play it is worse: a GitLab
 * pipeline id and an Azure build id are both small integers from the same range. So every map in
 * here is keyed by [`runKey`], which carries the project and the provider as well.
 *
 * **The polling is the only one of its kind in this app.** Pull requests are not polled at all;
 * they are fetched when you unfold the section and when you press refresh. A CI screen cannot work
 * that way — the whole point is watching something finish — so this is the first thing in CodeFlow
 * that repeatedly hits a third-party API on a timer. It is therefore also the first that can
 * plausibly exhaust a rate limit, which is why the cadence drops when nothing is running, stops
 * entirely when the window isn't visible, and backs off geometrically per project after a failure.
 */

/** `${projectId}:${provider}:${runId}` — see the note above about `#42`. */
export function runKey(projectId: string, run: Pick<PipelineRun, "provider" | "id">): string {
  return `${projectId}:${run.provider}:${run.id}`;
}

/** The same, for a job inside a run. */
function jobKey(projectId: string, job: Pick<PipelineJob, "provider" | "run_id" | "id">): string {
  return `${projectId}:${job.provider}:${job.run_id}:${job.id}`;
}

/** How the run's structure was worked out, so the panel can say. See `pipelineGraph.ts`. */
export type GraphMode = "graph" | "waterfall";

interface Selection {
  projectId: string;
  runId: string;
  provider: PipelineRun["provider"];
  /** `null` while the detail is still loading and no job has been chosen yet. */
  jobId: string | null;
}

interface CiState {
  /** Newest first, as the host returned them. */
  runsByProject: Record<string, PipelineRun[]>;
  /** Which project's list is in flight — one at a time, since only one repository is on screen. */
  loadingProjectId: string | null;
  /** `""` means "no error", the same convention `prStore.loadErrorByProject` uses. */
  errorByProject: Record<string, string>;
  /** Whether a project has ever been loaded, so an empty list can be told from an unopened one. */
  fetchedProjects: Record<string, boolean>;

  detailByRun: Record<string, PipelineRunDetail>;
  detailBusy: Record<string, boolean>;
  detailError: Record<string, string>;

  logByJob: Record<string, JobLog>;
  logBusy: Record<string, boolean>;
  logError: Record<string, string>;

  /** The `needs:` of a GitHub run's workflow, once read off disk. `null` means "tried and
   *  couldn't" — a distinct state from "not tried", which is the key being absent. */
  needsByRun: Record<string, Map<string, string[]> | null>;

  selection: Selection | null;
  /** Per project, not global. A branch name only means anything inside one repository, and a
   *  filter carried across would fetch `release/1.18` from a repo that has never had it —
   *  while the chips, which read the *active* project, showed "all branches". */
  branchFilterByProject: Record<string, string | null>;
  statusFilter: PipelineRun["status"] | null;
  graphMode: GraphMode;

  /** Runs the failure analysis has been asked about: the AI run id it was given, so the panel can
   *  subscribe, plus the answer once there is one. Keyed by job, because a run can fail in more
   *  than one job and each is its own question. */
  analysisByJob: Record<string, { aiRunId: string; startedAt: number; text?: string; error?: string }>;

  load: (projectId: string, options?: { quiet?: boolean }) => Promise<void>;
  selectRun: (projectId: string, run: Pick<PipelineRun, "id" | "provider">) => Promise<void>;
  selectJob: (jobId: string) => Promise<void>;
  /** Opens a run by its [`runKey`] — the shape a notification carries. */
  openByKey: (key: string) => Promise<void>;
  setBranchFilter: (projectId: string, branch: string | null) => void;
  setStatusFilter: (status: PipelineRun["status"] | null) => void;
  setGraphMode: (mode: GraphMode) => void;
  rememberNeeds: (key: string, needs: Map<string, string[]> | null) => void;
  setAnalysis: (key: string, patch: Partial<CiState["analysisByJob"][string]>) => void;
  /** Removes the entry outright. `setAnalysis` merges, so it can never empty one — and an
   *  entry left behind with no `text` and no `error` reads as "still running" forever, which
   *  also hides the button that would start it again. */
  clearAnalysis: (key: string) => void;
  /** Ref-counted watcher. Returns its own teardown, so a component does
   *  `useEffect(() => watch(), [watch])` — the shape `powerStore` and `systemLoadStore` use. */
  watch: () => () => void;
}

/** How many runs a page asks for. One screen of scrolling; more is a rate limit spent on history. */
const PAGE = 50;

/** Every 5 s while something is moving — fast enough that a job finishing feels immediate. */
const LIVE_MS = 5_000;
/** Every 30 s when nothing is. A new push is the only thing that can change the list, and it
 *  arrives from outside the app. */
const IDLE_MS = 30_000;
/** The interval actually runs at the fast rate and counts; a second timer that has to be rebuilt
 *  on every `visibilitychange` is what `api/sync.ts` explains it avoided doing. */
const TICK_MS = LIVE_MS;

const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 5 * 60_000;

// --- module-scope watcher state, exactly as powerStore/systemLoadStore hold theirs -------------
let timer: ReturnType<typeof setInterval> | undefined;
let watchers = 0;
let sinceLastPoll = 0;
/** Consecutive failures per project, and the moment each is allowed to try again. */
const failures = new Map<string, number>();
const nextAttempt = new Map<string, number>();
/** Projects with a round still in flight. Kept per project rather than as one boolean so a slow
 *  poll in one repository does not delay the first poll after switching to another. */
const polling = new Set<string>();
/**
 * The status each run was last seen in, so a *change* can be told from a first sighting.
 *
 * Module scope rather than store state on purpose: it is bookkeeping about what has already been
 * announced, not something any component renders, and putting it in the store would re-render
 * every subscriber on each poll for no visible reason.
 */
const lastSeenStatus = new Map<string, PipelineRun["status"]>();

function isLive(run: PipelineRun): boolean {
  return run.status === "running" || run.status === "queued";
}

/**
 * Announces a run that finished while the user was looking somewhere else.
 *
 * Three rules, each of which exists because of a specific way this goes wrong:
 *
 *  1. **A first sighting is never news.** Without this, opening the tab on a repository with a
 *     year of history announces every failure in it at once — and `notificationStore` caps at 100
 *     items, so that would also throw away everything else in the bell.
 *  2. **Only transitions into a finished state count.** `queued → running` is not an event anybody
 *     wants a row for.
 *  3. **The workspace is captured before the await, not after.** `notify` requires it and gives it
 *     no default, because defaulting to "wherever the user is now" filed twenty-one kinds of
 *     finished work under whatever workspace they had wandered into. A poll takes seconds; the
 *     user can absolutely have switched during one.
 */
function announceTransitions(projectId: string, runs: PipelineRun[], workspaceId: string | null): void {
  for (const run of runs) {
    const key = runKey(projectId, run);
    const before = lastSeenStatus.get(key);
    lastSeenStatus.set(key, run.status);
    if (before === undefined || before === run.status) continue;
    if (isLive(run)) continue;

    const failed = run.status === "failed";
    const warned = run.status === "warning";
    if (!failed && !warned && run.status !== "success") continue;

    notify({
      source: "ci",
      workspaceId,
      status: failed ? "error" : warned ? "info" : "success",
      titleKey: failed
        ? "pipelines.notifyFailed"
        : warned
          ? "pipelines.notifyWarning"
          : "pipelines.notifySucceeded",
      params: { name: run.name, branch: run.branch },
      detail: run.commit_title ?? run.commit_sha.slice(0, 7),
      target: { view: "pipelines", projectId, select: { kind: "pipelineRun", id: key } },
    });
  }
}

export const useCiStore = create<CiState>((set, get) => ({
  runsByProject: {},
  loadingProjectId: null,
  errorByProject: {},
  fetchedProjects: {},
  detailByRun: {},
  detailBusy: {},
  detailError: {},
  logByJob: {},
  logBusy: {},
  logError: {},
  needsByRun: {},
  selection: null,
  branchFilterByProject: {},
  statusFilter: null,
  graphMode: "graph",
  analysisByJob: {},

  /**
   * Reloads a project's runs.
   *
   * `quiet` is what the poll passes: no spinner, and a failure is remembered rather than shown.
   * A background refresh that fails is not the user's problem — `prStore.refreshPr` and the whole
   * of `backgroundFetch` take the same line — and a toast every 30 seconds from a laptop that
   * closed its lid is worse than the silence.
   */
  load: async (projectId, options = {}) => {
    const quiet = options.quiet === true;
    if (!quiet) set({ loadingProjectId: projectId });
    // Captured before the await: a poll round outlives the user's attention span for switching
    // workspaces, and a notification filed under the wrong one is unfindable.
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const branch = get().branchFilterByProject[projectId] ?? null;

    try {
      const runs = await api.listPipelineRuns(projectId, branch, PAGE);
      failures.delete(projectId);
      nextAttempt.delete(projectId);
      announceTransitions(projectId, runs, workspaceId);
      set((s) => ({
        runsByProject: {
          ...s.runsByProject,
          // Merged, not replaced. The list response cannot reach the "passed with warnings"
          // verdict for GitHub or GitLab — only the detail can (see `refine_run_status`) — so a
          // plain overwrite would flip an amber row back to green on the very next poll, five
          // seconds after opening it. `raw_status` is what the provider itself said and is left
          // untouched by the refinement, so it is the discriminant; `finished_at` guards against a
          // re-run of the same id inheriting a stale verdict.
          [projectId]: runs.map((run) => {
            const refined = s.detailByRun[runKey(projectId, run)]?.run;
            return refined &&
              refined.raw_status === run.raw_status &&
              refined.finished_at === run.finished_at
              ? refined
              : run;
          }),
        },
        errorByProject: { ...s.errorByProject, [projectId]: "" },
        fetchedProjects: { ...s.fetchedProjects, [projectId]: true },
      }));
    } catch (e) {
      const count = (failures.get(projectId) ?? 0) + 1;
      failures.set(projectId, count);
      nextAttempt.set(
        projectId,
        Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS),
      );
      set((s) => ({
        errorByProject: { ...s.errorByProject, [projectId]: String(e) },
        fetchedProjects: { ...s.fetchedProjects, [projectId]: true },
      }));
    } finally {
      // Only ever clears its own load, so a manual refresh started during a slow one doesn't get
      // its spinner switched off by the other one landing. Same guard as `prStore`'s.
      if (!quiet) {
        set((s) => (s.loadingProjectId === projectId ? { loadingProjectId: null } : {}));
      }
    }
  },

  selectRun: async (projectId, run) => {
    const key = runKey(projectId, run);
    const previous = get().selection;
    const cached = get().detailByRun[key];

    // Re-selecting the run that is *already open* is what the poll does every five seconds while
    // something is running, and it must not take the user's job away from them. Without this the
    // selection snapped back to `pickInterestingJob` on every tick — which also reset the log
    // pane's scroll position and cleared whatever was typed in its search box, because those are
    // keyed on the selected job. Only a genuinely different run starts on the interesting one.
    const keepJobId =
      previous &&
      previous.projectId === projectId &&
      previous.runId === run.id &&
      previous.provider === run.provider &&
      previous.jobId &&
      cached?.jobs.some((job) => job.id === previous.jobId)
        ? previous.jobId
        : null;
    set({ selection: { projectId, runId: run.id, provider: run.provider, jobId: keepJobId } });

    if (cached) {
      void get().selectJob(keepJobId ?? pickInterestingJob(cached.jobs)?.id ?? "");
      // Still refetched underneath: a run that was running when it was last opened has moved on.
      if (!isLive(cached.run)) return;
    }

    set((s) => ({ detailBusy: { ...s.detailBusy, [key]: true } }));
    try {
      const detail = await api.pipelineRunDetail(projectId, run.id);
      set((s) => ({
        detailByRun: { ...s.detailByRun, [key]: detail },
        detailError: { ...s.detailError, [key]: "" },
        // The list's copy of this run is replaced by the detail's. This is not redundant: for
        // GitHub and GitLab the "succeeded with warnings" verdict cannot be reached from the list
        // response at all, so the row is corrected the moment the run is opened. See
        // `refine_run_status` in `ci/github.rs`.
        runsByProject: {
          ...s.runsByProject,
          [projectId]: (s.runsByProject[projectId] ?? []).map((r) =>
            r.id === detail.run.id && r.provider === detail.run.provider ? detail.run : r,
          ),
        },
      }));
      // Only if the user hasn't moved on: a slow detail landing after they clicked another run
      // must not drag the selection back.
      const now = get().selection;
      if (now && now.projectId === projectId && now.runId === run.id && now.jobId === null) {
        const job = pickInterestingJob(detail.jobs);
        if (job) void get().selectJob(job.id);
      }
    } catch (e) {
      set((s) => ({ detailError: { ...s.detailError, [key]: String(e) } }));
    } finally {
      set((s) => (s.detailBusy[key] ? { detailBusy: { ...s.detailBusy, [key]: false } } : {}));
    }
  },

  selectJob: async (jobId) => {
    const selection = get().selection;
    if (!selection || !jobId) return;
    set({ selection: { ...selection, jobId } });

    const detail =
      get().detailByRun[runKey(selection.projectId, { provider: selection.provider, id: selection.runId })];
    const job = detail?.jobs.find((j) => j.id === jobId);
    if (!job) return;

    const key = jobKey(selection.projectId, job);
    // A finished job's log never changes, so it is fetched once. A running one is refetched every
    // time it is selected — and the poll below reselects it, which is what makes a live log grow.
    if (get().logByJob[key] && job.status !== "running") return;
    if (get().logBusy[key]) return;

    set((s) => ({ logBusy: { ...s.logBusy, [key]: true } }));
    try {
      const log = await api.fetchPipelineJobLog(
        selection.projectId,
        selection.runId,
        job.id,
        job.log_ref,
      );
      set((s) => ({
        logByJob: { ...s.logByJob, [key]: log },
        logError: { ...s.logError, [key]: "" },
      }));
    } catch (e) {
      set((s) => ({ logError: { ...s.logError, [key]: String(e) } }));
    } finally {
      set((s) => ({ logBusy: { ...s.logBusy, [key]: false } }));
    }
  },

  openByKey: async (key) => {
    // `${projectId}:${provider}:${runId}` — the project id is a UUID and carries no colons, and
    // the provider is one of three fixed words, so the split is unambiguous from the left.
    const [projectId, provider, ...rest] = key.split(":");
    const runId = rest.join(":");
    if (!projectId || !runId) return;

    let run = get().runsByProject[projectId]?.find((r) => r.id === runId && r.provider === provider);
    if (!run) {
      await get().load(projectId);
      run = get().runsByProject[projectId]?.find((r) => r.id === runId && r.provider === provider);
    }
    // A run that has aged off the first page is still openable: the detail command reaches any run
    // by id. It has to go *through* `selectRun` to do it — setting the selection alone leaves a
    // pane that says "pick a run" forever, because nothing else in this store asks for a detail.
    // Which is exactly the path a week-old analysis followed from Activity takes.
    await get().selectRun(projectId, run ?? { id: runId, provider: provider as PipelineRun["provider"] });
  },

  setBranchFilter: (projectId, branch) => {
    set((s) => ({ branchFilterByProject: { ...s.branchFilterByProject, [projectId]: branch } }));
    // The filter is applied by the host, not here, so changing it is a refetch. Manual, so it
    // clears any backoff the last failure left behind — the user asking again is a good reason to
    // stop waiting.
    failures.delete(projectId);
    nextAttempt.delete(projectId);
    void get().load(projectId);
  },

  setStatusFilter: (status) => set({ statusFilter: status }),
  setGraphMode: (mode) => set({ graphMode: mode }),

  clearAnalysis: (key) =>
    set((s) => {
      if (!(key in s.analysisByJob)) return {};
      const next = { ...s.analysisByJob };
      delete next[key];
      return { analysisByJob: next };
    }),

  rememberNeeds: (key, needs) =>
    set((s) => (key in s.needsByRun ? {} : { needsByRun: { ...s.needsByRun, [key]: needs } })),

  setAnalysis: (key, patch) =>
    set((s) => {
      const previous = s.analysisByJob[key] ?? { aiRunId: "", startedAt: Date.now() };
      return { analysisByJob: { ...s.analysisByJob, [key]: { ...previous, ...patch } } };
    }),

  watch: () => {
    watchers += 1;
    const tick = () => {
      // Not visible: nothing to update, and a laptop with its lid shut should not be spending a
      // rate limit. The interval is left running rather than torn down and rebuilt — the same
      // choice `powerStore` and `api/sync.ts` both document.
      if (document.visibilityState !== "visible") return;
      // The view is never unmounted, only hidden (`App.tsx` keeps visited views mounted), so
      // "am I on screen" has to be asked rather than assumed from being mounted.
      if (useUiStore.getState().activeView !== "pipelines") return;

      const projectId = useWorkspaceStore.getState().activeProjectId;
      if (!projectId) return;
      if (Date.now() < (nextAttempt.get(projectId) ?? 0)) return;

      const runs = useCiStore.getState().runsByProject[projectId] ?? [];
      const anyLive = runs.some(isLive);
      sinceLastPoll += TICK_MS;
      if (sinceLastPoll < (anyLive ? LIVE_MS : IDLE_MS)) return;
      // A round that hasn't landed yet must not be joined by another. Azure's job logs are fetched
      // one timeline record at a time, so a single tick there can outlast the five seconds until
      // the next — and without this the requests stack against a host that rate-limits. Returning
      // before the counter is reset keeps its credit, so the tick after the answer lands polls
      // immediately rather than waiting out another full interval.
      if (polling.has(projectId)) return;
      sinceLastPoll = 0;

      polling.add(projectId);
      void useCiStore
        .getState()
        .load(projectId, { quiet: true })
        .finally(() => polling.delete(projectId));

      // The open run is refreshed alongside the list while it is still moving, so its jobs and its
      // log grow on screen instead of freezing at whatever they were when it was opened.
      const selection = useCiStore.getState().selection;
      if (!selection || selection.projectId !== projectId) return;
      const open = runs.find((r) => r.id === selection.runId && r.provider === selection.provider);
      if (open && isLive(open)) void useCiStore.getState().selectRun(projectId, open);
    };

    if (!timer) {
      sinceLastPoll = TICK_MS; // so the first tick after mounting polls immediately
      timer = setInterval(tick, TICK_MS);
      document.addEventListener("visibilitychange", wake);
      window.addEventListener("focus", wake);
    }
    tick();

    return () => {
      watchers -= 1;
      if (watchers > 0 || !timer) return;
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  },
}));

/** Coming back to the window is the moment the answer is most likely to be stale. */
function wake(): void {
  if (document.visibilityState !== "visible") return;
  sinceLastPoll = IDLE_MS;
}

/**
 * The job a run should open on.
 *
 * The first failure, because that is the reason anybody opens a red run. Then the first thing
 * still running, because that is the reason anybody opens a live one. Otherwise the first job,
 * which for a green run is as good an answer as any.
 */
export function pickInterestingJob(jobs: PipelineJob[]): PipelineJob | undefined {
  return (
    jobs.find((j) => j.status === "failed") ??
    jobs.find((j) => j.status === "running") ??
    jobs.find((j) => j.status === "warning") ??
    jobs[0]
  );
}

/** The selected run's detail, or `undefined` while it loads. */
export function selectedDetail(state: CiState): PipelineRunDetail | undefined {
  const s = state.selection;
  return s ? state.detailByRun[`${s.projectId}:${s.provider}:${s.runId}`] : undefined;
}

/** The key the selected job's log and analysis are filed under. */
export function selectedJobKey(state: CiState): string | null {
  const s = state.selection;
  return s && s.jobId ? `${s.projectId}:${s.provider}:${s.runId}:${s.jobId}` : null;
}

/**
 * Reopens a stored failure analysis: the Pipelines tab, on the run and the job it was about.
 *
 * Lives here rather than in either of the two Activity lists that call it, because both would
 * otherwise carry a copy of the same four steps — and because the coordinates it reads
 * (`pipelineRunKey`, `pipelineJobId`) are written by `analyze_pipeline_failure` against this
 * store's own key format.
 *
 * A row whose meta predates this (or whose run has since been deleted on the host) opens the tab
 * and stops there, which is most of where the user was going.
 */
export async function openPipelineAnalysis(job: {
  projectId: string;
  meta: Record<string, unknown>;
}): Promise<void> {
  const key = job.meta.pipelineRunKey;
  const jobId = job.meta.pipelineJobId;
  const { useUiStore: ui } = await import("./uiStore");
  const { useWorkspaceStore: ws } = await import("./workspaceStore");
  // The repository first: this view reads everything off the *active* project, so opening the tab
  // before switching would show another repo's runs for a frame and then reload. The workspace is
  // found rather than assumed — an Activity list spans every workspace, so the row being followed
  // is routinely not in the one on screen.
  if (ws.getState().activeProjectId !== job.projectId) {
    const owner = Object.entries(ws.getState().projectsByWorkspace).find(([, projects]) =>
      projects.some((project) => project.id === job.projectId),
    );
    if (owner) await ws.getState().focusProject(owner[0], job.projectId);
    else ws.getState().setActiveProject(job.projectId);
  }
  ui.getState().setActiveView("pipelines");
  if (typeof key !== "string") return;
  await useCiStore.getState().openByKey(key);
  if (typeof jobId === "string") await useCiStore.getState().selectJob(jobId);
}
