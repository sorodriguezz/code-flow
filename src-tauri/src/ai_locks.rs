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

// ---------- the optional exclusive lock ----------
//
// Sharing is the default, and the README's promise. Some teams prefer the old guarantee for their
// chats — one turn that *writes* in a working copy at a time — because two agents editing the same
// repository make each turn's review and undo include the other's edits (both are measured against
// the working tree). Settings › Asistente de IA turns it on: a writing chat turn then takes every
// working copy it may write in, all or nothing, and a second writing turn waits on the busy marker
// as a conversation's second turn does. Read-only (plan) turns never take it.

/// What follows [`BUSY_MARKER`] when the refusal is this lock's — another turn is writing in that
/// working copy — rather than the conversation's own lease. The workspace chat waits on the first
/// and holds its queue on the second.
pub const WRITER_BUSY: &str = "writer:";

/// `app_settings` key: `"true"` makes writing chat turns exclusive per working copy.
pub const EXCLUSIVE_SETTING: &str = "chat_exclusive_repo_lock";

static EXCLUSIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Mirrors [`EXCLUSIVE_SETTING`] — seeded at startup and on every write of it (`set_setting`), so
/// a turn never reads the database to know (it may be holding the lock already).
pub fn setting_changed(key: &str, value: Option<&str>) {
    if key == EXCLUSIVE_SETTING {
        EXCLUSIVE.store(value.map(str::trim) == Some("true"), Ordering::Relaxed);
    }
}

/// Whether writing chat turns are exclusive per working copy.
pub fn exclusive() -> bool {
    EXCLUSIVE.load(Ordering::Relaxed)
}

/// The working copies a writing turn holds while [`exclusive`] is on. Released on drop.
#[derive(Debug)]
pub struct WriterLease {
    keys: Vec<String>,
}

impl Drop for WriterLease {
    fn drop(&mut self) {
        if let Ok(mut held) = leases().lock() {
            for key in &self.keys {
                held.remove(key);
            }
        }
    }
}

/// Takes every working copy of `local_paths` for one writing turn — all of them, or none and the
/// busy marker naming the first that is taken. `None` (nothing to hold) when the lock is off or the
/// turn does not write.
pub fn writers(local_paths: &[String], writes: bool) -> Result<Option<WriterLease>, String> {
    writers_if(exclusive() && writes, local_paths)
}

fn writers_if(on: bool, local_paths: &[String]) -> Result<Option<WriterLease>, String> {
    if !on || local_paths.is_empty() {
        return Ok(None);
    }
    let mut keys: Vec<String> = local_paths.iter().map(|path| format!("writer::{}", key_for(path))).collect();
    keys.sort();
    keys.dedup();
    let mut held = leases().lock().map_err(|e| e.to_string())?;
    if let Some(taken) = keys.iter().position(|key| held.contains(key)) {
        let path = local_paths
            .iter()
            .find(|path| format!("writer::{}", key_for(path)) == keys[taken])
            .map(String::as_str)
            .unwrap_or_default();
        let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
        return Err(format!("{BUSY_MARKER}{WRITER_BUSY}{name}"));
    }
    for key in &keys {
        held.insert(key.clone());
    }
    Ok(Some(WriterLease { keys }))
}

#[cfg(test)]
mod tests {
    use super::*;


    /// With the exclusive lock on, a second writing turn in a working copy is refused with the busy
    /// marker, all of its copies or none are taken, and dropping the first frees them.
    #[test]
    fn exclusive_writers_take_all_their_copies_or_none() {
        let a = format!("/tmp/cf-excl-{}/a", uuid::Uuid::new_v4());
        let b = format!("/tmp/cf-excl-{}/b", uuid::Uuid::new_v4());
        let first = writers_if(true, std::slice::from_ref(&a)).unwrap().unwrap();
        let refused = writers_if(true, &[b.clone(), format!("{a}/")]).unwrap_err();
        assert!(refused.starts_with(BUSY_MARKER) && refused.ends_with("a"), "{refused}");
        // `b` was not taken by the refused call.
        drop(writers_if(true, std::slice::from_ref(&b)).unwrap().unwrap());
        drop(first);
        assert!(writers_if(true, &[a, b]).unwrap().is_some());
        assert!(writers_if(false, &["/x".to_string()]).unwrap().is_none(), "off: nothing held");
    }

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
