import { create } from "zustand";
import { parseClaudeError, type ClaudeErrorInfo } from "../lib/claudeError";
import { listJobHistory } from "../lib/tauri/commands";
import { useLanguageStore } from "./languageStore";
import { translations } from "../lib/i18n/translations";

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
  loaded: Record<string, boolean>;
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
  /** Hydrates this project's finished PR reviews / pre-commit analyses from disk — `run()`
   * only ever lived in memory, so without this every past result vanished on restart. Runs
   * once per project per session; a job already in memory (freshly run before this resolves)
   * is merged in rather than replaced. */
  load: (projectId: string) => Promise<void>;
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

    void task()
      .then((result) => settle({ status: "done", result, finishedAt: Date.now() }))
      .catch((e) => settle({ status: "error", error: parseClaudeError(String(e)), finishedAt: Date.now() }));

    return id;
  },

  load: async (projectId) => {
    if (get().loaded[projectId]) return;
    // Marked synchronously, before the `await` below — React (in dev StrictMode especially)
    // can fire this effect-triggered call twice back to back, and if the "already loaded"
    // flag only got set *after* the fetch resolved, both calls would pass this guard and each
    // append their own copy of the same history rows, duplicating every entry (and handing
    // React two list items with the same key, which then misbinds clicks on nearby rows).
    set((s) => ({ loaded: { ...s.loaded, [projectId]: true } }));

    const rows = await listJobHistory(projectId).catch(() => []);
    const loadedJobs: Job[] = rows.map((row) => {
      const meta = safeParseMeta(row.meta);
      const label =
        row.kind === "analyze-changes"
          ? translate("analyze.title")
          : row.kind === "pr-review" && typeof meta.prTitle === "string"
            ? `#${meta.prId} ${meta.prTitle}`
            : row.label;
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
    });
    set((s) => {
      const existing = s.byProject[projectId] ?? [];
      const existingIds = new Set(existing.map((j) => j.id));
      const merged = [...loadedJobs.filter((j) => !existingIds.has(j.id)), ...existing].sort(
        (a, b) => b.createdAt - a.createdAt,
      );
      return { byProject: { ...s.byProject, [projectId]: merged } };
    });
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
