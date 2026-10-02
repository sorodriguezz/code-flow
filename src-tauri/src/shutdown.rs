//! The last thing the app does, whichever way it ends.
//!
//! Most exits reach `RunEvent::Exit`: every quit path ends in `AppHandle::exit`, which raises that
//! event before it calls `std::process::exit`. Not all of them do. Installing an update on Windows
//! hands over to the installer and calls `std::process::exit` from inside the updater plugin, after
//! nothing but its `on_before_exit` hook — so services and their Compose containers, `ssh` tunnels,
//! language servers and AI CLIs still running were all left behind, reparented to nobody, and the
//! clean-exit marker was never cleared: the new version's first launch reported a crash that had not
//! happened.
//!
//! So the cleanup is one function, [`shutdown_cleanup`], and it runs once however many of those
//! paths reach it: the `Exit` event, the `on_before_exit` of an update installed from the Rust side
//! (`updates.rs`), and [`install_exit_hook`] for every other caller of `cleanup_before_exit` — the
//! update installed from the frontend among them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};

use tauri::{AppHandle, Manager, ResourceId, Runtime};

use crate::datasource::DbRegistry;

/// A job that runs at most once per process — and that a second caller *waits for* rather than
/// skipping while it is still running: an exit racing another exit must not end the process half-way
/// through the first one's cleanup.
pub struct RunOnce(Once);

impl RunOnce {
    pub const fn new() -> Self {
        Self(Once::new())
    }

    /// Runs `job` unless it already ran; `true` when this call is the one that ran it.
    ///
    /// A job that panicked counts as done. Running half a shutdown a second time is not safer than
    /// not running it, and `Once` would otherwise answer every later call with a panic of its own.
    pub fn run(&self, job: impl FnOnce()) -> bool {
        let mut ran = false;
        self.0.call_once_force(|state| {
            if !state.is_poisoned() {
                ran = true;
                job();
            }
        });
        ran
    }
}

static SHUTDOWN: RunOnce = RunOnce::new();

/// Everything the app has to stop or save on its way out. Idempotent: the first call does the work,
/// and any later one returns once it is finished. See the module note for who calls it.
///
/// Blocking is correct here: the point is to finish before the process does. Call it where
/// `tauri::async_runtime::block_on` is allowed — never on a runtime worker; see
/// [`run_outside_runtime`].
pub fn shutdown_cleanup(app: &AppHandle) {
    SHUTDOWN.run(|| {
        // The quit paths that never touch the close handler: the tray's Quit, ⌘Q, the
        // in-app quit. All three end in `AppHandle::exit`, which is here.
        crate::window_state::save(app);
        // The last four seconds of every bench terminal's output, which the flusher's timer
        // has not come round for. The shells themselves die with the process — that is what
        // a pty is — so this is the whole of what "don't lose my work" can mean here, and
        // it is the moment it has to happen.
        crate::commands::terminal_cmd::flush_transcripts(app);
        // Every AI CLI still running, with everything it started. Each was spawned into a
        // process group of its own — that is what makes Stop work — so none of them dies
        // with this process: left alone, an agent would go on editing a repository after
        // the app that started it is gone. Early in this block because it is the step whose
        // absence does damage. Then the turns it cut short are filed as stopped, and the
        // prompt files their runs never got to delete are deleted.
        crate::ai_runs::stop_all(std::time::Duration::from_secs(3));
        crate::commands::chat_cmd::record_turns_stopped_at_quit(app);
        crate::ai_prompt_files::remove_own();
        // Services, stopped the way the Stop button stops them — Ctrl-C first — rather than
        // by the process exiting under them. The difference is Compose: its Ctrl-C takes the
        // containers down, and an app that simply exits leaves them running.
        app.state::<Arc<crate::services::Supervisor>>()
            .shutdown(app, std::time::Duration::from_secs(8));
        let registry = app.state::<DbRegistry>();
        tauri::async_runtime::block_on(registry.close_all());
        // The Remote workspace's own `static` maps, for the reason the comment in `lib.rs` gives:
        // `forward`'s registry and the two file-session maps hold children that
        // `process::exit` walks straight past. Without this every quit leaves an `ssh -N`
        // holding a forwarded port, and an `ssh -s … sftp` holding a channel on somebody
        // else's machine, both reparented to init.
        tauri::async_runtime::block_on(crate::remotes::hold::release_all());
        // And every language server, for exactly the reason above: each is a separate
        // process holding an index of the repository, and a reparented `rust-analyzer`
        // keeps several hundred megabytes that nothing is left to reap.
        tauri::async_runtime::block_on(crate::lsp::stop_all());
        // Every notebook's Jupyter kernel: asked to shut down, then its process group killed if it
        // has not left. Each sits in a group of its own for interrupting, so none dies with this
        // process — and a kernel is a Python holding whatever the notebook loaded into memory.
        tauri::async_runtime::block_on(crate::jupyter::shutdown_all(std::time::Duration::from_secs(2)));
        // A debug session, whichever backend runs it. The program sits in a process group of its
        // own — that is what lets Stop reach what it started — so it would outlive this process,
        // quite possibly paused at a breakpoint for ever, holding whatever port it had opened.
        tauri::async_runtime::block_on(crate::commands::debug_cmd::stop_all());
        // The hybrid task's local model, if one is loaded. A child process does not die with its
        // parent, and this one can be holding twenty gigabytes; the sweep at the next launch would
        // find it, but only after it had sat in memory for however long the app was closed.
        tauri::async_runtime::block_on(crate::localai::executor::shutdown());
        // Last, once everything above has actually finished: the marker's whole meaning is
        // "the previous session did not get this far", so clearing it early would call a
        // shutdown clean that a hang in any of the steps above could still spoil.
        crate::applog::mark_clean_exit();
    });
}

