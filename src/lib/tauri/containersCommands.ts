import { invoke } from "@tauri-apps/api/core";
import type {
  CloudAccount,
  CloudCluster,
  CloudSource,
  ContainerStats,
  ContainerSummary,
  DiskUsageRow,
  FileEntry,
  ForwardView,
  HubRepo,
  HubTag,
  ImageLayer,
  KubeAdded,
  KubeAddRequest,
  KubeContextOrigin,
  KubeTest,
  KubeTools,
  RunSpec,
  RuntimeInfo,
} from "../../types/containers";

/**
 * IPC surface for the Contenedores panel (`src-tauri/src/commands/containers_cmd.rs`).
 *
 * A container's logs and a shell inside it are terminal sessions — `containersOpenSession` returns an
 * id for the same registry a local shell lives in, driven by `writeTerminal` / `resizeTerminal` /
 * `closeTerminal` from `commands.ts`, exactly as the Remote workspace's `ssh` sessions are.
 */

export const containersDetect = () => invoke<RuntimeInfo[]>("containers_detect");

/** An engine's list (`containers`, `images`, `volumes`, `networks`) or a Kubernetes kind in a
 *  namespace (`""` = every namespace). */
export const containersList = <T>(runtime: string, context: string | null, namespace: string | null, what: string) =>
  invoke<T[]>("containers_list", { runtime, context, namespace, what });

export const containersAct = (args: {
  runtime: string;
  context: string | null;
  namespace?: string | null;
  object: string;
  action: string;
  ids: string[];
  options?: Record<string, unknown>;
}) =>
  invoke<string>("containers_act", {
    runtime: args.runtime,
    context: args.context,
    namespace: args.namespace ?? null,
    object: args.object,
    action: args.action,
    ids: args.ids,
    options: args.options ?? null,
  });

export const containersText = (args: {
  runtime: string;
  context: string | null;
  namespace?: string | null;
  object: string;
  id: string;
  view: "inspect" | "describe" | "yaml";
  reveal?: boolean;
}) =>
  invoke<string>("containers_text", {
    runtime: args.runtime,
    context: args.context,
    namespace: args.namespace ?? null,
    object: args.object,
    id: args.id,
    view: args.view,
    reveal: args.reveal ?? null,
  });

export const containersContainerDetail = (runtime: string, context: string | null, id: string, running: boolean) =>
  invoke<ContainerSummary>("containers_container_detail", { runtime, context, id, running });

export const containersNamespaces = (runtime: string, context: string | null) =>
  invoke<string[]>("containers_namespaces", { runtime, context });

export const containersReach = (context: string | null) => invoke<string>("containers_reach", { context });

export const containersApply = (context: string | null, namespace: string | null, manifest: string) =>
  invoke<string>("containers_apply", { context, namespace, manifest });

export interface SessionRequest {
  /** `pull`, `build` and the `compose*` ones run to their end in the pane, then the session exits. */
  kind: "logs" | "exec" | "projectLogs" | "pull" | "build" | "composeUp" | "composeDown" | "composeRestart" | "composePull";
  runtime: string;
  context: string | null;
  namespace?: string | null;
  target: string;
  container?: string | null;
  tail?: number;
  timestamps?: boolean;
  previous?: boolean;
  shell?: string | null;
  /** A Compose project's folder and files, for `projectLogs` and the `compose*` kinds. */
  projectDir?: string | null;
  configFiles?: string | null;
  /** `build`: the folder, its Dockerfile and the image's tag. `pull` reads its image from `target`. */
  buildContext?: string | null;
  dockerfile?: string | null;
  tag?: string | null;
}

export const containersOpenSession = (request: SessionRequest) => invoke<string>("containers_open_session", { request });

export const containersStartRuntime = (how: string) => invoke<string>("containers_start_runtime", { how });

export const containersForwardOpen = (request: {
  context: string | null;
  namespace: string | null;
  kind: string;
  name: string;
  localPort: number;
  remotePort: number;
}) => invoke<ForwardView>("containers_forward_open", { request });

export const containersForwardClose = (id: string) => invoke<void>("containers_forward_close", { id });

export const containersForwards = () => invoke<ForwardView[]>("containers_forwards");

// ---------------------------------------------------------------- the manager (lite-dock's views)

export const containersHubSearch = (term: string, limit = 10) => invoke<HubRepo[]>("containers_hub_search", { term, limit });

export const containersHubTags = (repo: string, limit = 30) => invoke<HubTag[]>("containers_hub_tags", { repo, limit });

/** Runs a container from the form; its id. */
export const containersRun = (runtime: string, context: string | null, spec: RunSpec) => invoke<string>("containers_run", { runtime, context, spec });

/** Live stats of `ids` — every running container when `ids` is null. */
export const containersStats = (runtime: string, context: string | null, ids: string[] | null = null) =>
  invoke<ContainerStats[]>("containers_stats", { runtime, context, ids });

export const containersFiles = (runtime: string, context: string | null, id: string, path: string) =>
  invoke<FileEntry[]>("containers_files", { runtime, context, id, path });

export const containersFileDelete = (runtime: string, context: string | null, id: string, path: string) =>
  invoke<void>("containers_file_delete", { runtime, context, id, path });

export const containersFileUpload = (runtime: string, context: string | null, id: string, dir: string, hostPaths: string[]) =>
  invoke<void>("containers_file_upload", { runtime, context, id, dir, hostPaths });

/** Copies a file or folder out of the container into `hostDir`; where it landed. */
export const containersFileDownload = (runtime: string, context: string | null, id: string, path: string, hostDir: string) =>
  invoke<string>("containers_file_download", { runtime, context, id, path, hostDir });

export const containersUpdateLimits = (runtime: string, context: string | null, id: string, memoryMb: number | null, cpus: number | null) =>
  invoke<void>("containers_update_limits", { runtime, context, id, memoryMb, cpus });

export const containersCreateVolume = (runtime: string, context: string | null, name: string, driver: string | null = null) =>
  invoke<void>("containers_create_volume", { runtime, context, name, driver });

export const containersCreateNetwork = (runtime: string, context: string | null, name: string, driver: string | null = null) =>
  invoke<void>("containers_create_network", { runtime, context, name, driver });

export const containersImageHistory = (runtime: string, context: string | null, image: string) =>
  invoke<ImageLayer[]>("containers_image_history", { runtime, context, image });

export const containersDiskUsage = (runtime: string, context: string | null) => invoke<DiskUsageRow[]>("containers_disk_usage", { runtime, context });

/** A remote Docker engine (`ssh://user@host`, `tcp://host:2376`) as a Docker context. */
export const containersDockerContextAdd = (name: string, host: string, description: string | null = null) =>
  invoke<void>("containers_docker_context_add", { name, host, description });

// ------------------------------------------------------------- Kubernetes clusters, anywhere

export const containersKubeTools = () => invoke<KubeTools>("containers_kube_tools");

export const containersKubeAccounts = (source: CloudSource) => invoke<CloudAccount[]>("containers_kube_accounts", { source });

export const containersKubeClouds = (source: CloudSource, account: string | null, region: string | null = null) =>
  invoke<CloudCluster[]>("containers_kube_clouds", { source, account, region });

export const containersKubeAdd = (request: KubeAddRequest) => invoke<KubeAdded>("containers_kube_add", { request });

export const containersKubeOrigins = () => invoke<KubeContextOrigin[]>("containers_kube_origins");

export const containersKubeRemove = (context: string) => invoke<void>("containers_kube_remove", { context });

export const containersKubeTest = (context: string) => invoke<KubeTest>("containers_kube_test", { context });
