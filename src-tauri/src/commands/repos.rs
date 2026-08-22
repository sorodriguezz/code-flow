use std::path::Path;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::{models::*, queries, Db};
use crate::paths;
use crate::repo_identity::{primary_remote, DuplicateReason, RepoIdentity};

/// Non-async `#[tauri::command]`s run on the main thread, and `blocking_pick_folder`
/// parks the calling thread on a rendezvous channel until the picker answers — but on
/// macOS the picker itself needs the main thread to show up and pump events, so the two
/// deadlock and the whole app hangs ("no responde"). Use the callback API and await the
/// result instead, which keeps the main thread free.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()));
        });
    rx.await.ok().flatten()
}

/// One git repository found inside a picked folder.
#[derive(serde::Serialize)]
pub struct FoundRepo {
    /// The directory's own name, which is what the project gets called.
    pub name: String,
    pub path: String,
    /// Its `origin`, or its first remote when there is no `origin` — see
    /// [`crate::repo_identity::primary_remote`]. Read here rather than left for the import to look
    /// up later: it is what says whether this repository is one the workspace already holds at
    /// some other path, and it is nearly free while the folder is being walked anyway. `None` for
    /// a repository with no remote configured.
    pub remote_url: Option<String>,
}

/// What a picked folder turned out to be.
#[derive(serde::Serialize)]
pub struct FolderScan {
    /// The folder is itself a repository — add it and nothing else.
    pub is_repo: bool,
    /// The picked folder's own remote, when [`Self::is_repo`]. The repositories *inside* a folder
    /// carry theirs on [`FoundRepo`]; this is the same thing for the folder that is one itself, so
    /// that a single picked repository can be checked for being one the workspace already holds.
    pub remote_url: Option<String>,
    /// Repositories sitting directly inside it. Only ever one level down; see [`scan_folder`].
    pub repos: Vec<FoundRepo>,
    /// The folder has nothing in it at all, which is worth saying differently from "nothing here
    /// is a repository".
    pub empty: bool,
    /// The folder had more entries than [`SCAN_LIMIT`] and the rest were not looked at.
    pub truncated: bool,
}

/// How many entries of a picked folder are examined. A guard rather than a real limit: nobody
/// keeps two thousand repositories side by side, and something that size is far more likely to be
/// a home directory or a drive root — which is exactly the pick this scan exists to refuse
/// cheaply, rather than stat its way through.
const SCAN_LIMIT: usize = 2000;

/// Whether this directory is the root of a git repository.
///
/// Deliberately *not* `git rev-parse`: that walks **up** until it finds a repository, so a plain
/// folder inside one answers yes and the app would register a project whose path is a subdirectory
/// — pointing every status, diff and watch at the enclosing repository instead. This is the report
/// that hangs the app: picking `~/repos` under a home directory that happens to be a repo had git
/// walking the entire home directory on every refresh.
///
/// `.git` is checked with `exists` rather than `is_dir` because a worktree or a submodule records
/// it as a *file* holding a `gitdir:` pointer. Both are real repositories to work in.
fn is_repo_root(path: &Path) -> bool {
    path.join(".git").exists()
}

/// Looks at a folder the user picked and reports what can be imported from it.
///
/// Answers three questions in one round trip, because they are one question to the user: is this a
/// repository, does it *contain* repositories, or is it neither? The third is the case that had no
/// answer at all before — a folder that is not a repository was added as a project regardless, and
/// everything downstream (status, diff, the recursive watcher) was then pointed at it.
///
/// **Exactly one level down.** Not a recursive search: a nested scan of a large tree is the same
/// unbounded walk this is here to prevent, and a repository three directories deep is not
/// something the user pointed at — it is something a search found. One level is what "I keep my
/// repos in this folder" means.
#[tauri::command]
pub fn scan_folder(path: String) -> Result<FolderScan, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    if is_repo_root(root) {
        return Ok(FolderScan {
            is_repo: true,
            remote_url: primary_remote(&path),
            repos: Vec::new(),
            empty: false,
            truncated: false,
        });
    }

    let mut repos = Vec::new();
    let mut seen = 0usize;
    let mut truncated = false;
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
        seen += 1;
        if seen > SCAN_LIMIT {
            truncated = true;
            break;
        }
        let child = entry.path();
        // `file_type` rather than `is_dir` on the path: it reads the entry the directory already
        // returned instead of a fresh stat, and it does not follow symlinks — a link pointing back
        // up the tree is how a one-level scan turns into an unbounded one.
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() || !is_repo_root(&child) {
            continue;
        }
        let Some(name) = child.file_name().and_then(|n| n.to_str()) else { continue };
        let child_path = child.to_string_lossy().to_string();
        repos.push(FoundRepo {
            name: name.to_string(),
            remote_url: primary_remote(&child_path),
            path: child_path,
        });
    }
    repos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(FolderScan { is_repo: false, remote_url: None, repos, empty: seen == 0, truncated })
}

