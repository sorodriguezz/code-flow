/** The Contenedores panel's data, as `src-tauri/src/containers` serialises it. */

export type RuntimeId = "docker" | "podman" | "nerdctl" | "ctr" | "kubernetes";

export interface ContextInfo {
  name: string;
  /** A Docker context's endpoint, or a Kubernetes context's cluster. */
  detail: string;
  /** A Kubernetes context's own default namespace. */
  namespace: string;
  /** What provides a Docker context's engine, from its endpoint: `Kiri`, `OrbStack`… */
  provider?: string | null;
}

export interface RuntimeInfo {
  id: RuntimeId;
  provider: string | null;
  binary: string;
  version: string | null;
  serverVersion: string | null;
  running: boolean;
  problem: string | null;
  contexts: ContextInfo[];
  currentContext: string | null;
  start: string | null;
}

export interface PortMap {
  hostIp: string;
  hostPort: number | null;
  containerPort: number;
  protocol: string;
}

export interface ContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health: string;
  exitCode: number | null;
  ports: PortMap[];
  created: string;
  command: string;
  project: string;
  service: string;
  projectDir: string;
  configFiles: string;
  pod: string;
  labels: Record<string, string>;
  /** The volumes it mounts, by name (Docker; Podman's list names none). */
  mounts: string[];
}

export interface ImageRow {
  id: string;
  repository: string;
  tag: string;
  reference: string;
  size: string;
  sizeBytes: number | null;
  created: string;
  dangling: boolean;
  containers: number | null;
}

export interface VolumeRow {
  name: string;
  driver: string;
  mountpoint: string;
  project: string;
  labels: Record<string, string>;
  /** From its inspect document; `""` when that could not be read. */
  created: string;
}

export interface NetworkRow {
  id: string;
  name: string;
  driver: string;
  scope: string;
  builtin: boolean;
  created: string;
  subnets: string[];
  /** Containers attached — `null` when the engine does not say (Podman). */
  containers: number | null;
}

export interface KubeRow {
  kind: string;
  name: string;
  namespace: string;
  status: string;
  tone: "ok" | "warn" | "bad" | "idle";
  ready: string;
  restarts: number | null;
  created: string;
  extra: Record<string, unknown>;
  labels: Record<string, string>;
}

export interface ForwardView {
  id: string;
  context: string;
  namespace: string;
  kind: string;
  name: string;
  localPort: number;
  remotePort: number;
  status: "starting" | "active" | "failed";
  error: string | null;
}

export interface ContainerSummary {
  image: string | null;
  command: string[] | string | null;
  entrypoint: string[] | string | null;
  workingDir: string | null;
  created: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  oomKilled: boolean | null;
  restartCount: number | null;
  restartPolicy: string | null;
  health: string | null;
  healthLog: { exitCode: number | null; output: string; end: string }[];
  env: { name: string; value: string; secret: boolean }[];
  mounts: { type: string; source: string; destination: string; readOnly: boolean }[];
  networks: { name: string; ip: string }[];
  ports: PortMap[];
  labels: Record<string, string>;
  stats?: { cpu: string; memory: string; memoryPercent: string; network: string; disk: string; processes: string };
}

/** The Kubernetes kinds the panel lists, in its order (`kube::KINDS`). */
export const KUBE_KINDS = [
  "pods",
  "deployments",
  "statefulsets",
  "daemonsets",
  "jobs",
  "cronjobs",
  "services",
  "ingresses",
  "configmaps",
  "secrets",
  "persistentvolumeclaims",
  "events",
  "nodes",
  "namespaces",
] as const;
export type KubeKind = (typeof KUBE_KINDS)[number];

/** What a selection points at: a row of an engine list, a Compose project, or a Kubernetes object. */
export interface ContainerSelection {
  runtime: RuntimeId;
  context: string | null;
  /** A Kubernetes object's namespace. */
  namespace: string | null;
  object: "container" | "image" | "volume" | "network" | "project" | "runtime" | KubeKind;
  id: string;
  name: string;
}

// ---------------------------------------------------------------- the manager (lite-dock's views)

/** A Docker Hub repository, as the image field's search lists it. */
export interface HubRepo {
  /** `nginx` for an official image, `bitnami/redis` for anyone else's. */
  name: string;
  description: string;
  stars: number;
  pulls: number;
  official: boolean;
}

export interface HubTag {
  name: string;
  size: number | null;
  updated: string | null;
}

export interface RunPort {
  /** `8080`, `127.0.0.1:8080`, or empty for a port the engine picks. */
  host: string;
  container: string;
  protocol: "tcp" | "udp";
}

export interface RunVolume {
  kind: "volume" | "bind";
  source: string;
  target: string;
  readOnly: boolean;
}

export interface RunEnv {
  key: string;
  value: string;
}

export type RestartPolicy = "no" | "always" | "unless-stopped" | "on-failure";

