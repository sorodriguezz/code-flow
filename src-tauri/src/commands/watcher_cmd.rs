use tauri::{AppHandle, State};

use crate::watcher::{self, WatcherRegistry};

#[tauri::command]
pub fn start_watching(app: AppHandle, registry: State<WatcherRegistry>, repo_path: String) -> Result<(), String> {
    watcher::start_watching(app, &registry, repo_path)
}

#[tauri::command]
pub fn stop_watching(registry: State<WatcherRegistry>, repo_path: String) -> Result<(), String> {
    watcher::stop_watching(&registry, &repo_path);
    Ok(())
}
