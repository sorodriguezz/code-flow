//! Undo, and the record that makes it possible: HEAD's reflog.
//!
//! Every move of HEAD — a commit, an amend, a merge, a reset, a checkout, each step of a rebase — is
//! written to `.git/logs/HEAD` with where HEAD was before and where it went. That is git's own undo
//! history, and it was invisible in the app: the only undo on offer was "undo commit" on the newest
//! row of the graph. This module reads that record, names what each entry was, and offers two ways
//! back:
//!
//! * **Restore to here** — put HEAD (and the branch it is on) where an entry left it. After a backup
//!   ref is written, so the restore is itself undoable by name, not only by reading the reflog.
//! * **Undo the last operation** — the common cases, each done the way that loses nothing:
//!   a commit comes off with its changes left staged (`reset --soft`), an amend gives back the commit
//!   it replaced (its additions staged), a merge / pull / rebase / reset moves the branch back to
//!   where it was (`reset --keep`: files the move changes are updated, local edits elsewhere stay,
//!   and a local edit in the way refuses the whole thing), a checkout goes back to where it came from.
//!
//! Nothing here is `reset --hard`. The worst an undo can do is refuse.

use git2::{BranchType, Oid, Repository, RepositoryState};
use serde::{Deserialize, Serialize};

use super::merge::{MERGE_BLOCKED_PREFIX, OPERATION_IN_PROGRESS_PREFIX};
use super::repo::open;

/// Where backup refs live — outside `refs/heads`, so no branch list shows them, beside
/// `checkpoint.rs`'s `refs/codeflow/checkpoints/`.
const BACKUP_PREFIX: &str = "refs/codeflow/backups/";

/// How many backups a repository keeps. Each is one ref; they exist so a restore can be walked back
/// by name, and nobody walks back the fortieth.
const MAX_BACKUPS: usize = 30;

/// Marks an undo refused because HEAD moved since the plan was shown — the confirmation described
/// an operation that is no longer the last one. Nothing was changed.
pub const UNDO_STALE_PREFIX: &str = "UNDO_STALE: ";

/// One line of HEAD's reflog, newest first.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReflogEntry {
    /// 0 is the newest — `HEAD@{0}`.
    pub index: usize,
    pub old_oid: String,
    pub new_oid: String,
    /// git's own words for the move, verbatim.
    pub message: String,
    /// What the move was — see [`classify`]. The frontend's label and icon key off this.
    pub op: String,
    /// Unix seconds.
    pub time: i64,
    /// The summary of the commit HEAD moved to, when it can still be read.
    pub summary: Option<String>,
}

/// What a reflog message says happened, as a stable key.
///
/// From the message's prefix — the vocabulary git and libgit2 both write — plus one structural test
/// the text cannot answer: libgit2 writes an amend as a plain `commit:`, so a `commit:` whose new
/// commit does not have the old one as a parent, and shares its parents instead, was an amend.
pub fn classify(repo: &Repository, message: &str, old: Oid, new: Oid) -> &'static str {
    let starts = |prefix: &str| message.starts_with(prefix);
    if starts("commit (initial)") {
        return "initial";
    }
    if starts("commit (merge)") || starts("merge ") {
        return "merge";
    }
    if starts("commit (amend)") {
        return "amend";
    }
    if starts("commit") {
        let parents = |id: Oid| -> Vec<Oid> {
            repo.find_commit(id).map(|c| c.parent_ids().collect()).unwrap_or_default()
        };
        let new_parents = parents(new);
        if !old.is_zero() && !new_parents.contains(&old) && new_parents == parents(old) {
            return "amend";
        }
        return "commit";
    }
    if starts("pull") {
        return if message.contains("rebase") { "rebase" } else { "pull" };
    }
    if starts("rebase") {
        return "rebase";
    }
    if starts("reset:") {
        return "reset";
    }
    if starts("checkout:") {
        return "checkout";
    }
    if starts("cherry-pick") {
        return "cherry_pick";
    }
    if starts("revert") {
        return "revert";
    }
    if starts("clone") {
        return "clone";
    }
    if starts("branch") {
        return "branch";
    }
    "other"
}

