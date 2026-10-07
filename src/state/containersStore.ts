import { create } from "zustand";
import {
  containersAct,
  containersDetect,
  containersForwardClose,
  containersForwardOpen,
  containersForwards,
  containersKubeOrigins,
  containersKubeTest,
  containersList,
  containersNamespaces,
  containersReach,
  containersStartRuntime,
  containersStats,
} from "../lib/tauri/containersCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { pushErrorToast, pushSuccessToast } from "./toastStore";
import type { ContainerSelection, ContainerStats, ForwardView, KubeContextOrigin, KubeTest, RuntimeId, RuntimeInfo } from "../types/containers";

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
 *
 * **A cluster is asked whether it answers once, not on every visit.** `kubectl version` against a
 * remote cluster costs seconds — an auth plugin starting, a DNS lookup that fails slowly — so its
 * answer (`reach`, `kubeTests`) is kept with the time it was given and reused while it is fresh:
 * leaving the cluster's page and coming back, or closing the dock and opening it again, shows what
 * was found a minute ago instead of asking again. «Probar» and the navigation's refresh ask anew.
 *
 * **Disconnecting is the panel's, not kubeconfig's.** «Desconectar» leaves Kubernetes with no cluster
 * (`kubeDisconnected`): nothing is read from it, its port-forwards are closed, its pages and their log
 * and shell sessions let go. The user's kubeconfig, its current context and the credentials an auth
 * plugin keeps are untouched — a terminal's kubectl goes on working. Kept across launches, so a
 * disconnected panel does not fall back to kubeconfig's current context on the next start; picking a
 * cluster connects again.
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
  /** Kubernetes: disconnected on purpose — no cluster, rather than kubeconfig's current one. */
  kubeDisconnected?: boolean;
}

const DEFAULT_PREFS: Prefs = {
  open: ["docker", "docker|containers", "podman", "podman|containers", "nerdctl", "nerdctl|containers", "kubernetes", "kubernetes|pods"],
  nav: { runtime: null, section: "containers" },
  context: {},
  namespace: {},
  kubeDisconnected: false,
};

export const listKey = (runtime: string, context: string | null, namespace: string | null, what: string) =>
  `${runtime}|${context ?? ""}|${namespace ?? ""}|${what}`;

/** How long a cluster's answer — it answers, it does not and why — stands before a visit asks again. */
export const KUBE_CHECK_FRESH_MS = 10 * 60_000;

/** A context's connection test on the cluster page: the last answer, and whether one is on its way. */
export interface KubeTestState {
  result: KubeTest | null;
  testing: boolean;
  /** When `result` came back, ms since the epoch; 0 = never. */
  at: number;
}

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
  /** Whether a Kubernetes context's cluster answers: its version, or the reason it does not, and
   *  when that was found out. */
  reach: Record<string, { ok: boolean; text: string; at: number }>;
  /** The cluster page's connection test per context — with the hint that says what fixes it. */
  kubeTests: Record<string, KubeTestState>;
  /** Which kubeconfig each context comes from; `null` until first read. */
  kubeOrigins: KubeContextOrigin[] | null;
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
  /** Leaves Kubernetes with no cluster: see the note above. Port-forwards it holds are closed. */
  disconnectKube: () => Promise<void>;
  namespaceOf: (context: string | null) => string;
  setNamespace: (context: string | null, namespace: string) => void;
  /** Read once per context; `force` reads them again (the navigation's refresh). */
  loadNamespaces: (context: string | null, opts?: { force?: boolean }) => Promise<void>;
  /** Asks the cluster unless a fresh answer is kept; `force` asks regardless. */
  checkReach: (context: string | null, opts?: { force?: boolean }) => Promise<void>;
  /** The cluster page's test of one context — kept like `reach`, which it also answers. */
  testKube: (context: string, opts?: { force?: boolean }) => Promise<void>;
  loadKubeOrigins: () => Promise<void>;
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
/** Reach checks and connection tests on their way, per context — a second caller joins the first. */
const reachInflight = new Map<string, Promise<void>>();
const testInflight = new Map<string, Promise<void>>();

const fresh = (at: number | undefined) => at !== undefined && at > 0 && Date.now() - at < KUBE_CHECK_FRESH_MS;

/**
 * Records whether a context's cluster answers. A cluster that did not and now does gets its lists
 * read at once (the pulse skips a cluster known not to answer) and its namespaces, which the
 * navigation did not ask for while it was down.
 */
