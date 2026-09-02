import { create } from "zustand";
import * as api from "../lib/tauri/services";
import { closeTerminal } from "../lib/tauri/commands";
import { onTerminalExit, onTerminalOutput } from "../lib/tauri/events";
import { isMainWindow } from "../lib/windowIdentity";
import { pushErrorToast } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  serviceDeps,
  type ServiceGroup,
  type ServiceRow,
  type ServiceRuntime,
  type ServiceStatus,
} from "../types/services";

/**
 * The Services workspace: what is defined, what is running, and the order it comes up in.
 *
 * # Why the executor is here and not in Rust
 *
 * The gate that matters most is *"this line appeared in the output"*, and the output is already
 * streaming into the frontend through `terminal:output`. Moving the dependency graph to Rust to
 * save a round trip per probe would mean re-implementing that stream on the other side of it. What
 * genuinely cannot happen in a webview — opening a TCP socket, making an arbitrary HTTP request —
 * is exactly the two commands this calls (`probe_port`, `probe_http`) and nothing else.
 *
 * # One executor, in the main window
 *
 * Same rule as `chainStore.pump`, same reason: two windows starting the same group would spawn two
 * `docker compose up` against one project. Services is a main-window app and is not detachable at
 * all, so this is belt as well as braces — but the guard is here rather than in the view, because a
 * view is not what makes something run.
 *
 * # What is not stored
 *
 * Every field on [`ServiceRuntime`] is in memory only. A pid written to SQLite is a claim about a
 * process that died with the previous launch, and the list would be confidently wrong every
 * morning. On launch nothing is running, which is the truth.
 */

/** How long a gate is given before the service is called failed. Ninety seconds is a cold
 *  `docker compose up` pulling nothing, plus room — and it is a *ceiling*, not a wait: the moment
 *  the gate passes, the next service starts. */
const GATE_TIMEOUT_MS = 90_000;

/** How often a port or an HTTP gate is asked again. Fast enough that the cascade does not feel
 *  padded, slow enough that a minute of waiting is 120 probes rather than thousands. */
const GATE_POLL_MS = 500;

/** Per-probe timeout. Short: a closed port on loopback refuses immediately, and a long timeout
 *  would make each poll cycle drag rather than making the answer more accurate. */
const PROBE_TIMEOUT_MS = 800;

/**
 * How many times a crashed service restarts itself before it is left alone.
 *
 * A cap and not a switch, because the failure mode is silent and expensive: a service that cannot
 * bind its port restarts in a tight loop, and what the user notices is the fan. Three attempts is
 * enough to ride out a database that was still coming up; the fourth is a real problem to look at.
 */
const MAX_AUTORESTARTS = 3;

function idle(): ServiceRuntime {
  return { status: "stopped", sessionId: null, startedAt: null, error: "", blockedBy: null, restarts: 0 };
}

interface ServicesState {
  services: ServiceRow[];
  groups: ServiceGroup[];
  /** Live state per service id. Absent means [`idle`] — the map only holds services that have been
   *  touched this session. */
  runtime: Record<string, ServiceRuntime>;
  /**
   * Enough about every service that is **running** to name it after its list is gone.
   *
   * `services` holds one workspace at a time, because that is what a service belongs to. `runtime`
   * outlives the switch, because a process does. Between the two there was a gap you could put six
   * `docker compose up` in: start a group, move to another workspace, and the status bar counted
   * zero — it was filtering a list the running services were no longer in — with no way to see them,
   * stop them, or read what they were printing.
   *
   * So a service that starts writes down its name and its workspace here, and stops being written
   * down when it settles. It is deliberately not the whole row: this exists to *get back to* a
   * service, not to operate one from another workspace.
   */
  runningInfo: Record<string, { name: string; workspaceId: string }>;
  loading: boolean;

  load: (workspaceId: string) => Promise<void>;

  save: (service: ServiceRow) => Promise<void>;
  add: (service: ServiceRow) => Promise<ServiceRow | null>;
  remove: (id: string) => Promise<void>;
  addGroup: (workspaceId: string, name: string) => Promise<void>;
  renameGroup: (id: string, name: string) => Promise<void>;
  removeGroup: (id: string) => Promise<void>;

