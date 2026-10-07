/** The Contenedores panel's data, as `src-tauri/src/containers` serialises it. */

export type RuntimeId = "docker" | "podman" | "nerdctl" | "ctr" | "kubernetes";

export interface ContextInfo {
  name: string;
  /** A Docker context's endpoint, or a Kubernetes context's cluster. */
  detail: string;
  /** A Kubernetes context's own default namespace. */
  namespace: string;
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
}

export interface NetworkRow {
  id: string;
  name: string;
  driver: string;
  scope: string;
  builtin: boolean;
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

/** What an engine lists. */
export type EngineList = "containers" | "images" | "volumes" | "networks";

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

export const CLUSTER_KINDS: ReadonlySet<string> = new Set(["nodes", "namespaces"]);

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
