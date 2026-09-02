//! Starting services, and the two questions the executor cannot answer from JavaScript.
//!
//! # A service is a terminal with a name
//!
//! Nothing here spawns a process of its own. [`start_service`] resolves a working directory,
//! builds one command line and hands it to [`crate::terminal::open_pty`] — the same call the
//! terminal dock and the Remote workspace already use. What that buys, for free: colour, a real
//! tty (so `vite` and `docker compose` print their progress the way they do in a terminal),
//! `terminal:output` / `terminal:exit` events the existing xterm pane already knows how to render,
//! and Ctrl-C, resize and close that already work. The only thing this file adds on top is a name
//! and a `cwd` policy.
//!
//! # Why the orchestration is *not* here
//!
//! Dependency order, readiness gates and restarts live in the frontend's `servicesStore`, in the
//! main window and nowhere else — the same split as the agent-chain executor, and for the same
//! reason. The gate that matters most is "this line appeared in the output", and the output is
//! already streaming into the frontend; moving the whole graph into Rust to avoid one round trip
//! per probe would mean re-implementing the log stream on the other side of it.
//!
//! What the frontend genuinely cannot do is open a TCP socket or make an arbitrary HTTP request
//! from a webview under a strict origin policy. Those two are [`probe_port`] and [`probe_http`],
//! and they are the entire backend half of the gates.

use std::collections::HashMap;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, State};

