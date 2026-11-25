//! Agent sandboxes — an agent's work run in a container of its own (its own checkout, limits, a
//! network policy) **through a broker**: the agent never gets the engine's socket. With the socket
//! an agent could start a privileged container or mount the host and walk out of any restriction,
//! so it gets operations instead — run this argv in my sandbox, read its log, list its ports — and
//! this module is the only thing that ever talks to the engine about a sandbox.
//!
//! **Hardened by construction, checked anyway.** A sandbox's container is built here
//! ([`spec::run_spec`]): the task's git worktree bind-mounted at `/workspace` and nothing else of
//! the host, a non-root user, every capability dropped, no new privileges, a read-only root with a
//! `/tmp` to write in, memory/CPU/process limits, and no network unless asked. Then the workspace's
//! security policy (`containers::policy`) judges that spec before anything starts — a hard block —
//! and the started container's own inspect document is judged again, so what the engine actually
//! did is what the evidence records.
//!
//! **Evidence, not trust.** Every command run is kept (argv, exit code, duration, the end of its
//! output — longer for tests), with the policy and hardening report, the image's latest scan and,
//! when the sandbox stops or goes, the checkout's diff against where it started ([`store`],
//! exported by [`evidence::markdown`]).
//!
//! **No orphans.** Each container carries `codeflow.sandbox=<id>`; a creation that fails or is
//! cancelled removes what carries its id, and [`cleanup`] removes any container with the label whose
//! sandbox is no longer live — never one that merely looks alike.
//!
//! Agents reach a sandbox through the MCP server CodeFlow serves its CLI agents ([`tools`]): a run
//! whose working tree *is* a running sandbox's checkout is offered `sandbox_exec` and the rest,
//! scoped to that sandbox alone.

pub mod evidence;
pub mod spec;
pub mod store;
pub mod tools;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::containers::engine::{self, EngineKind, Target};
use crate::containers::{hardening, policy};
use crate::db::Db;

pub use spec::{Limits, NetworkPolicy, PublishedPort};
pub use store::{Evidence, Sandbox};

const ACTION_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_EXEC_S: f64 = 120.0;
const MAX_EXEC_S: f64 = 1800.0;
/// How much of a command's output the evidence keeps: the end, where the verdict is. A test's more.
const KEPT_OUTPUT: usize = 8 * 1024;
const KEPT_TEST_OUTPUT: usize = 32 * 1024;
/// How much of it a caller is handed back.
const RETURNED_OUTPUT: usize = 64 * 1024;
const KEPT_DIFF: usize = 200 * 1024;

/// What the "new sandbox" form (or a story's «Crear ambiente de ingeniería») asks for.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SandboxRequest {
    /// Chosen by the window, so it can cancel the creation before it answers; empty: one is made.
    pub id: String,
    pub runtime: String,
    pub context: Option<String>,
    pub workspace_id: String,
    /// The repository to make a checkout of. Taken from the task when one is named.
    pub project_id: String,
    /// An agent task whose own worktree the sandbox mounts (its runs are then bound to it).
    pub task_id: String,
    pub story_id: String,
    pub title: String,
    /// Empty: the policy's sandbox image.
    pub image: String,
    /// `none`, `internal` or `internet`.
    pub network: String,
    pub memory_mb: Option<f64>,
    pub cpus: Option<f64>,
    pub pids_limit: Option<f64>,
    /// Container ports to publish on 127.0.0.1 (internet sandboxes only).
    pub ports: Vec<String>,
    /// The branch of a new checkout; empty names it after the title.
    pub branch: String,
}

/// One command's end.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub cancelled: bool,
    pub test: bool,
}

// ------------------------------------------------------------------------------------ cancelling

/// The token every operation of a sandbox waits on; [`cancel`] fires it and leaves a fresh one.
static TOKENS: LazyLock<Mutex<HashMap<String, CancellationToken>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn token(id: &str) -> CancellationToken {
    let mut map = TOKENS.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(id.to_string()).or_default().clone()
}

/// Stops what a sandbox is doing now — its creation (which then removes what it made) or a command.
pub fn cancel(id: &str) -> bool {
    let token = TOKENS.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    token.map(|t| t.cancel()).is_some()
}

