import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";

/** One "Resolve with AI" outcome — the confirmation text Claude returned after applying a fix to
 * a finding or a PR comment, plus when it happened. Kept so the result survives leaving and
 * re-opening the panel / switching repositories / restarting the app: the fix itself lives in the
 * working tree, but without this the "esto fue lo que resolví" note vanished the moment the card
 * unmounted, which read as the work being lost. */
export interface ResolutionRecord {
  text: string;
  at: number;
}

type ProjectResolutions = Record<string, ResolutionRecord>;

interface ResolutionsState {
  /** `byProject[projectId][resolutionKey]` — the key is a stable, caller-chosen id for the
   * finding/comment (see the `resolutionKey` props threaded through `FindingCard` /
   * `PrCommentCard`), so the same finding maps to the same record across reloads. */
  byProject: Record<string, ProjectResolutions>;
  loaded: Record<string, boolean>;
  /** Hydrates a project's saved resolutions from the settings KV store. Runs once per project per
   * session; in-memory records (a resolution just made this session) win over the disk copy. */
  load: (projectId: string) => Promise<void>;
  /** Records (and persists) one resolution. */
  save: (projectId: string, key: string, text: string) => void;
  /** Forgets one resolution — used by the card's dismiss (×) control. */
  clear: (projectId: string, key: string) => void;
}

export const EMPTY_RESOLUTIONS: ProjectResolutions = {};

const settingKey = (projectId: string) => `ai_resolutions_${projectId}`;

/** Persist best-effort — a failed write just means the resolution is session-only, which is no
 * worse than before this store existed, so it must never surface an error to the user. */
function persist(projectId: string, map: ProjectResolutions) {
  void setSetting(settingKey(projectId), JSON.stringify(map)).catch(() => {});
}

export const useResolutionsStore = create<ResolutionsState>((set, get) => ({
  byProject: {},
  loaded: {},

  load: async (projectId) => {
    if (get().loaded[projectId]) return;
    // Set synchronously before the await so a double-invoked effect (dev StrictMode) can't both
    // pass the guard and fire two reads.
    set((s) => ({ loaded: { ...s.loaded, [projectId]: true } }));

    const raw = await getSetting(settingKey(projectId)).catch(() => null);
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt blob — ignore rather than throw
    }
    if (!parsed || typeof parsed !== "object") return;
    set((s) => ({
      byProject: {
        ...s.byProject,
        // In-memory (fresh this session) takes precedence over the disk copy for the same key.
        [projectId]: { ...(parsed as ProjectResolutions), ...(s.byProject[projectId] ?? {}) },
      },
    }));
  },

  save: (projectId, key, text) => {
    set((s) => {
      const next = { ...(s.byProject[projectId] ?? {}), [key]: { text, at: Date.now() } };
      persist(projectId, next);
      return { byProject: { ...s.byProject, [projectId]: next } };
    });
  },

  clear: (projectId, key) => {
    set((s) => {
      const next = { ...(s.byProject[projectId] ?? {}) };
      delete next[key];
      persist(projectId, next);
      return { byProject: { ...s.byProject, [projectId]: next } };
    });
  },
}));