  /**
   * Brings one service up, and everything it waits for.
   *
   * Not "just this one": a service with dependencies started alone would come up against a database
   * that is not there, which is the failure the dependencies exist to describe. Pressing play on the
   * API means "make the API work", and that is what this does.
   */
  start: (id: string) => Promise<void>;
  /** Brings a whole group up in dependency order. */
  startGroup: (groupId: string | null) => Promise<void>;
  /** Stops one service. Its dependents are left alone — stopping the database under a running API
   *  is a thing people do on purpose, to watch what the API does about it. */
  stop: (id: string) => Promise<void>;
  stopAll: () => Promise<void>;
  /** Stop, then start. What the row's restart button does. */
  restart: (id: string) => Promise<void>;

  runtimeOf: (id: string) => ServiceRuntime;
}

/**
 * Output routed to gates.
 *
 * A `log` gate needs to see the bytes, and the pane that would normally receive them may not be
 * mounted — the whole point of a group is that it starts six things and you look at one. So this
 * store keeps its own subscription, filtered to the sessions it started, and it is deliberately
 * *not* a second sink on `terminalStore`'s router: that router hands each session to exactly one
 * pane, and taking that slot would blank the console the user is reading.
 */
const gateWatchers = new Map<string, (chunk: string) => void>();
/** Sessions this store started, so the exit listener can tell a service dying from a shell being
 *  closed in the dock. */
const sessionToService = new Map<string, string>();

let routerStarted = false;

function startRouter(): void {
  if (routerStarted || !isMainWindow()) return;
  routerStarted = true;

  void onTerminalOutput((e) => {
    gateWatchers.get(e.id)?.(e.data);
  });

  void onTerminalExit((e) => {
    const serviceId = sessionToService.get(e.id);
    if (!serviceId) return;
    sessionToService.delete(e.id);
    gateWatchers.delete(e.id);
    useServicesStore.getState().runtimeOf(serviceId);
    handleExit(serviceId, e.id);
  });
}

/** What a service's process ending means, which depends entirely on what it was doing. */
function handleExit(serviceId: string, sessionId: string): void {
  const store = useServicesStore.getState();
  const current = store.runtime[serviceId];
  // A session that is not the one we are tracking is a stale exit — the service was restarted and
  // this is the old process going away. Acting on it would stop the new one.
  if (!current || current.sessionId !== sessionId) return;

  const service = store.services.find((s) => s.id === serviceId);
  // A one-shot command (`ready_kind: none`) ending is the command finishing, not a crash. A
  // long-running service ending is a crash, whatever its exit code — a dev server that exits was
  // not asked to.
  const oneShot = service?.ready_kind === "none";

  setRuntime(serviceId, (prev) => ({
    ...prev,
    status: oneShot && prev.status === "ready" ? "stopped" : oneShot ? "stopped" : "failed",
    sessionId: null,
    startedAt: null,
    error: oneShot ? "" : "services.exited",
  }));

  if (!oneShot && service?.autorestart && current.restarts < MAX_AUTORESTARTS) {
    setRuntime(serviceId, (prev) => ({ ...prev, restarts: prev.restarts + 1 }));
    void useServicesStore.getState().start(serviceId);
    return;
  }
  // Not restarting, so it is genuinely no longer running. A failed service stays findable through
  // its own workspace's list, which is where its error is written.
  forgetRunning(serviceId);
}

/** Writes one service's runtime without replacing the map for the others — a group of six changing
 *  state one at a time should re-render one row at a time. */
function setRuntime(id: string, update: (prev: ServiceRuntime) => ServiceRuntime): void {
  useServicesStore.setState((s) => ({
    runtime: { ...s.runtime, [id]: update(s.runtime[id] ?? idle()) },
  }));
}

