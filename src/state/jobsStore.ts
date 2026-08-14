import { create } from "zustand";
import { parseClaudeError, type ClaudeErrorInfo } from "../lib/claudeError";
import {
  getJobResult,
  listJobHistory,
  listWorkspaceActivity,
  renameJobHistoryEntry,
  deleteJobHistoryEntry,
  renameWorkspaceActivityEntry,
  deleteWorkspaceActivityEntry,
} from "../lib/tauri/commands";
import { isWorkspaceBucket, workspaceIdFromBucket } from "../lib/prTarget";
import type { JobHistoryEntry, WorkspaceActivityEntry } from "../types/domain";
import { useLanguageStore } from "./languageStore";
import { useWorkspaceStore } from "./workspaceStore";
import { isCancellation, useAiRunStore } from "./aiRunStore";
import { notify } from "./notificationStore";
import { translations } from "../lib/i18n/translations";

/** `pr-action` is the odd one out: it isn't something that *ran*, it's a decision that was taken
 * (approve / request changes / close). It's filed here anyway because Activity is where the user
 * looks for "what happened to this PR", and a decision belongs in that answer. */
export type JobKind = "pr-review" | "analyze-changes" | "pr-action";
/** `cancelled` is a stopped run, kept apart from `error` so the UI can offer "run it again"
 * instead of showing a failure the user caused on purpose. It only ever lives in memory — the
 * backend doesn't persist a cancelled run to `job_history`. */
export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface Job {
  id: string;
  /** The *bucket* this job is filed under, which is a project id for almost everything — but a
   * workspace key (see `workspaceActivityKey`) for a PR reviewed from a link, which belongs to no
   * repository here. It's the field that says which table the row lives in, so anything acting on
   * a job (rename, delete) should take it from here rather than from whatever the surrounding
   * screen happens to be showing: one Activity list mixes both. */
  projectId: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  createdAt: number;
  finishedAt: number | null;
  result: string | null;
  error: ClaudeErrorInfo | null;
  meta: Record<string, unknown>;
}

const EMPTY_JOBS: Job[] = [];

/**
 * How many persisted rows a page holds.
 *
 * `list_job_history` and `list_workspace_activity` now take this as a `LIMIT` (they used to
 * `SELECT` the whole table), and every row still carries `result` — the entire text of a PR review
 * — so on a long-lived install the un-paged read handed the first open of the AI panel megabytes to
 * deserialise and render in one go. That was the freeze, not the memory.
 *
 * `result` stays in the projection on purpose: `AiPanel` and `AnalyzeSection` read `job.result`
 * straight off the row they have, so a list without it would show an empty review until a second
 * fetch landed. Only the page is bounded.
 */
const PAGE_SIZE = 50;

/** How many persisted rows each bucket has read so far — the offset the next page starts at.
 * Bookkeeping rather than state: nothing renders it. */
const fetchedRows = new Map<string, number>();
/** Buckets with a page in flight, so a double click on "load more" doesn't fetch it twice. */
const pagingBuckets = new Set<string>();
/** Buckets whose background read-through has already been started, so it happens once per
 * session no matter how many times a view remounts and calls `load`. */
const drainedBuckets = new Set<string>();
/** Rows whose result text is being fetched, so selecting a row twice in quick succession — or two
 * readers rendering the same selection — costs one round trip. See `hydrateResult`. */
const hydrating = new Set<string>();

/** Runs `fn` when the main thread has nothing better to do, with a ceiling so it still happens on
 * a busy app. The fallback matters for nothing in production (the webview has
 * `requestIdleCallback`) but keeps this callable under a test DOM. */
function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 500 });
  else setTimeout(fn, 0);
}

/**
 * Reads the rest of a bucket's history in the background, one page at a time.
 *
 * This is what makes the `LIMIT` above safe. Nothing in the UI offers a "load more" row today, so
 * a bounded first read on its own would put every run older than a page out of the user's reach —
 * and out of `notificationStore`'s reach too, which finds a notified job by scanning `byProject`.
 * Reading through to the end keeps the list exactly as complete as it was before.
 *
 * What changes is *when*: the panel paints after one page instead of after the whole table, and
 * each further page is a separate small task with an idle gap in front of it, so the main thread
 * gets a turn between them rather than blocking once for the lot.
 *
 * Stops if something else is already paging this bucket — the only such caller would be a future
 * "load more" click, and two walkers sharing one offset would read the same page twice.
 */
