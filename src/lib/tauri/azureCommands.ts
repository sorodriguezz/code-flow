import { invoke } from "./invoke";
import type { AzActivity, AzGroup, AzHealth, AzQueryResult, AzResource, AzSubscriptions, AzTopology, AzWorkspace } from "../../types/containers";

/**
 * IPC for the Azure pages of the Contenedores panel (`src-tauri/src/commands/containers_azure_cmd.rs`).
 * Every one of these reads; nothing here changes a resource. A resource's logs followed live are a
 * terminal session (`containersOpenSession` with kind `azureLogs`).
 */

export const azureFound = () => invoke<boolean>("azure_found");
export const azureSubscriptions = () => invoke<AzSubscriptions>("azure_subscriptions");
export const azureGroups = (subscription: string) => invoke<AzGroup[]>("azure_groups", { subscription });
export const azureResources = (subscription: string, group: string | null) => invoke<AzResource[]>("azure_resources", { subscription, group });
export const azureShow = (id: string) => invoke<unknown>("azure_show", { id });
export const azureHealth = (subscription: string, group: string | null) => invoke<AzHealth[]>("azure_health", { subscription, group });
export const azureActivity = (subscription: string, group: string | null, resource: string | null, hours: number) =>
  invoke<AzActivity[]>("azure_activity", { subscription, group, resource, hours });
export const azureLogs = (id: string, tail?: number) => invoke<string>("azure_logs", { id, tail });
export const azureWorkspaces = (subscription: string) => invoke<AzWorkspace[]>("azure_workspaces", { subscription });
export const azureQuery = (workspace: string, query: string, hours: number) => invoke<AzQueryResult>("azure_query", { workspace, query, hours });
export const azureTopology = (subscription: string, group: string | null) => invoke<AzTopology>("azure_topology", { subscription, group });
