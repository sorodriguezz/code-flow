//! Kubernetes on this computer — clusters made by **kind**, **k3d** or **minikube**, through their own
//! CLIs, the way the rest of the panel works: found, not embedded. Nothing here installs a tool or
//! keeps a list of clusters; what `kind get clusters`, `k3d cluster list` and `minikube profile list`
//! say is the list, and every action is the command the user would have typed.
//!
//! **No second Kubernetes page.** Each of these tools writes its cluster's context into the user's
//! kubeconfig as it creates it (`kind-<name>`, `k3d-<name>`, minikube's profile name) and takes it
//! out as it deletes it — so a new cluster shows up in the panel's Kubernetes list by itself, and is
//! read and acted on there like any other. Only what is the tool's own (start, stop, delete, how many
//! nodes) is shown here.
//!
//! **The user's kubeconfig, not CodeFlow's.** Every command the panel runs carries a `KUBECONFIG`
//! with CodeFlow's own file last (`cli::engine_env`). kind and k3d write into the *first existing*
//! file of that list, which for someone without `~/.kube/config` yet would be CodeFlow's — a file a
//! terminal's kubectl never reads, and one the panel removes contexts from. So these sessions run
//! with `KUBECONFIG` pointed at the user's own file ([`own_kubeconfig`]): the cluster lands where a
//! terminal would have put it.
//!
//! **Minutes, in the open.** Creating a cluster pulls a node image and boots it; it runs as one of
//! the manager's jobs (a `localCluster` session, see `session`), so what the tool prints is on screen
//! while it works and the job survives the page that started it. Listing is quick and runs directly.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cli;

const LIST_TIMEOUT: Duration = Duration::from_secs(20);
/// More than this many worker nodes on one laptop is a typo, not a cluster.
pub const MAX_WORKERS: u32 = 9;
/// kind and k3d name containers, networks and the context after the cluster; both refuse long names.
const MAX_NAME: usize = 32;

/// The tools that make local clusters, and Helm — which of them are installed.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalTools {
    pub kind: bool,
    pub k3d: bool,
    pub minikube: bool,
    pub helm: bool,
    /// A Docker-compatible CLI is there: kind and k3d run their nodes as its containers.
    pub docker: bool,
}

pub async fn tools() -> LocalTools {
    tokio::task::spawn_blocking(|| LocalTools {
        kind: cli::find("kind").is_some(),
        k3d: cli::find("k3d").is_some(),
        minikube: cli::find("minikube").is_some(),
        helm: cli::find("helm").is_some(),
        docker: cli::find("docker").is_some() || cli::find("podman").is_some(),
    })
    .await
    .unwrap_or(LocalTools { kind: false, k3d: false, minikube: false, helm: false, docker: false })
}

/// One cluster a local tool knows.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalCluster {
    /// `kind`, `k3d` or `minikube`.
    pub tool: String,
    pub name: String,
    /// The kubeconfig context the tool wrote for it.
    pub context: String,
    /// `running`, `stopped`, `partial` (some nodes up), or `""` when the tool does not say (kind).
    pub state: String,
    /// Control-plane and worker nodes together; 0 when unknown.
    pub nodes: u32,
    /// How many of those run, when the tool says.
    pub running_nodes: Option<u32>,
    /// The Kubernetes version or node image, when the tool says.
    pub version: String,
    /// The tool can stop and start it again (k3d, minikube — not kind).
    pub can_stop: bool,
}

/// What each installed tool listed, and what the ones that failed said.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalClusters {
    pub clusters: Vec<LocalCluster>,
    pub errors: Vec<String>,
}

/// What a `localCluster` session does.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalClusterSpec {
    /// `kind`, `k3d` or `minikube`.
    pub tool: String,
    /// `create`, `start`, `stop` or `delete`.
    pub action: String,
    pub name: String,
    /// Nodes besides the control plane: kind's workers, k3d's agents, minikube's extra nodes.
    #[serde(default)]
    pub workers: u32,
    /// A Kubernetes version (`v1.30.0`) or, for kind and k3d, a whole node image.
    #[serde(default)]
    pub version: Option<String>,
    /// k3d: the port on this computer its load balancer forwards to the cluster's port 80 — where an
    /// ingress answers.
    #[serde(default)]
    pub ingress_port: Option<u16>,
}

/// The context each tool names its cluster's after.
pub fn context_of(tool: &str, name: &str) -> String {
    match tool {
        "kind" => format!("kind-{name}"),
        "k3d" => format!("k3d-{name}"),
        _ => name.to_string(),
    }
}