/** Waits for a service's readiness gate, or answers `false` when the ceiling is reached. */
async function awaitGate(service: ServiceRow, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + GATE_TIMEOUT_MS;

  if (service.ready_kind === "none") return true;

  if (service.ready_kind === "log") {
    // Matched against a *rolling tail*, not against every byte ever printed: a dev server prints
    // its banner once and then megabytes of request logs, and searching an unbounded buffer on
    // every chunk is the one way this could become expensive.
    const needle = service.ready_value.trim();
    if (!needle) return true;
    return await new Promise<boolean>((resolve) => {
      let tail = "";
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        gateWatchers.delete(sessionId);
        clearInterval(timer);
        resolve(ok);
      };
      gateWatchers.set(sessionId, (chunk) => {
        tail = (tail + chunk).slice(-4096);
        if (tail.includes(needle)) finish(true);
      });
      const timer = setInterval(() => {
        if (Date.now() > deadline) finish(false);
        // The session went away while we were waiting: the process died before it was ready, and
        // the exit handler has already filed that. Nothing left to wait for.
        else if (!sessionToService.has(sessionId)) finish(false);
      }, GATE_POLL_MS);
    });
  }

  while (Date.now() < deadline) {
    // Same check as the log gate's: a dead process is not going to open its port.
    if (!sessionToService.has(sessionId)) return false;
    const ok =
      service.ready_kind === "port"
        ? await api.probePort("127.0.0.1", Number(service.ready_value) || 0, PROBE_TIMEOUT_MS)
        : await api.probeHttp(service.ready_value, PROBE_TIMEOUT_MS);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, GATE_POLL_MS));
  }
  return false;
}

/**
 * The services `id` needs before it can run, deepest first.
 *
 * Depth-first with a visiting set, so a cycle that somehow survived the save-time check (a database
 * edited by hand, a row from a newer version) is walked once rather than forever. The backend
 * refuses to save one; this refuses to hang on one.
 */
function resolveOrder(services: ServiceRow[], roots: string[]): ServiceRow[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const ordered: ServiceRow[] = [];
  const done = new Set<string>();
  const onPath = new Set<string>();

  const visit = (id: string) => {
    if (done.has(id) || onPath.has(id)) return;
    const service = byId.get(id);
    if (!service) return;
    onPath.add(id);
    for (const dep of serviceDeps(service)) visit(dep);
    onPath.delete(id);
    done.add(id);
    ordered.push(service);
  };

  for (const root of roots) visit(root);
  return ordered;
}

