import { create } from "zustand";
import {
  containersAct,
  containersDetect,
  containersForwardClose,
  containersForwardOpen,
  containersForwards,
  containersList,
  containersNamespaces,
  containersReach,
  containersStartRuntime,
  containersStats,
} from "../lib/tauri/containersCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { pushErrorToast, pushSuccessToast } from "./toastStore";
import type { ContainerSelection, ContainerStats, ForwardView, RuntimeId, RuntimeInfo } from "../types/containers";

/**
 * The Contenedores panel: which runtimes this computer has, what each holds, and what is picked.
 *
 * **A mirror, refreshed while looked at.** Nothing here is pushed by the engines: the lists are read
 * again on a short timer while the panel is on screen (`ContainersPanel` drives `pulse`), right after
 * every action, and on demand. A hidden panel reads nothing — `docker ps` every few seconds for a panel
 * nobody sees is a fan that spins for no one.
 *
 * **Machine-wide, not per workspace.** Containers and clusters belong to the computer, so the panel
 * shows the same thing whichever workspace is open, and its preferences (folds, contexts, namespaces)
 * are one setting, `containers_prefs`.
 *
 * **An action goes where its rows came from.** A context the user never picked follows the one the
 * tool considers current — kubeconfig's `current-context`, `docker context use` — which a terminal can
 * switch under the panel at any moment (`detect` re-reads it). So every action and port-forward is
 * given the context its rows were read from and never resolves one itself, and a selection made under a
 * context that is no longer in force is let go: its pane would show staging's rows while Delete went to
 * prod.
 */

const PREFS_KEY = "containers_prefs";

export interface ListState {
  rows: unknown[];
  error: string | null;
  /** When it was last read, ms since the epoch; 0 = never. */
  at: number;
  loading: boolean;
}

/** What an engine's page lists — lite-dock's views, without its engine settings. */
export type EngineSection = "overview" | "containers" | "images" | "volumes" | "networks" | "compose" | "build";

/** Where the manager is: a runtime, and one of its sections (an `EngineSection`, or a Kubernetes kind). */
export interface ContainersNav {
  runtime: RuntimeId | null;
  section: string;
}

interface Prefs {
  /** Section keys unfolded: `runtime`, `runtime|list`, `runtime|project:<name>`. */
  open: string[];
  /** The page on screen, kept across launches. */
  nav: ContainersNav;
  /** The context (Docker), connection (Podman), namespace (containerd) or cluster (Kubernetes) per runtime. */
  context: Record<string, string>;
  /** Kubernetes: the namespace per context; `""` = all. */
  namespace: Record<string, string>;
}

const DEFAULT_PREFS: Prefs = {
  open: ["docker", "docker|containers", "podman", "podman|containers", "nerdctl", "nerdctl|containers", "kubernetes", "kubernetes|pods"],
  nav: { runtime: null, section: "containers" },
  context: {},
  namespace: {},
};

export const listKey = (runtime: string, context: string | null, namespace: string | null, what: string) =>
  `${runtime}|${context ?? ""}|${namespace ?? ""}|${what}`;

interface ContainersState {
  runtimes: RuntimeInfo[];
  /** The first detection has answered. */
  detected: boolean;
  detecting: boolean;
  /** A runtime being started ("Iniciar"), by id. */
  starting: Record<string, boolean>;
  lists: Record<string, ListState>;
  prefs: Prefs;
  prefsLoaded: boolean;
  /** Kubernetes namespaces, per context. */
  namespaces: Record<string, string[]>;
  /** Whether a Kubernetes context's cluster answers: its version, or the reason it does not. */
  reach: Record<string, { ok: boolean; text: string }>;
  selection: ContainerSelection | null;
  forwards: ForwardView[];
  /** Actions in flight, by `object|id`, so a row shows it is busy and refuses a second click. */
  busy: Record<string, boolean>;
  /** Live stats of an engine's running containers, by `listKey(runtime, context, null, "stats")`. */
  stats: Record<string, ContainerStats[]>;
  /** A dialog of the manager that is open — adding a cluster, or a remote engine. */
  dialog: "cluster" | "engine" | null;
  setDialog: (dialog: "cluster" | "engine" | null) => void;

