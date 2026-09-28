//! Rewriting and replaying history: amend, revert, cherry-pick, and tags.
//!
//! These four were the conspicuous hole in a git client's vocabulary. Everything up to now was
//! about *making* a commit — stage, unstage, stage a hunk, commit, stash, reset — and nothing about
//! doing anything to one that already exists. "Fix the message on the commit I just made" is
//! probably the single most common thing anybody wants from a git UI, and it required a terminal.
//!
//! **What is deliberately not here: rebase.** An interactive rebase is not one operation, it is a
//! session with a state machine, a conflict at every step and an editor in the middle. Half of one
//! is worse than none — a UI that starts a rebase and cannot finish it leaves the repository in a
//! state the user has to leave the app to escape. Revert and cherry-pick below are each a single
//! commit applied to the working tree, which is a promise this module can keep.
//!
//! Every function refuses rather than guesses when the tree is dirty, for the same reason: an
//! operation that half-applies over uncommitted work leaves nothing to undo it with.
//!
//! **A conflict leaves a real in-progress state behind.** Revert and cherry-pick go through
//! libgit2's `git_revert` / `git_cherrypick`, which write `REVERT_HEAD` / `CHERRY_PICK_HEAD` and a
//! prepared `MERGE_MSG` exactly as `git revert` does. They used to write only the conflicted index,
//! which left the repository conflicted with nothing on record about *why*: no banner, no way to
//! continue with the right message, no way to abort back to where it was. Now the conflicts banner
//! finishes or undoes one of these like it does a merge — see `merge::continue_operation` and
//! `merge::abort_operation`.

use git2::{ObjectType, Repository, Signature};

use super::merge::{refuse_in_progress, OPERATION_CONFLICTS_PREFIX};
use super::repo::open;

/// Whether anything is staged or modified — the precondition for the three operations that write
/// to the working tree.
///
/// Untracked files are deliberately not counted: they cannot conflict with a patch being applied,
/// and refusing a cherry-pick because there is a stray `notes.txt` in the folder is refusing for no
/// reason.
fn is_dirty(repo: &Repository) -> Result<bool, String> {
    let mut options = git2::StatusOptions::new();
    options.include_untracked(false).include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| e.message().to_string())?;
    Ok(!statuses.is_empty())
}

/// The signature to author with: the caller's override, or whatever git config says.
fn signature(
    repo: &Repository,
    name: Option<String>,
    email: Option<String>,
) -> Result<Signature<'static>, String> {
    match (name, email) {
        (Some(name), Some(email)) => {
            Signature::now(&name, &email).map_err(|e| e.message().to_string())
        }
        _ => repo
            .signature()
            .map(|s| s.to_owned())
            .map_err(|e| e.message().to_string()),
    }
}

