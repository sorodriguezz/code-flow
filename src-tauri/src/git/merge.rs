use std::cell::RefCell;
use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{BranchType, CheckoutNotificationType, ErrorCode, Oid, Repository, RepositoryState, Tree};
use serde::{Deserialize, Serialize};

use super::identity::repo_signature;
use super::repo::{open, unborn_head_branch};

/// Marks a merge refused because it would overwrite uncommitted work. Whatever follows the prefix
/// is the list of files in the way, when libgit2 named them — the frontend turns it into "commit or
/// stash your changes first" rather than showing "1 conflict prevents checkout".
pub const MERGE_BLOCKED_PREFIX: &str = "MERGE_BLOCKED: ";

/// Marks a (non-fast-forward) merge refused because something is staged. git refuses this too, and
/// for a reason that is easy to miss: the merge commit is written from the index, so whatever was
/// staged beforehand would ride along inside "Merge branch …" where nobody would think to look.
pub const MERGE_STAGED_PREFIX: &str = "MERGE_STAGED: ";

/// Marks a refusal because another operation — a merge, a revert, a cherry-pick, a rebase — is
/// already half done. The operation's kind follows the prefix.
pub const OPERATION_IN_PROGRESS_PREFIX: &str = "OPERATION_IN_PROGRESS: ";

/// Marks an operation that *started* and stopped on conflicts: the repository is now mid-revert (or
/// mid-cherry-pick, mid-merge, mid-rebase) and the conflicts banner is where it continues. Not a
/// failure in the ordinary sense, which is why it is tagged — the UI refreshes and sends the user
/// to the conflicts instead of just showing a red toast. The operation's kind follows the prefix.
pub const OPERATION_CONFLICTS_PREFIX: &str = "OPERATION_CONFLICTS: ";

/// Marks a commit refused because the index still holds conflicts — libgit2's own words for it are
/// "cannot create a tree from a not fully merged index".
pub const UNRESOLVED_CONFLICTS_PREFIX: &str = "UNRESOLVED_CONFLICTS: ";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeOutcome {
    /// "up_to_date" | "fast_forward" | "merged" | "conflicts"
    pub status: String,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictFile {
    pub path: String,
}

/// The operations git can leave half done, waiting for the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Merge,
    Revert,
    CherryPick,
    Rebase,
}

impl OperationKind {
    /// `None` for a clean repository — and for the two states this app has no verbs for (a bisect,
    /// a `git am`), which are left to the terminal that started them.
    pub fn of(state: RepositoryState) -> Option<OperationKind> {
        match state {
            RepositoryState::Merge => Some(OperationKind::Merge),
            RepositoryState::Revert | RepositoryState::RevertSequence => Some(OperationKind::Revert),
            RepositoryState::CherryPick | RepositoryState::CherryPickSequence => Some(OperationKind::CherryPick),
            RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge
            | RepositoryState::ApplyMailboxOrRebase => Some(OperationKind::Rebase),
            _ => None,
        }
    }

    /// The name the UI keys off, spelled as the frontend's `OperationKind` spells it (`cherry_pick`).
    /// The CLI's own spelling of each is in `remote::sequencer_args`.
    pub fn as_str(self) -> &'static str {
        match self {
            OperationKind::Merge => "merge",
            OperationKind::Revert => "revert",
            OperationKind::CherryPick => "cherry_pick",
            OperationKind::Rebase => "rebase",
        }
    }
}

/// Whether an in-progress operation belongs to git's own sequencer — a rebase, or a revert or
/// cherry-pick of *several* commits started from a terminal — rather than being the single-step
/// kind this module writes itself.
///
/// The difference decides who may finish it. A single merge, revert or cherry-pick is one commit
/// and a handful of state files, which the code below completes or undoes directly. A sequence has
/// a to-do list in `.git/sequencer` or `.git/rebase-merge` that only git knows how to walk, and
/// libgit2's `cleanup_state` deletes that directory outright — so finishing one of those here
/// would silently drop every step after the current one. Those go through `git <op> --continue`.
pub fn is_sequenced(state: RepositoryState) -> bool {
    matches!(
        state,
        RepositoryState::RevertSequence
            | RepositoryState::CherryPickSequence
            | RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge
            | RepositoryState::ApplyMailboxOrRebase
    )
}

/// What the conflicts banner needs to know, in one read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationState {
    /// The operation in progress, if any.
    pub kind: Option<OperationKind>,
    /// Continue and abort go through the git CLI — see [`is_sequenced`].
    pub sequenced: bool,
    /// Unresolved paths, read from the index **whatever the state**. A `git stash pop` that
    /// conflicted leaves conflicts behind with no operation at all, and a list that only looked
    /// while merging hid them completely.
    pub conflicts: Vec<String>,
    /// The message git prepared for the operation's commit (`.git/MERGE_MSG`), with its `#` comment
    /// lines taken out — what "continue" commits with unless the user edits it.
    pub message: Option<String>,
}

fn conflict_paths(index: &git2::Index) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for conflict in index.conflicts().map_err(|e| e.message().to_string())? {
        let conflict = conflict.map_err(|e| e.message().to_string())?;
        let entry = conflict.our.or(conflict.their).or(conflict.ancestor);
        if let Some(entry) = entry {
            let path = String::from_utf8_lossy(&entry.path).to_string();
            if seen.insert(path.clone()) {
                result.push(path);
            }
        }
    }
    Ok(result)
}