function noteReach(context: string, ok: boolean, text: string, at = Date.now()) {
  const store = useContainersStore;
  const before = store.getState().reach[context];
  store.setState((s) => ({ reach: { ...s.reach, [context]: { ok, text, at } } }));
  if (ok && before && !before.ok) {
    void store.getState().loadNamespaces(context);
    void store.getState().pulse();
  }
}

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
  kubeTests: {},
  kubeOrigins: null,
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
            kubeDisconnected: parsed.kubeDisconnected === true,
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
    if (runtime === "kubernetes" && get().prefs.kubeDisconnected) return null;
    const info = get().runtimes.find((r) => r.id === runtime);
    const chosen = get().prefs.context[runtime];
    if (chosen && info?.contexts.some((c) => c.name === chosen)) return chosen;
    if (runtime === "nerdctl" || runtime === "ctr") return chosen || "default";
    return info?.currentContext ?? info?.contexts[0]?.name ?? null;
  },
  setContext: (runtime, context) => {
    const prefs = get().prefs;
    const next = { ...prefs, context: { ...prefs.context, [runtime]: context }, kubeDisconnected: runtime === "kubernetes" ? false : prefs.kubeDisconnected };
    set({ prefs: next, selection: get().selection?.runtime === runtime ? null : get().selection });
    savePrefs(next);
    void get().pulse();
  },
  disconnectKube: async () => {
    const context = get().contextOf("kubernetes");
    if (!context) return;
    const prefs = get().prefs;
    // Back to the clusters' page: a kind's page has no cluster to read now.
    const next: Prefs = { ...prefs, kubeDisconnected: true, nav: prefs.nav.runtime === "kubernetes" ? { runtime: "kubernetes", section: "overview" } : prefs.nav };
    // Its rows go too: a page that came back to them would show a cluster nobody is reading.
    const prefix = `kubernetes|${context}|`;
    set((s) => ({
      prefs: next,
      selection: s.selection?.runtime === "kubernetes" ? null : s.selection,
      lists: Object.fromEntries(Object.entries(s.lists).filter(([key]) => !key.startsWith(prefix))),
    }));
    savePrefs(next);
    const forwards = get().forwards.filter((f) => f.context === context);
    if (forwards.length === 0) return;
    await Promise.all(forwards.map((f) => containersForwardClose(f.id).catch(() => {})));
    await get().loadForwards();
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
  loadNamespaces: async (context, opts) => {
    if (!opts?.force && get().namespaces[context ?? ""]) return;
    try {
      const names = await containersNamespaces("kubernetes", context);
      set((s) => ({ namespaces: { ...s.namespaces, [context ?? ""]: names } }));
    } catch {
      // The reach check says why; the picker keeps "all namespaces".
    }
  },
  checkReach: (context, opts) => {
    const key = context ?? "";
    if (!opts?.force && fresh(get().reach[key]?.at)) return Promise.resolve();
    const running = reachInflight.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        noteReach(key, true, await containersReach(context));
      } catch (error) {
        noteReach(key, false, String(error));
      } finally {
        reachInflight.delete(key);
      }
    })();
    reachInflight.set(key, task);
    return task;
  },
  testKube: (context, opts) => {
    if (!opts?.force && fresh(get().kubeTests[context]?.at)) return Promise.resolve();
    const running = testInflight.get(context);
    if (running) return running;
    const task = (async () => {
      set((s) => ({ kubeTests: { ...s.kubeTests, [context]: { result: s.kubeTests[context]?.result ?? null, at: s.kubeTests[context]?.at ?? 0, testing: true } } }));
      try {
        const result = await containersKubeTest(context).catch((e: unknown): KubeTest => ({ ok: false, version: null, error: String(e), hint: null }));
        const at = Date.now();
        set((s) => ({ kubeTests: { ...s.kubeTests, [context]: { result, at, testing: false } } }));
        // The same question the navigation's dot asks: one answer serves both — stamped alike, so the
        // cluster page knows this test is not older than the dot's answer.
        noteReach(context, result.ok, result.ok ? (result.version ?? "") : (result.error ?? ""), at);
      } finally {
        testInflight.delete(context);
      }
    })();
    testInflight.set(context, task);
    return task;
  },
  loadKubeOrigins: async () => {
    try {
      set({ kubeOrigins: await containersKubeOrigins() });
    } catch {
      set((s) => ({ kubeOrigins: s.kubeOrigins ?? [] }));
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
      // A cluster disconnected while its read was on its way: the answer has nowhere to go.
      const dropped = () => runtime === "kubernetes" && get().contextOf("kubernetes") === null;
      try {
        const rows = await containersList<unknown>(runtime, context, namespace, what);
        if (!dropped()) set((s) => ({ lists: { ...s.lists, [key]: { rows, error: null, at: Date.now(), loading: false } } }));
      } catch (error) {
        if (!dropped()) set((s) => ({ lists: { ...s.lists, [key]: { rows: s.lists[key]?.rows ?? [], error: String(error), at: Date.now(), loading: false } } }));
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