/// Replaces the last commit with one carrying `message` and whatever is staged now.
///
/// The commit's **author** and its authored date are preserved — amending is editing your own
/// commit, not re-authoring it — while the committer becomes the current signature, which is
/// exactly what `git commit --amend` does.
///
/// Refuses on a merge commit. Amending one means rebuilding a commit with two parents from an index
/// that no longer records which side each change came from, and getting that wrong silently
/// discards one parent's work.
pub fn amend_commit(
    path: &str,
    message: &str,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<String, String> {
    let repo = open(path)?;
    let head = repo
        .head()
        .map_err(|_| "There is no commit to amend yet".to_string())?;
    let commit = head.peel_to_commit().map_err(|e| e.message().to_string())?;

    if commit.parent_count() > 1 {
        return Err("A merge commit cannot be amended from here".to_string());
    }

    // An amend is a commit: with hooks or signing set up it has to be git's own — see
    // `features.rs`. An empty message keeps the old one, which is `--no-edit` there.
    if super::features::detect_repo(&repo)?.commits_via_cli() {
        let author = author_name.zip(author_email);
        let text = (!message.trim().is_empty()).then_some(message);
        return super::features::commit_via_cli(path, text, super::features::CliCommit::Amend, author);
    }

    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;

    let committer = signature(&repo, author_name, author_email)?;
    // The original author, verbatim — including their timestamp. `to_owned` because the borrowed
    // signature dies with `commit`.
    let author = commit.author().to_owned();

    let text = if message.trim().is_empty() {
        commit.message().unwrap_or_default().to_string()
    } else {
        message.to_string()
    };

    let oid = commit
        .amend(Some("HEAD"), Some(&author), Some(&committer), None, Some(&text), Some(&tree))
        .map_err(|e| e.message().to_string())?;
    Ok(oid.to_string())
}

/// The message an amend should start from — the last commit's, so the editor opens on it rather
/// than on a blank box the user has to retype from memory.
pub fn head_commit_message(path: &str) -> Result<String, String> {
    let repo = open(path)?;
    let head = repo
        .head()
        .map_err(|_| "There is no commit yet".to_string())?;
    let commit = head.peel_to_commit().map_err(|e| e.message().to_string())?;
    Ok(commit.message().unwrap_or_default().to_string())
}

/// A libgit2 failure while applying a revert or cherry-pick. Its checkout is a safe one, so the
/// only thing that can stand in its way on a clean tree is an untracked file where the change wants
/// to write — and "1 conflict prevents checkout" does not say that. Tagged with no paths after it,
/// since libgit2 names none here; the UI then says "commit or stash your changes first".
fn apply_error(e: git2::Error) -> String {
    if e.code() == git2::ErrorCode::Conflict {
        super::merge::MERGE_BLOCKED_PREFIX.to_string()
    } else {
        e.message().to_string()
    }
}

/// Applies the inverse of `target_oid` to the working tree and commits it.
///
/// Committed rather than left staged, and that is the deliberate half of this: `git revert` commits
/// by default, the resulting commit's whole purpose is to be pushed, and leaving it staged would
/// invite it to be mixed into an unrelated commit.
///
/// A merge commit is refused. Reverting one requires naming which parent the change came *from*
/// (`-m 1`), and a UI that picks a mainline for you is one that silently undoes the wrong side.
///
/// On a conflict it stops the way `git revert` stops — `REVERT_HEAD` and the prepared message
/// written, the conflicts in the index and on disk — and answers with
/// [`OPERATION_CONFLICTS_PREFIX`] so the UI can send the user to the conflicts banner.
pub fn revert_commit(
    path: &str,
    target_oid: &str,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<String, String> {
    let repo = open(path)?;
    refuse_in_progress(&repo)?;
    if is_dirty(&repo)? {
        return Err("Commit or stash your changes before reverting".to_string());
    }

    let oid = git2::Oid::from_str(target_oid).map_err(|e| e.message().to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
    if commit.parent_count() > 1 {
        return Err("Reverting a merge commit is not supported here".to_string());
    }

    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.message().to_string())?;
    // Resolved before anything is written, so a missing identity refuses the revert instead of
    // stranding it half-applied.
    let sig = signature(&repo, author_name, author_email)?;

    // Index and working tree, through a safe checkout, with `REVERT_HEAD` and `MERGE_MSG` beside
    // them — the state `git revert` leaves when it stops.
    repo.revert(&commit, None).map_err(apply_error)?;

    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    if index.has_conflicts() {
        return Err(format!("{OPERATION_CONFLICTS_PREFIX}revert"));
    }

    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;

    let summary = commit.summary().unwrap_or("commit");
    let message = format!("Revert \"{summary}\"\n\nThis reverts commit {}.\n", commit.id());

    let new_oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&head_commit])
        .map_err(|e| e.message().to_string())?;
    // The files are already on disk and in the index — `git_revert` put them there — so all that is
    // left is the state files. The forced checkout this used to end with is gone with the rest.
    repo.cleanup_state().map_err(|e| e.message().to_string())?;

    Ok(new_oid.to_string())
}