  /** The page on screen; a runtime that is gone (or never was) falls back to the first one there is. */
  nav: () => ContainersNav;
  setNav: (nav: ContainersNav) => void;
  loadStats: (runtime: RuntimeId) => Promise<void>;

  loadPrefs: () => Promise<void>;
  detect: () => Promise<void>;
  startRuntime: (runtime: RuntimeInfo) => Promise<void>;
  isOpen: (key: string) => boolean;
  toggleOpen: (key: string, open?: boolean) => void;
  contextOf: (runtime: RuntimeId) => string | null;
  setContext: (runtime: RuntimeId, context: string) => void;
  namespaceOf: (context: string | null) => string;
  setNamespace: (context: string | null, namespace: string) => void;
  loadNamespaces: (context: string | null) => Promise<void>;
  checkReach: (context: string | null) => Promise<void>;
  refreshList: (runtime: RuntimeId, what: string) => Promise<void>;
  /** Re-reads every list that is unfolded — the panel's timer. */
  pulse: () => Promise<void>;
  select: (selection: ContainerSelection | null) => void;
  act: (args: {
    runtime: RuntimeId;
    /** The context (connection, containerd namespace) the rows acted on were read from — never
     *  re-resolved here, see the note above. */
    context: string | null;
    object: string;
    action: string;
    ids: string[];
    label: string;
    namespace?: string | null;
    options?: Record<string, unknown>;
    /** Lists to read again afterwards; the action's own by default. */
    refresh?: string[];
    quiet?: boolean;
  }) => Promise<string | null>;
  loadForwards: () => Promise<void>;
  openForward: (args: { context: string | null; kind: string; name: string; namespace: string; remotePort: number; localPort?: number }) => Promise<ForwardView | null>;
  closeForward: (id: string) => Promise<void>;
}

let savePrefsTimer: ReturnType<typeof setTimeout> | null = null;
function savePrefs(prefs: Prefs) {
  if (savePrefsTimer) clearTimeout(savePrefsTimer);
  savePrefsTimer = setTimeout(() => void setSetting(PREFS_KEY, JSON.stringify(prefs)).catch(() => {}), 400);
}

/** The list an object's action changes, for reading it again. */
function listOf(object: string): string {
  switch (object) {
    case "container":
    case "project":
      return "containers";
    case "image":
      return "images";
    case "volume":
      return "volumes";
    case "network":
      return "networks";
    default:
      return object;
  }
}

const inflight = new Map<string, Promise<void>>();

