import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import {
  repoEnvDefaults,
  repoEnvScan,
  repoEnvUsage,
  type EnvGlobalConfig,
  type EnvRepoConfig,
  type EnvScan,
  type EnvUsage,
} from "../lib/tauri/envCommands";
import { GLOBAL_KEY, parseGlobalConfig, parseRepoConfig, repoKey } from "../lib/env/config";

/**
 * «Entorno»'s state: each repository's last scan and code reads, and the two settings rows that say
 * which files are read. **No value is ever held here** — a scan carries keys only, and a revealed
 * value lives in the one cell that asked for it (`EnvView`), gone with it.
 */

interface RepoEnvEntry {
  scan: EnvScan | null;
  usage: EnvUsage | null;
  loading: boolean;
  usageLoading: boolean;
  error: string | null;
}

interface RepoEnvState {
  byProject: Record<string, RepoEnvEntry>;
  repoConfig: Record<string, EnvRepoConfig>;
  global: EnvGlobalConfig | null;
  defaults: { patterns: string[]; exclude: string[] } | null;
  /** Scans `path` and reads its code, both at once; the scan arrives first. */
  load: (projectId: string, path: string) => Promise<void>;
  /** Only the files — after a move or a settings change, where the code did not change. */
  rescan: (projectId: string, path: string) => Promise<void>;
  loadConfig: (projectId: string) => Promise<EnvRepoConfig>;
  saveConfig: (projectId: string, path: string, config: EnvRepoConfig) => Promise<void>;
  loadGlobal: () => Promise<void>;
  saveGlobal: (config: EnvGlobalConfig) => Promise<void>;
}

const blank = (): RepoEnvEntry => ({ scan: null, usage: null, loading: false, usageLoading: false, error: null });

export const useRepoEnvStore = create<RepoEnvState>((set, get) => {
  const patch = (projectId: string, change: Partial<RepoEnvEntry>) =>
    set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? blank()), ...change } } }));

  return {
    byProject: {},
    repoConfig: {},
    global: null,
    defaults: null,

    load: async (projectId, path) => {
      patch(projectId, { loading: true, usageLoading: true, error: null });
      const usage = repoEnvUsage(projectId, path)
        .then((result) => patch(projectId, { usage: result, usageLoading: false }))
        .catch(() => patch(projectId, { usageLoading: false }));
      await get().rescan(projectId, path);
      await usage;
    },

    rescan: async (projectId, path) => {
      patch(projectId, { loading: true, error: null });
      try {
        const scan = await repoEnvScan(projectId, path);
        patch(projectId, { scan, loading: false });
      } catch (error) {
        patch(projectId, { loading: false, error: String(error) });
      }
    },

    loadConfig: async (projectId) => {
      const config = parseRepoConfig(await getSetting(repoKey(projectId)).catch(() => null));
      set((s) => ({ repoConfig: { ...s.repoConfig, [projectId]: config } }));
      if (!get().defaults) await get().loadGlobal();
      return config;
    },

    saveConfig: async (projectId, path, config) => {
      set((s) => ({ repoConfig: { ...s.repoConfig, [projectId]: config } }));
      await setSetting(repoKey(projectId), JSON.stringify(config));
      await get().rescan(projectId, path);
    },

    loadGlobal: async () => {
      const [raw, defaults] = await Promise.all([getSetting(GLOBAL_KEY).catch(() => null), repoEnvDefaults()]);
      set({ global: parseGlobalConfig(raw), defaults });
    },

    saveGlobal: async (config) => {
      set({ global: config });
      await setSetting(GLOBAL_KEY, JSON.stringify(config));
    },
  };
});

/** The patterns the app reads by default: the saved ones, or the shipped list. */
export function globalPatterns(state: Pick<RepoEnvState, "global" | "defaults">): string[] {
  return state.global?.patterns ?? state.defaults?.patterns ?? [];
}

export function globalExclude(state: Pick<RepoEnvState, "global" | "defaults">): string[] {
  return state.global?.exclude ?? state.defaults?.exclude ?? [];
}
