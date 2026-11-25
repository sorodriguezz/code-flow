//! Entornos — several versions of one system running at once: `main`, `feature/payment` and
//! `fix/auth`, each in its own checkout with its own containers, network, volumes and host ports.
//!
//! An environment is four decisions, made once and kept in [`store`]:
//!
//! 1. **A checkout of the branch** — a git worktree (`git::branch_worktree::ensure`) under the
//!    user's worktrees folder, beside the agents' ones. The `.env` files the app needs and git does
//!    not carry are copied in from the main checkout ([`copy_env_files`]), using the same patterns
//!    «Entorno» reads (`repo_env::config`).
//! 2. **A Compose project name**, `<repo>-<branch>` ([`plan::compose_project_name`]). Compose
//!    already prefixes networks, volumes and containers with it, so that alone keeps most of a stack
//!    apart.
//! 3. **A port offset.** What a project name cannot separate is the host's ports: two stacks that
//!    both publish `8080` collide. Each environment publishes every port at `port + offset`, through
//!    an override file generated from Compose's effective configuration ([`plan::compose_override`]).
//! 4. **How it runs** ([`store::EnvConfig`]): a Compose stack the repository has (as
//!    `services::detect::compose_stacks` finds them), or its `devcontainer.json` — through the Dev
//!    Containers CLI when installed (given an override config, in the cache, that moves its ports by
//!    the offset), or directly ([`devcontainer`], [`direct`]).
//!
//! **What runs on the host.** A devcontainer's `initializeCommand` is the repository's code run on
//! this computer, before any container. It runs only when the user starts the environment, and only
//! the command the create dialog showed them: the branch's file is compared with the approved text
//! before every start ([`check_initialize`]); a changed one is refused with [`INIT_CHANGED_PREFIX`]
//! until the page has asked again.
//!
//! **What the workspace allows.** A devcontainer started directly is judged by the workspace's
//! security policy before it is created (`direct::judge`, on what `runArgs`, `mounts` and the file's
//! own flags make of it); one the CLI starts is judged first on what its file declares and then on
//! the container the CLI made — features add flags no file shows — and stopped if it breaks the
//! policy.
//!
//! Whether an environment runs is never stored: it is read from the engine every time — its Compose
//! project's containers, or the ones labelled `codeflow.env=<id>`.

pub mod devcontainer;
pub mod direct;
pub mod plan;
pub mod store;

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::engine::{self, ContainerRow, EngineKind, Target};
use super::{cli, manage, policy};
use devcontainer::{DevContainer, Source};
use plan::{EnvWarning, OverridePlan, PortBinding};
pub use store::{EnvConfig, EnvRecord};

/// The label every container an environment starts by itself (not through Compose) carries.
pub const ENV_LABEL: &str = "codeflow.env";
const CONFIG_TIMEOUT: Duration = Duration::from_secs(60);
/// What a lifecycle command (`npm ci`, a migration) may take before it is stopped.
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// What `initializeCommand` may take on the host before it is stopped.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// `up` refused because the branch's `initializeCommand` is not the one approved; a JSON list of the
/// commands follows, for the page to show and approve.
pub const INIT_CHANGED_PREFIX: &str = "INIT_CHANGED: ";

// ------------------------------------------------------------------------------------ paths

/// `a/b/../c` → `a/c`, without touching the disk (the file may not exist yet).
pub(crate) fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `rel` under `root`, refused when it is absolute or climbs out of it — the paths come from the
/// webview and from a repository's own files.
pub fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() || Path::new(&rel).is_absolute() || rel.contains(':') {
        return Err(format!("\"{rel}\" is not a path inside the repository"));
    }
    let joined = lexical(&root.join(&rel));
    if !joined.starts_with(lexical(root)) {
        return Err(format!("\"{rel}\" is outside the repository"));
    }
    Ok(joined)
}

/// Where an environment's generated files go: the cache root, because each is written again before
/// every start — nothing there is worth keeping, and nothing is ever written into the checkout.
pub fn work_dir(id: &str) -> PathBuf {
    crate::paths::cache_dir().join("container-envs").join(plan::slug(id, 64))
}

fn override_path(id: &str) -> PathBuf {
    work_dir(id).join("compose.override.yml")
}

/// The folder a new environment's checkout goes in: `<worktrees>/<repo>/env-<branch>`.
pub fn checkout_dir(repo_name: &str, branch: &str, id: &str) -> PathBuf {
    let base = format!("env-{}", plan::slug(branch, 48));
    let first = crate::paths::agent_worktree_dir(repo_name, &base);
    if !first.exists() {
        return first;
    }
    crate::paths::agent_worktree_dir(repo_name, &format!("{base}-{}", plan::slug(id, 6)))
}

// -------------------------------------------------------------------------------- discovery

/// One way the repository can be run, as the create dialog offers it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    /// `compose`, `devcontainer` (direct) or `devcontainerCli`.
    pub kind: String,
    pub label: String,
    pub config: EnvConfig,
    /// Its services, or its image.
    pub detail: String,
    /// Host ports its files publish, before any offset.
    pub ports: Vec<u16>,
    pub recommended: bool,
    pub available: bool,
    /// Why not available: `noCli`, `unknownSource`, `invalid`.
    pub reason: Option<String>,
    /// The parse error of an invalid `devcontainer.json`.
    pub problem: Option<String>,
    /// `devcontainer.json` keys present that this way of running it leaves out.
    pub unsupported: Vec<String>,
    /// `devcontainer.json` keys present that this way of running it applies.
    pub honoured: Vec<String>,
    /// The `features` the file asks for — installed only by the Dev Containers CLI.
    pub features: Vec<String>,
    /// `initializeCommand`, as it will run on this computer (and as it is approved).
    pub initialize: Vec<String>,
    /// Whether the environment's offset moves its ports.
    pub offset_applies: bool,
}

fn source_detail(dc: &DevContainer) -> String {
    match &dc.source {
        Source::Image { image } => image.clone(),
        Source::Dockerfile { dockerfile, .. } => dockerfile.clone(),
        Source::Compose { service, files, .. } => format!("{service} · {}", files.join(", ")),
        Source::Unknown => String::new(),
    }
}