/** «Ejecutar contenedor»'s form — a `docker run -d` (`containers::run::RunSpec`). */
export interface RunSpec {
  image: string;
  name: string;
  ports: RunPort[];
  publishAll: boolean;
  env: RunEnv[];
  volumes: RunVolume[];
  restart: RestartPolicy;
  autoRemove: boolean;
  pull: "missing" | "always";
  /** Replaces the image's command, split the way a shell would; empty keeps it. */
  command: string;
  workdir: string;
  network: string;
  memoryMb: number | null;
  cpus: number | null;
  /** The container's own filesystem cannot be written; volumes and tmpfs still can. */
  readOnly?: boolean;
  /** `1000`, `1000:1000`, `app`; empty keeps the image's. */
  user?: string;
  capDrop?: string[];
  capAdd?: string[];
  noNewPrivileges?: boolean;
  /** `""` the engine's default profile, `unconfined`, or a profile's full path. */
  seccomp?: string;
  /** `/tmp` or `/tmp:size=64m,mode=1777`. */
  tmpfs?: string[];
  pidsLimit?: number | null;
  shmSizeMb?: number | null;
  health?: RunHealth;
}

/** A healthcheck replacing the image's (`containers::run::RunHealth`). */
export interface RunHealth {
  /** Run by the container's shell; empty keeps the image's check. */
  command: string;
  intervalS: number | null;
  timeoutS: number | null;
  startPeriodS: number | null;
  retries: number | null;
  /** Turns the image's check off; wins over a command. */
  disabled: boolean;
}

export interface ContainerStats {
  /** As the engine prints it (often the short id): match by prefix. */
  id: string;
  name: string;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number | null;
}

export interface FileEntry {
  name: string;
  dir: boolean;
  link: boolean;
  size: number | null;
  /** Unix seconds. */
  modified: number | null;
}

export interface ImageLayer {
  id: string;
  created: string;
  createdBy: string;
  size: number;
  comment: string;
}

export interface DiskUsageRow {
  kind: "images" | "containers" | "volumes" | "buildCache";
  count: number;
  active: number;
  size: number;
  reclaimable: number;
}

// ------------------------------------------------------------- Kubernetes clusters, anywhere

export interface KubeTools {
  kubectl: boolean;
  az: boolean;
  aws: boolean;
  gcloud: boolean;
  kubelogin: boolean;
  gkeAuthPlugin: boolean;
}

export type CloudSource = "aks" | "eks" | "gke";

export interface CloudAccount {
  /** An Azure subscription id, an AWS profile, a Google Cloud project id. */
  id: string;
  name: string;
  isDefault: boolean;
}

export interface CloudCluster {
  name: string;
  location: string;
  /** AKS: its resource group. GKE: its project. EKS: its region. */
  group: string;
  version: string;
  account: string;
}

export type KubeAddRequest =
  | { source: "file"; path: string; toUserConfig: boolean }
  | { source: "aks"; subscription: string; resourceGroup: string; name: string; admin: boolean; toUserConfig: boolean }
  | { source: "eks"; region: string; name: string; profile: string; toUserConfig: boolean }
  | { source: "gke"; project: string; location: string; name: string; toUserConfig: boolean }
  | {
      source: "manual";
      name: string;
      server: string;
      token: string;
      certificateAuthority: string;
      insecure: boolean;
      clientCertificate: string;
      clientKey: string;
      namespace: string;
      toUserConfig: boolean;
    };

export interface KubeAdded {
  contexts: string[];
  file: string;
  warnings: string[];
}

export interface KubeContextOrigin {
  context: string;
  file: string;
  /** In CodeFlow's own kubeconfig — the only ones the app removes. */
  managed: boolean;
}

export interface KubeTest {
  ok: boolean;
  version: string | null;
  error: string | null;
  hint: string | null;
}

/** What Azure says about the AKS cluster behind a context that does not answer. */
export interface AksStatus {
  /** Found among the subscriptions `az` is signed into. */
  found: boolean;
  name: string;
  resourceGroup: string;
  subscription: string;
  subscriptionName: string;
  /** Azure's power state: `Running`, `Stopped`. */
  power: string;
  /** Azure's provisioning state: `Succeeded`, `Starting`, `Stopping`… */
  provisioning: string;
  private: boolean;
  /** The addresses its API server lets in; empty when any may. */
  authorizedRanges: string[];
  /** The kubeconfig still names one of its current addresses. */
  addressCurrent: boolean;
}

/** A context switched to the Azure CLI's sign-in: the kubeconfig kubelogin rewrote, and the copy
 *  taken first. */
export interface AzureCliSwitch {
  file: string;
  backup: string;
}

// ------------------------------------------------------------------- topology (read-only graphs)

