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

/// One git write at a time per repository.
///
/// The write commands used to run on the UI thread, and that thread was the lock: stage, unstage,
/// checkout, stash and the rest could not interleave, so nothing raced on `index.write()` — at the
/// price of a frozen window for as long as one took on a big repository. They run on workers now,
/// and this is the same guarantee without the freeze. Reads never take it: libgit2 reads take their
/// own snapshot.
///
/// Keyed by the working copy, not global (user, 2026-11-05: «se bloquea el commitear, pushear/pull
/// del resto. Debería ser por separado»). What it protects — the index, HEAD, a merge's state — is
/// per working copy, so a slow checkout or merge in one repository used to hold every other
/// repository's stage and commit for nothing. Striped rather than one mutex per path: a fixed table
/// of `'static` mutexes needs no map, no cleanup and no owned guard; two repositories that hash to
/// the same stripe merely wait for each other, which is what every pair did before. `""` is the
/// global git config (`set_git_identity`).
pub fn write_lock(repo_path: &str) -> std::sync::MutexGuard<'static, ()> {
    static WRITES: [std::sync::Mutex<()>; WRITE_STRIPES] = [const { std::sync::Mutex::new(()) }; WRITE_STRIPES];
    // A write that panicked left the repository as git left it; the lock guards no data of its own.
    WRITES[write_stripe(repo_path)].lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

const WRITE_STRIPES: usize = 64;

/// The stripe of a working copy: separators made one kind, the trailing one dropped and case
/// folded, so the spellings one repository arrives under (`C:\\a\\b\\`, `c:/a/b`) share a lock.
fn write_stripe(repo_path: &str) -> usize {
    use std::hash::{Hash, Hasher};
    let normal = repo_path.replace('\\', "/");
    let normal = normal.trim_end_matches('/').to_lowercase();
    // `DefaultHasher::new()` has fixed keys: the same path lands on the same stripe for the whole
    // process, which is all the lock needs.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    normal.hash(&mut hasher);
    (hasher.finish() as usize) % WRITE_STRIPES
}

#[cfg(test)]
mod write_lock_tests {
    use super::*;

    #[test]
    fn one_repository_under_its_spellings_shares_a_stripe() {
        assert_eq!(write_stripe("/a/b"), write_stripe("/a/b/"));
        assert_eq!(write_stripe("C:\\Repos\\app"), write_stripe("c:/repos/app/"));
    }

    #[test]
    fn another_repository_does_not_wait_for_a_held_lock() {
        // Find a path on another stripe, hold the first, and the second must be free.
        let first = "/work/first";
        let other = (0..)
            .map(|i| format!("/work/other-{i}"))
            .find(|p| write_stripe(p) != write_stripe(first))
            .unwrap();
        let _held = write_lock(first);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _g = write_lock(&other);
            tx.send(()).unwrap();
        });
        rx.recv_timeout(std::time::Duration::from_secs(2)).expect("another repository was blocked");
    }
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
