import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";

/**
 * The files last opened in each repository, newest first — VS Code's "recently opened" at the top of
 * Quick Open, and «Abrir reciente». Kept in settings, so they survive a restart and every window of
 * the app sees the same list.
 */

const KEY = "editor_recent_files";
/** Files remembered per repository, and repositories remembered at all. */
const PER_REPO = 50;
const REPOS = 30;
/** Writes are batched: switching tabs quickly is one write, not ten. */
const WRITE_DELAY_MS = 800;

interface RecentFilesState {
  byRepo: Record<string, string[]>;
  loaded: boolean;
  init: () => Promise<void>;
  touch: (repoPath: string, path: string) => void;
  forget: (repoPath: string, path: string) => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let loading: Promise<void> | null = null;

function persist(byRepo: Record<string, string[]>) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void setSetting(KEY, JSON.stringify(byRepo)).catch(() => undefined), WRITE_DELAY_MS);
}

/** The stored map, or `{}` for anything that is not one. */
export function parseRecent(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string[]> = {};
    for (const [repo, paths] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(paths)) out[repo] = paths.filter((path): path is string => typeof path === "string").slice(0, PER_REPO);
    }
    return out;
  } catch {
    return {};
  }
}

/** `path` to the front of `repo`'s list, and `repo` to the front of the map. */
export function withTouched(byRepo: Record<string, string[]>, repo: string, path: string): Record<string, string[]> {
  const list = [path, ...(byRepo[repo] ?? []).filter((entry) => entry !== path)].slice(0, PER_REPO);
  const others = Object.entries(byRepo).filter(([key]) => key !== repo).slice(0, REPOS - 1);
  return Object.fromEntries([[repo, list], ...others]);
}

export const useRecentFilesStore = create<RecentFilesState>((set, get) => ({
  byRepo: {},
  loaded: false,
  init: () =>
    (loading ??= getSettings([KEY])
      .then((stored) => {
        // Anything touched before the read landed stays in front of what was stored.
        const stored_ = parseRecent(stored[KEY]);
        let merged = stored_;
        for (const [repo, paths] of Object.entries(get().byRepo)) {
          for (const path of [...paths].reverse()) merged = withTouched(merged, repo, path);
        }
        set({ byRepo: merged, loaded: true });
      })
      .catch(() => set({ loaded: true }))),
  touch: (repoPath, path) => {
    const current = get().byRepo[repoPath];
    if (current?.[0] === path) return;
    const byRepo = withTouched(get().byRepo, repoPath, path);
    set({ byRepo });
    if (get().loaded) persist(byRepo);
  },
  forget: (repoPath, path) => {
    const byRepo = { ...get().byRepo, [repoPath]: (get().byRepo[repoPath] ?? []).filter((entry) => entry !== path) };
    set({ byRepo });
    persist(byRepo);
  },
}));