/** One object of a cluster's graph (`containers::topology`). `id` = `kind/namespace/name`. */
export interface TopoNode {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  status: string;
  tone: "ok" | "warn" | "bad" | "idle";
  ready: string;
  detail: string;
  /** Referenced, but not in the cluster. */
  missing: boolean;
}

export interface TopoEdge {
  from: string;
  to: string;
  kind: "routes" | "selects" | "owns" | "mounts" | "env" | "pull" | "claims" | "scales";
  label: string;
}

export interface TopoIssue {
  node: string;
  code: "noPods" | "missing" | "failing";
  detail: string;
}

export interface KubeTopology {
  nodes: TopoNode[];
  edges: TopoEdge[];
  issues: TopoIssue[];
  warnings: string[];
}

// ---------------------------------------------------------------------------- Azure (read-only)

export interface AzSubscription {
  id: string;
  name: string;
  detail: string;
  default: boolean;
}

export interface AzSubscriptions {
  found: boolean;
  contexts: AzSubscription[];
  error: string | null;
}

export interface AzGroup {
  id: string;
  name: string;
}

export interface AzResource {
  id: string;
  name: string;
  type: string;
  /** The resource's own `kind` (`functionapp,linux`). */
  flavor: string;
  location: string;
  group: string;
  sku: string;
  /** `provisioningState`. */
  state: string;
  tags: Record<string, string>;
}

export interface AzHealth {
  id: string;
  state: "Available" | "Degraded" | "Unavailable" | "Unknown" | string;
  summary: string;
  reason: string;
  since: string;
}

export interface AzActivity {
  time: string;
  operation: string;
  status: string;
  level: string;
  caller: string;
  resource: string;
  message: string;
}

export interface AzWorkspace {
  id: string;
  name: string;
  group: string;
  customerId: string;
  location: string;
}

export interface AzQueryResult {
  columns: string[];
  rows: unknown[][];
  cut: boolean;
}

export interface AzNode {
  id: string;
  name: string;
  type: string;
  flavor: string;
  group: string;
  location: string;
  state: string;
  external: boolean;
}

export interface AzEdge {
  from: string;
  to: string;
  kind: "ref" | "host" | "setting" | "vault";
  /** The property or setting's name — never its value. */
  label: string;
}

export interface AzTopology {
  nodes: AzNode[];
  edges: AzEdge[];
  warnings: string[];
}

// ------------------------------------------------------------------- builds (BuildKit's history)

export interface BuildRecord {
  id: string;
  name: string;
  status: "completed" | "failed" | "running" | "canceled" | string;
  createdAt: string;
  completedAt: string;
  totalSteps: number;
  completedSteps: number;
  cachedSteps: number;
}

export interface BuildDetail extends BuildRecord {
  context: string;
  dockerfile: string;
  platforms: string[];
  durationMs: number | null;
  error: string;
  logs: string;
}

// ------------------------------------------------------------------------ security (local scanner)

export interface Scanner {
  id: "trivy" | "grype" | string;
  path: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

export interface Finding {
  id: string;
  severity: Severity;
  package: string;
  installed: string;
  fixed: string;
  title: string;
  url: string;
}

export interface ScanResult {
  scanner: string;
  findings: Finding[];
  /** The kept scan's id; empty when it could not be kept. */
  id: string;
  /** RFC 3339. */
  scannedAt: string;
  /** The image's id at the time (`sha256:…`). */
  imageId: string;
}

/** One kept scan of an image, without its findings (`containers::scan::ScanSummary`). */
export interface ScanSummary {
  id: string;
  image: string;
  imageId: string;
  scanner: string;
  scannedAt: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

/** What a later scan found that an earlier one did not, and what it no longer finds. */
export interface ScanComparison {
  added: Finding[];
  fixed: Finding[];
  kept: number;
}

export type SbomFormat = "cyclonedx" | "spdx";

/** A file a container added, changed or deleted against its image. */
export interface DiffEntry {
  kind: "added" | "changed" | "deleted";
  path: string;
}

export type HardeningRule =
  | "privileged"
  | "engineSocket"
  | "hostMount"
  | "hostNetwork"
  | "hostPid"
  | "hostIpc"
  | "dangerousCap"
  | "seccompOff"
  | "apparmorOff"
  | "devices"
  | "rootUser"
  | "newPrivileges"
  | "writableRoot"
  | "noMemoryLimit"
  | "noCpuLimit"
  | "noPidsLimit"
  | "noHealthcheck"
  | "allInterfaces";

/** What in a container's configuration weakens its isolation (`containers::hardening`). */
export interface HardeningFinding {
  rule: HardeningRule;
  severity: "high" | "medium" | "low";
  /** A path, a capability, a port — or empty. */
  detail: string;
}

/** One problem hadolint found in a Dockerfile. */
export interface LintFinding {
  line: number;
  code: string;
  level: "error" | "warning" | "info" | "style" | string;
  message: string;
}
