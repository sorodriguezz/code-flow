//! A team's checks, in a container of their own.
//!
//! A check is code the member just wrote, or a script it just edited, run by the app: on the host
//! it runs with the user's own account, files and network. With `Policy::sandbox = "checks"` it
//! runs here instead — and so does the install that comes before it:
//!
//! - **Nothing of the host is writable.** The worktree is mounted read-only at `/src` and copied
//!   into a volume (`/work`); the check runs on the copy. What a test writes, a build leaves or a
//!   rogue script deletes stays in the volume. The copy is what git would commit — tracked and
//!   untracked files, nothing `.gitignore` keeps out — so the host's `node_modules`, built for
//!   another system, never crosses over, and the container's never comes back.
//! - **No network while it checks.** Dependencies install in a step of their own, with network,
//!   only when the manifests changed since the last install of that copy; the check itself runs
//!   with `--network none`.
//! - **Hardened like any sandbox:** the user's own uid, every capability dropped, no new
//!   privileges, a read-only root, memory, CPU and process limits — and the workspace's container
//!   policy judges the container before it starts ([`crate::containers::policy`]).
//!
//! There is no quiet way down: an engine that is not running, an image that will not pull or a
//! policy that refuses is [`Unavailable`], and the run stops for the user (`sandbox:` gate) rather
//! than checking on the host as if nothing had been asked.
//!
//! The volumes: one per tree checked (`codeflow-check-<run>-…`, removed with the run) and one cache
//! per repository for what the package managers download (`codeflow-check-home-…`, kept).

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::containers::agent_sandbox::spec::sandbox_user;
use crate::containers::engine::{self, EngineKind, Target};
use crate::containers::run::{self, RunEnv, RunSpec, RunVolume};
use crate::containers::policy;
use crate::db::Db;

pub const LABEL_RUN: &str = "codeflow.team-run";
pub const LABEL_CACHE: &str = "codeflow.team-cache";
const SRC: &str = "/src";
const WORK: &str = "/work";
const HOME: &str = "/home/check";
/// How the copy tells that its dependencies are not the ones its manifests ask for.
const NEEDS_PREPARE: &str = "CODEFLOW_NEEDS_PREPARE";
const NEEDS_PREPARE_CODE: i32 = 97;
const MEMORY_MB: f64 = 4096.0;
const CPUS: f64 = 4.0;
const PIDS: f64 = 2048.0;
/// How long the engine may take to say it is there.
const PROBE_FOR: Duration = Duration::from_secs(20);

/// Why a check could not run isolated, in words for the user.
#[derive(Debug, Clone, PartialEq)]
pub struct Unavailable(pub String);

/// One command to run on a copy of `tree`.
#[derive(Debug, Clone)]
pub struct Job {
    pub workspace_id: String,
    pub run_id: String,
    pub project_id: String,
    pub tree: String,
    /// Which copy of the run this is — the item's, the integration tree's, the base's. The same
    /// slot reuses the same volume, and with it what is already installed there.
    pub slot: String,
    pub command: String,
    /// The team's own image; empty picks one from what the tree is.
    pub image: String,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct Ran {
    pub passed: bool,
    pub output: String,
    pub image: String,
}

// ------------------------------------------------------------------------------------ the engine

#[derive(Clone)]
struct Probe {
    at: Instant,
    target: Option<Target>,
    name: String,
    problem: String,
}

static PROBE: Mutex<Option<Probe>> = Mutex::new(None);

/// A test's own answer to «is there an engine», so it never depends on the machine it runs on.
#[cfg(test)]
pub static FORCED: Mutex<Option<bool>> = Mutex::new(None);

/// What the settings show about isolation on this computer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    /// `OrbStack`, `Docker Desktop`, `podman`…
    pub engine: String,
    /// Why not, when not: nothing installed, or installed and not running.
    pub problem: String,
}

