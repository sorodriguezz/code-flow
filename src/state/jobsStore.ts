import { create } from "zustand";
import { parseClaudeError, type ClaudeErrorInfo } from "../lib/claudeError";
import {
  listJobHistory,
  renameJobHistoryEntry,
  deleteJobHistoryEntry,
  listWorkspaceActivity,
  renameWorkspaceActivityEntry,
  deleteWorkspaceActivityEntry,
} from "../lib/tauri/commands";
import { isWorkspaceBucket, workspaceIdFromBucket } from "../lib/prTarget";
import type { JobHistoryEntry, WorkspaceActivityEntry } from "../types/domain";
import { useLanguageStore } from "./languageStore";
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

interface JobsState {
  byProject: Record<string, Job[]>;
  loaded: Record<string, boolean>;
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
   * rather than replaced. */
  load: (projectId: string) => Promise<void>;
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
function notifyJobSettled(kind: JobKind, label: string, ok: boolean): void {
  if (kind === "pr-action") return;
  const analyzing = kind === "analyze-changes";
  notify({
    source: analyzing ? "changes" : "review",
    titleKey: analyzing
      ? ok
        ? "notifications.analyzeDone"
        : "notifications.analyzeFailed"
      : ok
        ? "notifications.reviewDone"
        : "notifications.reviewFailed",
    status: ok ? "success" : "error",
    detail: label,
  });
}

export const useJobsStore = create<JobsState>((set, get) => ({
  byProject: {},
  loaded: {},

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
    useAiRunStore.getState().start(id);

    void task(id)
      .then((result) => {
        settle({ status: "done", result, finishedAt: Date.now() });
        notifyJobSettled(kind, label, true);
      })
      .catch((e) => {
        const cancelled = isCancellation(e);
        settle(
          cancelled
            ? { status: "cancelled", finishedAt: Date.now() }
            : { status: "error", error: parseClaudeError(String(e)), finishedAt: Date.now() },
        );
        if (!cancelled) notifyJobSettled(kind, label, false);
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

    // A workspace bucket reads the other table: everything reviewed from a link, which belongs to
    // no repository and so follows the workspace instead. See `targetKey`.
    const workspaceId = workspaceIdFromBucket(projectId);
    const rows: ActivityRow[] = await (workspaceId === null
      ? listJobHistory(projectId)
      : listWorkspaceActivity(workspaceId)
    ).catch(() => []);
    const loadedJobs: Job[] = rows.map((row) => toJob(projectId, row));
    set((s) => {
      const existing = s.byProject[projectId] ?? [];
      const existingIds = new Set(existing.map((j) => j.id));
      const merged = [...loadedJobs.filter((j) => !existingIds.has(j.id)), ...existing].sort(
        (a, b) => b.createdAt - a.createdAt,
      );
      return { byProject: { ...s.byProject, [projectId]: merged } };
    });
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