/// `.git/MERGE_MSG` as a commit message: without the lines git writes as comments (libgit2 appends a
/// `#Conflicts:` list, the CLI a whole paragraph of advice), and trimmed. `None` when there is no
/// such file or nothing is left of it.
fn prepared_message(repo: &Repository) -> Option<String> {
    let raw = repo.message().ok()?;
    let kept: Vec<&str> = raw.lines().filter(|line| !line.starts_with('#')).collect();
    let text = kept.join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub fn operation_state(path: &str) -> Result<OperationState, String> {
    let repo = open(path)?;
    let state = repo.state();
    let kind = OperationKind::of(state);
    let index = repo.index().map_err(|e| e.message().to_string())?;
    Ok(OperationState {
        kind,
        sequenced: kind.is_some() && is_sequenced(state),
        conflicts: conflict_paths(&index)?,
        message: kind.and_then(|_| prepared_message(&repo)),
    })
}

/// Refuses to start anything while another operation is half done — git does the same, because two
/// operations interleaved leave state files that belong to neither.
pub(super) fn refuse_in_progress(repo: &Repository) -> Result<(), String> {
    match OperationKind::of(repo.state()) {
        Some(kind) => Err(format!("{OPERATION_IN_PROGRESS_PREFIX}{}", kind.as_str())),
        None => Ok(()),
    }
}

/// The paths where the index differs from HEAD — what `git diff --cached --name-only` lists.
fn staged_paths(repo: &Repository) -> Result<Vec<String>, String> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let index = repo.index().map_err(|e| e.message().to_string())?;
    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        .map_err(|e| e.message().to_string())?;
    let mut paths = BTreeSet::new();
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(bytes) = file.path_bytes() {
                paths.insert(String::from_utf8_lossy(bytes).into_owned());
            }
        }
    }
    Ok(paths.into_iter().collect())
}

/// A checkout or merge that stopped because local work is in the way, with the paths it named.
fn blocked_error(e: git2::Error, paths: &[String]) -> String {
    if e.code() == ErrorCode::Conflict || e.code() == ErrorCode::MergeConflict {
        format!("{MERGE_BLOCKED_PREFIX}{}", paths.join(", "))
    } else {
        e.message().to_string()
    }
}

pub fn merge_branch(path: &str, branch_name: &str) -> Result<MergeOutcome, String> {
    let repo = open(path)?;
    // A merge moves the branch we're standing on, so it's that one the lock has to protect —
    // merging *from* a locked branch leaves the locked branch untouched and stays allowed.
    super::branch::guard_head_unlocked(&repo)?;
    refuse_in_progress(&repo)?;
    {
        let index = repo.index().map_err(|e| e.message().to_string())?;
        if index.has_conflicts() {
            return Err(format!("{UNRESOLVED_CONFLICTS_PREFIX}resolve the conflicts first"));
        }
    }
    let their_branch = repo
        .find_branch(branch_name, BranchType::Local)
        .or_else(|_| repo.find_branch(branch_name, BranchType::Remote))
        .map_err(|e| e.message().to_string())?;
    let their_commit = their_branch
        .get()
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    // From the reference rather than the bare id, so the message git prepares for a conflicted
    // merge reads "Merge branch 'feature'" instead of "Merge commit '3f2a…'" — it is the text the
    // conflicts banner offers to commit with.
    let annotated = repo
        .reference_to_annotated_commit(their_branch.get())
        .map_err(|e| e.message().to_string())?;

    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.message().to_string())?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome { status: "up_to_date".to_string(), conflicts: vec![] });
    }

    if analysis.is_fast_forward() {
        fast_forward(&repo, &their_commit, branch_name)?;
        return Ok(MergeOutcome { status: "fast_forward".to_string(), conflicts: vec![] });
    }

    // What git refuses and libgit2 would not: anything already staged would be folded into the merge
    // commit, because that commit is written from the index. Unstaged edits to files the merge does
    // not touch are fine — they stay in the working tree and out of the commit, exactly as with git.
    let staged = staged_paths(&repo)?;
    if !staged.is_empty() {
        return Err(format!("{MERGE_STAGED_PREFIX}{}", staged.join(", ")));
    }
    // Resolved before anything is written, so a missing name refuses the merge instead of leaving it
    // applied and uncommitted.
    let sig = repo_signature(&repo)?;

    // libgit2's default for a merge is a *safe* checkout that allows conflicts, and it checks first
    // that no uncommitted change sits on a path the merge writes (`git_merge__check_result`) — the
    // same "your local changes would be overwritten" refusal git gives, and it leaves no state
    // behind when it refuses.
    repo.merge(&[&annotated], None, None).map_err(|e| blocked_error(e, &[]))?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;

    if index.has_conflicts() {
        let conflicts = conflict_paths(&index)?;
        return Ok(MergeOutcome { status: "conflicts".to_string(), conflicts });
    }

    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;
    let head_commit = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    let message = format!("Merge branch '{branch_name}'");
    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&head_commit, &their_commit])
        .map_err(|e| e.message().to_string())?;
    repo.cleanup_state().map_err(|e| e.message().to_string())?;

    Ok(MergeOutcome { status: "merged".to_string(), conflicts: vec![] })
}

