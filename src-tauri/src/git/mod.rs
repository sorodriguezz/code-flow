pub mod bisect;
pub mod blame;
pub mod blobs;
pub mod branch;
pub mod checkpoint;
pub mod cli;
pub mod conflict;
pub mod diff;
pub mod features;
pub mod graph;
pub mod history;
pub mod hunk;
pub mod identity;
pub mod lines;
pub mod lock_rules;
pub mod merge;
pub mod rebase;
pub mod reflog;
pub mod remote_refs;
pub mod remotes;
pub mod repo;
pub mod stash;
pub mod submodule;
pub mod summary;
pub mod worktree;

/// One git write at a time, across every repository.
///
/// The write commands used to run on the UI thread, and that thread was the lock: stage, unstage,
/// checkout, stash and the rest could not interleave, so nothing raced on `index.write()` — at the
/// price of a frozen window for as long as one took on a big repository. They run on workers now,
/// and this is the same guarantee without the freeze. Reads never take it: libgit2 reads take their
/// own snapshot.
pub fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    // A write that panicked left the repository as git left it; the lock guards no data of its own.
    WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
