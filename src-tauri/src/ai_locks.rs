//! One engine per working copy.
//!
//! Every agentic turn runs with edits auto-approved against a real checkout, wrapped in a
//! `checkpoint_before`/`checkpoint_after` pair. Two of them on one folder is not a slow path, it is
//! a wrong one: they edit the same files while each takes a restore point over the other's writes,
//! they race on the skills directory the app syncs into each of them, and
//! `sync_skills_into_project` deletes and recreates `<repo>/.claude/skills` underneath both. There
//! is no queue anywhere below this point, so this is the choke point.
//!
//! **Keyed on the path, not on `project_id`.** `projects.local_path` has no UNIQUE constraint and
//! nothing stops the same folder from being added to two workspaces, which is two rows and two ids
//! for one working copy — a project-keyed guard would wave both through.
//!
//! **In memory, not in SQLite.** A lease is a statement about a *live process*: the process dying
//! releases it. A row would need stale-lease recovery, and a database that already held one from a
//! killed session would refuse work forever with no way for the user to tell why.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// Prefix on the error a refused run returns, so the frontend can tell "the repository is busy"
/// apart from a genuine engine failure — the same trick `ai_runs::CANCELLED_MARKER` uses.
pub const BUSY_MARKER: &str = "REPO_BUSY::";

fn leases() -> &'static Mutex<HashSet<String>> {
    static LEASES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LEASES.get_or_init(Mutex::default)
}

/// The key two paths pointing at one folder must agree on: separators unified, trailing separator
/// dropped, and case folded on Windows — where `C:\Repos\App` and `c:/repos/app/` are the same
/// directory and the picker and a hand-typed path disagree about which you get.
fn key_for(local_path: &str) -> String {
    let unified = local_path.trim().replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// Held for as long as a run owns its repository. Releasing on `Drop` is the whole point: it
/// covers every exit of the run — reply, engine error, cancellation, `?` on some DB read halfway
/// down, or a panic — without a single explicit release call to forget.
#[derive(Debug)]
pub struct RepoLease {
    key: String,
}

impl Drop for RepoLease {
    fn drop(&mut self) {
        if let Ok(mut held) = leases().lock() {
            held.remove(&self.key);
        }
    }
}

/// Takes the repository, or `None` if another run already holds it. Callers must return the
/// refusal *before* doing any work, so a busy repository costs no checkpoint and records no turn.
pub fn acquire(local_path: &str) -> Option<RepoLease> {
    let key = key_for(local_path);
    let mut held = leases().lock().ok()?;
    if !held.insert(key.clone()) {
        return None;
    }
    Some(RepoLease { key })
}

/// Takes several repositories at once, or gives back the first that was already busy.
///
/// Exists because one run can legitimately span more than one working copy — reviewing a story
/// against every repository it touches — and doing that with a loop over [`acquire`] has a trap the
/// caller cannot see: the same folder can appear twice in a workspace (two `projects` rows, one
/// directory), and the second `acquire` would be refused *by the first one*, so a run would report
/// itself busy. Deduplicating needs [`key_for`], which is private on purpose — the normalisation is
/// this module's business — so the deduplication has to happen here.
///
/// `Err(index)` is the position in `local_paths` of the folder somebody else holds, so the caller
/// can name the repository rather than the path. All-or-nothing: the leases taken so far drop on
/// the way out, because half a review is not a review.
pub fn acquire_all(local_paths: &[String]) -> Result<Vec<RepoLease>, usize> {
    let mut taken: Vec<RepoLease> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (at, path) in local_paths.iter().enumerate() {
        // A folder already covered by a lease this call took is not a conflict — it is the same
        // repository named twice, and it is already ours.
        if !seen.insert(key_for(path)) {
            continue;
        }
        match acquire(path) {
            Some(lease) => taken.push(lease),
            None => return Err(at),
        }
    }
    Ok(taken)
}

// Deliberately no `is_busy`: a caller that intends to run must take `acquire`, because any
// separate check is already stale by the time it is acted on. The UI's "this repository is busy"
// hint comes from the frontend's own view of its runs, and this is what makes it true.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_run_on_the_same_folder_is_refused_until_the_first_drops() {
        let path = "/tmp/cf-lease-basic";
        let first = acquire(path).expect("free");
        assert!(acquire(path).is_none(), "second acquire must be refused");
        drop(first);
        assert!(acquire(path).is_some(), "dropping the lease releases the repository");
    }

    /// The case this exists for: one folder, two project rows, two workspaces. A `project_id`-keyed
    /// guard lets both in.
    #[test]
    fn two_spellings_of_one_folder_collide() {
        let held = acquire("/tmp/cf-lease-spelling/").expect("free");
        assert!(acquire("/tmp/cf-lease-spelling").is_none(), "trailing separator must not matter");
        drop(held);
    }

    #[test]
    #[cfg(windows)]
    fn windows_paths_collide_across_case_and_separator() {
        let held = acquire(r"C:\Repos\CfLeaseCase").expect("free");
        assert!(acquire("c:/repos/cfleasecase").is_none(), "Windows paths are case-insensitive");
        drop(held);
    }

    #[test]
    fn different_folders_do_not_collide() {
        let a = acquire("/tmp/cf-lease-a").expect("free");
        let b = acquire("/tmp/cf-lease-b").expect("free");
        drop(a);
        drop(b);
    }

    #[test]
    fn several_folders_are_taken_together() {
        let held = acquire_all(&["/tmp/cf-all-a".to_string(), "/tmp/cf-all-b".to_string()])
            .expect("both free");
        assert_eq!(held.len(), 2);
        assert!(acquire("/tmp/cf-all-a").is_none(), "the batch holds the first");
        assert!(acquire("/tmp/cf-all-b").is_none(), "the batch holds the second");
        drop(held);
        assert!(acquire("/tmp/cf-all-a").is_some(), "dropping the batch releases every folder");
    }

    /// The trap this function exists for: one folder listed twice must not refuse itself.
    #[test]
    fn one_folder_named_twice_is_not_a_conflict() {
        let held = acquire_all(&["/tmp/cf-all-dup/".to_string(), "/tmp/cf-all-dup".to_string()])
            .expect("the same folder twice is still just one repository");
        assert_eq!(held.len(), 1, "it is taken once, not twice");
    }

    /// A batch that cannot be taken whole is not taken at all — otherwise a refused review would
    /// leave the repositories it did get locked behind it.
    #[test]
    fn a_busy_folder_releases_the_ones_already_taken() {
        let other = acquire("/tmp/cf-all-busy").expect("free");
        let refused =
            acquire_all(&["/tmp/cf-all-free".to_string(), "/tmp/cf-all-busy".to_string()]);
        assert_eq!(refused.unwrap_err(), 1, "it reports which one was busy");
        assert!(acquire("/tmp/cf-all-free").is_some(), "the first one was given back");
        drop(other);
    }
}