/// Moves HEAD's branch forward to `target` — **checkout first, ref second**.
///
/// The old version did it the other way round: it moved the branch, then ran a *forced* checkout of
/// the new HEAD. A forced checkout does not merge anything, it overwrites, so every uncommitted edit
/// to a tracked file was reverted without a word — a fast-forward is the most common merge there
/// is, which made it the most common way to lose work in the app.
///
/// Now the target tree is checked out with a **safe** checkout while HEAD still points where it
/// did, so HEAD's tree is the baseline: a file the fast-forward changes is refused if it has local
/// edits (or if an untracked file sits where it would land), and every other local change —
/// staged or not — is carried over untouched, which is what `git merge --ff` does. libgit2 finds
/// every conflict before it writes anything, so a refusal leaves the working tree exactly as it
/// was, and the ref is only moved once the files are in place.
fn fast_forward(repo: &Repository, target: &git2::Commit, branch_name: &str) -> Result<(), String> {
    let blocked: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let checked_out = {
        let mut cb = CheckoutBuilder::new();
        cb.safe();
        cb.notify_on(CheckoutNotificationType::CONFLICT);
        cb.notify(|_kind, path, _baseline, _target, _workdir| {
            if let Some(path) = path {
                blocked.borrow_mut().push(path.to_string_lossy().replace('\\', "/"));
            }
            true
        });
        repo.checkout_tree(target.as_object(), Some(&mut cb))
    };
    checked_out.map_err(|e| blocked_error(e, &blocked.borrow()))?;

    let log = format!("merge {branch_name}: Fast-forward");
    match repo.head() {
        Ok(head) if head.is_branch() => {
            let refname = head.name().ok_or("invalid HEAD ref")?.to_string();
            let mut reference = repo.find_reference(&refname).map_err(|e| e.message().to_string())?;
            reference.set_target(target.id(), &log).map_err(|e| e.message().to_string())?;
        }
        // A detached HEAD fast-forwards by moving HEAD itself — there is no branch to move.
        Ok(_) => repo.set_head_detached(target.id()).map_err(|e| e.message().to_string())?,
        // Before the first commit the branch is only a line in `.git/HEAD`; the fast-forward is what
        // finally creates it.
        Err(_) => {
            let name = unborn_head_branch(repo).ok_or("HEAD points at no branch")?;
            repo.reference(&format!("refs/heads/{name}"), target.id(), false, &log)
                .map_err(|e| e.message().to_string())?;
        }
    }
    Ok(())
}

pub fn is_merging(path: &str) -> Result<bool, String> {
    let repo = open(path)?;
    Ok(repo.state() == RepositoryState::Merge)
}

pub fn list_conflicts(path: &str) -> Result<Vec<ConflictFile>, String> {
    let repo = open(path)?;
    let index = repo.index().map_err(|e| e.message().to_string())?;
    Ok(conflict_paths(&index)?.into_iter().map(|path| ConflictFile { path }).collect())
}

/// The three conflicting versions of a single file, decoded to text from the merge index stages.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictVersions {
    /// Common ancestor (stage 1). Empty when the file was newly added on both sides.
    pub base: String,
    /// Our side (stage 2 — the branch merged into). Empty if we deleted the file.
    pub ours: String,
    /// Their side (stage 3 — the incoming branch). Empty if they deleted the file.
    pub theirs: String,
}

/// Reads a conflicted file's base/ours/theirs versions straight from the merge index stages so the
/// AI resolver gets each side whole — rather than having to reverse-engineer them from the
/// `<<<<<<<`/`=======`/`>>>>>>>` markers in the working copy.
pub fn conflict_versions(path: &str, rel_path: &str) -> Result<ConflictVersions, String> {
    let repo = open(path)?;
    let index = repo.index().map_err(|e| e.message().to_string())?;
    let conflict = index
        .conflicts()
        .map_err(|e| e.message().to_string())?
        .filter_map(|c| c.ok())
        .find(|c| {
            c.our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .is_some_and(|e| e.path == rel_path.as_bytes())
        })
        .ok_or("no conflict for this path")?;

    let read = |entry: &Option<git2::IndexEntry>| -> String {
        entry
            .as_ref()
            .and_then(|e| repo.find_blob(e.id).ok())
            .map(|b| String::from_utf8_lossy(b.content()).to_string())
            .unwrap_or_default()
    };

    Ok(ConflictVersions {
        base: read(&conflict.ancestor),
        ours: read(&conflict.our),
        theirs: read(&conflict.their),
    })
}