/// A cluster name every one of these tools takes — and one that cannot be read as a flag: lowercase
/// letters, digits and inner dashes.
pub fn check_cluster_name(name: &str) -> Result<(), String> {
    let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let valid = !name.is_empty()
        && name.len() <= MAX_NAME
        && edge(name.chars().next())
        && edge(name.chars().last())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(format!("\"{name}\" is not a cluster name: lowercase letters, digits and dashes, up to {MAX_NAME}"))
    }
}

fn check_tool(tool: &str) -> Result<(), String> {
    if matches!(tool, "kind" | "k3d" | "minikube") {
        Ok(())
    } else {
        Err(format!("{tool} is not a local cluster tool"))
    }
}

/// `v1.30.0`, `1.30`, `v1.30.4-k3s1` — a Kubernetes version as the tools' images are tagged.
fn is_version(text: &str) -> bool {
    let core = text.strip_prefix('v').unwrap_or(text);
    let (numbers, suffix) = core.split_once(['-', '+']).unwrap_or((core, ""));
    let parts: Vec<&str> = numbers.split('.').collect();
    (2..=3).contains(&parts.len())
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && suffix.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
}

/// The node image kind or k3d boots: a version turned into the tool's own image, or an image given
/// whole.
fn node_image(tool: &str, version: &str) -> Result<String, String> {
    if is_version(version) {
        let tagged = if version.starts_with('v') { version.to_string() } else { format!("v{version}") };
        return Ok(match tool {
            "kind" => format!("kindest/node:{tagged}"),
            // k3s tags its releases `v1.30.4-k3s1`; a bare Kubernetes version means the first one.
            _ if tagged.contains('-') => format!("rancher/k3s:{tagged}"),
            _ => format!("rancher/k3s:{tagged}-k3s1"),
        });
    }
    if version.contains([':', '/', '@']) {
        super::engine::check_ref(version)?;
        return Ok(version.to_string());
    }
    Err(format!("\"{version}\" is neither a Kubernetes version (v1.30.0) nor an image"))
}

/// kind's cluster config for a control plane and `workers` workers — kind takes a node count only
/// through a config file.
pub fn kind_config(workers: u32) -> String {
    let mut text = String::from("kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnodes:\n- role: control-plane\n");
    for _ in 0..workers {
        text.push_str("- role: worker\n");
    }
    text
}

/// The arguments a spec runs with. `kind_config_file` is where [`kind_config`] was written when kind
/// is asked for workers (the caller writes it: this stays a pure function).
pub fn args(spec: &LocalClusterSpec, kind_config_file: Option<&Path>) -> Result<Vec<String>, String> {
    check_tool(&spec.tool)?;
    let name = spec.name.trim();
    check_cluster_name(name)?;
    if spec.workers > MAX_WORKERS {
        return Err(format!("{} nodes is more than this computer should run; at most {MAX_WORKERS}", spec.workers));
    }
    let version = spec.version.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let creating = spec.action == "create";
    if spec.ingress_port.is_some() && !(creating && spec.tool == "k3d") {
        return Err("only k3d maps a port of this computer to the cluster when it is created".into());
    }
    if spec.ingress_port == Some(0) {
        return Err("0 is not a port".into());
    }
    let s = |v: &str| v.to_string();
    let args: Vec<String> = match (spec.tool.as_str(), spec.action.as_str()) {
        ("kind", "create") => {
            let mut a = vec![s("create"), s("cluster"), s("--name"), s(name)];
            if let Some(v) = version {
                a.extend([s("--image"), node_image("kind", v)?]);
            }
            if spec.workers > 0 {
                let file = kind_config_file.ok_or("kind needs a config file for worker nodes")?;
                a.extend([s("--config"), file.to_string_lossy().into_owned()]);
            }
            a
        }
        ("kind", "delete") => vec![s("delete"), s("cluster"), s("--name"), s(name)],
        ("kind", "start" | "stop") => return Err("kind clusters cannot be stopped and started again: delete it and create it anew".into()),
        ("k3d", "create") => {
            let mut a = vec![s("cluster"), s("create"), s(name), s("--agents"), spec.workers.to_string()];
            if let Some(v) = version {
                a.extend([s("--image"), node_image("k3d", v)?]);
            }
            if let Some(port) = spec.ingress_port {
                a.extend([s("-p"), format!("{port}:80@loadbalancer")]);
            }
            a
        }
        ("k3d", action @ ("start" | "stop" | "delete")) => vec![s("cluster"), s(action), s(name)],
        ("minikube", "create") => {
            let mut a = vec![s("start"), s("-p"), s(name)];
            if spec.workers > 0 {
                a.extend([s("--nodes"), (spec.workers + 1).to_string()]);
            }
            if let Some(v) = version {
                if !is_version(v) {
                    return Err(format!("\"{v}\" is not a Kubernetes version (v1.30.0)"));
                }
                a.extend([s("--kubernetes-version"), if v.starts_with('v') { s(v) } else { format!("v{v}") }]);
            }
            a
        }
        ("minikube", "start") => vec![s("start"), s("-p"), s(name)],
        ("minikube", action @ ("stop" | "delete")) => vec![s(action), s("-p"), s(name)],
        (_, other) => return Err(format!("{other} is not something done to a local cluster")),
    };
    Ok(args)
}

