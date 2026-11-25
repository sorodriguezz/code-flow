//! Contenedores › Entornos: one environment per branch — see `crate::containers::envs`.
//!
//! Every command names a repository by its project id and an environment by its id; the paths are
//! read from the database here, never taken from the webview.

use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::containers::engine::{EngineKind, Target};
use crate::containers::envs::{self, plan, store, EnvConfig, EnvRecord, EnvView};
use crate::db::{queries, Db};
use crate::git::branch_worktree;
use crate::repo_env::config;

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// A repository CodeFlow knows, as the create dialog lists them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvRepo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub workspace: String,
}

#[tauri::command]
pub fn containers_envs_repos(db: State<'_, Db>) -> Result<Vec<EnvRepo>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT p.id, p.name, p.local_path, w.name FROM projects p JOIN workspaces w ON w.id = p.workspace_id ORDER BY w.sort_order, w.name, p.name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(EnvRepo { id: r.get(0)?, name: r.get(1)?, path: r.get(2)?, workspace: r.get(3)? }))
        .map_err(|e| e.to_string())?;
    let repos: Vec<EnvRepo> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    Ok(repos.into_iter().filter(|r| Path::new(&r.path).join(".git").exists()).collect())
}

fn project(db: &Db, project_id: &str) -> Result<(String, String), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT name, local_path FROM projects WHERE id = ?1", params![project_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|_| "that repository is not in any workspace any more".to_string())
}

fn record(db: &Db, id: &str) -> Result<EnvRecord, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::get(&conn, id).map_err(|e| e.to_string())?.ok_or_else(|| "that environment is gone".to_string())
}

fn all(db: &Db) -> Result<Vec<EnvRecord>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::list(&conn).map_err(|e| e.to_string())
}