/// Runs `job` where `tauri::async_runtime::block_on` is allowed, which is anywhere but inside a
/// Tokio runtime, and waits for it.
///
/// The cleanup blocks on async work — closing database sessions, stopping language servers — and the
/// exits that reach it through the updater arrive from inside a runtime: the frontend's install is an
/// async command on a runtime worker, and `block_on` there panics with "Cannot start a runtime from
/// within a runtime". A thread of its own has no runtime around it. On the main thread, where the
/// `Exit` event is handled, it runs in place, exactly as it always did.
pub fn run_outside_runtime(job: impl FnOnce() + Send) {
    if tokio::runtime::Handle::try_current().is_err() {
        job();
        return;
    }
    std::thread::scope(|scope| {
        if scope.spawn(job).join().is_err() {
            crate::applog::error("shutdown: the cleanup panicked");
        }
    });
}

/// Runs `on_exit` from inside `AppHandle::cleanup_before_exit`.
///
/// **Why a resource.** The updater the frontend drives (`updateStore.install`) is built by the plugin
/// itself, with an `on_before_exit` of the plugin's choosing — `cleanup_before_exit` and nothing of
/// ours — and there is no way to add to it. What `cleanup_before_exit` does, though, is empty the
/// app's resource table, dropping what is in it; and it is the step every exit that skips
/// `RunEvent::Exit` still takes: a Windows update install, `AppHandle::restart` on the main thread,
/// `exit` once the event loop is gone. A resource whose `Drop` runs the cleanup is how the app gets a
/// say there. On the ordinary path `cleanup_before_exit` runs right *after* the `Exit` handler, and
/// [`RunOnce`] makes the second call a no-op.
///
/// **Only that emptying runs it.** The webview can close a resource by id — the resources plugin
/// falls back to the app's table for an id the webview does not hold — and a close would drop this
/// just the same. `ResourceTable::close` calls `Resource::close` first, which marks the hook spent;
/// `clear` never calls it. Both behaviours are Tauri's, and the tests below pin them, so a version
/// that changes either fails here rather than in somebody's Windows update.
pub fn install_exit_hook<R: Runtime>(
    app: &AppHandle<R>,
    on_exit: impl FnOnce() + Send + Sync + 'static,
) -> ResourceId {
    app.resources_table().add(ExitHook { on_exit: Some(Box::new(on_exit)), spent: AtomicBool::new(false) })
}

struct ExitHook {
    on_exit: Option<Box<dyn FnOnce() + Send + Sync>>,
    spent: AtomicBool,
}

impl tauri::Resource for ExitHook {
    fn close(self: Arc<Self>) {
        self.spent.store(true, Ordering::SeqCst);
    }
}

impl Drop for ExitHook {
    fn drop(&mut self) {
        if self.spent.load(Ordering::SeqCst) {
            return;
        }
        if let Some(on_exit) = self.on_exit.take() {
            on_exit();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[test]
    fn a_job_runs_once_and_a_second_caller_waits_for_it() {
        let once = RunOnce::new();
        let runs = AtomicUsize::new(0);
        let finished = AtomicBool::new(false);
        let winners = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    let ran = once.run(|| {
                        runs.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(50));
                        finished.store(true, Ordering::SeqCst);
                    });
                    if ran {
                        winners.fetch_add(1, Ordering::SeqCst);
                    }
                    // Whoever lost the race still returns only after the cleanup is complete.
                    assert!(finished.load(Ordering::SeqCst));
                });
            }
        });
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(winners.load(Ordering::SeqCst), 1);
        assert!(!once.run(|| panic!("ran twice")));
    }

    #[test]
    fn a_job_that_panicked_is_not_run_again() {
        let once = RunOnce::new();
        let first = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            once.run(|| panic!("half a shutdown"));
        }));
        assert!(first.is_err());
        let mut again = false;
        assert!(!once.run(|| again = true));
        assert!(!again);
    }

    /// The exits that skip `RunEvent::Exit` all go through `cleanup_before_exit`; that is the whole
    /// of what the hook relies on.
    #[test]
    fn cleanup_before_exit_runs_the_hook_once() {
        let app = tauri::test::mock_app();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        install_exit_hook(app.handle(), move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(count.load(Ordering::SeqCst), 0);
        app.handle().cleanup_before_exit();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        app.handle().cleanup_before_exit();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    /// A close by id — which the webview can send for an id it does not own — is not an exit.
    #[test]
    fn closing_the_hook_by_id_never_runs_it() {
        let app = tauri::test::mock_app();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let rid = install_exit_hook(app.handle(), move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        app.handle().resources_table().close(rid).unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 0);
        app.handle().cleanup_before_exit();
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    /// Inside a runtime — where the frontend's update install calls the hook from — the cleanup's
    /// `block_on` would panic in place; moved to a thread of its own, it runs.
    #[test]
    fn a_job_that_blocks_on_async_work_runs_from_inside_a_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let ran = runtime.block_on(async {
            let mut ran = false;
            run_outside_runtime(|| {
                ran = tauri::async_runtime::block_on(async { true });
            });
            ran
        });
        assert!(ran);
        // And outside one, in place.
        let mut here = false;
        run_outside_runtime(|| here = tauri::async_runtime::block_on(async { true }));
        assert!(here);
    }
}
