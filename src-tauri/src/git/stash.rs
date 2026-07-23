use git2::{StashApplyOptions, StashFlags};
use serde::{Deserialize, Serialize};

use super::repo::open;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

pub fn list_stashes(path: &str) -> Result<Vec<StashInfo>, String> {
    let mut repo = open(path)?;
    let mut result = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        result.push(StashInfo {
            index,
            message: message.to_string(),
            oid: oid.to_string(),
        });
        true
    })
    .map_err(|e| e.message().to_string())?;
    Ok(result)
}

pub fn stash_save(path: &str, message: Option<String>, include_untracked: bool) -> Result<(), String> {
    let mut repo = open(path)?;
    let sig = repo.signature().map_err(|e| e.message().to_string())?;
    let mut flags = StashFlags::DEFAULT;
    if include_untracked {
        flags |= StashFlags::INCLUDE_UNTRACKED;
    }
    repo.stash_save(&sig, message.as_deref().unwrap_or("WIP"), Some(flags))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn stash_apply(path: &str, index: usize) -> Result<(), String> {
    let mut repo = open(path)?;
    repo.stash_apply(index, Some(&mut StashApplyOptions::new()))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn stash_pop(path: &str, index: usize) -> Result<(), String> {
    let mut repo = open(path)?;
    repo.stash_pop(index, Some(&mut StashApplyOptions::new()))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn stash_drop(path: &str, index: usize) -> Result<(), String> {
    let mut repo = open(path)?;
    repo.stash_drop(index).map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Git has no native "rename a stash" operation — a stash's message lives in the
/// `refs/stash` reflog, and reflog entries can't be edited in place. Removing it via
/// `stash_drop` (the same well-tested path the Drop button uses) and re-appending a fresh
/// entry for the *same* underlying commit is the reliable way to do it; manually splicing
/// the reflog with `Reflog::remove`/`append` looked equivalent but actually left a stray
/// duplicate entry behind (caught by the test below) rather than truly replacing it.
/// The one visible side effect: re-appending always lands at the top of the log
/// (`stash@{0}`), so renaming a stash that wasn't already the most recent one moves it
/// there — the same trade-off `git stash pop && git stash push -m "..."` has.
pub fn rename_stash(path: &str, index: usize, new_message: &str) -> Result<(), String> {
    let mut repo = open(path)?;
    let oid = {
        let reflog = repo.reflog("refs/stash").map_err(|e| e.message().to_string())?;
        let entry = reflog
            .get(index)
            .ok_or_else(|| "Stash not found".to_string())?;
        entry.id_new()
    };

    repo.stash_drop(index).map_err(|e| e.message().to_string())?;

    // `Repository::reference` both retargets `refs/stash` to `oid` *and* appends exactly one
    // reflog entry using `new_message` verbatim — doing this instead of a manual
    // `Reflog::append`+`write` (which only touches the log, not the ref itself) is what keeps
    // the ref and its reflog consistent without leaving a duplicate entry behind.
    repo.reference("refs/stash", oid, true, new_message)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn init_repo_with_stashes() -> tempfile_dir::TempDir {
        let dir = tempfile_dir::TempDir::new();
        let path = dir.path();
        let run = |args: &[&str]| {
            let status = Command::new("git").args(args).current_dir(path).status().unwrap();
            assert!(status.success(), "git {:?} failed", args);
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(path.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);

        fs::write(path.join("a.txt"), "two\n").unwrap();
        run(&["stash", "push", "-q", "-m", "first stash"]);
        fs::write(path.join("a.txt"), "three\n").unwrap();
        run(&["stash", "push", "-q", "-m", "second stash"]);
        dir
    }

    #[test]
    fn rename_top_stash_keeps_order() {
        let dir = init_repo_with_stashes();
        let path = dir.path().to_str().unwrap();

        // git prefixes a custom `-m` message with "On <branch>: " — assert on containment
        // rather than exact equality so this doesn't depend on the default branch name.
        let before = list_stashes(path).unwrap();
        assert_eq!(before.len(), 2);
        assert!(before[0].message.contains("second stash"));
        assert!(before[1].message.contains("first stash"));

        rename_stash(path, 0, "renamed second").unwrap();

        let after = list_stashes(path).unwrap();
        assert_eq!(after.len(), 2, "no stash should be lost or duplicated");
        assert_eq!(after[0].message, "renamed second");
        assert!(after[1].message.contains("first stash"));
    }

    #[test]
    fn rename_non_top_stash_moves_it_to_top() {
        let dir = init_repo_with_stashes();
        let path = dir.path().to_str().unwrap();

        rename_stash(path, 1, "renamed first").unwrap();

        let after = list_stashes(path).unwrap();
        assert_eq!(after.len(), 2, "no stash should be lost or duplicated");
        assert_eq!(after[0].message, "renamed first");
        assert!(after[1].message.contains("second stash"));
    }

    mod tempfile_dir {
        use std::env;
        use std::fs;
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};

        static COUNTER: AtomicU64 = AtomicU64::new(0);

        pub struct TempDir(PathBuf);
        impl TempDir {
            pub fn new() -> Self {
                let n = COUNTER.fetch_add(1, Ordering::SeqCst);
                let p = env::temp_dir().join(format!("codeflow-stash-test-{}-{}", std::process::id(), n));
                fs::create_dir_all(&p).unwrap();
                TempDir(p)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }
}