/// The offset for a new environment of `project_id` whose files publish `ports`: past the other
/// environments of that repository, and off every port in use — another environment's or anything
/// listening on this computer.
fn suggest(envs: &[EnvRecord], project_id: &str, ports: &[u16]) -> u16 {
    let taken: Vec<u16> = envs.iter().filter(|e| e.project_id == project_id).map(|e| e.port_offset).collect();
    let used: Vec<u16> = envs.iter().flat_map(|e| e.ports.iter().filter_map(|p| p.host)).collect();
    plan::suggest_offset(ports, &taken, |port| used.contains(&port) || !envs::port_free(port)).unwrap_or(plan::OFFSET_STEP)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredProposal {
    #[serde(flatten)]
    pub proposal: envs::Proposal,
    pub suggested_offset: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub repo_name: String,
    pub repo_path: String,
    pub proposals: Vec<DiscoveredProposal>,
    pub devcontainer_cli: bool,
}

/// How a repository can be run, read from its main checkout (the branch's own files are read again
/// when its environment starts).
#[tauri::command]
pub async fn containers_envs_discover(db: State<'_, Db>, project_id: String) -> Result<Discovery, String> {
    let (repo_name, repo_path) = project(&db, &project_id)?;
    let existing = all(&db)?;
    let cli_installed = crate::containers::cli::find("devcontainer").is_some();
    let root = PathBuf::from(&repo_path);
    let proposals = blocking(move || Ok(envs::discover(&root, cli_installed))).await?;
    let proposals = proposals
        .into_iter()
        .map(|proposal| {
            let suggested_offset = suggest(&existing, &project_id, &proposal.ports);
            DiscoveredProposal { proposal, suggested_offset }
        })
        .collect();
    Ok(Discovery { repo_name, repo_path, proposals, devcontainer_cli: cli_installed })
}

#[tauri::command]
pub async fn containers_envs_list(db: State<'_, Db>) -> Result<Vec<EnvView>, String> {
    let envs = all(&db)?;
    Ok(envs::views(envs).await)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub project_id: String,
    pub branch: String,
    /// The branch or commit a new branch starts from; empty when `branch` already exists.
    #[serde(default)]
    pub base: Option<String>,
    pub config: EnvConfig,
    /// Chosen by hand; `None` takes the suggestion.
    #[serde(default)]
    pub offset: Option<u16>,
    pub runtime: String,
    #[serde(default)]
    pub context: Option<String>,
}

fn check_config(config: &EnvConfig) -> Result<(), String> {
    let root = Path::new("/repo");
    match config {
        EnvConfig::Compose { dir, files } => {
            if files.is_empty() {
                return Err("choose the compose files".into());
            }
            for file in files {
                envs::inside(root, file)?;
            }
            if !dir.trim().is_empty() {
                envs::inside(root, dir)?;
            }
        }
        EnvConfig::Devcontainer { config, mode, approved_init, .. } => {
            if approved_init.len() > 32 || approved_init.iter().any(|c| c.len() > 16 * 1024) {
                return Err("that initializeCommand is too long to approve".into());
            }
            envs::inside(root, config)?;
            if mode != "cli" && mode != "direct" {
                return Err(format!("{mode} is not a way to run a devcontainer"));
            }
        }
    }
    Ok(())
}

async fn create(db: &Db, request: CreateRequest) -> Result<EnvView, String> {
    let target = Target { runtime: request.runtime.clone(), context: request.context.clone() };
    if matches!(target.engine()?, EngineKind::Ctr) {
        return Err("ctr cannot run environments: install nerdctl, Docker or Podman".into());
    }
    if let Some(context) = request.context.as_deref().filter(|c| !c.trim().is_empty()) {
        crate::containers::engine::check_ref(context)?;
    }
    check_config(&request.config)?;
    let (repo_name, repo_path) = project(db, &request.project_id)?;
    let branch = request.branch.trim().to_string();
    let base = request.base.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string);

    let existing = all(db)?;
    let mut name = plan::compose_project_name(&repo_name, &branch);
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let stem = name.clone();
        let mut n = 2;
        while store::project_name_taken(&conn, &name).map_err(|e| e.to_string())? {
            name = format!("{}-{n}", stem.chars().take(60).collect::<String>().trim_end_matches('-'));
            n += 1;
            if n > 50 {
                return Err(format!("too many environments named {stem}"));
            }
        }
    }
    let offset = request.offset.unwrap_or_else(|| suggest(&existing, &request.project_id, &[]));
    let id = uuid::Uuid::new_v4().simple().to_string();
    let target_dir = envs::checkout_dir(&repo_name, &branch, &id);

    let eff = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let global = queries::get_setting(&conn, config::GLOBAL_KEY).map_err(|e| e.to_string())?;
        let repo = queries::get_setting(&conn, &config::repo_key(&request.project_id)).map_err(|e| e.to_string())?;
        config::effective(&config::parse_global(global.as_deref()), &config::parse_repo(repo.as_deref()))
    };
    let (repo_for_git, branch_for_git, base_for_git) = (repo_path.clone(), branch.clone(), base.clone());
    let (made, copied) = blocking(move || {
        let _lock = crate::git::write_lock(&repo_for_git);
        let made = branch_worktree::ensure(&repo_for_git, &target_dir, &branch_for_git, base_for_git.as_deref())?;
        let copied = envs::copy_env_files(Path::new(&repo_for_git), Path::new(&made.path), &eff);
        Ok((made, copied))
    })
    .await?;

    let stamp = now();
    let env = EnvRecord {
        id,
        project_id: request.project_id.clone(),
        repo_name,
        repo_path: repo_path.clone(),
        branch,
        base: if made.new_branch { base.unwrap_or_default() } else { String::new() },
        worktree_path: made.path.clone(),
        worktree_created: made.created,
        compose_project: name,
        port_offset: offset,
        runtime: request.runtime,
        context: request.context.filter(|c| !c.trim().is_empty()),
        config: request.config,
        ports: vec![],
        warnings: vec![],
        copied_files: copied,
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    // The branch has to have what was chosen; a checkout made for nothing is taken back.
    if let Err(problem) = envs::shape(&env) {
        if made.created {
            let (repo, path) = (repo_path.clone(), made.path.clone());
            let _ = blocking(move || branch_worktree::remove(&repo, &path, true)).await;
        }
        return Err(problem);
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::insert(&conn, &env).map_err(|e| e.to_string())?;
    }
    Ok(envs::views(vec![env]).await.remove(0))
}

/// A checkout of the branch, its env files and a record — nothing started yet: the page starts it
/// next (as a job for a Compose stack, through `containers_envs_up` for a devcontainer).
#[tauri::command]
pub async fn containers_envs_create(db: State<'_, Db>, request: CreateRequest) -> Result<EnvView, String> {
    create(&db, request).await
}

/// Another branch with the configuration, engine and repository of environment `id`.
#[tauri::command]
pub async fn containers_envs_clone(db: State<'_, Db>, id: String, branch: String, base: Option<String>, offset: Option<u16>) -> Result<EnvView, String> {
    let source = record(&db, &id)?;
    create(
        &db,
        CreateRequest { project_id: source.project_id, branch, base, config: source.config, offset, runtime: source.runtime, context: source.context },
    )
    .await
}

/// The override written again and what a Compose job starts with — for a Compose stack.
#[tauri::command]
pub async fn containers_envs_prepare(db: State<'_, Db>, id: String) -> Result<envs::ComposeLaunch, String> {
    let env = record(&db, &id)?;
    let (project_dir, files) = match envs::shape(&env)? {
        envs::Shape::Compose { project_dir, files, dev: None } => (project_dir, files),
        _ => return Err("this environment is a devcontainer: it is started with containers_envs_up".into()),
    };
    let (launch, _) = envs::plan_compose(&env, &project_dir, &files).await?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::set_plan(&conn, &id, &launch.ports, &launch.warnings, &now()).map_err(|e| e.to_string())?;
    Ok(launch)
}

