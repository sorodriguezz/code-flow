//! Who is working in a working copy — and the one exclusion that is left.
//!
//! **Repositories are shared.** This module used to run one engine per working copy: a second chat
//! in the same repository was refused and waited, so asking a quick question while another
//! conversation was editing meant sitting in a queue (the user's complaint, 2026-10-01: "no debería
//! bloquearme del todo… necesito poder tener chats en paralelo"). Now every run *enters* the
//! repository and is listed there for as long as it runs ([`enter`] → [`RepoPresence`]), and a run
//! that writes is told who else is in it — `ai::parallel_work_note`, appended invisibly to its prompt
//! — so two agents can avoid each other's files instead of being kept apart. What used to make
//! sharing unsafe was dealt with at the source: each run takes its own checkpoint ref (they never
//! overwrite each other), the skills sync only rewrites a file whose bytes changed, and
//! `git_exclude::exclude` is serialised.
//!
//! **Conversations are not shared.** One conversation runs one turn at a time ([`acquire_key`]): two
//! turns resuming one engine session at once — a phone and the desk in the same thread — would race
//! on the session the thread points at. That refusal carries [`BUSY_MARKER`], and the frontend waits
//! on it (`lib/repoQueue`).
//!
//! **Keyed on the path, not on `project_id`.** `projects.local_path` has no UNIQUE constraint and
//! nothing stops the same folder from being added to two workspaces — two rows, one working copy.
//!
//! **In memory, not in SQLite.** Both are statements about *live processes*: the process dying
//! releases them, with no stale rows to recover.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// Prefix on the error a refused run returns, so the frontend can tell "busy, wait" apart from a
/// genuine engine failure — the same trick `ai_runs::CANCELLED_MARKER` uses.
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

/// Held for as long as a turn owns its conversation. Releasing on `Drop` is the whole point: it
/// covers every exit of the run — reply, engine error, cancellation, `?` halfway down, or a panic.
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

// ===================== presence: who is in a repository =====================

/// One run listed in a working copy.
struct Present {
    id: u64,
    label: String,
}

fn presence() -> &'static Mutex<HashMap<String, Vec<Present>>> {
    static PRESENCE: OnceLock<Mutex<HashMap<String, Vec<Present>>>> = OnceLock::new();
    PRESENCE.get_or_init(Mutex::default)
}

static NEXT_PRESENCE: AtomicU64 = AtomicU64::new(1);

/// A run's place in a repository's list — not a claim on it. Leaves the list on `Drop`, by every
/// route out of the run, like the lease above.
#[derive(Debug)]
pub struct RepoPresence {
    key: String,
    id: u64,
}

impl RepoPresence {
    /// What else is running in this working copy right now, oldest first — never this run itself.
    pub fn others(&self) -> Vec<String> {
        let Ok(listed) = presence().lock() else { return Vec::new() };
        listed
            .get(&self.key)
            .map(|runs| runs.iter().filter(|run| run.id != self.id).map(|run| run.label.clone()).collect())
            .unwrap_or_default()
    }
}

impl Drop for RepoPresence {
    fn drop(&mut self) {
        if let Ok(mut listed) = presence().lock() {
            if let Some(runs) = listed.get_mut(&self.key) {
                runs.retain(|run| run.id != self.id);
                if runs.is_empty() {
                    listed.remove(&self.key);
                }
            }
        }
    }
}

/// Lists a run in a working copy for as long as the returned guard lives. Never refuses: a
/// repository is shared — see the module note. `label` is what the *other* runs are told this one
/// is doing ("chat: «…»", "análisis de cambios"), so it is written for a model to read.
pub fn enter(local_path: &str, label: &str) -> RepoPresence {
    let key = key_for(local_path);
    let id = NEXT_PRESENCE.fetch_add(1, Ordering::Relaxed);
    let label: String = label.trim().chars().take(120).collect();
    if let Ok(mut listed) = presence().lock() {
        listed.entry(key.clone()).or_default().push(Present { id, label });
    }
    RepoPresence { key, id }
}