function drainHistory(projectId: string): void {
  const step = () => {
    const state = useJobsStore.getState();
    if (!state.hasMore[projectId] || pagingBuckets.has(projectId)) return;
    void state.loadMore(projectId).then(() => whenIdle(step));
  };
  whenIdle(step);
}

interface JobsState {
  byProject: Record<string, Job[]>;
  loaded: Record<string, boolean>;
  /** Whether a bucket may still have older rows on disk than the ones in `byProject`.
   *
   * True between the first page landing and the background read-through finishing (see
   * `drainHistory`), and it is also what a "load more" row in the Activity list would be gated on
   * if one is ever added. */
  hasMore: Record<string, boolean>;
  /** Kicks off `task` immediately and tracks it as a job entry that survives project/view
   * switches — the promise itself already keeps running in the background regardless of what
   * the UI shows (Tauri's `invoke` doesn't get cancelled by React unmounting), this just makes
   * that fact visible instead of silently discarding the result if nobody's watching. `task`
   * receives the job's own id so the backend can persist its `job_history` row under that
   * same id — that's what lets a job just run this session and the same job reloaded from
   * history after a restart be the same identity, so renaming/deleting either always works. */
  run: (args: {
    projectId: string;
    kind: JobKind;
    label: string;
    meta?: Record<string, unknown>;
    task: (jobId: string) => Promise<string>;
  }) => string;
  /** Files an already-completed history row into Activity without a round-trip to disk — used by
   * a PR decision, which the backend persists as it happens rather than running as a job. */
  record: (projectId: string, entry: ActivityRow) => void;
  /** Hydrates a bucket's finished runs from disk — a project's PR reviews / pre-commit analyses
   * from `job_history`, or a workspace's link reviews from `workspace_activity`. `run()` only
   * ever lived in memory, so without this every past result vanished on restart. Runs once per
   * bucket per session; a job already in memory (freshly run before this resolves) is merged in
   * rather than replaced.
   *
   * Resolves once the *first* page is on screen; the rest of the history keeps arriving after that
   * through `drainHistory`, which is what lets the panel paint without waiting for the whole
   * table. */
  load: (projectId: string) => Promise<void>;
  /** Reads the next page of a bucket's history and **appends** it, so nothing already on screen
   * moves or is replaced. A no-op while `hasMore[projectId]` is false. */
  loadMore: (projectId: string) => Promise<void>;
  /**
   * Fetches one finished run's output text and files it into the row, for the pages that were read
   * without it (see `fetchActivityPage`).
   *
   * Idempotent and cheap to over-call: a row that already has its `result` is returned untouched,
   * and a run that produced none records `""` rather than staying `null`, so a second open does not
   * re-ask. Only rows whose `status` is `done` are worth asking about — a failed run's text is in
   * `error`, which the list always carries.
   */
  hydrateResult: (projectId: string, jobId: string) => Promise<void>;
  rename: (projectId: string, jobId: string, label: string) => Promise<void>;
  /** Best-effort against the persisted row — a job still `running` has no `job_history` row
   * yet, so there's nothing there to delete, but it's removed from the in-memory list either
   * way. */
  remove: (projectId: string, jobId: string) => Promise<void>;
  jobsFor: (projectId: string) => Job[];
  latestOfKind: (projectId: string, kind: JobKind, meta?: Record<string, unknown>) => Job | null;
}

let seq = 0;

/** Translates outside of React (this store isn't a component) using whatever language is
 * currently selected — same lookup `useT()` does, just without the hook. */
function translate(key: keyof typeof translations.en): string {
  const language = useLanguageStore.getState().language;
  return translations[language][key] ?? translations.en[key] ?? key;
}