/// The tool and arguments of a session, the kind config written first when one is needed.
pub fn command_line(spec: &LocalClusterSpec) -> Result<(String, Vec<String>), String> {
    // Everything checked before anything is written or found.
    args(spec, Some(Path::new("kind-config.yaml")))?;
    let program = cli::find(&spec.tool).ok_or_else(|| format!("{} is not installed", spec.tool))?;
    let config = if spec.tool == "kind" && spec.action == "create" && spec.workers > 0 {
        // Beside CodeFlow's kubeconfig: written fresh for every create, read once by kind.
        let dir = crate::paths::state_dir().join("containers");
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let file = dir.join(format!("kind-{}.yaml", spec.name.trim()));
        std::fs::write(&file, kind_config(spec.workers)).map_err(|e| format!("{}: {e}", file.display()))?;
        Some(file)
    } else {
        None
    };
    Ok((program.to_string_lossy().into_owned(), args(spec, config.as_deref())?))
}

/// The command as a terminal would show it — for the form to say what it will run.
pub fn preview(spec: &LocalClusterSpec) -> Result<String, String> {
    let shown_config = PathBuf::from("kind-config.yaml");
    let args = args(spec, Some(&shown_config))?;
    Ok(std::iter::once(spec.tool.clone()).chain(args).collect::<Vec<_>>().join(" "))
}

/// The user's own kubeconfig file within a composed `KUBECONFIG` — CodeFlow's file taken out, then
/// the first file that exists, as kind and k3d would pick, or the first one when none does yet.
/// `None` only when there is no home to put `~/.kube/config` in.
pub fn own_kubeconfig(composed: Option<&str>, app: &Path, home: Option<&Path>, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let separator = super::kubeconfig::list_separator();
    let own: Vec<String> = composed
        .unwrap_or_default()
        .split(separator)
        .map(str::trim)
        .filter(|p| !p.is_empty() && Path::new(p) != app)
        .map(str::to_string)
        .collect();
    let joined = own.join(&separator.to_string());
    let files = super::kubeconfig::user_files(if own.is_empty() { None } else { Some(&joined) }, home);
    files.iter().find(|p| exists(p)).cloned().or_else(|| files.into_iter().next())
}

/// A `localCluster` session's environment: `KUBECONFIG` narrowed to the user's own file.
pub fn session_env(env: &mut Vec<(String, String)>) {
    let composed = env.iter().rev().find(|(name, _)| name == "KUBECONFIG").map(|(_, v)| v.clone()).or_else(|| std::env::var("KUBECONFIG").ok());
    let app = super::kubeconfig::app_path();
    if let Some(own) = own_kubeconfig(composed.as_deref(), &app, dirs::home_dir().as_deref(), |p| p.is_file()) {
        env.retain(|(name, _)| name != "KUBECONFIG");
        env.push(("KUBECONFIG".into(), own.to_string_lossy().into_owned()));
    }
}

// ------------------------------------------------------------------------------------ listing

/// `kind get clusters`: a name a line ("No kind clusters found." goes to stderr).
pub fn parse_kind_clusters(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains(' ')).map(str::to_string).collect()
}

fn node_running(node: &Value) -> Option<bool> {
    node.pointer("/State/Running").or_else(|| node.pointer("/state/running")).and_then(Value::as_bool)
}

fn state_of(nodes: u32, running: u32) -> String {
    if nodes == 0 {
        String::new()
    } else if running == nodes {
        "running".into()
    } else if running == 0 {
        "stopped".into()
    } else {
        "partial".into()
    }
}