export const useContainersStore = create<ContainersState>((set, get) => ({
  runtimes: [],
  detected: false,
  detecting: false,
  starting: {},
  lists: {},
  prefs: DEFAULT_PREFS,
  prefsLoaded: false,
  namespaces: {},
  reach: {},
  selection: null,
  forwards: [],
  busy: {},
  stats: {},
  dialog: null,
  setDialog: (dialog) => set({ dialog }),

  nav: () => {
    const { prefs, runtimes } = get();
    const chosen = prefs.nav.runtime ? runtimes.find((r) => r.id === prefs.nav.runtime) : undefined;
    if (chosen) return prefs.nav;
    // The first engine that answers, else the first one found — Kubernetes last, being remote.
    const fallback = runtimes.find((r) => r.id !== "kubernetes" && r.running) ?? runtimes.find((r) => r.id !== "kubernetes") ?? runtimes[0];
    if (!fallback) return { runtime: null, section: "containers" };
    return { runtime: fallback.id, section: fallback.id === "kubernetes" ? "pods" : "containers" };
  },
  setNav: (nav) => {
    const prefs = get().prefs;
    if (prefs.nav.runtime === nav.runtime && prefs.nav.section === nav.section && !get().selection) return;
    const next = { ...prefs, nav };
    set({ prefs: next, selection: null });
    savePrefs(next);
    void get().pulse();
  },
  loadStats: async (runtime) => {
    const context = get().contextOf(runtime);
    const key = listKey(runtime, context, null, "stats");
    try {
      const stats = await containersStats(runtime, context, null);
      set((s) => ({ stats: { ...s.stats, [key]: stats } }));
    } catch {
      // A sample that failed keeps the last one; the next tick tries again.
    }
  },

  loadPrefs: async () => {
    if (get().prefsLoaded) return;
    try {
      const raw = await getSetting(PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Prefs>;
        set({
          prefs: {
            open: Array.isArray(parsed.open) ? parsed.open.filter((k) => typeof k === "string") : DEFAULT_PREFS.open,
            nav:
              parsed.nav && typeof parsed.nav === "object" && typeof parsed.nav.section === "string"
                ? { runtime: (parsed.nav.runtime as RuntimeId | null) ?? null, section: parsed.nav.section }
                : DEFAULT_PREFS.nav,
            context: parsed.context && typeof parsed.context === "object" ? parsed.context : {},
            namespace: parsed.namespace && typeof parsed.namespace === "object" ? parsed.namespace : {},
          },
        });
      }
    } catch {
      // Unreadable preferences are the defaults.
    }
    set({ prefsLoaded: true });
  },

  detect: async () => {
    if (get().detecting) return;
    set({ detecting: true });
    try {
      const runtimes = await containersDetect();
      set({ runtimes, detected: true });
      // The context a runtime resolves to may have moved (a terminal switched it, the one picked is
      // gone): a selection made under the old one no longer matches what the tree shows.
      const selection = get().selection;
      if (selection && selection.context !== get().contextOf(selection.runtime)) set({ selection: null });
    } catch (error) {
      set({ detected: true });
      pushErrorToast(String(error));
    } finally {
      set({ detecting: false });
    }
  },

  startRuntime: async (runtime) => {
    if (!runtime.start || get().starting[runtime.id]) return;
    set((s) => ({ starting: { ...s.starting, [runtime.id]: true } }));
    try {
      await containersStartRuntime(runtime.start);
      // A VM takes a moment past its command returning before its socket answers.
      for (let attempt = 0; attempt < 20; attempt++) {
        await get().detect();
        if (get().runtimes.find((r) => r.id === runtime.id)?.running) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      void get().pulse();
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      set((s) => ({ starting: { ...s.starting, [runtime.id]: false } }));
    }
  },

  isOpen: (key) => get().prefs.open.includes(key),
  toggleOpen: (key, open) => {
    const prefs = get().prefs;
    const isOpen = prefs.open.includes(key);
    const want = open ?? !isOpen;
    if (want === isOpen) return;
    const next = { ...prefs, open: want ? [...prefs.open, key] : prefs.open.filter((k) => k !== key) };
    set({ prefs: next });
    savePrefs(next);
  },

  contextOf: (runtime) => {
    const info = get().runtimes.find((r) => r.id === runtime);
    const chosen = get().prefs.context[runtime];
    if (chosen && info?.contexts.some((c) => c.name === chosen)) return chosen;
    if (runtime === "nerdctl" || runtime === "ctr") return chosen || "default";
    return info?.currentContext ?? info?.contexts[0]?.name ?? null;
  },
  setContext: (runtime, context) => {
    const prefs = get().prefs;
    const next = { ...prefs, context: { ...prefs.context, [runtime]: context } };
    set({ prefs: next, selection: get().selection?.runtime === runtime ? null : get().selection });
    savePrefs(next);
    void get().pulse();
  },

  namespaceOf: (context) => {
    const key = context ?? "";
    const chosen = get().prefs.namespace[key];
    if (chosen !== undefined) return chosen;
    const info = get().runtimes.find((r) => r.id === "kubernetes");
    return info?.contexts.find((c) => c.name === context)?.namespace || "";
  },
  setNamespace: (context, namespace) => {
    const prefs = get().prefs;
    const next = { ...prefs, namespace: { ...prefs.namespace, [context ?? ""]: namespace } };
    set({ prefs: next, selection: get().selection?.runtime === "kubernetes" ? null : get().selection });
    savePrefs(next);
    void get().pulse();
  },
  loadNamespaces: async (context) => {
    try {
      const names = await containersNamespaces("kubernetes", context);
      set((s) => ({ namespaces: { ...s.namespaces, [context ?? ""]: names } }));
    } catch {
      // The reach check says why; the picker keeps "all namespaces".
    }
  },
  checkReach: async (context) => {
    try {
      const version = await containersReach(context);
      set((s) => ({ reach: { ...s.reach, [context ?? ""]: { ok: true, text: version } } }));
    } catch (error) {
      set((s) => ({ reach: { ...s.reach, [context ?? ""]: { ok: false, text: String(error) } } }));
    }
  },

  refreshList: (runtime, what) => {
    const context = get().contextOf(runtime);
    const namespace = runtime === "kubernetes" ? get().namespaceOf(context) : null;
    const key = listKey(runtime, context, namespace, what);
    const running = inflight.get(key);
    if (running) return running;
    const task = (async () => {
      set((s) => ({ lists: { ...s.lists, [key]: { ...(s.lists[key] ?? { rows: [], error: null, at: 0 }), loading: true } } }));
      try {
        const rows = await containersList<unknown>(runtime, context, namespace, what);
        set((s) => ({ lists: { ...s.lists, [key]: { rows, error: null, at: Date.now(), loading: false } } }));
      } catch (error) {
        set((s) => ({ lists: { ...s.lists, [key]: { rows: s.lists[key]?.rows ?? [], error: String(error), at: Date.now(), loading: false } } }));
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    return task;
  },

  pulse: async () => {
    const { runtimes } = get();
    const nav = get().nav();
    const jobs: Promise<void>[] = [];
    for (const runtime of runtimes) {
      if (!runtime.running) continue;
      if (runtime.id === "kubernetes") {
        // A cluster is remote and may be slow or far: only the kind on screen is read, never all of
        // them for counts.
        if (nav.runtime !== "kubernetes") continue;
        const context = get().contextOf("kubernetes");
        if (!context || get().reach[context]?.ok === false) continue;
        if (nav.section && nav.section !== "overview") jobs.push(get().refreshList("kubernetes", nav.section));
        continue;
      }
      // Every engine's containers, for the counts beside it; the rest only for the engine on screen.
      jobs.push(get().refreshList(runtime.id, "containers"));
      if (nav.runtime === runtime.id) {
        for (const what of ["images", "volumes", "networks"]) jobs.push(get().refreshList(runtime.id, what));
      }
    }
    await Promise.all(jobs);
  },

  // A row clicked in a frame drawn before the context moved belongs to the old one: not selected.
  select: (selection) => set({ selection: selection && selection.context !== get().contextOf(selection.runtime) ? null : selection }),

  act: async ({ runtime, context, object, action, ids, label, namespace, options, refresh, quiet }) => {
    const busyKey = `${object}|${ids.join(",")}`;
    if (get().busy[busyKey]) return null;
    set((s) => ({ busy: { ...s.busy, [busyKey]: true } }));
    try {
      const out = await containersAct({ runtime, context, namespace: namespace ?? null, object, action, ids, options });
      if (!quiet) pushSuccessToast(label);
      return out;
    } catch (error) {
      pushErrorToast(`${label}: ${String(error)}`);
      return null;
    } finally {
      set((s) => {
        const busy = { ...s.busy };
        delete busy[busyKey];
        return { busy };
      });
      for (const what of refresh ?? [listOf(object)]) void get().refreshList(runtime, what);
    }
  },

  loadForwards: async () => {
    try {
      set({ forwards: await containersForwards() });
    } catch {
      // Nothing to show.
    }
  },
  openForward: async ({ context, kind, name, namespace, remotePort, localPort }) => {
    try {
      const view = await containersForwardOpen({ context, namespace: namespace || null, kind, name, remotePort, localPort: localPort ?? 0 });
      await get().loadForwards();
      return view;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },
  closeForward: async (id) => {
    await containersForwardClose(id).catch(() => {});
    await get().loadForwards();
  },
}));