/// What a checkout can be run as: its devcontainers first (when a repository has one, that is how
/// its authors meant it to be run), then its Compose stacks, best first. One is `recommended`.
pub fn discover(root: &Path, cli_installed: bool) -> Vec<Proposal> {
    let mut out = Vec::new();
    for rel in devcontainer::find_configs(root) {
        let label = if rel == ".devcontainer/devcontainer.json" || rel == ".devcontainer.json" {
            "devcontainer".to_string()
        } else {
            format!("devcontainer · {}", rel.trim_start_matches(".devcontainer/").trim_end_matches("/devcontainer.json"))
        };
        let parsed = std::fs::read_to_string(root.join(&rel)).map_err(|e| e.to_string()).and_then(|t| devcontainer::parse(&t));
        match parsed {
            Err(problem) => out.push(Proposal {
                id: format!("devcontainer:{rel}"),
                kind: "devcontainer".into(),
                label,
                config: EnvConfig::Devcontainer { config: rel.clone(), mode: "direct".into(), without_features: false, approved_init: vec![] },
                detail: String::new(),
                ports: vec![],
                recommended: false,
                available: false,
                reason: Some("invalid".into()),
                problem: Some(problem),
                unsupported: vec![],
                honoured: vec![],
                features: vec![],
                initialize: vec![],
                offset_applies: false,
            }),
            Ok(dc) => {
                let label = if dc.name.is_empty() { label } else { format!("{label} · {}", dc.name) };
                let mut ports: Vec<u16> = dc.ports.iter().map(|p| p.0).collect();
                if !matches!(dc.source, Source::Compose { .. }) {
                    for port in direct::run_args_hosts(&dc.run_args) {
                        if !ports.contains(&port) {
                            ports.push(port);
                        }
                    }
                }
                let direct_ok = dc.source != Source::Unknown;
                out.push(Proposal {
                    id: format!("devcontainer:{rel}"),
                    kind: "devcontainer".into(),
                    label: label.clone(),
                    config: EnvConfig::Devcontainer { config: rel.clone(), mode: "direct".into(), without_features: false, approved_init: vec![] },
                    detail: source_detail(&dc),
                    ports: ports.clone(),
                    recommended: false,
                    available: direct_ok,
                    reason: (!direct_ok).then(|| "unknownSource".into()),
                    problem: None,
                    unsupported: dc.ignored_direct(),
                    honoured: dc.honoured_direct(),
                    features: dc.features.clone(),
                    initialize: dc.initialize_display(),
                    offset_applies: true,
                });
                out.push(Proposal {
                    id: format!("devcontainerCli:{rel}"),
                    kind: "devcontainerCli".into(),
                    label,
                    config: EnvConfig::Devcontainer { config: rel.clone(), mode: "cli".into(), without_features: false, approved_init: vec![] },
                    detail: source_detail(&dc),
                    ports,
                    recommended: false,
                    available: cli_installed,
                    reason: (!cli_installed).then(|| "noCli".into()),
                    problem: None,
                    unsupported: dc.ignored_cli(),
                    honoured: dc.honoured_cli(),
                    features: dc.features.clone(),
                    initialize: dc.initialize_display(),
                    offset_applies: true,
                });
            }
        }
    }
    for stack in crate::services::detect::compose_stacks(root) {
        out.push(Proposal {
            id: format!("compose:{}", stack.files.join("+")),
            kind: "compose".into(),
            label: stack.files.join(" + "),
            config: EnvConfig::Compose { dir: stack.dir.clone(), files: stack.files.clone() },
            detail: stack.services.join(", "),
            ports: stack.ports.clone(),
            recommended: false,
            available: true,
            reason: None,
            problem: None,
            unsupported: vec![],
            honoured: vec![],
            features: vec![],
            initialize: vec![],
            offset_applies: true,
        });
    }
    // The direct run of a devcontainer that needs nothing only the CLI does; else the CLI; else the
    // first that can run (a direct run with features then says what it needs).
    let pick = out
        .iter()
        .position(|p| p.kind == "devcontainer" && p.available && p.unsupported.is_empty() && p.features.is_empty())
        .or_else(|| out.iter().position(|p| p.kind == "devcontainerCli" && p.available))
        .or_else(|| out.iter().position(|p| p.available));
    if let Some(index) = pick {
        out[index].recommended = true;
    }
    out
}

/// A host port nothing on this computer listens on, tried by binding it on localhost.
pub fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

// ------------------------------------------------------------------------------- env files

/// The files «Entorno» would read (`.env`, `.env.local`, `appsettings.Development.json`, …) that
/// the main checkout has, git does not track, and the new checkout lacks — copied across, so the
/// branch starts with the same local configuration. Relative paths of what was copied.
pub fn copy_env_files(main: &Path, checkout: &Path, eff: &crate::repo_env::config::Effective) -> Vec<String> {
    if lexical(main) == lexical(checkout) {
        return Vec::new();
    }
    let matcher = crate::repo_env::config::Matcher::new(&eff.patterns);
    let (found, _) = crate::repo_env::find_files(main, eff, &matcher);
    let missing: Vec<String> = found.into_iter().filter(|rel| !checkout.join(rel).exists()).collect();
    if missing.is_empty() {
        return Vec::new();
    }
    let mut args: Vec<&str> = vec!["ls-files", "--"];
    args.extend(missing.iter().map(String::as_str));
    let tracked: Vec<String> = match crate::git::cli::run_in(&main.to_string_lossy(), &args, &[]) {
        Ok(out) if out.success => out.stdout.lines().map(|l| l.trim().to_string()).collect(),
        // Unknown is taken for tracked: copying a file the branch deleted on purpose is the worse harm.
        _ => return Vec::new(),
    };
    let mut copied = Vec::new();
    for rel in missing.into_iter().filter(|rel| !tracked.contains(rel)) {
        let (Some(from), Some(to)) = (crate::repo_env::safe_join(main, &rel), crate::repo_env::safe_join(checkout, &rel)) else { continue };
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::copy(&from, &to).is_ok() {
            copied.push(rel);
        }
    }
    copied
}

// ------------------------------------------------------------------------------------ shape

/// How an environment's configuration runs, read from its checkout.
pub enum Shape {
    /// A Compose project: a stack, or a Compose devcontainer (`dev` is then its `devcontainer.json`).
    Compose { project_dir: PathBuf, files: Vec<PathBuf>, dev: Option<DevContainer> },
    /// One container from an image or a Dockerfile; the folder of its `devcontainer.json`.
    Single { dev: DevContainer, config_dir: PathBuf },
    /// `devcontainer up`, with this config: as written (`raw`, for the override config), read with
    /// the environment's variables (`dev`), and for a Compose one its folder and files.
    Cli { config: PathBuf, raw: Value, dev: DevContainer, compose: Option<(PathBuf, Vec<PathBuf>)> },
}

/// What `${…}` stands for in this environment's `devcontainer.json`: its checkout, and the
/// `${devcontainerId}` the CLI would compute from the same id label.
pub fn vars_for(env: &EnvRecord) -> devcontainer::Vars {
    let labels = BTreeMap::from([(ENV_LABEL.to_string(), env.id.clone())]);
    devcontainer::Vars::new(Path::new(&env.worktree_path), devcontainer::devcontainer_id(&labels), std::env::vars().collect())
}

/// A Compose devcontainer's files, relative to its `devcontainer.json`, kept inside the checkout;
/// and the project folder Compose would take (the first file's).
fn compose_files(root: &Path, config_dir: &Path, files: &[String], config: &str) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let mut abs = Vec::new();
    for file in files {
        let joined = lexical(&config_dir.join(file));
        if !joined.starts_with(lexical(root)) || !joined.is_file() {
            return Err(format!("{file} (named by {config}) is not in the branch's checkout"));
        }
        abs.push(joined);
    }
    let project_dir = abs.first().and_then(|f| f.parent()).map(Path::to_path_buf).unwrap_or_else(|| config_dir.to_path_buf());
    Ok((project_dir, abs))
}

/// The refusal of a direct run of a file with `features`, unless the user chose to run without them.
pub fn features_refusal(config: &str, features: &[String]) -> String {
    format!(
        "{config} asks for features ({}), which only the Dev Containers CLI installs: install it (npm i -g @devcontainers/cli) and use the CLI, or create the environment with \"run without features\"",
        features.join(", ")
    )
}

