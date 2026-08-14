use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// One native watcher per currently-open repo. Dropping the `RecommendedWatcher` value
/// stops it, which is what removing it from the map on `stop_watching` achieves.
#[derive(Default)]
pub struct WatcherRegistry(Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Clone, Serialize)]
struct RepoChangedEvent {
    repo_path: String,
}

/// Directory names that are never part of what the repo view shows: dependency trees and
/// build output. These used to sail straight through the filter, which made the watcher the
/// app's biggest source of idle CPU — a single `npm install` or `cargo build` writes
/// thousands of files, and at one emission per 400ms each one costs the frontend a *full*
/// repo refresh (9 IPC invokes, 11 store writes, a whole-file-context working diff).
///
/// Yes, a repo could legitimately track a folder called `dist` or `build`; the trade is
/// deliberate. Losing live refresh on committed build output is far cheaper than freezing
/// the UI for the whole duration of every build. Anything the user does inside the app
/// (stage, commit, checkout) refreshes explicitly and does not depend on the watcher.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

/// Paths *inside* `.git` that churn without changing anything the UI renders. Each entry is
/// the sequence of components that follows the `.git` component.
///
/// This is also how the app stops feeding itself: our own `git fetch` rewrites
/// `.git/objects/pack/*`, `.git/refs/remotes/*` and `.git/packed-refs`, so every fetch used
/// to trigger a second full refresh right after the one the fetch already does itself.
/// The cost is that a fetch run from an *external* terminal no longer updates ahead/behind
/// on its own — the next refresh (any other file change, or a user action) picks it up.
const IGNORED_GIT_PATHS: &[&[&str]] = &[
    &["objects"],           // loose objects + packs: written by every commit/fetch/gc
    &["logs"],              // reflog; the ref updates themselves are seen via refs/heads
    &["lfs"],               // git-lfs object cache
    &["packed-refs"],       // rewritten wholesale by fetch/gc
    &["refs", "remotes"],   // remote-tracking refs, rewritten by every fetch
];

/// Everything under `.git` that is NOT listed above stays watched, because those paths are
/// the only way an *external* `git checkout` / `git add` / `git stash` / merge is detected,
/// which is the entire reason the full refresh exists. Test-by-inspection of the five that
/// must keep returning `false` (= not noise), with `rest` = components after `.git`:
///
/// | path (relative to repo root) | file-name rule       | IGNORED_DIRS | rest              | IGNORED_GIT_PATHS match          | is_noise |
/// |------------------------------|----------------------|--------------|-------------------|----------------------------------|----------|
/// | `.git/HEAD`                  | not *.lock, != FETCH_HEAD | no      | ["HEAD"]          | no prefix matches                | false    |
/// | `.git/refs/heads/main`       | not *.lock           | no           | ["refs","heads",…]| ["refs","remotes"] fails at [1]  | false    |
/// | `.git/index`                 | not *.lock           | no           | ["index"]         | no prefix matches                | false    |
/// | `.git/MERGE_HEAD`            | != FETCH_HEAD        | no           | ["MERGE_HEAD"]    | no prefix matches                | false    |
/// | `.git/rebase-merge/done`     | not *.lock           | no           | ["rebase-merge",…]| no prefix matches                | false    |
///
/// Note the `refs` row: the rule is `["refs", "remotes"]`, compared component by component,
/// so it can never swallow `refs/heads`. `.git/index.lock` and `.git/HEAD.lock` are still
/// noise via the file-name rule — they are transient and the real write follows.
fn is_noise_path(root: &Path, p: &Path) -> bool {
    // File-name noise, unchanged from the original filter: git's lock files and the scratch
    // files it rewrites on every fetch/commit.
    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
        if name.ends_with(".lock") || name == "FETCH_HEAD" || name == "COMMIT_EDITMSG" {
            return true;
        }
    }

    // Only the part of the path *below* the repo root is inspected. A repo that happens to
    // live in `~/dist/myapp` or `~/build/thing` must not have every single event classified
    // as noise, which would silently kill the watcher for that user. `strip_prefix` is the
    // normal path; when it fails (macOS FSEvents can report `/private/var/...` where the
    // root says `/var/...`) we fall back to dropping as many leading components as the root
    // has, which is close enough — the components we care about are all near the tail.
    let relative: Option<&Path> = p.strip_prefix(root).ok();
    let skip = if relative.is_some() { 0 } else { root.components().count() };
    // Matching is done on components, never on the rendered string: on Windows the
    // separator is `\`, so a `to_string_lossy().contains(".git/objects")` test would never
    // fire and every fetch would keep triggering a full refresh on the user's main platform.
    let comps: Vec<&str> = relative
        .unwrap_or(p)
        .components()
        .skip(skip)
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    for (i, comp) in comps.iter().enumerate() {
        if IGNORED_DIRS.contains(comp) {
            return true;
        }
        if *comp == ".git" {
            let rest = &comps[i + 1..];
            if IGNORED_GIT_PATHS.iter().any(|prefix| rest.starts_with(prefix)) {
                return true;
            }
        }
    }

    false
}

