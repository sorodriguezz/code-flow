import { create } from "zustand";
import { parseClaudeError, type ClaudeErrorInfo } from "../lib/claudeError";

export type JobKind = "pr-review" | "analyze-changes";
export type JobStatus = "running" | "done" | "error";

export interface Job {
  id: string;
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
  /** Kicks off `task` immediately and tracks it as a job entry that survives project/view
   * switches — the promise itself already keeps running in the background regardless of what
   * the UI shows (Tauri's `invoke` doesn't get cancelled by React unmounting), this just makes
   * that fact visible instead of silently discarding the result if nobody's watching. */
  run: (args: {
    projectId: string;
    kind: JobKind;
    label: string;
    meta?: Record<string, unknown>;
    task: () => Promise<string>;
  }) => string;
  jobsFor: (projectId: string) => Job[];
  latestOfKind: (projectId: string, kind: JobKind, meta?: Record<string, unknown>) => Job | null;
}

let seq = 0;

export const useJobsStore = create<JobsState>((set, get) => ({
  byProject: {},

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

    void task()
      .then((result) => settle({ status: "done", result, finishedAt: Date.now() }))
      .catch((e) => settle({ status: "error", error: parseClaudeError(String(e)), finishedAt: Date.now() }));

    return id;
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