function safeParseMeta(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const PR_ACTION_LABEL_KEY: Record<string, keyof typeof translations.en> = {
  approve: "activity.prApproved",
  request_changes: "activity.prChangesRequested",
  close: "activity.prClosed",
};

/** A persisted Activity row, from either table — they carry the same fields apart from what they
 * hang off (a project or a workspace), which the bucket key already says. */
type ActivityRow = JobHistoryEntry | WorkspaceActivityEntry;

/** Turns a persisted history row into the in-memory job the Activity list renders. Shared by the
 * initial load and by a decision recorded this session, so a row reads the same either way. */
function toJob(projectId: string, row: ActivityRow): Job {
  const meta = safeParseMeta(row.meta);
  // A repo-less review names its repository, because nothing else in the row does: it sits in the
  // list next to reviews of repositories the user actually has, and "#42 Fix login" alone gives no
  // clue which one it came from — "#42 acme/widgets · Fix login" does, and is searchable by repo.
  const repoLabel = typeof meta.repoLabel === "string" ? meta.repoLabel : null;
  const prLabel =
    typeof meta.prTitle === "string"
      ? repoLabel
        ? `#${meta.prId} ${repoLabel} · ${meta.prTitle}`
        : `#${meta.prId} ${meta.prTitle}`
      : row.label;
  const label =
    row.custom_label ??
    (row.kind === "analyze-changes"
      ? // Same "title · time" shape as a freshly-run analysis (see AnalyzeSection.runAnalysis),
        // so reloaded entries stay distinguishable instead of all reading the plain title.
        `${translate("analyze.title")} · ${new Date(row.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : row.kind === "pr-action"
        ? // The decision is the whole point of the row, so it's in the label rather than only in
          // the icon — "#12 Fix login · Approved".
          `${prLabel} · ${translate(PR_ACTION_LABEL_KEY[String(meta.action)] ?? "activity.prApproved")}`
        : row.kind === "pr-review" && typeof meta.prTitle === "string"
          ? prLabel
          : row.label);
  const createdAt = new Date(row.created_at).getTime();
  return {
    id: row.id,
    projectId,
    kind: row.kind as JobKind,
    label,
    status: row.status as JobStatus,
    createdAt,
    finishedAt: createdAt,
    result: row.result,
    error: row.error ? parseClaudeError(row.error) : null,
    meta,
  };
}

/**
 * Files a finished job in the notification centre.
 *
 * `pr-action` is skipped: it is a decision the user just made (approve, close), not work that ran
 * while they were elsewhere, and it settles in the same instant they click. Telling them it
 * happened would be telling them what they did.
 */
function notifyJobSettled(job: Job, ok: boolean): void {
  if (job.kind === "pr-action") return;
  const analyzing = job.kind === "analyze-changes";
  // A run filed under a workspace is a PR reviewed from a link: there is no project to bring to the
  // front, and the workspace it belongs to is the bucket's own rather than whichever one the user
  // has wandered into since. A run filed under a project answers the same question through the
  // project — a review is exactly the kind of work that outlives the screen it was started from,
  // and the store's default ("wherever the user is now") would file it under the wrong workspace
  // and then send the button there.
  const linkWorkspaceId = workspaceIdFromBucket(job.projectId);
  const workspaceId =
    linkWorkspaceId ?? useWorkspaceStore.getState().workspaceOfProject(job.projectId);
  notify({
    source: analyzing ? "changes" : "review",
    titleKey: analyzing
      ? ok
        ? "notifications.analyzeDone"
        : "notifications.analyzeFailed"
      : ok
        ? "notifications.reviewDone"
        : "notifications.reviewFailed",
    // Where the result is: this run, in the assistant panel, on the project it ran for. No view —
    // the panel is a rail over whichever one the user is on, and a review is not a reason to move
    // them off it.
    target: {
      openAiPanel: true,
      projectId: linkWorkspaceId ? undefined : job.projectId,
      select: { kind: "job", id: job.id },
    },
    workspaceId: workspaceId ?? undefined,
    status: ok ? "success" : "error",
    detail: job.label,
  });
}

/**
 * Reads one page of a bucket's persisted rows.
 *
 * A workspace bucket reads the other table: everything reviewed from a link, which belongs to no
 * repository and so follows the workspace instead. See `targetKey`.
 *
 * `offset` counts rows already read for this bucket rather than being a cursor, which is what the
 * `LIMIT ?/OFFSET ?` on both queries takes. The window can shift under a page if a row is deleted
 * mid-walk; a row *added* mid-walk only ever re-reads one, and the append below dedupes by id.
 * Neither is worth a keyset cursor here: the walk lasts a few hundred ms and only runs once per
 * bucket per session.
 */
async function fetchActivityPage(projectId: string, offset: number): Promise<ActivityRow[]> {
  const workspaceId = workspaceIdFromBucket(projectId);
  // Only the first page carries `result`, which is the whole markdown of a review or an analysis —
  // tens of kilobytes a row. The pages behind it exist so the list can draw them and so
  // `notificationStore` can scan them, and neither needs the text; `drainHistory` below walks
  // *every* page in the background, so carrying it meant a mature install held every review it had
  // ever run, per bucket, for the session. A row selected later fetches its own body — see
  // `hydrateResult` and its two callers.
  return await (workspaceId === null
    ? listJobHistory(projectId, PAGE_SIZE, offset, offset === 0)
    : listWorkspaceActivity(workspaceId, PAGE_SIZE, offset, offset === 0)
  ).catch(() => []);
}

export const useJobsStore = create<JobsState>((set, get) => ({
  byProject: {},
  loaded: {},
  hasMore: {},

  run: ({ projectId, kind, label, meta = {}, task }) => {
    const id = `job-${Date.now()}-${seq++}`;
    const job: Job = {
      id,
      projectId,
      kind,
      label,
      status: "running",
      createdAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
      meta,
    };
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: [job, ...(s.byProject[projectId] ?? [])] },
    }));

    const settle = (patch: Partial<Job>) => {
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).map((j) => (j.id === id ? { ...j, ...patch } : j)),
        },
      }));
    };

    // The job id is also the run id the backend streams under — that's what lets this row show
    // the CLI's live output and stop it.
    //
    // The same landing this job's *finished* notification will offer (see `notifyJobSettled`),
    // including its one subtlety: a pull request reviewed from a link belongs to no repository
    // here, and naming its bucket as a project would focus one that does not exist.
    useAiRunStore.getState().start(id, {
      kindKey: kind === "pr-review" ? "agents.liveKindReview" : "agents.liveKindAnalyze",
      detail: label,
      target: {
        openAiPanel: true,
        projectId: isWorkspaceBucket(projectId) ? undefined : projectId,
        select: { kind: "job", id },
      },
    });

    void task(id)
      .then((result) => {
        settle({ status: "done", result, finishedAt: Date.now() });
        notifyJobSettled(job, true);
      })
      .catch((e) => {
        const cancelled = isCancellation(e);
        settle(
          cancelled
            ? { status: "cancelled", finishedAt: Date.now() }
            : { status: "error", error: parseClaudeError(String(e)), finishedAt: Date.now() },
        );
        if (!cancelled) notifyJobSettled(job, false);
      })
      .finally(() => useAiRunStore.getState().finish(id));

    return id;
  },

  record: (projectId, entry) => {
    const job = toJob(projectId, entry);
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [job, ...(s.byProject[projectId] ?? []).filter((j) => j.id !== job.id)],
      },
    }));
  },

  load: async (projectId) => {
    if (get().loaded[projectId]) return;
    // Marked synchronously, before the `await` below — React (in dev StrictMode especially)
    // can fire this effect-triggered call twice back to back, and if the "already loaded"
    // flag only got set *after* the fetch resolved, both calls would pass this guard and each
    // append their own copy of the same history rows, duplicating every entry (and handing
    // React two list items with the same key, which then misbinds clicks on nearby rows).
    set((s) => ({ loaded: { ...s.loaded, [projectId]: true } }));

    const rows = await fetchActivityPage(projectId, 0);
    fetchedRows.set(projectId, rows.length);
    const loadedJobs: Job[] = rows.map((row) => toJob(projectId, row));
    set((s) => {
      const existing = s.byProject[projectId] ?? [];
      const existingIds = new Set(existing.map((j) => j.id));
      const merged = [...loadedJobs.filter((j) => !existingIds.has(j.id)), ...existing].sort(
        (a, b) => b.createdAt - a.createdAt,
      );
      return {
        byProject: { ...s.byProject, [projectId]: merged },
        // A full page back means there may be another one; a short read is the end of the history.
        // `loadMore` retires the flag itself the moment a page adds nothing, which covers the
        // boundary case of a history that is an exact multiple of `PAGE_SIZE`.
        hasMore: { ...s.hasMore, [projectId]: rows.length === PAGE_SIZE },
      };
    });
    // The list is on screen now; the rest of it follows in the background rather than being left
    // behind a "load more" nothing in the UI draws yet. See `drainHistory`.
    if (!drainedBuckets.has(projectId)) {
      drainedBuckets.add(projectId);
      drainHistory(projectId);
    }
  },

  loadMore: async (projectId) => {
    if (!get().hasMore[projectId] || pagingBuckets.has(projectId)) return;
    pagingBuckets.add(projectId);
    try {
      const offset = fetchedRows.get(projectId) ?? 0;
      const rows = await fetchActivityPage(projectId, offset);
      fetchedRows.set(projectId, offset + rows.length);
      const older: Job[] = rows.map((row) => toJob(projectId, row));
      set((s) => {
        const existing = s.byProject[projectId] ?? [];
        const existingIds = new Set(existing.map((j) => j.id));
        const fresh = older.filter((j) => !existingIds.has(j.id));
        return {
          byProject: {
            ...s.byProject,
            [projectId]: [...existing, ...fresh].sort((a, b) => b.createdAt - a.createdAt),
          },
          // A page that brought nothing new is the end of the history, whatever its length said.
          // Belt and braces around the length check: it is also what stops `drainHistory` if a
          // caller ever hands back a page it has already seen.
          hasMore: { ...s.hasMore, [projectId]: fresh.length > 0 && rows.length === PAGE_SIZE },
        };
      });
    } finally {
      pagingBuckets.delete(projectId);
    }
  },

  hydrateResult: async (projectId, jobId) => {
    const job = (get().byProject[projectId] ?? []).find((j) => j.id === jobId);
    if (!job || job.status !== "done" || job.result !== null) return;
    if (hydrating.has(jobId)) return;
    hydrating.add(jobId);
    try {
      // `?? ""` rather than leaving it null: a run that genuinely produced no text must be
      // distinguishable from one that has not been asked yet, or every render of that row asks
      // again. Empty renders as an empty review, which is what it is.
      const result = (await getJobResult(jobId).catch(() => null)) ?? "";
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).map((j) => (j.id === jobId ? { ...j, result } : j)),
        },
      }));
    } finally {
      hydrating.delete(jobId);
    }
  },

  rename: async (projectId, jobId, label) => {
    await (isWorkspaceBucket(projectId)
      ? renameWorkspaceActivityEntry(jobId, label)
      : renameJobHistoryEntry(jobId, label));
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((j) => (j.id === jobId ? { ...j, label } : j)),
      },
    }));
  },

  remove: async (projectId, jobId) => {
    await (isWorkspaceBucket(projectId)
      ? deleteWorkspaceActivityEntry(jobId)
      : deleteJobHistoryEntry(jobId)
    ).catch(() => {});
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: (s.byProject[projectId] ?? []).filter((j) => j.id !== jobId) },
    }));
  },

  jobsFor: (projectId) => get().byProject[projectId] ?? EMPTY_JOBS,

  latestOfKind: (projectId, kind, meta) => {
    const jobs = get().byProject[projectId] ?? EMPTY_JOBS;
    return (
      jobs.find(
        (j) => j.kind === kind && (!meta || Object.entries(meta).every(([k, v]) => j.meta[k] === v)),
      ) ?? null
    );
  },
}));

export { EMPTY_JOBS };
