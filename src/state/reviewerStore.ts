import { create } from "zustand";
import {
  onReviewerInstall,
  onReviewerRun,
  onReviewerServer,
  reviewerActiveRun,
  reviewerApplyRules,
  reviewerCancelInstall,
  reviewerCancelRun,
  reviewerDeleteServer,
  reviewerDetect,
  reviewerInstall,
  reviewerLastRun,
  reviewerRun,
  reviewerSaveConfig,
  reviewerSaveServer,
  reviewerServerStart,
  reviewerServerStop,
  reviewerStatus,
  reviewerUninstall,
  type ReviewerConfig,
  type ReviewerHistoryEntry,
  type ReviewerInstallProgress,
  type ReviewerLogLine,
  type ReviewerRemoteServer,
  type ReviewerRulesReport,
  type ReviewerRunSummary,
  type ReviewerServerStatus,
  type ReviewerStage,
  type ReviewerStatus,
  type ReviewerSuggestion,
} from "../lib/tauri/reviewerCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { isMainWindow } from "../lib/windowIdentity";
import type { Project } from "../types/domain";
import { notify } from "./notificationStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * The Reviewer's state on this side: what is installed, the local server, and each project's run.
 *
 * A run belongs to the project it was started for and survives switching repository: the store is
 * keyed by project id, the backend runs one review at a time, and every event names its project —
 * so a review started on one repository and watched from another lands where it belongs (the
 * run-isolation rule the AI runs follow).
 */

/** What the user set for one repository's stages, in `app_settings` under `reviewer_project:<id>`. */
export interface ReviewerProjectConfig {
  /** `false` until the user edits anything: the detected commands are used, and follow the repo. */
  customized: boolean;
  projectKey: string;
  prepare: string;
  build: string;
  test: string;
  exclusions: string;
}

export const EMPTY_PROJECT_CONFIG: ReviewerProjectConfig = {
  customized: false,
  projectKey: "",
  prepare: "",
  build: "",
  test: "",
  exclusions: "",
};

const projectConfigKey = (projectId: string) => `reviewer_project:${projectId}`;

/** A project's review: live while it runs, the summary once it has finished. */
export interface ReviewerProjectRun {
  runId: string;
  projectKey: string;
  startedAt: number;
  stages: ReviewerStage[];
  log: ReviewerLogLine[];
  summary: ReviewerRunSummary | null;
}

/** The lines a panel keeps; the backend keeps more and hands them over on reopening. */
const LOG_KEEP = 20_000;

export type InstallProgressMap = Partial<Record<ReviewerInstallProgress["item"], ReviewerInstallProgress>>;

interface ReviewerState {
  status: ReviewerStatus | null;
  server: ReviewerServerStatus;
  installing: boolean;
  installProgress: InstallProgressMap;
  installError: string | null;
  /** Live or last run, by project id. */
  runs: Record<string, ReviewerProjectRun>;
  history: Record<string, ReviewerHistoryEntry[]>;
  suggestions: Record<string, ReviewerSuggestion>;
  projectConfigs: Record<string, ReviewerProjectConfig>;
  /** The project whose review is running, if one is. */
  activeProjectId: string | null;

  refresh: () => Promise<void>;
  install: () => Promise<void>;
  cancelInstall: () => Promise<void>;
  uninstall: (withData: boolean) => Promise<void>;
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;
  saveConfig: (patch: Partial<ReviewerConfig>) => Promise<void>;
  applyRules: () => Promise<ReviewerRulesReport>;
  saveServer: (server: ReviewerRemoteServer, token?: string) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  loadProject: (project: Project) => Promise<void>;
  saveProjectConfig: (projectId: string, config: ReviewerProjectConfig) => Promise<void>;
  run: (project: Project) => Promise<void>;
  cancel: (projectId: string) => Promise<void>;
}

