use tauri::{AppHandle, State};

use crate::watcher::{self, WatcherRegistry};

/// The window's own claim, and only that. A paired phone takes its own through the `watch_project`
/// arm of `remotectl/dispatch.rs`, which is what keeps this command's teardown from stopping a
/// watcher the phone is depending on — see [`WatcherRegistry`].
#[tauri::command]
pub fn start_watching(app: AppHandle, registry: State<WatcherRegistry>, repo_path: String) -> Result<(), String> {
    watcher::start_watching(app, &registry, repo_path, watcher::DESKTOP_HOLDER)
}

#[tauri::command]
pub fn stop_watching(registry: State<WatcherRegistry>, repo_path: String) -> Result<(), String> {
    watcher::stop_watching(&registry, &repo_path, watcher::DESKTOP_HOLDER);
    Ok(())
}