async fn probe(fresh: bool) -> Probe {
    #[cfg(test)]
    if let Some(forced) = *FORCED.lock().unwrap_or_else(|e| e.into_inner()) {
        return Probe { at: Instant::now(), target: forced.then(|| Target { runtime: "docker".into(), context: None }), name: "docker".into(), problem: if forced { String::new() } else { "not running".into() } };
    }
    if !fresh {
        if let Some(known) = PROBE.lock().unwrap_or_else(|e| e.into_inner()).clone().filter(|p| p.at.elapsed() < PROBE_FOR) {
            return known;
        }
    }
    let runtimes = crate::containers::detect().await;
    let engines: Vec<_> = runtimes.iter().filter(|r| EngineKind::from_id(&r.id).is_some_and(|kind| kind != EngineKind::Ctr)).collect();
    let found = match engines.iter().find(|r| r.running) {
        Some(runtime) => Probe {
            at: Instant::now(),
            target: Some(Target { runtime: runtime.id.clone(), context: None }),
            name: runtime.provider.clone().unwrap_or_else(|| runtime.id.clone()),
            problem: String::new(),
        },
        None => Probe {
            at: Instant::now(),
            target: None,
            name: engines.first().map(|r| r.provider.clone().unwrap_or_else(|| r.id.clone())).unwrap_or_default(),
            problem: if engines.is_empty() { "none".into() } else { "stopped".into() },
        },
    };
    *PROBE.lock().unwrap_or_else(|e| e.into_inner()) = Some(found.clone());
    found
}

pub async fn status(fresh: bool) -> Status {
    let probe = probe(fresh).await;
    Status { available: probe.target.is_some(), engine: probe.name, problem: probe.problem }
}

fn no_engine(probe: &Probe) -> Unavailable {
    Unavailable(if probe.problem == "none" {
        "No hay un motor de contenedores instalado (Docker, OrbStack, Podman…).".into()
    } else {
        format!("{} está instalado pero no responde: ábrelo e inténtalo de nuevo.", if probe.name.is_empty() { "El motor de contenedores" } else { &probe.name })
    })
}

// ------------------------------------------------------------------------------------ what to run

/// The image a check of `tree` runs in when the team named none: by the command's own tool, then
/// by what the tree is, then `fallback` (the workspace's sandbox image).
pub fn image_for(tree: &Path, command: &str, fallback: &str) -> String {
    let has = |name: &str| tree.join(name).exists();
    let bun = has("bun.lock") || has("bun.lockb");
    // The first word of the command that names a tool: `cd api && go test` is Go's, whatever
    // `api` is.
    let by_tool = command.split_whitespace().map(|word| word.rsplit('/').next().unwrap_or(word)).find_map(|tool| match tool {
        "bun" | "bunx" => Some("oven/bun:1"),
        "npm" | "npx" | "pnpm" | "yarn" | "node" | "vitest" | "jest" | "tsc" | "eslint" | "biome" | "prettier" if bun => Some("oven/bun:1"),
        "npm" | "npx" | "pnpm" | "yarn" | "node" | "vitest" | "jest" | "tsc" | "eslint" | "biome" | "prettier" => Some("node:22-bookworm-slim"),
        "cargo" | "rustc" => Some("rust:1-bookworm"),
        "go" | "gofmt" => Some("golang:1-bookworm"),
        "python" | "python3" | "pytest" | "pip" | "uv" | "ruff" | "poetry" | "tox" | "mypy" => Some("python:3.12-bookworm"),
        _ => None,
    });
    let by_tree = || {
        if has("package.json") {
            Some(if bun { "oven/bun:1" } else { "node:22-bookworm-slim" })
        } else if has("Cargo.toml") {
            Some("rust:1-bookworm")
        } else if has("go.mod") {
            Some("golang:1-bookworm")
        } else if has("pyproject.toml") || has("requirements.txt") {
            Some("python:3.12-bookworm")
        } else {
            None
        }
    };
    by_tool.or_else(by_tree).unwrap_or(fallback).to_string()
}

/// The manifests one level down, for the trees that keep a second stack in a folder of its own.
fn nested(tree: &Path, manifest: &str) -> Vec<String> {
    let mut found: Vec<String> = std::fs::read_dir(tree)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().join(manifest).is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.') && !matches!(name.as_str(), "node_modules" | "target") && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .collect();
    found.sort();
    found
}

/// What installs the copy's dependencies — the only step that runs with network.
pub fn prepare_commands(tree: &Path) -> Vec<String> {
    let has = |name: &str| tree.join(name).is_file();
    let mut commands = Vec::new();
    if let Some(install) = super::deps::install_line(tree) {
        commands.push(install);
    }
    let cargo = |dir: &Path, prefix: &str| format!("{prefix}cargo fetch{}", if dir.join("Cargo.lock").is_file() { " --locked" } else { "" });
    if has("Cargo.toml") {
        commands.push(cargo(tree, ""));
    }
    for dir in nested(tree, "Cargo.toml") {
        commands.push(format!("({})", cargo(&tree.join(&dir), &format!("cd {dir} && "))));
    }
    if has("go.mod") {
        commands.push("go mod download".into());
    }
    for dir in nested(tree, "go.mod") {
        commands.push(format!("(cd {dir} && go mod download)"));
    }
    if has("requirements.txt") {
        commands.push("python -m venv .venv && .venv/bin/pip install --disable-pip-version-check -r requirements.txt".into());
    } else if has("pyproject.toml") {
        commands.push("python -m venv .venv && .venv/bin/pip install --disable-pip-version-check -e .".into());
    }
    commands
}