export const useReviewerStore = create<ReviewerState>((set, get) => ({
  status: null,
  server: { state: "stopped" },
  installing: false,
  installProgress: {},
  installError: null,
  runs: {},
  history: {},
  suggestions: {},
  projectConfigs: {},
  activeProjectId: null,

  refresh: async () => {
    listen();
    const status = await reviewerStatus();
    set({ status, server: status.server });
  },

  install: async () => {
    listen();
    set({ installing: true, installError: null, installProgress: {} });
    try {
      await reviewerInstall();
    } catch (error) {
      const message = String(error);
      set({ installError: message === "cancelled" ? null : message });
    } finally {
      set({ installing: false });
      await get().refresh();
    }
  },

  cancelInstall: async () => {
    await reviewerCancelInstall();
  },

  uninstall: async (withData) => {
    await reviewerUninstall(withData);
    set({ installProgress: {} });
    await get().refresh();
  },

  startServer: async () => {
    listen();
    try {
      const server = await reviewerServerStart();
      set({ server });
    } finally {
      await get().refresh();
    }
  },

  stopServer: async () => {
    await reviewerServerStop();
    await get().refresh();
  },

  saveConfig: async (patch) => {
    const current = get().status;
    if (!current) return;
    const config = { ...current.config, ...patch };
    set({ status: { ...current, config } });
    await reviewerSaveConfig(config);
  },

  applyRules: async () => {
    const report = await reviewerApplyRules();
    await get().refresh();
    return report;
  },

  saveServer: async (server, token) => {
    const servers = await reviewerSaveServer(server, token);
    const current = get().status;
    if (current) set({ status: { ...current, servers } });
  },

  deleteServer: async (id) => {
    await reviewerDeleteServer(id);
    await get().refresh();
  },

  loadProject: async (project) => {
    listen();
    const [stored, active] = await Promise.all([
      getSetting(projectConfigKey(project.id)).catch(() => null),
      reviewerActiveRun().catch(() => null),
    ]);
    let config = EMPTY_PROJECT_CONFIG;
    if (stored) {
      try {
        config = { ...EMPTY_PROJECT_CONFIG, ...(JSON.parse(stored) as Partial<ReviewerProjectConfig>) };
      } catch {
        config = EMPTY_PROJECT_CONFIG;
      }
    }
    const [suggestion, last] = await Promise.all([
      reviewerDetect(project.local_path, project.name, config.projectKey || undefined),
      reviewerLastRun(project.local_path, project.name, config.projectKey || undefined),
    ]);
    set((state) => {
      const runs = { ...state.runs };
      if (active && active.projectId === project.id) {
        runs[project.id] = {
          runId: active.runId,
          projectKey: active.projectKey,
          startedAt: active.startedAt,
          stages: active.stages,
          log: active.log,
          summary: null,
        };
      } else if (!runs[project.id] && last.summary) {
        runs[project.id] = {
          runId: last.summary.runId,
          projectKey: last.summary.projectKey,
          startedAt: last.summary.startedAt,
          stages: last.summary.stages,
          log: [],
          summary: last.summary,
        };
      }
      return {
        runs,
        activeProjectId: active ? active.projectId : null,
        suggestions: { ...state.suggestions, [project.id]: suggestion },
        projectConfigs: { ...state.projectConfigs, [project.id]: config },
        history: { ...state.history, [project.id]: last.history },
      };
    });
  },

  saveProjectConfig: async (projectId, config) => {
    set((state) => ({ projectConfigs: { ...state.projectConfigs, [projectId]: config } }));
    await setSetting(projectConfigKey(projectId), JSON.stringify(config));
  },

  run: async (project) => {
    listen();
    const config = get().projectConfigs[project.id] ?? EMPTY_PROJECT_CONFIG;
    const suggestion = get().suggestions[project.id];
    const commands = effectiveCommands(config, suggestion);
    await reviewerRun({
      projectId: project.id,
      repoPath: project.local_path,
      projectName: project.name,
      projectKey: config.projectKey,
      ...commands,
      exclusions: config.exclusions,
    });
  },

  cancel: async (projectId) => {
    const run = get().runs[projectId];
    if (run) await reviewerCancelRun(run.runId);
  },
}));