fn forget_token(id: &str) {
    TOKENS.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

// ------------------------------------------------------------------------------------ helpers

fn target_of(sandbox: &Sandbox) -> Target {
    Target { runtime: sandbox.runtime.clone(), context: (!sandbox.context.trim().is_empty()).then(|| sandbox.context.clone()) }
}

pub fn load(db: &Db, id: &str) -> Result<Sandbox, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::get(&conn, id).map_err(|e| e.to_string())?.ok_or_else(|| format!("sandbox {id} is not known"))
}

fn note(db: &Db, id: &str, kind: &str, summary: &str, data: Value) -> Option<Evidence> {
    let conn = db.0.lock().ok()?;
    match store::add_evidence(&conn, id, kind, summary, &data) {
        Ok(entry) => Some(entry),
        Err(e) => {
            crate::applog::error(&format!("sandbox {id}: could not keep its {kind} evidence: {e}"));
            None
        }
    }
}

fn set_status(db: &Db, id: &str, status: &str, error: &str) {
    if let Ok(conn) = db.0.lock() {
        let _ = store::set_status(&conn, id, status, error);
    }
}

fn redact(text: &str) -> String {
    crate::secret_scan::redact(text).0
}

fn canonical(path: &str) -> String {
    Path::new(path).canonicalize().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string())
}

/// The new container's id: the last line `run -d` printed that looks like one.
fn new_id(stdout: &str) -> Option<String> {
    let lines: Vec<&str> = stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines.iter().rev().find(|l| l.len() >= 12 && l.chars().all(|c| c.is_ascii_hexdigit())).or(lines.last()).map(|id| id.to_string())
}

fn git(path: &str, args: &[&str]) -> Option<String> {
    crate::git::cli::run_in(path, args, &[]).ok().filter(|o| o.success).map(|o| o.stdout.trim_end().to_string())
}

/// Removes every container carrying this sandbox's label — the one a creation started, whatever
/// state it was left in.
async fn remove_labelled(target: &Target, id: &str) {
    let filter = format!("label={}={id}", spec::LABEL);
    let Ok(listed) = target.run(&["ps", "-a", "-q", "--filter", &filter], Duration::from_secs(10)).await else { return };
    let ids: Vec<String> = listed.split_whitespace().map(str::to_string).collect();
    if ids.is_empty() {
        return;
    }
    let mut args = vec!["rm".to_string(), "-f".into()];
    args.extend(ids);
    let _ = target.run_owned(args, ACTION_TIMEOUT).await;
}

/// The internal network an `internal` sandbox joins: made `--internal` once, and refused when a
/// network of that name exists but reaches out.
async fn ensure_internal_network(target: &Target) -> Result<(), String> {
    let inspect: Vec<String> = vec!["network".into(), "inspect".into(), spec::INTERNAL_NETWORK.into()];
    if matches!(target.run_owned(inspect, ACTION_TIMEOUT).await, Ok(out) if out.ok()) {
        return if policy::is_internal_network(target, spec::INTERNAL_NETWORK).await {
            Ok(())
        } else {
            Err(format!("a network named {} exists and is not internal; remove it or choose another network policy", spec::INTERNAL_NETWORK))
        };
    }
    let args: Vec<String> = vec!["network".into(), "create".into(), "--internal".into(), "--label".into(), format!("{}=shared", spec::LABEL), spec::INTERNAL_NETWORK.into()];
    let out = target.run_owned(args, ACTION_TIMEOUT).await?;
    if out.ok() { Ok(()) } else { Err(out.complaint()) }
}

// ------------------------------------------------------------------------------------ sources

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProject {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTask {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub worktree_path: String,
    pub branch: String,
}

/// What a sandbox can be made from in a workspace: its repositories, and its agent tasks that have
/// a worktree of their own.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    pub projects: Vec<SourceProject>,
    pub tasks: Vec<SourceTask>,
}

