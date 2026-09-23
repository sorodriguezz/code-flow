import { create } from "zustand";
import * as api from "../lib/tauri/services";
import { isMainWindow } from "../lib/windowIdentity";
import { pushErrorToast } from "./toastStore";
import { disownTerminalBacklog } from "./terminalStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { ServiceGroup, ServiceRow, ServiceRuntime, ServiceStatus } from "../types/services";

/**
 * The Services workspace: what is defined here, and what the supervisor says is running.
 *
 * # Nothing is decided here any more
 *
 * This store used to *be* the executor — dependency order, readiness gates, restarts — on the
 * argument that the log gate needs the output and the output streams into the webview. Everything
 * that went wrong with it went wrong because a webview cannot see processes: stopping killed one
 * process of a tree and left the rest holding the port, "the command finishes" passed the moment the
 * command *started* because no exit code ever arrived, and a port could be probed but never found.
 * All of that is `services/supervisor.rs` now. What is left here is the definitions (CRUD), the
 * verbs (start/stop/restart — a service, or a group), and a mirror of the supervisor's state fed by
 * `services:runtime` events.
 *
 * # The mirror spans workspaces
 *
 * `services` holds one workspace's definitions, because that is what a service belongs to. `runtime`
 * holds every service the supervisor knows, whichever workspace it lives in — a `docker compose up`
 * does not stop because you looked at another workspace, and the status bar and the dock's "running
 * elsewhere" section are built from this map for exactly that reason. Each entry carries its own
 * name and workspace, so it can be drawn after its list is gone.
 *
 * # Main window only
 *
 * Services are drawn in the main window — its dock and its status bar — and nowhere else (see
 * `ServicesDock`), so only that window subscribes. The supervisor would not mind another listener;
 * there is simply nothing to draw.
 */

interface ServicesState {
  services: ServiceRow[];
  groups: ServiceGroup[];
  /** Live state per service id, every workspace. Absent means stopped and never started. */
  runtime: Record<string, ServiceRuntime>;
  loading: boolean;

  load: (workspaceId: string) => Promise<void>;

  add: (service: ServiceRow) => Promise<ServiceRow | null>;
  save: (service: ServiceRow) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  addGroup: (workspaceId: string, name: string) => Promise<ServiceGroup | null>;
  renameGroup: (id: string, name: string) => Promise<void>;
  removeGroup: (id: string) => Promise<void>;

  /** Brings one service up, and everything it waits for — pressing play on the API means "make the
   *  API work", which includes its database. */
  start: (id: string) => Promise<void>;
  /** Stops one service. Its dependents are left alone: stopping the database under a running API is
   *  a thing people do on purpose, to watch what the API does about it. */
  stop: (id: string) => Promise<void>;
  restart: (id: string) => Promise<void>;
  /** A whole group, in dependency order — `null` is the ungrouped ones. */
  startGroup: (groupId: string | null) => Promise<void>;
  /** A whole group, dependents first, the way it came up reversed. */
  stopGroup: (groupId: string | null) => Promise<void>;
  restartGroup: (groupId: string | null) => Promise<void>;

  runtimeOf: (id: string) => ServiceRuntime | undefined;
}

let syncStarted = false;

/**
 * Starts mirroring the supervisor, if this window has not already.
 *
 * Called by everything that draws runtime state — the dock and the status bar — rather than only by
 * the dock's first load: a webview that reloads with the panel closed would otherwise show no
 * running services in the status bar until somebody opened the panel, while they ran regardless.
 */
export function ensureServicesSync(): void {
  startSync();
}

/**
 * Subscribes to the supervisor, then asks it for everything it already knows.
 *
 * In that order so nothing falls between the two — and a seed answer that lands *after* an event
 * about the same service is the older of the two, so it does not overwrite it.
 */
function startSync(): void {
  if (syncStarted || !isMainWindow()) return;
  syncStarted = true;
  const fresh = new Set<string>();
  void api.onServiceRuntime((runtime) => {
    fresh.add(runtime.id);
    if (runtime.sessionId) disownTerminalBacklog(runtime.sessionId);
    useServicesStore.setState((s) => ({ runtime: { ...s.runtime, [runtime.id]: runtime } }));
  });
  void api
    .servicesRuntime()
    .then((all) => {
      const seeded: Record<string, ServiceRuntime> = {};
      for (const runtime of all) {
        if (fresh.has(runtime.id)) continue;
        if (runtime.sessionId) disownTerminalBacklog(runtime.sessionId);
        seeded[runtime.id] = runtime;
      }
      useServicesStore.setState((s) => ({ runtime: { ...seeded, ...s.runtime } }));
    })
    .catch((err: unknown) => pushErrorToast(String(err)));
}

/** Runs one of the supervisor's verbs, turning a refusal into a toast rather than an unhandled
 *  rejection. */
async function attempt(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch (err) {
    pushErrorToast(String(err));
  }
}