pub fn shape(env: &EnvRecord) -> Result<Shape, String> {
    let root = Path::new(&env.worktree_path);
    if !root.is_dir() {
        return Err(format!("the checkout {} is not there any more", env.worktree_path));
    }
    match &env.config {
        EnvConfig::Compose { dir, files } => {
            let files: Vec<PathBuf> = files.iter().map(|f| inside(root, f)).collect::<Result<_, _>>()?;
            if let Some(missing) = files.iter().find(|f| !f.is_file()) {
                return Err(format!("{} is not in the branch's checkout", missing.display()));
            }
            let project_dir = if dir.trim().is_empty() { root.to_path_buf() } else { inside(root, dir)? };
            Ok(Shape::Compose { project_dir, files, dev: None })
        }
        EnvConfig::Devcontainer { config, mode, without_features, .. } => {
            let path = inside(root, config)?;
            if !path.is_file() {
                return Err(format!("{config} is not in the branch's checkout"));
            }
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let dev = devcontainer::parse_with(&text, Some(&vars_for(env)))?;
            let config_dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
            if mode == "cli" {
                let compose = match &dev.source {
                    Source::Compose { files, .. } => Some(compose_files(root, &config_dir, files, config)?),
                    _ => None,
                };
                return Ok(Shape::Cli { config: path, raw: devcontainer::read_json(&text)?, dev, compose });
            }
            if !dev.features.is_empty() && !without_features {
                return Err(features_refusal(config, &dev.features));
            }
            match &dev.source {
                Source::Compose { files, .. } => {
                    let (project_dir, files) = compose_files(root, &config_dir, files, config)?;
                    Ok(Shape::Compose { project_dir, files, dev: Some(dev) })
                }
                Source::Unknown => Err(format!("{config} names no image, Dockerfile or Compose file: run it with the Dev Containers CLI")),
                _ => Ok(Shape::Single { dev, config_dir }),
            }
        }
    }
}

/// The branch's `initializeCommand` against the one approved: `Err` with [`INIT_CHANGED_PREFIX`] and
/// the commands as JSON when they differ — nothing of the repository runs on the host until the user
/// has seen it. Read as written (no variables), the way the create dialog showed it.
pub fn check_initialize(env: &EnvRecord) -> Result<(), String> {
    let EnvConfig::Devcontainer { config, approved_init, .. } = &env.config else { return Ok(()) };
    let path = inside(Path::new(&env.worktree_path), config)?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("couldn't read {config}: {e}"))?;
    let current = devcontainer::parse(&text)?.initialize_display();
    if current.is_empty() || &current == approved_init {
        Ok(())
    } else {
        Err(format!("{INIT_CHANGED_PREFIX}{}", serde_json::to_string(&current).unwrap_or_default()))
    }
}

// ---------------------------------------------------------------------------------- compose

/// What a Compose job is started with: the project, its folder, and its files with the override last.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeLaunch {
    pub project: String,
    pub project_dir: String,
    /// Comma-separated, as `SessionRequest.configFiles` takes them.
    pub config_files: String,
    pub ports: Vec<PortBinding>,
    pub warnings: Vec<EnvWarning>,
}

fn target_of(env: &EnvRecord) -> Target {
    Target { runtime: env.runtime.clone(), context: env.context.clone() }
}

fn compose_base_args(engine: EngineKind, project: &str, project_dir: &Path, files: &[PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = vec!["compose".into(), "-p".into(), project.into()];
    if engine != EngineKind::Podman {
        args.extend(["--project-directory".into(), project_dir.to_string_lossy().into_owned()]);
    }
    for file in files {
        args.extend(["-f".into(), file.to_string_lossy().into_owned()]);
    }
    args
}

/// Reads Compose's effective configuration of the stack, writes the override that moves its ports,
/// and answers with what `up` is to be given.
pub async fn plan_compose(env: &EnvRecord, project_dir: &Path, files: &[PathBuf]) -> Result<(ComposeLaunch, OverridePlan), String> {
    let target = target_of(env);
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return Err("ctr has no Compose: install nerdctl, Docker or Podman".into());
    }
    if !plan::valid_compose_project(&env.compose_project) {
        return Err(format!("\"{}\" is not a Compose project name", env.compose_project));
    }
    if engine == EngineKind::Docker {
        if let Ok(out) = target.run_owned(vec!["compose".into(), "version".into(), "--short".into()], CONFIG_TIMEOUT).await {
            if plan::compose_supports_override(&out.stdout) == Some(false) {
                return Err(format!("Docker Compose {} cannot move published ports (it needs 2.24.4 or later): update Docker", out.stdout.trim()));
            }
        }
    }
    let mut args = compose_base_args(engine, &env.compose_project, project_dir, files);
    args.extend(["config".into(), "--format".into(), "json".into()]);
    let out = target.run_owned(args, CONFIG_TIMEOUT).await?;
    if !out.ok() {
        return Err(out.complaint());
    }
    let config: Value = cli::json_values(&out.stdout).into_iter().next().ok_or("Compose printed no configuration")?;
    let plan = plan::compose_override(&config, &env.compose_project, env.port_offset)?;
    let path = override_path(&env.id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, &plan.yaml).map_err(|e| format!("couldn't write {}: {e}", path.display()))?;
    let mut all: Vec<String> = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
    all.push(path.to_string_lossy().into_owned());
    let launch = ComposeLaunch {
        project: env.compose_project.clone(),
        project_dir: project_dir.to_string_lossy().into_owned(),
        config_files: all.join(","),
        ports: plan.ports.clone(),
        warnings: plan.warnings.clone(),
    };
    Ok((launch, plan))
}

/// `{projectDir, configFiles}` for `engine::act` on the project — the override included when it was
/// written, so an engine that reads the files (Podman) sees the same project `up` made.
fn compose_options(env: &EnvRecord) -> Value {
    let compose = match shape(env) {
        Ok(Shape::Compose { project_dir, files, .. }) => Some((project_dir, files)),
        Ok(Shape::Cli { compose, .. }) => compose,
        _ => None,
    };
    match compose {
        Some((project_dir, files)) => {
            let mut all: Vec<String> = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
            let over = override_path(&env.id);
            if over.is_file() {
                all.push(over.to_string_lossy().into_owned());
            }
            json!({ "projectDir": project_dir.to_string_lossy(), "configFiles": all.join(",") })
        }
        None => json!({}),
    }
}

// --------------------------------------------------------------------------------- running

/// The containers of an environment, out of an engine's whole list: its Compose project's, and the
/// ones labelled with its id (a devcontainer run directly or by the CLI).
pub fn rows_of<'a>(env: &EnvRecord, rows: &'a [ContainerRow]) -> Vec<&'a ContainerRow> {
    rows.iter().filter(|r| r.project == env.compose_project || r.labels.get(ENV_LABEL).is_some_and(|v| v == &env.id)).collect()
}

async fn lifecycle(target: &Target, container: &str, dev: &DevContainer, commands: &[Vec<String>], log: &mut String) -> Result<(), String> {
    let folder = dev.workspace_folder.clone();
    for argv in commands {
        let args = devcontainer::exec_args(container, folder.as_deref(), dev.remote_user.as_deref().or(dev.container_user.as_deref()), &dev.remote_env, argv);
        log.push_str(&format!("$ {}\n", argv.join(" ")));
        let out = target.run_owned(args, LIFECYCLE_TIMEOUT).await?;
        log.push_str(out.stdout.trim_end());
        log.push('\n');
        if !out.ok() {
            return Err(format!("{} failed:\n{}", argv.join(" "), out.complaint()));
        }
    }
    Ok(())
}

/// What `up` did, for the page to show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpResult {
    pub log: String,
    pub ports: Vec<PortBinding>,
    pub warnings: Vec<EnvWarning>,
}

fn unsupported_warnings(dev: &DevContainer, cli: bool) -> Vec<EnvWarning> {
    let ignored = if cli { dev.ignored_cli() } else { dev.ignored_direct() };
    let mut out: Vec<EnvWarning> = ignored.into_iter().map(|key| EnvWarning::new("unsupported", key)).collect();
    if !cli && !dev.features.is_empty() {
        out.push(EnvWarning::new("withoutFeatures", dev.features.join(", ")));
    }
    out
}

fn push_unique(into: &mut Vec<EnvWarning>, more: impl IntoIterator<Item = EnvWarning>) {
    for w in more {
        if !into.contains(&w) {
            into.push(w);
        }
    }
}

