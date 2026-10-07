//! The container engines that speak Docker's language — Docker itself, Podman and containerd's
//! `nerdctl` — plus containerd's bare `ctr`, for a machine that has nothing else.
//!
//! Each prints JSON for `ps`, `images`, `volume ls` and `network ls`, but not the same JSON: Docker
//! and nerdctl print one object per line with Go-template field names and everything as text
//! (`"Ports": "0.0.0.0:5432->5432/tcp"`, `"Labels": "a=b,c=d"`); Podman prints one array with typed
//! values (`"Ports": [{"host_port": 5432, …}]`, `"Labels": {…}`, `"Names": ["db"]`). This file reads
//! all of them into one shape, so the panel and the flow nodes never ask which engine answered.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::cli;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Docker,
    Podman,
    Nerdctl,
    Ctr,
}

impl EngineKind {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "docker" => Some(Self::Docker),
            "podman" => Some(Self::Podman),
            "nerdctl" => Some(Self::Nerdctl),
            "ctr" => Some(Self::Ctr),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
            Self::Nerdctl => "nerdctl",
            Self::Ctr => "ctr",
        }
    }

    /// The executable — `nerdctl.lima` stands in for `nerdctl` where Lima installed only that.
    pub fn program(self) -> String {
        if self == Self::Nerdctl && cli::find("nerdctl").is_none() && cli::find("nerdctl.lima").is_some() {
            return "nerdctl.lima".into();
        }
        cli::find(self.id()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| self.id().to_string())
    }
}

/// Where a command is aimed: the engine, and its context (Docker) or namespace (containerd).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub runtime: String,
    #[serde(default)]
    pub context: Option<String>,
}

impl Target {
    pub fn engine(&self) -> Result<EngineKind, String> {
        EngineKind::from_id(&self.runtime).ok_or_else(|| format!("{} is not a container engine", self.runtime))
    }

    /// The global flags that pick a context or namespace, before the subcommand.
    pub fn global_args(&self) -> Vec<String> {
        let Some(context) = self.context.as_deref().map(str::trim).filter(|c| !c.is_empty()) else { return vec![] };
        match self.engine() {
            Ok(EngineKind::Docker) => vec!["--context".into(), context.into()],
            Ok(EngineKind::Podman) => vec!["--connection".into(), context.into()],
            Ok(EngineKind::Nerdctl) | Ok(EngineKind::Ctr) => vec!["--namespace".into(), context.into()],
            Err(_) => vec![],
        }
    }

    pub async fn run(&self, args: &[&str], timeout: Duration) -> Result<String, String> {
        let engine = self.engine()?;
        let mut full = self.global_args();
        full.extend(args.iter().map(|a| a.to_string()));
        cli::run_ok(&engine.program(), &full, None, timeout).await
    }

    pub async fn run_owned(&self, args: Vec<String>, timeout: Duration) -> Result<cli::Output, String> {
        self.run_fed(args, None, timeout).await
    }

    /// [`Target::run_owned`] with `input` on the command's standard input — a script for an
    /// `exec -i … sh -s`, which never has to survive a command line that way.
    pub async fn run_fed(&self, args: Vec<String>, input: Option<&str>, timeout: Duration) -> Result<cli::Output, String> {
        let engine = self.engine()?;
        let mut full = self.global_args();
        full.extend(args);
        cli::run(&engine.program(), &full, input, timeout).await
    }

    /// Where this target's commands go: a socket on this computer (`unix://`, `npipe://`), or another
    /// machine (`ssh://`, `tcp://`). Empty for containerd, whose socket is always this computer's.
    pub async fn endpoint(&self) -> Result<String, String> {
        let context = self.context.as_deref().map(str::trim).filter(|c| !c.is_empty());
        if let Some(name) = context {
            check_ref(name)?;
        }
        match self.engine()? {
            EngineKind::Docker => {
                // Without a name, the current context — `DOCKER_HOST` and `DOCKER_CONTEXT` included.
                let mut args: Vec<String> = vec!["context".into(), "inspect".into()];
                args.extend(context.map(str::to_string));
                args.extend(["--format".into(), "{{.Endpoints.docker.Host}}".into()]);
                cli::run_ok(&EngineKind::Docker.program(), &args, None, LIST_TIMEOUT).await.map(|out| out.trim().to_string())
            }
            EngineKind::Podman => {
                let args: Vec<String> = ["system", "connection", "list", "--format", "json"].map(String::from).to_vec();
                let out = cli::run_ok(&EngineKind::Podman.program(), &args, None, LIST_TIMEOUT).await?;
                let connections = cli::json_values(&out);
                let chosen = connections.iter().find(|c| match context {
                    Some(name) => c.get("Name").and_then(Value::as_str) == Some(name),
                    None => c.get("Default").and_then(Value::as_bool) == Some(true),
                });
                Ok(chosen.and_then(|c| c.get("URI")).and_then(Value::as_str).unwrap_or_default().to_string())
            }
            EngineKind::Nerdctl | EngineKind::Ctr => Ok(String::new()),
        }
    }
}

/// Whether an engine endpoint is this computer: a socket, or a VM reached through localhost — a
/// Podman machine's connection is `ssh://core@127.0.0.1:…` and its files are the host's.
pub fn is_local_endpoint(endpoint: &str) -> bool {
    let endpoint = endpoint.trim().to_lowercase();
    let Some((scheme, rest)) = endpoint.split_once("://") else { return true };
    if matches!(scheme, "unix" | "npipe" | "fd") {
        return true;
    }
    let authority = rest.split('/').next().unwrap_or_default();
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = match host_port.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next().unwrap_or_default(),
        None => host_port.split(':').next().unwrap_or_default(),
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// A container, image, volume or network as the engines' commands take it: refused when it could be
/// read as a flag — an image "named" `--privileged`, from a flow's upstream data — or is not one word.
pub fn check_ref(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.starts_with('-') || value.contains(|c: char| c.is_whitespace() || c.is_control()) {
        Err(format!("\"{value}\" is not a container, image, volume or network"))
    } else {
        Ok(())
    }
}

pub const LIST_TIMEOUT: Duration = Duration::from_secs(15);
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(120);
/// An hour for what downloads: a multi-gigabyte image, or every image of a Compose project, does not
/// fit in two minutes. Started by hand or by a flow (which cancels it), so this only stops a tool
/// that hangs.
pub const PULL_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// How long one action may take: [`PULL_TIMEOUT`] for those that may download — a pull, a `run` of an
/// image not here yet, a project's `up` or `pull` — and [`ACTION_TIMEOUT`] for the rest.
fn action_timeout(object: &str, action: &str) -> Duration {
    match (object, action) {
        ("image", "pull" | "run") | ("project", "up" | "pull") => PULL_TIMEOUT,
        _ => ACTION_TIMEOUT,
    }
}

// ------------------------------------------------------------------------------------- reading

/// A field under any of the spellings the engines use.
fn get<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| value.get(*name)).filter(|v| !v.is_null())
}