export const useServicesStore = create<ServicesState>((set, get) => {
  const membersOf = (groupId: string | null) =>
    get()
      .services.filter((s) => s.group_id === groupId)
      .map((s) => s.id);
  const workspaceOf = (id: string) =>
    get().services.find((s) => s.id === id)?.workspace_id ??
    get().runtime[id]?.workspaceId ??
    useWorkspaceStore.getState().activeWorkspaceId;

  return {
    services: [],
    groups: [],
    runtime: {},
    loading: false,

    load: async (workspaceId) => {
      startSync();
      set({ loading: true });
      try {
        const [services, groups] = await Promise.all([
          api.listServices(workspaceId),
          api.listServiceGroups(workspaceId),
        ]);
        // A load for a workspace the user has already left must not overwrite the one they are in.
        if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) set({ services, groups });
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
        return true;
      } catch (err) {
        pushErrorToast(String(err));
        return false;
      }
    },

    remove: async (id) => {
      try {
        // The backend stops it first and waits: deleting the definition of something still running
        // would leave a process nothing on screen can name, let alone stop.
        await api.deleteService(id);
      } catch (err) {
        pushErrorToast(String(err));
        return;
      }
      set((s) => {
        const { [id]: _gone, ...runtime } = s.runtime;
        return { runtime };
      });
      // Re-read rather than filtered locally: deleting a service also rewrites every `depends_on`
      // that named it (see `delete_service`), and those rows are stale here now.
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      if (workspaceId) await get().load(workspaceId);
    },

    addGroup: async (workspaceId, name) => {
      try {
        const group = await api.createServiceGroup(workspaceId, name);
        set((s) => ({ groups: [...s.groups, group] }));
        return group;
      } catch (err) {
        pushErrorToast(String(err));
        return null;
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

    start: (id) => {
      const workspaceId = workspaceOf(id);
      if (!workspaceId) return Promise.resolve();
      return attempt(api.startServices(workspaceId, [id]));
    },

    stop: (id) => attempt(api.stopServices([id])),

    restart: (id) => {
      const workspaceId = workspaceOf(id);
      if (!workspaceId) return Promise.resolve();
      return attempt(api.restartServices(workspaceId, [id]));
    },

    startGroup: (groupId) => {
      const members = membersOf(groupId);
      // A one-shot that already finished is not re-run by starting its group — the migration ran,
      // and running it again is something to ask for by name. Unless it is all the group has left.
      const pending = members.filter((id) => get().runtime[id]?.status !== "completed");
      const ids = pending.length ? pending : members;
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!ids.length || !workspaceId) return Promise.resolve();
      return attempt(api.startServices(workspaceId, ids));
    },

    stopGroup: (groupId) => {
      const ids = membersOf(groupId);
      if (!ids.length) return Promise.resolve();
      return attempt(api.stopServices(ids));
    },

    restartGroup: (groupId) => {
      const ids = membersOf(groupId);
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!ids.length || !workspaceId) return Promise.resolve();
      return attempt(api.restartServices(workspaceId, ids));
    },

    runtimeOf: (id) => get().runtime[id],
  };
});

/** The statuses in which a service has a process, or is on its way to having one — what the row's
 *  primary button reads as "stop" rather than "start". */
export function isActive(runtime: ServiceRuntime | undefined): boolean {
  if (!runtime) return false;
  return (
    runtime.alive ||
    runtime.status === "waiting" ||
    runtime.status === "restarting" ||
    runtime.status === "stopping"
  );
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
 * Everything with a live process right now, across every workspace.
 *
 * Built from `runtime` rather than from `services`, and that is the whole point: `services` holds
 * one workspace and a process does not stop when you look at another one.
 *
 * **A pure function over the map, not a `getState()` selector**, so its callers subscribe to exactly
 * what the answer depends on and re-render when it changes.
 */
export function deriveRunning(
  runtime: Record<string, ServiceRuntime>,
  activeWorkspaceId: string | null,
): RunningService[] {
  const out: RunningService[] = [];
  for (const entry of Object.values(runtime)) {
    if (!entry.alive) continue;
    out.push({
      id: entry.id,
      name: entry.name,
      workspaceId: entry.workspaceId,
      status: entry.status,
      foreign: entry.workspaceId !== activeWorkspaceId,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A stable empty list, for the same reason `workspaceStore` keeps one: a selector that builds `[]`
 *  hands back a new reference every call, which `useSyncExternalStore` reads as a change. */
const NO_SERVICES: ServiceRow[] = [];

/** The services in one group — `null` for the ungrouped ones. */
export function useServicesInGroup(groupId: string | null): ServiceRow[] {
  return useServicesStore((s) => {
    const found = s.services.filter((service) => service.group_id === groupId);
    return found.length ? found : NO_SERVICES;
  });
}

/** How a status is coloured, in one place so the tree, the console header and the status bar agree. */
export const STATUS_TONE: Record<ServiceStatus, string> = {
  stopped: "var(--cf-text-muted)",
  waiting: "var(--cf-text-muted)",
  starting: "var(--cf-warning)",
  ready: "var(--cf-success)",
  completed: "var(--cf-success)",
  failed: "var(--cf-danger)",
  stopping: "var(--cf-warning)",
  restarting: "var(--cf-warning)",
};