/// The workspace's security policy, and where the latest kept scan of an image is read.
pub struct Gate<'a> {
    pub policy: policy::SecurityPolicy,
    pub db: Option<&'a crate::db::Db>,
}

impl Gate<'_> {
    fn scan(&self, image: &str) -> Option<super::scan::ScanSummary> {
        let conn = self.db?.0.lock().ok()?;
        policy::latest_scan(&conn, image)
    }

    /// What the policy needs to know about running `image` on `network`, asked only for its rules.
    async fn facts(&self, target: &Target, image: &str, network: &str) -> policy::Facts {
        let network = if network.trim().is_empty() { "bridge".to_string() } else { network.trim().to_string() };
        let scan = self.scan(image);
        policy::facts_for(target, image, &[network], &self.policy, scan).await
    }

    /// A container that runs, judged by its own `inspect` document: `Err` (and the container
    /// stopped) when it breaks the policy, else the warnings for what weakens it.
    async fn check_running(&self, target: &Target, container: &str) -> Result<Vec<EnvWarning>, String> {
        let text = engine::inspect(target, "container", container).await?;
        let doc: Value = serde_json::from_str(&text).map_err(|_| "the engine's inspect document could not be read".to_string())?;
        let image = doc.pointer("/Config/Image").and_then(Value::as_str).unwrap_or_default().to_string();
        let networks: Vec<String> = doc.pointer("/NetworkSettings/Networks").and_then(Value::as_object).map(|n| n.keys().cloned().collect()).unwrap_or_default();
        let scan = self.scan(&image);
        let mut facts = policy::facts_for(target, &image, &networks, &self.policy, scan).await;
        facts.image_user.clear();
        let verdict = direct::judge_document(&self.policy, &doc, &[], &facts, dirs::home_dir().as_deref());
        if verdict.blocked() {
            let _ = target.run_owned(vec!["stop".into(), container.to_string()], engine::ACTION_TIMEOUT).await;
            return Err(format!("the container was started differently than its file shows (features add flags of their own) and has been stopped: {}", verdict.refusal()));
        }
        Ok(verdict.warnings)
    }
}

/// Everything a pipe gives until it closes.
async fn read_pipe(pipe: Option<impl tokio::io::AsyncRead + Unpin>) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_end(&mut bytes).await;
    }
    bytes
}

/// One host command in `cwd` (the branch's checkout), with the panel's `PATH` and engine variables,
/// killed with what it started at `timeout`. A relative program (`./scripts/prep.sh`) is the
/// checkout's.
async fn run_on_host(argv: &[String], cwd: &Path, timeout: Duration) -> Result<cli::Output, String> {
    let (program, args) = argv.split_first().ok_or("an empty initializeCommand")?;
    let program = if program.contains('/') && !Path::new(program).is_absolute() { cwd.join(program).to_string_lossy().into_owned() } else { program.clone() };
    let mut cmd = crate::proc::command(&program);
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", cli::search_path())
        .envs(cli::engine_env().await)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::proc::own_process_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start {program}: {e}"))?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let finished = tokio::time::timeout(timeout, async {
        let (stdout, stderr) = tokio::join!(read_pipe(stdout), read_pipe(stderr));
        (child.wait().await, stdout, stderr)
    })
    .await;
    match finished {
        Ok((Ok(status), stdout, stderr)) => Ok(cli::Output { code: status.code(), stdout: String::from_utf8_lossy(&stdout).into_owned(), stderr: String::from_utf8_lossy(&stderr).into_owned() }),
        Ok((Err(error), _, _)) => Err(format!("{program}: {error}")),
        Err(_) => {
            crate::ai_runs::kill_tree(&mut child).await;
            Err(format!("initializeCommand did not finish within {} min and was stopped", timeout.as_secs() / 60))
        }
    }
}

/// `initializeCommand`, on the host, in the checkout — its output in the log; a failure stops the start.
async fn run_initialize(dev: &DevContainer, root: &Path, log: &mut String) -> Result<(), String> {
    for command in &dev.initialize {
        let argv = direct::host_argv(command, cfg!(windows));
        log.push_str(&format!("$ initializeCommand (on this computer, in {}): {}\n", root.display(), command.display()));
        let out = run_on_host(&argv, root, INITIALIZE_TIMEOUT).await.map_err(|e| format!("{}\n{e}", log.trim()))?;
        for text in [out.stdout.trim_end(), out.stderr.trim_end()] {
            if !text.is_empty() {
                log.push_str(text);
                log.push('\n');
            }
        }
        if !out.ok() {
            return Err(format!("initializeCommand failed (exit {}):\n{}", out.code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()), log.trim()));
        }
    }
    Ok(())
}

/// Brings up a devcontainer environment (a Compose stack goes through the jobs panel instead, with
/// [`plan_compose`]). `rebuild` builds again and replaces the containers. Refused before anything
/// runs when the branch's `initializeCommand` is not the approved one.
pub async fn up_devcontainer(env: &EnvRecord, rebuild: bool, gate: &Gate<'_>) -> Result<UpResult, String> {
    let target = target_of(env);
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return Err("ctr cannot run a devcontainer: install nerdctl, Docker or Podman".into());
    }
    let shape = shape(env)?;
    check_initialize(env)?;
    match shape {
        Shape::Cli { config, raw, dev, compose } => up_with_cli(env, &target, engine, &config, &raw, &dev, compose, rebuild, gate).await,
        Shape::Single { dev, config_dir } => up_single(env, &target, &dev, &config_dir, rebuild, gate).await,
        Shape::Compose { project_dir, files, dev } => {
            let Some(dev) = dev else { return Err("a Compose stack is started from the jobs panel".into()) };
            let mut log = String::new();
            run_initialize(&dev, Path::new(&env.worktree_path), &mut log).await?;
            let (_, plan) = plan_compose(env, &project_dir, &files).await?;
            let Source::Compose { service, run_services, .. } = &dev.source else { unreachable!("a Compose shape has a Compose source") };
            let before = engine::list_containers(&target).await.unwrap_or_default();
            let existed = before.iter().any(|r| r.project == env.compose_project && &r.service == service);
            let mut all = files.clone();
            all.push(override_path(&env.id));
            let mut args = compose_base_args(engine, &env.compose_project, &project_dir, &all);
            args.extend(["up".into(), "-d".into()]);
            if rebuild {
                args.extend(["--build".into(), "--force-recreate".into()]);
            }
            if !run_services.is_empty() {
                let mut wanted = run_services.clone();
                if !wanted.contains(service) {
                    wanted.push(service.clone());
                }
                for name in &wanted {
                    engine::check_ref(name)?;
                }
                args.extend(wanted);
            }
            let out = target.run_owned(args, engine::PULL_TIMEOUT).await?;
            log.push_str(&format!("{}\n{}\n", out.stdout.trim(), out.stderr.trim()));
            if !out.ok() {
                return Err(out.complaint());
            }
            let rows = engine::list_containers(&target).await?;
            let container = rows.iter().find(|r| r.project == env.compose_project && &r.service == service).map(|r| r.id.clone()).ok_or_else(|| format!("Compose started no {service} container"))?;
            if !existed || rebuild {
                lifecycle(&target, &container, &dev, &dev.on_create, &mut log).await?;
                lifecycle(&target, &container, &dev, &dev.update_content, &mut log).await?;
                lifecycle(&target, &container, &dev, &dev.post_create, &mut log).await?;
            }
            lifecycle(&target, &container, &dev, &dev.post_start, &mut log).await?;
            let mut warnings = plan.warnings;
            push_unique(&mut warnings, unsupported_warnings(&dev, false));
            Ok(UpResult { log: log.trim().to_string(), ports: plan.ports, warnings })
        }
    }
}