/// The security policy of the workspace the environment's repository is in (its own, the default,
/// or the built-in one).
fn workspace_policy(db: &Db, project_id: &str) -> Result<crate::containers::policy::SecurityPolicy, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let workspace: String = conn.query_row("SELECT workspace_id FROM projects WHERE id = ?1", params![project_id], |r| r.get(0)).unwrap_or_default();
    crate::containers::policy::load(&conn, &workspace).map(|stored| stored.policy).map_err(|e| e.to_string())
}

/// Brings a devcontainer environment up (`rebuild`: built again, containers replaced), held to the
/// workspace's security policy. Refused with `INIT_CHANGED: [...]` when the branch's
/// `initializeCommand` is not the one approved — see `containers_envs_approve_init`.
#[tauri::command]
pub async fn containers_envs_up(db: State<'_, Db>, id: String, rebuild: bool) -> Result<envs::UpResult, String> {
    let env = record(&db, &id)?;
    let gate = envs::Gate { policy: workspace_policy(&db, &env.project_id)?, db: Some(&db) };
    let result = envs::up_devcontainer(&env, rebuild, &gate).await?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::set_plan(&conn, &id, &result.ports, &result.warnings, &now()).map_err(|e| e.to_string())?;
    Ok(result)
}

/// The user agreed, in the page's confirmation, to run `commands` — the `initializeCommand` the
/// branch's `devcontainer.json` has now — on this computer when the environment starts. Kept word for
/// word: `up` runs nothing else.
#[tauri::command]
pub async fn containers_envs_approve_init(db: State<'_, Db>, id: String, commands: Vec<String>) -> Result<(), String> {
    let env = record(&db, &id)?;
    let EnvConfig::Devcontainer { config, mode, without_features, .. } = env.config else {
        return Err("a Compose stack has no initializeCommand".into());
    };
    let config = EnvConfig::Devcontainer { config, mode, without_features, approved_init: commands };
    check_config(&config)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::set_config(&conn, &id, &config, &now()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn containers_envs_stop(db: State<'_, Db>, id: String) -> Result<String, String> {
    let env = record(&db, &id)?;
    envs::stop(&env).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeState {
    pub exists: bool,
    pub dirty: bool,
    /// Made for this environment — the only kind removing it may delete.
    pub created: bool,
}

#[tauri::command]
pub async fn containers_envs_worktree_state(db: State<'_, Db>, id: String) -> Result<WorktreeState, String> {
    let env = record(&db, &id)?;
    let path = env.worktree_path.clone();
    let exists = Path::new(&path).is_dir();
    let dirty = if exists { blocking(move || branch_worktree::is_dirty(&path)).await.unwrap_or(true) } else { false };
    Ok(WorktreeState { exists, dirty, created: env.worktree_created })
}

/// Takes the environment away: its containers (`volumes`: its volumes too), then — when asked and
/// when this environment made it — its checkout. A checkout with changes nobody committed is kept
/// unless `force`; the refusal comes back as `WORKTREE_DIRTY: <path>` and the environment stays.
#[tauri::command]
pub async fn containers_envs_remove(db: State<'_, Db>, id: String, volumes: bool, remove_worktree: bool, force: bool) -> Result<(), String> {
    let env = record(&db, &id)?;
    if remove_worktree && env.worktree_created && Path::new(&env.worktree_path).is_dir() && !force {
        let path = env.worktree_path.clone();
        if blocking(move || branch_worktree::is_dirty(&path)).await? {
            return Err(format!("{}{}", crate::git::worktree::WORKTREE_DIRTY_PREFIX, env.worktree_path));
        }
    }
    envs::down(&env, volumes).await?;
    if remove_worktree && env.worktree_created {
        let (repo, path) = (env.repo_path.clone(), env.worktree_path.clone());
        blocking(move || {
            let _lock = crate::git::write_lock(&repo);
            branch_worktree::remove(&repo, &path, force)
        })
        .await?;
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::delete(&conn, &id).map_err(|e| e.to_string())
}

/// Every volume of the environment into a new folder under `folder` (one the folder dialog chose).
#[tauri::command]
pub async fn containers_envs_snapshot(db: State<'_, Db>, id: String, folder: String) -> Result<envs::SnapshotResult, String> {
    let env = record(&db, &id)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    envs::snapshot(&env, Path::new(&folder), &stamp).await
}

/// A snapshot folder restored into the environment's volumes (stop it first).
#[tauri::command]
pub async fn containers_envs_restore(db: State<'_, Db>, id: String, folder: String) -> Result<Vec<String>, String> {
    let env = record(&db, &id)?;
    let folder = PathBuf::from(folder);
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(format!("{} is not a folder of this computer", folder.display()));
    }
    envs::restore(&env, &folder).await
}