fn summary_of(repo: &Repository, id: Oid) -> Option<String> {
    repo.find_commit(id).ok().and_then(|c| c.summary().map(str::to_string))
}

/// HEAD's reflog, newest first, at most `limit` entries.
pub fn list(path: &str, limit: usize) -> Result<Vec<ReflogEntry>, String> {
    let repo = open(path)?;
    let reflog = match repo.reflog("HEAD") {
        Ok(reflog) => reflog,
        // A repository with no commits has no log yet — an empty history, not an error.
        Err(_) => return Ok(vec![]),
    };
    let mut out = Vec::with_capacity(reflog.len().min(limit));
    for (index, entry) in reflog.iter().enumerate().take(limit) {
        let message = entry.message().unwrap_or("").to_string();
        let (old, new) = (entry.id_old(), entry.id_new());
        out.push(ReflogEntry {
            index,
            old_oid: old.to_string(),
            new_oid: new.to_string(),
            op: classify(&repo, &message, old, new).to_string(),
            time: entry.committer().when().seconds(),
            summary: summary_of(&repo, new),
            message,
        });
    }
    Ok(out)
}

/// How an undo moves HEAD back — see the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UndoStrategy {
    /// `reset --soft`: the commit goes, its changes stay staged.
    Soft,
    /// `reset --mixed`: HEAD and the index go back, the working tree stays — undoing a soft or mixed
    /// reset, whose changes are still sitting there.
    Mixed,
    /// `reset --keep`: the files the move changes are updated, nothing else is touched, and a local
    /// edit in the way refuses the whole move.
    Keep,
    /// Switch back to where a checkout came from.
    Checkout,
}

/// What "undo the last operation" would do, for the confirmation to spell out before anything moves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoPlan {
    /// The operation being undone — [`classify`]'s key.
    pub op: String,
    pub strategy: UndoStrategy,
    /// The commit HEAD goes back to.
    pub target_oid: String,
    pub target_summary: Option<String>,
    /// For a checkout: the branch (or commit) it goes back to.
    pub checkout_to: Option<String>,
    /// The branch that moves, or `None` on a detached HEAD.
    pub branch: Option<String>,
    /// What is being undone, in the reflog's own words.
    pub message: String,
    /// HEAD as the plan saw it — the undo refuses if it has moved since.
    pub head_oid: String,
}

/// Refuses while git has something half done — a merge, rebase, cherry-pick, revert or a bisect.
/// Moving HEAD underneath any of those leaves state files describing a history that is gone.
fn refuse_busy(repo: &Repository) -> Result<(), String> {
    if let Some(kind) = super::merge::OperationKind::of(repo.state()) {
        return Err(format!("{OPERATION_IN_PROGRESS_PREFIX}{}", kind.as_str()));
    }
    if repo.state() == RepositoryState::Bisect {
        return Err(format!("{}bisect", super::bisect::BISECT_ACTIVE_PREFIX));
    }
    Ok(())
}

/// Anything staged or modified in a tracked file — what decides how a reset is undone.
fn is_dirty(repo: &Repository) -> Result<bool, String> {
    let mut options = git2::StatusOptions::new();
    options.include_untracked(false).include_ignored(false);
    let statuses = repo.statuses(Some(&mut options)).map_err(|e| e.message().to_string())?;
    Ok(!statuses.is_empty())
}

/// "checkout: moving from A to B" → A.
fn checkout_origin(message: &str) -> Option<&str> {
    let rest = message.strip_prefix("checkout: moving from ")?;
    let (from, _to) = rest.rsplit_once(" to ")?;
    Some(from.trim())
}

