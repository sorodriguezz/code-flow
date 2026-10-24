import { create } from "zustand";
import {
  DEPS_CONFIG_KEY,
  depsAnalyze,
  depsCheckAlerts,
  depsConfigGet,
  depsReports,
  onDepsProgress,
  type DepsConfig,
  type DepsProgress,
  type DepsReport,
} from "../lib/tauri/depsCommands";
import { setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";
import { isMainWindow } from "../lib/windowIdentity";
import type { Project } from "../types/domain";
import { notify } from "./notificationStore";
import { saving } from "./powerSaveStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * «Salud de dependencias» (user, 2026-10-23): the last report of each repository, the analyses in
 * flight and the settings. Reports live on disk in the backend; this holds what was read of them.
 */
interface DepsState {
  config: DepsConfig | null;
  reports: Record<string, DepsReport>;
  progress: Record<string, DepsProgress>;
  analyzing: Record<string, boolean>;
  loadConfig: () => Promise<void>;
  saveConfig: (config: DepsConfig) => Promise<void>;
  loadReports: (projectIds: string[]) => Promise<void>;
  analyze: (projectId: string) => Promise<DepsReport>;
  /** One after another: registries are shared and OSV batches are per repository anyway. */
  analyzeMany: (projectIds: string[]) => Promise<void>;
}

let progressBound = false;

export const useDepsStore = create<DepsState>((set, get) => ({
  config: null,
  reports: {},
  progress: {},
  analyzing: {},

  loadConfig: async () => {
    set({ config: await depsConfigGet() });
  },

  saveConfig: async (config) => {
    set({ config });
    await setSetting(DEPS_CONFIG_KEY, JSON.stringify(config));
  },

  loadReports: async (projectIds) => {
    const missing = projectIds.filter((id) => !get().reports[id]);
    if (missing.length === 0) return;
    const found = await depsReports(missing);
    set((s) => ({ reports: { ...s.reports, ...Object.fromEntries(found.map((r) => [r.projectId, r])) } }));
  },

  analyze: async (projectId) => {
    if (!progressBound) {
      progressBound = true;
      void onDepsProgress((p) => set((s) => ({ progress: { ...s.progress, [p.projectId]: p } })));
    }
    set((s) => ({ analyzing: { ...s.analyzing, [projectId]: true } }));
    try {
      const report = await depsAnalyze(projectId);
      set((s) => ({ reports: { ...s.reports, [projectId]: report } }));
      return report;
    } finally {
      set((s) => {
        const { [projectId]: _a, ...analyzing } = s.analyzing;
        const { [projectId]: _p, ...progress } = s.progress;
        return { analyzing, progress };
      });
    }
  },

  analyzeMany: async (projectIds) => {
    for (const id of projectIds) {
      try {
        await get().analyze(id);
      } catch {
        // One repository that cannot be read (moved, busy) does not stop the others; its column
        // simply keeps its last report.
      }
    }
  },
}));

/** Every repository the app knows, across workspaces — what the daily check covers. */
function allProjects(): Project[] {
  return Object.values(useWorkspaceStore.getState().projectsByWorkspace).flat();
}

/** One tick an hour; the backend decides whether a day has passed since the last check. */
const TICK_MS = 60 * 60 * 1000;
/** Not in the boot rush: the first tick waits for the app to settle. */
const FIRST_TICK_MS = 3 * 60 * 1000;

export async function checkAdvisoriesNow(force = false): Promise<void> {
  // From Fuerte on, background work nobody asked for just now waits (`powerSaveStore`).
  if (!force && saving(2)) return;
  const projects = allProjects();
  if (projects.length === 0) return;
  const fresh = await depsCheckAlerts(
    projects.map((p) => p.id),
    force,
  );
  if (!fresh || fresh.length === 0) return;
  const byProject = new Map<string, typeof fresh>();
  for (const item of fresh) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item]);
  for (const [projectId, items] of byProject) {
    notify({
      source: "reviewer",
      workspaceId: useWorkspaceStore.getState().workspaceOfProject(projectId),
      status: "error",
      titleKey: items.length === 1 ? "deps.notifyNewAdvisory" : "deps.notifyNewAdvisories",
      params: { name: items[0].projectName, count: items.length },
      detail: items
        .slice(0, 4)
        .map((i) => `${i.name} ${i.version} · ${i.advisory.id}`)
        .join(" · "),
      target: { view: "reviewer", projectId },
    });
  }
}

let alertsStarted = false;

/** Starts the daily advisory check. Main window only: one window asks, every window hears. */
export function startDepsAlerts(): void {
  if (alertsStarted || !isMainWindow()) return;
  alertsStarted = true;
  const tick = () => void checkAdvisoriesNow().catch(() => {});
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, FIRST_TICK_MS);
  watchSettings([DEPS_CONFIG_KEY], () => void useDepsStore.getState().loadConfig().catch(() => {}));
}