/// The ports of a single-container devcontainer, moved by the offset.
pub fn single_ports(dev: &DevContainer, offset: u16) -> Result<Vec<PortBinding>, String> {
    dev.ports
        .iter()
        .map(|(host, container)| {
            let moved = *host as u32 + offset as u32;
            if moved > u16::MAX as u32 {
                return Err(format!("port {host} + {offset} is past 65535: choose a smaller offset"));
            }
            Ok(PortBinding { service: "dev".into(), target: *container, protocol: "tcp".into(), host_ip: "127.0.0.1".into(), base: Some(*host), host: Some(moved as u16), host_end: None })
        })
        .collect()
}

/// What `run` is given beyond the image, judged: the workspace mount, `mounts`, `runArgs` and the
/// file's own flags, with the facts the policy reads and the ports they publish.
pub struct SinglePlan {
    pub folder: String,
    pub workspace_mount: Option<String>,
    pub mounts: Vec<String>,
    pub extra: Vec<String>,
    /// Every port published (`runArgs`' own first).
    pub ports: Vec<PortBinding>,
    /// The `forwardPorts`/`appPort` ones `run` adds itself as (host, container) — `runArgs`' are in `extra`.
    pub config_ports: Vec<(u16, u16)>,
    pub facts: direct::RunFacts,
    pub warnings: Vec<EnvWarning>,
}

/// [`SinglePlan`] for one container of `dev` in `checkout`, its ports moved by `offset`.
pub fn plan_single(dev: &DevContainer, checkout: &Path, offset: u16) -> Result<SinglePlan, String> {
    let folder = dev
        .workspace_folder
        .clone()
        .or_else(|| dev.workspace_mount.as_ref().map(|m| m.target.clone()))
        .unwrap_or_else(|| devcontainer::default_workspace_folder(checkout));
    let mut facts = direct::RunFacts { user: dev.container_user.clone().unwrap_or_default(), ..Default::default() };
    let workspace_mount = match &dev.workspace_mount {
        Some(mount) => Some(direct::mount_value(mount, &mut facts)?),
        None => {
            facts.mounts.push(("bind".into(), checkout.to_string_lossy().into_owned(), true));
            None
        }
    };
    let mounts: Vec<String> = dev.mounts.iter().map(|m| direct::mount_value(m, &mut facts)).collect::<Result<_, _>>()?;
    let mut raw = direct::config_flags(dev);
    raw.extend(dev.run_args.iter().cloned());
    let parsed = direct::parse_run_args(&raw, offset, checkout, &mut facts)?;
    let ports = direct::merge_ports(&parsed.ports, single_ports(dev, offset)?);
    let mut config_ports = Vec::new();
    for port in ports.iter().filter(|p| !parsed.ports.contains(p)) {
        if let Some(host) = port.host {
            facts.published.push((port.host_ip.clone(), host.to_string(), format!("{}/{}", port.target, port.protocol)));
            config_ports.push((host, port.target));
        }
    }
    let mut warnings = unsupported_warnings(dev, false);
    warnings.extend(parsed.dropped.iter().map(|d| EnvWarning::new("dropped", d.clone())));
    if ports.is_empty() {
        warnings.push(EnvWarning::new("noPorts", String::new()));
    }
    Ok(SinglePlan { folder, workspace_mount, mounts, extra: parsed.args, ports, config_ports, facts, warnings })
}

/// The ports a container really publishes, read back; the planned ones when it cannot be read.
async fn published_ports(target: &Target, container: &str, planned: Vec<PortBinding>) -> Vec<PortBinding> {
    match engine::inspect(target, "container", container).await.ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(doc) => {
            let read = direct::ports_from_inspect(&doc, &planned);
            if read.is_empty() { planned } else { read }
        }
        None => planned,
    }
}

async fn up_single(env: &EnvRecord, target: &Target, dev: &DevContainer, config_dir: &Path, rebuild: bool, gate: &Gate<'_>) -> Result<UpResult, String> {
    let name = format!("{}-dev", env.compose_project);
    manage::check_name(&name, "container")?;
    let root = Path::new(&env.worktree_path);
    let rows = engine::list_containers(target).await?;
    let existing: Vec<String> = rows_of(env, &rows).iter().map(|r| r.id.clone()).collect();
    let mut log = String::new();
    // Judged before anything of the repository runs, here or on the host.
    let plan = plan_single(dev, root, env.port_offset)?;
    let early = direct::judge(&gate.policy, &plan.facts, &policy::Facts::default(), dirs::home_dir().as_deref());
    if early.blocked() {
        return Err(early.refusal());
    }
    let mut warnings = plan.warnings.clone();
    if let Some(w) = warnings.iter_mut().find(|w| w.code == "noPorts") {
        w.subject = env.compose_project.clone();
    }
    run_initialize(dev, root, &mut log).await?;

    if !existing.is_empty() && !rebuild {
        let out = target.run_owned(["start".to_string()].into_iter().chain(existing.iter().cloned()).collect(), engine::ACTION_TIMEOUT).await?;
        if !out.ok() {
            return Err(out.complaint());
        }
        let dev = DevContainer { workspace_folder: Some(plan.folder.clone()), ..dev.clone() };
        lifecycle(target, &existing[0], &dev, &dev.post_start, &mut log).await?;
        push_unique(&mut warnings, early.warnings);
        let ports = published_ports(target, &existing[0], plan.ports.clone()).await;
        return Ok(UpResult { log: log.trim().to_string(), ports, warnings });
    }
    if !existing.is_empty() {
        let out = target.run_owned(["rm".to_string(), "-f".into()].into_iter().chain(existing.iter().cloned()).collect(), engine::ACTION_TIMEOUT).await?;
        if !out.ok() {
            return Err(out.complaint());
        }
    }
    let image = match &dev.source {
        Source::Image { image } => {
            engine::check_ref(image)?;
            let have = target.run_owned(vec!["image".into(), "inspect".into(), image.clone()], engine::LIST_TIMEOUT).await.map(|o| o.ok()).unwrap_or(false);
            if !have {
                log.push_str(&format!("$ pull {image}\n"));
                let out = target.run_owned(vec!["pull".into(), image.clone()], engine::PULL_TIMEOUT).await?;
                log.push_str(out.stderr.trim_end());
                log.push('\n');
                if !out.ok() {
                    return Err(out.complaint());
                }
            }
            image.clone()
        }
        Source::Dockerfile { dockerfile, context, args, target: stage, options, cache_from } => {
            let file = lexical(&config_dir.join(dockerfile));
            let context = lexical(&config_dir.join(context));
            if !file.starts_with(lexical(root)) || !context.starts_with(lexical(root)) || !file.is_file() {
                return Err(format!("{dockerfile} is not in the branch's checkout"));
            }
            let tag = format!("codeflow-env-{}:latest", env.compose_project);
            let (build, build_warnings) = direct::build_args(&direct::BuildPlan { tag: &tag, dockerfile: &file, context: &context, args, target: stage.as_deref(), options, cache_from })?;
            warnings.extend(build_warnings);
            log.push_str(&format!("$ build {tag}\n"));
            let out = target.run_owned(build, engine::PULL_TIMEOUT).await?;
            log.push_str(out.stderr.trim_end());
            log.push('\n');
            if !out.ok() {
                return Err(out.complaint());
            }
            tag
        }
        _ => return Err("this devcontainer is not one container".into()),
    };
    let known = gate.facts(target, &image, &plan.facts.network).await;
    let verdict = direct::judge(&gate.policy, &plan.facts, &known, dirs::home_dir().as_deref());
    if verdict.blocked() {
        return Err(verdict.refusal());
    }
    push_unique(&mut warnings, verdict.warnings);
    let run = devcontainer::run_args(&devcontainer::RunPlan {
        name: &name,
        env_id: &env.id,
        project: &env.compose_project,
        image: &image,
        checkout: root,
        workspace_folder: &plan.folder,
        ports: &plan.config_ports,
        env: &dev.container_env,
        user: dev.container_user.as_deref(),
        override_command: dev.override_command,
        workspace_mount: plan.workspace_mount.as_deref(),
        mounts: &plan.mounts,
        extra: &plan.extra,
    })?;
    let out = target.run_owned(run, engine::PULL_TIMEOUT).await?;
    if !out.ok() {
        return Err(out.complaint());
    }
    let container = out.stdout.trim().lines().last().unwrap_or(&name).trim().to_string();
    let dev = DevContainer { workspace_folder: Some(plan.folder.clone()), ..dev.clone() };
    lifecycle(target, &container, &dev, &dev.on_create, &mut log).await?;
    lifecycle(target, &container, &dev, &dev.update_content, &mut log).await?;
    lifecycle(target, &container, &dev, &dev.post_create, &mut log).await?;
    lifecycle(target, &container, &dev, &dev.post_start, &mut log).await?;
    let ports = published_ports(target, &container, plan.ports.clone()).await;
    Ok(UpResult { log: log.trim().to_string(), ports, warnings })
}

