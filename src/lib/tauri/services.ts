import { invoke } from "@tauri-apps/api/core";
import type { ServiceGroup, ServiceRow } from "../../types/services";

/** The Services workspace's commands. See `src-tauri/src/commands/services_cmd.rs`. */

export const listServices = (workspaceId: string) =>
  invoke<ServiceRow[]>("list_services", { workspaceId });

export const listServiceGroups = (workspaceId: string) =>
  invoke<ServiceGroup[]>("list_service_groups", { workspaceId });

export const createService = (service: ServiceRow) =>
  invoke<ServiceRow>("create_service", { service });

/** Rejects a dependency graph that cannot finish, naming a service in the loop. The check is on the
 *  save rather than in the executor so the mistake is reported to the person who made it, while the
 *  form is still open. */
export const updateService = (service: ServiceRow) => invoke<void>("update_service", { service });

export const deleteService = (id: string) => invoke<void>("delete_service", { id });

export const createServiceGroup = (workspaceId: string, name: string) =>
  invoke<ServiceGroup>("create_service_group", { workspaceId, name });

export const renameServiceGroup = (id: string, name: string) =>
  invoke<void>("rename_service_group", { id, name });

export const deleteServiceGroup = (id: string) => invoke<void>("delete_service_group", { id });

export const reorderServices = (workspaceId: string, ids: string[]) =>
  invoke<void>("reorder_services", { workspaceId, ids });

/** Starts one service in a pty and answers with the terminal session id — the same kind of session
 *  the terminal dock opens, so the existing xterm pane renders it with no branch. */
export const startService = (id: string) => invoke<string>("start_service", { id });

/** The `port` gate: whether anything is listening. A TCP connect and nothing more. */
export const probePort = (host: string, port: number, timeoutMs: number) =>
  invoke<boolean>("probe_port", { host, port, timeoutMs });

/** The `http` gate: whether the URL answers with anything below 500. */
export const probeHttp = (url: string, timeoutMs: number) =>
  invoke<boolean>("probe_http", { url, timeoutMs });

/** Whether a working directory exists, for the editor to say so before the first run. */
export const servicePathExists = (path: string) => invoke<boolean>("service_path_exists", { path });