/// [`enter`] for a run that spans several repositories — a review over every repository a story
/// touches. The same folder named twice (two `projects` rows, one directory) is entered once.
pub fn enter_all(local_paths: &[String], label: &str) -> Vec<RepoPresence> {
    let mut seen: HashSet<String> = HashSet::new();
    local_paths
        .iter()
        .filter(|path| seen.insert(key_for(path)))
        .map(|path| enter(path, label))
        .collect()
}

/// The namespace every key handed to [`acquire_key`] is taken under — kept from when paths were
/// leased in the same registry, and harmless: a name is never a path.
const KEY_NAMESPACE: &str = "key::";

/// Takes an arbitrary named lease, or `None` if one is already held under that name.
///
/// The unit is the **conversation**: N conversations run concurrently — in one repository too, now —
/// and one conversation runs one turn at a time. Not leasing at all would let one conversation start
/// a second turn over the first, and the two would race on the engine session the thread points at:
/// whichever finished last would win, and the loser's turn would have been appended to a session the
/// thread no longer points at. That is also exactly what the composers draw — Send becomes Stop for
/// *this* thread and no other.
pub fn acquire_key(key: &str) -> Option<RepoLease> {
    let key = format!("{KEY_NAMESPACE}{}", key.trim());
    let mut held = leases().lock().ok()?;
    if !held.insert(key.clone()) {
        return None;
    }
    Some(RepoLease { key })
}

// Deliberately no `is_busy` for a conversation: a caller that intends to run must take
// `acquire_key`, because any separate check is already stale by the time it is acted on.

#[cfg(test)]
mod tests {
    use super::*;

    /// The point of the change: a second run in a repository is not refused — it is told.
    #[test]
    fn two_runs_share_a_repository_and_see_each_other() {
        let first = enter("/tmp/cf-presence-basic", "chat: «uno»");
        let second = enter("/tmp/cf-presence-basic", "chat: «dos»");
        assert_eq!(first.others(), ["chat: «dos»"]);
        assert_eq!(second.others(), ["chat: «uno»"], "never itself, and the other one by its label");
        drop(second);
        assert!(first.others().is_empty(), "a run that ends leaves the list");
    }

    /// One folder, two project rows, two workspaces: the same repository either way.
    #[test]
    fn two_spellings_of_one_folder_are_one_repository() {
        let a = enter("/tmp/cf-presence-spelling/", "a");
        let b = enter("/tmp/cf-presence-spelling", "b");
        assert_eq!(a.others(), ["b"], "trailing separator must not matter");
        drop(b);
    }

    #[test]
    #[cfg(windows)]
    fn windows_paths_are_one_repository_across_case_and_separator() {
        let a = enter(r"C:\Repos\CfPresenceCase", "a");
        let b = enter("c:/repos/cfpresencecase", "b");
        assert_eq!(a.others(), ["b"], "Windows paths are case-insensitive");
        drop(b);
    }

    #[test]
    fn different_folders_do_not_see_each_other() {
        let a = enter("/tmp/cf-presence-a", "a");
        let b = enter("/tmp/cf-presence-b", "b");
        assert!(a.others().is_empty() && b.others().is_empty());
    }

    /// A review over several repositories, one of them listed twice: entered once per folder.
    #[test]
    fn a_folder_named_twice_is_entered_once() {
        let held = enter_all(
            &["/tmp/cf-presence-dup/".to_string(), "/tmp/cf-presence-dup".to_string(), "/tmp/cf-presence-dup2".to_string()],
            "revisión",
        );
        assert_eq!(held.len(), 2);
        let other = enter("/tmp/cf-presence-dup", "chat");
        assert_eq!(other.others(), ["revisión"], "listed once, not twice");
    }

    /// The exclusion that is left: one conversation, one turn at a time — and two conversations are
    /// not each other's business.
    #[test]
    fn a_conversation_runs_one_turn_at_a_time() {
        let first = acquire_key("conv-aaa").expect("free");
        assert!(acquire_key("conv-aaa").is_none(), "a second turn on one thread is refused");
        assert!(acquire_key("conv-bbb").is_some(), "another thread is not blocked by it");
        drop(first);
        assert!(acquire_key("conv-aaa").is_some(), "and the turn ending releases it");
    }
}
