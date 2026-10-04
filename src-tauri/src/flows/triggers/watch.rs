//! The file trigger: a folder (or one file) watched for files that appear, change or go.
//!
//! Editors and copy tools touch a file several times while writing it, so events are gathered per
//! path and a path fires once it has been quiet for the trigger's debounce — one item for a CSV that
//! arrived, not four for the four writes that made it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use globset::{Glob, GlobMatcher};
use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::TriggerView;
use crate::flows::run::Item;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Change {
    Created,
    Modified,
    Deleted,
}

impl Change {
    fn name(self) -> &'static str {
        match self {
            Change::Created => "created",
            Change::Modified => "modified",
            Change::Deleted => "deleted",
        }
    }
}

fn wanted(params: &Value) -> Vec<Change> {
    params
        .get("events")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter_map(|name| match name {
                    "created" => Some(Change::Created),
                    "modified" => Some(Change::Modified),
                    "deleted" => Some(Change::Deleted),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_else(|| vec![Change::Created])
}

fn item_for(path: &Path, change: Change) -> Value {
    let meta = std::fs::metadata(path).ok();
    json!({
        "event": change.name(),
        "path": path.to_string_lossy(),
        "name": path.file_name().map(|n| n.to_string_lossy().into_owned()),
        "extension": path.extension().map(|e| e.to_string_lossy().into_owned()),
        "folder": path.parent().map(|p| p.to_string_lossy().into_owned()),
        "size": meta.as_ref().map(|m| m.len()),
        "modifiedAt": meta.and_then(|m| m.modified().ok()).map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()),
    })
}

pub fn spawn(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    params: &Value,
    view: Arc<Mutex<TriggerView>>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let root = PathBuf::from(params.get("watchPath").and_then(Value::as_str).unwrap_or_default().trim());
    if !root.exists() {
        return Err(format!("{} does not exist", root.display()));
    }
    let recursive = params.get("recursive").and_then(Value::as_bool).unwrap_or(false);
    let debounce = Duration::from_millis(params.get("debounceMs").and_then(Value::as_u64).unwrap_or(500).clamp(50, 60_000));
    let pattern = params.get("pattern").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let matcher: Option<GlobMatcher> = if pattern.is_empty() {
        None
    } else {
        Some(Glob::new(&pattern).map_err(|e| format!("\"{pattern}\" is not a pattern: {e}"))?.compile_matcher())
    };
    let wanted = wanted(params);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(PathBuf, Change)>();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        let change = match event.kind {
            EventKind::Create(_) => Change::Created,
            EventKind::Modify(notify::event::ModifyKind::Name(_)) => Change::Created,
            EventKind::Modify(_) => Change::Modified,
            EventKind::Remove(_) => Change::Deleted,
            _ => return,
        };
        for path in event.paths {
            let _ = tx.send((path, change));
        }
    })
    .map_err(|e| format!("could not watch {}: {e}", root.display()))?;
    watcher
        .watch(&root, if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive })
        .map_err(|e| format!("could not watch {}: {e}", root.display()))?;

    let app = app.clone();
    let flow_id = flow_id.to_string();
    let node_id = node_id.to_string();
    tauri::async_runtime::spawn(async move {
        // The watcher lives as long as this task: dropping it is what stops the watching.
        let _watcher = watcher;
        let mut pending: HashMap<PathBuf, (Change, Instant)> = HashMap::new();
        loop {
            let tick = tokio::time::sleep(Duration::from_millis(100));
            tokio::select! {
                _ = cancel.cancelled() => return,
                received = rx.recv() => {
                    let Some((path, change)) = received else { return };
                    // A file that was created and then written stays "created".
                    let entry = pending.entry(path).or_insert((change, Instant::now()));
                    if !(entry.0 == Change::Created && change == Change::Modified) {
                        entry.0 = change;
                    }
                    entry.1 = Instant::now();
                }
                _ = tick => {}
            }
            let ripe: Vec<(PathBuf, Change)> = pending
                .iter()
                .filter(|(_, (_, at))| at.elapsed() >= debounce)
                .map(|(path, (change, _))| (path.clone(), *change))
                .collect();
            for (path, change) in ripe {
                pending.remove(&path);
                if !wanted.contains(&change) || path.is_dir() {
                    continue;
                }
                if let Some(matcher) = &matcher {
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    if !matcher.is_match(&name) && !matcher.is_match(&path) {
                        continue;
                    }
                }
                if let Err(error) = super::fire(&app, &flow_id, &node_id, vec![Item::new(item_for(&path, change))]) {
                    super::note_problem(&view, Some(error));
                }
            }
        }
    });
    Ok(())
}
