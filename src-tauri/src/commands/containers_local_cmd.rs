//! Kubernetes on this computer and Helm, for the Contenedores panel: the clusters kind, k3d and
//! minikube run here (made, started, stopped and deleted as the manager's jobs — `localCluster`
//! sessions, see `containers_open_session`), and a cluster's Helm releases. See
//! `crate::containers::local` and `crate::containers::helm`.

use crate::containers::{helm, local};

/// Which of kind, k3d, minikube and helm are installed, and whether a Docker CLI is.
#[tauri::command]
pub async fn containers_local_tools() -> local::LocalTools {
    local::tools().await
}

/// Every cluster the installed tools know, and what the ones that failed to list said.
#[tauri::command]
pub async fn containers_local_clusters() -> local::LocalClusters {
    local::clusters().await
}

/// The command a `localCluster` job would run, as a terminal shows it — or why it would be refused.
#[tauri::command]
pub fn containers_local_preview(spec: local::LocalClusterSpec) -> Result<String, String> {
    local::preview(&spec)
}

#[tauri::command]
pub async fn containers_helm_releases(context: Option<String>) -> Result<Vec<helm::HelmRelease>, String> {
    helm::releases(context.as_deref()).await
}

/// One release: its state and notes, its revisions, the values it was given and its manifest.
#[tauri::command]
pub async fn containers_helm_release(context: Option<String>, namespace: String, name: String) -> Result<helm::HelmReleaseDetail, String> {
    helm::release(context.as_deref(), &namespace, &name).await
}

#[tauri::command]
pub async fn containers_helm_install(change: helm::HelmChange) -> Result<String, String> {
    helm::install(&change).await
}

#[tauri::command]
pub async fn containers_helm_upgrade(change: helm::HelmChange) -> Result<String, String> {
    helm::upgrade(&change).await
}

#[tauri::command]
pub async fn containers_helm_rollback(context: Option<String>, namespace: String, name: String, revision: u32) -> Result<String, String> {
    helm::rollback(context.as_deref(), &namespace, &name, revision).await
}

#[tauri::command]
pub async fn containers_helm_uninstall(context: Option<String>, namespace: String, name: String) -> Result<String, String> {
    helm::uninstall(context.as_deref(), &namespace, &name).await
}

/// The repositories in the user's Helm config.
#[tauri::command]
pub async fn containers_helm_repos() -> Result<Vec<helm::HelmRepo>, String> {
    helm::repos().await
}

#[tauri::command]
pub async fn containers_helm_repo_add(name: String, url: String) -> Result<String, String> {
    helm::repo_add(name.trim(), url.trim()).await
}

#[tauri::command]
pub async fn containers_helm_repo_remove(name: String) -> Result<String, String> {
    helm::repo_remove(name.trim()).await
}

#[tauri::command]
pub async fn containers_helm_repo_update() -> Result<String, String> {
    helm::repo_update().await
}

/// `helm search repo` — every version of one chart when `versions`.
#[tauri::command]
pub async fn containers_helm_search(term: String, versions: Option<bool>) -> Result<Vec<helm::HelmChart>, String> {
    helm::search(&term, versions.unwrap_or(false)).await
}

/// A chart's default values, to start an install's from.
#[tauri::command]
pub async fn containers_helm_chart_values(chart: String, version: Option<String>) -> Result<String, String> {
    helm::chart_values(chart.trim(), version.as_deref()).await
}
