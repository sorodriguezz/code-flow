//! Azure in the Contenedores panel — read-only, through `az` and the person's own login. See
//! `crate::containers::azure`.

use serde_json::Value;

use crate::architecture::cloud::{CloudContexts, CloudScope};
use crate::containers::azure;

#[tauri::command]
pub fn azure_found() -> bool {
    azure::found()
}

#[tauri::command]
pub async fn azure_subscriptions() -> CloudContexts {
    azure::subscriptions().await
}

#[tauri::command]
pub async fn azure_groups(subscription: String) -> Result<Vec<CloudScope>, String> {
    azure::groups(&subscription).await
}

#[tauri::command]
pub async fn azure_resources(subscription: String, group: Option<String>) -> Result<Vec<azure::AzResource>, String> {
    azure::resources(&subscription, group.as_deref()).await
}

#[tauri::command]
pub async fn azure_show(id: String) -> Result<Value, String> {
    azure::show(&id).await
}

#[tauri::command]
pub async fn azure_health(subscription: String, group: Option<String>) -> Result<Vec<azure::AzHealth>, String> {
    azure::health(&subscription, group.as_deref()).await
}

#[tauri::command]
pub async fn azure_activity(subscription: String, group: Option<String>, resource: Option<String>, hours: Option<u32>) -> Result<Vec<azure::AzActivity>, String> {
    azure::activity(&subscription, group.as_deref(), resource.as_deref(), hours.unwrap_or(24)).await
}

/// A resource's logs read once (the panel follows them in a terminal session, kind `azureLogs`).
#[tauri::command]
pub async fn azure_logs(id: String, tail: Option<u32>) -> Result<String, String> {
    azure::logs(&id, tail.unwrap_or(300)).await
}

#[tauri::command]
pub async fn azure_workspaces(subscription: String) -> Result<Vec<azure::AzWorkspace>, String> {
    azure::workspaces(&subscription).await
}

#[tauri::command]
pub async fn azure_query(workspace: String, query: String, hours: Option<u32>) -> Result<azure::AzQueryResult, String> {
    azure::query(&workspace, &query, hours.unwrap_or(24)).await
}

#[tauri::command]
pub async fn azure_topology(subscription: String, group: Option<String>) -> Result<azure::AzTopology, String> {
    azure::topology(&subscription, group.as_deref()).await
}