/// `devcontainer up --workspace-folder <checkout> --config <file> --override-config <cache file>
/// --id-label codeflow.env=<id>`. The override is the file with its ports moved by the offset
/// ([`direct::cli_override`]); a Compose devcontainer also gets the Compose override of
/// [`plan_compose`] and `COMPOSE_PROJECT_NAME`, so its project is the environment's. What the file
/// declares is judged before the CLI runs anything; the container it made, after.
#[allow(clippy::too_many_arguments)]
async fn up_with_cli(env: &EnvRecord, target: &Target, engine: EngineKind, config: &Path, raw: &Value, dev: &DevContainer, compose: Option<(PathBuf, Vec<PathBuf>)>, rebuild: bool, gate: &Gate<'_>) -> Result<UpResult, String> {
    let program = cli::find("devcontainer").ok_or("the Dev Containers CLI (`devcontainer`) is not installed: npm install -g @devcontainers/cli")?;
    let root = Path::new(&env.worktree_path);
    let mut warnings = unsupported_warnings(dev, true);
    if compose.is_none() {
        // Best effort: a flag only the CLI knows is left to the check of the container it makes.
        let mut facts = direct::RunFacts { user: dev.container_user.clone().unwrap_or_default(), ..Default::default() };
        for mount in dev.mounts.iter().chain(dev.workspace_mount.iter()) {
            let _ = direct::mount_value(mount, &mut facts);
        }
        let mut flags = direct::config_flags(dev);
        flags.extend(dev.run_args.iter().cloned());
        let _ = direct::parse_run_args(&flags, env.port_offset, root, &mut facts);
        let early = direct::judge(&gate.policy, &facts, &policy::Facts::default(), dirs::home_dir().as_deref());
        if early.blocked() {
            return Err(early.refusal());
        }
    }
    let (doc, mut ports) = match &compose {
        Some((project_dir, files)) => {
            let (_, plan) = plan_compose(env, project_dir, files).await?;
            push_unique(&mut warnings, plan.warnings);
            let (doc, _) = direct::cli_override(raw, dev, env.port_offset, Some(&override_path(&env.id)))?;
            (doc, plan.ports)
        }
        None => direct::cli_override(raw, dev, env.port_offset, None)?,
    };
    let override_file = direct::override_config_path(&work_dir(&env.id));
    if let Some(parent) = override_file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
    }
    std::fs::write(&override_file, serde_json::to_string_pretty(&doc).unwrap_or_default()).map_err(|e| format!("couldn't write {}: {e}", override_file.display()))?;
    let mut args: Vec<String> = vec![
        "up".into(),
        "--workspace-folder".into(),
        env.worktree_path.clone(),
        "--config".into(),
        config.to_string_lossy().into_owned(),
        "--override-config".into(),
        override_file.to_string_lossy().into_owned(),
        "--id-label".into(),
        format!("{ENV_LABEL}={}", env.id),
        "--docker-path".into(),
        engine.program(),
    ];
    if rebuild {
        args.push("--remove-existing-container".into());
    }
    let mut vars = cli::engine_env().await;
    if let Some(context) = target.context.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        engine::check_ref(context)?;
        if engine == EngineKind::Docker {
            vars.push(("DOCKER_CONTEXT".into(), context.into()));
        }
    }
    if compose.is_some() {
        vars.push(("COMPOSE_PROJECT_NAME".into(), env.compose_project.clone()));
    }
    let out = cli::run_with(&program.to_string_lossy(), &args, None, engine::PULL_TIMEOUT, &vars).await?;
    let log = format!("{}\n{}", out.stderr.trim(), out.stdout.trim()).trim().to_string();
    if !out.ok() {
        return Err(out.complaint());
    }
    let container = match (direct::cli_container_id(&out.stdout), &compose, &dev.source) {
        (Some(id), _, _) => Some(id),
        (None, Some(_), Source::Compose { service, .. }) => {
            let rows = engine::list_containers(target).await.unwrap_or_default();
            rows.iter().find(|r| r.project == env.compose_project && &r.service == service).map(|r| r.id.clone())
        }
        _ => None,
    };
    if let Some(container) = &container {
        push_unique(&mut warnings, gate.check_running(target, container).await?);
        if compose.is_none() {
            ports = published_ports(target, container, ports).await;
        }
    }
    Ok(UpResult { log, ports, warnings })
}

/// Stops what runs, keeping containers, volumes and checkout.
pub async fn stop(env: &EnvRecord) -> Result<String, String> {
    let target = target_of(env);
    let rows = engine::list_containers(&target).await?;
    let mine = rows_of(env, &rows);
    let mut said = Vec::new();
    if mine.iter().any(|r| r.project == env.compose_project) {
        said.push(engine::act(&target, "project", "stop", std::slice::from_ref(&env.compose_project), &compose_options(env)).await?);
    }
    let single: Vec<String> = mine.iter().filter(|r| r.project != env.compose_project && r.state == "running").map(|r| r.id.clone()).collect();
    if !single.is_empty() {
        said.push(engine::act(&target, "container", "stop", &single, &json!({})).await?);
    }
    Ok(said.join("\n").trim().to_string())
}

/// Takes the containers away: `compose down` (and `-v`), or `rm -f` of the labelled ones.
pub async fn down(env: &EnvRecord, volumes: bool) -> Result<String, String> {
    let target = target_of(env);
    let rows = engine::list_containers(&target).await?;
    let mine = rows_of(env, &rows);
    let mut said = Vec::new();
    if mine.iter().any(|r| r.project == env.compose_project) {
        let mut options = compose_options(env);
        options["volumes"] = json!(volumes);
        said.push(engine::act(&target, "project", "down", std::slice::from_ref(&env.compose_project), &options).await?);
    }
    let single: Vec<String> = mine.iter().filter(|r| r.project != env.compose_project).map(|r| r.id.clone()).collect();
    if !single.is_empty() {
        said.push(engine::act(&target, "container", "remove", &single, &json!({ "volumes": volumes })).await?);
    }
    let _ = std::fs::remove_dir_all(work_dir(&env.id));
    Ok(said.join("\n").trim().to_string())
}

// ---------------------------------------------------------------------------------- status

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvService {
    pub id: String,
    pub name: String,
    pub state: String,
    pub health: String,
}