/// Resolves a conflicted file by taking one side wholesale ("ours" or "theirs"),
/// writing it to disk and staging it.
pub fn resolve_conflict_side(path: &str, rel_path: &str, side: &str) -> Result<(), String> {
    // An LFS path's stages are pointers: git checks the side out through the smudge filter and
    // stages it back as a pointer. See `conflict::resolve_side_via_cli`.
    if super::conflict::resolve_side_via_cli(path, rel_path, side)?.is_some() {
        return Ok(());
    }
    let repo = open(path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let conflict = index
        .conflicts()
        .map_err(|e| e.message().to_string())?
        .filter_map(|c| c.ok())
        .find(|c| {
            c.our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .is_some_and(|e| e.path == rel_path.as_bytes())
        })
        .ok_or("no conflict for this path")?;

    let entry = match side {
        "ours" => conflict.our,
        "theirs" => conflict.their,
        _ => return Err("side must be 'ours' or 'theirs'".to_string()),
    }
    .ok_or("that side has no content for this file (it was added/deleted)")?;

    let blob = repo.find_blob(entry.id).map_err(|e| e.message().to_string())?;
    let full_path = Path::new(path).join(rel_path);
    std::fs::write(&full_path, blob.content()).map_err(|e| e.to_string())?;

    index.add_path(Path::new(rel_path)).map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Stages whatever is currently on disk for this path as the resolution — used after
/// the user manually edits the conflicted file (e.g. in the embedded editor).
///
/// A file that is no longer on disk resolves as deleted, the way `git rm` settles a modify/delete
/// conflict — the same split `diff::stage_file` makes.
pub fn mark_conflict_resolved(path: &str, rel_path: &str) -> Result<(), String> {
    let repo = open(path)?;
    if Path::new(path).join(rel_path).exists() && super::features::stage_needs_cli(&repo, rel_path) {
        return super::features::cli_add(path, &[rel_path]);
    }
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    if Path::new(path).join(rel_path).exists() {
        index.add_path(Path::new(rel_path)).map_err(|e| e.message().to_string())?;
    } else {
        index.remove_path(Path::new(rel_path)).map_err(|e| e.message().to_string())?;
    }
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

/// The commits an in-progress merge is merging in — every line of `MERGE_HEAD`, which is one oid per
/// line (several after an octopus merge started from a terminal).
///
/// Read from the file rather than through `mergehead_foreach`, which wants the repository mutably
/// borrowed — and every caller here is holding commits and trees borrowed from it at the time.
fn merge_heads(repo: &Repository) -> Vec<Oid> {
    std::fs::read_to_string(repo.path().join("MERGE_HEAD"))
        .map(|text| text.lines().filter_map(|line| Oid::from_str(line.trim()).ok()).collect())
        .unwrap_or_default()
}

/// The commit a single-step revert or cherry-pick is replaying, from `REVERT_HEAD` /
/// `CHERRY_PICK_HEAD`.
fn operation_commit<'r>(repo: &'r Repository, kind: OperationKind) -> Option<git2::Commit<'r>> {
    let name = match kind {
        OperationKind::Revert => "REVERT_HEAD",
        OperationKind::CherryPick => "CHERRY_PICK_HEAD",
        _ => return None,
    };
    repo.find_reference(name).ok()?.peel_to_commit().ok()
}

/// Commits a merge, revert or cherry-pick that stopped for the user, the way `git commit` would
/// while one is in progress — and clears its state files afterwards.
///
/// * a **merge** gets every `MERGE_HEAD` as a further parent — without them it is an ordinary
///   commit, and the branch that was merged in is not recorded as merged;
/// * a **cherry-pick** keeps the original commit's author, as `git cherry-pick --continue` does;
/// * a **revert** is authored by whoever is committing.
///
/// `message` wins when it has text; otherwise the one git prepared in `MERGE_MSG`. Not for a
/// sequenced operation — see [`is_sequenced`], which the callers check.
///
/// A merge commit is refused on a locked branch, from every route that can make one — the banner,
/// the commit box — which closes the "start the merge, then lock the branch" hole. Revert and
/// cherry-pick were never lock-guarded (a lock keeps merges and pushes off a branch, not commits),
/// and finishing one is not either.
pub(super) fn commit_in_progress(
    repo: &Repository,
    kind: OperationKind,
    message: Option<&str>,
    signature: git2::Signature<'static>,
) -> Result<String, String> {
    if kind == OperationKind::Merge {
        super::branch::guard_head_unlocked(repo)?;
    }
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    if index.has_conflicts() {
        return Err(format!("{UNRESOLVED_CONFLICTS_PREFIX}resolve the conflicts first"));
    }
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let extra_parents = match kind {
        OperationKind::Merge => merge_heads(repo),
        _ => vec![],
    };

    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;
    let head_commit = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    let mut parents = vec![head_commit];
    for oid in extra_parents {
        parents.push(repo.find_commit(oid).map_err(|e| e.message().to_string())?);
    }
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    let author = match kind {
        OperationKind::CherryPick => operation_commit(repo, kind)
            .map(|c| c.author().to_owned())
            .unwrap_or_else(|| signature.clone()),
        _ => signature.clone(),
    };
    let text = message
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| prepared_message(repo))
        .unwrap_or_else(|| "Merge".to_string());

    let oid = repo
        .commit(Some("HEAD"), &author, &signature, &text, &tree, &parent_refs)
        .map_err(|e| e.message().to_string())?;
    repo.cleanup_state().map_err(|e| e.message().to_string())?;
    Ok(oid.to_string())
}

pub fn complete_merge(path: &str, message: &str) -> Result<String, String> {
    let repo = open(path)?;
    // The lock is checked in `commit_in_progress`. Aborting stays available, so a merge locked
    // mid-flight still has a way out.
    if repo.state() != RepositoryState::Merge {
        return Err("no merge in progress".to_string());
    }
    // Hooks or signing: `git commit` concludes the merge instead — see `features.rs`.
    if super::features::detect_repo(&repo)?.commits_via_cli() {
        return super::features::commit_via_cli(path, Some(message), super::features::CliCommit::New, None);
    }
    let sig = repo_signature(&repo)?;
    commit_in_progress(&repo, OperationKind::Merge, Some(message), sig)
}

