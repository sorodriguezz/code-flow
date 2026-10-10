//! The repository map's commands for the «Mapa» view: the folder graph, a file's outline, symbol
//! search and usages. Every one reads the same cached map the agents read (`codemap`), built on the
//! first call and brought up to date by the next — on a blocking thread, since the first build reads
//! the whole working tree.

use serde::Serialize;

use crate::codemap::index::{FileOutline, SymbolHit, UsageReport};
use crate::codemap::summary::MapGraph;
use crate::codemap::BuildInfo;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapView {
    pub graph: MapGraph,
    pub build: BuildInfo,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// The folders and files one level under `focus` (`""` for the repository root), with the imports
/// between them.
#[tauri::command]
pub async fn codemap_graph(repo_path: String, focus: String) -> Result<MapView, String> {
    blocking(move || {
        let (map, build) = crate::codemap::snapshot(&repo_path)?;
        Ok(MapView { graph: crate::codemap::summary::graph(&map, &focus), build })
    })
    .await
}

/// The whole project at once — every file when it fits on a canvas, folders otherwise.
#[tauri::command]
pub async fn codemap_global(repo_path: String) -> Result<MapView, String> {
    blocking(move || {
        let (map, build) = crate::codemap::snapshot(&repo_path)?;
        Ok(MapView { graph: crate::codemap::summary::global_graph(&map, GLOBAL_NODES), build })
    })
    .await
}

/// Nodes the global view draws at most — readable when zoomed in, a shape when fitted.
const GLOBAL_NODES: usize = 140;

#[tauri::command]
pub async fn codemap_outline(repo_path: String, path: String) -> Result<Option<FileOutline>, String> {
    blocking(move || {
        let (map, _) = crate::codemap::snapshot(&repo_path)?;
        Ok(map.outline(&path))
    })
    .await
}

#[tauri::command]
pub async fn codemap_find(repo_path: String, query: String) -> Result<Vec<SymbolHit>, String> {
    blocking(move || {
        let (map, _) = crate::codemap::snapshot(&repo_path)?;
        Ok(map.find_symbol(&query, 30))
    })
    .await
}

#[tauri::command]
pub async fn codemap_usages(repo_path: String, name: String, path: Option<String>) -> Result<UsageReport, String> {
    blocking(move || {
        let (map, _) = crate::codemap::snapshot(&repo_path)?;
        Ok(map.usages(&name, path.as_deref(), 200))
    })
    .await
}

/// The most-used declarations — what the view lists before anything is searched.
#[tauri::command]
pub async fn codemap_key_symbols(repo_path: String) -> Result<Vec<SymbolHit>, String> {
    blocking(move || {
        let (map, _) = crate::codemap::snapshot(&repo_path)?;
        Ok(map.key_symbols(40))
    })
    .await
}
