use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::remotectl::RemoteCtl;

/// The desktop window's claim on a repository, as one holder among several.
///
/// A single string rather than one per window because there is one window: `src/App.tsx` watches
/// whichever project is active and releases it when that changes.
pub const DESKTOP_HOLDER: &str = "desktop-window";

/// A paired device's claim, namespaced so it can never collide with [`DESKTOP_HOLDER`] and so
/// [`watched_by_a_device`] can tell the two apart by inspection.
pub fn device_holder(device_id: &str) -> String {
    format!("device:{device_id}")
}

fn is_device_holder(holder: &str) -> bool {
    holder.starts_with("device:")
}

/// One native watcher and everyone who currently depends on it.
struct Watched {
    /// Never read, and that is the whole of its job: dropping this value is what stops the native
    /// watcher, and dropping the channel sender it owns is what ends the thread below. Removing
    /// the entry from the map is therefore the teardown, with nothing to call.
    _watcher: RecommendedWatcher,
    /// [`DESKTOP_HOLDER`] and/or one [`device_holder`] per paired device looking at this repo.
    holders: HashSet<String>,
}

/// One native watcher per currently-open repo, **reference counted by holder**.
///
/// # Why holders and not a plain map
///
/// The desktop window is no longer the only thing that wants a repository watched. A paired phone
/// drives this same process and reads the same working copy, and until it could ask for a watcher
/// of its own it was watching whatever the desk happened to have open — so a phone on another
/// project saw no filesystem events at all.
///
/// Counting is what makes that safe to add. `src/App.tsx` releases its watcher on every project
/// change, unconditionally; without holders that teardown would silently stop the watcher a phone
/// on the same repository is depending on, which is a worse bug than the one being fixed. Each
/// party names itself, and the watcher goes away when the last of them lets go.
#[derive(Default)]
pub struct WatcherRegistry(Mutex<HashMap<String, Watched>>);

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

/// Whether the window is on screen.
///
/// Both conditions, matching `window_state`: on Windows a minimised window still answers
/// `is_visible() == true`. Defaulting to "seen" when the window cannot be queried at all keeps the
/// old behaviour on any path where there is no main window.
fn window_seen(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| !(!w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false)))
        .unwrap_or(true)
}

/// Whether there is anyone to emit to at all.
///
/// # Why the window alone is not the question any more
///
/// Suppressing the emit while the window is hidden is right when the webview is the only reader —
/// there is nobody to redraw for, and a branch switch can produce hundreds of these. But a phone
/// driving this install reads the same event through `remotectl::bridge`, and *tray* is precisely
/// the state the machine is in while somebody drives it from the sofa. So a hidden window with a
/// connected device used to mean the phone waiting on the desktop being restored to find out that
/// a commit had landed.
///
/// `receiver_count` is the honest test: every live WebSocket subscribes to `events` for exactly as
/// long as it is open (see `server::events`), so this is a count of phones listening right now and
/// not of devices somebody once paired. `RemoteCtl` is managed unconditionally in `lib.rs`, so the
/// lookup cannot fail.
fn watched(app: &AppHandle) -> bool {
    window_seen(app) || app.state::<RemoteCtl>().events.receiver_count() > 0
}

/// Whether any *paired device* is depending on this repository being watched.
///
/// Read by the event bridge: a repository only the desk has open produces filesystem churn no
/// phone asked for and none can use, and forwarding it means a frame per burst per device for a
/// working copy nobody on the other end is looking at.
pub fn watched_by_a_device(registry: &WatcherRegistry, repo_path: &str) -> bool {
    registry
        .0
        .lock()
        .map(|watchers| {
            watchers
                .get(repo_path)
                .is_some_and(|entry| entry.holders.iter().any(|h| is_device_holder(h)))
        })
        .unwrap_or(false)
}

