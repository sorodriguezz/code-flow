//! Kubernetes clusters anywhere — a kubeconfig file, AKS, EKS, GKE or a server typed in — added to
//! the Contenedores panel. See `crate::containers::kubeconfig`.

use crate::containers::kubeconfig;

/// Which of the tools a cluster may need are installed: kubectl, the cloud CLIs, their auth plugins.
#[tauri::command]
pub async fn containers_kube_tools() -> kubeconfig::KubeTools {
    kubeconfig::tools().await
}

/// The subscriptions (`aks`), profiles (`eks`) or projects (`gke`) the provider's CLI can use.
#[tauri::command]
pub async fn containers_kube_accounts(source: String) -> Result<Vec<kubeconfig::CloudAccount>, String> {
    kubeconfig::accounts(&source).await
}

/// The clusters of an account — and, for EKS, a region.
#[tauri::command]
pub async fn containers_kube_clouds(source: String, account: Option<String>, region: Option<String>) -> Result<Vec<kubeconfig::CloudCluster>, String> {
    kubeconfig::clouds(&source, account.as_deref().unwrap_or_default(), region.as_deref().unwrap_or_default()).await
}

#[tauri::command]
pub async fn containers_kube_add(request: kubeconfig::KubeAddRequest) -> Result<kubeconfig::KubeAdded, String> {
    kubeconfig::add(request).await
}

/// Where each context comes from, and whether it is one of CodeFlow's own.
#[tauri::command]
pub async fn containers_kube_origins() -> Result<Vec<kubeconfig::KubeContextOrigin>, String> {
    kubeconfig::origins().await
}

/// Takes a context out of CodeFlow's own kubeconfig (never the user's).
#[tauri::command]
pub async fn containers_kube_remove(context: String) -> Result<(), String> {
    kubeconfig::remove(&context).await
}

#[tauri::command]
pub async fn containers_kube_test(context: String) -> kubeconfig::KubeTest {
    kubeconfig::test(&context).await
}

/// What Azure says about a context's AKS cluster: stopped, private, behind authorized addresses,
/// moved to a new address, or not in any subscription `az` can see.
#[tauri::command]
pub async fn containers_kube_aks_status(context: String) -> Result<kubeconfig::AksStatus, String> {
    kubeconfig::aks_status(&context).await
}

/// Makes a context sign in with the Azure CLI's session instead of a device code — a rewrite of the
/// kubeconfig that holds it, which the panel confirms first.
#[tauri::command]
pub async fn containers_kube_use_azure_cli(context: String) -> Result<kubeconfig::AzureCliSwitch, String> {
    kubeconfig::use_azure_cli(&context).await
}