export const useServicesStore = create<ServicesState>((set, get) => ({
  services: [],
  groups: [],
  runtime: {},
  runningInfo: {},
  loading: false,

  load: async (workspaceId) => {
    startRouter();
    set({ loading: true });
    try {
      const [services, groups] = await Promise.all([
        api.listServices(workspaceId),
        api.listServiceGroups(workspaceId),
      ]);
      set({ services, groups });
    } catch (err) {
      pushErrorToast(String(err));
    } finally {
      set({ loading: false });
    }
  },

  add: async (service) => {
    try {
      const created = await api.createService(service);
      set((s) => ({ services: [...s.services, created] }));
      return created;
    } catch (err) {
      pushErrorToast(String(err));
      return null;
    }
  },

  save: async (service) => {
    try {
      // Written first: the backend is what refuses a dependency loop, and showing the new graph
      // before it answered would leave the list claiming an arrangement that was rejected.
      await api.updateService(service);
      set((s) => ({ services: s.services.map((row) => (row.id === service.id ? service : row)) }));
    } catch (err) {
      pushErrorToast(String(err));
    }
  },

  remove: async (id) => {
    // Stopped first, and awaited: deleting the definition of something that is still running would
    // leave a process nothing on screen can name, let alone stop.
    await get().stop(id);
    try {
      await api.deleteService(id);
    } catch (err) {
      pushErrorToast(String(err));
      return;
    }
    // Re-read rather than filtered locally: deleting a service also rewrites every `depends_on`
    // that named it (see `delete_service`), and those rows are stale here now.
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (workspaceId) await get().load(workspaceId);
  },

  addGroup: async (workspaceId, name) => {
    try {
      const group = await api.createServiceGroup(workspaceId, name);
      set((s) => ({ groups: [...s.groups, group] }));
    } catch (err) {
      pushErrorToast(String(err));
    }
  },

  renameGroup: async (id, name) => {
    try {
      await api.renameServiceGroup(id, name);
      set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) }));
    } catch (err) {
      pushErrorToast(String(err));
    }
  },

  removeGroup: async (id) => {
    try {
      await api.deleteServiceGroup(id);
    } catch (err) {
      pushErrorToast(String(err));
      return;
    }
    // Its services survive, ungrouped — so the list has to be re-read rather than filtered.
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (workspaceId) await get().load(workspaceId);
  },

  start: async (id) => {
    if (!isMainWindow()) return;
    startRouter();
    const chain = resolveOrder(get().services, [id]);
    await runInOrder(chain);
  },

  startGroup: async (groupId) => {
    if (!isMainWindow()) return;
    startRouter();
    const members = get().services.filter((s) => s.group_id === groupId);
    const chain = resolveOrder(get().services, members.map((s) => s.id));
    await runInOrder(chain);
  },

  stop: async (id) => {
    const current = get().runtime[id];
    if (!current?.sessionId) return;
    const sessionId = current.sessionId;
    // Cleared before the close, so the exit event this produces is recognised as a stale one and
    // does not trip autorestart on a service the user just stopped.
    sessionToService.delete(sessionId);
    gateWatchers.delete(sessionId);
    forgetRunning(id);
    setRuntime(id, () => idle());
    await closeTerminal(sessionId).catch(() => {});
  },

  stopAll: async () => {
    const running = Object.entries(get().runtime)
      .filter(([, runtime]) => runtime.sessionId)
      .map(([id]) => id);
    await Promise.all(running.map((id) => get().stop(id)));
  },

  restart: async (id) => {
    await get().stop(id);
    await get().start(id);
  },

  runtimeOf: (id) => get().runtime[id] ?? idle(),
}));

/** Written down when a service starts, so it can still be named once its workspace's list has been
 *  swapped out. See [`ServicesState.runningInfo`]. */
function noteRunning(service: ServiceRow): void {
  useServicesStore.setState((s) => ({
    runningInfo: {
      ...s.runningInfo,
      [service.id]: { name: service.name, workspaceId: service.workspace_id },
    },
  }));
}

/** And forgotten when it settles — a stopped service is reachable through its own workspace's list
 *  again, which is where it belongs. */
function forgetRunning(id: string): void {
  useServicesStore.setState((s) => {
    if (!s.runningInfo[id]) return {};
    const { [id]: _gone, ...rest } = s.runningInfo;
    return { runningInfo: rest };
  });
}

/**
 * Runs a resolved chain, one gate at a time.
 *
 * Sequential on purpose, and only where it has to be: a service whose dependencies are already up
 * starts immediately, so a group of six with two independent roots does not serialise into six
 * waits. What is sequential is the *walk*, which is already in dependency order — so waiting for
 * entry N's gate before starting N+1 is exactly the semantics `depends_on` promises.
 *
 * A service that is already running is skipped rather than restarted: pressing play on the frontend
 * twice must not bounce the database underneath it.
 */
