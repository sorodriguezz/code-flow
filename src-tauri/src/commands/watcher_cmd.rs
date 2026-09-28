use tauri::{AppHandle, State};

use crate::watcher::{self, WatcherRegistry};

/// The calling window's own claim, and only that — the holder is derived from the webview's label
/// (see [`watcher::window_holder`]), so the main window and a detached repository window watching the
/// same repository hold it independently. A paired phone takes its own through the `watch_project`
/// arm of `remotectl/dispatch.rs`, which is what keeps this command's teardown from stopping a
/// watcher the phone is depending on — see [`WatcherRegistry`].
#[tauri::command]
pub fn start_watching(
    app: AppHandle,
    webview: tauri::Webview,
    registry: State<WatcherRegistry>,
    repo_path: String,
) -> Result<(), String> {
    watcher::start_watching(app, &registry, repo_path, &watcher::window_holder(webview.label()))
}

#[tauri::command]
pub fn stop_watching(
    webview: tauri::Webview,
    registry: State<WatcherRegistry>,
    repo_path: String,
) -> Result<(), String> {
    watcher::stop_watching(&registry, &repo_path, &watcher::window_holder(webview.label()));
    Ok(())
}
