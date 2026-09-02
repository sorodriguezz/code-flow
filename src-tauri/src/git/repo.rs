use git2::{Config, ObjectType, ResetType, Repository, StatusOptions};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatusEntry {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoStatusInfo {
    pub staged: Vec<FileStatusEntry>,
    pub unstaged: Vec<FileStatusEntry>,
    pub untracked: Vec<FileStatusEntry>,
    pub conflicted: Vec<FileStatusEntry>,
    pub current_branch: Option<String>,
    pub is_detached: bool,
    /// The commit HEAD points at, branch or not. The UI can't derive this from the branch list
    /// once HEAD is detached — no branch is head then — so it's reported here instead.
    pub head_oid: Option<String>,
}

pub fn open(path: &str) -> Result<Repository, String> {
    Repository::open(path).map_err(|e| e.message().to_string())
}

/// The branch HEAD points at when HEAD cannot be resolved — i.e. before the first commit.
///
/// Until something is committed the branch is a line in `.git/HEAD` and nothing else: no
/// `refs/heads/<name>` exists yet, which is both why `repo.head()` fails and why `repo.branches()`
/// has nothing to yield for it. The symbolic target carries the name regardless, and it is the same
/// one `git status` reports as "On branch <name>".
///
/// `None` for a detached HEAD, which has no symbolic target, and for a HEAD pointing somewhere
/// other than `refs/heads/`. Callers should only reach for this once `repo.head()` has failed —
/// on a normal repository it answers the same thing the head reference already would, more slowly.
pub fn unborn_head_branch(repo: &Repository) -> Option<String> {
    repo.find_reference("HEAD")
        .ok()
        .and_then(|head| head.symbolic_target().map(|target| target.to_string()))
        .and_then(|target| target.strip_prefix("refs/heads/").map(|name| name.to_string()))
}

fn status_label(status: git2::Status) -> Option<(&'static str, &'static str)> {
    // returns (bucket, label) where bucket is one of staged/unstaged/untracked/conflicted
    if status.is_conflicted() {
        return Some(("conflicted", "conflicted"));
    }
    if status.is_index_new() {
        return Some(("staged", "added"));
    }
    if status.is_index_modified() {
        return Some(("staged", "modified"));
    }
    if status.is_index_deleted() {
        return Some(("staged", "deleted"));
    }
    if status.is_index_renamed() {
        return Some(("staged", "renamed"));
    }
    if status.is_index_typechange() {
        return Some(("staged", "typechange"));
    }
    if status.is_wt_new() {
        return Some(("untracked", "untracked"));
    }
    if status.is_wt_modified() {
        return Some(("unstaged", "modified"));
    }
    if status.is_wt_deleted() {
        return Some(("unstaged", "deleted"));
    }
    if status.is_wt_renamed() {
        return Some(("unstaged", "renamed"));
    }
    if status.is_wt_typechange() {
        return Some(("unstaged", "typechange"));
    }
    None
}

pub fn get_status(path: &str) -> Result<RepoStatusInfo, String> {
    let repo = open(path)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.message().to_string())?;

    let mut info = RepoStatusInfo {
        staged: vec![],
        unstaged: vec![],
        untracked: vec![],
        conflicted: vec![],
        current_branch: None,
        is_detached: repo.head_detached().unwrap_or(false),
        head_oid: None,
    };

    for entry in statuses.iter() {
        let Some(file_path) = entry.path() else { continue };
        let Some((bucket, label)) = status_label(entry.status()) else { continue };
        let item = FileStatusEntry {
            path: file_path.to_string(),
            status: label.to_string(),
        };
        match bucket {
            "staged" => info.staged.push(item),
            "unstaged" => info.unstaged.push(item),
            "untracked" => info.untracked.push(item),
            "conflicted" => info.conflicted.push(item),
            _ => {}
        }
    }

    if let Ok(head) = repo.head() {
        if head.is_branch() {
            info.current_branch = head.shorthand().map(|s| s.to_string());
        }
        info.head_oid = head.peel_to_commit().ok().map(|c| c.id().to_string());
    } else {
        // An unborn HEAD: `git init` has run and the first commit hasn't. `repo.head()` can't
        // resolve it because `refs/heads/<name>` doesn't exist yet — until something is committed
        // the branch lives only as a line in `.git/HEAD`, which is also why `list_branches` has
        // nothing to return for it and why `git branch` prints it nowhere.
        //
        // Reading HEAD's symbolic target recovers the name anyway, and it is the same one
        // `git status` reports as "On branch <name>". Worth recovering rather than leaving the
        // status bar on a dash: a repository with no commits is exactly when someone checks that
        // bar to see whether the first commit is about to land on `main` or on `master`.
        //
        // `head_oid` stays `None`, correctly — there is no commit to point at yet.
        info.current_branch = unborn_head_branch(&repo);
    }

    Ok(info)
}

