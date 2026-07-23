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
        // Leading-edge-with-trailing-catchup throttle: the first event of a burst emits
        // immediately; anything else within 400ms just marks a change as pending instead of
        // being dropped outright. Once the burst goes quiet, the next poll tick (at most
        // ~200ms later, and only once 400ms has actually elapsed since the last emit) flushes
        // that pending change — a plain leading-edge throttle (emit-then-ignore-for-400ms,
        // nothing after) silently lost whatever event landed inside that window with no
        // later event to "wake it back up", which is exactly what happened when e.g. Claude's
        // Edit tool wrote several files in a row: everything but the first write vanished
        // until something unrelated (switching projects and back) forced a fresh reload.
        //
        // `Err` results (e.g. a `ReadDirectoryChangesW` buffer overflow on Windows when too
        // many changes land at once) are treated the same as a real change rather than
        // silently ignored — we don't know what changed, so the safe move is to refresh.
        let mut last_emit = Instant::now() - Duration::from_secs(10);
        let mut pending = false;
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(event)) => {
                    if !is_noise(&event) {
                        pending = true;
                    }
                }
                Ok(Err(_)) => pending = true,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if pending && last_emit.elapsed() >= Duration::from_millis(400) {
                pending = false;
                last_emit = Instant::now();
                let _ = app.emit("repo:fs-changed", RepoChangedEvent { repo_path: repo_path.clone() });
            }
        }
    });

    Ok(())
}

pub fn stop_watching(registry: &WatcherRegistry, repo_path: &str) {
    if let Ok(mut watchers) = registry.0.lock() {
        watchers.remove(repo_path);
    }
}