pub fn undo_plan(path: &str) -> Result<Option<UndoPlan>, String> {
    let repo = open(path)?;
    let Ok(reflog) = repo.reflog("HEAD") else { return Ok(None) };
    let Some(last) = reflog.get(0) else { return Ok(None) };
    let Ok(head) = repo.head() else { return Ok(None) };
    let Some(head_oid) = head.target() else { return Ok(None) };
    let branch = head.is_branch().then(|| head.shorthand().unwrap_or("").to_string());

    let message = last.message().unwrap_or("").to_string();
    let (old, new) = (last.id_old(), last.id_new());
    // The log's newest entry is not where HEAD is: something moved it without logging (a ref
    // edited by hand, `update-ref` with no message). Undoing "the last operation" would then undo
    // something other than what the user did last.
    if new != head_oid {
        return Ok(None);
    }
    let op = classify(&repo, &message, old, new);

    let plan = |strategy: UndoStrategy, target: Oid, checkout_to: Option<String>| UndoPlan {
        op: op.to_string(),
        strategy,
        target_oid: target.to_string(),
        target_summary: summary_of(&repo, target),
        checkout_to,
        branch: branch.clone(),
        message: message.clone(),
        head_oid: head_oid.to_string(),
    };

    let result = match op {
        "commit" | "cherry_pick" | "revert" | "amend" if !old.is_zero() => Some(plan(UndoStrategy::Soft, old, None)),
        "merge" | "pull" if !old.is_zero() => Some(plan(UndoStrategy::Keep, old, None)),
        "reset" if !old.is_zero() => {
            // A reset leaves no note of its mode. With nothing staged or modified it was hard (or
            // changed nothing), and going back means putting the files back too; otherwise its
            // changes are still sitting there, and going back is moving HEAD and the index only.
            let strategy = if is_dirty(&repo)? { UndoStrategy::Mixed } else { UndoStrategy::Keep };
            Some(plan(strategy, old, None))
        }
        "rebase" => {
            // A rebase is a run of entries ending (going back in time) at its `(start)`; where HEAD
            // was before that one is where the branch was before the rebase.
            let mut start = None;
            for entry in reflog.iter() {
                let text = entry.message().unwrap_or("");
                let is_rebase = text.starts_with("rebase") || (text.starts_with("pull") && text.contains("rebase"));
                if !is_rebase {
                    break;
                }
                start = Some(entry.id_old());
                if text.contains("(start)") {
                    break;
                }
            }
            start.filter(|id| !id.is_zero() && *id != head_oid).map(|id| plan(UndoStrategy::Keep, id, None))
        }
        "checkout" => checkout_origin(&message).and_then(|from| {
            // Back to a branch when the origin is one that still exists; to the commit otherwise
            // (it was a detached HEAD, or the branch has since been deleted).
            if repo.find_branch(from, BranchType::Local).is_ok() {
                return Some(plan(UndoStrategy::Checkout, old, Some(from.to_string())));
            }
            (!old.is_zero()).then(|| plan(UndoStrategy::Checkout, old, Some(old.to_string())))
        }),
        _ => None,
    };
    Ok(result)
}

