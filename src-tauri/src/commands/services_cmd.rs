//! The Services workspace's commands: definitions in, and the supervisor's verbs out.
//!
//! # A service is a terminal with a name
//!
//! Nothing here spawns a process of its own. The supervisor resolves a working directory, builds
//! one command line and hands it to [`crate::terminal::open_pty`] — the same call the terminal dock
//! and the Remote workspace use — so a service gets colour, a real tty, the xterm pane, Ctrl-C and
//! resize for free. What it adds on top is a name, an order, a gate and a way to stop a whole tree.
//! See [`crate::services::supervisor`] for why that orchestration lives here and not in the webview.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::models::{Service, ServiceGroup};
use crate::db::{queries, service_queries, Db};
use crate::services::detect::{self, Candidate};
use crate::services::ports;
use crate::services::supervisor::{RuntimeView, ServiceLog};
use crate::services::Supervisor;

#[tauri::command]
pub fn list_services(db: State<Db>, workspace_id: String) -> Result<Vec<Service>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    service_queries::list_services(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_service_groups(db: State<Db>, workspace_id: String) -> Result<Vec<ServiceGroup>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    service_queries::list_groups(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_service(db: State<Db>, service: Service) -> Result<Service, String> {
    if service.name.trim().is_empty() {
        return Err("a service needs a name".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    service_queries::create_service(&conn, &service).map_err(|e| e.to_string())
}

/// Saves a service, refusing a dependency graph that cannot finish.
///
/// The check is here rather than in the supervisor because a cycle is a mistake in the
/// *definition*, and the moment to say so is while the person who made it is looking at the form.
#[tauri::command]
pub fn update_service(db: State<Db>, service: Service) -> Result<(), String> {
    if service.name.trim().is_empty() {
        return Err("a service needs a name".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut all = service_queries::list_services(&conn, &service.workspace_id).map_err(|e| e.to_string())?;
    // The saved version, not the stored one: the cycle being introduced is in the edit.
    for existing in all.iter_mut() {
        if existing.id == service.id {
            existing.depends_on = service.depends_on.clone();
        }
    }
    if let Some(loop_names) = find_cycle(&all) {
        return Err(format!("these services wait for each other: {loop_names}"));
    }
    service_queries::update_service(&conn, &service).map_err(|e| e.to_string())
}

/// Deletes a service — stopped first, and awaited: deleting the definition of something still
/// running would leave a process nothing on screen can name, let alone stop.
#[tauri::command]
pub async fn delete_service(app: AppHandle, id: String) -> Result<(), String> {
    let supervisor = Supervisor::of(&app);
    supervisor.stop(&app, std::slice::from_ref(&id)).await;
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        service_queries::delete_service(&conn, &id).map_err(|e| e.to_string())?;
    }
    supervisor.forget(&id);
    Ok(())
}

#[tauri::command]
pub fn create_service_group(db: State<Db>, workspace_id: String, name: String) -> Result<ServiceGroup, String> {
    if name.trim().is_empty() {
        return Err("a group needs a name".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    service_queries::create_group(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_service_group(db: State<Db>, id: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    service_queries::rename_group(&conn, &id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_service_group(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    service_queries::delete_group(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_services(db: State<Db>, workspace_id: String, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    service_queries::reorder_services(&conn, &workspace_id, &ids).map_err(|e| e.to_string())
}

/// Starts `ids` and everything they wait for. Returns as soon as the work is queued; progress
/// arrives as `services:runtime` events.
#[tauri::command(async)]
pub fn services_start(app: AppHandle, workspace_id: String, ids: Vec<String>) -> Result<(), String> {
    Supervisor::of(&app).start(&app, &workspace_id, &ids)
}

/// Stops `ids`, dependents first, and returns once every one of them is down.
#[tauri::command]
pub async fn services_stop(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    Supervisor::of(&app).stop(&app, &ids).await;
    Ok(())
}

/// Stops what is running of `ids`, then starts them all again in dependency order.
#[tauri::command]
pub async fn services_restart(app: AppHandle, workspace_id: String, ids: Vec<String>) -> Result<(), String> {
    Supervisor::of(&app).restart(&app, &workspace_id, &ids).await
}

/// Every service the supervisor knows about, in any workspace — what a webview that has just
/// loaded (or reloaded) needs to draw the truth instead of "nothing is running".
#[tauri::command]
pub fn services_runtime(app: AppHandle) -> Vec<RuntimeView> {
    Supervisor::of(&app).snapshot()
}

/// What a service has printed, across restarts, for a console that is mounting.
#[tauri::command]
pub fn service_log(app: AppHandle, id: String) -> ServiceLog {
    Supervisor::of(&app).log(&id)
}

#[tauri::command]
pub fn service_clear_log(app: AppHandle, id: String) {
    Supervisor::of(&app).clear_log(&id);
}

/// What a folder can run, best first. See [`crate::services::detect`].
#[tauri::command]
pub async fn service_detect(path: String) -> Vec<Candidate> {
    tauri::async_runtime::spawn_blocking(move || detect::detect(Path::new(path.trim())))
        .await
        .unwrap_or_default()
}

/// One repository's suggestions, for the importer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCandidates {
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub candidates: Vec<Candidate>,
}

/// What every repository in a workspace can run — the "detect services" button.
#[tauri::command]
pub async fn services_detect_workspace(app: AppHandle, workspace_id: String) -> Result<Vec<ProjectCandidates>, String> {
    let projects = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::list_projects(&conn, &workspace_id).map_err(|e| e.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        projects
            .into_iter()
            .map(|project| ProjectCandidates {
                candidates: detect::detect(Path::new(&project.local_path)),
                project_id: project.id,
                project_name: project.name,
                path: project.local_path,
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// One listening port on this machine, and the service it belongs to when it is one of ours.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortRow {
    pub port: u16,
    pub address: String,
    pub pid: u32,
    pub process: String,
    pub service_id: Option<String>,
    pub service_name: Option<String>,
    pub workspace_id: Option<String>,
}

/// Every TCP port something is listening on — the Ports view — with the owning service named where
/// the process belongs to one. Docker's published ports are attributed by number, since the
/// process holding them is Docker's, not the service's.
#[tauri::command]
pub async fn services_listening_ports(app: AppHandle) -> Vec<PortRow> {
    let owners = Supervisor::of(&app).port_owners();
    let listeners = tauri::async_runtime::spawn_blocking(ports::all_listeners).await.unwrap_or_default();
    let by_pid: HashMap<u32, &(String, String, String)> =
        owners.by_pid.iter().map(|(pid, owner)| (*pid, owner)).collect();
    let by_port: HashMap<u16, &(String, String, String)> =
        owners.by_port.iter().map(|(port, owner)| (*port, owner)).collect();
    let mut rows: Vec<PortRow> = listeners
        .into_iter()
        .map(|listener| {
            let owner = by_pid.get(&listener.pid).or_else(|| by_port.get(&listener.port)).copied();
            PortRow {
                port: listener.port,
                address: listener.address,
                pid: listener.pid,
                process: listener.process,
                service_id: owner.map(|o| o.0.clone()),
                service_name: owner.map(|o| o.1.clone()),
                workspace_id: owner.map(|o| o.2.clone()),
            }
        })
        .collect();
    rows.sort_by(|a, b| a.port.cmp(&b.port).then(a.pid.cmp(&b.pid)));
    rows.dedup_by(|a, b| a.port == b.port && a.pid == b.pid);
    rows
}

/// Ends the process holding a port — the answer to "address already in use" when the holder is
/// not a service this app can stop by name. Refuses the two pids no user means.
#[tauri::command]
pub async fn services_free_port(pid: u32) -> Result<(), String> {
    if pid <= 1 || pid == std::process::id() {
        return Err("that process cannot be stopped from here".into());
    }
    tauri::async_runtime::spawn_blocking(move || ports::terminate(pid))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether a path is a directory, for the service editor to say so before the first run rather than
/// after it. Cheap enough to call on every keystroke of a path field.
#[tauri::command]
pub fn service_path_exists(path: String) -> bool {
    !path.trim().is_empty() && Path::new(path.trim()).is_dir()
}

/// The first cycle in a set of services, named, or `None` when the graph is a DAG.
///
/// Iterative depth-first search with an explicit stack rather than recursion: `depends_on` is user
/// input, and a deep chain should be refused rather than overflow the stack while refusing it.
fn find_cycle(services: &[Service]) -> Option<String> {
    let by_id: HashMap<&str, &Service> = services.iter().map(|s| (s.id.as_str(), s)).collect();
    let deps_of = |service: &Service| -> Vec<String> {
        serde_json::from_str::<Vec<String>>(&service.depends_on).unwrap_or_default()
    };

    // 0 unvisited, 1 on the current path, 2 finished.
    let mut state: HashMap<&str, u8> = HashMap::new();

    for root in services {
        if state.get(root.id.as_str()).copied().unwrap_or(0) != 0 {
            continue;
        }
        // (node, whether this frame is the "leaving" pass)
        let mut stack: Vec<(String, bool)> = vec![(root.id.clone(), false)];
        while let Some((id, leaving)) = stack.pop() {
            if leaving {
                state.insert(by_id.get(id.as_str()).map(|s| s.id.as_str()).unwrap_or(""), 2);
                continue;
            }
            match state.get(id.as_str()).copied().unwrap_or(0) {
                1 => {
                    let name = by_id.get(id.as_str()).map(|s| s.name.as_str()).unwrap_or("?");
                    return Some(name.to_string());
                }
                2 => continue,
                _ => {}
            }
            let Some(service) = by_id.get(id.as_str()) else { continue };
            state.insert(service.id.as_str(), 1);
            stack.push((id.clone(), true));
            for dep in deps_of(service) {
                if by_id.contains_key(dep.as_str()) {
                    stack.push((dep, false));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(id: &str, name: &str, deps: &[&str]) -> Service {
        Service {
            id: id.into(),
            workspace_id: "w1".into(),
            group_id: None,
            name: name.into(),
            kind: "shell".into(),
            project_id: None,
            cwd: String::new(),
            command: "true".into(),
            env: "{}".into(),
            ports: "[]".into(),
            ready_kind: "auto".into(),
            ready_value: String::new(),
            depends_on: serde_json::to_string(deps).unwrap(),
            autorestart: false,
            color: String::new(),
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
            detected_ports: "[]".into(),
        }
    }

    /// The ordinary case: a chain that ends. Refusing this would make the feature unusable.
    #[test]
    fn a_plain_chain_is_not_a_cycle() {
        let services = vec![
            service("db", "postgres", &[]),
            service("api", "api-auth", &["db"]),
            service("web", "web-shop", &["api"]),
        ];
        assert_eq!(find_cycle(&services), None);
    }

    /// Two services waiting for each other never start, and the moment to say so is while the form
    /// that created it is still open.
    #[test]
    fn two_services_waiting_for_each_other_are_refused() {
        let services = vec![service("a", "api", &["b"]), service("b", "web", &["a"])];
        assert!(find_cycle(&services).is_some());
    }

    /// A longer loop is the same mistake and has to be caught the same way — it is the one a person
    /// can actually make by accident.
    #[test]
    fn a_three_service_loop_is_refused() {
        let services = vec![
            service("a", "api", &["c"]),
            service("b", "web", &["a"]),
            service("c", "worker", &["b"]),
        ];
        assert!(find_cycle(&services).is_some());
    }

    /// A service depending on itself is the shortest possible loop, and the easiest to type.
    #[test]
    fn a_service_that_waits_for_itself_is_refused() {
        assert!(find_cycle(&[service("a", "api", &["a"])]).is_some());
    }

    /// A dependency on something that has been deleted is not a cycle — it is a stale id, which
    /// `delete_service` already sweeps. It must not make the whole graph unsavable.
    #[test]
    fn a_dependency_on_a_missing_service_is_ignored() {
        let services = vec![service("a", "api", &["ghost"])];
        assert_eq!(find_cycle(&services), None);
    }

    /// A diamond — two services waiting on the same database, one waiting on both — is a DAG, and
    /// the shape a real POC actually has.
    #[test]
    fn a_diamond_is_not_a_cycle() {
        let services = vec![
            service("db", "postgres", &[]),
            service("a", "api-auth", &["db"]),
            service("b", "api-orders", &["db"]),
            service("web", "web-shop", &["a", "b"]),
        ];
        assert_eq!(find_cycle(&services), None);
    }
}