/// Where a "Clone repository" flow should default to, and how to append a name to it.
#[derive(serde::Serialize)]
pub struct CloneRoot {
    pub root: String,
    /// `\` or `/`.
    ///
    /// Sent rather than inferred because the frontend used to build the destination as
    /// `${baseDir}/${name}` — a forward slash, unconditionally, onto a root that on Windows was
    /// `C:\CodeFlow\repos`. It happened to work, because Windows accepts either separator in most
    /// places, and it produced a mixed path that then appeared in the modal, in the duplicate
    /// check, and in `projects.local_path` forever after. The alternative to this field is a
    /// platform branch in TSX, which is the thing being removed everywhere else in this change.
    pub separator: String,
}

/// The default clone destination: `<user root>/repos`, unless this install carries a `clone_root`
/// row.
///
/// That row exists for exactly one situation and is written by the layout migration: a Windows
/// machine upgrading from the shared `C:\CodeFlow`, where `C:\CodeFlow\repos` already held clones.
/// Those are working copies that may carry uncommitted work, so they are adopted where they stand
/// rather than moved — see `paths::backups_dir` for why the backup folder gets the opposite
/// treatment.
#[tauri::command]
pub fn default_clone_dir(db: State<Db>) -> CloneRoot {
    let configured = db
        .0
        .lock()
        .ok()
        .and_then(|conn| queries::get_setting(&conn, "clone_root").ok().flatten())
        .filter(|value| !value.trim().is_empty());

    let root = configured.map(std::path::PathBuf::from).unwrap_or_else(paths::clone_root);
    CloneRoot {
        root: root.to_string_lossy().into_owned(),
        separator: std::path::MAIN_SEPARATOR.to_string(),
    }
}

#[tauri::command]
pub fn create_workspace(db: State<Db>, name: String, icon: String, color: String) -> Result<Workspace, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_workspace(&conn, &name, &icon, &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_workspaces(db: State<Db>) -> Result<Vec<Workspace>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspaces(&conn).map_err(|e| e.to_string())
}