pub fn sources(conn: &rusqlite::Connection, workspace_id: &str) -> rusqlite::Result<Sources> {
    let projects = crate::db::queries::list_projects(conn, workspace_id)?
        .into_iter()
        .map(|p| SourceProject { id: p.id, name: p.name, path: p.local_path })
        .collect();
    let mut statement = conn.prepare(
        "SELECT id, title, project_id, worktree_path, worktree_branch FROM agent_tasks
         WHERE workspace_id = ?1 AND worktree_path <> '' ORDER BY updated_at DESC LIMIT 50",
    )?;
    let tasks = statement
        .query_map(rusqlite::params![workspace_id], |r| Ok(SourceTask { id: r.get(0)?, title: r.get(1)?, project_id: r.get(2)?, worktree_path: r.get(3)?, branch: r.get(4)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Sources { projects, tasks })
}

/// A sandbox as the list shows it: with the names of what it hangs off.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxView {
    #[serde(flatten)]
    pub sandbox: Sandbox,
    pub project_name: String,
    pub story_title: String,
    pub story_batch_id: String,
    pub task_title: String,
}

pub fn view(conn: &rusqlite::Connection, sandbox: Sandbox) -> SandboxView {
    use rusqlite::OptionalExtension;
    let one = |sql: &str, id: &str| -> String {
        if id.is_empty() {
            return String::new();
        }
        conn.query_row(sql, rusqlite::params![id], |r| r.get::<_, String>(0)).optional().ok().flatten().unwrap_or_default()
    };
    let project_name = one("SELECT name FROM projects WHERE id = ?1", &sandbox.project_id);
    let story_title = one("SELECT title FROM story_drafts WHERE id = ?1", &sandbox.story_id);
    let story_batch_id = one("SELECT batch_id FROM story_drafts WHERE id = ?1", &sandbox.story_id);
    let task_title = one("SELECT title FROM agent_tasks WHERE id = ?1", &sandbox.task_id);
    SandboxView { sandbox, project_name, story_title, story_batch_id, task_title }
}

/// Where a request's checkout comes from.
struct Origin {
    workspace_id: String,
    project_id: String,
    repo_path: String,
    repo_name: String,
    title: String,
    /// A task's own worktree and branch, when the task has one on disk.
    task_checkout: Option<(String, String)>,
}

fn origin(conn: &rusqlite::Connection, request: &SandboxRequest) -> Result<Origin, String> {
    use rusqlite::OptionalExtension;
    let mut project_id = request.project_id.trim().to_string();
    let mut title = request.title.trim().to_string();
    let mut task_checkout = None;
    if !request.task_id.trim().is_empty() {
        let task: Option<(String, String, String, String)> = conn
            .query_row(
                "SELECT project_id, title, worktree_path, worktree_branch FROM agent_tasks WHERE id = ?1",
                rusqlite::params![request.task_id.trim()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let (task_project, task_title, path, branch) = task.ok_or_else(|| "that agent task no longer exists".to_string())?;
        project_id = task_project;
        if title.is_empty() {
            title = task_title;
        }
        if !path.is_empty() && Path::new(&path).is_dir() {
            task_checkout = Some((path, branch));
        }
    }
    if title.is_empty() && !request.story_id.trim().is_empty() {
        title = conn
            .query_row("SELECT title FROM story_drafts WHERE id = ?1", rusqlite::params![request.story_id.trim()], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
    }
    if project_id.is_empty() {
        return Err("choose the repository the sandbox works on".into());
    }
    let project = crate::db::queries::get_project(conn, &project_id).map_err(|e| e.to_string())?.ok_or_else(|| "that repository is no longer in the workspace".to_string())?;
    if title.is_empty() {
        title = project.name.clone();
    }
    let workspace_id = if request.workspace_id.trim().is_empty() { project.workspace_id.clone() } else { request.workspace_id.trim().to_string() };
    Ok(Origin { workspace_id, project_id, repo_path: project.local_path, repo_name: project.name, title, task_checkout })
}

// ------------------------------------------------------------------------------------ create

/// Creates a sandbox: checks the request against the workspace's policy (a block leaves a `blocked`
/// row saying why), makes or reuses the checkout, starts the container, and checks what started.
pub async fn create(db: &Db, request: SandboxRequest) -> Result<Sandbox, String> {
    let target = Target { runtime: request.runtime.trim().to_string(), context: request.context.clone().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) };
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return Err("ctr cannot run a sandbox; install nerdctl, Docker or Podman".into());
    }
    let network = NetworkPolicy::parse(&request.network)?;
    let limits = Limits::checked(request.memory_mb, request.cpus, request.pids_limit)?;
    let ports: Vec<String> = request.ports.iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
    for port in &ports {
        if !(port.chars().all(|c| c.is_ascii_digit()) && port.parse::<u32>().is_ok_and(|n| (1..=65_535).contains(&n))) {
            return Err(format!("{port} is not a port of the container (1 to 65535)"));
        }
    }
    let (origin, stored) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let origin = origin(&conn, &request)?;
        let stored = policy::load(&conn, &origin.workspace_id).map_err(|e| e.to_string())?;
        (origin, stored)
    };
    let image = if request.image.trim().is_empty() { stored.policy.sandbox_image() } else { request.image.trim().to_string() };
    engine::check_ref(&image)?;
    let scan = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        policy::latest_scan(&conn, &image)
    };

    let asked = request.id.trim();
    let id = if (8..=64).contains(&asked.len()) && asked.chars().all(|c| c.is_ascii_alphanumeric()) { asked.to_ascii_lowercase() } else { uuid::Uuid::new_v4().simple().to_string() };
    // From here on a cancel from the window reaches this creation, the policy check included.
    let cancel = token(&id);
    let story = !request.story_id.trim().is_empty();
    let (worktree, branch, owned) = match &origin.task_checkout {
        Some((path, branch)) => (canonical(path), branch.clone(), false),
        None => {
            let (folder, named) = spec::checkout_names(&origin.title, &id, story);
            let branch = if request.branch.trim().is_empty() { named } else { request.branch.trim().to_string() };
            (crate::paths::agent_worktree_dir(&origin.repo_name, &folder).to_string_lossy().into_owned(), branch, true)
        }
    };
    let repo = origin.repo_path.clone();
    let git_dir = tokio::task::spawn_blocking(move || git(&repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])).await.ok().flatten();
    let run_spec = spec::run_spec(&id, &image, &worktree, git_dir.as_deref(), network, limits, &ports, &spec::sandbox_user());

    let mut facts = policy::facts_for(&target, &image, std::slice::from_ref(&run_spec.network), &stored.policy, scan.clone()).await;
    if network == NetworkPolicy::Internal {
        // Made `--internal` below if it is not there yet, and refused if it exists and is not.
        facts.internal_networks.push(spec::INTERNAL_NETWORK.into());
    }
    let violations = policy::check_spec(&stored.policy, &run_spec, &facts);
    let blocked = policy::blocks(&violations);
    let now = store::now();
    let mut sandbox = Sandbox {
        id: id.clone(),
        workspace_id: origin.workspace_id.clone(),
        project_id: origin.project_id.clone(),
        task_id: request.task_id.trim().into(),
        story_id: request.story_id.trim().into(),
        title: origin.title.clone(),
        runtime: target.runtime.clone(),
        context: target.context.clone().unwrap_or_default(),
        image: image.clone(),
        container_name: spec::container_name(&id),
        repo_path: origin.repo_path.clone(),
        worktree_path: worktree.clone(),
        branch: branch.clone(),
        worktree_owned: owned,
        network: network.id().into(),
        memory_mb: limits.memory_mb,
        cpus: limits.cpus,
        pids_limit: limits.pids,
        ports: ports.clone(),
        status: if blocked { "blocked".into() } else { "creating".into() },
        policy_status: if blocked { "blocked".into() } else if violations.is_empty() { "ok".into() } else { "warnings".into() },
        error: if blocked { policy::refusal(&violations) } else { String::new() },
        created_at: now.clone(),
        updated_at: now,
        ..Default::default()
    };
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::insert(&conn, &sandbox).map_err(|e| e.to_string())?;
        let summary = if blocked { "Refused by the workspace's security policy" } else { "Checked against the workspace's security policy" };
        let _ = store::add_evidence(&conn, &id, "policy", summary, &json!({"policy": stored, "violations": violations, "signature": facts.signature}));
        let _ = store::add_evidence(&conn, &id, "scan", "", &json!({"scan": scan}));
    }
    if blocked {
        forget_token(&id);
        return Err(sandbox.error.clone());
    }

    let built = tokio::select! {
        result = build(db, &target, engine, &mut sandbox, &run_spec, &stored.policy, &facts) => result,
        _ = cancel.cancelled() => Err("cancelled".to_string()),
    };
    forget_token(&id);
    match built {
        Ok(()) => load(db, &id),
        Err(error) => {
            let cancelled = error == "cancelled";
            remove_labelled(&target, &id).await;
            if owned && Path::new(&worktree).exists() {
                let (repo, path, branch, base) = (origin.repo_path.clone(), worktree.clone(), branch.clone(), sandbox.base_commit.clone());
                let _ = tokio::task::spawn_blocking(move || {
                    // Brand new and never handed to anyone: nothing in it is anybody's work yet.
                    let _ = crate::git::worktree::remove(&repo, &path, true);
                    if !base.is_empty() {
                        crate::team::gitops::delete_branch_if_contained(&repo, &branch, &base);
                    }
                })
                .await;
            }
            set_status(db, &id, if cancelled { "destroyed" } else { "failed" }, if cancelled { "" } else { &error });
            note(db, &id, if cancelled { "cancelled" } else { "error" }, if cancelled { "Creation cancelled" } else { "Creation failed" }, json!({"detail": error}));
            Err(if cancelled { "the sandbox's creation was cancelled".into() } else { error })
        }
    }
}