/// Moves HEAD (and the current branch) to `target_oid`. "mixed" (the safe default for an
/// "undo commit" action) unstages but keeps working-tree content; "soft" keeps the diff
/// staged; "hard" discards it entirely — callers should get explicit confirmation for that one.
pub fn reset_to_commit(path: &str, target_oid: &str, mode: &str) -> Result<(), String> {
    let repo = open(path)?;
    let oid = git2::Oid::from_str(target_oid).map_err(|e| e.message().to_string())?;
    let object = repo.find_object(oid, Some(ObjectType::Commit)).map_err(|e| e.message().to_string())?;

    let reset_type = match mode {
        "soft" => ResetType::Soft,
        "hard" => ResetType::Hard,
        _ => ResetType::Mixed,
    };

    repo.reset(&object, reset_type, None).map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Turns a plain folder back into a git repository.
///
/// The one repair on offer for a project whose `.git` was deleted from outside the app — see
/// `commands::repos::project_path_health`, which is what finds them. The alternative the UI
/// offers beside it is removing the project from the list, and between them they replace the old
/// behaviour: a row that still looked openable, pointed the git engine at nothing, and answered
/// every refresh with "could not find repository".
///
/// **Refuses a folder that is already a repository.** `git init` on one is documented as harmless
/// — it reinitialises and keeps the objects — but this is reached from a button labelled "create a
/// repository here", and running it against a live checkout on a mistaken verdict is not a risk
/// worth the convenience. The check is the same `.git` test `is_repo_root` makes, with `exists`
/// rather than `is_dir` so a worktree or submodule (whose `.git` is a file holding a `gitdir:`
/// pointer) counts as one.
///
/// **The initial branch is whatever the user's git would have used.** libgit2 hardcodes `master`
/// when nothing says otherwise, while git itself has honoured `init.defaultBranch` since 2.28 —
/// so a repository initialised here would be on a different branch than the same folder
/// initialised from the terminal, which is exactly the sort of difference that gets discovered
/// during a push. Read from the default config chain (system, global, per-user), so it picks up
/// `git config --global init.defaultBranch main`.
///
/// Nothing is committed and nothing is staged: this only creates `.git`. What was in the folder
/// stays exactly where it is, and shows up as untracked on the next status — which is what the
/// user is about to look at.
pub fn init(path: &str) -> Result<(), String> {
    let root = std::path::Path::new(path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    if root.join(".git").exists() {
        return Err(format!("{path} is already a git repository"));
    }

    let mut options = git2::RepositoryInitOptions::new();
    // `Config::open_default` failing is not a reason to refuse: it means this machine has no git
    // config at all, and the answer to "what would git have done" is then its own default.
    if let Some(branch) = Config::open_default()
        .ok()
        .and_then(|config| config.get_string("init.defaultBranch").ok())
        .filter(|branch| !branch.trim().is_empty())
    {
        options.initial_head(branch.trim());
    }
    // Off, and it is the difference between initialising *this* folder and adopting an enclosing
    // one: with `no_reinit` unset libgit2 will happily return the repository it finds by walking
    // up, so a folder inside a checkout would silently "become" that checkout.
    options.no_reinit(true);
    Repository::init_opts(root, &options).map_err(|e| e.message().to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A repository whose first commit hasn't happened yet still knows which branch it is on.
    ///
    /// `repo.head()` cannot resolve an unborn HEAD, and reading that as "no branch" left the status
    /// bar showing a dash for the whole of a new project's life — right up until the first commit,
    /// which is the stretch where "am I on `main` or `master`?" is worth answering.
    #[test]
    fn a_repository_with_no_commits_still_names_its_branch() {
        let dir = std::env::temp_dir().join(format!("cf-repo-unborn-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        // Whatever `init.defaultBranch` this machine has, pin the one the assertion names.
        repo.set_head("refs/heads/master").unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();

        let status = get_status(dir.to_str().unwrap()).unwrap();
        assert_eq!(status.current_branch.as_deref(), Some("master"));
        // No commit to point at, and not detached — HEAD is symbolic, it just points at nothing.
        assert_eq!(status.head_oid, None);
        assert!(!status.is_detached);
        // The file is still seen, which is what says the rest of the status survived the branch.
        assert_eq!(status.untracked.len(), 1);

        fs::remove_dir_all(&dir).ok();
    }

    /// The repair for a project whose `.git` was deleted: the folder is a repository again, and
    /// everything that was in it is still in it — untracked, because nothing was committed.
    #[test]
    fn init_makes_a_plain_folder_a_repository_without_touching_its_contents() {
        let dir = std::env::temp_dir().join(format!("cf-repo-init-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("keep.txt"), "mine\n").unwrap();

        init(dir.to_str().unwrap()).unwrap();

        assert!(dir.join(".git").exists(), "the folder is a repository now");
        assert_eq!(fs::read_to_string(dir.join("keep.txt")).unwrap(), "mine\n");
        let status = get_status(dir.to_str().unwrap()).unwrap();
        assert_eq!(status.untracked.len(), 1, "the file is there, and uncommitted");
        assert!(status.staged.is_empty(), "init stages nothing");

        fs::remove_dir_all(&dir).ok();
    }

    /// The guard that keeps the repair button off a live checkout. `git init` on an existing
    /// repository is harmless in git's own terms, but this is reached from a verdict about the
    /// folder, and a wrong verdict must fail loudly rather than reinitialise someone's work.
    #[test]
    fn init_refuses_a_folder_that_is_already_a_repository() {
        let dir = std::env::temp_dir().join(format!("cf-repo-reinit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();

        assert!(init(dir.to_str().unwrap()).is_err());

        fs::remove_dir_all(&dir).ok();
    }

    /// A folder that is not there is not something to initialise — the project row for one of
    /// those offers removal and nothing else, and this is the backstop for the race where the
    /// folder disappears between the verdict and the click.
    #[test]
    fn init_refuses_a_folder_that_is_not_there() {
        let dir = std::env::temp_dir().join(format!("cf-repo-gone-{}", uuid::Uuid::new_v4()));
        assert!(init(dir.to_str().unwrap()).is_err());
    }
}