/// `k3d cluster list -o json`: its servers and agents (the load balancer is not a node), and how
/// many of them run. The cluster's token is in there too; it is never read.
pub fn parse_k3d(text: &str) -> Vec<LocalCluster> {
    cli::json_values(text)
        .iter()
        .filter_map(|cluster| {
            let name = cluster.get("name").and_then(Value::as_str)?.to_string();
            let nodes: Vec<&Value> = cluster
                .get("nodes")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter(|n| matches!(n.get("role").and_then(Value::as_str), Some("server" | "agent"))).collect())
                .unwrap_or_default();
            let (count, running) = if nodes.is_empty() {
                let at = |key: &str| cluster.get(key).and_then(Value::as_u64).unwrap_or(0) as u32;
                (at("serversCount") + at("agentsCount"), at("serversRunning") + at("agentsRunning"))
            } else {
                (nodes.len() as u32, nodes.iter().filter(|n| node_running(n) == Some(true)).count() as u32)
            };
            let version = nodes.first().and_then(|n| n.get("image")).and_then(Value::as_str).unwrap_or_default().to_string();
            Some(LocalCluster { tool: "k3d".into(), context: context_of("k3d", &name), name, state: state_of(count, running), nodes: count, running_nodes: Some(running), version, can_stop: true })
        })
        .collect()
}

/// `minikube profile list -o json`: `{"valid": [...], "invalid": [...]}`, each a profile with its
/// status and config.
pub fn parse_minikube(text: &str) -> Vec<LocalCluster> {
    let doc = cli::json_values(text).into_iter().next().unwrap_or(Value::Null);
    ["valid", "invalid"]
        .iter()
        .filter_map(|key| doc.get(*key).and_then(Value::as_array))
        .flatten()
        .filter_map(|profile| {
            let name = profile.get("Name").and_then(Value::as_str)?.to_string();
            let status = profile.get("Status").and_then(Value::as_str).unwrap_or_default().to_lowercase();
            let nodes = profile.pointer("/Config/Nodes").and_then(Value::as_array).map(|n| n.len() as u32).unwrap_or(0);
            let state = match status.as_str() {
                "running" => "running",
                "stopped" => "stopped",
                "" | "unknown" => "",
                _ => "partial",
            };
            Some(LocalCluster {
                tool: "minikube".into(),
                context: context_of("minikube", &name),
                name,
                state: state.into(),
                nodes,
                running_nodes: None,
                version: profile.pointer("/Config/KubernetesConfig/KubernetesVersion").and_then(Value::as_str).unwrap_or_default().to_string(),
                can_stop: true,
            })
        })
        .collect()
}

async fn run_tool(tool: &str, args: &[&str]) -> Result<cli::Output, String> {
    let program = cli::find(tool).ok_or_else(|| format!("{tool} is not installed"))?;
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    cli::run(&program.to_string_lossy(), &args, None, LIST_TIMEOUT).await
}

async fn list_kind() -> Result<Vec<LocalCluster>, String> {
    let out = run_tool("kind", &["get", "clusters"]).await?;
    if !out.ok() {
        return Err(format!("kind: {}", out.complaint()));
    }
    let names = parse_kind_clusters(&out.stdout);
    // Each cluster's nodes are its containers; how many, asked of each at once.
    let counts = futures_util::future::join_all(names.iter().map(|name| async move {
        match run_tool("kind", &["get", "nodes", "--name", name]).await {
            Ok(out) if out.ok() => parse_kind_clusters(&out.stdout).len() as u32,
            _ => 0,
        }
    }))
    .await;
    Ok(names
        .into_iter()
        .zip(counts)
        .map(|(name, nodes)| LocalCluster { tool: "kind".into(), context: context_of("kind", &name), name, state: String::new(), nodes, running_nodes: None, version: String::new(), can_stop: false })
        .collect())
}

async fn list_k3d() -> Result<Vec<LocalCluster>, String> {
    let out = run_tool("k3d", &["cluster", "list", "-o", "json"]).await?;
    if !out.ok() {
        return Err(format!("k3d: {}", out.complaint()));
    }
    Ok(parse_k3d(&out.stdout))
}

async fn list_minikube() -> Result<Vec<LocalCluster>, String> {
    let out = run_tool("minikube", &["profile", "list", "-o", "json"]).await?;
    // With no profile at all minikube exits non-zero, saying so in its JSON or on stderr.
    let parsed = parse_minikube(&out.stdout);
    if !out.ok() && parsed.is_empty() {
        let said = format!("{}{}", out.stdout, out.stderr).to_lowercase();
        if said.contains("no minikube profile") || (said.contains("profile") && said.contains("not found")) {
            return Ok(vec![]);
        }
        return Err(format!("minikube: {}", out.complaint()));
    }
    Ok(parsed)
}

