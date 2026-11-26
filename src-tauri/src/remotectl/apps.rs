//! Notes and containers, as a phone is shown them.
//!
//! Two apps that are worth having in a pocket for one reason each: a note is something you read —
//! or jot — away from the desk, and a container is something you check is still up, and restart
//! when it is not. Neither is brought over whole. Notes come without their trash, their templates,
//! their versions and their graph; containers come without images, volumes, shells, files and
//! anything that reaches past this machine. See the arms in `dispatch.rs` for the line each draws.

use serde::Serialize;
use serde_json::{json, Value};

use crate::containers::{self, engine};

/// The engines a phone may name: the ones that run containers on *this* machine.
///
/// Not `kubernetes`. A cluster is somebody else's machines, reached with credentials in a
/// kubeconfig — the same reason `db_*` and `remote_*` are out of the table.
const PHONE_ENGINES: &[&str] = &["docker", "podman", "nerdctl"];

/// Whether `runtime` is one a phone may name. See [`PHONE_ENGINES`].
pub fn phone_engine(runtime: &str) -> bool {
    PHONE_ENGINES.contains(&runtime)
}

/// The three verbs a phone has over a container. Starting, stopping and restarting leave the
/// container, its volumes and its image exactly where they were; removing does not, and stays at
/// the desk with everything else that deletes.
pub fn phone_container_action(action: &str) -> bool {
    matches!(action, "start" | "stop" | "restart")
}

/// An engine, as the phone names it above its containers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRow {
    pub id: String,
    /// What provides it, when that can be told: `OrbStack`, `Docker Desktop`…
    pub provider: String,
    pub running: bool,
    pub problem: String,
}

/// One container. No command line, no labels and no mounts: a command line carries whatever was
/// passed to it, tokens included, and none of the three is needed to tell whether it is up.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRow {
    pub runtime: String,
    pub id: String,
    pub name: String,
    pub image: String,
    /// `running`, `exited`, `paused`, `created`…
    pub state: String,
    /// The engine's own sentence: "Up 3 hours", "Exited (1) 2 minutes ago".
    pub status: String,
    pub health: String,
    /// The ports it publishes on this machine, as `8080→80`.
    pub ports: Vec<String>,
    /// The Compose project it belongs to, when one made it.
    pub project: String,
    pub service: String,
}

/// Every local engine and what it is running.
///
/// The engine's default context only — `context: None`. A context can name another machine
/// (`ssh://…`), and which one is current is a choice made at the desk; the phone sees what the
/// desk's own list opens on.
pub async fn containers() -> Value {
    let mut engines = Vec::new();
    let mut rows = Vec::new();
    for runtime in containers::detect().await {
        if !phone_engine(&runtime.id) {
            continue;
        }
        let mut problem = runtime.problem.clone().unwrap_or_default();
        if runtime.running {
            let target = engine::Target { runtime: runtime.id.clone(), context: None };
            match engine::list_containers(&target).await {
                Ok(found) => rows.extend(found.into_iter().map(|c| container_row(&runtime.id, c))),
                Err(error) => problem = error,
            }
        }
        engines.push(EngineRow {
            id: runtime.id,
            provider: runtime.provider.unwrap_or_default(),
            running: runtime.running,
            problem: problem.chars().take(400).collect(),
        });
    }
    json!({ "engines": engines, "containers": rows })
}

fn container_row(runtime: &str, c: engine::ContainerRow) -> ContainerRow {
    ContainerRow {
        runtime: runtime.to_string(),
        ports: c
            .ports
            .iter()
            .filter_map(|port| port.host_port.map(|host| format!("{host}→{}", port.container_port)))
            .collect(),
        id: c.id,
        name: c.name,
        image: c.image,
        state: c.state,
        status: c.status,
        health: c.health,
        project: c.project,
        service: c.service,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cluster and a low-level runtime are not things a phone names, and neither is anything
    /// that is not an engine at all.
    #[test]
    fn only_local_engines_are_named() {
        for ok in ["docker", "podman", "nerdctl"] {
            assert!(phone_engine(ok), "{ok}");
        }
        for no in ["kubernetes", "ctr", "", "docker --host", "sh"] {
            assert!(!phone_engine(no), "{no}");
        }
    }

    /// Start, stop, restart — and nothing that removes or kills.
    #[test]
    fn a_phone_never_removes_a_container() {
        for ok in ["start", "stop", "restart"] {
            assert!(phone_container_action(ok));
        }
        for no in ["remove", "kill", "pause", "prune", "rm", ""] {
            assert!(!phone_container_action(no), "{no}");
        }
    }

    /// What a container was started with never reaches the phone: read as text, the way a thief
    /// would, a row names no command line, label or mount.
    #[test]
    fn a_container_row_carries_no_command_line_or_labels() {
        let row = container_row(
            "docker",
            engine::ContainerRow {
                id: "abc".into(),
                name: "api".into(),
                image: "node:22".into(),
                state: "running".into(),
                status: "Up 2 hours".into(),
                health: String::new(),
                exit_code: None,
                ports: vec![engine::PortMap { host_ip: "0.0.0.0".into(), host_port: Some(8080), container_port: 80, protocol: "tcp".into() },
                    engine::PortMap { host_ip: String::new(), host_port: None, container_port: 9229, protocol: "tcp".into() }],
                created: String::new(),
                command: "node server.js --token=SECRETO".into(),
                project: "shop".into(),
                service: "api".into(),
                project_dir: "/work/shop".into(),
                config_files: String::new(),
                pod: String::new(),
                labels: [("env".to_string(), "CLAVE-PRIVADA".to_string())].into_iter().collect(),
                mounts: vec!["datos".into()],
            },
        );
        let text = serde_json::to_string(&row).unwrap();
        assert!(!text.contains("SECRETO") && !text.contains("CLAVE-PRIVADA") && !text.contains("/work/shop"));
        // Only the ports published on this machine are listed.
        assert_eq!(row.ports, vec!["8080→80".to_string()]);
    }
}