fn text(value: &Value, names: &[&str]) -> String {
    match get(value, names) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// `a=b,c=d` (Docker, nerdctl) or `{"a":"b"}` (Podman) as a map.
pub fn labels(value: &Value) -> BTreeMap<String, String> {
    match get(value, &["Labels", "labels"]) {
        Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))).collect(),
        Some(Value::String(raw)) => {
            let mut out = BTreeMap::new();
            let mut last: Option<String> = None;
            for part in raw.split(',') {
                match part.split_once('=') {
                    Some((key, val)) if !key.contains(' ') && !key.is_empty() => {
                        out.insert(key.to_string(), val.to_string());
                        last = Some(key.to_string());
                    }
                    // A comma inside a value (`config_files=a.yml,b.yml`): it belongs to the label before.
                    _ => {
                        if let Some(key) = &last {
                            if let Some(existing) = out.get_mut(key) {
                                existing.push(',');
                                existing.push_str(part);
                            }
                        }
                    }
                }
            }
            out
        }
        _ => BTreeMap::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortMap {
    pub host_ip: String,
    pub host_port: Option<u16>,
    pub container_port: u16,
    pub protocol: String,
}

/// Docker's `0.0.0.0:5432->5432/tcp, :::5432->5432/tcp, 6379/tcp` — the IPv6 twin of a mapping is
/// dropped, since it publishes the same port.
pub fn parse_port_text(raw: &str) -> Vec<PortMap> {
    let mut out: Vec<PortMap> = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (left, right) = match part.split_once("->") {
            Some((host, container)) => (Some(host), container),
            None => (None, part),
        };
        let (container_port, protocol) = match right.split_once('/') {
            Some((port, proto)) => (port, proto),
            None => (right, "tcp"),
        };
        // A range (`8000-8002/tcp`) keeps its first port: the row links to one.
        let first = |p: &str| p.split('-').next().unwrap_or(p).trim().parse::<u16>().ok();
        let Some(container_port) = first(container_port) else { continue };
        let (host_ip, host_port) = match left {
            Some(host) => match host.rsplit_once(':') {
                Some((ip, port)) => (ip.trim_matches(['[', ']']).to_string(), first(port)),
                None => (String::new(), first(host)),
            },
            None => (String::new(), None),
        };
        let mapping = PortMap { host_ip, host_port, container_port, protocol: protocol.to_string() };
        let twin = out.iter().any(|m| m.host_port == mapping.host_port && m.container_port == mapping.container_port && m.protocol == mapping.protocol);
        if !twin {
            out.push(mapping);
        }
    }
    out
}

fn ports(value: &Value) -> Vec<PortMap> {
    match get(value, &["Ports", "ports"]) {
        Some(Value::String(raw)) => parse_port_text(raw),
        Some(Value::Array(list)) => {
            let mut out: Vec<PortMap> = Vec::new();
            for entry in list {
                let number = |names: &[&str]| get(entry, names).and_then(Value::as_u64).map(|n| n as u16);
                let Some(container_port) = number(&["container_port", "containerPort", "PrivatePort"]) else { continue };
                let host_port = number(&["host_port", "hostPort", "PublicPort"]).filter(|p| *p != 0);
                let mapping = PortMap {
                    host_ip: text(entry, &["host_ip", "hostIP", "IP"]),
                    host_port,
                    container_port,
                    protocol: {
                        let p = text(entry, &["protocol", "Type"]);
                        if p.is_empty() { "tcp".into() } else { p }
                    },
                };
                if !out.iter().any(|m| m.host_port == mapping.host_port && m.container_port == mapping.container_port && m.protocol == mapping.protocol) {
                    out.push(mapping);
                }
            }
            out
        }
        _ => vec![],
    }
}

/// `running`, `exited`, `paused`, `created`, `restarting`, `dead`, `removing` — from the state an
/// engine reports, or from the status text (`Up 2 hours`, `Exited (0) 3 minutes ago`) of one that
/// reports none (older nerdctl).
pub fn state_of(state: &str, status: &str) -> String {
    let state = state.trim().to_lowercase();
    if !state.is_empty() && state != "unknown" {
        return match state.as_str() {
            "up" => "running".into(),
            "stopped" | "configured" => "exited".into(),
            other => other.to_string(),
        };
    }
    let status = status.trim().to_lowercase();
    if status.starts_with("up") {
        if status.contains("paused") { "paused".into() } else { "running".into() }
    } else if status.starts_with("exited") {
        "exited".into()
    } else if status.starts_with("created") {
        "created".into()
    } else if status.starts_with("restarting") {
        "restarting".into()
    } else if status.starts_with("dead") {
        "dead".into()
    } else if status.starts_with("removal") || status.starts_with("removing") {
        "removing".into()
    } else if status.is_empty() {
        "unknown".into()
    } else {
        status.split_whitespace().next().unwrap_or("unknown").to_string()
    }
}

/// `healthy`, `unhealthy`, `starting` — from `Up 2 hours (healthy)`; empty without a health check.
pub fn health_of(status: &str) -> String {
    let lower = status.to_lowercase();
    for word in ["unhealthy", "healthy", "health: starting", "starting"] {
        if lower.contains(&format!("({word})")) {
            return word.trim_start_matches("health: ").to_string();
        }
    }
    String::new()
}