/** The commands a review runs: the user's once they have edited any, else what was detected. */
export function effectiveCommands(
  config: ReviewerProjectConfig,
  suggestion: ReviewerSuggestion | undefined,
): { prepare: string; build: string; test: string } {
  if (config.customized || !suggestion) {
    return { prepare: config.prepare, build: config.build, test: config.test };
  }
  return { prepare: suggestion.prepare, build: suggestion.build, test: suggestion.test };
}

let listening = false;

/** One set of listeners per window, attached the first time anything here is used. */
function listen(): void {
  if (listening) return;
  listening = true;
  void onReviewerServer((server) => {
    useReviewerStore.setState((state) => ({
      server,
      status: state.status ? { ...state.status, server } : state.status,
    }));
  });
  void onReviewerInstall((progress) => {
    useReviewerStore.setState((state) => ({ installProgress: { ...state.installProgress, [progress.item]: progress } }));
  });
  void onReviewerRun((event) => {
    const { projectId } = event;
    useReviewerStore.setState((state) => {
      const current = state.runs[projectId];
      switch (event.kind) {
        case "started":
          return {
            activeProjectId: projectId,
            runs: {
              ...state.runs,
              [projectId]: {
                runId: event.runId,
                projectKey: event.projectKey,
                startedAt: event.startedAt,
                stages: event.stages,
                log: [],
                summary: null,
              },
            },
          };
        case "stage": {
          if (!current || current.runId !== event.runId) return state;
          const stages = current.stages.map((stage) => (stage.id === event.stage.id ? event.stage : stage));
          return { runs: { ...state.runs, [projectId]: { ...current, stages } } };
        }
        case "log": {
          if (!current || current.runId !== event.runId) return state;
          const log = current.log.concat(event.lines);
          return {
            runs: {
              ...state.runs,
              [projectId]: { ...current, log: log.length > LOG_KEEP ? log.slice(log.length - LOG_KEEP) : log },
            },
          };
        }
        case "finished": {
          const base = current && current.runId === event.runId ? current : { log: [] as ReviewerLogLine[] };
          const entry: ReviewerHistoryEntry = {
            runId: event.summary.runId,
            finishedAt: event.summary.finishedAt,
            status: event.summary.status,
            gate: event.summary.gate?.status ?? null,
            coverage: event.summary.measures.coverage,
            reliabilityIssues: event.summary.measures.reliabilityIssues,
            securityIssues: event.summary.measures.securityIssues,
            maintainabilityIssues: event.summary.measures.maintainabilityIssues,
            testsFailed: event.summary.tests?.failed ?? null,
            commit: event.summary.commit,
          };
          return {
            activeProjectId: null,
            runs: {
              ...state.runs,
              [projectId]: {
                runId: event.runId,
                projectKey: event.summary.projectKey,
                startedAt: event.summary.startedAt,
                stages: event.summary.stages,
                log: base.log,
                summary: event.summary,
              },
            },
            history: { ...state.history, [projectId]: [...(state.history[projectId] ?? []), entry].slice(-30) },
          };
        }
      }
    });
    if (event.kind === "finished" && isMainWindow()) announce(event.summary);
  });
}

function announce(summary: ReviewerRunSummary): void {
  if (summary.status === "cancelled") return;
  const project = Object.values(useWorkspaceStore.getState().projectsByWorkspace)
    .flat()
    .find((p) => p.id === summary.projectId);
  notify({
    source: "reviewer",
    workspaceId: useWorkspaceStore.getState().workspaceOfProject(summary.projectId),
    status: summary.status === "passed" ? "success" : "error",
    titleKey:
      summary.status === "passed"
        ? "reviewer.notifyPassed"
        : summary.status === "failed"
          ? "reviewer.notifyFailed"
          : "reviewer.notifyError",
    params: { name: project?.name ?? summary.projectKey },
    target: { view: "reviewer", projectId: summary.projectId },
  });
}
