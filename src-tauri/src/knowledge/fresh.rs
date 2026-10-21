//! How current the index is — what the repository watcher saw change, and which refreshes are
//! running now.
//!
//! The index used to learn about a change only by walking: any search more than a minute after the
//! last one re-listed and re-stat'ed every file of every repository in scope. The code map already
//! has a watcher feed (`crate::watcher` → `codemap::changed_paths`), and it forwards it here
//! ([`changed`], [`invalidated`], [`watched`]): a watched repository is brought up to date file by
//! file, only the files that changed, and trusted for longer in between. The minute-old lazy walk
//! stays as the fallback for what nothing watches (a document folder, a repository not open in a
//! window) and for a watcher that lost track.
//!
//! **One refresh per collection at a time** ([`claim`]): two searches arriving together used to
//! index the same repository twice over, one after the other on the index's lock. A collection being
//! refreshed is skipped by the second caller, which answers from what is there and says the results
//! are partial ([`in_progress`]).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

#[derive(Default)]
struct State {
    /// Roots a watcher is reporting for.
    watched: HashSet<PathBuf>,
    /// Paths (relative to the root) seen changing since the last refresh.
    dirty: HashMap<PathBuf, HashSet<String>>,
    /// Roots where something changed that a path list cannot describe: walk next time.
    dirty_all: HashSet<PathBuf>,
    /// Collections a refresh is working on now.
    running: HashSet<String>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));

fn canonical(root: &Path) -> PathBuf {
    root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
}

/// The watcher saw `paths` (absolute) change under `root`.
pub fn changed(root: &Path, paths: &[PathBuf]) {
    let given = root.to_path_buf();
    let root = canonical(root);
    let Ok(mut state) = STATE.lock() else { return };
    for path in paths {
        // The watcher reports real paths; a caller may hand the root as the user spelled it.
        let Ok(rel) = path.strip_prefix(&root).or_else(|_| path.strip_prefix(&given)) else {
            // A path outside the root the watcher was given (a symlinked tree, another spelling):
            // nothing itemisable, so walk.
            state.dirty_all.insert(root.clone());
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.is_empty() || rel == ".git" || rel.starts_with(".git/") {
            continue;
        }
        if path.is_dir() {
            // A folder appeared or moved: its files are not in the event.
            state.dirty_all.insert(root.clone());
        } else {
            state.dirty.entry(root.clone()).or_default().insert(rel);
        }
    }
}

/// The watcher lost track (an overflowed buffer): walk `root` next time.
pub fn invalidated(root: &Path) {
    if let Ok(mut state) = STATE.lock() {
        state.dirty_all.insert(canonical(root));
    }
}

/// Whether a watcher reports `root`'s changes. One that stops is walked next time: what happened
/// while nothing watched is unknown.
pub fn watched(root: &Path, on: bool) {
    let root = canonical(root);
    if let Ok(mut state) = STATE.lock() {
        if on {
            state.watched.insert(root);
        } else {
            state.watched.remove(&root);
            state.dirty_all.insert(root);
        }
    }
}

/// What the watcher says about `root` since the last call: whether it is watched, whether it must
/// be walked, and the paths that changed. Taking clears it — a change that arrives afterwards is for
/// the next refresh.
pub fn take(root: &Path) -> (bool, bool, Vec<String>) {
    let root = canonical(root);
    let Ok(mut state) = STATE.lock() else { return (false, true, Vec::new()) };
    let watched = state.watched.contains(&root);
    let all = state.dirty_all.remove(&root);
    let mut paths: Vec<String> = state.dirty.remove(&root).map(|set| set.into_iter().collect()).unwrap_or_default();
    paths.sort();
    (watched, all, paths)
}

/// Puts back what [`take`] handed out, for a refresh that failed before using it.
pub fn restore(root: &Path, all: bool, paths: Vec<String>) {
    let root = canonical(root);
    if let Ok(mut state) = STATE.lock() {
        if all {
            state.dirty_all.insert(root.clone());
        }
        if !paths.is_empty() {
            state.dirty.entry(root).or_default().extend(paths);
        }
    }
}

/// Held while a collection is being refreshed; released on drop.
pub struct Claim(String);

impl Drop for Claim {
    fn drop(&mut self) {
        if let Ok(mut state) = STATE.lock() {
            state.running.remove(&self.0);
        }
    }
}

/// The right to refresh `key`, or `None` while another refresh has it.
pub fn claim(key: &str) -> Option<Claim> {
    let mut state = STATE.lock().ok()?;
    state.running.insert(key.to_string()).then(|| Claim(key.to_string()))
}

/// Which of `keys` a refresh is working on now.
pub fn in_progress(keys: &[String]) -> Vec<String> {
    let Ok(state) = STATE.lock() else { return Vec::new() };
    keys.iter().filter(|k| state.running.contains(*k)).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_watcher_feed_itemises_files_and_walks_for_folders_and_lost_tracks() {
        let root = std::env::temp_dir().join(format!("codeflow-fresh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("docs")).unwrap();
        watched(&root, true);
        changed(&root, &[root.join("docs/a.md"), root.join(".git/index"), root.join("src/b.ts")]);
        let (watching, all, paths) = take(&root);
        assert!(watching && !all);
        assert_eq!(paths, vec!["docs/a.md", "src/b.ts"], "git's own files are not knowledge");
        assert_eq!(take(&root).2, Vec::<String>::new(), "taken once");
        changed(&root, &[root.join("docs")]);
        assert!(take(&root).1, "a folder changed: walk");
        invalidated(&root);
        assert!(take(&root).1);
        watched(&root, false);
        let (watching, all, _) = take(&root);
        assert!(!watching && all, "what happened unwatched is unknown");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn one_refresh_per_collection_at_a_time() {
        let key = format!("repo:{}", uuid::Uuid::new_v4());
        let first = claim(&key).unwrap();
        assert!(claim(&key).is_none());
        assert_eq!(in_progress(&[key.clone(), "other".into()]), vec![key.clone()]);
        drop(first);
        assert!(claim(&key).is_some());
        assert!(in_progress(&[key]).is_empty());
    }
}
