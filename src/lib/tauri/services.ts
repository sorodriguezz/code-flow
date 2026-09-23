import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ListeningPort,
  ProjectCandidates,
  ServiceCandidate,
  ServiceGroup,
  ServiceRow,
  ServiceRuntime,
} from "../../types/services";

/** The Services workspace's commands. See `src-tauri/src/commands/services_cmd.rs`. */

export const listServices = (workspaceId: string) =>
  invoke<ServiceRow[]>("list_services", { workspaceId });

export const listServiceGroups = (workspaceId: string) =>
  invoke<ServiceGroup[]>("list_service_groups", { workspaceId });

export const createService = (service: ServiceRow) =>
  invoke<ServiceRow>("create_service", { service });

/** Rejects a dependency graph that cannot finish, naming a service in the loop. */
export const updateService = (service: ServiceRow) => invoke<void>("update_service", { service });

/** Stops the service first, then deletes it. */
export const deleteService = (id: string) => invoke<void>("delete_service", { id });

export const createServiceGroup = (workspaceId: string, name: string) =>
  invoke<ServiceGroup>("create_service_group", { workspaceId, name });

export const renameServiceGroup = (id: string, name: string) =>
  invoke<void>("rename_service_group", { id, name });

export const deleteServiceGroup = (id: string) => invoke<void>("delete_service_group", { id });

export const reorderServices = (workspaceId: string, ids: string[]) =>
  invoke<void>("reorder_services", { workspaceId, ids });

/** Starts `ids` and everything they wait for, in dependency order. Resolves once queued; progress
 *  arrives through {@link onServiceRuntime}. */
export const startServices = (workspaceId: string, ids: string[]) =>
  invoke<void>("services_start", { workspaceId, ids });

/** Stops `ids` — dependents first — and resolves once they are all down. */
export const stopServices = (ids: string[]) => invoke<void>("services_stop", { ids });

/** Stops what is running of `ids`, then starts them all in dependency order. */
export const restartServices = (workspaceId: string, ids: string[]) =>
  invoke<void>("services_restart", { workspaceId, ids });

/** Every service the supervisor knows about, in every workspace. */
export const servicesRuntime = () => invoke<ServiceRuntime[]>("services_runtime");

/** What a service has printed, across restarts, and the last live chunk that record includes. */
export const serviceLog = (id: string) =>
  invoke<{ text: string; seq: number; sessionId: string | null }>("service_log", { id });

export const clearServiceLog = (id: string) => invoke<void>("service_clear_log", { id });

/** What a folder can run, best first. */
export const detectServices = (path: string) => invoke<ServiceCandidate[]>("service_detect", { path });

/** What every repository in a workspace can run. */
export const detectWorkspaceServices = (workspaceId: string) =>
  invoke<ProjectCandidates[]>("services_detect_workspace", { workspaceId });

/** Every listening TCP port on the machine, attributed to a service where one owns it. */
export const listeningPorts = () => invoke<ListeningPort[]>("services_listening_ports");

/** Ends the process holding a port. */
export const freePort = (pid: number) => invoke<void>("services_free_port", { pid });

/** Whether a working directory exists, for the editor to say so before the first run. */
export const servicePathExists = (path: string) => invoke<boolean>("service_path_exists", { path });

/** One service's state changed. */
export const onServiceRuntime = (handler: (runtime: ServiceRuntime) => void) =>
  listen<ServiceRuntime>("services:runtime", (e) => handler(e.payload));
