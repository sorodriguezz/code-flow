import { invoke } from "./invoke";
import type {
  BuildDetail,
  BuildRecord,
  CloudAccount,
  CloudCluster,
  CloudSource,
  ContainerStats,
  ContainerSummary,
  DiffEntry,
  DiskUsageRow,
  FileEntry,
  ForwardView,
  HubRepo,
  HubTag,
  HardeningFinding,
  ImageLayer,
  KubeAdded,
  KubeAddRequest,
  KubeContextOrigin,
  KubeTest,
  AzureCliSwitch,
  AksStatus,
  KubeTools,
  KubeTopology,
  LintFinding,
  RunSpec,
  RuntimeInfo,
  SbomFormat,
  ScanComparison,
  ScanResult,
  ScanSummary,
  Scanner,
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
/** The last `lines` of a container's log, credentials redacted. */
export const containersLogsTail = (runtime: string, context: string | null, id: string, lines: number) =>
  invoke<string>("containers_logs_tail", { runtime, context, id, lines });

export const containersNamespaces = (runtime: string, context: string | null) =>
  invoke<string[]>("containers_namespaces", { runtime, context });

export const containersReach = (context: string | null) => invoke<string>("containers_reach", { context });

export const containersApply = (context: string | null, namespace: string | null, manifest: string) =>
  invoke<string>("containers_apply", { context, namespace, manifest });

export interface SessionRequest {
  /** `pull`, `build` and the `compose*` ones run to their end in the pane, then the session exits. */
  /** `kubeLogin`: `kubectl version` against the context named by `target`, so that a sign-in its
   *  auth plugin asks for (a device code) shows in the pane. */
  /** `aksStart`: `az aks start` for the cluster named by `target`, in `resourceGroup` and `subscription`. */
  /** `azureLogs`: an Azure resource's own log stream (`az webapp log tail`, `az containerapp logs show
   *  --follow`, `az container logs --follow`); `target` is the resource's id. */
  /** `marketUp`: a service-catalogue stack's `compose up`, opened by `containersMarketUpJob` rather than
   *  as a session; `target` is the stack's id. */
  kind: "logs" | "exec" | "projectLogs" | "pull" | "build" | "composeUp" | "composeDown" | "composeRestart" | "composePull" | "composeBuild" | "kubeLogin" | "aksStart" | "azureLogs" | "localCluster" | "marketUp";
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
  resourceGroup?: string | null;
  subscription?: string | null;
  /** `localCluster`: what kind, k3d or minikube does to the cluster named by `target`. */
  localCluster?: import("../../types/containersLocal").LocalClusterSpec | null;
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

/** Volume `name` as a `.tar.gz` at `path`, through a throwaway container. Resolves to the bytes written. */
export const containersBackupVolume = (runtime: string, context: string | null, name: string, path: string) =>
  invoke<number>("containers_backup_volume", { runtime, context, name, path });

/** A `.tar.gz` unpacked into volume `name` (made if missing); `replace` empties it first. */
export const containersRestoreVolume = (runtime: string, context: string | null, name: string, path: string, replace: boolean) =>
  invoke<void>("containers_restore_volume", { runtime, context, name, path, replace });

export const containersCreateNetwork = (runtime: string, context: string | null, name: string, driver: string | null = null) =>
  invoke<void>("containers_create_network", { runtime, context, name, driver });

export const containersImageHistory = (runtime: string, context: string | null, image: string) =>
  invoke<ImageLayer[]>("containers_image_history", { runtime, context, image });

/** BuildKit's build history (Docker with buildx); rejects with `"unsupported"` elsewhere. */
export const containersBuilds = (runtime: string, context: string | null) => invoke<BuildRecord[]>("containers_buildkit_history", { runtime, context });

export const containersBuildDetail = (runtime: string, context: string | null, id: string) => invoke<BuildDetail>("containers_buildkit_detail", { runtime, context, id });

export const containersBuildRemove = (runtime: string, context: string | null, ids: string[]) => invoke<void>("containers_buildkit_remove", { runtime, context, ids });

/** Trivy or Grype, when one is installed. */
export const containersScanner = () => invoke<Scanner | null>("containers_scanner_detect");

/** Rejects with `"no scanner"`, `"remote"` or `"unsupported"` when there is nothing to run it with. */
export const containersImageScan = (runtime: string, context: string | null, image: string) => invoke<ScanResult>("containers_image_scan", { runtime, context, image });

/** The kept scans of an image, newest first. */
export const containersScanHistory = (image: string) => invoke<ScanSummary[]>("containers_scan_history", { image });

export const containersScanGet = (id: string) => invoke<ScanResult | null>("containers_scan_get", { id });

export const containersScanCompare = (earlier: string, later: string) => invoke<ScanComparison>("containers_scan_compare", { earlier, later });

/** Forgets every kept scan of an image; how many were dropped. */
export const containersScanForget = (image: string) => invoke<number>("containers_scan_forget", { image });

/** Trivy or Syft, when one is installed — what can write an SBOM. */
export const containersSbomTool = () => invoke<Scanner | null>("containers_sbom_tool");

/** Writes an image's SBOM to `path`; the tool that wrote it. Rejects like `containersImageScan`, or with `"no sbom tool"`. */
export const containersImageSbom = (runtime: string, context: string | null, image: string, format: SbomFormat, path: string) =>
  invoke<string>("containers_image_sbom", { runtime, context, image, format, path });

export const containersContainerDiff = (runtime: string, context: string | null, id: string) => invoke<DiffEntry[]>("containers_container_diff", { runtime, context, id });

export const containersHardening = (runtime: string, context: string | null, id: string) => invoke<HardeningFinding[]>("containers_hardening", { runtime, context, id });

export const containersHadolint = () => invoke<string | null>("containers_hadolint_detect");

/** Rejects with `"no hadolint"` when it is not installed. */
export const containersDockerfileLint = (path: string) => invoke<LintFinding[]>("containers_dockerfile_lint", { path });

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

/** «Analizar con IA» on a log: `about` says what produced it (one `Clave: valor` per line), `log` is
 *  the text the pane shows. Routed as the `logs` AI task; `workspaceId` picks the account the way
 *  the picker beside the button names it. */
export const containersAnalyzeLogs = (args: { log: string; about: string; language: string; runId: string; workspaceId: string | null }) =>
  invoke<string>("containers_analyze_logs", args);

export const containersKubeUseAzureCli = (context: string) => invoke<AzureCliSwitch>("containers_kube_use_azure_cli", { context });

export const containersKubeAksStatus = (context: string) => invoke<AksStatus>("containers_kube_aks_status", { context });

/** How a namespace's objects hang together (every namespace when `null`) — read-only. */
export const containersKubeTopology = (context: string | null, namespace: string | null) => invoke<KubeTopology>("containers_kube_topology", { context, namespace });