async fn build(db: &Db, target: &Target, engine: EngineKind, sandbox: &mut Sandbox, run_spec: &crate::containers::run::RunSpec, rules: &policy::SecurityPolicy, facts: &policy::Facts) -> Result<(), String> {
    // The checkout.
    if sandbox.worktree_owned {
        let (repo, path, branch) = (sandbox.repo_path.clone(), sandbox.worktree_path.clone(), sandbox.branch.clone());
        tokio::task::spawn_blocking(move || {
            if let Some(parent) = Path::new(&path).parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            crate::git::worktree::add(&repo, &path, &branch, true, None)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    let path = sandbox.worktree_path.clone();
    let base = tokio::task::spawn_blocking(move || git(&path, &["rev-parse", "HEAD"])).await.ok().flatten().unwrap_or_default();
    sandbox.base_commit = base;
    sandbox.worktree_path = canonical(&sandbox.worktree_path);
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::set_checkout(&conn, &sandbox.id, &sandbox.worktree_path, &sandbox.branch, &sandbox.base_commit, sandbox.worktree_owned).map_err(|e| e.to_string())?;
    }
    if sandbox.network == NetworkPolicy::Internal.id() {
        ensure_internal_network(target).await?;
    }

    // The container. The spec named the checkout by the path it had before it existed; the same
    // folder, canonical, is what is mounted.
    let mut run_spec = run_spec.clone();
    if let Some(first) = run_spec.volumes.first_mut() {
        first.source = sandbox.worktree_path.clone();
    }
    let args = spec::create_args(engine, &run_spec, &sandbox.id)?;
    let output = target.run_owned(args.clone(), engine::PULL_TIMEOUT).await?;
    if !output.ok() {
        return Err(output.complaint());
    }
    let container = new_id(&output.stdout).ok_or_else(|| "the engine started the container without printing its id".to_string())?;
    sandbox.container_id = container.clone();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::set_container(&conn, &sandbox.id, &container).map_err(|e| e.to_string())?;
    }

    // What the engine actually made.
    let doc_text = engine::inspect(target, "container", &container).await?;
    let doc: Value = serde_json::from_str(&doc_text).unwrap_or(Value::Null);
    let findings = hardening::audit(&doc);
    let after = policy::check_container(rules, &doc, facts);
    note(db, &sandbox.id, "hardening", "The started container, as the engine reports it", json!({"findings": findings, "violations": after}));
    if policy::blocks(&after) {
        return Err(format!("the engine started the container differently than asked: {}", policy::refusal(&after)));
    }
    note(db, &sandbox.id, "created", &format!("Started {} from {}", sandbox.container_name, sandbox.image), json!({"argv": args, "detail": format!("checkout {} on {}", sandbox.worktree_path, sandbox.branch)}));
    set_status(db, &sandbox.id, "running", "");
    sandbox.status = "running".into();
    Ok(())
}

// ------------------------------------------------------------------------------------ operations

/// Runs `argv` in the sandbox's checkout, keeps it as evidence, and hands back how it ended. A
/// command past `timeout_s` (or cancelled) is ended inside the container with everything it started.
pub async fn exec(db: &Db, id: &str, argv: Vec<String>, timeout_s: Option<f64>) -> Result<ExecResult, String> {
    let sandbox = load(db, id)?;
    if sandbox.status != "running" || sandbox.container_id.is_empty() {
        return Err(format!("the sandbox is {}, not running", sandbox.status));
    }
    let target = target_of(&sandbox);
    let mark = format!("{}={}", spec::EXEC_MARK, uuid::Uuid::new_v4().simple());
    let args = spec::exec_args(&sandbox.container_id, &argv, &mark)?;
    let seconds = timeout_s.unwrap_or(DEFAULT_EXEC_S);
    let seconds = if seconds.is_finite() { seconds.clamp(1.0, MAX_EXEC_S) } else { DEFAULT_EXEC_S };
    let test = spec::is_test_command(&argv);
    let cancel = token(id);
    let started = Instant::now();
    let outcome = tokio::select! {
        result = target.run_owned(args, Duration::from_secs_f64(seconds)) => Some(result),
        _ = cancel.cancelled() => None,
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    let (exit_code, stdout, stderr, timed_out, cancelled) = match outcome {
        Some(Ok(out)) => (out.code, out.stdout, out.stderr, false, false),
        Some(Err(e)) if e.contains("did not answer within") => (None, String::new(), format!("timed out after {seconds} s"), true, false),
        Some(Err(e)) => return Err(e),
        None => (None, String::new(), "cancelled".to_string(), false, true),
    };
    if timed_out || cancelled {
        let reap = vec!["exec".to_string(), sandbox.container_id.clone(), "sh".into(), "-c".into(), spec::reap_script(&mark)];
        let _ = target.run_owned(reap, Duration::from_secs(5)).await;
    }
    let (stdout, stderr) = (redact(&stdout), redact(&stderr));
    let keep = if test { KEPT_TEST_OUTPUT } else { KEPT_OUTPUT };
    let (kept_out, out_cut) = spec::tail(&stdout, keep);
    let (kept_err, err_cut) = spec::tail(&stderr, keep);
    let line = argv.join(" ");
    let summary = match exit_code {
        Some(code) => format!("{} exited {code}", line.chars().take(120).collect::<String>()),
        None if timed_out => format!("{} timed out", line.chars().take(120).collect::<String>()),
        None => format!("{} was cancelled", line.chars().take(120).collect::<String>()),
    };
    note(
        db,
        id,
        if test { "test" } else { "exec" },
        &summary,
        json!({"argv": argv, "exitCode": exit_code, "durationMs": duration_ms, "stdout": kept_out, "stderr": kept_err,
               "stdoutTruncated": out_cut, "stderrTruncated": err_cut, "timedOut": timed_out, "cancelled": cancelled}),
    );
    Ok(ExecResult { exit_code, duration_ms, stdout: spec::tail(&stdout, RETURNED_OUTPUT).0, stderr: spec::tail(&stderr, RETURNED_OUTPUT).0, timed_out, cancelled, test })
}

/// The container's log, its last `lines`.
pub async fn logs(db: &Db, id: &str, lines: Option<u32>) -> Result<String, String> {
    let sandbox = load(db, id)?;
    if sandbox.container_id.is_empty() || sandbox.status == "destroyed" {
        return Err("the sandbox has no container".into());
    }
    let lines = lines.unwrap_or(200).clamp(1, 10_000);
    let args: Vec<String> = vec!["logs".into(), "--tail".into(), lines.to_string(), sandbox.container_id.clone()];
    let out = target_of(&sandbox).run_owned(args, ACTION_TIMEOUT).await?;
    if !out.ok() {
        return Err(out.complaint());
    }
    Ok(redact(&format!("{}{}", out.stdout, out.stderr)))
}

/// The ports the sandbox publishes on this computer.
pub async fn ports(db: &Db, id: &str) -> Result<Vec<PublishedPort>, String> {
    let sandbox = load(db, id)?;
    if sandbox.status != "running" {
        return Ok(vec![]);
    }
    let args: Vec<String> = vec!["port".into(), sandbox.container_id.clone()];
    let out = target_of(&sandbox).run_owned(args, ACTION_TIMEOUT).await?;
    Ok(if out.ok() { spec::parse_ports(&out.stdout) } else { vec![] })
}

/// The checkout's changes since the sandbox started, kept as evidence.
pub async fn capture_diff(db: &Db, id: &str, summary: &str) -> Result<Option<Evidence>, String> {
    let sandbox = load(db, id)?;
    if sandbox.worktree_path.is_empty() || !Path::new(&sandbox.worktree_path).is_dir() {
        return Ok(None);
    }
    let (path, base) = (sandbox.worktree_path.clone(), if sandbox.base_commit.is_empty() { "HEAD".to_string() } else { sandbox.base_commit.clone() });
    let (stat, diff, untracked) = tokio::task::spawn_blocking(move || {
        let stat = git(&path, &["diff", "--no-ext-diff", "--stat", &base, "--"]).unwrap_or_default();
        let diff = git(&path, &["diff", "--no-ext-diff", &base, "--"]).unwrap_or_default();
        let untracked: Vec<String> = git(&path, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default().lines().map(str::to_string).take(500).collect();
        (stat, diff, untracked)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (diff, cut) = spec::head(&redact(&diff), KEPT_DIFF);
    let files = stat.lines().filter(|l| l.contains('|')).count();
    let summary = format!("{summary}: {files} files changed, {} new", untracked.len());
    Ok(note(db, id, "diff", &summary, json!({"stat": stat, "diff": diff, "diffTruncated": cut, "untracked": untracked, "base": sandbox.base_commit})))
}

pub async fn stop(db: &Db, id: &str) -> Result<Sandbox, String> {
    let sandbox = load(db, id)?;
    if sandbox.status != "running" {
        return Err(format!("the sandbox is {}, not running", sandbox.status));
    }
    cancel(id);
    let args: Vec<String> = vec!["stop".into(), "-t".into(), "5".into(), sandbox.container_id.clone()];
    let out = target_of(&sandbox).run_owned(args, ACTION_TIMEOUT).await?;
    if !out.ok() {
        return Err(out.complaint());
    }
    set_status(db, id, "stopped", "");
    let _ = capture_diff(db, id, "Diff when stopped").await;
    note(db, id, "stopped", "Stopped", json!({}));
    load(db, id)
}

pub async fn start(db: &Db, id: &str) -> Result<Sandbox, String> {
    let sandbox = load(db, id)?;
    if sandbox.status != "stopped" {
        return Err(format!("the sandbox is {}, not stopped", sandbox.status));
    }
    let args: Vec<String> = vec!["start".into(), sandbox.container_id.clone()];
    let out = target_of(&sandbox).run_owned(args, ACTION_TIMEOUT).await?;
    if !out.ok() {
        return Err(out.complaint());
    }
    set_status(db, id, "running", "");
    note(db, id, "started", "Started again", json!({}));
    load(db, id)
}

/// Removes the container — whatever it is doing — after keeping the final diff. The checkout goes too
/// when `remove_worktree` and the broker made it and nothing in it is uncommitted; its branch stays
/// unless it holds no commit of its own.
pub async fn destroy(db: &Db, id: &str, remove_worktree: bool) -> Result<Sandbox, String> {
    let sandbox = load(db, id)?;
    cancel(id);
    if sandbox.status == "destroyed" {
        return Ok(sandbox);
    }
    let _ = capture_diff(db, id, "Final diff").await;
    let target = target_of(&sandbox);
    if !sandbox.container_id.is_empty() {
        let args: Vec<String> = vec!["rm".into(), "-f".into(), sandbox.container_id.clone()];
        let out = target.run_owned(args, ACTION_TIMEOUT).await?;
        let gone = out.ok() || out.complaint().to_lowercase().contains("no such container") || out.complaint().to_lowercase().contains("no container with");
        if !gone {
            return Err(out.complaint());
        }
    }
    remove_labelled(&target, id).await;
    let mut detail = String::from("container removed");
    if remove_worktree && sandbox.worktree_owned && Path::new(&sandbox.worktree_path).exists() {
        let (repo, path, branch, base) = (sandbox.repo_path.clone(), sandbox.worktree_path.clone(), sandbox.branch.clone(), sandbox.base_commit.clone());
        let removed = tokio::task::spawn_blocking(move || {
            let result = crate::git::worktree::remove(&repo, &path, false);
            if result.is_ok() && !base.is_empty() {
                crate::team::gitops::delete_branch_if_contained(&repo, &branch, &base);
            }
            result
        })
        .await
        .map_err(|e| e.to_string())?;
        detail = match removed {
            Ok(()) => "container and checkout removed".into(),
            Err(e) => format!("container removed; the checkout was kept: {}", e.trim_start_matches(crate::git::worktree::WORKTREE_DIRTY_PREFIX)),
        };
    }
    set_status(db, id, "destroyed", "");
    note(db, id, "destroyed", "Destroyed", json!({"detail": detail}));
    load(db, id)
}

/// Forgets a sandbox that is gone (or never started), and its evidence.
pub fn forget(db: &Db, id: &str) -> Result<(), String> {
    let sandbox = load(db, id)?;
    if sandbox.live() {
        return Err("destroy the sandbox before forgetting it".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    store::delete(&conn, id).map_err(|e| e.to_string())
}

/// Removes every container of `target` carrying the sandbox label whose sandbox is no longer live —
/// a creation killed with the app, a row forgotten. The names of what was removed.
pub async fn cleanup(db: &Db, target: &Target) -> Result<Vec<String>, String> {
    if target.engine()? == EngineKind::Ctr {
        return Ok(vec![]);
    }
    let rows = engine::list_containers(target).await?;
    let live = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        store::live_ids(&conn).map_err(|e| e.to_string())?
    };
    let orphans: Vec<(String, String)> = rows
        .iter()
        .filter_map(|row| row.labels.get(spec::LABEL).map(|owner| (row, owner)))
        .filter(|(_, owner)| !live.iter().any(|id| id == *owner))
        .map(|(row, _)| (row.id.clone(), row.name.clone()))
        .collect();
    if orphans.is_empty() {
        return Ok(vec![]);
    }
    let mut args = vec!["rm".to_string(), "-f".into()];
    args.extend(orphans.iter().map(|(id, _)| id.clone()));
    let out = target.run_owned(args, ACTION_TIMEOUT).await?;
    if !out.ok() {
        return Err(out.complaint());
    }
    Ok(orphans.into_iter().map(|(id, name)| if name.is_empty() { id } else { name }).collect())
}

/// The whole evidence of a sandbox as Markdown.
pub fn export(db: &Db, id: &str) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sandbox = store::get(&conn, id).map_err(|e| e.to_string())?.ok_or_else(|| format!("sandbox {id} is not known"))?;
    let timeline = store::evidence(&conn, id).map_err(|e| e.to_string())?;
    Ok(evidence::markdown(&sandbox, &timeline))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancel_fires_once_and_leaves_a_fresh_token() {
        let first = token("t1");
        assert!(cancel("t1"));
        assert!(first.is_cancelled());
        assert!(!cancel("t1"), "nothing left to cancel");
        assert!(!token("t1").is_cancelled(), "the next operation starts uncancelled");
        forget_token("t1");
    }

    #[test]
    fn the_new_containers_id_is_the_last_hex_line() {
        assert_eq!(new_id("Unable to find image\n3f2a9c1d77aa\n").as_deref(), Some("3f2a9c1d77aa"));
        assert_eq!(new_id("").as_deref(), None);
    }

    #[test]
    fn sources_and_views_read_the_workspace() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, local_path TEXT);
             CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT, title TEXT, worktree_path TEXT, worktree_branch TEXT, updated_at TEXT);
             CREATE TABLE story_drafts (id TEXT PRIMARY KEY, batch_id TEXT, title TEXT);
             INSERT INTO agent_tasks VALUES ('t1', 'w', 'p1', 'Fix login', '/wt/t1', 'codeflow/fix', '2'), ('t2', 'w', 'p1', 'No tree', '', '', '1');
             INSERT INTO story_drafts VALUES ('s1', 'b1', 'Login con SSO');",
        )
        .unwrap();
        store::migrate(&conn).unwrap();
        let mut statement = conn.prepare("SELECT id, title, project_id, worktree_path, worktree_branch FROM agent_tasks WHERE workspace_id = ?1 AND worktree_path <> '' ORDER BY updated_at DESC LIMIT 50").unwrap();
        let tasks: Vec<String> = statement.query_map(["w"], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(tasks, vec!["t1"], "only a task with a worktree of its own");
        let shown = view(&conn, Sandbox { id: "x".into(), story_id: "s1".into(), task_id: "t1".into(), ..Default::default() });
        assert_eq!((shown.story_title.as_str(), shown.story_batch_id.as_str(), shown.task_title.as_str()), ("Login con SSO", "b1", "Fix login"));
        let bare = view(&conn, Sandbox::default());
        assert!(bare.story_title.is_empty() && bare.project_name.is_empty());
    }
}
