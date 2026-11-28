import type { LocalCluster, LocalTool } from "../../types/containersLocal";

/**
 * The plain rules behind the local-cluster and Helm pages — kept out of the components so they can
 * be tested, and kept the same as the backend's (`containers/local.rs`, `containers/helm.rs`), which
 * checks everything again: these only let a form say what is wrong before it is sent.
 */

export const LOCAL_TOOLS: LocalTool[] = ["kind", "k3d", "minikube"];

/** Nodes besides the control plane, at most — `local::MAX_WORKERS`. */
export const MAX_WORKERS = 9;

/** A cluster name every tool takes: lowercase letters, digits and inner dashes, up to 32. */
export function validClusterName(name: string): boolean {
  return name.length <= 32 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
}

/** A Helm release name: a DNS label of at most 53. */
export function validReleaseName(name: string): boolean {
  return name.length <= 53 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
}

export function validNamespace(name: string): boolean {
  return name.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
}

export function validRepoName(name: string): boolean {
  return name.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

export function validRepoUrl(url: string): boolean {
  return /^(https?|oci):\/\/\S+$/i.test(url);
}

/** The context each tool writes for its cluster. */
export function localContextOf(tool: LocalTool, name: string): string {
  return tool === "kind" ? `kind-${name}` : tool === "k3d" ? `k3d-${name}` : name;
}

/** The local cluster behind a kube context, when one of the tools made it. */
export function localClusterOf(clusters: LocalCluster[] | null | undefined, context: string | null): LocalCluster | null {
  if (!context || !clusters) return null;
  return clusters.find((c) => c.context === context) ?? null;
}

/** A name not taken yet by that tool: `dev`, then `dev-2`, `dev-3`… */
export function freeClusterName(clusters: LocalCluster[], tool: LocalTool, base = "dev"): string {
  const taken = new Set(clusters.filter((c) => c.tool === tool).map((c) => c.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The dot a local cluster's state gets. */
export function localTone(state: string): "ok" | "warn" | "bad" | "idle" {
  if (state === "running") return "ok";
  if (state === "partial") return "warn";
  return "idle";
}

/** The dot a Helm status gets. */
export function helmTone(status: string): "ok" | "warn" | "bad" | "idle" {
  if (status === "deployed") return "ok";
  if (status === "failed") return "bad";
  if (status.startsWith("pending") || status === "uninstalling") return "warn";
  return "idle";
}

/** A release name for a chart picked from a search: the chart's own name, made a valid release. */
export function releaseNameFor(chart: string): string {
  const own = chart.split("/").pop() ?? chart;
  const tidy = own
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 53)
    .replace(/-+$/g, "");
  return tidy || "release";
}