/// Every local cluster the installed tools know, asked of all of them at once.
pub async fn clusters() -> LocalClusters {
    let found = tools().await;
    let skip = || async { Ok(vec![]) };
    let (kind, k3d, minikube) = tokio::join!(
        async { if found.kind { list_kind().await } else { skip().await } },
        async { if found.k3d { list_k3d().await } else { skip().await } },
        async { if found.minikube { list_minikube().await } else { skip().await } },
    );
    let mut out = LocalClusters { clusters: vec![], errors: vec![] };
    for result in [kind, k3d, minikube] {
        match result {
            Ok(list) => out.clusters.extend(list),
            Err(error) => out.errors.push(error),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(tool: &str, action: &str) -> LocalClusterSpec {
        LocalClusterSpec { tool: tool.into(), action: action.into(), name: "dev".into(), workers: 0, version: None, ingress_port: None }
    }

    #[test]
    fn names_that_could_be_flags_or_break_a_context_are_refused() {
        assert!(check_cluster_name("dev").is_ok());
        assert!(check_cluster_name("dev-2").is_ok());
        for bad in ["", "-dev", "dev-", "Dev", "dev cluster", "dev_1", "a.b", &"x".repeat(33)] {
            assert!(check_cluster_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn kind_commands() {
        assert_eq!(args(&spec("kind", "create"), None).unwrap(), vec!["create", "cluster", "--name", "dev"]);
        let mut more = spec("kind", "create");
        more.workers = 2;
        more.version = Some("1.30.0".into());
        let file = PathBuf::from("/tmp/kind-dev.yaml");
        assert_eq!(args(&more, Some(&file)).unwrap(), vec!["create", "cluster", "--name", "dev", "--image", "kindest/node:v1.30.0", "--config", "/tmp/kind-dev.yaml"]);
        assert!(args(&more, None).is_err(), "workers need the config file");
        assert_eq!(args(&spec("kind", "delete"), None).unwrap(), vec!["delete", "cluster", "--name", "dev"]);
        assert!(args(&spec("kind", "stop"), None).is_err());
        assert!(args(&spec("kind", "start"), None).is_err());
        assert_eq!(kind_config(2), "kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnodes:\n- role: control-plane\n- role: worker\n- role: worker\n");
    }

    #[test]
    fn k3d_commands() {
        let mut create = spec("k3d", "create");
        create.workers = 2;
        create.version = Some("v1.30.4".into());
        create.ingress_port = Some(8080);
        assert_eq!(args(&create, None).unwrap(), vec!["cluster", "create", "dev", "--agents", "2", "--image", "rancher/k3s:v1.30.4-k3s1", "-p", "8080:80@loadbalancer"]);
        create.version = Some("v1.29.1-k3s2".into());
        create.ingress_port = None;
        assert_eq!(args(&create, None).unwrap()[5..], ["--image", "rancher/k3s:v1.29.1-k3s2"]);
        create.version = Some("registry.local/k3s:custom".into());
        assert_eq!(args(&create, None).unwrap()[6], "registry.local/k3s:custom");
        for action in ["start", "stop", "delete"] {
            assert_eq!(args(&spec("k3d", action), None).unwrap(), vec!["cluster", action, "dev"]);
        }
        let mut port = spec("k3d", "start");
        port.ingress_port = Some(80);
        assert!(args(&port, None).is_err(), "a port is mapped only when the cluster is made");
    }

    #[test]
    fn minikube_commands() {
        let mut create = spec("minikube", "create");
        create.workers = 1;
        create.version = Some("1.30.0".into());
        assert_eq!(args(&create, None).unwrap(), vec!["start", "-p", "dev", "--nodes", "2", "--kubernetes-version", "v1.30.0"]);
        create.version = Some("kindest/node:v1".into());
        assert!(args(&create, None).is_err(), "minikube takes a version, not an image");
        assert_eq!(args(&spec("minikube", "start"), None).unwrap(), vec!["start", "-p", "dev"]);
        assert_eq!(args(&spec("minikube", "stop"), None).unwrap(), vec!["stop", "-p", "dev"]);
        assert_eq!(args(&spec("minikube", "delete"), None).unwrap(), vec!["delete", "-p", "dev"]);
    }

    #[test]
    fn what_is_not_a_cluster_action_is_refused() {
        let mut many = spec("k3d", "create");
        many.workers = 50;
        assert!(args(&many, None).is_err());
        assert!(args(&spec("docker", "create"), None).is_err());
        assert!(args(&spec("k3d", "upgrade"), None).is_err());
        let mut flag = spec("kind", "create");
        flag.version = Some("--help".into());
        assert!(args(&flag, None).is_err());
        let mut ported = spec("kind", "create");
        ported.ingress_port = Some(8080);
        assert!(args(&ported, None).is_err(), "only k3d maps a port");
    }

    #[test]
    fn contexts_are_named_as_the_tools_name_them() {
        assert_eq!(context_of("kind", "dev"), "kind-dev");
        assert_eq!(context_of("k3d", "dev"), "k3d-dev");
        assert_eq!(context_of("minikube", "dev"), "dev");
    }

    #[test]
    fn preview_reads_like_the_terminal() {
        let mut create = spec("k3d", "create");
        create.workers = 1;
        assert_eq!(preview(&create).unwrap(), "k3d cluster create dev --agents 1");
    }

    #[test]
    fn kind_lists_read() {
        assert_eq!(parse_kind_clusters("dev\nci\n\n"), vec!["dev", "ci"]);
        assert!(parse_kind_clusters("No kind clusters found.\n").is_empty());
    }

    #[test]
    fn k3d_lists_read() {
        let text = r#"[{"name":"dev","token":"secret","nodes":[
            {"name":"k3d-dev-server-0","role":"server","image":"rancher/k3s:v1.30.4-k3s1","State":{"Running":true,"Status":"running"}},
            {"name":"k3d-dev-agent-0","role":"agent","State":{"Running":false,"Status":"exited"}},
            {"name":"k3d-dev-serverlb","role":"loadbalancer","State":{"Running":true}}]},
            {"name":"old","serversCount":1,"serversRunning":0,"agentsCount":0,"agentsRunning":0}]"#;
        let list = parse_k3d(text);
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].name.as_str(), list[0].context.as_str(), list[0].state.as_str(), list[0].nodes, list[0].running_nodes), ("dev", "k3d-dev", "partial", 2, Some(1)));
        assert_eq!(list[0].version, "rancher/k3s:v1.30.4-k3s1");
        assert_eq!((list[1].state.as_str(), list[1].nodes), ("stopped", 1));
        assert!(parse_k3d("[]").is_empty());
    }

    #[test]
    fn minikube_lists_read() {
        let text = r#"{"invalid":[{"Name":"broken","Status":"Unknown"}],"valid":[{"Name":"minikube","Status":"Running","Config":{"Nodes":[{},{}],"KubernetesConfig":{"KubernetesVersion":"v1.30.0"}}},{"Name":"lab","Status":"Stopped","Config":{"Nodes":[{}]}}]}"#;
        let list = parse_minikube(text);
        assert_eq!(list.iter().map(|c| (c.name.as_str(), c.state.as_str(), c.nodes)).collect::<Vec<_>>(), vec![("minikube", "running", 2), ("lab", "stopped", 1), ("broken", "", 0)]);
        assert_eq!(list[0].version, "v1.30.0");
        assert!(parse_minikube("").is_empty());
    }

    #[test]
    fn the_users_own_kubeconfig_is_where_a_cluster_lands() {
        let app = PathBuf::from("/state/containers/kubeconfig");
        let home = PathBuf::from("/home/me");
        let sep = super::super::kubeconfig::list_separator();
        // Only CodeFlow's file in the list: the user's default, whether or not it exists yet.
        let only_app = app.to_string_lossy().into_owned();
        assert_eq!(own_kubeconfig(Some(&only_app), &app, Some(&home), |_| false), Some(home.join(".kube").join("config")));
        assert_eq!(own_kubeconfig(None, &app, Some(&home), |_| false), Some(home.join(".kube").join("config")));
        // The user's list, CodeFlow's last: the first of theirs that exists.
        let list = format!("/a/missing{sep}/b/config{sep}{}", app.display());
        assert_eq!(own_kubeconfig(Some(&list), &app, Some(&home), |p| p == Path::new("/b/config")), Some(PathBuf::from("/b/config")));
        assert_eq!(own_kubeconfig(Some(&list), &app, Some(&home), |_| false), Some(PathBuf::from("/a/missing")));
    }
}
