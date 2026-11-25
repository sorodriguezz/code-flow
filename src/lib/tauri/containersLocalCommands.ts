import { invoke } from "./invoke";
import type { HelmChange, HelmChart, HelmRelease, HelmReleaseDetail, HelmRepo, LocalClusterSpec, LocalClusters, LocalTools } from "../../types/containersLocal";

/** Local clusters (kind, k3d, minikube) and Helm — `commands/containers_local_cmd.rs`. Making,
 *  starting, stopping and deleting a cluster are jobs: a `localCluster` session (`containersOpenSession`). */

export const containersLocalTools = () => invoke<LocalTools>("containers_local_tools");

export const containersLocalClusters = () => invoke<LocalClusters>("containers_local_clusters");

/** The command a job would run, as a terminal shows it; rejects with why it would be refused. */
export const containersLocalPreview = (spec: LocalClusterSpec) => invoke<string>("containers_local_preview", { spec });

export const containersHelmReleases = (context: string | null) => invoke<HelmRelease[]>("containers_helm_releases", { context });

export const containersHelmRelease = (context: string | null, namespace: string, name: string) =>
  invoke<HelmReleaseDetail>("containers_helm_release", { context, namespace, name });

export const containersHelmInstall = (change: HelmChange) => invoke<string>("containers_helm_install", { change });

export const containersHelmUpgrade = (change: HelmChange) => invoke<string>("containers_helm_upgrade", { change });

export const containersHelmRollback = (context: string | null, namespace: string, name: string, revision: number) =>
  invoke<string>("containers_helm_rollback", { context, namespace, name, revision });

export const containersHelmUninstall = (context: string | null, namespace: string, name: string) =>
  invoke<string>("containers_helm_uninstall", { context, namespace, name });

export const containersHelmRepos = () => invoke<HelmRepo[]>("containers_helm_repos");

export const containersHelmRepoAdd = (name: string, url: string) => invoke<string>("containers_helm_repo_add", { name, url });

export const containersHelmRepoRemove = (name: string) => invoke<string>("containers_helm_repo_remove", { name });

export const containersHelmRepoUpdate = () => invoke<string>("containers_helm_repo_update");

export const containersHelmSearch = (term: string, versions = false) => invoke<HelmChart[]>("containers_helm_search", { term, versions });

export const containersHelmChartValues = (chart: string, version: string | null) => invoke<string>("containers_helm_chart_values", { chart, version });
