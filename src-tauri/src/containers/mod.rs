//! Contenedores — Docker, Podman, containerd and Kubernetes, the way an IDE's Services view shows
//! them: **found, not embedded.** Nothing here starts a daemon of its own or keeps a list the user
//! has to fill in. What is installed on this computer is detected (`detect`), and everything is
//! read and done through the runtimes' own tools — `docker`, `podman`, `nerdctl` (or containerd's
//! bare `ctr`) and `kubectl` — so the panel shows exactly what a terminal would, and an action
//! here is the command the user would have typed.
//!
//! - [`cli`] finds the tools (including where OrbStack, Docker Desktop, Rancher Desktop and Podman
//!   put them without telling the shell) and runs them.
//! - [`engine`] reads and acts on the Docker-compatible engines, whatever JSON dialect they print.
//! - [`kube`] does the same for a Kubernetes context.
//! - [`session`] opens a container's logs or a shell inside it as a terminal session.
//! - [`forward`] keeps `kubectl port-forward`s running.

pub mod cli;
pub mod engine;
pub mod files;
pub mod forward;
pub mod hub;
pub mod kube;
pub mod kubeconfig;
pub mod manage;
pub mod run;
pub mod session;

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const DETECT_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    /// The endpoint a Docker context points at, or a Kubernetes context's cluster.
    pub detail: String,
    /// A Kubernetes context's own default namespace.
    pub namespace: String,
}

/// One runtime found on this computer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    /// `docker`, `podman`, `nerdctl`, `ctr`, `kubernetes`.
    pub id: String,
    /// What provides it, when that can be told: `OrbStack`, `Docker Desktop`, `Colima`, `Rancher
    /// Desktop`, `Podman machine`.
    pub provider: Option<String>,
    pub binary: String,
    pub version: Option<String>,
    pub server_version: Option<String>,
    /// Its daemon (or VM) answers. Always true for Kubernetes, whose clusters are checked per context.
    pub running: bool,
    pub problem: Option<String>,
    pub contexts: Vec<ContextInfo>,
    pub current_context: Option<String>,
    /// How it can be started from here when it is not running: `orbstack`, `dockerDesktop`, `colima`,
    /// `podmanMachine`, `rancherDesktop`.
    pub start: Option<String>,
}

/// A name or image matched by a glob (`api-*`, `postgres*`), case-insensitive; an empty pattern
/// matches everything, and one that is not a glob is looked for as text.
pub fn glob_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return true;
    }
    match globset::GlobBuilder::new(pattern).case_insensitive(true).build() {
        Ok(glob) => glob.compile_matcher().is_match(value),
        Err(_) => value.to_lowercase().contains(&pattern.to_lowercase()),
    }
}

/// Who provides a Docker endpoint, from its socket path.
pub fn provider_of(endpoint: &str) -> Option<(&'static str, &'static str)> {
    let e = endpoint.to_lowercase();
    if e.contains(".orbstack") {
        Some(("OrbStack", "orbstack"))
    } else if e.contains(".colima") {
        Some(("Colima", "colima"))
    } else if e.contains(".rd/") || e.contains("rancher-desktop") {
        Some(("Rancher Desktop", "rancherDesktop"))
    } else if e.contains("podman") {
        Some(("Podman", "podmanMachine"))
    } else if e.contains(".docker/run/docker.sock") || e.contains("docker_engine") || e.contains("dockerdesktop") || e.contains("desktop-linux") {
        Some(("Docker Desktop", "dockerDesktop"))
    } else {
        None
    }
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().to_string()
}

/// A daemon that does not answer explains itself at length; the panel shows the gist.
pub fn tidy_problem(raw: &str) -> String {
    let line = first_line(raw);
    let lower = line.to_lowercase();
    if lower.contains("cannot connect") || lower.contains("failed to connect") || lower.contains("connection refused") || lower.contains("no such file or directory") || lower.contains("is the docker daemon running") {
        "not running".to_string()
    } else {
        line.chars().take(200).collect()
    }
}

async fn detect_docker() -> Option<RuntimeInfo> {
    let binary = cli::find("docker")?;
    let program = binary.to_string_lossy().into_owned();
    let version_args: Vec<String> = vec!["version".into(), "--format".into(), "{{json .}}".into()];
    let context_args: Vec<String> = vec!["context".into(), "ls".into(), "--format".into(), "{{json .}}".into()];
    let (version, contexts) = tokio::join!(
        cli::run(&program, &version_args, None, DETECT_TIMEOUT),
        cli::run(&program, &context_args, None, DETECT_TIMEOUT),
    );
    let mut info = RuntimeInfo {
        id: "docker".into(),
        provider: None,
        binary: program,
        version: None,
        server_version: None,
        running: false,
        problem: None,
        contexts: vec![],
        current_context: None,
        start: None,
    };
    if let Ok(out) = &contexts {
        for value in cli::json_values(&out.stdout) {
            let name = value.get("Name").and_then(Value::as_str).unwrap_or_default().to_string();
            let endpoint = value.get("DockerEndpoint").and_then(Value::as_str).unwrap_or_default().to_string();
            if value.get("Current").and_then(Value::as_bool).unwrap_or(false) {
                info.current_context = Some(name.clone());
                if let Some((label, start)) = provider_of(&endpoint) {
                    info.provider = Some(label.into());
                    info.start = Some(start.into());
                }
            }
            if !name.is_empty() {
                info.contexts.push(ContextInfo { name, detail: endpoint, namespace: String::new() });
            }
        }
    }
    match version {
        Ok(out) => {
            let doc = cli::json_values(&out.stdout).into_iter().next().unwrap_or(Value::Null);
            info.version = doc.pointer("/Client/Version").and_then(Value::as_str).map(str::to_string);
            info.server_version = doc.pointer("/Server/Version").and_then(Value::as_str).map(str::to_string);
            info.running = info.server_version.is_some();
            if !info.running {
                info.problem = Some(tidy_problem(&out.stderr));
            }
            if info.version.is_none() && out.stdout.trim().is_empty() {
                info.problem = Some(tidy_problem(&out.complaint()));
            }
        }
        Err(error) => info.problem = Some(error),
    }
    Some(info)
}