/// "Continue" on the conflicts banner, for the operations this module finishes itself: commits the
/// resolution of a merge, revert or cherry-pick with `message` (or the prepared one).
pub fn continue_operation(path: &str, message: Option<&str>) -> Result<String, String> {
    let repo = open(path)?;
    let state = repo.state();
    let kind = OperationKind::of(state).ok_or("nothing is in progress")?;
    if is_sequenced(state) {
        return Err(format!("{} is run by git itself — continue it from the git CLI", kind.as_str()));
    }
    // The operation's commit is a commit like any other: with hooks or signing it is `git commit`,
    // which finishes a merge, revert or cherry-pick itself (parents, the picked commit's author,
    // the state files). `None` keeps the message git prepared.
    if super::features::detect_repo(&repo)?.commits_via_cli() {
        return super::features::commit_via_cli(path, message, super::features::CliCommit::New, None);
    }
    let sig = repo_signature(&repo)?;
    commit_in_progress(&repo, kind, message, sig)
}

/// Every path an in-progress merge, revert or cherry-pick could have written — the set an abort is
/// allowed to touch, and nothing outside it.
///
/// The operation's own change bounds it: a merge only ever writes paths where the incoming commit's
/// tree differs from HEAD's, and a revert or cherry-pick only paths the replayed commit changed. Of
/// those, only the ones that now differ between HEAD and the index were actually written (the
/// operation stages what it applies), plus every conflicted path. An edit the user made to some
/// unrelated file — before the operation, or while resolving it — is in none of those sets, and is
/// left exactly as it is. That is `git merge --abort`'s promise, which the old abort broke: it
/// force-checked-out the whole of HEAD and took every uncommitted change in the repository with it.
///
/// When the operation's commit cannot be read back, the scope falls back to everything staged —
/// still never an unstaged edit.
fn touched_paths(repo: &Repository, kind: OperationKind, head_tree: &Tree) -> Result<BTreeSet<String>, String> {
    let index = repo.index().map_err(|e| e.message().to_string())?;
    let mut touched: BTreeSet<String> = conflict_paths(&index)?.into_iter().collect();

    let scope: Option<HashSet<String>> = match kind {
        OperationKind::Merge => {
            let mut scope = HashSet::new();
            for oid in merge_heads(repo) {
                let Ok(tree) = repo.find_commit(oid).and_then(|c| c.tree()) else { continue };
                collect_diff_paths(repo, Some(head_tree), Some(&tree), &mut scope)?;
            }
            (!scope.is_empty()).then_some(scope)
        }
        OperationKind::Revert | OperationKind::CherryPick => match operation_commit(repo, kind) {
            Some(commit) => {
                let tree = commit.tree().map_err(|e| e.message().to_string())?;
                let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
                let mut scope = HashSet::new();
                collect_diff_paths(repo, parent_tree.as_ref(), Some(&tree), &mut scope)?;
                Some(scope)
            }
            None => None,
        },
        OperationKind::Rebase => None,
    };

    let staged = repo
        .diff_tree_to_index(Some(head_tree), Some(&index), None)
        .map_err(|e| e.message().to_string())?;
    for delta in staged.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            let Some(bytes) = file.path_bytes() else { continue };
            let path = String::from_utf8_lossy(bytes).into_owned();
            if scope.as_ref().map_or(true, |s| s.contains(&path)) {
                touched.insert(path);
            }
        }
    }
    Ok(touched)
}

fn collect_diff_paths(
    repo: &Repository,
    old: Option<&Tree>,
    new: Option<&Tree>,
    into: &mut HashSet<String>,
) -> Result<(), String> {
    let diff = repo.diff_tree_to_tree(old, new, None).map_err(|e| e.message().to_string())?;
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(bytes) = file.path_bytes() {
                into.insert(String::from_utf8_lossy(bytes).into_owned());
            }
        }
    }
    Ok(())
}

/// Characters a checkout pathspec reads as a pattern. A path holding one is restored by writing its
/// blob directly, because `report[1].txt` as a pathspec also matches `report1.txt` — and a forced
/// checkout of *that* would overwrite a file the abort has no business touching.
fn has_glob(path: &str) -> bool {
    path.contains(['*', '?', '[', ']', '\\'])
}

