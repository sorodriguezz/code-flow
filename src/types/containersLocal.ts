/** Local Kubernetes clusters and Helm, as `src-tauri/src/containers/{local,helm}.rs` serialise them. */

export type LocalTool = "kind" | "k3d" | "minikube";
export type LocalAction = "create" | "start" | "stop" | "delete";

export interface LocalTools {
  kind: boolean;
  k3d: boolean;
  minikube: boolean;
  helm: boolean;
  /** A Docker-compatible CLI: kind and k3d run their nodes as its containers. */
  docker: boolean;
}

export interface LocalCluster {
  tool: LocalTool;
  name: string;
  /** The kubeconfig context the tool wrote for it. */
  context: string;
  /** `running`, `stopped`, `partial`, or `""` when the tool does not say (kind). */
  state: string;
  nodes: number;
  runningNodes: number | null;
  version: string;
  /** k3d and minikube stop and start; kind does not. */
  canStop: boolean;
}

export interface LocalClusters {
  clusters: LocalCluster[];
  errors: string[];
}

export interface LocalClusterSpec {
  tool: LocalTool;
  action: LocalAction;
  name: string;
  /** Nodes besides the control plane. */
  workers?: number;
  /** `v1.30.0`, or a whole node image for kind and k3d. */
  version?: string | null;
  /** k3d only: this computer's port its load balancer forwards to the cluster's port 80. */
  ingressPort?: number | null;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  updated: string;
  status: string;
  chart: string;
  chartName: string;
  chartVersion: string;
  appVersion: string;
}

export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
}

export interface HelmReleaseDetail {
  name: string;
  namespace: string;
  status: string;
  description: string;
  revision: number;
  firstDeployed: string;
  lastDeployed: string;
  chartName: string;
  chartVersion: string;
  appVersion: string;
  notes: string;
  history: HelmRevision[];
  /** The values given to it, as YAML; `""` for none. */
  values: string;
  manifest: string;
  /** The `repo/chart` an upgrade most likely means. */
  chartGuess: string | null;
}

export interface HelmRepo {
  name: string;
  url: string;
}

export interface HelmChart {
  /** `repo/chart`. */
  name: string;
  version: string;
  appVersion: string;
  description: string;
}

/** An install or an upgrade. */
export interface HelmChange {
  context: string | null;
  namespace: string;
  name: string;
  chart: string;
  version?: string | null;
  /** YAML; empty for none (an upgrade then goes back to the chart's defaults). */
  values: string;
}