async fn detect_podman() -> Option<RuntimeInfo> {
    let binary = cli::find("podman")?;
    let program = binary.to_string_lossy().into_owned();
    let version = cli::run(&program, &["version".into(), "--format".into(), "json".into()], None, DETECT_TIMEOUT).await;
    let mut info = RuntimeInfo {
        id: "podman".into(),
        provider: None,
        binary: program.clone(),
        version: None,
        server_version: None,
        running: false,
        problem: None,
        contexts: vec![],
        current_context: None,
        start: if cfg!(any(target_os = "macos", target_os = "windows")) { Some("podmanMachine".into()) } else { None },
    };
    match version {
        Ok(out) => {
            let doc = cli::json_values(&out.stdout).into_iter().next().unwrap_or(Value::Null);
            info.version = doc.pointer("/Client/Version").and_then(Value::as_str).map(str::to_string);
            info.server_version = doc.pointer("/Server/Version").and_then(Value::as_str).map(str::to_string);
            // On Linux podman is daemonless: the client is the engine.
            info.running = info.server_version.is_some() || (cfg!(target_os = "linux") && out.ok());
            if !info.running {
                info.problem = Some(tidy_problem(&out.complaint()));
            }
        }
        Err(error) => info.problem = Some(error),
    }
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        info.provider = Some("Podman machine".into());
    }
    if let Ok(out) = cli::run(&program, &["system".into(), "connection".into(), "list".into(), "--format".into(), "json".into()], None, DETECT_TIMEOUT).await {
        for value in cli::json_values(&out.stdout) {
            let name = value.get("Name").and_then(Value::as_str).unwrap_or_default().to_string();
            if name.is_empty() {
                continue;
            }
            if value.get("Default").and_then(Value::as_bool).unwrap_or(false) {
                info.current_context = Some(name.clone());
            }
            info.contexts.push(ContextInfo { detail: value.get("URI").and_then(Value::as_str).unwrap_or_default().to_string(), name, namespace: String::new() });
        }
    }
    Some(info)
}

async fn detect_containerd() -> Option<RuntimeInfo> {
    let (id, binary) = match cli::find("nerdctl").or_else(|| cli::find("nerdctl.lima")) {
        Some(path) => ("nerdctl", path),
        None => ("ctr", cli::find("ctr")?),
    };
    let program = binary.to_string_lossy().into_owned();
    let mut info = RuntimeInfo {
        id: id.into(),
        provider: None,
        binary: program.clone(),
        version: None,
        server_version: None,
        running: false,
        problem: None,
        contexts: vec![],
        current_context: Some("default".into()),
        start: None,
    };
    if program.contains(".rd") || program.to_lowercase().contains("rancher") {
        info.provider = Some("Rancher Desktop".into());
        info.start = Some("rancherDesktop".into());
    } else if program.ends_with(".lima") {
        info.provider = Some("Lima".into());
    }
    let out = if id == "nerdctl" {
        cli::run(&program, &["version".into(), "--format".into(), "{{json .}}".into()], None, DETECT_TIMEOUT).await
    } else {
        cli::run(&program, &["version".into()], None, DETECT_TIMEOUT).await
    };
    match out {
        Ok(out) if id == "nerdctl" => {
            let doc = cli::json_values(&out.stdout).into_iter().next().unwrap_or(Value::Null);
            info.version = doc.pointer("/Client/Version").and_then(Value::as_str).map(str::to_string);
            info.server_version = doc
                .pointer("/Server/Components")
                .and_then(Value::as_array)
                .and_then(|list| list.iter().find(|c| c.get("Name").and_then(Value::as_str) == Some("containerd")))
                .and_then(|c| c.get("Version").and_then(Value::as_str))
                .map(str::to_string);
            info.running = out.ok() && info.server_version.is_some();
            if !info.running {
                info.problem = Some(tidy_problem(&out.complaint()));
            }
        }
        Ok(out) => {
            // `ctr version`: "Client:\n  Version: v2…\n…\nServer:\n  Version: v2…"
            let mut section = "";
            for line in out.stdout.lines() {
                let t = line.trim();
                if t.starts_with("Client") {
                    section = "client";
                } else if t.starts_with("Server") {
                    section = "server";
                } else if let Some(v) = t.strip_prefix("Version:") {
                    match section {
                        "client" => info.version = Some(v.trim().to_string()),
                        "server" => info.server_version = Some(v.trim().to_string()),
                        _ => {}
                    }
                }
            }
            info.running = info.server_version.is_some();
            if !info.running {
                info.problem = Some(tidy_problem(&out.complaint()));
            }
        }
        Err(error) => info.problem = Some(error),
    }
    if info.running {
        let target = engine::Target { runtime: id.into(), context: None };
        if let Ok(names) = engine::namespaces(&target).await {
            info.contexts = names.into_iter().map(|name| ContextInfo { name, detail: String::new(), namespace: String::new() }).collect();
        }
    }
    Some(info)
}