/// Writes the order the workspaces are shown in. `ids` is the whole list.
#[tauri::command]
pub fn reorder_workspaces(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::reorder_workspaces(&conn, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_workspace(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_workspace_color(db: State<Db>, id: String, color: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_workspace_color(&conn, &id, &color).map_err(|e| e.to_string())
}

/// Rejects a blank name rather than storing one: the sidebar and the workspace switcher both
/// identify a workspace by its label, and an empty one leaves a row nothing can be told apart by.
#[tauri::command]
pub fn rename_workspace(db: State<Db>, id: String, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Workspace name cannot be empty".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_workspace(&conn, &id, trimmed).map_err(|e| e.to_string())
}

/// One repository about to be added, as the duplicate check needs to see it.
#[derive(serde::Deserialize)]
pub struct RepoCandidate {
    /// Where it is — or, for a clone, where it is *about to be*. A destination that doesn't exist
    /// yet still compares against the paths already registered.
    pub path: String,
    /// The remote it points at, when the caller knows it before the working copy does: a clone has
    /// its URL and nothing on disk, an import has the reverse. Folded in on top of whatever the
    /// folder itself reports.
    pub remote_url: Option<String>,
}

/// The project a workspace already holds that *is* the repository being added.
#[derive(serde::Serialize)]
pub struct DuplicateProject {
    pub id: String,
    pub name: String,
    /// Where the copy already in the workspace lives — the thing worth saying out loud, since the
    /// whole confusion is that it is somewhere other than where the user is adding from.
    pub local_path: String,
    pub reason: DuplicateReason,
}

/// Reads every project of `workspace_id` once, with its identity resolved from disk.
///
/// Separated out because both callers need the same list and it is the expensive half: one git
/// open per project, which is worth doing once per user action and not once per candidate.
fn workspace_identities(db: &State<Db>, workspace_id: &str) -> Result<Vec<(Project, RepoIdentity)>, String> {
    let projects = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::list_projects(&conn, workspace_id).map_err(|e| e.to_string())?
    };
    Ok(projects
        .into_iter()
        .map(|project| {
            let identity = RepoIdentity::read(&project.local_path, project.remote_url.as_deref());
            (project, identity)
        })
        .collect())
}

fn duplicate_of(
    existing: &[(Project, RepoIdentity)],
    candidate: &RepoIdentity,
) -> Option<DuplicateProject> {
    existing.iter().find_map(|(project, other)| {
        candidate.duplicate_of(other).map(|reason| DuplicateProject {
            id: project.id.clone(),
            name: project.name.clone(),
            local_path: project.local_path.clone(),
            reason,
        })
    })
}

/// For each candidate, the project of `workspace_id` that already *is* that repository — `None` at
/// the positions with no match, so the answers line up with what was asked.
///
/// **A workspace holds a repository once.** That has to be decided on the repository's identity
/// rather than on its path: a repository imported from `~/dev/api` and the same one cloned into
/// CodeFlow's own `repos/api` are two folders and one repository, and comparing paths — which is
/// all that was ever compared — called them different. That is how a workspace ended up listing
/// the same repository twice, from two origins. Having it open twice at once is what a *second
/// workspace* is for; see [`crate::repo_identity`].
///
/// Every candidate in one call, because the answer needs each existing project's remotes read off
/// disk: doing that once for a folder of thirty repositories rather than thirty times is the
/// difference between instant and a stall the user can see.
#[tauri::command]
pub fn find_duplicate_projects(
    db: State<Db>,
    workspace_id: String,
    candidates: Vec<RepoCandidate>,
) -> Result<Vec<Option<DuplicateProject>>, String> {
    let existing = workspace_identities(&db, &workspace_id)?;
    Ok(candidates
        .iter()
        .map(|candidate| {
            let identity = RepoIdentity::read(&candidate.path, candidate.remote_url.as_deref());
            duplicate_of(&existing, &identity)
        })
        .collect())
}

/// Registers a repository, refusing one the workspace already holds.
///
/// The refusal is the last gate rather than the first: every caller asks
/// [`find_duplicate_projects`] beforehand, because only the caller can name the repository that is
/// already there and offer somewhere else to put this one. This is what keeps the invariant true
/// when a caller forgets to — including a new one written later.
#[tauri::command]
pub fn create_project(db: State<Db>, input: NewProject) -> Result<Project, String> {
    let existing = workspace_identities(&db, &input.workspace_id)?;
    let identity = RepoIdentity::read(&input.local_path, input.remote_url.as_deref());
    if let Some(duplicate) = duplicate_of(&existing, &identity) {
        return Err(format!(
            "\"{}\" is already in this workspace, at {}. A repository can only be in a workspace once — open it in another workspace if you need a second copy.",
            duplicate.name, duplicate.local_path
        ));
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_project(&conn, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_projects(db: State<Db>, workspace_id: String) -> Result<Vec<Project>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_projects(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Writes the order the repositories are shown in, for one workspace. `ids` is the whole list.
#[tauri::command]
pub fn reorder_projects(db: State<Db>, workspace_id: String, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::reorder_projects(&conn, &workspace_id, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_project(db: State<Db>, id: String) -> Result<Option<Project>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_project(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_project(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_project(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_project_to_workspace(db: State<Db>, id: String, workspace_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::move_project_to_workspace(&conn, &id, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_project_color(db: State<Db>, id: String, color: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_project_color(&conn, &id, &color).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory that cleans itself up, so a failing assertion doesn't leave one behind.
    struct Temp(std::path::PathBuf);

    impl Temp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("cf-scan-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Temp(dir)
        }
        /// A directory that looks like a repository, with `.git` as a directory (the normal case).
        fn repo(&self, name: &str) {
            std::fs::create_dir_all(self.0.join(name).join(".git")).unwrap();
        }
        fn plain(&self, name: &str) {
            std::fs::create_dir_all(self.0.join(name)).unwrap();
        }
        fn scan(&self) -> FolderScan {
            scan_folder(self.0.to_string_lossy().to_string()).unwrap()
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_repository_reports_itself_and_looks_no_further() {
        let temp = Temp::new();
        std::fs::create_dir_all(temp.0.join(".git")).unwrap();
        temp.repo("vendored");

        let scan = temp.scan();
        assert!(scan.is_repo);
        assert!(scan.repos.is_empty(), "a repository's own contents are not candidates");
    }

    /// A worktree or submodule records `.git` as a file holding a `gitdir:` pointer. Still a
    /// repository to work in, and it must not be filtered out as "not a directory".
    #[test]
    fn a_git_file_counts_as_a_repository() {
        let temp = Temp::new();
        std::fs::write(temp.0.join(".git"), "gitdir: /elsewhere/.git/worktrees/x").unwrap();
        assert!(temp.scan().is_repo);
    }

    #[test]
    fn a_folder_of_repositories_lists_them_sorted_and_skips_what_is_not_one() {
        let temp = Temp::new();
        temp.repo("zeta");
        temp.repo("alpha");
        temp.plain("notes");
        std::fs::write(temp.0.join("readme.txt"), "x").unwrap();

        let scan = temp.scan();
        assert!(!scan.is_repo);
        assert!(!scan.empty);
        let names: Vec<&str> = scan.repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["alpha", "zeta"]);
    }

    /// Only one level. A repository buried deeper is not what the user pointed at, and finding it
    /// would mean the recursive walk this whole scan exists to avoid.
    #[test]
    fn a_repository_two_levels_down_is_not_found() {
        let temp = Temp::new();
        temp.plain("group");
        std::fs::create_dir_all(temp.0.join("group").join("deep").join(".git")).unwrap();

        let scan = temp.scan();
        assert!(!scan.is_repo);
        assert!(scan.repos.is_empty());
        assert!(!scan.empty, "there is something in it — just nothing importable");
    }

    /// The two refusals the UI words differently: nothing here at all, versus things here of which
    /// none is a repository.
    #[test]
    fn an_empty_folder_is_told_apart_from_one_with_no_repositories() {
        let empty = Temp::new();
        let scan = empty.scan();
        assert!(scan.empty);
        assert!(scan.repos.is_empty());

        let full = Temp::new();
        full.plain("just-a-folder");
        let scan = full.scan();
        assert!(!scan.empty);
        assert!(scan.repos.is_empty());
    }

    /// The scan carries each repository's remote out with it. Without this an import registers a
    /// project with no remote recorded — the state every imported project used to be in, and the
    /// reason the same repository could be added a second time from another folder without
    /// anything noticing.
    #[test]
    fn a_scan_reports_each_repositorys_origin() {
        let temp = Temp::new();
        let repo = git2::Repository::init(temp.0.join("api")).unwrap();
        repo.remote("origin", "git@github.com:acme/api.git").unwrap();
        // A `.git` that is a directory but not a repository: found, but with nothing to report.
        temp.repo("hollow");

        let scan = temp.scan();
        let api = scan.repos.iter().find(|r| r.name == "api").unwrap();
        assert_eq!(api.remote_url.as_deref(), Some("git@github.com:acme/api.git"));
        let hollow = scan.repos.iter().find(|r| r.name == "hollow").unwrap();
        assert_eq!(hollow.remote_url, None);
    }

    /// A picked folder that *is* a repository never appears in `repos`, so without its own field
    /// the single-repository import would be the one route with no identity to check.
    #[test]
    fn a_picked_repository_reports_its_own_origin() {
        let temp = Temp::new();
        let repo = git2::Repository::init(&temp.0).unwrap();
        repo.remote("origin", "https://github.com/acme/api.git").unwrap();

        let scan = temp.scan();
        assert!(scan.is_repo);
        assert_eq!(scan.remote_url.as_deref(), Some("https://github.com/acme/api.git"));
    }

    #[test]
    fn a_path_that_is_not_a_folder_is_an_error_rather_than_an_empty_answer() {
        let temp = Temp::new();
        let file = temp.0.join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(scan_folder(file.to_string_lossy().to_string()).is_err());
        assert!(scan_folder(temp.0.join("nope").to_string_lossy().to_string()).is_err());
    }
}