/// Puts one path back to HEAD in the index and on disk, whatever state it is in: conflicted, staged,
/// edited, added by the operation (removed again) or deleted by it (brought back).
fn restore_path(repo: &Repository, head_tree: &Tree, workdir: &Path, path: &str) -> Result<(), String> {
    let rel = Path::new(path);
    let entry = head_tree.get_path(rel).ok();

    // The index first: every stage of the path goes (a conflict is three entries), and HEAD's entry
    // comes back if HEAD has one. Zeroed stat data only means git re-hashes the file once.
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index.remove_path(rel).map_err(|e| format!("{path}: {}", e.message()))?;
    if let Some(entry) = &entry {
        index
            .add(&git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: entry.filemode() as u32,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: entry.id(),
                flags: 0,
                flags_extended: 0,
                path: path.as_bytes().to_vec(),
            })
            .map_err(|e| format!("{path}: {}", e.message()))?;
    }
    index.write().map_err(|e| e.message().to_string())?;

    let full = workdir.join(rel);
    match entry {
        Some(_) if !has_glob(path) => {
            // One path per checkout — see the note in `diff::discard_all_changes` on why a batch of
            // paths makes libgit2 walk into `node_modules` on Windows.
            let mut cb = CheckoutBuilder::new();
            cb.force().path(path);
            repo.checkout_tree(head_tree.as_object(), Some(&mut cb))
                .map_err(|e| format!("{path}: {}", e.message()))?;
        }
        Some(entry) => {
            let blob = repo.find_blob(entry.id()).map_err(|e| format!("{path}: {}", e.message()))?;
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
            }
            std::fs::write(&full, blob.content()).map_err(|e| format!("{path}: {e}"))?;
        }
        None => {
            // Not in HEAD: the operation created it, so it goes — along with any folder it leaves
            // empty, which git would not have recorded either.
            match std::fs::remove_file(&full) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{path}: {e}")),
            }
            let mut parent = full.parent().map(|p| p.to_path_buf());
            while let Some(dir) = parent {
                if dir == workdir || std::fs::remove_dir(&dir).is_err() {
                    break;
                }
                parent = dir.parent().map(|p| p.to_path_buf());
            }
        }
    }
    Ok(())
}