/// What the copy's dependencies are installed from, and in which image: the same fingerprint is the
/// same install.
pub fn fingerprint(tree: &Path, image: &str) -> String {
    let mut names: Vec<String> = ["package.json", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "requirements.txt", "pyproject.toml"].iter().map(|n| n.to_string()).collect();
    names.extend(super::deps::LOCKFILES.iter().map(|n| n.to_string()));
    for manifest in ["Cargo.toml", "go.mod"] {
        for dir in nested(tree, manifest) {
            let lock = if manifest == "Cargo.toml" { "Cargo.lock" } else { "go.sum" };
            names.push(format!("{dir}/{manifest}"));
            names.push(format!("{dir}/{lock}"));
        }
    }
    let mut parts = vec![image.to_string()];
    for name in names {
        if let Ok(bytes) = std::fs::read(tree.join(&name)) {
            parts.push(name);
            parts.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    super::coordination::fingerprint(&parts)
}

/// The files of `tree` git would commit — tracked, and untracked but not ignored — that are there,
/// one per line. `None` when the tree is not a repository: the copy then takes everything but the
/// folders an install or a build leaves.
pub fn listing(tree: &str) -> Option<String> {
    let out = crate::git::cli::run_in(tree, &["ls-files", "-z", "-co", "--exclude-standard"], &[]).ok().filter(|out| out.success)?;
    let files: Vec<&str> = out
        .stdout
        .split('\0')
        .filter(|name| !name.is_empty() && !name.contains('\n'))
        .filter(|name| Path::new(tree).join(name).symlink_metadata().is_ok_and(|meta| !meta.is_dir()))
        .collect();
    Some(files.join("\n"))
}

fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The script one step runs. It refreshes the copy from `/src`, then either installs (`prepare`)
/// or runs the check — which first says so and leaves when what is installed is not what the
/// manifests ask for.
pub fn script(command: &str, prepare: &[String], fingerprint: &str, listed: bool, preparing: bool) -> String {
    let copy = if listed {
        "tar -C /src -cf - -T - | tar -C /work -xf -".to_string()
    } else {
        "tar -C /src --exclude=node_modules --exclude=target --exclude=.git --exclude=.venv -cf - . | tar -C /work -xf -".to_string()
    };
    let head = format!(
        r#"set -e
mkdir -p "$HOME/bin" {WORK}/.codeflow-sandbox
for m in pnpm yarn; do
  if ! command -v "$m" >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
    printf '#!/bin/sh\nexec corepack %s "$@"\n' "$m" > "$HOME/bin/$m"
    chmod +x "$HOME/bin/$m"
  fi
done
export PATH="$HOME/bin:{WORK}/.venv/bin:{WORK}/node_modules/.bin:$PATH"
cd {WORK}
find . -mindepth 1 \( -name node_modules -o -name target -o -name .venv -o -name .codeflow-sandbox \) -prune -o ! -type d -exec rm -f {{}} +
{copy}
"#
    );
    let run = |line: &str| format!("if command -v bash >/dev/null 2>&1; then bash -c {q} </dev/null; else sh -c {q} </dev/null; fi", q = quoted(line));
    if preparing {
        return format!("{head}{}\nprintf %s {} > .codeflow-sandbox/prepared\n", run(&prepare.join(" && ")), quoted(fingerprint));
    }
    let guard = if prepare.is_empty() {
        String::new()
    } else {
        format!("if [ \"$(cat .codeflow-sandbox/prepared 2>/dev/null)\" != {} ]; then echo {NEEDS_PREPARE}; exit {NEEDS_PREPARE_CODE}; fi\n", quoted(fingerprint))
    };
    format!("{head}{guard}set +e\n{}\n", run(command))
}

fn hashed(text: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(&Sha256::digest(text.as_bytes())[..6])
}

fn short_run(run_id: &str) -> String {
    run_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect::<String>().to_ascii_lowercase()
}

/// The volume a slot's copy lives in.
pub fn work_volume(run_id: &str, project_id: &str, slot: &str) -> String {
    format!("codeflow-check-{}-{}", short_run(run_id), hashed(&format!("{project_id}\n{slot}")))
}

/// The volume a repository's downloads are kept in, across runs.
pub fn home_volume(project_id: &str) -> String {
    format!("codeflow-check-home-{}", hashed(project_id))
}

/// One step's container, as the policy judges it and the engine starts it.
fn spec(job: &Job, image: &str, name: &str, network: bool) -> RunSpec {
    let env = |key: &str, value: &str| RunEnv { key: key.into(), value: value.into() };
    let mut vars = vec![
        env("HOME", HOME),
        env("CI", "1"),
        env("CODEFLOW_SANDBOX", "team"),
        env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0"),
        env("CARGO_HOME", &format!("{HOME}/.cargo")),
        env("GOPATH", &format!("{HOME}/go")),
        env("GOCACHE", &format!("{HOME}/.cache/go-build")),
        env("GOFLAGS", "-buildvcs=false"),
        env("PIP_CACHE_DIR", &format!("{HOME}/.cache/pip")),
    ];
    if !network {
        vars.extend([env("CARGO_NET_OFFLINE", "true"), env("GOPROXY", "off"), env("COREPACK_ENABLE_NETWORK", "0")]);
    }
    RunSpec {
        image: image.into(),
        name: name.into(),
        env: vars,
        volumes: vec![
            RunVolume { kind: "bind".into(), source: job.tree.clone(), target: SRC.into(), read_only: true },
            RunVolume { kind: "volume".into(), source: work_volume(&job.run_id, &job.project_id, &job.slot), target: WORK.into(), read_only: false },
            RunVolume { kind: "volume".into(), source: home_volume(&job.project_id), target: HOME.into(), read_only: false },
        ],
        auto_remove: true,
        pull: "missing".into(),
        // No working directory: the engine would make `/work` in the container as root, and an
        // empty volume mounted over a folder takes that folder's owner. The script moves there.
        network: if network { "bridge".into() } else { "none".into() },
        memory_mb: Some(MEMORY_MB),
        cpus: Some(CPUS),
        read_only: true,
        user: sandbox_user(),
        cap_drop: vec!["ALL".into()],
        no_new_privileges: true,
        tmpfs: vec!["/tmp:rw,exec,nosuid,size=2g,mode=1777".into()],
        pids_limit: Some(PIDS),
        ..Default::default()
    }
}

/// The engine's arguments for a step: the spec's own, attached instead of detached, labelled with
/// the run, and the script as the command.
fn step_args(engine: EngineKind, spec: &RunSpec, run_id: &str, script: &str) -> Result<Vec<String>, String> {
    let mut args = run::run_args(engine, spec)?;
    if args.len() < 2 || args[0] != "run" || args[1] != "-d" {
        return Err("the run's arguments did not start as expected".into());
    }
    args[1] = "-i".into();
    args.splice(2..2, ["--label".to_string(), format!("{LABEL_RUN}={run_id}")]);
    args.extend(["sh".to_string(), "-c".to_string(), script.to_string()]);
    Ok(args)
}

// ------------------------------------------------------------------------------------ running it

async fn volume_exists(target: &Target, name: &str) -> bool {
    target.run_owned(vec!["volume".into(), "inspect".into(), name.into()], Duration::from_secs(20)).await.is_ok_and(|out| out.ok())
}

/// Makes the job's volumes when they are not there, and hands them to the user the steps run as: a
/// fresh volume is root's. The one container here that runs as root does nothing but that — no
/// network, one capability, nothing of the repository mounted.
async fn ensure_volumes(target: &Target, job: &Job, image: &str) -> Result<(), String> {
    let work = work_volume(&job.run_id, &job.project_id, &job.slot);
    let home = home_volume(&job.project_id);
    let mut fresh = Vec::new();
    for (name, label) in [(&work, format!("{LABEL_RUN}={}", job.run_id)), (&home, format!("{LABEL_CACHE}=1"))] {
        if !volume_exists(target, name).await {
            let made = target.run_owned(vec!["volume".into(), "create".into(), "--label".into(), label, name.clone()], Duration::from_secs(30)).await?;
            if !made.ok() {
                return Err(made.complaint());
            }
            fresh.push(name.clone());
        }
    }
    if fresh.is_empty() {
        return Ok(());
    }
    let user = sandbox_user();
    let mut args: Vec<String> = ["run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--read-only", "--security-opt", "no-new-privileges", "--label"]
        .iter()
        .map(|a| a.to_string())
        .collect();
    args.push(format!("{LABEL_RUN}={}", job.run_id));
    let mut paths = Vec::new();
    for (index, name) in fresh.iter().enumerate() {
        args.extend(["-v".to_string(), format!("{name}:/v{index}")]);
        paths.push(format!("/v{index}"));
    }
    // A folder of its own in each, so the volume is never the empty one an engine re-owns on mount.
    let keeps: String = paths.iter().map(|path| format!("{path}/.codeflow-sandbox")).collect::<Vec<_>>().join(" ");
    let paths = paths.join(" ");
    args.extend([image.to_string(), "sh".into(), "-c".into(), format!("mkdir -p {keeps} && chown {user} {paths} {keeps} || chmod 1777 {paths} {keeps}")]);
    let out = target.run_owned(args, engine::PULL_TIMEOUT).await?;
    if out.ok() { Ok(()) } else { Err(out.complaint()) }
}

async fn ensure_image(target: &Target, image: &str) -> Result<(), String> {
    let there = target.run_owned(vec!["image".into(), "inspect".into(), image.into()], Duration::from_secs(30)).await.is_ok_and(|out| out.ok());
    if there {
        return Ok(());
    }
    let pulled = target.run_owned(vec!["pull".into(), image.into()], engine::PULL_TIMEOUT).await?;
    if pulled.ok() { Ok(()) } else { Err(pulled.complaint()) }
}

struct Step {
    code: Option<i32>,
    output: String,
    timed_out: bool,
}

async fn step(target: &Target, engine: EngineKind, job: &Job, image: &str, script: &str, input: Option<&str>, network: bool, timeout: Duration) -> Result<Step, String> {
    let name = format!("codeflow-check-{}", uuid::Uuid::new_v4().simple());
    let args = step_args(engine, &spec(job, image, &name, network), &job.run_id, script)?;
    match target.run_fed(args, Some(input.unwrap_or_default()), timeout).await {
        Ok(out) => {
            let output = match (out.stdout.trim().is_empty(), out.stderr.trim().is_empty()) {
                (false, false) => format!("{}\n{}", out.stdout.trim_end(), out.stderr.trim_end()),
                (false, true) => out.stdout,
                _ => out.stderr,
            };
            Ok(Step { code: out.code, output, timed_out: false })
        }
        Err(error) if error.contains("did not answer within") => {
            // The command line was let go; the container it started is not gone until it is told.
            let _ = target.run_owned(vec!["rm".into(), "-f".into(), name], Duration::from_secs(30)).await;
            Ok(Step { code: None, output: format!("La verificación superó {} minutos y se detuvo.", timeout.as_secs() / 60), timed_out: true })
        }
        Err(error) => Err(error),
    }
}

/// Runs the job's command on a copy of its tree, in a container. `Err` is only ever «it could not
/// run isolated»: a command that fails is a [`Ran`] that did not pass.
pub async fn run(db: &Db, job: Job) -> Result<Ran, Unavailable> {
    let probe = probe(false).await;
    let Some(target) = probe.target.clone() else { return Err(no_engine(&probe)) };
    let engine = target.engine().map_err(Unavailable)?;
    let tree = Path::new(&job.tree);
    let stored = {
        let conn = db.0.lock().map_err(|e| Unavailable(e.to_string()))?;
        policy::load(&conn, &job.workspace_id).map_err(|e| Unavailable(e.to_string()))?
    };
    let image = if job.image.trim().is_empty() { image_for(tree, &job.command, &stored.policy.sandbox_image()) } else { job.image.trim().to_string() };
    engine::check_ref(&image).map_err(Unavailable)?;
    let scan = db.0.lock().ok().and_then(|conn| policy::latest_scan(&conn, &image));

    // The policy judges the step that is most exposed: the one with network.
    let prepare = prepare_commands(tree);
    let judged = spec(&job, &image, "codeflow-check", !prepare.is_empty());
    let facts = policy::facts_for(&target, &image, std::slice::from_ref(&judged.network), &stored.policy, scan).await;
    let violations = policy::check_spec(&stored.policy, &judged, &facts);
    if policy::blocks(&violations) {
        let list: Vec<String> = violations.iter().filter(|v| v.blocking).map(|v| v.sentence()).collect();
        return Err(Unavailable(format!("La política de contenedores del workspace no permite el contenedor de verificación: {}.", list.join("; "))));
    }

    ensure_image(&target, &image).await.map_err(|e| Unavailable(format!("No se pudo obtener la imagen `{image}`: {}", first_lines(&e))))?;
    ensure_volumes(&target, &job, &image).await.map_err(|e| Unavailable(format!("No se pudieron preparar los volúmenes de la verificación: {}", first_lines(&e))))?;

    let source = job.tree.clone();
    let listing = tokio::task::spawn_blocking(move || listing(&source)).await.ok().flatten();
    let print = fingerprint(tree, &image);
    let check = script(&job.command, &prepare, &print, listing.is_some(), false);
    let broken = |e: String| Unavailable(format!("El motor de contenedores no pudo correr la verificación: {}", first_lines(&e)));
    let mut ran = step(&target, engine, &job, &image, &check, listing.as_deref(), false, job.timeout).await.map_err(broken)?;
    if ran.code == Some(NEEDS_PREPARE_CODE) && ran.output.contains(NEEDS_PREPARE) {
        let install = script(&job.command, &prepare, &print, listing.is_some(), true);
        let installed = step(&target, engine, &job, &image, &install, listing.as_deref(), true, super::deps::INSTALL_TIMEOUT).await.map_err(broken)?;
        if installed.code != Some(0) {
            let tail: String = installed.output.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
            return Ok(Ran { passed: false, output: format!("No se pudieron instalar las dependencias antes de la verificación (`{}`):\n{tail}", prepare.join(" && ")), image });
        }
        ran = step(&target, engine, &job, &image, &check, listing.as_deref(), false, job.timeout).await.map_err(broken)?;
    }
    // Exit codes above 124 with nothing said are the engine's own (the image has no shell, the
    // daemon went away): not a verdict on the work.
    if matches!(ran.code, Some(125..=127)) && !ran.timed_out && ran.output.to_lowercase().contains("docker:") {
        return Err(broken(ran.output));
    }
    Ok(Ran { passed: ran.code == Some(0), output: ran.output, image })
}

fn first_lines(text: &str) -> String {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).take(3).collect::<Vec<_>>().join(" · ")
}

/// Removes what a run's checks left in the engine: its copies, and any container of its that is
/// still there. The repositories' caches stay. Best effort — an engine that is not running keeps
/// them until [`forget_run`] is called again.
pub async fn forget_run(run_id: &str) {
    let probe = probe(false).await;
    let Some(target) = probe.target else { return };
    let label = format!("label={LABEL_RUN}={run_id}");
    if let Ok(out) = target.run_owned(vec!["ps".into(), "-aq".into(), "--filter".into(), label.clone()], Duration::from_secs(30)).await {
        let ids: Vec<String> = out.stdout.split_whitespace().map(str::to_string).collect();
        if !ids.is_empty() {
            let mut args = vec!["rm".to_string(), "-f".to_string()];
            args.extend(ids);
            let _ = target.run_owned(args, Duration::from_secs(60)).await;
        }
    }
    if let Ok(out) = target.run_owned(vec!["volume".into(), "ls".into(), "-q".into(), "--filter".into(), label], Duration::from_secs(30)).await {
        let names: Vec<String> = out.stdout.split_whitespace().map(str::to_string).collect();
        if !names.is_empty() {
            let mut args = vec!["volume".to_string(), "rm".to_string(), "-f".to_string()];
            args.extend(names);
            let _ = target.run_owned(args, Duration::from_secs(60)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tree(std::path::PathBuf);

    impl Tree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("cf-sandbox-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Tree(path)
        }
        fn write(&self, name: &str, text: &str) {
            let path = self.0.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn git(&self, args: &[&str]) {
            let out = crate::git::cli::run_in(&self.0.to_string_lossy(), args, &[]).unwrap();
            assert!(out.success, "git {args:?}: {}", out.detail());
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_image_follows_the_command_then_the_tree_then_the_workspace() {
        let tree = Tree::new();
        assert_eq!(image_for(tree.path(), "make test", "base:1"), "base:1", "nothing to go by: the workspace's image");
        tree.write("package.json", "{}");
        assert_eq!(image_for(tree.path(), "make test", "base:1"), "node:22-bookworm-slim", "the tree says what it is");
        assert_eq!(image_for(tree.path(), "CI=1 cargo test --manifest-path src-tauri/Cargo.toml", "base:1"), "rust:1-bookworm", "the command's own tool wins over the tree");
        assert_eq!(image_for(tree.path(), "cd api && go test ./...", "base:1"), "golang:1-bookworm");
        tree.write("bun.lock", "");
        assert_eq!(image_for(tree.path(), "npm test", "base:1"), "oven/bun:1", "a bun tree runs in bun's image");
    }

    #[test]
    fn what_installs_is_every_stack_the_tree_has_and_changes_the_fingerprint() {
        let tree = Tree::new();
        assert!(prepare_commands(tree.path()).is_empty());
        tree.write("package.json", "{}");
        tree.write("package-lock.json", "{}");
        tree.write("node_modules/x/index.js", "host build");
        tree.write("src-tauri/Cargo.toml", "[package]");
        tree.write("src-tauri/Cargo.lock", "v1");
        let commands = prepare_commands(tree.path());
        assert_eq!(commands, vec!["npm ci --prefer-offline --no-audit --no-fund".to_string(), "(cd src-tauri && cargo fetch --locked)".to_string()],
            "the host's node_modules is no reason not to install in the copy");
        let before = fingerprint(tree.path(), "node:22");
        assert_eq!(before, fingerprint(tree.path(), "node:22"));
        assert_ne!(before, fingerprint(tree.path(), "node:20"), "another image is another install");
        tree.write("src-tauri/Cargo.lock", "v2");
        assert_ne!(before, fingerprint(tree.path(), "node:22"), "a lockfile one folder down counts");
    }

    #[test]
    fn the_copy_is_what_git_would_commit() {
        let tree = Tree::new();
        assert_eq!(listing(&tree.path().to_string_lossy()), None, "not a repository: no list, the copy excludes by name");
        tree.git(&["init", "-q"]);
        tree.write(".gitignore", "node_modules\ndist\n");
        tree.write("src/a.ts", "a");
        tree.write("gone.ts", "x");
        tree.git(&["add", "-A"]);
        std::fs::remove_file(tree.path().join("gone.ts")).unwrap();
        tree.write("new.ts", "untracked");
        tree.write("node_modules/x/index.js", "host build");
        tree.write("dist/out.js", "built");
        let mut files: Vec<String> = listing(&tree.path().to_string_lossy()).unwrap().lines().map(str::to_string).collect();
        files.sort();
        assert_eq!(files, vec![".gitignore", "new.ts", "src/a.ts"], "tracked and new files that exist; nothing ignored, nothing deleted");
    }

    #[test]
    fn a_check_leaves_when_what_is_installed_is_stale_and_only_the_install_marks_it() {
        let prepare = vec!["npm ci".to_string()];
        let check = script("npm test -- --run 'it works'", &prepare, "abc", true, false);
        assert!(check.contains("exit 97") && check.contains(NEEDS_PREPARE));
        assert!(check.contains("tar -C /src -cf - -T -"), "the listed files are what is copied");
        assert!(check.contains(r#"bash -c 'npm test -- --run '\''it works'\''' </dev/null"#), "{check}");
        assert!(!check.contains("printf %s 'abc' >"), "a check never claims an install");
        let install = script("npm test", &prepare, "abc", false, true);
        assert!(install.contains("bash -c 'npm ci'") && install.contains("printf %s 'abc' > .codeflow-sandbox/prepared"));
        assert!(install.contains("--exclude=node_modules"), "without a list the copy leaves installs and builds out");
        assert!(!install.contains("npm test"), "the install step runs no check");
        let plain = script("make test", &[], "abc", true, false);
        assert!(!plain.contains("exit 97"), "nothing to install: nothing to wait for");
    }

    #[test]
    fn a_step_is_hardened_and_only_the_install_has_network() {
        let job = Job { workspace_id: "w".into(), run_id: "run-1234-5678".into(), project_id: "p".into(), tree: "/repo/tree".into(), slot: "item-1".into(), command: "npm test".into(), image: String::new(), timeout: Duration::from_secs(60) };
        let check = step_args(EngineKind::Docker, &spec(&job, "node:22", "codeflow-check-x", false), &job.run_id, "echo hi").unwrap();
        let line = check.join(" ");
        assert!(line.starts_with("run -i --label codeflow.team-run=run-1234-5678 --name codeflow-check-x"), "{line}");
        assert!(!check.contains(&"-w".to_string()), "no working directory for the engine to make as root: {line}");
        for needed in ["--rm", "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "-v /repo/tree:/src:ro", "--pids-limit 2048", "-e CARGO_NET_OFFLINE=true"] {
            assert!(line.contains(needed), "missing {needed} in {line}");
        }
        assert!(!line.contains("/repo/tree:/work"), "the host's tree is never the one written to");
        assert_eq!(&check[check.len() - 3..], ["sh", "-c", "echo hi"]);
        let install = step_args(EngineKind::Docker, &spec(&job, "node:22", "codeflow-check-y", true), &job.run_id, "x").unwrap().join(" ");
        assert!(install.contains("--network bridge") && !install.contains("CARGO_NET_OFFLINE"));
        // The same slot is the same copy; another item, another run or another repository is not.
        assert_eq!(work_volume("run-1234-5678", "p", "item-1"), work_volume("run-1234-5678", "p", "item-1"));
        assert_ne!(work_volume("run-1234-5678", "p", "item-1"), work_volume("run-1234-5678", "p", "item-2"));
        assert!(work_volume("run-1234-5678", "p", "item-1").starts_with("codeflow-check-run12345-"));
        assert_ne!(home_volume("p"), home_volume("q"));
    }

    /// Against a real engine: `cargo test --lib team::sandbox -- --ignored`.
    #[tokio::test]
    #[ignore = "needs a running container engine and network to pull an image"]
    async fn a_check_runs_isolated_on_a_real_engine() {
        let tree = Tree::new();
        tree.git(&["init", "-q"]);
        tree.write(".gitignore", "node_modules\n");
        tree.write("package.json", r#"{"name":"t","version":"1.0.0","scripts":{"test":"node test.js"},"dependencies":{"left-pad":"1.3.0"}}"#);
        tree.write("test.js", "const pad = require('left-pad'); require('fs').writeFileSync('made-by-check.txt', pad('x', 3)); console.log('padded', pad('x', 3));");
        tree.write("node_modules/left-pad/index.js", "throw new Error('the host build crossed over')");
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let db = Db::new(conn);
        let run_id = format!("test{}", uuid::Uuid::new_v4().simple());
        let job = |command: &str| Job { workspace_id: String::new(), run_id: run_id.clone(), project_id: format!("p-{run_id}"), tree: tree.path().to_string_lossy().into_owned(), slot: "item".into(), command: command.into(), image: String::new(), timeout: Duration::from_secs(300) };

        let ran = run(&db, job("npm test")).await.expect("an engine is running");
        assert!(ran.passed, "{}", ran.output);
        assert!(ran.output.contains("padded   x") || ran.output.contains("padded"), "{}", ran.output);
        assert_eq!(ran.image, "node:22-bookworm-slim");
        assert!(!tree.path().join("made-by-check.txt").exists(), "what the check wrote stayed in its copy");
        assert_eq!(std::fs::read_to_string(tree.path().join("node_modules/left-pad/index.js")).unwrap(), "throw new Error('the host build crossed over')", "the host's install is untouched");

        // The check itself has no network, and a failure is a failure, not «unavailable».
        let offline = run(&db, job("node -e \"require('https').get('https://registry.npmjs.org', () => process.exit(0)).on('error', () => process.exit(7))\"")).await.unwrap();
        assert!(!offline.passed, "the check reached the network: {}", offline.output);
        // It cannot write to the host's tree, and it is not root.
        let locked = run(&db, job("touch /src/x && exit 1; test \"$(id -u)\" != 0")).await.unwrap();
        assert!(locked.passed, "{}", locked.output);
        assert!(!tree.path().join("x").exists());

        // A file the tree dropped is gone from the copy on the next check.
        std::fs::remove_file(tree.path().join("test.js")).unwrap();
        tree.write("other.js", "console.log('other')");
        let next = run(&db, job("test ! -e test.js && node other.js && test -d node_modules/left-pad")).await.unwrap();
        assert!(next.passed, "{}", next.output);

        forget_run(&run_id).await;
        let target = Target { runtime: "docker".into(), context: None };
        let left = target.run_owned(vec!["volume".into(), "ls".into(), "-q".into(), "--filter".into(), format!("label={LABEL_RUN}={run_id}")], Duration::from_secs(30)).await.unwrap();
        assert!(left.stdout.trim().is_empty(), "the run's copies are removed with it: {}", left.stdout);
        let _ = target.run_owned(vec!["volume".into(), "rm".into(), "-f".into(), home_volume(&format!("p-{run_id}"))], Duration::from_secs(30)).await;
    }
}
