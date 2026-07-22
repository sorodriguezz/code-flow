use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One native watcher per currently-open repo. Dropping the `RecommendedWatcher` value
/// stops it, which is what removing it from the map on `stop_watching` achieves.
#[derive(Default)]
pub struct WatcherRegistry(Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Clone, Serialize)]
struct RepoChangedEvent {
    repo_path: String,
}

fn is_noise(event: &Event) -> bool {
    event.paths.iter().any(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".lock") || n == "FETCH_HEAD" || n == "COMMIT_EDITMSG")
            .unwrap_or(false)
    })
}

pub fn start_watching(app: AppHandle, registry: &WatcherRegistry, repo_path: String) -> Result<(), String> {
    stop_watching(registry, &repo_path);

    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&repo_path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    {
        let mut watchers = registry.0.lock().map_err(|e| e.to_string())?;
        watchers.insert(repo_path.clone(), watcher);
    }

    std::thread::spawn(move || {
        // Leading-edge throttle: emit on the first event of a burst, then ignore
        // anything else for a short window so e.g. a save-triggered rewrite of several
        // files only causes one refresh instead of a flood of them.
        let mut last_emit = Instant::now() - Duration::from_secs(10);
        while let Ok(result) = rx.recv() {
            let Ok(event) = result else { continue };
            if is_noise(&event) {
                continue;
            }
            if last_emit.elapsed() < Duration::from_millis(400) {
                continue;
            }
            last_emit = Instant::now();
            let _ = app.emit("repo:fs-changed", RepoChangedEvent { repo_path: repo_path.clone() });
        }
    });

    Ok(())
}

pub fn stop_watching(registry: &WatcherRegistry, repo_path: &str) {
    if let Ok(mut watchers) = registry.0.lock() {
        watchers.remove(repo_path);
    }
}
