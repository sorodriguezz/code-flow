import { create } from "zustand";
import {
  detectTools,
  fetchVersions,
  springMetadata,
  type ScaffoldPlatform,
  type SpringMeta,
  type ToolStatus,
  type VersionLine,
  type VersionSource,
} from "../lib/scaffold/api";
import type { Options, PackageManager } from "../lib/scaffold/catalog";
import { DETECT_IDS } from "../lib/scaffold/tools";
import { getSetting, setSetting } from "../lib/tauri/commands";

/**
 * What the project initializer has learned about this machine and the registries, kept between
 * openings of the dialog.
 *
 * Detection runs a login shell and a dozen version probes — a second or two — so it happens once, the
 * first time the dialog opens, and again only when asked (the refresh button) or when an install
 * finishes. Registry answers are cached here per source as well as in Rust, so switching templates
 * back and forth redraws a picker instead of refetching it — and **they expire after an hour**, like
 * the backend's copy, so a release published while the app is open shows up without a restart.
 */

export interface Loadable<T> {
  status: "loading" | "ready" | "error";
  data: T | null;
  error: string | null;
  /** When `data` arrived. An answer older than `STALE_MS` is asked for again on its next use. */
  fetchedAt: number;
}

/** How long a registry answer is trusted: the backend's own cache lifetime (`versions::TTL`,
 *  `spring::META_TTL`). Stamped after the backend answered, so by the time this runs out the backend's
 *  copy has too, and a refresh never lands on an answer it is still holding. */
const STALE_MS = 60 * 60 * 1000;
/** After a refresh fails, how soon to try again. The lines already on screen stay; a flaky connection
 *  should neither park them for another hour nor turn every template switch into a request. */
const RETRY_MS = 5 * 60 * 1000;

/** Sources with a request in flight, so a refresh is never asked for twice at once. */
const inflight = new Set<string>();

function needsLoad<T>(entry: Loadable<T> | null | undefined): boolean {
  if (!entry || entry.status === "error") return true;
  if (entry.status === "loading") return false;
  return Date.now() - entry.fetchedAt >= STALE_MS;
}

/** A failed refresh keeps what it had and schedules the retry; a failed first load is an error. */
function afterFailure<T>(previous: Loadable<T> | null | undefined, error: unknown): Loadable<T> {
  return previous?.data
    ? { ...previous, status: "ready", fetchedAt: Date.now() - STALE_MS + RETRY_MS }
    : { status: "error", data: null, error: String(error), fetchedAt: 0 };
}

/** What is remembered between projects: the last template, where projects go, each template's own
 *  choices, and which install route the user took for a tool. One JSON setting. */
export interface ScaffoldPrefs {
  template?: string;
  parent?: string;
  pm?: PackageManager;
  commit?: boolean;
  options?: Record<string, Options>;
  recipes?: Record<string, string>;
}

const PREFS_KEY = "scaffold_prefs";

export function sourceKey(source: VersionSource): string {
  return source.kind === "runtime" ? `runtime:${source.product}` : `${source.kind}:${source.package}`;
}

interface ScaffoldState {
  platform: ScaffoldPlatform | null;
  tools: Record<string, ToolStatus>;
  detecting: boolean;
  detectError: string | null;
  versions: Record<string, Loadable<VersionLine[]>>;
  spring: Loadable<SpringMeta> | null;
  prefs: ScaffoldPrefs | null;

  /** Probes every tool the catalogue knows. `refresh` re-reads the login shell's `PATH` first. */
  detect: (refresh?: boolean) => Promise<void>;
  /** Fetches `source`'s lines unless a fresh answer is already here — cheap to call on every render
   *  that needs them, which is how the dialog keeps them current while it stays open. */
  loadVersions: (source: VersionSource) => void;
  loadSpring: () => void;
  loadPrefs: () => Promise<ScaffoldPrefs>;
  savePrefs: (patch: Partial<ScaffoldPrefs>) => void;
}

export const useScaffoldStore = create<ScaffoldState>((set, get) => ({
  platform: null,
  tools: {},
  detecting: false,
  detectError: null,
  versions: {},
  spring: null,
  prefs: null,

  detect: async (refresh = false) => {
    if (get().detecting) return;
    set({ detecting: true, detectError: null });
    try {
      const detection = await detectTools(DETECT_IDS, refresh);
      set({
        platform: detection.platform,
        tools: Object.fromEntries(detection.tools.map((tool) => [tool.id, tool])),
        detecting: false,
      });
    } catch (e) {
      set({ detecting: false, detectError: String(e) });
    }
  },

  loadVersions: (source) => {
    const key = sourceKey(source);
    const current = get().versions[key];
    if (inflight.has(key) || !needsLoad(current)) return;
    inflight.add(key);
    // A refresh keeps the lines it has on screen until new ones arrive — the picker must not blank
    // and lose its selection once an hour. Only a first load shows as loading.
    if (!current?.data) {
      set((s) => ({ versions: { ...s.versions, [key]: { status: "loading", data: null, error: null, fetchedAt: 0 } } }));
    }
    fetchVersions(source)
      .then((lines) =>
        set((s) => ({
          versions: { ...s.versions, [key]: { status: "ready", data: lines, error: null, fetchedAt: Date.now() } },
        })),
      )
      .catch((e) => set((s) => ({ versions: { ...s.versions, [key]: afterFailure(s.versions[key], e) } })))
      .finally(() => inflight.delete(key));
  },

  loadSpring: () => {
    const current = get().spring;
    if (inflight.has("spring") || !needsLoad(current)) return;
    inflight.add("spring");
    if (!current?.data) set({ spring: { status: "loading", data: null, error: null, fetchedAt: 0 } });
    springMetadata()
      .then((meta) => set({ spring: { status: "ready", data: meta, error: null, fetchedAt: Date.now() } }))
      .catch((e) => set((s) => ({ spring: afterFailure(s.spring, e) })))
      .finally(() => inflight.delete("spring"));
  },

  loadPrefs: async () => {
    const loaded = get().prefs;
    if (loaded) return loaded;
    let prefs: ScaffoldPrefs = {};
    try {
      const raw = await getSetting(PREFS_KEY);
      if (raw) prefs = JSON.parse(raw) as ScaffoldPrefs;
    } catch {
      // A malformed value is a fresh start, not an error worth a toast.
    }
    set({ prefs });
    return prefs;
  },

  savePrefs: (patch) => {
    const prefs = { ...(get().prefs ?? {}), ...patch };
    set({ prefs });
    void setSetting(PREFS_KEY, JSON.stringify(prefs)).catch(() => {});
  },
}));