use crate::db::models::{Service, ServiceGroup};
use crate::db::{queries, service_queries, Db};
use crate::terminal::{Origin, TerminalRegistry};

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
/// The check is here rather than in the executor because a cycle is a mistake in the *definition*,
/// and the moment to say so is while the person who made it is looking at the form. In the executor
/// it would surface as a group that starts nothing, hours later, with no obvious cause — and the
/// executor would have to carry cycle detection anyway to avoid hanging.
#[tauri::command]
pub fn update_service(db: State<Db>, service: Service) -> Result<(), String> {
    if service.name.trim().is_empty() {
        return Err("a service needs a name".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut all = service_queries::list_services(&conn, &service.workspace_id)
        .map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn delete_service(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    service_queries::delete_service(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_service_group(
    db: State<Db>,
    workspace_id: String,
    name: String,
) -> Result<ServiceGroup, String> {
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

/// Where a service runs.
///
/// A `project_id` means the directory is relative to that repository's checkout, which is what lets
/// a definition survive the folder being moved or the repository being re-cloned somewhere else.
/// Without one, `cwd` is taken as absolute. An empty `cwd` under a project is the repository root.
///
/// The join is `Path::join`, which treats an absolute `cwd` as a replacement rather than appending
/// it — so a definition that names both a project and an absolute path lands on the absolute path.
/// That is the behaviour a person typing an absolute path expects, and the alternative (a silently
/// mangled `/repo//usr/local/bin`) is not a directory anywhere.
fn resolve_cwd(db: &Db, service: &Service) -> Result<Option<String>, String> {
    let base: Option<PathBuf> = match &service.project_id {
        Some(project_id) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let project = queries::get_project(&conn, project_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "this service points at a repository that is no longer here".to_string())?;
            Some(PathBuf::from(project.local_path))
        }
        None => None,
    };

    let trimmed = service.cwd.trim();
    let resolved = match (base, trimmed.is_empty()) {
        (Some(root), true) => Some(root),
        (Some(root), false) => Some(root.join(trimmed)),
        (None, true) => None,
        (None, false) => Some(PathBuf::from(trimmed)),
    };

    let Some(path) = resolved else { return Ok(None) };
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Starts one service in a pty and returns the terminal session id.
///
/// The command is run **through a shell** rather than split into argv here, and that is the whole
/// reason a service can be `docker compose up db && echo ready` or `pnpm dev --host`: splitting on
/// spaces would break quoting, and asking the user to fill in an args array would make the common
/// case worse to serve the rare one. It is the same trust boundary the terminal dock already has —
/// this is a command the user typed into their own machine's shell.
#[tauri::command]
pub fn start_service(
    app: AppHandle,
    db: State<Db>,
    registry: State<TerminalRegistry>,
    id: String,
) -> Result<String, String> {
    let service = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        service_queries::get_service(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "that service no longer exists".to_string())?
    };
    if service.command.trim().is_empty() {
        return Err("this service has no command to run".into());
    }

    let cwd = resolve_cwd(&db, &service)?;
    let (program, args) = shell_invocation(&service.command);

    crate::terminal::open_pty(
        app,
        &registry,
        &program,
        &args,
        cwd.as_deref(),
        None,
        Origin {
            cwd: cwd.clone().unwrap_or_default(),
            // The service's own name, so the terminal registry — which the Remote workspace and a
            // paired phone also read — lists it as what it is rather than as an anonymous shell.
            profile: service.name.clone(),
            owner: None,
        },
    )
}

/// The shell a one-line command is handed to, per platform.
///
/// `cmd /C` on Windows rather than PowerShell: it is present on every installation, it needs no
/// execution-policy exemption, and a command that wants PowerShell can say so as its own first
/// word. `sh -lc` elsewhere — a **login** shell, because the whole point of a service is that it
/// runs `pnpm`, `docker` and `cargo`, which live on a `PATH` a non-login shell on macOS does not
/// have (the same problem `shell_env::import_login_path` exists for).
fn shell_invocation(command: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("cmd".to_string(), vec!["/C".to_string(), command.to_string()])
    }
    #[cfg(not(windows))]
    {
        ("/bin/sh".to_string(), vec!["-lc".to_string(), command.to_string()])
    }
}

/// Whether something is listening on this port — the `port` readiness gate.
///
/// A TCP connect and nothing more: no protocol, no read. "Postgres is accepting connections" is
/// exactly a successful connect, and anything cleverer would need per-service knowledge this has no
/// business having.
///
/// The timeout is short and the failure is silent, because this is polled: a closed port is the
/// expected answer for as long as the service is starting, and it is not an error until the caller
/// gives up. Resolving the host is part of the timeout budget — a `localhost` that resolves slowly
/// is a stall the caller has to be able to bound.
#[tauri::command]
pub async fn probe_port(host: String, port: u16, timeout_ms: u64) -> bool {
    let budget = Duration::from_millis(timeout_ms.clamp(50, 5_000));
    tauri::async_runtime::spawn_blocking(move || {
        let target = if host.trim().is_empty() { "127.0.0.1".to_string() } else { host };
        let Ok(addrs) = (format!("{target}:{port}")).to_socket_addrs() else { return false };
        let addrs: Vec<SocketAddr> = addrs.collect();
        addrs
            .iter()
            .any(|addr| std::net::TcpStream::connect_timeout(addr, budget).is_ok())
    })
    .await
    .unwrap_or(false)
}

/// Whether this URL answers — the `http` readiness gate.
///
/// Any status below 500 counts as up, which is the useful definition rather than the strict one: a
/// health endpoint behind auth answers 401, a bare `/` on an API answers 404, and both mean the
/// server is listening and serving. A 5xx means it is up but broken, which is not ready.
///
/// Redirects are followed by reqwest's default policy — a dev server redirecting `/` to `/app` is
/// still up.
#[tauri::command]
pub async fn probe_http(url: String, timeout_ms: u64) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(100, 10_000)))
        // A dev server with a self-signed certificate is the normal case for `https://localhost`,
        // and refusing to talk to it would make the gate unusable for exactly the setup it is for.
        // This request reads nothing but a status code from a loopback address the user configured.
        .danger_accept_invalid_certs(true)
        .build()
    else {
        return false;
    };
    match client.get(&url).send().await {
        Ok(response) => response.status().as_u16() < 500,
        Err(_) => false,
    }
}

/// Whether a path is a directory, for the service editor to say so before the first run rather than
/// after it. Cheap enough to call on every keystroke of a path field.
#[tauri::command]
pub fn service_path_exists(path: String) -> bool {
    !path.trim().is_empty() && Path::new(path.trim()).is_dir()
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
            ready_kind: "none".into(),
            ready_value: String::new(),
            depends_on: serde_json::to_string(deps).unwrap(),
            autorestart: false,
            color: String::new(),
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
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

    /// A closed port answers false rather than hanging or erroring — the expected answer for as
    /// long as a service is still starting.
    #[tokio::test]
    async fn a_closed_port_is_not_ready() {
        // Port 1 on loopback: reserved, and nothing binds it.
        assert!(!probe_port("127.0.0.1".into(), 1, 200).await);
    }

    /// And an open one answers true, which is the whole of the `port` gate.
    #[tokio::test]
    async fn a_listening_port_is_ready() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe_port("127.0.0.1".into(), port, 500).await);
    }
}