/// An environment as the page lists it: the row, and what the engine says right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvView {
    #[serde(flatten)]
    pub env: EnvRecord,
    pub worktree_exists: bool,
    /// `running`, `partial`, `stopped`, `absent` (no containers) or `unknown` (the engine did not answer).
    pub status: String,
    pub services: Vec<EnvService>,
    pub problem: Option<String>,
}

pub fn status_of(rows: &[&ContainerRow]) -> &'static str {
    let running = rows.iter().filter(|r| r.state == "running").count();
    match (rows.len(), running) {
        (0, _) => "absent",
        (total, up) if up == total => "running",
        (_, 0) => "stopped",
        _ => "partial",
    }
}

/// Every environment with its containers, each engine asked once.
pub async fn views(envs: Vec<EnvRecord>) -> Vec<EnvView> {
    let mut lists: BTreeMap<(String, Option<String>), Result<Vec<ContainerRow>, String>> = BTreeMap::new();
    for env in &envs {
        let key = (env.runtime.clone(), env.context.clone());
        if !lists.contains_key(&key) {
            let listed = engine::list_containers(&target_of(env)).await;
            lists.insert(key, listed);
        }
    }
    envs.into_iter()
        .map(|env| {
            let worktree_exists = Path::new(&env.worktree_path).is_dir();
            let (status, services, problem) = match &lists[&(env.runtime.clone(), env.context.clone())] {
                Ok(rows) => {
                    let mine = rows_of(&env, rows);
                    let services = mine
                        .iter()
                        .map(|r| EnvService { id: r.id.clone(), name: if r.service.is_empty() { r.name.clone() } else { r.service.clone() }, state: r.state.clone(), health: r.health.clone() })
                        .collect();
                    (status_of(&mine).to_string(), services, None)
                }
                Err(error) => ("unknown".to_string(), vec![], Some(super::tidy_problem(error))),
            };
            EnvView { env, worktree_exists, status, services, problem }
        })
        .collect()
}

// -------------------------------------------------------------------------------- snapshots

/// The named volumes an environment's containers use: its Compose project's, and the ones its
/// labelled containers mount.
pub async fn volumes_of(env: &EnvRecord) -> Result<Vec<String>, String> {
    let target = target_of(env);
    let mut names: Vec<String> = Vec::new();
    let filter = format!("label=com.docker.compose.project={}", env.compose_project);
    let out = target.run_owned(vec!["volume".into(), "ls".into(), "--filter".into(), filter, "--format".into(), "{{.Name}}".into()], engine::LIST_TIMEOUT).await?;
    if out.ok() {
        names.extend(out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string));
    }
    let rows = engine::list_containers(&target).await?;
    for row in rows_of(env, &rows) {
        names.extend(row.mounts.iter().cloned());
    }
    names.sort();
    names.dedup();
    names.retain(|n| manage::check_name(n, "volume").is_ok());
    Ok(names)
}

/// What a snapshot folder says about itself, so it can be restored into another environment.
pub const SNAPSHOT_MANIFEST: &str = "codeflow-snapshot.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResult {
    pub folder: String,
    pub volumes: Vec<String>,
    pub bytes: u64,
}

