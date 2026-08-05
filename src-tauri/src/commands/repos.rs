use std::path::Path;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::{models::*, queries, Db};
use crate::paths;

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
}

/// What a picked folder turned out to be.
#[derive(serde::Serialize)]
pub struct FolderScan {
    /// The folder is itself a repository — add it and nothing else.
    pub is_repo: bool,
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
        return Ok(FolderScan { is_repo: true, repos: Vec::new(), empty: false, truncated: false });
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
        repos.push(FoundRepo { name: name.to_string(), path: child.to_string_lossy().to_string() });
    }
    repos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(FolderScan { is_repo: false, repos, empty: seen == 0, truncated })
}

/// Where a "Clone repository" flow should default to: `C:\CodeFlow\repos\<name>` on
/// Windows (same root as the rest of the app's persisted state), OS app-data equivalent
/// elsewhere. The frontend appends the repo name itself.
#[tauri::command]
pub fn default_clone_dir() -> String {
    paths::clone_root().to_string_lossy().to_string()
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

#[tauri::command]
pub fn create_project(db: State<Db>, input: NewProject) -> Result<Project, String> {
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

    #[test]
    fn a_path_that_is_not_a_folder_is_an_error_rather_than_an_empty_answer() {
        let temp = Temp::new();
        let file = temp.0.join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(scan_folder(file.to_string_lossy().to_string()).is_err());
        assert!(scan_folder(temp.0.join("nope").to_string_lossy().to_string()).is_err());
    }
}