/// Records `holder`'s claim on `repo_path`, building the native watcher only when this is the
/// first one. Answers whether it built it — i.e. whether the caller still owes the emitter thread.
///
/// The bookkeeping is split out from [`start_watching`] because it is the whole of the reference
/// counting and the tests have to reach it: constructing an `AppHandle` outside a running Tauri app
/// is not possible, and a correctness rule nobody can test is a correctness rule that decays.
fn install<F>(
    registry: &WatcherRegistry,
    repo_path: &str,
    holder: &str,
    build: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Result<RecommendedWatcher, String>,
{
    let mut watchers = registry.0.lock().map_err(|e| e.to_string())?;
    // Already watched: record the new holder and leave the running watcher exactly as it is.
    // Re-arming it here — which is what this used to do for every call — would drop the thread
    // mid-burst and lose whatever it had marked pending.
    if let Some(entry) = watchers.get_mut(repo_path) {
        entry.holders.insert(holder.to_string());
        return Ok(false);
    }
    watchers.insert(
        repo_path.to_string(),
        Watched {
            _watcher: build()?,
            holders: HashSet::from([holder.to_string()]),
        },
    );
    Ok(true)
}

/// Adds `holder` to the repository's watcher, starting one if this is the first claim on it.
pub fn start_watching(
    app: AppHandle,
    registry: &WatcherRegistry,
    repo_path: String,
    holder: &str,
) -> Result<(), String> {
    let (tx, rx) = channel::<notify::Result<Event>>();
    let started = install(registry, &repo_path, holder, || {
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
        watcher
            .watch(Path::new(&repo_path), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        Ok(watcher)
    })?;
    // Somebody else's thread is already reading this repository. `rx` drops here, which is
    // harmless: its sender belongs to the watcher that was *not* built.
    if !started {
        return Ok(());
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

        loop {
            // Read here only to choose how long to wait. The emit below re-reads it, because this
            // answer can be minutes old by the time a blocking `recv` returns — the window may well
            // have been hidden or restored, and a phone may well have connected or gone, while the
            // thread sat in it.
            //
            // The same predicate as the emit, deliberately. When these two disagreed, a change made
            // while the window was hidden but a phone was connected took the "waiting on a person"
            // branch below and sat for up to a second before the emit it was already entitled to.
            let seen = watched(&app);

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
            // Nothing is emitted when nobody is reading. The webview's handler for this event
            // refreshes the repository — a git status walk and the panels that redraw from it —
            // and while the app is parked in the tray with no phone connected there is no reader
            // for any of it. A branch switch or a long build can produce hundreds of these.
            //
            // `pending` is deliberately left standing rather than cleared, and `last_emit` is not
            // touched: an arbitrary number of unread bursts therefore collapse into exactly one
            // change, which fires on the first loop iteration after somebody comes back — so
            // restoring the window lands on a fully refreshed repository rather than a stale one.
            if pending && watched(&app) && last_emit.elapsed() >= Duration::from_millis(400) {
                pending = false;
                last_emit = Instant::now();
                let _ = app.emit("repo:fs-changed", RepoChangedEvent { repo_path: repo_path.clone() });
            }
        }
    });

    Ok(())
}

/// Drops `holder`'s claim, stopping the watcher only when it was the last one.
pub fn stop_watching(registry: &WatcherRegistry, repo_path: &str, holder: &str) {
    if let Ok(mut watchers) = registry.0.lock() {
        if let Some(entry) = watchers.get_mut(repo_path) {
            entry.holders.remove(holder);
            if entry.holders.is_empty() {
                watchers.remove(repo_path);
            }
        }
    }
}

/// Drops `holder`'s claim on every repository it holds.
///
/// The teardown for a party that goes away all at once rather than repository by repository — a
/// phone whose socket closed. Without it a device that browsed five projects during a session
/// would leave five native watchers running for a client that is no longer there.
pub fn release_holder(registry: &WatcherRegistry, holder: &str) {
    release_holder_except(registry, holder, "");
}

/// The same, sparing one path.
///
/// [`follow`] is the only caller with something to spare, and it needs this rather than a plain
/// release because the common case is re-claiming the repository it already holds: the mobile
/// client calls `watch_project` on *every* socket reopen, and a phone reconnects constantly — a
/// screen lock, a wifi handover, a tab evicted in the background. Releasing unconditionally would
/// empty the holder set, drop the `RecommendedWatcher` and end its emitter thread, and the
/// reinstall a line later would build a fresh one: a full recursive re-walk of the tree on every
/// reconnect, plus a window in which filesystem changes are silently missed. Precisely the case
/// `watch_project` exists for — a phone on a project the desk does not have open — is the case
/// where the phone is the sole holder and the teardown therefore actually happens.
fn release_holder_except(registry: &WatcherRegistry, holder: &str, keep: &str) {
    if let Ok(mut watchers) = registry.0.lock() {
        watchers.retain(|path, entry| {
            if path == keep {
                return true;
            }
            entry.holders.remove(holder);
            !entry.holders.is_empty()
        });
    }
}

/// Points `holder` at exactly one repository, releasing whatever else it was holding.
///
/// The shape a phone needs: the mobile client shows one project at a time, so its previous claim is
/// dead the moment it picks another. Written as replace-then-take rather than left to the caller
/// because forgetting the release is invisible — everything keeps working, and the machine simply
/// accumulates a native watcher per project the user ever tapped.
pub fn follow(
    app: AppHandle,
    registry: &WatcherRegistry,
    holder: &str,
    repo_path: String,
) -> Result<(), String> {
    // Everything *except* the one being claimed, so re-following the repository already followed is
    // a no-op instead of a teardown and rebuild. See `release_holder_except`; `install` already
    // handles "already watched, just add the holder" correctly, so the spared entry needs nothing
    // more than to survive to reach it.
    release_holder_except(registry, holder, &repo_path);
    start_watching(app, registry, repo_path, holder)
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

    /// [`install`] with the native half stubbed out.
    ///
    /// A `RecommendedWatcher` that watches nothing is enough for every claim below: the reference
    /// counting is pure bookkeeping over the map, and the only thing the watcher value contributes
    /// to it is being dropped when the last holder lets go. Building one avoids the test needing a
    /// directory on disk — and avoids it needing an `AppHandle`, which cannot be constructed outside
    /// a running Tauri app.
    fn claim(registry: &WatcherRegistry, repo_path: &str, holder: &str) {
        install(registry, repo_path, holder, || {
            notify::recommended_watcher(|_: notify::Result<Event>| {}).map_err(|e| e.to_string())
        })
        .unwrap();
    }

    /// **The regression the holder set exists to prevent.**
    ///
    /// `src/App.tsx` releases the active project's watcher on every project change, and it does so
    /// unconditionally — it has no way to know that a phone is looking at the same repository. Under
    /// the old map that teardown stopped the watcher outright, so switching projects at the desk
    /// silently froze the Repo tab of every phone on the repository just left.
    #[test]
    fn the_desktop_letting_go_does_not_stop_a_watcher_a_phone_is_holding() {
        let registry = WatcherRegistry::default();
        let phone = device_holder("phone-1");

        claim(&registry, "/repos/api", DESKTOP_HOLDER);
        claim(&registry, "/repos/api", &phone);

        stop_watching(&registry, "/repos/api", DESKTOP_HOLDER);
        assert!(
            watched_by_a_device(&registry, "/repos/api"),
            "the phone's claim must outlive the desktop's"
        );

        // And the last holder letting go is still what stops it — a refcount that never reaches
        // zero is a leak, not a fix.
        stop_watching(&registry, "/repos/api", &phone);
        assert!(registry.0.lock().unwrap().is_empty());
    }

    /// A phone shows one project at a time, so `follow` releases before it claims — otherwise a
    /// session spent browsing leaves one native watcher per project ever tapped. Tested through the
    /// release half, which is the half that has to happen.
    #[test]
    fn a_device_following_another_repo_lets_go_of_the_first() {
        let registry = WatcherRegistry::default();
        let phone = device_holder("phone-1");

        claim(&registry, "/repos/api", &phone);
        release_holder(&registry, &phone);
        claim(&registry, "/repos/web", &phone);

        assert!(!watched_by_a_device(&registry, "/repos/api"));
        assert!(watched_by_a_device(&registry, "/repos/web"));

        // The socket closing releases whatever is left, wherever it is.
        release_holder(&registry, &phone);
        assert!(registry.0.lock().unwrap().is_empty());
    }

    /// Releasing one device must leave the others alone — the same rule the revocation channel
    /// follows, for the same reason: one phone going away is not every phone going away.
    #[test]
    fn releasing_one_device_does_not_disturb_another() {
        let registry = WatcherRegistry::default();
        let first = device_holder("phone-1");
        let second = device_holder("phone-2");

        claim(&registry, "/repos/api", &first);
        claim(&registry, "/repos/api", &second);

        release_holder(&registry, &first);
        assert!(watched_by_a_device(&registry, "/repos/api"));
    }

    /// The desktop's own hold must not read as a device's, or the bridge would forward filesystem
    /// churn for a repository only the person at the desk has open.
    #[test]
    fn the_desktop_window_is_not_a_device() {
        let registry = WatcherRegistry::default();
        claim(&registry, "/repos/api", DESKTOP_HOLDER);
        assert!(!watched_by_a_device(&registry, "/repos/api"));
    }
}