/// Writes a backup ref at HEAD's commit and returns its name. Pruned to [`MAX_BACKUPS`].
pub fn backup_head(repo: &Repository, reason: &str) -> Result<Option<String>, String> {
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else { return Ok(None) };
    let name = format!(
        "{BACKUP_PREFIX}{}-{}",
        chrono::Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    repo.reference(&name, head, false, &format!("codeflow backup: {reason}"))
        .map_err(|e| e.message().to_string())?;
    if let Ok(refs) = repo.references_glob(&format!("{BACKUP_PREFIX}*")) {
        let mut names: Vec<String> = refs.flatten().filter_map(|r| r.name().map(str::to_string)).collect();
        // The names start with a millisecond timestamp, so sorting them is sorting by age.
        names.sort();
        let excess = names.len().saturating_sub(MAX_BACKUPS);
        for stale in &names[..excess] {
            if let Ok(mut reference) = repo.find_reference(stale) {
                let _ = reference.delete();
            }
        }
    }
    Ok(Some(name))
}

/// `reset --keep`, with libgit2: a *safe* checkout of the target with HEAD as the baseline — files
/// the move changes are updated only where they have no local edits, everything else is left alone,
/// and any conflict refuses before a byte is written — then the ref moves. The same two steps, in the
/// same order and for the same reason, as `merge::fast_forward`.
fn keep_reset(repo: &Repository, target: &git2::Commit, log: &str) -> Result<(), String> {
    let blocked = std::cell::RefCell::new(Vec::<String>::new());
    let checked_out = {
        let mut cb = git2::build::CheckoutBuilder::new();
        cb.safe();
        cb.notify_on(git2::CheckoutNotificationType::CONFLICT);
        cb.notify(|_kind, path, _baseline, _target, _workdir| {
            if let Some(path) = path {
                blocked.borrow_mut().push(path.to_string_lossy().replace('\\', "/"));
            }
            true
        });
        repo.checkout_tree(target.as_object(), Some(&mut cb))
    };
    if let Err(e) = checked_out {
        return Err(if e.code() == git2::ErrorCode::Conflict || e.code() == git2::ErrorCode::MergeConflict {
            format!("{MERGE_BLOCKED_PREFIX}{}", blocked.borrow().join(", "))
        } else {
            e.message().to_string()
        });
    }
    move_head(repo, target.id(), log)?;
    // The checkout wrote the index for the paths it changed; the rest of the index — including
    // anything staged on an unrelated path — is exactly as it was, which is `--keep`'s promise.
    Ok(())
}

/// Moves the branch HEAD is on (or a detached HEAD) to `target`, with `log` in the reflog.
fn move_head(repo: &Repository, target: Oid, log: &str) -> Result<(), String> {
    let head = repo.head().map_err(|e| e.message().to_string())?;
    if head.is_branch() {
        let name = head.name().ok_or("invalid HEAD ref")?.to_string();
        let mut reference = repo.find_reference(&name).map_err(|e| e.message().to_string())?;
        reference.set_target(target, log).map_err(|e| e.message().to_string())?;
        Ok(())
    } else {
        repo.set_head_detached(target).map_err(|e| e.message().to_string())
    }
}

/// Does what [`undo_plan`] described — if HEAD is still where the plan saw it. Returns the backup ref.
pub fn undo(path: &str, expected_head: &str) -> Result<Option<String>, String> {
    let plan = undo_plan(path)?.ok_or_else(|| format!("{UNDO_STALE_PREFIX}nothing to undo"))?;
    if plan.head_oid != expected_head {
        return Err(format!("{UNDO_STALE_PREFIX}HEAD moved"));
    }
    let repo = open(path)?;
    refuse_busy(&repo)?;
    let target_id = Oid::from_str(&plan.target_oid).map_err(|e| e.message().to_string())?;
    let target = repo.find_commit(target_id).map_err(|e| e.message().to_string())?;

    if plan.strategy == UndoStrategy::Checkout {
        let to = plan.checkout_to.clone().unwrap_or_else(|| plan.target_oid.clone());
        drop(target);
        drop(repo);
        return if super::branch::local_branch_exists(path, &to).unwrap_or(false) {
            super::branch::checkout_local_branch(path, &to).map(|_| None)
        } else {
            super::branch::checkout_detached(path, &to).map(|_| None)
        };
    }

    let backup = backup_head(&repo, &format!("undo {}", plan.op))?;
    let log = format!("reset: moving to {} (undo {})", plan.target_oid, plan.op);
    match plan.strategy {
        UndoStrategy::Soft | UndoStrategy::Mixed => {
            let kind = if plan.strategy == UndoStrategy::Soft { git2::ResetType::Soft } else { git2::ResetType::Mixed };
            repo.reset(target.as_object(), kind, None).map_err(|e| e.message().to_string())?;
        }
        UndoStrategy::Keep => keep_reset(&repo, &target, &log)?,
        UndoStrategy::Checkout => unreachable!("handled above"),
    }
    Ok(backup)
}

/// "Restore to here": the branch HEAD is on (or a detached HEAD) goes to `target_oid`, by
/// `reset --keep`, after a backup ref records where it was. Refuses while an operation is in
/// progress, and when a local edit is in the way — nothing moves then.
pub fn restore(path: &str, target_oid: &str) -> Result<Option<String>, String> {
    let repo = open(path)?;
    refuse_busy(&repo)?;
    let target_id = Oid::from_str(target_oid).map_err(|e| e.message().to_string())?;
    let target = repo.find_commit(target_id).map_err(|e| e.message().to_string())?;
    let backup = backup_head(&repo, "restore")?;
    let log = format!("reset: moving to {target_oid} (restore)");
    if let Err(e) = keep_reset(&repo, &target, &log) {
        // Nothing moved, so the backup names a HEAD that is still HEAD — dropped rather than left
        // to clutter the list with copies of the present.
        if let Some(name) = &backup {
            if let Ok(mut reference) = repo.find_reference(name) {
                let _ = reference.delete();
            }
        }
        return Err(e);
    }
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(out.success, "git {args:?} failed: {}", out.combined());
        out.stdout
    }

    /// A repository on `main` with one commit, configured against the machine's global config.
    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-reflog-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            git(&dir, &["config", key, value]);
        }
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "first"]);
        dir
    }

    fn commit(dir: &Path, file: &str, content: &str, message: &str) {
        fs::write(dir.join(file), content).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", message]);
    }

    fn head(dir: &Path) -> String {
        git(dir, &["rev-parse", "HEAD"]).trim().to_string()
    }

    fn rev(dir: &Path, spec: &str) -> String {
        git(dir, &["rev-parse", spec]).trim().to_string()
    }

    #[test]
    fn entries_are_named_by_what_they_were() {
        let dir = fixture();
        commit(&dir, "a.txt", "two\n", "second");
        git(&dir, &["commit", "-q", "--amend", "-m", "second, amended"]);
        git(&dir, &["checkout", "-q", "-b", "side"]);
        git(&dir, &["reset", "-q", "--hard", "HEAD~1"]);
        let entries = list(dir.to_str().unwrap(), 50).unwrap();
        let ops: Vec<&str> = entries.iter().map(|e| e.op.as_str()).collect();
        assert_eq!(ops, vec!["reset", "checkout", "amend", "commit", "initial"]);
        assert_eq!(entries[2].summary.as_deref(), Some("second, amended"));
        fs::remove_dir_all(&dir).ok();
    }

    /// libgit2 writes an amend as a plain `commit:` — told apart by its parents.
    #[test]
    fn a_libgit2_amend_is_still_an_amend() {
        let dir = fixture();
        commit(&dir, "a.txt", "two\n", "second");
        crate::git::history::amend_commit(dir.to_str().unwrap(), "second, fixed", None, None).unwrap();
        let entries = list(dir.to_str().unwrap(), 5).unwrap();
        assert!(entries[0].message.starts_with("commit"), "{}", entries[0].message);
        assert_eq!(entries[0].op, "amend");
        fs::remove_dir_all(&dir).ok();
    }

    /// The last commit comes off, and what it changed stays staged.
    #[test]
    fn undoing_a_commit_keeps_its_changes_staged() {
        let dir = fixture();
        let first = head(&dir);
        commit(&dir, "a.txt", "two\n", "second");
        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        assert_eq!((plan.op.as_str(), plan.strategy), ("commit", UndoStrategy::Soft));
        assert_eq!(plan.target_oid, first);

        let backup = undo(path, &plan.head_oid).unwrap();
        assert_eq!(head(&dir), first);
        assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]).trim(), "a.txt");
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "two\n");
        // The undone commit is kept by name.
        let backup = backup.unwrap();
        assert_ne!(rev(&dir, &backup), first);
        fs::remove_dir_all(&dir).ok();
    }

    /// An amend gives back the commit it replaced; what the amend added is left staged.
    #[test]
    fn undoing_an_amend_restores_the_previous_commit() {
        let dir = fixture();
        commit(&dir, "a.txt", "two\n", "second");
        let before_amend = head(&dir);
        fs::write(dir.join("b.txt"), "added by the amend\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "--amend", "-m", "second, amended"]);

        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        assert_eq!(plan.op, "amend");
        undo(path, &plan.head_oid).unwrap();
        assert_eq!(head(&dir), before_amend);
        assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]).trim(), "b.txt");
        fs::remove_dir_all(&dir).ok();
    }

    /// A merge is undone by moving the branch back, the merged files with it — and an unrelated
    /// local edit survives.
    #[test]
    fn undoing_a_merge_moves_back_and_keeps_local_edits() {
        let dir = fixture();
        fs::write(dir.join("local.txt"), "committed\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "local file"]);
        let before = head(&dir);
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        commit(&dir, "feature.txt", "feature\n", "feature work");
        git(&dir, &["checkout", "-q", "main"]);
        commit(&dir, "a.txt", "main change\n", "main work");
        let before_merge = head(&dir);
        git(&dir, &["merge", "-q", "--no-edit", "feature"]);
        assert_ne!(head(&dir), before_merge);
        fs::write(dir.join("local.txt"), "edited, not committed\n").unwrap();

        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        assert_eq!((plan.op.as_str(), plan.strategy), ("merge", UndoStrategy::Keep));
        undo(path, &plan.head_oid).unwrap();
        assert_eq!(head(&dir), before_merge);
        assert!(!dir.join("feature.txt").exists(), "the merged file went with the merge");
        assert_eq!(fs::read_to_string(dir.join("local.txt")).unwrap(), "edited, not committed\n");
        assert_ne!(before, before_merge);
        fs::remove_dir_all(&dir).ok();
    }

    /// A local edit on a file the undo would change refuses the whole thing, and nothing moves.
    #[test]
    fn a_local_edit_in_the_way_refuses_the_undo() {
        let dir = fixture();
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        commit(&dir, "feature.txt", "feature\n", "feature work");
        git(&dir, &["checkout", "-q", "main"]);
        git(&dir, &["merge", "-q", "--ff-only", "feature"]);
        let merged = head(&dir);
        fs::write(dir.join("feature.txt"), "edited after the merge\n").unwrap();

        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        assert_eq!(plan.op, "merge");
        let err = undo(path, &plan.head_oid).unwrap_err();
        assert!(err.starts_with(MERGE_BLOCKED_PREFIX), "{err}");
        assert_eq!(head(&dir), merged);
        assert_eq!(fs::read_to_string(dir.join("feature.txt")).unwrap(), "edited after the merge\n");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn undoing_a_checkout_goes_back_to_the_branch() {
        let dir = fixture();
        git(&dir, &["checkout", "-q", "-b", "other"]);
        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        assert_eq!((plan.op.as_str(), plan.checkout_to.as_deref()), ("checkout", Some("main")));
        undo(path, &plan.head_oid).unwrap();
        assert_eq!(git(&dir, &["branch", "--show-current"]).trim(), "main");
        fs::remove_dir_all(&dir).ok();
    }

    /// A hard reset threw the commit away; undoing it brings commit and files back.
    #[test]
    fn undoing_a_hard_reset_brings_the_commit_back() {
        let dir = fixture();
        commit(&dir, "a.txt", "two\n", "second");
        let second = head(&dir);
        git(&dir, &["reset", "-q", "--hard", "HEAD~1"]);
        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        assert_eq!((plan.op.as_str(), plan.strategy), ("reset", UndoStrategy::Keep));
        undo(path, &plan.head_oid).unwrap();
        assert_eq!(head(&dir), second);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "two\n");
        fs::remove_dir_all(&dir).ok();
    }

    /// A mixed reset left its changes in the tree; undoing it is moving HEAD and the index back.
    #[test]
    fn undoing_a_mixed_reset_is_clean_afterwards() {
        let dir = fixture();
        commit(&dir, "a.txt", "two\n", "second");
        let second = head(&dir);
        git(&dir, &["reset", "-q", "HEAD~1"]);
        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        assert_eq!(plan.strategy, UndoStrategy::Mixed);
        undo(path, &plan.head_oid).unwrap();
        assert_eq!(head(&dir), second);
        assert!(git(&dir, &["status", "--porcelain"]).trim().is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn undoing_a_rebase_returns_to_before_it_started() {
        let dir = fixture();
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        commit(&dir, "feature.txt", "feature\n", "feature work");
        let before_rebase = head(&dir);
        git(&dir, &["checkout", "-q", "main"]);
        commit(&dir, "a.txt", "main moved\n", "main work");
        git(&dir, &["checkout", "-q", "feature"]);
        git(&dir, &["rebase", "-q", "main"]);
        assert_ne!(head(&dir), before_rebase);

        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        assert_eq!((plan.op.as_str(), plan.strategy), ("rebase", UndoStrategy::Keep));
        assert_eq!(plan.target_oid, before_rebase);
        undo(path, &plan.head_oid).unwrap();
        assert_eq!(head(&dir), before_rebase);
        assert_eq!(git(&dir, &["branch", "--show-current"]).trim(), "feature");
        fs::remove_dir_all(&dir).ok();
    }

    /// A plan shown before HEAD moved again must not be carried out against the new HEAD.
    #[test]
    fn a_stale_plan_is_refused() {
        let dir = fixture();
        commit(&dir, "a.txt", "two\n", "second");
        let path = dir.to_str().unwrap();
        let plan = undo_plan(path).unwrap().unwrap();
        commit(&dir, "a.txt", "three\n", "third");
        let err = undo(path, &plan.head_oid).unwrap_err();
        assert!(err.starts_with(UNDO_STALE_PREFIX), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nothing_is_undone_while_a_merge_is_stopped() {
        let dir = fixture();
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        commit(&dir, "a.txt", "feature\n", "feature");
        git(&dir, &["checkout", "-q", "main"]);
        commit(&dir, "a.txt", "main\n", "main");
        let out = cli::run_in(dir.to_str().unwrap(), &["merge", "feature"], &[]).unwrap();
        assert!(!out.success, "the merge should conflict");
        let path = dir.to_str().unwrap();
        let head_now = head(&dir);
        let err = restore(path, &head_now).unwrap_err();
        assert!(err.starts_with(OPERATION_IN_PROGRESS_PREFIX), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    /// Restore moves HEAD to an older entry after writing a backup of where it was.
    #[test]
    fn restore_writes_a_backup_first() {
        let dir = fixture();
        let first = head(&dir);
        commit(&dir, "a.txt", "two\n", "second");
        let second = head(&dir);
        let backup = restore(dir.to_str().unwrap(), &first).unwrap().unwrap();
        assert_eq!(head(&dir), first);
        assert_eq!(rev(&dir, &backup), second);
        assert!(backup.starts_with(BACKUP_PREFIX));
        // And the restore is itself the newest entry, so it can be undone like anything else.
        let entries = list(dir.to_str().unwrap(), 1).unwrap();
        assert_eq!(entries[0].op, "reset");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn checkout_messages_name_where_they_came_from() {
        assert_eq!(checkout_origin("checkout: moving from main to feature"), Some("main"));
        assert_eq!(checkout_origin("checkout: moving from feature/a to b to c"), Some("feature/a to b"));
        assert_eq!(checkout_origin("commit: x"), None);
    }
}