/// Applies `target_oid`'s change on top of HEAD, keeping its message and author.
///
/// `commit_now = false` leaves the result staged instead of committed, which is `-n`: the case
/// where somebody is lifting a fix out of another branch and intends to edit it before it lands.
pub fn cherry_pick_commit(
    path: &str,
    target_oid: &str,
    commit_now: bool,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<String, String> {
    let repo = open(path)?;
    refuse_in_progress(&repo)?;
    if is_dirty(&repo)? {
        return Err("Commit or stash your changes before cherry-picking".to_string());
    }

    let oid = git2::Oid::from_str(target_oid).map_err(|e| e.message().to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
    if commit.parent_count() > 1 {
        return Err("Cherry-picking a merge commit is not supported here".to_string());
    }

    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.message().to_string())?;
    let committer = if commit_now { Some(signature(&repo, author_name, author_email)?) } else { None };

    // Same shape as the revert: a safe checkout, `CHERRY_PICK_HEAD` and the commit's own message
    // in `MERGE_MSG`, and on a conflict the state is left for the banner to finish.
    repo.cherrypick(&commit, None).map_err(apply_error)?;

    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    if index.has_conflicts() {
        return Err(format!("{OPERATION_CONFLICTS_PREFIX}cherry_pick"));
    }

    let Some(committer) = committer else {
        // `-n`: the change stays staged for the user to edit, and like `git cherry-pick -n` nothing
        // records an operation in progress.
        repo.cleanup_state().map_err(|e| e.message().to_string())?;
        return Ok(String::new());
    };

    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;

    // The original author is kept and the committer is us — the same split `git cherry-pick` makes,
    // and the reason a cherry-picked commit still credits whoever wrote it.
    let author = commit.author().to_owned();
    let message = commit.message().unwrap_or_default();

    let new_oid = repo
        .commit(Some("HEAD"), &author, &committer, message, &tree, &[&head_commit])
        .map_err(|e| e.message().to_string())?;
    repo.cleanup_state().map_err(|e| e.message().to_string())?;

    Ok(new_oid.to_string())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TagInfo {
    pub name: String,
    /// The commit it points at, after peeling — an annotated tag points at a tag object, and the
    /// UI only ever wants the commit.
    pub target_oid: String,
    /// Annotated tags carry a message; lightweight ones are just a ref and have none.
    pub message: String,
    pub annotated: bool,
}

/// Every tag in the repository, newest-looking first is *not* attempted — they come back in the
/// order git stores them, which is alphabetical, because a tag has no date of its own unless it is
/// annotated and sorting two kinds by different keys reads as random.
pub fn list_tags(path: &str) -> Result<Vec<TagInfo>, String> {
    let repo = open(path)?;
    let names = repo.tag_names(None).map_err(|e| e.message().to_string())?;
    let mut out = Vec::new();
    for name in names.iter().flatten() {
        let Ok(reference) = repo.find_reference(&format!("refs/tags/{name}")) else {
            continue;
        };
        let Ok(object) = reference.peel(ObjectType::Commit) else {
            continue;
        };
        let annotated = reference.peel(ObjectType::Tag).is_ok();
        let message = reference
            .peel(ObjectType::Tag)
            .ok()
            .and_then(|tag| tag.as_tag().and_then(|t| t.message().map(str::to_string)))
            .unwrap_or_default();
        out.push(TagInfo {
            name: name.to_string(),
            target_oid: object.id().to_string(),
            message,
            annotated,
        });
    }
    Ok(out)
}

/// Creates a tag at `target_oid`. With a message it is annotated; without, lightweight.
pub fn create_tag(
    path: &str,
    name: &str,
    target_oid: &str,
    message: &str,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<(), String> {
    let repo = open(path)?;
    let oid = git2::Oid::from_str(target_oid).map_err(|e| e.message().to_string())?;
    let object = repo
        .find_object(oid, Some(ObjectType::Commit))
        .map_err(|e| e.message().to_string())?;

    if message.trim().is_empty() {
        repo.tag_lightweight(name, &object, false)
            .map_err(|e| e.message().to_string())?;
    } else {
        let sig = signature(&repo, author_name, author_email)?;
        repo.tag(name, &object, &sig, message, false)
            .map_err(|e| e.message().to_string())?;
    }
    Ok(())
}

pub fn delete_tag(path: &str, name: &str) -> Result<(), String> {
    let repo = open(path)?;
    repo.tag_delete(name).map_err(|e| e.message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::build::CheckoutBuilder;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn sig() -> Signature<'static> {
        Signature::now("Test", "test@example.com").unwrap()
    }

    /// A repo with `n` commits, each adding a line to `file.txt`.
    fn fixture(lines: &[&str]) -> (PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!("cf-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        let mut parent: Option<git2::Oid> = None;
        for (index, line) in lines.iter().enumerate() {
            fs::write(dir.join("file.txt"), format!("{line}\n")).unwrap();
            let mut idx = repo.index().unwrap();
            idx.add_path(Path::new("file.txt")).unwrap();
            idx.write().unwrap();
            let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
            let parents: Vec<git2::Commit> =
                parent.iter().map(|oid| repo.find_commit(*oid).unwrap()).collect();
            let refs: Vec<&git2::Commit> = parents.iter().collect();
            parent = Some(
                repo.commit(Some("HEAD"), &sig(), &sig(), &format!("commit {index}"), &tree, &refs)
                    .unwrap(),
            );
        }
        (dir, repo)
    }

    fn head_message(repo: &Repository) -> String {
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .message()
            .unwrap()
            .to_string()
    }

    #[test]
    fn amend_replaces_the_message_and_keeps_one_commit() {
        let (dir, repo) = fixture(&["a", "b"]);
        let before = repo.head().unwrap().peel_to_commit().unwrap().id();

        amend_commit(dir.to_str().unwrap(), "a better message", None, None).unwrap();

        let after = repo.head().unwrap().peel_to_commit().unwrap();
        assert_ne!(before, after.id(), "amending rewrites the commit");
        assert_eq!(head_message(&repo).trim(), "a better message");
        assert_eq!(after.parent_count(), 1, "it replaces HEAD rather than adding to it");
    }

    #[test]
    fn amend_keeps_the_original_author() {
        let (dir, repo) = fixture(&["a"]);
        amend_commit(
            dir.to_str().unwrap(),
            "reworded",
            Some("Someone Else".into()),
            Some("else@example.com".into()),
        )
        .unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(commit.author().name().unwrap(), "Test", "the author is preserved");
        assert_eq!(
            commit.committer().name().unwrap(),
            "Someone Else",
            "the committer is whoever amended it"
        );
    }

    #[test]
    fn amend_with_an_empty_message_keeps_the_old_one() {
        let (dir, repo) = fixture(&["a"]);
        amend_commit(dir.to_str().unwrap(), "   ", None, None).unwrap();
        assert_eq!(head_message(&repo).trim(), "commit 0");
    }

    #[test]
    fn revert_undoes_the_change_and_adds_a_commit() {
        let (dir, repo) = fixture(&["first", "second"]);
        let top = repo.head().unwrap().peel_to_commit().unwrap().id();

        revert_commit(dir.to_str().unwrap(), &top.to_string(), None, None).unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("file.txt")).unwrap(),
            "first\n",
            "the working tree is back to the previous content"
        );
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert!(head_message(&repo).starts_with("Revert \"commit 1\""));
        assert_eq!(head.parent(0).unwrap().id(), top, "it is a new commit on top, not a rewrite");
    }

    #[test]
    fn revert_refuses_a_dirty_tree() {
        let (dir, repo) = fixture(&["first", "second"]);
        let top = repo.head().unwrap().peel_to_commit().unwrap().id();
        fs::write(dir.join("file.txt"), "uncommitted\n").unwrap();

        let error = revert_commit(dir.to_str().unwrap(), &top.to_string(), None, None).unwrap_err();
        assert!(error.contains("stash"), "it says what to do: {error}");
        assert_eq!(
            fs::read_to_string(dir.join("file.txt")).unwrap(),
            "uncommitted\n",
            "and it changed nothing"
        );
    }

    #[test]
    fn cherry_pick_applies_a_commit_from_elsewhere() {
        let (dir, repo) = fixture(&["base"]);
        let base = repo.head().unwrap().peel_to_commit().unwrap();

        // A commit on a side branch that adds a second file.
        repo.branch("side", &base, false).unwrap();
        repo.set_head("refs/heads/side").unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force())).unwrap();
        fs::write(dir.join("extra.txt"), "from the side branch\n").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("extra.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let side = repo
            .commit(Some("HEAD"), &sig(), &sig(), "add extra", &tree, &[&base])
            .unwrap();

        // Back to the original branch, which does not have that file.
        repo.set_head("refs/heads/master")
            .or_else(|_| repo.set_head("refs/heads/main"))
            .unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force())).unwrap();
        assert!(!dir.join("extra.txt").exists());

        cherry_pick_commit(dir.to_str().unwrap(), &side.to_string(), true, None, None).unwrap();

        assert!(dir.join("extra.txt").exists(), "the change is on this branch now");
        assert_eq!(head_message(&repo).trim(), "add extra", "with its own message");
    }

    #[test]
    fn tags_can_be_created_listed_and_deleted() {
        let (dir, repo) = fixture(&["a"]);
        let head = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
        let path = dir.to_str().unwrap();

        create_tag(path, "v1.0.0", &head, "", None, None).unwrap();
        create_tag(path, "v1.1.0", &head, "the annotated one", None, None).unwrap();

        let tags = list_tags(path).unwrap();
        assert_eq!(tags.len(), 2);
        let annotated = tags.iter().find(|t| t.name == "v1.1.0").unwrap();
        assert!(annotated.annotated);
        assert_eq!(annotated.message.trim(), "the annotated one");
        assert_eq!(annotated.target_oid, head, "an annotated tag reports the commit, not the tag object");

        let light = tags.iter().find(|t| t.name == "v1.0.0").unwrap();
        assert!(!light.annotated);

        delete_tag(path, "v1.0.0").unwrap();
        assert_eq!(list_tags(path).unwrap().len(), 1);
    }

    /// Reverting the first of three commits that each rewrote the same line conflicts with the
    /// two after it — the simplest revert that cannot apply cleanly.
    fn conflicted_revert() -> (PathBuf, Repository, git2::Oid) {
        let (dir, repo) = fixture(&["first", "second", "third"]);
        let (second, tip) = {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            (head.parent(0).unwrap().id(), head.id())
        };
        let err = revert_commit(dir.to_str().unwrap(), &second.to_string(), None, None).unwrap_err();
        assert_eq!(err, format!("{OPERATION_CONFLICTS_PREFIX}revert"), "tagged for the UI");
        (dir, repo, tip)
    }

    /// A conflicted revert stops the way `git revert` does, instead of leaving an anonymous
    /// conflicted index: `REVERT_HEAD`, the prepared message, and the conflicts on disk.
    #[test]
    fn a_conflicted_revert_leaves_a_revert_in_progress() {
        let (dir, _repo, tip) = conflicted_revert();
        let path = dir.to_str().unwrap();

        let state = super::super::merge::operation_state(path).unwrap();
        assert_eq!(state.kind, Some(super::super::merge::OperationKind::Revert));
        assert!(!state.sequenced);
        assert_eq!(state.conflicts, vec!["file.txt".to_string()]);
        assert!(state.message.as_deref().unwrap_or("").starts_with("Revert \"commit 1\""), "{state:?}");
        assert!(fs::read_to_string(dir.join("file.txt")).unwrap().contains("<<<<<<<"));
        let repo = Repository::open(&dir).unwrap();
        assert_eq!(repo.head().unwrap().target().unwrap(), tip, "nothing is committed yet");

        fs::remove_dir_all(&dir).ok();
    }

    /// Continue commits the resolution with the prepared "Revert …" message and clears the state.
    #[test]
    fn continuing_a_conflicted_revert_commits_with_the_prepared_message() {
        let (dir, _repo, tip) = conflicted_revert();
        let path = dir.to_str().unwrap();
        fs::write(dir.join("file.txt"), "resolved\n").unwrap();
        super::super::merge::mark_conflict_resolved(path, "file.txt").unwrap();

        super::super::merge::continue_operation(path, None).unwrap();

        let repo = Repository::open(&dir).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_id(0).unwrap(), tip);
        assert_eq!(head.parent_count(), 1, "a revert is not a merge");
        assert!(head_message(&repo).starts_with("Revert \"commit 1\""));
        assert!(!head_message(&repo).contains('#'), "git's comment lines stay out of the commit");

        fs::remove_dir_all(&dir).ok();
    }

    /// Abort puts the reverted file back and leaves an edit to anything else alone.
    #[test]
    fn aborting_a_conflicted_revert_keeps_unrelated_work() {
        let (dir, _repo, tip) = conflicted_revert();
        let path = dir.to_str().unwrap();
        // Something the user started while the revert was stopped — not the revert's to take away.
        fs::write(dir.join("notes.txt"), "mine\n").unwrap();

        super::super::merge::abort_operation(path).unwrap();

        let repo = Repository::open(&dir).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        assert_eq!(repo.head().unwrap().target().unwrap(), tip);
        assert_eq!(fs::read_to_string(dir.join("file.txt")).unwrap(), "third\n");
        assert_eq!(fs::read_to_string(dir.join("notes.txt")).unwrap(), "mine\n");
        assert!(!repo.index().unwrap().has_conflicts());

        fs::remove_dir_all(&dir).ok();
    }

    /// The cherry-pick twin: a conflicting pick stops with `CHERRY_PICK_HEAD`, and continuing keeps
    /// the original author — what `git cherry-pick --continue` does.
    #[test]
    fn a_conflicted_cherry_pick_continues_with_the_original_author() {
        let (dir, repo) = fixture(&["base"]);
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        let base_ref = repo.head().unwrap().name().unwrap().to_string();

        // A side commit by someone else that rewrites the file…
        let blob = repo.blob(b"side\n").unwrap();
        let mut builder = repo.treebuilder(Some(&base.tree().unwrap())).unwrap();
        builder.insert("file.txt", blob, 0o100644).unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let other = Signature::now("Other Person", "other@example.com").unwrap();
        let side = repo.commit(None, &other, &other, "side change", &tree, &[&base]).unwrap();
        // …and a commit here that rewrites it differently.
        fs::write(dir.join("file.txt"), "here\n").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("file.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        repo.commit(Some(&base_ref), &sig(), &sig(), "here", &tree, &[&base]).unwrap();
        let path = dir.to_str().unwrap();

        let err = cherry_pick_commit(path, &side.to_string(), true, None, None).unwrap_err();
        assert_eq!(err, format!("{OPERATION_CONFLICTS_PREFIX}cherry_pick"));
        let state = super::super::merge::operation_state(path).unwrap();
        assert_eq!(state.kind, Some(super::super::merge::OperationKind::CherryPick));

        super::super::merge::resolve_conflict_side(path, "file.txt", "theirs").unwrap();
        super::super::merge::continue_operation(path, None).unwrap();

        let repo = Repository::open(&dir).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.author().name(), Some("Other Person"), "the pick still credits its author");
        assert_eq!(head.message().unwrap().trim(), "side change");
        assert_eq!(repo.state(), git2::RepositoryState::Clean);

        fs::remove_dir_all(&dir).ok();
    }

    /// Starting a revert while one is already stopped would tangle two operations' state files.
    #[test]
    fn a_revert_is_refused_while_another_is_in_progress() {
        let (dir, repo, _tip) = conflicted_revert();
        let first = repo.find_reference("HEAD").unwrap().peel_to_commit().unwrap();
        let first = first.parent(0).unwrap().parent(0).unwrap().id();
        // The tree is conflicted, which the dirty check would also catch — the state check comes
        // first and says what is actually wrong.
        let err = revert_commit(dir.to_str().unwrap(), &first.to_string(), None, None).unwrap_err();
        assert!(err.starts_with(super::super::merge::OPERATION_IN_PROGRESS_PREFIX), "{err}");

        fs::remove_dir_all(&dir).ok();
    }
}
