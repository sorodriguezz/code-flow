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

/// The index entry at `rel`, or `None` — never git2's `Index::get_path` panic on a path that is not
/// relative to the repository: an editor buffer never saved reaches here as `/Sin título` (user log,
/// 2026-11-02: two panics on a tokio worker), and git2 `unwrap`s the conversion.
pub fn index_entry(index: &git2::Index, rel: &std::path::Path) -> Option<git2::IndexEntry> {
    if rel.as_os_str().is_empty() || rel.has_root() || rel.is_absolute() {
        return None;
    }
    index.get_path(rel, 0)
}

#[cfg(test)]
mod index_entry_tests {
    #[test]
    fn a_rooted_path_is_no_entry() {
        let dir = std::env::temp_dir().join(format!("cf-index-entry-{}", std::process::id()));
        let repo = git2::Repository::init(&dir).unwrap();
        let index = repo.index().unwrap();
        assert!(super::index_entry(&index, std::path::Path::new("/Sin título")).is_none());
        assert!(super::index_entry(&index, std::path::Path::new("")).is_none());
        assert!(super::index_entry(&index, std::path::Path::new("a.txt")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