async function runInOrder(chain: ServiceRow[]): Promise<void> {
  const store = useServicesStore.getState;

  // Everything about to be attempted is marked up front, so the whole group changes state in one
  // frame rather than lighting up row by row as the walk reaches it. Six rows going amber at once
  // is what says "this is starting"; six going amber over ten seconds looks like six separate
  // events.
  for (const service of chain) {
    const runtime = store().runtimeOf(service.id);
    if (runtime.status === "ready" || runtime.status === "starting") continue;
    setRuntime(service.id, (prev) => ({ ...prev, status: "waiting", error: "", blockedBy: null }));
  }

  for (const service of chain) {
    const runtime = store().runtimeOf(service.id);
    if (runtime.status === "ready" || runtime.status === "starting") continue;

    // A dependency that failed takes everything downstream with it, and says which one. Without
    // this the API would be launched against a database that never came up, fail on its own, and
    // report a connection error instead of the actual cause.
    const failedDep = serviceDeps(service).find(
      (dep) => store().runtimeOf(dep).status === "failed",
    );
    if (failedDep) {
      setRuntime(service.id, (prev) => ({
        ...prev,
        status: "failed",
        blockedBy: failedDep,
        error: "services.dependencyFailed",
      }));
      continue;
    }

    setRuntime(service.id, (prev) => ({ ...prev, status: "starting", blockedBy: null, error: "" }));

    let sessionId: string;
    try {
      sessionId = await api.startService(service.id);
    } catch (err) {
      setRuntime(service.id, (prev) => ({ ...prev, status: "failed", error: String(err) }));
      continue;
    }

    sessionToService.set(sessionId, service.id);
    // Before the gate is awaited, not after: a service that never becomes ready is exactly the one
    // somebody needs to find from another workspace.
    noteRunning(service);
    setRuntime(service.id, (prev) => ({ ...prev, sessionId, startedAt: Date.now() }));

    const ready = await awaitGate(service, sessionId);
    // The process may have died while the gate was being waited on, in which case `handleExit` has
    // already filed the failure and this must not overwrite it with a gate verdict.
    if (!sessionToService.has(sessionId)) continue;
    setRuntime(service.id, (prev) => ({
      ...prev,
      status: ready ? "ready" : "failed",
      error: ready ? "" : "services.gateTimedOut",
    }));
  }
}

/** One service that is up, wherever it belongs. */
export interface RunningService {
  id: string;
  name: string;
  workspaceId: string;
  status: ServiceStatus;
  /** Not in the workspace on screen — the row it belongs to is not in the list below it. */
  foreign: boolean;
}

/**
 * Everything running right now, across every workspace.
 *
 * Built from `runtime` rather than from `services`, and that is the whole point: `services` holds
 * one workspace and a process does not stop when you look at another one. The status bar counted
 * off the list and therefore said zero for six live containers the moment you switched.
 *
 * **A pure function over the two maps, not a `getState()` selector**, so its callers subscribe to
 * exactly what the answer depends on and re-render when it changes. A selector reaching into the
 * store would be a snapshot taken during render — right once, then quietly stale, which is the bug
 * this whole function exists to fix in a different place.
 */
export function deriveRunning(
  runtime: Record<string, ServiceRuntime>,
  runningInfo: Record<string, { name: string; workspaceId: string }>,
  activeWorkspaceId: string | null,
): RunningService[] {
  const out: RunningService[] = [];
  for (const [id, info] of Object.entries(runningInfo)) {
    const status = runtime[id]?.status;
    // `ready` or `starting` and nothing else — a service is written down once its process exists,
    // and `waiting` is the state before that. Counting a queued service as running would make the
    // status bar claim six processes during a cascade that has started two.
    if (status !== "ready" && status !== "starting") continue;
    out.push({
      id,
      name: info.name,
      workspaceId: info.workspaceId,
      status,
      foreign: info.workspaceId !== activeWorkspaceId,
    });
  }
  return out;
}

/** A stable empty list, for the same reason `workspaceStore` keeps one: a selector that builds `[]`
 *  hands back a new reference every call, which `useSyncExternalStore` reads as a change. */
const NO_SERVICES: ServiceRow[] = [];

/** The services in one group — `null` for the ungrouped ones, which are shown as a group of their
 *  own at the top the way Remote does it. */
export function useServicesInGroup(groupId: string | null): ServiceRow[] {
  return useServicesStore((s) => {
    const found = s.services.filter((service) => service.group_id === groupId);
    return found.length ? found : NO_SERVICES;
  });
}

/** How a status is drawn, in one place so the tree, the console header and the status bar agree. */
export const STATUS_TONE: Record<ServiceStatus, string> = {
  stopped: "var(--cf-text-muted)",
  waiting: "var(--cf-text-muted)",
  starting: "var(--cf-warning)",
  ready: "var(--cf-success)",
  failed: "var(--cf-danger)",
};