/// The exit code a stopped container's status names: `Exited (137) 2 minutes ago`.
fn exit_code_of(status: &str) -> Option<i64> {
    let lower = status.to_lowercase();
    let rest = lower.strip_prefix("exited")?.trim_start();
    let inner = rest.strip_prefix('(')?;
    inner.split(')').next()?.trim().parse().ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRow {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub health: String,
    pub exit_code: Option<i64>,
    pub ports: Vec<PortMap>,
    pub created: String,
    pub command: String,
    /// The Compose project and service it belongs to, when Compose (or podman-compose) made it.
    pub project: String,
    pub service: String,
    pub project_dir: String,
    pub config_files: String,
    /// A Podman pod's name.
    pub pod: String,
    pub labels: BTreeMap<String, String>,
}

pub fn parse_containers(text_out: &str) -> Vec<ContainerRow> {
    cli::json_values(text_out)
        .iter()
        .map(|value| {
            let labels = labels(value);
            let status = text(value, &["Status", "status"]);
            let label = |key: &str| labels.get(key).cloned().unwrap_or_default();
            let project = {
                let compose = label("com.docker.compose.project");
                if compose.is_empty() { label("io.podman.compose.project") } else { compose }
            };
            let name = {
                let raw = text(value, &["Names", "names", "Name"]);
                raw.split(',').next().unwrap_or_default().trim_start_matches('/').to_string()
            };
            let id = text(value, &["ID", "Id", "id"]);
            let created = match get(value, &["CreatedAt", "Created"]) {
                Some(Value::Number(n)) => n.as_i64().and_then(|s| chrono::DateTime::from_timestamp(s, 0)).map(|d| d.to_rfc3339()).unwrap_or_default(),
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            let exit_code = get(value, &["ExitCode"]).and_then(Value::as_i64).filter(|_| value.get("Exited").and_then(Value::as_bool).unwrap_or(false)).or_else(|| exit_code_of(&status));
            ContainerRow {
                id,
                name,
                image: text(value, &["Image", "image"]),
                state: state_of(&text(value, &["State", "state"]), &status),
                health: health_of(&status),
                status,
                exit_code,
                ports: ports(value),
                created,
                command: text(value, &["Command", "command"]).trim_matches('"').to_string(),
                service: {
                    let s = label("com.docker.compose.service");
                    if s.is_empty() { label("io.podman.compose.service") } else { s }
                },
                project_dir: label("com.docker.compose.project.working_dir"),
                config_files: label("com.docker.compose.project.config_files"),
                project,
                pod: text(value, &["PodName", "Pod"]).trim().to_string(),
                labels,
            }
        })
        .filter(|row| !row.id.is_empty())
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRow {
    pub id: String,
    pub repository: String,
    pub tag: String,
    /// `repository:tag`, or the id for a dangling image.
    pub reference: String,
    pub size: String,
    pub size_bytes: Option<u64>,
    pub created: String,
    pub dangling: bool,
    pub containers: Option<u64>,
}

/// `431MB`, `1.2GB`, `612kB` as bytes (decimal units, as Docker prints them).
pub fn bytes_of(size: &str) -> Option<u64> {
    let s = size.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic())?;
    let (number, unit) = s.split_at(split);
    let number: f64 = number.trim().parse().ok()?;
    let factor: f64 = match unit.trim().to_lowercase().as_str() {
        "b" => 1.0,
        "kb" | "k" => 1e3,
        "mb" | "m" => 1e6,
        "gb" | "g" => 1e9,
        "tb" | "t" => 1e12,
        "kib" => 1024.0,
        "mib" => 1024.0 * 1024.0,
        "gib" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((number * factor).round() as u64)
}

pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "kB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 { format!("{bytes} B") } else { format!("{value:.1} {}", UNITS[unit]) }
}

pub fn parse_images(text_out: &str) -> Vec<ImageRow> {
    let mut out = Vec::new();
    for value in cli::json_values(text_out) {
        let id = text(&value, &["ID", "Id", "id"]).trim_start_matches("sha256:").to_string();
        let size_bytes = get(&value, &["Size", "size"]).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(bytes_of)));
        let size = match get(&value, &["Size"]) {
            Some(Value::String(s)) => s.clone(),
            _ => size_bytes.map(human_bytes).unwrap_or_default(),
        };
        let created = match get(&value, &["CreatedAt", "Created"]) {
            Some(Value::Number(n)) => n.as_i64().and_then(|s| chrono::DateTime::from_timestamp(s, 0)).map(|d| d.to_rfc3339()).unwrap_or_default(),
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        let containers = get(&value, &["Containers"]).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
        // Podman lists every tag of one image in `RepoTags`; Docker prints one line per tag.
        let tags: Vec<String> = match get(&value, &["RepoTags", "Names"]) {
            Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            _ => {
                let repository = text(&value, &["Repository", "repository"]);
                let tag = text(&value, &["Tag", "tag"]);
                if repository.is_empty() || repository == "<none>" { vec![] } else { vec![format!("{repository}:{tag}")] }
            }
        };
        let short = id.chars().take(12).collect::<String>();
        if tags.is_empty() {
            out.push(ImageRow { id: id.clone(), repository: "<none>".into(), tag: "<none>".into(), reference: short, size: size.clone(), size_bytes, created: created.clone(), dangling: true, containers });
            continue;
        }
        for reference in tags {
            let (repository, tag) = match reference.rsplit_once(':') {
                Some((repo, tag)) if !tag.contains('/') => (repo.to_string(), tag.to_string()),
                _ => (reference.clone(), "latest".to_string()),
            };
            let dangling = tag == "<none>";
            out.push(ImageRow {
                id: id.clone(),
                reference: if dangling { short.clone() } else { format!("{repository}:{tag}") },
                repository,
                tag,
                size: size.clone(),
                size_bytes,
                created: created.clone(),
                dangling,
                containers,
            });
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeRow {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub project: String,
    pub labels: BTreeMap<String, String>,
}

pub fn parse_volumes(text_out: &str) -> Vec<VolumeRow> {
    cli::json_values(text_out)
        .iter()
        .map(|value| {
            let labels = labels(value);
            VolumeRow {
                name: text(value, &["Name", "name"]),
                driver: text(value, &["Driver", "driver"]),
                mountpoint: text(value, &["Mountpoint", "mountpoint"]),
                project: labels.get("com.docker.compose.project").cloned().unwrap_or_default(),
                labels,
            }
        })
        .filter(|row| !row.name.is_empty())
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRow {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    /// One of the engine's own networks (`bridge`, `host`, `none`, `podman`), which cannot be removed.
    pub builtin: bool,
}

pub fn parse_networks(text_out: &str) -> Vec<NetworkRow> {
    cli::json_values(text_out)
        .iter()
        .map(|value| {
            let name = text(value, &["Name", "name"]);
            NetworkRow {
                id: text(value, &["ID", "Id", "id"]),
                builtin: matches!(name.as_str(), "bridge" | "host" | "none" | "podman" | "default"),
                name,
                driver: text(value, &["Driver", "driver"]),
                scope: text(value, &["Scope", "scope"]),
            }
        })
        .filter(|row| !row.name.is_empty())
        .collect()
}

// ------------------------------------------------------------------------------------ listing

/// What a list of one engine holds: the rows, or why it could not be read.
pub async fn list(target: &Target, what: &str) -> Result<Value, String> {
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return ctr_list(target, what).await;
    }
    let json_fmt = |args: &[&str]| -> Vec<String> {
        let mut out: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        out.push("--format".into());
        out.push(if engine == EngineKind::Podman { "json".into() } else { "{{json .}}".into() });
        out
    };
    let run = |args: Vec<String>| async move {
        let output = target.run_owned(args, LIST_TIMEOUT).await?;
        if output.ok() { Ok(output.stdout) } else { Err(output.complaint()) }
    };
    Ok(match what {
        "containers" => json!(parse_containers(&run(json_fmt(&["ps", "-a", "--no-trunc"])).await?)),
        "images" => json!(parse_images(&run(json_fmt(&["images"])).await?)),
        "volumes" => json!(parse_volumes(&run(json_fmt(&["volume", "ls"])).await?)),
        "networks" => json!(parse_networks(&run(json_fmt(&["network", "ls"])).await?)),
        other => return Err(format!("unknown list {other}")),
    })
}

/// The containers of an engine, typed — what the flow nodes and triggers read.
pub async fn list_containers(target: &Target) -> Result<Vec<ContainerRow>, String> {
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        let value = ctr_list(target, "containers").await?;
        return Ok(value
            .as_array()
            .map(|rows| rows.iter().filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_string)).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .map(|id| ContainerRow {
                name: id.clone(),
                id,
                image: String::new(),
                state: "unknown".into(),
                status: String::new(),
                health: String::new(),
                exit_code: None,
                ports: vec![],
                created: String::new(),
                command: String::new(),
                project: String::new(),
                service: String::new(),
                project_dir: String::new(),
                config_files: String::new(),
                pod: String::new(),
                labels: BTreeMap::new(),
            })
            .collect());
    }
    let format = if engine == EngineKind::Podman { "json" } else { "{{json .}}" };
    let out = target.run(&["ps", "-a", "--no-trunc", "--format", format], LIST_TIMEOUT).await?;
    Ok(parse_containers(&out))
}

/// containerd's own client: names only, read from its plain tables.
async fn ctr_list(target: &Target, what: &str) -> Result<Value, String> {
    let lines = |out: String| out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect::<Vec<_>>();
    match what {
        "containers" => {
            let ids = lines(target.run(&["containers", "list", "-q"], LIST_TIMEOUT).await?);
            // `tasks list`: TASK PID STATUS — what is running.
            let tasks = target.run(&["tasks", "list"], LIST_TIMEOUT).await.unwrap_or_default();
            let running: BTreeMap<String, String> = tasks
                .lines()
                .skip(1)
                .filter_map(|line| {
                    let cols: Vec<&str> = line.split_whitespace().collect();
                    (cols.len() >= 3).then(|| (cols[0].to_string(), cols[2].to_lowercase()))
                })
                .collect();
            Ok(json!(ids
                .into_iter()
                .map(|id| {
                    let state = running.get(&id).cloned().unwrap_or_else(|| "created".into());
                    ContainerRow {
                        name: id.clone(),
                        id,
                        image: String::new(),
                        status: state.clone(),
                        state: if state == "stopped" { "exited".into() } else { state },
                        health: String::new(),
                        exit_code: None,
                        ports: vec![],
                        created: String::new(),
                        command: String::new(),
                        project: String::new(),
                        service: String::new(),
                        project_dir: String::new(),
                        config_files: String::new(),
                        pod: String::new(),
                        labels: BTreeMap::new(),
                    }
                })
                .collect::<Vec<_>>()))
        }
        "images" => {
            let refs = lines(target.run(&["images", "list", "-q"], LIST_TIMEOUT).await?);
            Ok(json!(refs
                .into_iter()
                .map(|reference| {
                    let (repository, tag) = reference.rsplit_once(':').map(|(r, t)| (r.to_string(), t.to_string())).unwrap_or((reference.clone(), String::new()));
                    ImageRow { id: reference.clone(), repository, tag, reference, size: String::new(), size_bytes: None, created: String::new(), dangling: false, containers: None }
                })
                .collect::<Vec<_>>()))
        }
        "volumes" | "networks" => Ok(json!([])),
        other => Err(format!("unknown list {other}")),
    }
}

/// containerd's namespaces (`default`, `k8s.io`, `moby`, `buildkit`), for its picker.
pub async fn namespaces(target: &Target) -> Result<Vec<String>, String> {
    let bare = Target { runtime: target.runtime.clone(), context: None };
    let out = match target.engine()? {
        EngineKind::Nerdctl => bare.run(&["namespace", "ls", "-q"], LIST_TIMEOUT).await?,
        EngineKind::Ctr => bare.run(&["namespaces", "list", "-q"], LIST_TIMEOUT).await?,
        _ => return Ok(vec![]),
    };
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

// ------------------------------------------------------------------------------------ acting

/// Whether a Compose command needs the project's files. Docker Compose finds a project's containers
/// by its label, so everything but `up` and `pull` (which build the project from its files) runs on
/// the name alone — and a file a label names may be gone (a checkout moved since) or another
/// machine's (a project started there, on a remote engine). podman-compose and nerdctl compose read
/// the files for every command, so those keep the ones still on this computer.
pub fn compose_reads_files(engine: EngineKind, action: &str) -> bool {
    matches!(action, "up" | "pull") || engine != EngineKind::Docker
}

/// A Compose project's folder and files as its labels name them, kept only where they are on this
/// computer — and only when the engine is this computer's: a remote engine's project may name paths
/// that happen to exist here holding something else.
async fn local_compose(target: &Target, options: &Value) -> Value {
    let named = |key: &str| options.get(key).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    let (dir, files) = (named("projectDir"), named("configFiles"));
    let mut out = if options.is_object() { options.clone() } else { json!({}) };
    if dir.is_empty() && files.is_empty() {
        return out;
    }
    // Unknown is taken for local, as before this was asked: the command that follows says why if not.
    let local = target.endpoint().await.map(|endpoint| is_local_endpoint(&endpoint)).unwrap_or(true);
    let kept: Vec<&str> = files.split(',').map(str::trim).filter(|f| local && !f.is_empty() && Path::new(f).is_file()).collect();
    out["configFiles"] = json!(kept.join(","));
    out["projectDir"] = json!(if local && Path::new(&dir).is_dir() { dir } else { String::new() });
    out
}

/// The command line of one action — its own function so it can be checked without an engine.
pub fn action_args(engine: EngineKind, object: &str, action: &str, ids: &[String], options: &Value) -> Result<Vec<String>, String> {
    let opt = |name: &str| options.get(name).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    let flag = |name: &str| options.get(name).and_then(Value::as_bool).unwrap_or(false);
    let need_ids = || if ids.is_empty() { Err("nothing was chosen".to_string()) } else { Ok(()) };
    // Every id is a positional argument: one that starts with `-` would be read as a flag.
    for id in ids {
        check_ref(id)?;
    }
    let mut args: Vec<String> = Vec::new();
    if engine == EngineKind::Ctr {
        need_ids()?;
        match (object, action) {
            ("container", "stop") | ("container", "kill") => args.extend(["tasks".into(), "kill".into(), "--signal".into(), if action == "kill" { "SIGKILL".into() } else { "SIGTERM".into() }]),
            ("container", "start") => args.extend(["tasks".into(), "start".into(), "--detach".into()]),
            ("container", "remove") => args.extend(["containers".into(), "delete".into()]),
            ("image", "remove") => args.extend(["images".into(), "delete".into()]),
            _ => return Err(format!("ctr cannot {action} a {object}")),
        }
        args.extend(ids.iter().cloned());
        return Ok(args);
    }
    match (object, action) {
        ("container", "start" | "stop" | "restart" | "pause" | "unpause" | "kill") => {
            need_ids()?;
            args.push(action.into());
            args.extend(ids.iter().cloned());
        }
        ("container", "remove") => {
            need_ids()?;
            args.extend(["rm".into(), "-f".into()]);
            if flag("volumes") {
                args.push("-v".into());
            }
            args.extend(ids.iter().cloned());
        }
        ("container", "rename") => {
            need_ids()?;
            let name = opt("name");
            if name.is_empty() {
                return Err("write the new name".into());
            }
            check_ref(&name)?;
            args.extend(["rename".into(), ids[0].clone(), name]);
        }
        ("container", "prune") => args.extend(["container".into(), "prune".into(), "-f".into()]),
        ("image", "remove") => {
            need_ids()?;
            args.push("rmi".into());
            if flag("force") {
                args.push("-f".into());
            }
            args.extend(ids.iter().cloned());
        }
        ("image", "pull") => {
            let reference = if ids.is_empty() { opt("reference") } else { ids[0].clone() };
            if reference.is_empty() {
                return Err("write the image to pull".into());
            }
            check_ref(&reference)?;
            args.extend(["pull".into(), reference]);
        }
        ("image", "prune") => {
            args.extend(["image".into(), "prune".into(), "-f".into()]);
            if flag("all") {
                args.push("-a".into());
            }
        }
        ("image", "run") => {
            need_ids()?;
            args.extend(["run".into(), "-d".into()]);
            let name = opt("name");
            if !name.is_empty() {
                args.extend(["--name".into(), name]);
            }
            for port in opt("ports").split([',', ' ']).map(str::trim).filter(|p| !p.is_empty()) {
                args.extend(["-p".into(), port.to_string()]);
            }
            for line in opt("env").lines().map(str::trim).filter(|l| l.contains('=')) {
                args.extend(["-e".into(), line.to_string()]);
            }
            for volume in opt("volumes").lines().map(str::trim).filter(|l| l.contains(':')) {
                args.extend(["-v".into(), volume.to_string()]);
            }
            if flag("remove") {
                args.push("--rm".into());
            }
            args.push(ids[0].clone());
            let command = opt("command");
            if !command.is_empty() {
                args.extend(["sh".into(), "-c".into(), command]);
            }
        }
        ("volume", "remove") => {
            need_ids()?;
            args.extend(["volume".into(), "rm".into()]);
            args.extend(ids.iter().cloned());
        }
        ("volume", "prune") => args.extend(["volume".into(), "prune".into(), "-f".into()]),
        ("network", "remove") => {
            need_ids()?;
            args.extend(["network".into(), "rm".into()]);
            args.extend(ids.iter().cloned());
        }
        ("network", "prune") => args.extend(["network".into(), "prune".into(), "-f".into()]),
        ("project", "up" | "down" | "stop" | "start" | "restart" | "pull") => {
            need_ids()?;
            args.push("compose".into());
            args.extend(["-p".into(), ids[0].clone()]);
            if compose_reads_files(engine, action) {
                let dir = opt("projectDir");
                let files = opt("configFiles");
                let files: Vec<&str> = files.split(',').map(str::trim).filter(|f| !f.is_empty()).collect();
                if files.is_empty() && matches!(action, "up" | "pull") {
                    return Err(format!("the compose files of {} are not on this computer", ids[0]));
                }
                if !dir.is_empty() && engine != EngineKind::Podman {
                    args.extend(["--project-directory".into(), dir]);
                }
                for file in files {
                    args.extend(["-f".into(), file.to_string()]);
                }
            }
            args.push(action.into());
            if action == "up" {
                args.push("-d".into());
            }
            if action == "down" && flag("volumes") {
                args.push("-v".into());
            }
        }
        _ => return Err(format!("cannot {action} a {object}")),
    }
    Ok(args)
}

/// Runs one action and answers with what the engine printed.
pub async fn act(target: &Target, object: &str, action: &str, ids: &[String], options: &Value) -> Result<String, String> {
    let engine = target.engine()?;
    let options = if object == "project" && compose_reads_files(engine, action) { local_compose(target, options).await } else { options.clone() };
    let args = action_args(engine, object, action, ids, &options)?;
    if object == "container" && action == "remove" && engine != EngineKind::Ctr {
        // `rm -f` alone kills a running container outright. It is asked to stop first, with the grace
        // `stop` gives it — as the confirmation promises — and `rm -f` then takes whatever is left (one
        // paused, one that ignored the signal). A container already stopped answers `stop` at once.
        let stop = action_args(engine, "container", "stop", ids, &options)?;
        let _ = target.run_owned(stop, ACTION_TIMEOUT).await;
    }
    let output = target.run_owned(args, action_timeout(object, action)).await?;
    if output.ok() {
        Ok(format!("{}{}", output.stdout.trim(), if output.stderr.trim().is_empty() { String::new() } else { format!("\n{}", output.stderr.trim()) }).trim().to_string())
    } else {
        Err(output.complaint())
    }
}

/// `inspect` of one object, as pretty JSON text.
pub async fn inspect(target: &Target, object: &str, id: &str) -> Result<String, String> {
    let engine = target.engine()?;
    check_ref(id)?;
    let args: Vec<&str> = match (engine, object) {
        (EngineKind::Ctr, "container") => vec!["containers", "info", id],
        (EngineKind::Ctr, _) => return Err("ctr shows containers only".into()),
        (_, "container") => vec!["container", "inspect", id],
        (_, "image") => vec!["image", "inspect", id],
        (_, "volume") => vec!["volume", "inspect", id],
        (_, "network") => vec!["network", "inspect", id],
        _ => return Err(format!("cannot inspect a {object}")),
    };
    let out = target.run(&args, LIST_TIMEOUT).await?;
    let value: Value = serde_json::from_str(out.trim()).unwrap_or(Value::String(out.clone()));
    let single = match value {
        Value::Array(mut list) if list.len() == 1 => list.remove(0),
        other => other,
    };
    Ok(serde_json::to_string_pretty(&single).unwrap_or(out))
}

/// What a running container uses now: CPU, memory, network and disk, process count.
pub async fn stats(target: &Target, id: &str) -> Result<Value, String> {
    let engine = target.engine()?;
    check_ref(id)?;
    if engine == EngineKind::Ctr {
        return Ok(json!({}));
    }
    let format = if engine == EngineKind::Podman { "json" } else { "{{json .}}" };
    let out = target.run(&["stats", "--no-stream", "--format", format, id], LIST_TIMEOUT).await?;
    let value = cli::json_values(&out).into_iter().next().unwrap_or(Value::Null);
    let pick = |names: &[&str]| text(&value, names);
    Ok(json!({
        "cpu": pick(&["CPUPerc", "cpu_percent", "CPU"]),
        "memory": pick(&["MemUsage", "mem_usage", "MemUsageBytes"]),
        "memoryPercent": pick(&["MemPerc", "mem_percent"]),
        "network": pick(&["NetIO", "net_io"]),
        "disk": pick(&["BlockIO", "block_io"]),
        "processes": pick(&["PIDs", "pids"]),
    }))
}

/// The inspect document of a container read into what its detail shows.
pub fn summary_of_inspect(doc: &Value) -> Value {
    let env: Vec<Value> = doc
        .pointer("/Config/Env")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(|line| {
                    let (name, value) = line.split_once('=').unwrap_or((line, ""));
                    json!({"name": name, "value": value, "secret": looks_secret(name)})
                })
                .collect()
        })
        .unwrap_or_default();
    let mounts: Vec<Value> = doc
        .get("Mounts")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|m| {
                    json!({
                        "type": text(m, &["Type"]),
                        "source": text(m, &["Source", "Name"]),
                        "destination": text(m, &["Destination"]),
                        "readOnly": !m.get("RW").and_then(Value::as_bool).unwrap_or(true),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let networks: Vec<Value> = doc
        .pointer("/NetworkSettings/Networks")
        .and_then(Value::as_object)
        .map(|map| map.iter().map(|(name, n)| json!({"name": name, "ip": text(n, &["IPAddress"])})).collect())
        .unwrap_or_default();
    let mut port_list: Vec<PortMap> = Vec::new();
    if let Some(map) = doc.pointer("/NetworkSettings/Ports").and_then(Value::as_object) {
        for (key, bindings) in map {
            let (port, proto) = key.split_once('/').unwrap_or((key, "tcp"));
            let Ok(container_port) = port.parse::<u16>() else { continue };
            match bindings.as_array() {
                Some(list) if !list.is_empty() => {
                    for b in list {
                        let mapping = PortMap {
                            host_ip: text(b, &["HostIp"]),
                            host_port: text(b, &["HostPort"]).parse().ok(),
                            container_port,
                            protocol: proto.to_string(),
                        };
                        if !port_list.iter().any(|m| m.host_port == mapping.host_port && m.container_port == mapping.container_port) {
                            port_list.push(mapping);
                        }
                    }
                }
                _ => port_list.push(PortMap { host_ip: String::new(), host_port: None, container_port, protocol: proto.to_string() }),
            }
        }
    }
    port_list.sort_by_key(|p| p.container_port);
    let health_log: Vec<Value> = doc
        .pointer("/State/Health/Log")
        .and_then(Value::as_array)
        .map(|list| list.iter().rev().take(3).map(|e| json!({"exitCode": e.get("ExitCode"), "output": text(e, &["Output"]).trim(), "end": text(e, &["End"])})).collect())
        .unwrap_or_default();
    json!({
        "image": doc.pointer("/Config/Image").cloned().unwrap_or(Value::Null),
        "command": doc.pointer("/Config/Cmd").cloned().unwrap_or(Value::Null),
        "entrypoint": doc.pointer("/Config/Entrypoint").cloned().unwrap_or(Value::Null),
        "workingDir": doc.pointer("/Config/WorkingDir").cloned().unwrap_or(Value::Null),
        "created": doc.get("Created").cloned().unwrap_or(Value::Null),
        "startedAt": doc.pointer("/State/StartedAt").cloned().unwrap_or(Value::Null),
        "finishedAt": doc.pointer("/State/FinishedAt").cloned().unwrap_or(Value::Null),
        "exitCode": doc.pointer("/State/ExitCode").cloned().unwrap_or(Value::Null),
        "oomKilled": doc.pointer("/State/OOMKilled").cloned().unwrap_or(Value::Null),
        "restartCount": doc.get("RestartCount").cloned().unwrap_or(Value::Null),
        "restartPolicy": doc.pointer("/HostConfig/RestartPolicy/Name").cloned().unwrap_or(Value::Null),
        "health": doc.pointer("/State/Health/Status").cloned().unwrap_or(Value::Null),
        "healthLog": health_log,
        "env": env,
        "mounts": mounts,
        "networks": networks,
        "ports": port_list,
        "labels": doc.pointer("/Config/Labels").cloned().unwrap_or_else(|| json!({})),
    })
}

/// A variable whose value should be hidden until asked for: tokens, passwords, keys.
pub fn looks_secret(name: &str) -> bool {
    let upper = name.to_uppercase();
    ["PASSWORD", "PASSWD", "SECRET", "TOKEN", "API_KEY", "APIKEY", "PRIVATE", "CREDENTIAL", "_KEY", "AUTH"].iter().any(|w| upper.contains(w))
}

/// A container row as an item for a flow: the fields a node after it reads.
pub fn row_item(row: &ContainerRow) -> Value {
    let mut item = Map::new();
    item.insert("id".into(), json!(row.id));
    item.insert("shortId".into(), json!(row.id.chars().take(12).collect::<String>()));
    item.insert("name".into(), json!(row.name));
    item.insert("image".into(), json!(row.image));
    item.insert("state".into(), json!(row.state));
    item.insert("status".into(), json!(row.status));
    item.insert("health".into(), json!(row.health));
    item.insert("exitCode".into(), json!(row.exit_code));
    item.insert("ports".into(), json!(row.ports));
    item.insert("project".into(), json!(row.project));
    item.insert("service".into(), json!(row.service));
    item.insert("created".into(), json!(row.created));
    item.insert("labels".into(), json!(row.labels));
    Value::Object(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCKER_PS: &str = r#"{"Command":"\"docker-entrypoint.s…\"","CreatedAt":"2026-10-01 10:00:00 -0300 -03","ID":"4f2c1a9b8d7e","Image":"postgres:16","Labels":"com.docker.compose.project=shop,com.docker.compose.service=db,com.docker.compose.project.working_dir=/Users/me/shop,com.docker.compose.project.config_files=/Users/me/shop/compose.yaml,/Users/me/shop/compose.dev.yaml","Names":"shop-db-1","Ports":"0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp","State":"running","Status":"Up 2 hours (healthy)"}
{"Command":"\"nginx -g…\"","CreatedAt":"2026-10-01 10:00:00 -0300 -03","ID":"9a8b7c6d5e4f","Image":"nginx","Labels":"","Names":"web","Ports":"","State":"exited","Status":"Exited (137) 5 minutes ago"}"#;

    const PODMAN_PS: &str = r#"[{"Command":["postgres"],"Created":1759322400,"Exited":false,"ExitCode":0,"Id":"abc123","Image":"docker.io/library/postgres:16","Labels":{"io.podman.compose.project":"shop","com.docker.compose.service":"db"},"Names":["db"],"Ports":[{"host_ip":"","container_port":5432,"host_port":5432,"range":1,"protocol":"tcp"}],"State":"running","Status":"Up 2 hours","PodName":""}]"#;

    #[test]
    fn docker_and_podman_rows_read_the_same() {
        let docker = parse_containers(DOCKER_PS);
        assert_eq!(docker.len(), 2);
        assert_eq!(docker[0].name, "shop-db-1");
        assert_eq!(docker[0].state, "running");
        assert_eq!(docker[0].health, "healthy");
        assert_eq!(docker[0].project, "shop");
        assert_eq!(docker[0].service, "db");
        assert_eq!(docker[0].config_files, "/Users/me/shop/compose.yaml,/Users/me/shop/compose.dev.yaml", "a comma inside a label value stays in it");
        assert_eq!(docker[0].ports, vec![PortMap { host_ip: "0.0.0.0".into(), host_port: Some(5432), container_port: 5432, protocol: "tcp".into() }]);
        assert_eq!(docker[1].state, "exited");
        assert_eq!(docker[1].exit_code, Some(137));

        let podman = parse_containers(PODMAN_PS);
        assert_eq!(podman[0].name, "db");
        assert_eq!(podman[0].project, "shop");
        assert_eq!(podman[0].ports[0].host_port, Some(5432));
        assert!(podman[0].created.starts_with("2025-10-01T12:40:00"), "a unix time reads as RFC 3339: {}", podman[0].created);
    }

    #[test]
    fn state_comes_from_the_status_when_none_is_given() {
        assert_eq!(state_of("", "Up 3 minutes"), "running");
        assert_eq!(state_of("", "Up 3 minutes (Paused)"), "paused");
        assert_eq!(state_of("", "Exited (0) 2 hours ago"), "exited");
        assert_eq!(state_of("", "Created"), "created");
        assert_eq!(state_of("Up", ""), "running");
        assert_eq!(health_of("Up 1 minute (health: starting)"), "starting");
        assert_eq!(health_of("Up 1 minute (unhealthy)"), "unhealthy");
        assert_eq!(health_of("Up 1 minute"), "");
    }

    #[test]
    fn ports_ranges_and_bare_ports() {
        let ports = parse_port_text("127.0.0.1:8000-8002->8000-8002/tcp, 6379/tcp, :::9000->9000/udp");
        assert_eq!(ports.len(), 3);
        assert_eq!(ports[0].host_port, Some(8000));
        assert_eq!(ports[0].host_ip, "127.0.0.1");
        assert_eq!(ports[1].host_port, None);
        assert_eq!(ports[2].protocol, "udp");
        assert_eq!(ports[2].host_ip, "::");
    }

    #[test]
    fn images_from_both_shapes() {
        let docker = parse_images(r#"{"ID":"sha256:f2a1","Repository":"postgres","Tag":"16","Size":"431MB","CreatedAt":"2026-09-01"}
{"ID":"9b8c7d6e5f4a","Repository":"<none>","Tag":"<none>","Size":"12.5kB"}"#);
        assert_eq!(docker[0].reference, "postgres:16");
        assert_eq!(docker[0].size_bytes, Some(431_000_000));
        assert!(docker[1].dangling);
        assert_eq!(docker[1].reference, "9b8c7d6e5f4a");
        let podman = parse_images(r#"[{"Id":"sha256:abc","RepoTags":["docker.io/library/redis:7","localhost/redis:mine"],"Size":120000000,"Created":1759322400}]"#);
        assert_eq!(podman.len(), 2);
        assert_eq!(podman[0].repository, "docker.io/library/redis");
        assert_eq!(podman[0].tag, "7");
        assert_eq!(podman[0].size, "120.0 MB");
        let registry_port = parse_images(r#"[{"Id":"x","RepoTags":["localhost:5000/app"]}]"#);
        assert_eq!(registry_port[0].repository, "localhost:5000/app");
        assert_eq!(registry_port[0].tag, "latest");
    }

    #[test]
    fn volumes_and_networks() {
        let volumes = parse_volumes(r#"{"Driver":"local","Labels":"com.docker.compose.project=shop","Mountpoint":"/var/lib/docker/volumes/shop_data/_data","Name":"shop_data","Scope":"local"}"#);
        assert_eq!(volumes[0].project, "shop");
        let networks = parse_networks(r#"[{"name":"podman","id":"2f25","driver":"bridge"},{"name":"shop_default","id":"9a","driver":"bridge"}]"#);
        assert!(networks[0].builtin);
        assert!(!networks[1].builtin);
    }

    #[test]
    fn action_lines() {
        let ids = vec!["a".to_string(), "b".to_string()];
        assert_eq!(action_args(EngineKind::Docker, "container", "stop", &ids, &json!({})).unwrap(), vec!["stop", "a", "b"]);
        assert_eq!(action_args(EngineKind::Podman, "container", "remove", &ids[..1], &json!({"volumes": true})).unwrap(), vec!["rm", "-f", "-v", "a"]);
        assert_eq!(
            action_args(EngineKind::Docker, "project", "up", &["shop".into()], &json!({"projectDir": "/w/shop", "configFiles": "/w/shop/a.yml,/w/shop/b.yml"})).unwrap(),
            vec!["compose", "-p", "shop", "--project-directory", "/w/shop", "-f", "/w/shop/a.yml", "-f", "/w/shop/b.yml", "up", "-d"]
        );
        assert_eq!(action_args(EngineKind::Docker, "project", "stop", &["shop".into()], &json!({})).unwrap(), vec!["compose", "-p", "shop", "stop"]);
        assert_eq!(action_args(EngineKind::Ctr, "container", "stop", &ids[..1], &json!({})).unwrap(), vec!["tasks", "kill", "--signal", "SIGTERM", "a"]);
        assert!(action_args(EngineKind::Docker, "container", "stop", &[], &json!({})).is_err());
        assert_eq!(
            action_args(EngineKind::Docker, "image", "run", &["redis:7".into()], &json!({"name": "cache", "ports": "6379:6379", "env": "A=1\nB=2"})).unwrap(),
            vec!["run", "-d", "--name", "cache", "-p", "6379:6379", "-e", "A=1", "-e", "B=2", "redis:7"]
        );
    }

    #[test]
    fn a_name_never_becomes_a_flag() {
        assert!(action_args(EngineKind::Docker, "image", "run", &["--privileged".into()], &json!({})).is_err());
        assert!(action_args(EngineKind::Docker, "container", "remove", &["--volumes".into()], &json!({})).is_err());
        assert!(action_args(EngineKind::Podman, "container", "stop", &["web".into(), "-t0".into()], &json!({})).is_err());
        assert!(action_args(EngineKind::Docker, "image", "pull", &[], &json!({"reference": "-q"})).is_err());
        assert!(action_args(EngineKind::Docker, "container", "rename", &["web".into()], &json!({"name": "--help"})).is_err());
        assert!(action_args(EngineKind::Ctr, "container", "remove", &["-a".into()], &json!({})).is_err());
        assert!(action_args(EngineKind::Docker, "container", "start", &["web 2".into()], &json!({})).is_err());
        assert!(check_ref("sha256:9b8c7d6e5f4a").is_ok() && check_ref("localhost:5000/app:dev").is_ok());
    }

    #[test]
    fn compose_files_only_where_the_command_reads_them() {
        let files = json!({"projectDir": "/w/shop", "configFiles": "/w/shop/a.yml,/w/shop/b.yml"});
        // Docker Compose stops, starts, restarts and takes down a project by its name alone: a moved
        // checkout or a remote engine's paths cannot break them.
        for action in ["stop", "start", "restart", "down"] {
            assert_eq!(action_args(EngineKind::Docker, "project", action, &["shop".into()], &files).unwrap(), vec!["compose", "-p", "shop", action]);
        }
        assert_eq!(
            action_args(EngineKind::Docker, "project", "pull", &["shop".into()], &files).unwrap(),
            vec!["compose", "-p", "shop", "--project-directory", "/w/shop", "-f", "/w/shop/a.yml", "-f", "/w/shop/b.yml", "pull"]
        );
        // podman-compose reads the files for everything.
        assert_eq!(
            action_args(EngineKind::Podman, "project", "stop", &["shop".into()], &files).unwrap(),
            vec!["compose", "-p", "shop", "-f", "/w/shop/a.yml", "-f", "/w/shop/b.yml", "stop"]
        );
        assert_eq!(action_args(EngineKind::Podman, "project", "stop", &["shop".into()], &json!({})).unwrap(), vec!["compose", "-p", "shop", "stop"]);
        // `up` without its files (none left on this computer) says so instead of reading the app's folder.
        let error = action_args(EngineKind::Docker, "project", "up", &["shop".into()], &json!({"projectDir": "", "configFiles": ""})).unwrap_err();
        assert!(error.contains("not on this computer"), "{error}");
        assert!(compose_reads_files(EngineKind::Docker, "up") && !compose_reads_files(EngineKind::Docker, "down") && compose_reads_files(EngineKind::Nerdctl, "down"));
    }

    #[test]
    fn local_and_remote_endpoints() {
        assert!(is_local_endpoint("unix:///Users/me/.orbstack/run/docker.sock"));
        assert!(is_local_endpoint("npipe:////./pipe/docker_engine"));
        assert!(is_local_endpoint(""));
        assert!(is_local_endpoint("ssh://core@127.0.0.1:52345/run/user/501/podman/podman.sock"), "a Podman machine is this computer");
        assert!(is_local_endpoint("tcp://localhost:2375"));
        assert!(is_local_endpoint("ssh://root@[::1]:22/run/podman/podman.sock"));
        assert!(!is_local_endpoint("ssh://deploy@build.example.com"));
        assert!(!is_local_endpoint("tcp://10.0.0.5:2376"));
        assert!(!is_local_endpoint("ssh://127.0.0.1.example.net/x"));
    }

    #[test]
    fn what_downloads_gets_the_long_limit() {
        assert_eq!(action_timeout("image", "pull"), PULL_TIMEOUT);
        assert_eq!(action_timeout("project", "up"), PULL_TIMEOUT);
        assert_eq!(action_timeout("image", "run"), PULL_TIMEOUT);
        assert_eq!(action_timeout("container", "stop"), ACTION_TIMEOUT);
        assert_eq!(action_timeout("project", "down"), ACTION_TIMEOUT);
    }

    #[test]
    fn target_flags_pick_the_context() {
        let docker = Target { runtime: "docker".into(), context: Some("orbstack".into()) };
        assert_eq!(docker.global_args(), vec!["--context", "orbstack"]);
        let nerd = Target { runtime: "nerdctl".into(), context: Some("k8s.io".into()) };
        assert_eq!(nerd.global_args(), vec!["--namespace", "k8s.io"]);
        let none = Target { runtime: "docker".into(), context: Some("  ".into()) };
        assert!(none.global_args().is_empty());
    }

    /// Against the Docker on this computer: `CODEFLOW_LIVE_CONTAINERS=1 cargo test --lib
    /// containers::engine::tests::live -- --ignored --nocapture`, with a container named `cf-test-web`
    /// (`docker run -d --name cf-test-web -p 18080:80 nginx:alpine`).
    #[tokio::test]
    #[ignore]
    async fn live_docker() {
        if std::env::var("CODEFLOW_LIVE_CONTAINERS").is_err() {
            return;
        }
        let target = Target { runtime: "docker".into(), context: None };
        for what in ["containers", "images", "volumes", "networks"] {
            let rows = list(&target, what).await.expect(what);
            println!("{what}: {}", serde_json::to_string_pretty(&rows).unwrap());
        }
        let rows = parse_containers(&target.run(&["ps", "-a", "--no-trunc", "--format", "{{json .}}"], LIST_TIMEOUT).await.unwrap());
        let web = rows.iter().find(|r| r.name == "cf-test-web").expect("cf-test-web exists");
        assert_eq!(web.ports.first().and_then(|p| p.host_port), Some(18080));
        let doc: Value = serde_json::from_str(&inspect(&target, "container", &web.id).await.unwrap()).unwrap();
        let summary = summary_of_inspect(&doc);
        println!("summary: {}", serde_json::to_string_pretty(&summary).unwrap());
        println!("stats: {}", stats(&target, &web.id).await.unwrap());
        assert_eq!(act(&target, "container", "restart", &[web.id.clone()], &json!({})).await.map(|_| ()), Ok(()));
        assert!(act(&target, "container", "start", &["cf-no-such-container".into()], &json!({})).await.is_err());
    }

    #[test]
    fn secrets_are_spotted_by_name() {
        assert!(looks_secret("POSTGRES_PASSWORD"));
        assert!(looks_secret("github_token"));
        assert!(!looks_secret("PATH"));
        assert_eq!(bytes_of("1.5GB"), Some(1_500_000_000));
        assert_eq!(bytes_of("10MiB"), Some(10 * 1024 * 1024));
        assert_eq!(human_bytes(999), "999 B");
    }
}