async fn detect_kubernetes() -> Option<RuntimeInfo> {
    let binary = cli::find("kubectl")?;
    let program = binary.to_string_lossy().into_owned();
    let version = cli::run(&program, &["version".into(), "--client".into(), "-o".into(), "json".into()], None, DETECT_TIMEOUT).await;
    let mut info = RuntimeInfo {
        id: "kubernetes".into(),
        provider: None,
        binary: program,
        version: None,
        server_version: None,
        running: true,
        problem: None,
        contexts: vec![],
        current_context: None,
        start: None,
    };
    if let Ok(out) = version {
        let doc = cli::json_values(&out.stdout).into_iter().next().unwrap_or(Value::Null);
        info.version = doc.pointer("/clientVersion/gitVersion").and_then(Value::as_str).map(str::to_string);
    }
    match kube::contexts().await {
        Ok((contexts, current)) => {
            info.contexts = contexts.into_iter().map(|c| ContextInfo { name: c.name, detail: c.cluster, namespace: c.namespace }).collect();
            info.current_context = current;
            if info.contexts.is_empty() {
                info.problem = Some("no contexts".into());
            }
        }
        Err(error) => info.problem = Some(tidy_problem(&error)),
    }
    Some(info)
}

/// Every runtime on this computer, asked all at once.
pub async fn detect() -> Vec<RuntimeInfo> {
    let (docker, podman, containerd, kubernetes) = tokio::join!(detect_docker(), detect_podman(), detect_containerd(), detect_kubernetes());
    [docker, podman, containerd, kubernetes].into_iter().flatten().collect()
}

/// Starts what provides a runtime: OrbStack, Docker Desktop, Colima, a Podman machine, Rancher Desktop.
pub async fn start_runtime(how: &str) -> Result<String, String> {
    let run = |program: &str, args: &[&str], seconds: u64| {
        let program = program.to_string();
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        async move {
            let binary = cli::find(&program).map(|p| p.to_string_lossy().into_owned()).unwrap_or(program.clone());
            cli::run_ok(&binary, &args, None, Duration::from_secs(seconds)).await
        }
    };
    match how {
        "orbstack" => run("orb", &["start"], 90).await,
        "colima" => run("colima", &["start"], 300).await,
        "podmanMachine" => run("podman", &["machine", "start"], 300).await,
        "rancherDesktop" => run("rdctl", &["start"], 60).await,
        "dockerDesktop" => {
            #[cfg(target_os = "macos")]
            {
                cli::run_ok("open", &["-a".into(), "Docker".into()], None, Duration::from_secs(20)).await
            }
            #[cfg(target_os = "windows")]
            {
                let exe = r"C:\Program Files\Docker\Docker\Docker Desktop.exe";
                crate::proc::std_command(exe).spawn().map(|_| String::new()).map_err(|e| format!("could not start Docker Desktop: {e}"))
            }
            #[cfg(target_os = "linux")]
            {
                cli::run_ok("systemctl", &["--user".into(), "start".into(), "docker-desktop".into()], None, Duration::from_secs(60)).await
            }
        }
        other => Err(format!("{other} cannot be started from here")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_from_endpoints() {
        assert_eq!(provider_of("unix:///Users/me/.orbstack/run/docker.sock").map(|p| p.0), Some("OrbStack"));
        assert_eq!(provider_of("unix:///Users/me/.docker/run/docker.sock").map(|p| p.0), Some("Docker Desktop"));
        assert_eq!(provider_of("npipe:////./pipe/docker_engine").map(|p| p.0), Some("Docker Desktop"));
        assert_eq!(provider_of("unix:///Users/me/.colima/default/docker.sock").map(|p| p.1), Some("colima"));
        assert_eq!(provider_of("unix:///var/run/docker.sock"), None);
    }

    #[test]
    fn a_daemon_that_is_down_reads_short() {
        assert_eq!(tidy_problem("failed to connect to the docker API at unix:///x.sock; check if the path is correct and if the daemon is running: dial unix /x.sock: connect: no such file or directory"), "not running");
        assert_eq!(tidy_problem("Cannot connect to Podman. Please verify your connection"), "not running");
        assert_eq!(tidy_problem("\n permission denied\n"), "permission denied");
    }
}