/// Undoes a single-step merge, revert or cherry-pick: every path it touched goes back to HEAD, its
/// state files are removed, and nothing else in the working tree is looked at — see
/// [`touched_paths`]. Sequenced operations are refused here; they abort through the git CLI.
pub fn abort_operation(path: &str) -> Result<(), String> {
    let repo = open(path)?;
    let state = repo.state();
    let Some(kind) = OperationKind::of(state) else {
        return Err("nothing is in progress".to_string());
    };
    if is_sequenced(state) {
        return Err(format!("{} is run by git itself — abort it from the git CLI", kind.as_str()));
    }
    let workdir = repo.workdir().ok_or("bare repository")?.to_path_buf();
    let head_commit = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    let head_tree = head_commit.tree().map_err(|e| e.message().to_string())?;
    let paths = touched_paths(&repo, kind, &head_tree)?;
    for rel in &paths {
        restore_path(&repo, &head_tree, &workdir, rel)?;
    }
    repo.cleanup_state().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn abort_merge(path: &str) -> Result<(), String> {
    abort_operation(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A repository on its default branch with `a.txt` and `b.txt` committed, plus a `feature`
    /// branch whose one commit rewrites `a.txt`. HEAD stays on the default branch, so merging
    /// `feature` is a fast-forward.
    fn fixture() -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("cf-merge-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@example.com").unwrap();
            config.set_bool("core.autocrlf", false).unwrap();
        }
        commit_files(&repo, &[("a.txt", "one\n"), ("b.txt", "bee\n")], "initial");
        let base = repo.head().unwrap().shorthand().unwrap().to_string();
        let path = dir.to_str().unwrap();
        super::super::branch::create_branch(path, "feature", None).unwrap();
        super::super::branch::checkout_local_branch(path, "feature").unwrap();
        commit_files(&repo, &[("a.txt", "feature\n")], "feature edit");
        super::super::branch::checkout_local_branch(path, &base).unwrap();
        (dir, base)
    }

    /// Writes the files, stages them and commits on HEAD.
    fn commit_files(repo: &Repository, files: &[(&str, &str)], message: &str) -> Oid {
        let workdir = repo.workdir().unwrap().to_path_buf();
        let mut index = repo.index().unwrap();
        for (name, content) in files {
            let full = workdir.join(name);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, content).unwrap();
            index.add_path(Path::new(name)).unwrap();
        }
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents).unwrap()
    }

    fn head_oid(path: &str) -> Oid {
        Repository::open(path).unwrap().head().unwrap().target().unwrap()
    }

    fn read(dir: &Path, name: &str) -> String {
        fs::read_to_string(dir.join(name)).unwrap()
    }

    /// Makes the two branches diverge: the default branch gets a commit of its own on `c.txt`, so
    /// merging `feature` needs a real merge commit rather than a fast-forward.
    fn diverge(dir: &Path) {
        let repo = Repository::open(dir).unwrap();
        commit_files(&repo, &[("c.txt", "sea\n")], "base moves on");
    }

    /// The P0 this module was rewritten for: a fast-forward used to force-checkout the new HEAD and
    /// revert every uncommitted edit. An edit to a file the fast-forward does not touch has to
    /// survive it — staged or not.
    #[test]
    fn fast_forward_keeps_an_unrelated_dirty_file() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        fs::write(dir.join("b.txt"), "local edit\n").unwrap();
        fs::write(dir.join("d.txt"), "staged new file\n").unwrap();
        {
            let repo = Repository::open(&dir).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("d.txt")).unwrap();
            index.write().unwrap();
        }
        let feature_tip = Repository::open(&dir)
            .unwrap()
            .find_branch("feature", BranchType::Local)
            .unwrap()
            .get()
            .target()
            .unwrap();

        let outcome = merge_branch(path, "feature").unwrap();

        assert_eq!(outcome.status, "fast_forward");
        assert_eq!(head_oid(path), feature_tip, "the branch moved");
        assert_eq!(read(&dir, "a.txt"), "feature\n", "the fast-forward's own change is on disk");
        assert_eq!(read(&dir, "b.txt"), "local edit\n", "the unrelated edit survived");
        let status = super::super::repo::get_status(path).unwrap();
        assert!(status.unstaged.iter().any(|e| e.path == "b.txt"), "and is still an unstaged change");
        assert!(status.staged.iter().any(|e| e.path == "d.txt"), "a staged file stays staged");
        assert!(!status.staged.iter().any(|e| e.path == "a.txt"), "nothing of the merge is left staged");

        fs::remove_dir_all(&dir).ok();
    }

    /// An edit to a file the fast-forward *does* change is refused — and the refusal changes
    /// nothing at all: not the file, not the branch.
    #[test]
    fn fast_forward_refuses_a_conflicting_dirty_file_and_changes_nothing() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        let before = head_oid(path);
        fs::write(dir.join("a.txt"), "precious uncommitted work\n").unwrap();

        let err = merge_branch(path, "feature").unwrap_err();

        assert!(err.starts_with(MERGE_BLOCKED_PREFIX), "tagged for the UI: {err}");
        assert!(err.contains("a.txt"), "names the file in the way: {err}");
        assert_eq!(read(&dir, "a.txt"), "precious uncommitted work\n", "the edit is untouched");
        assert_eq!(head_oid(path), before, "the branch did not move");
        assert_eq!(Repository::open(&dir).unwrap().state(), RepositoryState::Clean);

        fs::remove_dir_all(&dir).ok();
    }

    /// An untracked file sitting where the fast-forward would write one is work too.
    #[test]
    fn fast_forward_refuses_to_overwrite_an_untracked_file() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, base) = fixture();
        let path = dir.to_str().unwrap();
        {
            let repo = Repository::open(&dir).unwrap();
            super::super::branch::checkout_local_branch(path, "feature").unwrap();
            commit_files(&repo, &[("new.txt", "from feature\n")], "add new");
            super::super::branch::checkout_local_branch(path, &base).unwrap();
        }
        fs::write(dir.join("new.txt"), "mine, untracked\n").unwrap();
        let before = head_oid(path);

        let err = merge_branch(path, "feature").unwrap_err();

        assert!(err.starts_with(MERGE_BLOCKED_PREFIX), "unexpected error: {err}");
        assert_eq!(read(&dir, "new.txt"), "mine, untracked\n");
        assert_eq!(head_oid(path), before);

        fs::remove_dir_all(&dir).ok();
    }

    /// git refuses a real merge while anything is staged, because the merge commit is written from
    /// the index. libgit2 did not, and the staged change landed inside "Merge branch …".
    #[test]
    fn a_normal_merge_refuses_staged_changes() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        diverge(&dir);
        let before = head_oid(path);
        fs::write(dir.join("b.txt"), "staged edit\n").unwrap();
        {
            let repo = Repository::open(&dir).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("b.txt")).unwrap();
            index.write().unwrap();
        }

        let err = merge_branch(path, "feature").unwrap_err();

        assert!(err.starts_with(MERGE_STAGED_PREFIX), "unexpected error: {err}");
        assert!(err.contains("b.txt"), "names what is staged: {err}");
        assert_eq!(head_oid(path), before, "no merge commit");
        let repo = Repository::open(&dir).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean, "no MERGE_HEAD left behind");
        assert_eq!(read(&dir, "a.txt"), "one\n", "the merge wrote nothing");
        let status = super::super::repo::get_status(path).unwrap();
        assert!(status.staged.iter().any(|e| e.path == "b.txt"), "the staged change is still staged");

        fs::remove_dir_all(&dir).ok();
    }

    /// Unstaged edits to files the merge does not touch are allowed, and stay out of the commit.
    #[test]
    fn a_normal_merge_keeps_an_unrelated_unstaged_edit_out_of_the_commit() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        diverge(&dir);
        fs::write(dir.join("b.txt"), "local edit\n").unwrap();

        let outcome = merge_branch(path, "feature").unwrap();

        assert_eq!(outcome.status, "merged");
        assert_eq!(read(&dir, "a.txt"), "feature\n");
        assert_eq!(read(&dir, "b.txt"), "local edit\n");
        let repo = Repository::open(&dir).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        let committed = head.tree().unwrap().get_path(Path::new("b.txt")).unwrap().id();
        assert_eq!(repo.find_blob(committed).unwrap().content(), b"bee\n", "the edit is not in the merge");

        fs::remove_dir_all(&dir).ok();
    }

    /// Makes `a.txt` conflict: the default branch rewrites it too, differently from `feature`.
    fn conflicting_merge(dir: &Path) -> Oid {
        let repo = Repository::open(dir).unwrap();
        commit_files(&repo, &[("a.txt", "ours\n")], "ours edit")
    }

    /// The abort half of the P0: it used to force-checkout the whole of HEAD, which also wiped every
    /// uncommitted change that had nothing to do with the merge. Now only the merge's own paths go
    /// back.
    #[test]
    fn aborting_a_merge_keeps_pre_existing_unrelated_modifications() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        let before = conflicting_merge(&dir);
        fs::write(dir.join("b.txt"), "unrelated local edit\n").unwrap();

        let outcome = merge_branch(path, "feature").unwrap();
        assert_eq!(outcome.status, "conflicts");
        assert_eq!(outcome.conflicts, vec!["a.txt".to_string()]);
        let state = operation_state(path).unwrap();
        assert_eq!(state.kind, Some(OperationKind::Merge));
        assert!(!state.sequenced);
        assert_eq!(state.conflicts, vec!["a.txt".to_string()]);
        assert!(state.message.as_deref().unwrap_or("").starts_with("Merge branch"), "{state:?}");
        assert!(!state.message.unwrap().contains('#'), "comment lines are dropped");

        abort_merge(path).unwrap();

        assert_eq!(read(&dir, "a.txt"), "ours\n", "the conflicted file is back to HEAD");
        assert_eq!(read(&dir, "b.txt"), "unrelated local edit\n", "the unrelated edit survived");
        assert_eq!(head_oid(path), before);
        let repo = Repository::open(&dir).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean, "MERGE_HEAD is gone");
        assert!(!repo.index().unwrap().has_conflicts());
        let status = super::super::repo::get_status(path).unwrap();
        assert!(status.staged.is_empty(), "nothing of the merge is left staged");
        assert!(status.unstaged.iter().any(|e| e.path == "b.txt"));

        fs::remove_dir_all(&dir).ok();
    }

    /// A file the merge *added* is removed again on abort, and one it deleted comes back.
    #[test]
    fn aborting_a_merge_removes_what_it_added_and_restores_what_it_deleted() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, base) = fixture();
        let path = dir.to_str().unwrap();
        {
            let repo = Repository::open(&dir).unwrap();
            super::super::branch::checkout_local_branch(path, "feature").unwrap();
            commit_files(&repo, &[("added/by/feature.txt", "new\n")], "add a file");
            let mut index = repo.index().unwrap();
            index.remove_path(Path::new("b.txt")).unwrap();
            index.write().unwrap();
            fs::remove_file(dir.join("b.txt")).unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = repo.signature().unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "delete b", &tree, &[&parent]).unwrap();
            super::super::branch::checkout_local_branch(path, &base).unwrap();
        }
        conflicting_merge(&dir);

        assert_eq!(merge_branch(path, "feature").unwrap().status, "conflicts");
        assert!(dir.join("added/by/feature.txt").exists());
        assert!(!dir.join("b.txt").exists());

        abort_merge(path).unwrap();

        assert!(!dir.join("added/by/feature.txt").exists(), "the merge's new file is gone");
        assert!(!dir.join("added").exists(), "and the folders it made for it");
        assert_eq!(read(&dir, "b.txt"), "bee\n", "the deleted file is back");
        assert_eq!(read(&dir, "a.txt"), "ours\n");

        fs::remove_dir_all(&dir).ok();
    }

    /// Continue commits the resolution with the prepared message and both parents.
    #[test]
    fn continuing_a_merge_commits_with_both_parents() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        let ours = conflicting_merge(&dir);
        merge_branch(path, "feature").unwrap();

        let err = continue_operation(path, None).unwrap_err();
        assert!(err.starts_with(UNRESOLVED_CONFLICTS_PREFIX), "refused while conflicted: {err}");

        resolve_conflict_side(path, "a.txt", "theirs").unwrap();
        continue_operation(path, None).unwrap();

        let repo = Repository::open(&dir).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(head.parent_id(0).unwrap(), ours);
        assert!(head.message().unwrap().starts_with("Merge branch"));
        assert_eq!(read(&dir, "a.txt"), "feature\n");

        fs::remove_dir_all(&dir).ok();
    }

    /// A second merge on top of one in progress is refused rather than tangled into it.
    #[test]
    fn a_merge_is_refused_while_another_is_in_progress() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        conflicting_merge(&dir);
        merge_branch(path, "feature").unwrap();

        let err = merge_branch(path, "feature").unwrap_err();
        assert!(err.starts_with(OPERATION_IN_PROGRESS_PREFIX), "unexpected error: {err}");

        fs::remove_dir_all(&dir).ok();
    }

    /// Conflicts are reported even with no operation in progress — a conflicted `stash pop` leaves
    /// exactly that behind.
    #[test]
    fn conflicts_are_reported_without_an_operation() {
        let _pinned = super::super::lock_rules::pin_for_test(&[]);
        let (dir, _base) = fixture();
        let path = dir.to_str().unwrap();
        {
            let repo = Repository::open(&dir).unwrap();
            let blob = repo.blob(b"x\n").unwrap();
            let mut index = repo.index().unwrap();
            index.remove(Path::new("b.txt"), 0).unwrap();
            for stage in 1..=3u16 {
                index
                    .add(&git2::IndexEntry {
                        ctime: git2::IndexTime::new(0, 0),
                        mtime: git2::IndexTime::new(0, 0),
                        dev: 0,
                        ino: 0,
                        mode: 0o100644,
                        uid: 0,
                        gid: 0,
                        file_size: 0,
                        id: blob,
                        flags: stage << 12,
                        flags_extended: 0,
                        path: b"b.txt".to_vec(),
                    })
                    .unwrap();
            }
            index.write().unwrap();
        }

        let state = operation_state(path).unwrap();
        assert_eq!(state.kind, None);
        assert_eq!(state.conflicts, vec!["b.txt".to_string()]);
        assert_eq!(state.message, None);

        fs::remove_dir_all(&dir).ok();
    }
}