fn is_noise(root: &Path, event: &Event) -> bool {
    // `all`, not `any`: an event can carry two paths (a rename reports from *and* to), and
    // with the much broader filter above an `any` would drop the whole event whenever one
    // half happened to be ignorable — including git's own `.git/index.lock` -> `.git/index`
    // rename, i.e. exactly the `git add` we must never miss. An empty path list means "we
    // don't know what changed", so it is treated as a real change and refreshed.
    !event.paths.is_empty() && event.paths.iter().all(|p| is_noise_path(root, p))
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

    // Kept as a `PathBuf` so `is_noise_path` can strip the repo root off every event path
    // before looking for ignored directory names (see the comment there).
    let root = PathBuf::from(&repo_path);

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

        /// Whether there is anyone to emit to.
        ///
        /// Both conditions, matching `window_state`: on Windows a minimised window still answers
        /// `is_visible() == true`. Defaulting to "seen" when the window cannot be queried at all
        /// keeps the old behaviour on any path where there is no main window.
        fn window_seen(app: &AppHandle) -> bool {
            app.get_webview_window("main")
                .map(|w| !(!w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false)))
                .unwrap_or(true)
        }

        loop {
            // Read here only to choose how long to wait. The emit below re-reads it, because this
            // answer can be minutes old by the time a blocking `recv` returns — the window may well
            // have been hidden or restored while the thread sat in it.
            let seen = window_seen(&app);

            // The timeout exists only to flush a *pending* change once its burst goes quiet, so
            // with nothing pending there is nothing a tick could do and the thread blocks on the
            // channel instead — rather than waking five times a second, per watched repository, for
            // as long as the app is open. A real event wakes it immediately either way; that is
            // what a channel is for.
            //
            // The third case is a change held back because the window is hidden (see below). That
            // one is waiting on a person, not on a burst, so it waits a second at a time: the emit
            // still lands on the first iteration after the window returns, and a second of latency
            // on a repository the user is only now looking at is not perceptible.
            let received = match (pending, seen) {
                (false, _) => rx.recv().map_err(|_| std::sync::mpsc::RecvTimeoutError::Disconnected),
                (true, true) => rx.recv_timeout(Duration::from_millis(200)),
                (true, false) => rx.recv_timeout(Duration::from_secs(1)),
            };
            match received {
                Ok(Ok(event)) => {
                    if !is_noise(&root, &event) {
                        pending = true;
                    }
                }
                Ok(Err(_)) => pending = true,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // Nothing is emitted into a window nobody can see. The webview's handler for this
            // event refreshes the repository — a git status walk and the panels that redraw from
            // it — and while the app is parked in the tray, or minimised, there is no reader for
            // any of it. A branch switch or a long build can produce hundreds of these.
            //
            // `pending` is deliberately left standing rather than cleared, and `last_emit` is not
            // touched: an arbitrary number of hidden bursts therefore collapse into exactly one
            // change, which fires on the first loop iteration after the window comes back — so
            // restoring the window lands on a fully refreshed repository rather than a stale one.
            if pending && window_seen(&app) && last_emit.elapsed() >= Duration::from_millis(400) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Built with `join` so the test itself is separator-agnostic and passes on Windows too.
    fn under_root(rel: &[&str]) -> PathBuf {
        let mut p = PathBuf::from("/home/dev/repo");
        for c in rel {
            p.push(c);
        }
        p
    }

    fn root() -> PathBuf {
        PathBuf::from("/home/dev/repo")
    }

    #[test]
    fn keeps_watching_the_paths_that_detect_external_git_commands() {
        // The five in the table above. If any of these ever becomes noise, an external
        // `git checkout` / `git add` / `git stash` / merge stops showing up in the UI.
        for rel in [
            vec![".git", "HEAD"],
            vec![".git", "refs", "heads", "main"],
            vec![".git", "index"],
            vec![".git", "MERGE_HEAD"],
            vec![".git", "rebase-merge", "done"],
        ] {
            let p = under_root(&rel);
            assert!(!is_noise_path(&root(), &p), "{:?} must stay watched", p);
        }
    }

    #[test]
    fn filters_dependency_and_build_trees() {
        for rel in [
            vec!["node_modules", "react", "index.js"],
            vec!["src-tauri", "target", "debug", "build", "x.rs"],
            vec!["dist", "assets", "app.js"],
            vec![".next", "cache", "x"],
            vec!["api", "__pycache__", "m.pyc"],
        ] {
            let p = under_root(&rel);
            assert!(is_noise_path(&root(), &p), "{:?} must be noise", p);
        }
    }

    #[test]
    fn filters_git_internals_that_only_the_app_itself_churns() {
        for rel in [
            vec![".git", "objects", "pack", "pack-abc.pack"],
            vec![".git", "logs", "HEAD"],
            vec![".git", "lfs", "objects", "aa"],
            vec![".git", "packed-refs"],
            vec![".git", "refs", "remotes", "origin", "main"],
            vec![".git", "index.lock"],
        ] {
            let p = under_root(&rel);
            assert!(is_noise_path(&root(), &p), "{:?} must be noise", p);
        }
    }

    #[test]
    fn repo_living_inside_an_ignored_directory_is_still_watched() {
        // Regression guard: matching the full absolute path would classify *every* event of
        // a repo cloned into `~/build/` as noise and silently kill the watcher for that user.
        let root = PathBuf::from("/home/dev/build/myapp");
        let p = root.join("src").join("main.rs");
        assert!(!is_noise_path(&root, &p));
    }

    #[test]
    fn ordinary_source_edits_are_never_noise() {
        assert!(!is_noise_path(&root(), &under_root(&["src", "App.tsx"])));
        assert!(!is_noise_path(&root(), &under_root(&["README.md"])));
    }
}