/// Every volume of the environment as `<folder>/<project>-<time>/<volume>.tar.gz`, with a manifest.
pub async fn snapshot(env: &EnvRecord, dest: &Path, stamp: &str) -> Result<SnapshotResult, String> {
    if !dest.is_absolute() || !dest.is_dir() {
        return Err(format!("{} is not a folder of this computer", dest.display()));
    }
    let volumes = volumes_of(env).await?;
    if volumes.is_empty() {
        return Err("this environment has no volumes to keep".into());
    }
    let folder = dest.join(format!("{}-{}", env.compose_project, plan::slug(stamp, 32)));
    std::fs::create_dir_all(&folder).map_err(|e| format!("couldn't create {}: {e}", folder.display()))?;
    let target = target_of(env);
    let mut bytes = 0;
    for volume in &volumes {
        bytes += manage::backup_volume(&target, volume, &folder.join(format!("{volume}.tar.gz"))).await?;
    }
    let manifest = json!({ "project": env.compose_project, "branch": env.branch, "volumes": volumes, "createdAt": stamp });
    std::fs::write(folder.join(SNAPSHOT_MANIFEST), serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(SnapshotResult { folder: folder.to_string_lossy().into_owned(), volumes, bytes })
}

/// A snapshot folder's archives unpacked into the environment's volumes — those of the snapshot's
/// own project renamed to this one's (see [`plan::restore_target`]), so a snapshot of `main` seeds a
/// new branch. Each volume is emptied first. The volumes restored, by their new names.
pub async fn restore(env: &EnvRecord, folder: &Path) -> Result<Vec<String>, String> {
    let manifest: Value = std::fs::read_to_string(folder.join(SNAPSHOT_MANIFEST)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let from_project = manifest.get("project").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut archives: Vec<String> = std::fs::read_dir(folder)
        .map_err(|e| format!("couldn't read {}: {e}", folder.display()))?
        .flatten()
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".tar.gz")).map(str::to_string))
        .filter(|name| manage::check_name(name, "volume").is_ok())
        .collect();
    archives.sort();
    if archives.is_empty() {
        return Err(format!("{} holds no volume archives", folder.display()));
    }
    let target = target_of(env);
    let mut restored = Vec::new();
    for archive in archives {
        let into = plan::restore_target(&from_project, &env.compose_project, &archive);
        manage::check_name(&into, "volume")?;
        manage::restore_volume(&target, &into, &folder.join(format!("{archive}.tar.gz")), true).await?;
        restored.push(into);
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::git::cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(out.success, "git {args:?}: {}", out.combined());
    }

    #[test]
    fn paths_stay_inside_the_checkout() {
        let root = Path::new("/w/shop");
        assert_eq!(inside(root, "docker/compose.yml").unwrap(), PathBuf::from("/w/shop/docker/compose.yml"));
        assert_eq!(inside(root, ".devcontainer/../compose.yml").unwrap(), PathBuf::from("/w/shop/compose.yml"));
        assert!(inside(root, "../other/compose.yml").is_err());
        assert!(inside(root, "/etc/passwd").is_err());
        assert!(inside(root, "").is_err());
    }

    #[test]
    fn untracked_env_files_follow_the_branch_and_tracked_ones_do_not() {
        let root = std::env::temp_dir().join(format!("cf-envs-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        fs::create_dir_all(main.join("api")).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        for (k, v) in [("user.name", "T"), ("user.email", "t@e.com"), ("commit.gpgsign", "false"), ("core.hooksPath", "/dev/null")] {
            git(&main, &["config", k, v]);
        }
        fs::write(main.join(".gitignore"), ".env\napi/.env.local\n").unwrap();
        fs::write(main.join(".env.example"), "A=\n").unwrap();
        fs::write(main.join("compose.yaml"), "services:\n  web:\n    image: nginx\n    ports:\n      - \"8080:80\"\n").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-q", "-m", "first"]);
        fs::write(main.join(".env"), "A=1\n").unwrap();
        fs::write(main.join("api/.env.local"), "B=2\n").unwrap();

        let checkout = root.join("feature");
        let made = crate::git::branch_worktree::ensure(main.to_str().unwrap(), &checkout, "feature/x", Some("main")).unwrap();
        assert!(made.created);
        let eff = crate::repo_env::config::effective(&Default::default(), &Default::default());
        let mut copied = copy_env_files(&main, &checkout, &eff);
        copied.sort();
        assert_eq!(copied, vec![".env", "api/.env.local"]);
        assert_eq!(fs::read_to_string(checkout.join("api/.env.local")).unwrap(), "B=2\n");
        assert!(copy_env_files(&main, &checkout, &eff).is_empty(), "nothing twice");
        assert!(!crate::git::branch_worktree::is_dirty(&made.path).unwrap(), "ignored copies are not changes");

        let proposals = discover(&checkout, false);
        let compose = proposals.iter().find(|p| p.kind == "compose").unwrap();
        assert!(compose.recommended && compose.available);
        assert_eq!(compose.ports, vec![8080]);

        crate::git::branch_worktree::remove(main.to_str().unwrap(), &made.path, false).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_devcontainer_is_proposed_before_compose_and_the_cli_only_when_installed() {
        let root = std::env::temp_dir().join(format!("cf-envs-d-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".devcontainer")).unwrap();
        fs::write(root.join(".devcontainer/devcontainer.json"), "{ // c\n \"image\": \"node:20\", \"forwardPorts\": [3000], }").unwrap();
        fs::write(root.join("compose.yaml"), "services:\n  db:\n    image: postgres\n").unwrap();
        let found = discover(&root, false);
        assert_eq!(found[0].kind, "devcontainer");
        assert!(found[0].recommended);
        assert_eq!(found[0].ports, vec![3000]);
        assert_eq!(found[1].kind, "devcontainerCli");
        assert_eq!(found[1].reason.as_deref(), Some("noCli"));

        fs::write(root.join(".devcontainer/devcontainer.json"), "{ \"image\": \"node\", \"features\": { \"x\": {} } }").unwrap();
        let found = discover(&root, true);
        assert!(found.iter().find(|p| p.kind == "devcontainerCli").unwrap().recommended, "features need the CLI");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_environment_is_running_only_when_all_of_it_runs() {
        let row = |state: &str| ContainerRow { state: state.into(), ..blank_row() };
        let (a, b) = (row("running"), row("exited"));
        assert_eq!(status_of(&[]), "absent");
        assert_eq!(status_of(&[&a]), "running");
        assert_eq!(status_of(&[&a, &b]), "partial");
        assert_eq!(status_of(&[&b]), "stopped");
    }

    fn blank_row() -> ContainerRow {
        engine::parse_containers("{\"ID\":\"x\",\"Names\":\"x\",\"State\":\"running\"}").into_iter().next().unwrap()
    }

    fn env_at(root: &Path, config: EnvConfig) -> EnvRecord {
        EnvRecord {
            id: "e1".into(),
            project_id: "p".into(),
            repo_name: "shop".into(),
            repo_path: root.to_string_lossy().into_owned(),
            branch: "main".into(),
            base: String::new(),
            worktree_path: root.to_string_lossy().into_owned(),
            worktree_created: false,
            compose_project: "shop-main".into(),
            port_offset: 100,
            runtime: "docker".into(),
            context: None,
            config,
            ports: vec![],
            warnings: vec![],
            copied_files: vec![],
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn dev_config(mode: &str, without_features: bool, approved_init: &[&str]) -> EnvConfig {
        EnvConfig::Devcontainer { config: ".devcontainer/devcontainer.json".into(), mode: mode.into(), without_features, approved_init: approved_init.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn features_wait_for_the_cli_or_an_explicit_choice_and_initialize_for_an_approval() {
        let root = std::env::temp_dir().join(format!("cf-envs-f-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".devcontainer")).unwrap();
        fs::write(root.join(".devcontainer/devcontainer.json"), r#"{ "image": "node:20", "features": { "ghcr.io/devcontainers/features/go:1": {} }, "initializeCommand": "cp .env.example .env" }"#).unwrap();
        let refused = shape(&env_at(&root, dev_config("direct", false, &[]))).err().unwrap();
        assert!(refused.contains("ghcr.io/devcontainers/features/go:1") && refused.contains("npm i -g @devcontainers/cli"), "{refused}");
        assert!(matches!(shape(&env_at(&root, dev_config("direct", true, &[]))), Ok(Shape::Single { .. })));
        assert!(matches!(shape(&env_at(&root, dev_config("cli", false, &[]))), Ok(Shape::Cli { compose: None, .. })));

        let changed = check_initialize(&env_at(&root, dev_config("direct", true, &[]))).err().unwrap();
        assert_eq!(changed, format!("{INIT_CHANGED_PREFIX}[\"cp .env.example .env\"]"));
        assert!(check_initialize(&env_at(&root, dev_config("direct", true, &["cp .env.example .env"]))).is_ok());
        assert!(check_initialize(&env_at(&root, dev_config("cli", false, &["something else"]))).is_err(), "the CLI path asks too: the CLI runs it");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_single_container_plan_has_its_mounts_flags_and_ports_judged() {
        let checkout = Path::new("/w/shop-main");
        let vars = devcontainer::Vars::new(checkout, "id1".into(), BTreeMap::new());
        let dev = devcontainer::parse_with(
            r#"{
              "image": "node:20",
              "workspaceMount": "source=${localWorkspaceFolder},target=/src,type=bind",
              "workspaceFolder": "/src",
              "mounts": ["type=volume,source=nm-${devcontainerId},target=/src/node_modules"],
              "runArgs": ["--init", "-p", "9229:9229", "--name", "x"],
              "capAdd": ["CHOWN"],
              "forwardPorts": [3000, 9229],
              "containerUser": "node"
            }"#,
            Some(&vars),
        )
        .unwrap();
        let plan = plan_single(&dev, checkout, 100).unwrap();
        assert_eq!(plan.folder, "/src");
        assert_eq!(plan.workspace_mount.as_deref(), Some("type=bind,source=/w/shop-main,target=/src"));
        assert_eq!(plan.mounts, vec!["type=volume,source=nm-id1,target=/src/node_modules"]);
        assert_eq!(plan.extra.join(" "), "--cap-add CHOWN --init --publish 127.0.0.1:9329:9229");
        assert_eq!(plan.config_ports, vec![(3100, 3000)], "9229 is runArgs' own");
        assert_eq!(plan.ports.iter().map(|p| (p.target, p.host)).collect::<Vec<_>>(), vec![(9229, Some(9329)), (3000, Some(3100))]);
        assert!(plan.warnings.contains(&EnvWarning::new("dropped", "--name x")));
        assert_eq!(plan.facts.user, "node");
        assert_eq!(plan.facts.mounts[0], ("bind".to_string(), "/w/shop-main".to_string(), true));
        let verdict = direct::judge(&policy::SecurityPolicy::default(), &plan.facts, &policy::Facts::default(), Some(Path::new("/Users/me")));
        assert!(!verdict.blocked(), "{verdict:?}");

        let socket = devcontainer::parse(r#"{ "image": "x", "mounts": ["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"] }"#).unwrap();
        let plan = plan_single(&socket, checkout, 100).unwrap();
        assert!(direct::judge(&policy::SecurityPolicy::default(), &plan.facts, &policy::Facts::default(), None).blocked(), "the engine's socket, as the policy refuses it everywhere");
        assert!(plan_single(&devcontainer::parse(r#"{ "image": "x", "runArgs": ["--weird"] }"#).unwrap(), checkout, 100).is_err());
    }

    #[test]
    fn single_container_ports_move_by_the_offset() {
        let dev = devcontainer::parse(r#"{ "image": "node", "forwardPorts": [3000], "appPort": "8080:80" }"#).unwrap();
        let ports = single_ports(&dev, 100).unwrap();
        assert_eq!(ports.iter().map(|p| (p.host, p.target)).collect::<Vec<_>>(), vec![(Some(3100), 3000), (Some(8180), 80)]);
        assert!(single_ports(&dev, 65000).is_err());
    }
}
