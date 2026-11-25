//! Agent sandboxes and workspace security policies: the window's side of `containers::agent_sandbox`
//! and `containers::policy`. Thin on purpose — every rule lives in those modules, so the window, a
//! flow and an agent's MCP tools are held to the same code.
//!
//! The policy's own writes (`containers_policy_save`, `containers_policy_reset`) are kept out of the
//! models' reach in the app catalogue (`scripts/app-catalog.mjs`): an agent must never be able to
//! loosen the rules it is held to.

use tauri::State;

use crate::containers::agent_sandbox::{self, store, Evidence, ExecResult, PublishedPort, Sandbox, SandboxRequest, SandboxView, Sources};
use crate::containers::engine::Target;
use crate::containers::policy::{self, PolicyCheck, SecurityPolicy, StoredPolicy};
use crate::containers::run::RunSpec;
use crate::db::Db;

fn target(runtime: String, context: Option<String>) -> Target {
    Target { runtime, context: context.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) }
}

// ------------------------------------------------------------------------------------ policies

/// The policy in force for a workspace (`""` = the global default) and where it comes from.
#[tauri::command]
pub fn containers_policy_get(db: State<'_, Db>, workspace_id: String) -> Result<StoredPolicy, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    policy::load(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Keeps a workspace's own policy (`""` = the global default).
#[tauri::command]
pub fn containers_policy_save(db: State<'_, Db>, workspace_id: String, policy: SecurityPolicy) -> Result<StoredPolicy, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    policy::save(&conn, &workspace_id, &policy).map_err(|e| e.to_string())
}

/// Drops a workspace's own policy so it follows the default again.
#[tauri::command]
pub fn containers_policy_reset(db: State<'_, Db>, workspace_id: String) -> Result<StoredPolicy, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    policy::reset(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Where cosign is installed, if it is.
#[tauri::command]
pub async fn containers_cosign_detect() -> Option<String> {
    tokio::task::spawn_blocking(policy::cosign).await.ok().flatten()
}

/// What a run spec breaks of the workspace's policy — the Run dialog's warnings before it runs.
#[tauri::command]
pub async fn containers_policy_check(db: State<'_, Db>, workspace_id: Option<String>, runtime: String, context: Option<String>, spec: RunSpec) -> Result<PolicyCheck, String> {
    policy::check_run(&db, workspace_id.as_deref().unwrap_or_default(), &target(runtime, context), &spec).await
}

/// What an existing container breaks of the workspace's policy.
#[tauri::command]
pub async fn containers_policy_check_container(db: State<'_, Db>, workspace_id: Option<String>, runtime: String, context: Option<String>, id: String) -> Result<PolicyCheck, String> {
    policy::check_existing(&db, workspace_id.as_deref().unwrap_or_default(), &target(runtime, context), &id).await
}

// ------------------------------------------------------------------------------------ sandboxes

/// A workspace's sandboxes (every one without a workspace), newest first, with what they hang off.
#[tauri::command]
pub fn containers_sandbox_list(db: State<'_, Db>, workspace_id: Option<String>) -> Result<Vec<SandboxView>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let rows = store::list(&conn, workspace_id.as_deref().filter(|w| !w.is_empty())).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|s| agent_sandbox::view(&conn, s)).collect())
}

/// The sandboxes made for a story.
#[tauri::command]
pub fn containers_sandbox_for_story(db: State<'_, Db>, story_id: String) -> Result<Vec<SandboxView>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let rows = store::for_story(&conn, &story_id).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|s| agent_sandbox::view(&conn, s)).collect())
}

#[tauri::command]
pub fn containers_sandbox_get(db: State<'_, Db>, id: String) -> Result<SandboxView, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sandbox = store::get(&conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| format!("sandbox {id} is not known"))?;
    Ok(agent_sandbox::view(&conn, sandbox))
}

/// The repositories and agent tasks (with a worktree) a sandbox can be made from.
#[tauri::command]
pub fn containers_sandbox_sources(db: State<'_, Db>, workspace_id: String) -> Result<Sources, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    agent_sandbox::sources(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Creates a sandbox — refused, with the reason, when the workspace's policy blocks it.
#[tauri::command]
pub async fn containers_sandbox_create(db: State<'_, Db>, request: SandboxRequest) -> Result<Sandbox, String> {
    agent_sandbox::create(&db, request).await
}

/// Stops what a sandbox is doing now: its creation, or a command running in it.
#[tauri::command]
pub fn containers_sandbox_cancel(id: String) -> bool {
    agent_sandbox::cancel(&id)
}

/// Runs a command in a sandbox: `argv`, or else `line` split the way a shell would.
#[tauri::command]
pub async fn containers_sandbox_exec(db: State<'_, Db>, id: String, argv: Option<Vec<String>>, line: Option<String>, timeout_s: Option<f64>) -> Result<ExecResult, String> {
    let argv = match argv.filter(|a| !a.is_empty()) {
        Some(argv) => argv,
        None => crate::containers::run::split_command(line.as_deref().unwrap_or_default())?,
    };
    agent_sandbox::exec(&db, &id, argv, timeout_s).await
}

#[tauri::command]
pub async fn containers_sandbox_logs(db: State<'_, Db>, id: String, lines: Option<u32>) -> Result<String, String> {
    agent_sandbox::logs(&db, &id, lines).await
}

#[tauri::command]
pub async fn containers_sandbox_ports(db: State<'_, Db>, id: String) -> Result<Vec<PublishedPort>, String> {
    agent_sandbox::ports(&db, &id).await
}

#[tauri::command]
pub async fn containers_sandbox_stop(db: State<'_, Db>, id: String) -> Result<Sandbox, String> {
    agent_sandbox::stop(&db, &id).await
}

#[tauri::command]
pub async fn containers_sandbox_start(db: State<'_, Db>, id: String) -> Result<Sandbox, String> {
    agent_sandbox::start(&db, &id).await
}

/// Removes a sandbox's container (after keeping its final diff), and its checkout when asked and clean.
#[tauri::command]
pub async fn containers_sandbox_destroy(db: State<'_, Db>, id: String, remove_worktree: Option<bool>) -> Result<Sandbox, String> {
    agent_sandbox::destroy(&db, &id, remove_worktree.unwrap_or(false)).await
}

/// Forgets a destroyed (or never started) sandbox and its evidence.
#[tauri::command]
pub fn containers_sandbox_forget(db: State<'_, Db>, id: String) -> Result<(), String> {
    agent_sandbox::forget(&db, &id)
}

/// Keeps the checkout's current diff as evidence.
#[tauri::command]
pub async fn containers_sandbox_capture_diff(db: State<'_, Db>, id: String) -> Result<Option<Evidence>, String> {
    agent_sandbox::capture_diff(&db, &id, "Diff captured").await
}

/// A sandbox's timeline, oldest first.
#[tauri::command]
pub fn containers_sandbox_evidence(db: State<'_, Db>, id: String) -> Result<Vec<Evidence>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::evidence(&conn, &id).map_err(|e| e.to_string())
}

/// The evidence as Markdown — written to `path` too when one is given.
#[tauri::command]
pub fn containers_sandbox_export(db: State<'_, Db>, id: String, path: Option<String>) -> Result<String, String> {
    let markdown = agent_sandbox::export(&db, &id)?;
    if let Some(path) = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        std::fs::write(&path, &markdown).map_err(|e| format!("could not write {path}: {e}"))?;
    }
    Ok(markdown)
}

/// Removes the engine's sandbox containers whose sandbox is no longer live; their names.
#[tauri::command]
pub async fn containers_sandbox_cleanup(db: State<'_, Db>, runtime: String, context: Option<String>) -> Result<Vec<String>, String> {
    agent_sandbox::cleanup(&db, &target(runtime, context)).await
}
