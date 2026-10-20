//! Where an agent is: the folder `cf` ran in, as the checkout, project and workspace it belongs to.
//!
//! Every lookup by path elsewhere in the backend is an exact `projects.local_path = ?` — right for a
//! project's own folder and wrong for nearly everywhere an agent actually works: a subfolder, or a
//! task's worktree under `~/CodeFlow/worktrees/…`, which no project row names. So this asks git: the
//! repository `cwd` is in (searching upward, as git itself does), and — for a linked worktree — the
//! main checkout behind it, which *is* a project. A bench shell outside any repository still has a
//! workspace: its row's.

use tauri::{AppHandle, Manager};

use crate::db::models::Project;

pub struct Place {
    /// The checkout the agent works in: the worktree's root, the project's folder, or `cwd` itself
    /// outside any repository. What the code map reads.
    pub root: String,
    /// The project the checkout belongs to — its own folder, or the main checkout of a worktree.
    pub project: Option<Project>,
    /// The project's workspace, or the bench row's when there is no project.
    pub workspace_id: Option<String>,
}

impl Place {
    /// Where the knowledge index and memories are keyed: the project's own folder, so a worktree
    /// reads the same index as its project rather than indexing a second copy from scratch.
    pub fn knowledge_root(&self) -> &str {
        self.project.as_ref().map_or(self.root.as_str(), |p| p.local_path.as_str())
    }
}

pub fn of(app: &AppHandle, cwd: &str, session: &str) -> Place {
    let repo = git2::Repository::discover(cwd).ok();
    let root = repo
        .as_ref()
        .and_then(|r| r.workdir())
        .map(|p| p.to_string_lossy().trim_end_matches(['/', '\\']).to_string())
        .unwrap_or_else(|| cwd.to_string());
    // A linked worktree's common git folder is the main checkout's `.git`; its parent is the project.
    let main = repo.as_ref().and_then(|r| {
        if r.is_worktree() {
            crate::git::features::common_dir(r).parent().map(|p| p.to_string_lossy().into_owned())
        } else {
            r.workdir().map(|p| p.to_string_lossy().into_owned())
        }
    });

    let projects = crate::ai_usage::with_conn(crate::db::queries::list_all_projects).and_then(Result::ok).unwrap_or_default();
    let project = main
        .as_deref()
        .and_then(|main| find_project(&projects, main, true))
        .or_else(|| find_project(&projects, cwd, false))
        .cloned();
    let workspace_id = project.as_ref().map(|p| p.workspace_id.clone()).or_else(|| bench_workspace(app, session));
    Place { root, project, workspace_id }
}

/// The project whose folder is `path` (`exact`) or holds it — the deepest one, for a project nested
/// in another's folder.
fn find_project<'a>(projects: &'a [Project], path: &str, exact: bool) -> Option<&'a Project> {
    let wanted = crate::repo_identity::canonical_path(path);
    projects
        .iter()
        .filter(|p| !p.local_path.trim().is_empty())
        .map(|p| (p, crate::repo_identity::canonical_path(&p.local_path)))
        .filter(|(_, folder)| *folder == wanted || (!exact && within(&wanted, folder)))
        .max_by_key(|(_, folder)| folder.len())
        .map(|(p, _)| p)
}

/// `path` is `folder` or inside it, by whole segments (`/a/bc` is not inside `/a/b`).
pub fn within(path: &str, folder: &str) -> bool {
    path == folder || path.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'))
}

/// The workspace of the bench terminal running `session`, if it is one.
pub fn bench_workspace(app: &AppHandle, session: &str) -> Option<String> {
    let row = bench_row(app, session)?;
    crate::ai_usage::with_conn(|conn| {
        conn.query_row("SELECT workspace_id FROM workspace_terminals WHERE id = ?1", [row.as_str()], |r| r.get::<_, String>(0)).ok()
    })
    .flatten()
}

/// The bench row (`workspace_terminals.id`) whose shell is `session`.
pub fn bench_row(app: &AppHandle, session: &str) -> Option<String> {
    if session.is_empty() {
        return None;
    }
    let registry = app.state::<crate::terminal::TerminalRegistry>();
    crate::terminal::recorded_state(&registry).into_iter().find(|(_, (id, _))| id == session).map(|(row, _)| row)
}

#[cfg(test)]
mod tests {
    use super::within;

    #[test]
    fn a_folder_holds_its_subfolders_by_whole_segments() {
        assert!(within("/a/b", "/a/b"));
        assert!(within("/a/b/c", "/a/b"));
        assert!(!within("/a/bc", "/a/b"));
        assert!(!within("/a", "/a/b"));
    }
}
