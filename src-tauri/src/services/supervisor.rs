//! Runs services: in dependency order, through their readiness gates, down again as a tree, and
//! back up after a crash when asked to.
//!
//! # Why this moved out of the webview
//!
//! The first executor lived in `servicesStore`, on the argument that the log gate needs the output
//! and the output was already streaming into the frontend. Everything that went wrong with it went
//! wrong because a webview cannot see processes:
//!
//! - **Stopping killed one process.** `close_terminal` signals the shell it started, and a dev
//!   command is a tree — `pnpm` → `node` → `vite` → `esbuild`, or `docker compose` talking to a
//!   daemon. The children were reparented and carried on holding the port, so the next start (and
//!   every autorestart) failed on "address already in use".
//! - **No exit codes.** `terminal:exit` carried none, so a migration that finished and a server that
//!   crashed were the same event, and "wait until it finishes" could not be expressed at all — the
//!   default gate, labelled "the command finishes", passed the instant the process *started*.
//! - **Ports could only be probed, never found.** A TCP connect to a port somebody typed, on
//!   `127.0.0.1` only — which a Node server bound to `::1` never answers.
//!
//! Here the supervisor owns the pty hooks (every byte and the exit code, in order), the process
//! tree (from the OS), and the listening sockets (see [`super::ports`]). The frontend asks for
//! things to start and stop and draws what it is told; it no longer decides anything.
//!
//! # The state machine
//!
//! ```text
//!   stopped ─start─▶ waiting ─deps ready─▶ starting ─gate─▶ ready
//!                       │                     │  ╲             │
//!                       ╰─dep failed─▶ failed ◀──exit≠0──────────╯
//!                                             ╲
//!   completed ◀─exit 0 (one-shot)──────────── starting
//!   restarting ─backoff─▶ waiting            (a crash with autorestart on)
//!   any live state ─stop─▶ stopping ─tree gone─▶ stopped
//! ```
//!
//! A `generation` counter is bumped by every transition that should cancel work in flight (a stop,
//! a restart, a new start); each task carries the generation it was started for and quietly gives up
//! when it no longer matches. A separate `spawn_id` names the *process*, so the output and exit of
//! a previous process can never be mistaken for the current one's.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::db::models::Service;
use crate::db::{queries, service_queries, Db};
use crate::terminal::{self, Origin, PtyHooks, TerminalRegistry};

use super::compose::{self, ComposeTarget};
use super::log::{strip_ansi, LogBuffer};
use super::ports::{self, ProcId, ProcessTable};

/// Emitted with one [`RuntimeView`] every time a service's state changes.
pub const RUNTIME_EVENT: &str = "services:runtime";

/// How long a gate that is waiting for something specific is given before the service is called
/// stuck. Long, because a JVM compiling before it boots is normal — and it is a ceiling, not a wait:
/// the row shows the elapsed time the whole while.
const GATE_TIMEOUT: Duration = Duration::from_secs(300);
/// How often a gate is re-evaluated when nothing has woken it.
const GATE_POLL: Duration = Duration::from_millis(400);
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

/// `auto` with no port to wait for: a process that has lived this long and then gone quiet this
/// long has finished starting. Workers, watchers and queue consumers never open a port, and would
/// otherwise sit at "starting" for ever.
const SETTLE_MIN: Duration = Duration::from_secs(4);
const SETTLE_QUIET: Duration = Duration::from_secs(2);
/// …and one that never stops talking is called up at this point regardless.
const SETTLE_MAX: Duration = Duration::from_secs(30);
/// A service that has been seen listening before is expected to listen again, so it is not settled
/// early — only after this long, in case it genuinely stopped opening a port.
const LEARNED_SETTLE: Duration = Duration::from_secs(120);

/// A cap and not a switch: a service that cannot bind its port restarts in a tight loop, and what
/// the user notices is the fan. Three attempts ride out a dependency still coming up.
const MAX_AUTORESTARTS: u32 = 3;
/// Seconds before each automatic restart. Growing, so a crash loop spends its attempts over twelve
/// seconds rather than in one.
const BACKOFF_SECS: [u64; 3] = [1, 3, 8];
/// Up this long, and the restart budget is refilled: one crash a day is not a crash loop.
const STABLE_RESET: Duration = Duration::from_secs(60);

/// How long a service gets after Ctrl-C before it is signalled harder. Compose gets longer: its
/// Ctrl-C *stops the containers*, and Docker's own stop timeout is ten seconds per container.
const STOP_GRACE: Duration = Duration::from_secs(6);
const STOP_GRACE_COMPOSE: Duration = Duration::from_secs(20);
const TERM_GRACE: Duration = Duration::from_secs(3);

/// The wait before automatic restart number `attempt`. Shortened under test, where the live tests
/// below exercise the whole ladder and twelve seconds of it would be twelve seconds of nothing.
fn backoff(attempt: usize) -> Duration {
    if cfg!(test) {
        Duration::from_millis(100)
    } else {
        Duration::from_secs(BACKOFF_SECS[attempt.min(BACKOFF_SECS.len() - 1)])
    }
}

fn stop_grace(compose: bool) -> Duration {
    if cfg!(test) {
        Duration::from_millis(1500)
    } else if compose {
        STOP_GRACE_COMPOSE
    } else {
        STOP_GRACE
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Stopped,
    /// Nothing launched yet: a dependency has not passed its gate. `blocked_by` names which.
    Waiting,
    /// The process is up; its gate has not passed.
    Starting,
    Ready,
    /// A one-shot that ran to a clean exit. Satisfies whatever depends on it.
    Completed,
    Failed,
    /// Ctrl-C has been sent; the tree has not finished going away.
    Stopping,
    /// Crashed, and waiting out its backoff before the automatic restart.
    Restarting,
}

/// What "it is up" means for one service. See `Service::ready_kind`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// A port opened by anything in its process tree (or, for Compose, every container up) — and
    /// for a process that never opens one, alive and quiet for a moment.
    Auto,
    Port(u16),
    Log(String),
    Http(String),
    /// A one-shot: ready when it exits cleanly.
    Exit,
    /// Ready the moment the process exists.
    Immediate,
}

pub fn gate_of(service: &Service) -> Gate {
    let value = service.ready_value.trim();
    match service.ready_kind.as_str() {
        "port" => value.parse::<u16>().ok().filter(|p| *p > 0).map(Gate::Port).unwrap_or(Gate::Auto),
        "log" if !value.is_empty() => Gate::Log(value.to_string()),
        "http" if !value.is_empty() => Gate::Http(if value.contains("://") {
            value.to_string()
        } else {
            format!("http://{value}")
        }),
        "exit" => Gate::Exit,
        "none" => Gate::Immediate,
        _ => Gate::Auto,
    }
}

/// A log gate's pattern: plain text (any case), or a regular expression written between slashes.
enum Matcher {
    Text(String),
    Regex(regex::Regex),
}

impl Matcher {
    fn new(pattern: &str) -> Self {
        if pattern.len() > 2 && pattern.starts_with('/') && pattern.ends_with('/') {
            if let Ok(re) = regex::RegexBuilder::new(&pattern[1..pattern.len() - 1]).case_insensitive(true).build() {
                return Matcher::Regex(re);
            }
        }
        Matcher::Text(pattern.to_lowercase())
    }

    fn matches(&self, text: &str) -> bool {
        match self {
            Matcher::Text(needle) => text.to_lowercase().contains(needle),
            Matcher::Regex(re) => re.is_match(text),
        }
    }
}

/// One service as the supervisor knows it. Never persisted — see `db/service_queries.rs`.
struct Run {
    /// The definition the current (or last) process was started from. Edits apply on next start.
    def: Service,
    status: Status,
    session_id: Option<String>,
    pid: Option<u32>,
    started_at: Option<i64>,
    ready_at: Option<i64>,
    exit_code: Option<i32>,
    /// A machine-readable reason, translated by the frontend: `exited`, `exitedClean`,
    /// `exitedBeforeReady`, `gateTimedOut`, `dependencyFailed`, `dependencyStopped`, `spawn`.
    error: Option<String>,
    /// Free text to go with it — the spawn error's own message.
    detail: Option<String>,
    blocked_by: Option<String>,
    restarts: u32,
    /// Listening right now: the tree's sockets plus, for Compose, the published ports.
    ports: Vec<u16>,
    generation: u64,
    spawn_id: u64,
    /// The spawn whose exit has already been handled, so a spawn that races its own exit does not
    /// record a session that is already gone.
    exited_spawn: u64,
    stopping: bool,
    start_after_stop: bool,
    log: LogBuffer,
    /// The number of the last output chunk of the current process in `log`. See `service_log`.
    seq: u64,
    matcher: Option<Matcher>,
    match_tail: String,
    log_matched: bool,
    spawned_at: Option<Instant>,
    ready_instant: Option<Instant>,
    last_output: Option<Instant>,
    tree: Vec<ProcId>,
    compose: Option<ComposeTarget>,
    compose_ready: bool,
    compose_ports: Vec<u16>,
    /// Pinned ports that answered when the gate passed — what a `docker run -p` publishes, which
    /// Docker holds and the tree never shows. Counted as this service's while it runs, the way
    /// `compose_ports` are.
    probed_ports: Vec<u16>,
    cwd: Option<PathBuf>,
    env: Vec<(String, String)>,
}

impl Run {
    fn new(def: Service) -> Self {
        Run {
            def,
            status: Status::Stopped,
            session_id: None,
            pid: None,
            started_at: None,
            ready_at: None,
            exit_code: None,
            error: None,
            detail: None,
            blocked_by: None,
            restarts: 0,
            ports: Vec::new(),
            generation: 0,
            spawn_id: 0,
            exited_spawn: 0,
            stopping: false,
            start_after_stop: false,
            log: LogBuffer::default(),
            seq: 0,
            matcher: None,
            match_tail: String::new(),
            log_matched: false,
            spawned_at: None,
            ready_instant: None,
            last_output: None,
            tree: Vec::new(),
            compose: None,
            compose_ready: false,
            compose_ports: Vec::new(),
            probed_ports: Vec::new(),
            cwd: None,
            env: Vec::new(),
        }
    }

    fn view(&self) -> RuntimeView {
        RuntimeView {
            id: self.def.id.clone(),
            workspace_id: self.def.workspace_id.clone(),
            name: self.def.name.clone(),
            status: self.status,
            alive: self.session_id.is_some(),
            session_id: self.session_id.clone(),
            pid: self.pid,
            started_at: self.started_at,
            ready_at: self.ready_at,
            exit_code: self.exit_code,
            error: self.error.clone(),
            detail: self.detail.clone(),
            blocked_by: self.blocked_by.clone(),
            restarts: self.restarts,
            ports: self.ports.clone(),
            known_ports: parse_ports(&self.def.detected_ports),
        }
    }
}

/// What the frontend is told about one service.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub status: Status,
    /// A process exists. Separate from `status` because a service can be `failed` and still
    /// running — a gate that never passed — and the row must still offer to stop it.
    pub alive: bool,
    pub session_id: Option<String>,
    pub pid: Option<u32>,
    pub started_at: Option<i64>,
    pub ready_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub detail: Option<String>,
    pub blocked_by: Option<String>,
    pub restarts: u32,
    pub ports: Vec<u16>,
    /// The ports seen on a previous run, for a stopped row to still say where it lives.
    pub known_ports: Vec<u16>,
}

/// A service's output so far, for a pane that is mounting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLog {
    pub text: String,
    /// The last chunk of the current process included in `text`. A pane attached to that process
    /// skips live chunks up to and including this number — they are already on screen.
    pub seq: u64,
    pub session_id: Option<String>,
}

/// `(service id, name, workspace id)` per process and per published port. See
/// [`Supervisor::port_owners`].
#[derive(Default)]
pub struct PortOwners {
    pub by_pid: Vec<(u32, (String, String, String))>,
    pub by_port: Vec<(u16, (String, String, String))>,
}

#[derive(Default)]
pub struct Supervisor {
    runs: Mutex<HashMap<String, Run>>,
    /// Woken on every state change, so a service waiting for a dependency moves the instant it is
    /// ready rather than at its next poll.
    changed: tokio::sync::Notify,
}

enum DepCheck {
    Cancelled,
    Satisfied,
    Blocked(String),
    Broken(String, &'static str),
}

enum Verdict {
    Wait,
    Ready,
    TimedOut,
}

/// Everything a gate decision reads, taken in one lock.
struct Observation {
    gate: Gate,
    elapsed: Duration,
    quiet: Duration,
    tree_ports: Vec<u16>,
    log_matched: bool,
    compose: bool,
    compose_ready: bool,
    pinned: Vec<u16>,
    learned: Vec<u16>,
}

enum Probe {
    None,
    Ports(Vec<u16>),
    Http(String),
}

/// What the monitor thread found about one live service.
struct MonitorUpdate {
    id: String,
    spawn_id: u64,
    tree: Vec<ProcId>,
    tree_ports: Vec<u16>,
    compose: Option<compose::ComposeStatus>,
}

struct MonitorTarget {
    id: String,
    spawn_id: u64,
    pid: Option<u32>,
    starting: bool,
    compose: Option<ComposeTarget>,
    cwd: Option<PathBuf>,
    env: Vec<(String, String)>,
}

impl Supervisor {
    pub fn of<R: Runtime>(app: &AppHandle<R>) -> Arc<Supervisor> {
        app.state::<Arc<Supervisor>>().inner().clone()
    }

    fn runs(&self) -> MutexGuard<'_, HashMap<String, Run>> {
        self.runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn publish<R: Runtime>(&self, app: &AppHandle<R>, views: Vec<RuntimeView>) {
        for view in views {
            let _ = app.emit(RUNTIME_EVENT, view);
        }
        self.changed.notify_waiters();
    }

    fn publish_one<R: Runtime>(&self, app: &AppHandle<R>, id: &str) {
        let view = self.runs().get(id).map(Run::view);
        self.publish(app, view.into_iter().collect());
    }

    /// Every service the supervisor has touched since launch.
    pub fn snapshot(&self) -> Vec<RuntimeView> {
        self.runs().values().map(Run::view).collect()
    }

    pub fn log(&self, id: &str) -> ServiceLog {
        match self.runs().get(id) {
            Some(run) => ServiceLog {
                text: run.log.text().to_string(),
                seq: run.seq,
                session_id: run.session_id.clone(),
            },
            None => ServiceLog { text: String::new(), seq: 0, session_id: None },
        }
    }

    pub fn clear_log(&self, id: &str) {
        if let Some(run) = self.runs().get_mut(id) {
            run.log.clear();
        }
    }

    /// Which live service each process and each Docker-published port belongs to, for the Ports
    /// view. The tree is the monitor's last reading, so a process started in the last second or two
    /// may not be attributed yet.
    pub fn port_owners(&self) -> PortOwners {
        let mut owners = PortOwners::default();
        for run in self.runs().values().filter(|run| run.session_id.is_some()) {
            let owner = (run.def.id.clone(), run.def.name.clone(), run.def.workspace_id.clone());
            owners.by_pid.extend(run.pid.map(|pid| (pid, owner.clone())));
            owners.by_pid.extend(run.tree.iter().map(|p| (p.pid, owner.clone())));
            owners.by_port.extend(run.compose_ports.iter().map(|port| (*port, owner.clone())));
            owners.by_port.extend(run.probed_ports.iter().map(|port| (*port, owner.clone())));
        }
        owners
    }

    /// Drops a deleted service's state. Called after it has been stopped.
    pub fn forget(&self, id: &str) {
        self.runs().remove(id);
    }

    /// Starts `ids` and everything they depend on, in dependency order.
    ///
    /// Not "just these": a service started alone would come up against a database that is not
    /// there, which is the failure its dependencies exist to describe. Anything already on its way
    /// up, or up, is left alone — pressing play on the frontend must not bounce the database under
    /// it — and a one-shot that already completed satisfies its dependents without running again
    /// unless it was asked for by name.
    pub fn start<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, workspace_id: &str, ids: &[String]) -> Result<(), String> {
        let services = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            service_queries::list_services(&conn, workspace_id).map_err(|e| e.to_string())?
        };
        let order = resolve_order(&services, ids);
        let asked: HashSet<&str> = ids.iter().map(String::as_str).collect();

        let mut launch = Vec::new();
        let mut bounce = Vec::new();
        let mut views = Vec::new();
        {
            let mut runs = self.runs();
            for service in order {
                let run = runs.entry(service.id.clone()).or_insert_with(|| Run::new(service.clone()));
                let named = asked.contains(service.id.as_str());
                match run.status {
                    Status::Waiting | Status::Starting | Status::Ready | Status::Restarting => continue,
                    Status::Stopping => {
                        run.start_after_stop = true;
                        continue;
                    }
                    Status::Completed if !named => continue,
                    // Alive but stuck behind a gate that never passed. Starting it again means
                    // starting it *over*, not a second copy beside the first.
                    Status::Failed if run.session_id.is_some() => {
                        if named {
                            bounce.push(service.id.clone());
                        }
                        continue;
                    }
                    _ => {}
                }
                run.def = service.clone();
                run.generation += 1;
                run.status = Status::Waiting;
                run.error = None;
                run.detail = None;
                run.blocked_by = None;
                run.exit_code = None;
                if named {
                    run.restarts = 0;
                }
                launch.push((service.id.clone(), run.generation));
                views.push(run.view());
            }
        }
        self.publish(app, views);

        for (id, generation) in launch {
            let (sup, app) = (self.clone(), app.clone());
            tauri::async_runtime::spawn(async move { sup.run_one(app, id, generation).await });
        }
        if !bounce.is_empty() {
            let (sup, app, workspace) = (self.clone(), app.clone(), workspace_id.to_string());
            tauri::async_runtime::spawn(async move {
                let _ = sup.restart(&app, &workspace, &bounce).await;
            });
        }
        Ok(())
    }

    /// Stops `ids`, dependents before what they depend on, and returns once they are all down.
    ///
    /// Only the services named: stopping the database under a running API is a thing people do on
    /// purpose, to watch what the API does about it.
    pub async fn stop<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, ids: &[String]) {
        let layers = {
            let runs = self.runs();
            let deps: HashMap<String, Vec<String>> = ids
                .iter()
                .filter_map(|id| runs.get(id).map(|run| (id.clone(), deps_of(&run.def))))
                .collect();
            stop_layers(ids, &deps)
        };
        for layer in layers {
            let mut handles = Vec::new();
            for id in layer {
                let (sup, app) = (self.clone(), app.clone());
                handles.push(tauri::async_runtime::spawn(async move { sup.stop_one(&app, &id).await }));
            }
            for handle in handles {
                let _ = handle.await;
            }
        }
    }

    /// Stops what is running of `ids`, then starts all of them — in reverse order going down and
    /// dependency order coming up, which is what makes restarting a group safe.
    pub async fn restart<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, workspace_id: &str, ids: &[String]) -> Result<(), String> {
        self.stop(app, ids).await;
        self.start(app, workspace_id, ids)
    }

    async fn run_one<R: Runtime>(self: Arc<Self>, app: AppHandle<R>, id: String, generation: u64) {
        loop {
            // Armed before the check, so a change landing between the two still wakes this.
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match self.deps_state(&id, generation) {
                DepCheck::Cancelled => return,
                DepCheck::Satisfied => break,
                DepCheck::Blocked(dep) => self.set_blocked(&app, &id, generation, dep),
                DepCheck::Broken(dep, reason) => {
                    self.fail_waiting(&app, &id, generation, reason, dep);
                    return;
                }
            }
            let _ = tokio::time::timeout(Duration::from_millis(500), notified).await;
        }
        if self.spawn(&app, &id, generation) {
            self.await_gate(&app, &id, generation).await;
        }
    }

    fn deps_state(&self, id: &str, generation: u64) -> DepCheck {
        let runs = self.runs();
        let Some(run) = runs.get(id) else { return DepCheck::Cancelled };
        if run.generation != generation || run.status != Status::Waiting {
            return DepCheck::Cancelled;
        }
        let mut blocked = None;
        for dep in deps_of(&run.def) {
            // A dependency with no state was not part of the start — it no longer exists.
            let Some(other) = runs.get(&dep) else { continue };
            match other.status {
                Status::Ready | Status::Completed => {}
                Status::Waiting | Status::Starting | Status::Restarting => {
                    blocked.get_or_insert(dep);
                }
                Status::Stopping if other.start_after_stop => {
                    blocked.get_or_insert(dep);
                }
                Status::Failed => return DepCheck::Broken(dep, "dependencyFailed"),
                Status::Stopping | Status::Stopped => return DepCheck::Broken(dep, "dependencyStopped"),
            }
        }
        match blocked {
            Some(dep) => DepCheck::Blocked(dep),
            None => DepCheck::Satisfied,
        }
    }

    fn set_blocked<R: Runtime>(&self, app: &AppHandle<R>, id: &str, generation: u64, dep: String) {
        let view = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(id) else { return };
            if run.generation != generation || run.blocked_by.as_deref() == Some(dep.as_str()) {
                return;
            }
            run.blocked_by = Some(dep);
            run.view()
        };
        self.publish(app, vec![view]);
    }

    fn fail_waiting<R: Runtime>(&self, app: &AppHandle<R>, id: &str, generation: u64, reason: &str, dep: String) {
        let view = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(id) else { return };
            if run.generation != generation || run.status != Status::Waiting {
                return;
            }
            run.status = Status::Failed;
            run.error = Some(reason.to_string());
            run.blocked_by = Some(dep);
            run.view()
        };
        self.publish(app, vec![view]);
    }

    /// Launches the process. Everything from claiming the spawn to recording its session happens
    /// under one lock, so there is no instant at which a service is `starting` without a process a
    /// stop could reach.
    fn spawn<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, id: &str, generation: u64) -> bool {
        let ok = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(id) else { return false };
            if run.generation != generation || !matches!(run.status, Status::Waiting | Status::Restarting) {
                return false;
            }
            run.spawn_id += 1;
            let spawn_id = run.spawn_id;
            let gate = gate_of(&run.def);
            run.status = Status::Starting;
            run.blocked_by = None;
            run.error = None;
            run.detail = None;
            run.exit_code = None;
            run.ports.clear();
            run.tree.clear();
            run.seq = 0;
            run.match_tail.clear();
            run.log_matched = false;
            run.matcher = match &gate {
                Gate::Log(pattern) => Some(Matcher::new(pattern)),
                _ => None,
            };
            run.compose = compose::target_of(&run.def.command);
            run.compose_ready = false;
            run.compose_ports.clear();
            run.probed_ports.clear();
            run.spawned_at = Some(Instant::now());
            run.last_output = None;
            run.ready_at = None;
            run.ready_instant = None;
            run.started_at = Some(epoch_ms());
            let marker = start_marker(&run.def.command, !run.log.text().is_empty());
            run.log.push(&marker);

            let launched = launch(app, &run.def, self.hooks(app, id, spawn_id, env_of(&run.def)));
            match launched {
                Ok(Launched { session, pid, cwd, env }) => {
                    run.session_id = Some(session);
                    run.pid = pid;
                    run.cwd = cwd;
                    run.env = env;
                    if gate == Gate::Immediate {
                        run.status = Status::Ready;
                        run.ready_at = Some(epoch_ms());
                        run.ready_instant = Some(Instant::now());
                    }
                    true
                }
                Err(message) => {
                    run.status = Status::Failed;
                    run.error = Some("spawn".into());
                    run.log.push(&format!("\x1b[31m{message}\x1b[0m\r\n"));
                    run.detail = Some(message);
                    run.spawned_at = None;
                    run.started_at = None;
                    false
                }
            }
        };
        self.publish_one(app, id);
        ok
    }

    fn hooks<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, id: &str, spawn_id: u64, env: Vec<(String, String)>) -> PtyHooks {
        let sup = self.clone();
        let key = id.to_string();
        let on_output: Arc<dyn Fn(u64, &str) + Send + Sync> =
            Arc::new(move |seq: u64, data: &str| sup.on_output(&key, spawn_id, seq, data));
        let sup = self.clone();
        let key = id.to_string();
        let app = app.clone();
        let on_exit: Box<dyn FnOnce(Option<i32>) + Send> =
            Box::new(move |code: Option<i32>| sup.on_exit(&app, &key, spawn_id, code));
        PtyHooks { env, env_remove: Vec::new(), on_output: Some(on_output), on_exit: Some(on_exit) }
    }

    fn on_output(&self, id: &str, spawn_id: u64, seq: u64, data: &str) {
        let matched = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(id) else { return };
            if run.spawn_id != spawn_id {
                return;
            }
            run.log.push(data);
            run.seq = seq;
            run.last_output = Some(Instant::now());
            match (&run.matcher, run.log_matched) {
                (Some(matcher), false) => {
                    // A rolling tail rather than everything ever printed: a dev server prints its
                    // banner once and then megabytes of request logs.
                    run.match_tail.push_str(&strip_ansi(data));
                    if run.match_tail.len() > 16 * 1024 {
                        let cut = run.match_tail.len() - 8 * 1024;
                        let cut = (cut..run.match_tail.len()).find(|i| run.match_tail.is_char_boundary(*i)).unwrap_or(0);
                        run.match_tail.drain(..cut);
                    }
                    let hit = matcher.matches(&run.match_tail);
                    run.log_matched = hit;
                    hit
                }
                _ => false,
            }
        };
        if matched {
            self.changed.notify_waiters();
        }
    }

    fn on_exit<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, id: &str, spawn_id: u64, code: Option<i32>) {
        enum Next {
            Nothing,
            Start(String),
            Respawn(u64, Duration),
        }
        let (view, next) = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(id) else { return };
            if run.spawn_id != spawn_id {
                return;
            }
            run.exited_spawn = spawn_id;
            run.session_id = None;
            run.pid = None;
            run.exit_code = code;
            run.ports.clear();
            run.probed_ports.clear();
            run.tree.clear();
            run.compose_ready = false;
            run.log.push(&exit_marker(code));
            let gate = gate_of(&run.def);
            let mut next = Next::Nothing;

            if run.stopping {
                run.stopping = false;
                run.status = Status::Stopped;
                if std::mem::take(&mut run.start_after_stop) {
                    next = Next::Start(run.def.workspace_id.clone());
                }
            } else {
                let clean = code == Some(0);
                let was = run.status;
                let one_shot = matches!(gate, Gate::Exit | Gate::Immediate);
                if clean && (one_shot || (was == Status::Starting && gate == Gate::Auto)) {
                    // Finished what it was for. Under `auto`, a process that exits cleanly before
                    // ever opening a port was a task, not a server.
                    run.status = Status::Completed;
                } else if clean && matches!(was, Status::Ready | Status::Failed) {
                    // Ended by itself, cleanly — not a crash, but not something the user asked for
                    // either, so the row says so.
                    run.status = Status::Stopped;
                    run.error = Some("exitedClean".into());
                } else if clean {
                    // A clean exit from a service whose gate needed it to stay up to pass.
                    run.status = Status::Failed;
                    run.error = Some("exitedBeforeReady".into());
                } else {
                    // A crash.
                    if run.ready_instant.is_some_and(|at| at.elapsed() >= STABLE_RESET) {
                        run.restarts = 0;
                    }
                    if run.def.autorestart && run.restarts < MAX_AUTORESTARTS {
                        let delay = backoff(run.restarts as usize);
                        run.restarts += 1;
                        run.generation += 1;
                        run.status = Status::Restarting;
                        run.error = Some(if was == Status::Starting { "exitedBeforeReady" } else { "exited" }.into());
                        next = Next::Respawn(run.generation, delay);
                    } else {
                        run.status = Status::Failed;
                        run.error = Some(if was == Status::Starting { "exitedBeforeReady" } else { "exited" }.into());
                    }
                }
            }
            run.ready_instant = None;
            (run.view(), next)
        };
        self.publish(app, vec![view]);

        match next {
            Next::Nothing => {}
            Next::Start(workspace) => {
                let _ = self.start(app, &workspace, &[id.to_string()]);
            }
            Next::Respawn(generation, delay) => {
                let (sup, app, id) = (self.clone(), app.clone(), id.to_string());
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(delay).await;
                    let resumed = {
                        let mut runs = sup.runs();
                        match runs.get_mut(&id) {
                            Some(run) if run.generation == generation && run.status == Status::Restarting => {
                                run.status = Status::Waiting;
                                true
                            }
                            _ => false,
                        }
                    };
                    if resumed {
                        sup.publish_one(&app, &id);
                        // Through the dependency wait again: whatever took this one down may have
                        // taken its database with it.
                        sup.run_one(app, id, generation).await;
                    }
                });
            }
        }
    }

    async fn await_gate<R: Runtime>(&self, app: &AppHandle<R>, id: &str, generation: u64) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let Some(observation) = self.observe(id, generation) else { return };
            let mut answered = Vec::new();
            let probe_ok = match probe_for(&observation) {
                Probe::None => false,
                Probe::Ports(list) => {
                    answered = answering_ports(&list).await;
                    !answered.is_empty()
                }
                Probe::Http(url) => probe_http(&url, PROBE_TIMEOUT * 3).await,
            };
            match decide(&observation, probe_ok) {
                Verdict::Wait => {}
                Verdict::Ready => {
                    self.note_probed(id, generation, &answered);
                    self.settle(app, id, generation, Status::Ready, None);
                    return;
                }
                Verdict::TimedOut => {
                    self.settle(app, id, generation, Status::Failed, Some("gateTimedOut"));
                    return;
                }
            }
            let _ = tokio::time::timeout(GATE_POLL, notified).await;
        }
    }

    fn observe(&self, id: &str, generation: u64) -> Option<Observation> {
        let runs = self.runs();
        let run = runs.get(id)?;
        if run.generation != generation || run.status != Status::Starting {
            return None;
        }
        let spawned = run.spawned_at?;
        Some(Observation {
            gate: gate_of(&run.def),
            elapsed: spawned.elapsed(),
            quiet: run.last_output.unwrap_or(spawned).elapsed(),
            tree_ports: run
                .ports
                .iter()
                .copied()
                .filter(|p| !run.compose_ports.contains(p) && !run.probed_ports.contains(p))
                .collect(),
            log_matched: run.log_matched,
            compose: run.compose.is_some(),
            compose_ready: run.compose_ready,
            pinned: parse_ports(&run.def.ports),
            learned: parse_ports(&run.def.detected_ports),
        })
    }

    /// Records the pinned ports that answered as this service's own, just before the gate that
    /// probed them settles — so the row shows `:8080` for a `docker run -p 8080:8080`, and the Ports
    /// view names the service beside Docker's process holding it.
    fn note_probed(&self, id: &str, generation: u64, answered: &[u16]) {
        if answered.is_empty() {
            return;
        }
        let mut runs = self.runs();
        let Some(run) = runs.get_mut(id) else { return };
        if run.generation != generation || run.status != Status::Starting {
            return;
        }
        run.probed_ports = answered.to_vec();
        run.ports.extend(answered.iter().copied().filter(|p| !run.ports.contains(p)).collect::<Vec<_>>());
        run.ports.sort_unstable();
    }

    fn settle<R: Runtime>(&self, app: &AppHandle<R>, id: &str, generation: u64, status: Status, error: Option<&str>) {
        let view = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(id) else { return };
            if run.generation != generation || run.status != Status::Starting {
                return;
            }
            run.status = status;
            run.error = error.map(str::to_string);
            if status == Status::Ready {
                run.ready_at = Some(epoch_ms());
                run.ready_instant = Some(Instant::now());
            }
            run.view()
        };
        self.publish(app, vec![view]);
    }

    async fn stop_one<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, id: &str) {
        enum Plan {
            Done,
            AlreadyStopping,
            Kill { session: String, pid: Option<u32>, spawn_id: u64, grace: Duration, tree: Vec<ProcId> },
        }
        let plan = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(id) else { return };
            // An explicit stop wins over a restart that was queued behind an earlier one.
            run.start_after_stop = false;
            match (run.status, &run.session_id) {
                (Status::Stopping, _) => Plan::AlreadyStopping,
                (Status::Waiting | Status::Restarting, _) => {
                    run.generation += 1;
                    run.status = Status::Stopped;
                    run.blocked_by = None;
                    Plan::Done
                }
                (_, Some(session)) => {
                    run.generation += 1;
                    run.stopping = true;
                    run.status = Status::Stopping;
                    Plan::Kill {
                        session: session.clone(),
                        pid: run.pid,
                        spawn_id: run.spawn_id,
                        grace: stop_grace(run.compose.is_some()),
                        tree: run.tree.clone(),
                    }
                }
                _ => return,
            }
        };
        self.publish_one(app, id);

        match plan {
            Plan::Done => {}
            Plan::AlreadyStopping => {
                let deadline = Instant::now() + STOP_GRACE_COMPOSE + TERM_GRACE * 3;
                while Instant::now() < deadline {
                    let notified = self.changed.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if self.runs().get(id).is_none_or(|run| run.status != Status::Stopping) {
                        return;
                    }
                    let _ = tokio::time::timeout(Duration::from_millis(250), notified).await;
                }
            }
            Plan::Kill { session, pid, spawn_id, grace, tree } => {
                let app_for_kill = app.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    kill_gracefully(&app_for_kill, &session, pid, &tree, grace);
                })
                .await;
                self.finish_stop(app, id, spawn_id);
            }
        }
    }

    /// Closes out a stop whose exit hook never ran — a child that kept the pty open past its own
    /// death, closed from this side. When the hook did run, this finds nothing to do.
    fn finish_stop<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, id: &str, spawn_id: u64) {
        let (view, restart) = {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(id) else { return };
            if run.spawn_id != spawn_id || !run.stopping {
                return;
            }
            run.stopping = false;
            run.status = Status::Stopped;
            run.session_id = None;
            run.pid = None;
            run.ports.clear();
            run.probed_ports.clear();
            run.tree.clear();
            run.exited_spawn = spawn_id;
            let restart = std::mem::take(&mut run.start_after_stop).then(|| run.def.workspace_id.clone());
            (run.view(), restart)
        };
        self.publish(app, vec![view]);
        if let Some(workspace) = restart {
            let _ = self.start(app, &workspace, &[id.to_string()]);
        }
    }

    /// Stops everything, on the way out of the app. Blocking: the point is to finish before the
    /// process does, and a `docker compose up` stopped by its Ctrl-C takes its containers down with
    /// it — where one killed by the app's exit would leave them running.
    pub fn shutdown<R: Runtime>(&self, app: &AppHandle<R>, budget: Duration) {
        let alive: Vec<(String, Option<u32>, Vec<ProcId>)> = {
            let mut runs = self.runs();
            runs.values_mut()
                .filter_map(|run| {
                    let session = run.session_id.clone()?;
                    run.stopping = true;
                    run.start_after_stop = false;
                    run.generation += 1;
                    Some((session, run.pid, run.tree.clone()))
                })
                .collect()
        };
        if alive.is_empty() {
            return;
        }
        let registry = app.state::<TerminalRegistry>();
        let mut table = ProcessTable::new();
        table.refresh();
        let trees: Vec<(String, Option<u32>, Vec<ProcId>)> = alive
            .into_iter()
            .map(|(session, pid, known)| (session, pid, merged_tree(&table, pid, &known)))
            .collect();
        for (session, _, _) in &trees {
            let _ = terminal::write_terminal(&registry, session, "\x03");
        }
        let deadline = Instant::now() + budget.mul_f32(0.7);
        while Instant::now() < deadline && trees.iter().any(|(s, _, _)| terminal::is_open(&registry, s)) {
            std::thread::sleep(Duration::from_millis(50));
        }
        for (session, pid, tree) in &trees {
            if terminal::is_open(&registry, session) {
                signal_tree(pid.is_some(), tree, Signal::Term);
            }
        }
        let deadline = Instant::now() + budget.mul_f32(0.3);
        while Instant::now() < deadline && trees.iter().any(|(s, _, _)| terminal::is_open(&registry, s)) {
            std::thread::sleep(Duration::from_millis(50));
        }
        for (session, pid, tree) in &trees {
            signal_tree(pid.is_some(), tree, Signal::Kill);
            let _ = terminal::close_terminal(&registry, session);
        }
    }

    fn monitor_targets(&self) -> Vec<MonitorTarget> {
        self.runs()
            .values()
            .filter(|run| run.session_id.is_some() && run.status != Status::Stopping)
            .map(|run| MonitorTarget {
                id: run.def.id.clone(),
                spawn_id: run.spawn_id,
                pid: run.pid,
                starting: run.status == Status::Starting,
                compose: run.compose.clone(),
                cwd: run.cwd.clone(),
                env: run.env.clone(),
            })
            .collect()
    }

    /// Writes what the monitor found. Answers the services whose learned ports changed, for the
    /// caller to write down — outside this lock, since that needs the database's.
    fn apply_monitor<R: Runtime>(&self, app: &AppHandle<R>, updates: Vec<MonitorUpdate>) -> Vec<(String, Vec<u16>)> {
        let mut views = Vec::new();
        let mut learned = Vec::new();
        {
            let mut runs = self.runs();
            for update in updates {
                let Some(run) = runs.get_mut(&update.id) else { continue };
                if run.spawn_id != update.spawn_id || run.session_id.is_none() {
                    continue;
                }
                run.tree = update.tree;
                if let Some(status) = update.compose {
                    run.compose_ready = status.ready;
                    run.compose_ports = status.ports;
                }
                let mut merged: Vec<u16> = update
                    .tree_ports
                    .iter()
                    .chain(run.compose_ports.iter())
                    .chain(run.probed_ports.iter())
                    .copied()
                    .collect();
                merged.sort_unstable();
                merged.dedup();
                if merged != run.ports {
                    run.ports = merged.clone();
                    if !merged.is_empty() && merged != parse_ports(&run.def.detected_ports) {
                        run.def.detected_ports = serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into());
                        learned.push((run.def.id.clone(), merged));
                    }
                    views.push(run.view());
                }
            }
        }
        if views.is_empty() {
            // Nothing a row shows changed, but a compose gate may have flipped: let it look.
            self.changed.notify_waiters();
        } else {
            self.publish(app, views);
        }
        learned
    }
}

/// Watches every live service's process tree for listening ports, and Compose projects for their
/// containers. One thread for the life of the app; a second of sleep per loop while nothing runs.
pub fn spawn_monitor<R: Runtime>(app: AppHandle<R>) {
    let _ = std::thread::Builder::new().name("services-monitor".into()).spawn(move || {
        let supervisor = Supervisor::of(&app);
        let mut table = ProcessTable::new();
        let mut compose_due: HashMap<String, Instant> = HashMap::new();
        loop {
            let targets = supervisor.monitor_targets();
            if targets.is_empty() {
                compose_due.clear();
                std::thread::sleep(Duration::from_millis(800));
                continue;
            }
            let starting = targets.iter().any(|t| t.starting);
            table.refresh();
            let trees: Vec<Vec<ProcId>> = targets.iter().map(|t| t.pid.map(|p| table.tree(p)).unwrap_or_default()).collect();
            let pids: Vec<u32> = trees.iter().flatten().map(|p| p.pid).collect();
            let listeners = ports::listeners_of(&pids);

            let mut updates = Vec::new();
            for (target, tree) in targets.into_iter().zip(trees) {
                let tree_ports = ports::ports_of(&listeners, &tree);
                let mut compose_status = None;
                if let Some(compose_target) = &target.compose {
                    let due = compose_due.get(&target.id).is_none_or(|at| Instant::now() >= *at);
                    if due {
                        compose_status = compose::status(compose_target, target.cwd.as_deref(), &target.env);
                        let every = if target.starting { Duration::from_secs(2) } else { Duration::from_secs(10) };
                        compose_due.insert(target.id.clone(), Instant::now() + every);
                    }
                }
                updates.push(MonitorUpdate {
                    id: target.id,
                    spawn_id: target.spawn_id,
                    tree,
                    tree_ports,
                    compose: compose_status,
                });
            }
            let learned = supervisor.apply_monitor(&app, updates);
            if !learned.is_empty() {
                if let Ok(conn) = app.state::<Db>().0.lock() {
                    for (id, ports) in learned {
                        let _ = service_queries::set_detected_ports(&conn, &id, &ports);
                    }
                }
            }
            std::thread::sleep(if starting { Duration::from_millis(700) } else { Duration::from_millis(2500) });
        }
    });
}

/// The pure half of a gate: given what was observed, is it up?
fn decide(o: &Observation, probe_ok: bool) -> Verdict {
    let timed_out = o.elapsed > GATE_TIMEOUT;
    let wait_or_timeout = if timed_out { Verdict::TimedOut } else { Verdict::Wait };
    match &o.gate {
        Gate::Immediate => Verdict::Ready,
        // Decided by the exit hook, and never timed out: a migration can take as long as it takes.
        Gate::Exit => Verdict::Wait,
        Gate::Port(_) | Gate::Http(_) => {
            if probe_ok {
                Verdict::Ready
            } else {
                wait_or_timeout
            }
        }
        Gate::Log(_) => {
            if o.log_matched {
                Verdict::Ready
            } else {
                wait_or_timeout
            }
        }
        Gate::Auto => {
            if !o.tree_ports.is_empty() {
                return Verdict::Ready;
            }
            if o.compose {
                return if o.compose_ready { Verdict::Ready } else { wait_or_timeout };
            }
            if !o.pinned.is_empty() {
                return if probe_ok { Verdict::Ready } else { wait_or_timeout };
            }
            let settled = o.quiet >= SETTLE_QUIET;
            if !o.learned.is_empty() {
                // It listened last time, so give it the chance to again before calling it up.
                return if o.elapsed >= LEARNED_SETTLE && settled { Verdict::Ready } else { Verdict::Wait };
            }
            if o.elapsed >= SETTLE_MAX || (o.elapsed >= SETTLE_MIN && settled) {
                Verdict::Ready
            } else {
                Verdict::Wait
            }
        }
    }
}

fn probe_for(o: &Observation) -> Probe {
    match &o.gate {
        Gate::Port(port) => Probe::Ports(vec![*port]),
        Gate::Http(url) => Probe::Http(url.clone()),
        // Only ports the user pinned are probed. A learned port might be held by something else
        // entirely today, and a connect to it would call this service up on another's behalf.
        Gate::Auto if !o.compose && o.tree_ports.is_empty() && !o.pinned.is_empty() => Probe::Ports(o.pinned.clone()),
        _ => Probe::None,
    }
}

/// Which of `ports` accept a connection, on either loopback. Both, because Node resolves
/// `localhost` to `::1` first and a dev server bound there never answers on `127.0.0.1` — which is
/// exactly how a port gate used to time out on a server that was plainly up. Every port is asked,
/// not only until the first answers: the ones that do are what the row shows.
async fn answering_ports(ports: &[u16]) -> Vec<u16> {
    let mut up = Vec::new();
    for port in ports {
        for host in ["127.0.0.1", "::1"] {
            let Ok(ip) = host.parse::<std::net::IpAddr>() else { continue };
            let attempt = tokio::net::TcpStream::connect(std::net::SocketAddr::new(ip, *port));
            if matches!(tokio::time::timeout(PROBE_TIMEOUT, attempt).await, Ok(Ok(_))) {
                up.push(*port);
                break;
            }
        }
    }
    up
}

/// Whether `url` answers with anything below 500. A health endpoint behind auth answers 401 and a
/// bare `/` on an API answers 404; both mean it is up. A 5xx means up but broken.
pub async fn probe_http(url: &str, timeout: Duration) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(timeout)
        // A dev server with a self-signed certificate is the normal case for `https://localhost`.
        // This request reads nothing but a status code from an address the user configured.
        .danger_accept_invalid_certs(true)
        .build()
    else {
        return false;
    };
    matches!(client.get(url).send().await, Ok(response) if response.status().as_u16() < 500)
}

struct Launched {
    session: String,
    pid: Option<u32>,
    cwd: Option<PathBuf>,
    env: Vec<(String, String)>,
}

fn launch<R: Runtime>(app: &AppHandle<R>, def: &Service, hooks: PtyHooks) -> Result<Launched, String> {
    if def.command.trim().is_empty() {
        return Err("this service has no command to run".into());
    }
    let cwd = resolve_cwd(app, def)?;
    let env = hooks.env.clone();
    let (program, args) = shell_invocation(&def.command);
    let registry = app.state::<TerminalRegistry>();
    let cwd_text = cwd.as_ref().map(|p| p.to_string_lossy().into_owned());
    let session = terminal::open_pty(
        app.clone(),
        &registry,
        &program,
        &args,
        cwd_text.as_deref(),
        None,
        Origin {
            cwd: cwd_text.clone().unwrap_or_default(),
            // The service's own name, so the terminal registry — which the Remote workspace and a
            // paired phone also read — lists it as what it is rather than as an anonymous shell.
            profile: def.name.clone(),
            owner: None,
        },
        hooks,
    )?;
    let pid = terminal::pid_of(&registry, &session);
    Ok(Launched { session, pid, cwd, env })
}

/// Where a service runs.
///
/// A `project_id` means the directory is relative to that repository's checkout, which is what lets
/// a definition survive the folder being moved or the repository being re-cloned elsewhere. Without
/// one, `cwd` is absolute. `Path::join` treats an absolute `cwd` as a replacement, so a definition
/// naming both a project and an absolute path lands on the absolute path — which is what somebody
/// typing an absolute path means.
fn resolve_cwd<R: Runtime>(app: &AppHandle<R>, service: &Service) -> Result<Option<PathBuf>, String> {
    let base = match &service.project_id {
        Some(project_id) => {
            let db = app.state::<Db>();
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
    Ok(Some(path))
}

/// The shell a one-line command is handed to.
///
/// Through a shell rather than split into argv, so a service can be `docker compose up db && echo
/// ready` or `pnpm dev --host` without anybody filling in an args array. `cmd /C` on Windows — it
/// is on every installation and needs no execution-policy exemption. `sh -lc` elsewhere, a login
/// shell for the `PATH` its profile builds.
pub fn shell_invocation(command: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("cmd".to_string(), vec!["/C".to_string(), command.to_string()])
    }
    #[cfg(not(windows))]
    {
        ("/bin/sh".to_string(), vec!["-lc".to_string(), command.to_string()])
    }
}

/// A service's environment variables. Only plain values: an entry shaped `{"vault": id}` names a
/// secret in the keyring, and is left out rather than passed as the text of its reference.
fn env_of(service: &Service) -> Vec<(String, String)> {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&service.env) else {
        return Vec::new();
    };
    map.into_iter()
        .filter(|(key, _)| !key.trim().is_empty())
        .filter_map(|(key, value)| match value {
            serde_json::Value::String(s) => Some((key, s)),
            serde_json::Value::Number(n) => Some((key, n.to_string())),
            serde_json::Value::Bool(b) => Some((key, b.to_string())),
            _ => None,
        })
        .collect()
}

pub fn deps_of(service: &Service) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&service.depends_on).unwrap_or_default()
}

fn parse_ports(json: &str) -> Vec<u16> {
    serde_json::from_str::<Vec<u16>>(json).unwrap_or_default()
}

/// The services `roots` need, dependencies first, each once.
///
/// Depth-first with an on-path set, so a cycle that got past the save-time check (a database edited
/// by hand) is walked once rather than forever.
pub fn resolve_order(services: &[Service], roots: &[String]) -> Vec<Service> {
    let by_id: HashMap<&str, &Service> = services.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut ordered = Vec::new();
    let mut done = HashSet::new();
    let mut on_path = HashSet::new();

    fn visit<'a>(
        id: &str,
        by_id: &HashMap<&str, &'a Service>,
        done: &mut HashSet<String>,
        on_path: &mut HashSet<String>,
        ordered: &mut Vec<Service>,
    ) {
        if done.contains(id) || on_path.contains(id) {
            return;
        }
        let Some(service) = by_id.get(id) else { return };
        on_path.insert(id.to_string());
        for dep in deps_of(service) {
            visit(&dep, by_id, done, on_path, ordered);
        }
        on_path.remove(id);
        done.insert(id.to_string());
        ordered.push((*service).clone());
    }

    for root in roots {
        visit(root, &by_id, &mut done, &mut on_path, &mut ordered);
    }
    ordered
}

/// `ids` in the order to stop them: layers of services nothing else in the set depends on, first.
/// A group goes down the way it came up, reversed — the API before the database it writes to.
pub fn stop_layers(ids: &[String], deps: &HashMap<String, Vec<String>>) -> Vec<Vec<String>> {
    let mut remaining: Vec<String> = ids.to_vec();
    remaining.dedup();
    let mut layers = Vec::new();
    while !remaining.is_empty() {
        let layer: Vec<String> = remaining
            .iter()
            .filter(|candidate| {
                !remaining
                    .iter()
                    .any(|other| other != *candidate && deps.get(other).is_some_and(|d| d.contains(candidate)))
            })
            .cloned()
            .collect();
        // A cycle leaves nobody without a dependent. Stop the rest together rather than never.
        let layer = if layer.is_empty() { std::mem::take(&mut remaining) } else { layer };
        remaining.retain(|id| !layer.contains(id));
        layers.push(layer);
    }
    layers
}

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

/// The tree as the OS sees it now, plus whatever the monitor saw before that is still alive — a
/// child that has already been reparented is no longer under the root, but it is still ours.
fn merged_tree(table: &ProcessTable, pid: Option<u32>, known: &[ProcId]) -> Vec<ProcId> {
    let mut tree = pid.map(|p| table.tree(p)).unwrap_or_default();
    for proc_id in known {
        if !tree.contains(proc_id) && table.is_alive(*proc_id) {
            tree.push(*proc_id);
        }
    }
    tree
}

/// Signals every process in `tree` that is still the process it was. `tree[0]` is the root, which
/// leads its own process group — so on Unix the group is signalled too, reaching anything that
/// stayed in it but started after the tree was read.
fn signal_tree(root_first: bool, tree: &[ProcId], signal: Signal) {
    let mut table = ProcessTable::new();
    table.refresh();
    #[cfg(unix)]
    {
        let sig = match signal {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        for (index, proc_id) in tree.iter().enumerate() {
            if table.is_alive(*proc_id) {
                ports::signal(proc_id.pid, sig, root_first && index == 0);
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = (root_first, signal);
        for proc_id in tree {
            if table.is_alive(*proc_id) {
                let _ = crate::proc::std_command("taskkill")
                    .args(["/PID", &proc_id.pid.to_string(), "/T", "/F"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    let _ = (root_first, tree, signal);
}

/// Stops one service's process tree: the way a person would, then less politely.
///
/// 1. **Ctrl-C** into its terminal — SIGINT to the whole foreground group, which is what every dev
///    server expects and the one thing that makes `docker compose up` stop its containers.
/// 2. **SIGTERM** to every process in the tree, read *before* anything was signalled: once the root
///    is gone its children are reparented, and nothing would link them to this service any more.
/// 3. **SIGKILL**, and the terminal closed.
///
/// And after any of them, whatever of the tree is still alive — a child that ignored the group's
/// signal, or escaped the group — is ended too. Stop means everything this service started.
fn kill_gracefully<R: Runtime>(app: &AppHandle<R>, session: &str, pid: Option<u32>, known: &[ProcId], grace: Duration) {
    let registry = app.state::<TerminalRegistry>();
    let mut table = ProcessTable::new();
    table.refresh();
    let tree = merged_tree(&table, pid, known);

    let _ = terminal::write_terminal(&registry, session, "\x03");
    if !wait_closed(&registry, session, grace) {
        signal_tree(pid.is_some(), &tree, Signal::Term);
        if !wait_closed(&registry, session, TERM_GRACE) {
            signal_tree(pid.is_some(), &tree, Signal::Kill);
            let _ = terminal::close_terminal(&registry, session);
            wait_closed(&registry, session, Duration::from_secs(2));
        }
    }
    reap_leftovers(&tree);
}

/// Ends whatever of `tree` outlived its root. Politely, then not.
fn reap_leftovers(tree: &[ProcId]) {
    let mut table = ProcessTable::new();
    table.refresh();
    let alive: Vec<ProcId> = tree.iter().copied().filter(|p| table.is_alive(*p)).collect();
    if alive.is_empty() {
        return;
    }
    signal_tree(false, &alive, Signal::Term);
    std::thread::sleep(Duration::from_millis(600));
    signal_tree(false, &alive, Signal::Kill);
}

fn wait_closed(registry: &TerminalRegistry, session: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !terminal::is_open(registry, session) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !terminal::is_open(registry, session)
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn clock() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// The dim line a new run opens with in the log, so a restarted service reads as the same console
/// continued rather than a new one — and where one process ended and the next began is visible.
fn start_marker(command: &str, after_output: bool) -> String {
    let lead = if after_output { "\r\n" } else { "" };
    format!("{lead}\x1b[2m▶ {} · {}\x1b[0m\r\n", clock(), command)
}

fn exit_marker(code: Option<i32>) -> String {
    let code = code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
    format!("\r\n\x1b[2m■ {} · exit {code}\x1b[0m\r\n", clock())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(id: &str, deps: &[&str]) -> Service {
        Service {
            id: id.into(),
            workspace_id: "w1".into(),
            group_id: None,
            name: id.into(),
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

    fn ids(services: &[Service]) -> Vec<&str> {
        services.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn dependencies_come_first_and_each_once() {
        let all = vec![service("web", &["api"]), service("api", &["db", "cache"]), service("db", &[]), service("cache", &["db"])];
        let order = resolve_order(&all, &["web".into()]);
        assert_eq!(ids(&order), vec!["db", "cache", "api", "web"]);
    }

    #[test]
    fn a_cycle_is_walked_once_instead_of_hanging() {
        let all = vec![service("a", &["b"]), service("b", &["a"])];
        assert_eq!(resolve_order(&all, &["a".into()]).len(), 2);
    }

    #[test]
    fn a_group_stops_dependents_first() {
        let deps: HashMap<String, Vec<String>> = [
            ("web".to_string(), vec!["api".to_string()]),
            ("api".to_string(), vec!["db".to_string()]),
            ("worker".to_string(), vec!["db".to_string()]),
            ("db".to_string(), vec![]),
        ]
        .into_iter()
        .collect();
        let layers = stop_layers(&["db".into(), "api".into(), "web".into(), "worker".into()], &deps);
        assert_eq!(layers, vec![vec!["web".to_string(), "worker".to_string()], vec!["api".to_string()], vec!["db".to_string()]]);
    }

    #[test]
    fn a_cycle_still_stops() {
        let deps: HashMap<String, Vec<String>> =
            [("a".to_string(), vec!["b".to_string()]), ("b".to_string(), vec!["a".to_string()])].into_iter().collect();
        assert_eq!(stop_layers(&["a".into(), "b".into()], &deps).concat().len(), 2);
    }

    #[test]
    fn gates_are_read_from_the_definition() {
        let mut s = service("x", &[]);
        assert_eq!(gate_of(&s), Gate::Auto);
        s.ready_kind = "port".into();
        s.ready_value = "5432".into();
        assert_eq!(gate_of(&s), Gate::Port(5432));
        s.ready_value = "nope".into();
        assert_eq!(gate_of(&s), Gate::Auto, "an unusable value falls back rather than never passing");
        s.ready_kind = "http".into();
        s.ready_value = "localhost:4001/health".into();
        assert_eq!(gate_of(&s), Gate::Http("http://localhost:4001/health".into()));
        s.ready_kind = "exit".into();
        assert_eq!(gate_of(&s), Gate::Exit);
        s.ready_kind = "none".into();
        assert_eq!(gate_of(&s), Gate::Immediate);
    }

    #[test]
    fn a_log_pattern_matches_any_case_or_as_a_regex() {
        assert!(Matcher::new("Ready in").matches("  VITE v5  ready in 300 ms"));
        assert!(Matcher::new("/started on port \\d+/").matches("Tomcat started on port 8080 (http)"));
        assert!(Matcher::new("/TOMCAT .*port/").matches("tomcat started on port 8080"), "a regex ignores case too");
        assert!(!Matcher::new("/listening on \\d+/").matches("listening on port"));
    }

    fn observed(gate: Gate) -> Observation {
        Observation {
            gate,
            elapsed: Duration::from_secs(1),
            quiet: Duration::ZERO,
            tree_ports: Vec::new(),
            log_matched: false,
            compose: false,
            compose_ready: false,
            pinned: Vec::new(),
            learned: Vec::new(),
        }
    }

    #[test]
    fn auto_is_ready_the_moment_the_tree_listens() {
        let mut o = observed(Gate::Auto);
        assert!(matches!(decide(&o, false), Verdict::Wait));
        o.tree_ports = vec![5173];
        assert!(matches!(decide(&o, false), Verdict::Ready));
    }

    /// Watchers and workers never open a port; alive and quiet for a moment is what "up" means.
    #[test]
    fn auto_settles_a_process_that_never_listens() {
        let mut o = observed(Gate::Auto);
        o.elapsed = SETTLE_MIN;
        o.quiet = Duration::from_millis(500);
        assert!(matches!(decide(&o, false), Verdict::Wait), "still talking");
        o.quiet = SETTLE_QUIET;
        assert!(matches!(decide(&o, false), Verdict::Ready));
        let mut chatty = observed(Gate::Auto);
        chatty.elapsed = SETTLE_MAX;
        assert!(matches!(decide(&chatty, false), Verdict::Ready), "one that never stops talking still gets there");
    }

    /// Having listened before, it is expected to listen again — not settled at four seconds.
    #[test]
    fn auto_waits_for_a_port_it_has_seen_before() {
        let mut o = observed(Gate::Auto);
        o.learned = vec![8080];
        o.elapsed = Duration::from_secs(40);
        o.quiet = Duration::from_secs(10);
        assert!(matches!(decide(&o, false), Verdict::Wait));
        o.elapsed = LEARNED_SETTLE;
        assert!(matches!(decide(&o, false), Verdict::Ready));
    }

    #[test]
    fn auto_waits_for_compose_containers_not_for_quiet() {
        let mut o = observed(Gate::Auto);
        o.compose = true;
        o.elapsed = Duration::from_secs(60);
        o.quiet = Duration::from_secs(30);
        assert!(matches!(decide(&o, false), Verdict::Wait));
        o.compose_ready = true;
        assert!(matches!(decide(&o, false), Verdict::Ready));
    }

    #[test]
    fn a_specific_gate_times_out_but_exit_never_does() {
        let mut o = observed(Gate::Port(5432));
        o.elapsed = GATE_TIMEOUT + Duration::from_secs(1);
        assert!(matches!(decide(&o, false), Verdict::TimedOut));
        assert!(matches!(decide(&o, true), Verdict::Ready));
        let mut exit = observed(Gate::Exit);
        exit.elapsed = GATE_TIMEOUT * 10;
        assert!(matches!(decide(&exit, false), Verdict::Wait));
    }

    #[test]
    fn only_pinned_ports_are_probed() {
        let mut o = observed(Gate::Auto);
        o.learned = vec![5173];
        assert!(matches!(probe_for(&o), Probe::None), "a learned port may belong to someone else today");
        o.pinned = vec![5432];
        assert!(matches!(probe_for(&o), Probe::Ports(p) if p == vec![5432]));
    }

    #[test]
    fn env_takes_plain_values_and_skips_vault_references() {
        let mut s = service("x", &[]);
        s.env = r#"{"PORT":"4001","DEBUG":true,"WORKERS":2,"TOKEN":{"vault":"abc"},"":"x"}"#.into();
        let mut env = env_of(&s);
        env.sort();
        assert_eq!(
            env,
            vec![
                ("DEBUG".to_string(), "true".to_string()),
                ("PORT".to_string(), "4001".to_string()),
                ("WORKERS".to_string(), "2".to_string()),
            ]
        );
    }

    /// The supervisor against real processes in real ptys: the behaviour the user sees, end to end,
    /// minus the webview. Unix only — the commands are `sh`.
    #[cfg(unix)]
    mod live {
        use super::*;
        use std::sync::Mutex;

        struct Harness {
            app: tauri::App<tauri::test::MockRuntime>,
            sup: Arc<Supervisor>,
        }

        impl Harness {
            fn new(services: &[Service]) -> Self {
                let conn = rusqlite::Connection::open_in_memory().unwrap();
                crate::db::migrations::run(&conn).unwrap();
                conn.execute_batch(
                    "DELETE FROM workspaces;
                     INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                         VALUES ('w1', 'W', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');",
                )
                .unwrap();
                for service in services {
                    service_queries::create_service(&conn, service).unwrap();
                }
                let app = tauri::test::mock_app();
                app.manage(Db(Mutex::new(conn)));
                app.manage(TerminalRegistry::default());
                let sup = Arc::new(Supervisor::default());
                app.manage(sup.clone());
                Harness { app, sup }
            }

            fn start(&self, ids: &[&str]) {
                let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
                self.sup.start(self.app.handle(), "w1", &ids).unwrap();
            }

            fn stop(&self, ids: &[&str]) {
                let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
                tauri::async_runtime::block_on(self.sup.stop(self.app.handle(), &ids));
            }

            fn view(&self, id: &str) -> RuntimeView {
                self.sup.runs().get(id).map(Run::view).expect("the service has state")
            }

            fn wait_for(&self, id: &str, want: Status, within: Duration) -> RuntimeView {
                let deadline = Instant::now() + within;
                loop {
                    let view = self.view(id);
                    if view.status == want {
                        return view;
                    }
                    if Instant::now() > deadline {
                        panic!("{id} never became {want:?}: {view:?}\n--- log ---\n{}", self.sup.log(id).text);
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
        }

        fn svc(id: &str, command: &str, ready_kind: &str, deps: &[&str]) -> Service {
            let mut s = service(id, deps);
            s.command = command.into();
            s.ready_kind = ready_kind.into();
            s
        }

        /// "Wait for the one before" — the thing that did not work. A one-shot gated on its exit
        /// holds its dependent back until it has actually finished.
        #[test]
        fn a_dependent_waits_for_a_one_shot_to_finish() {
            let h = Harness::new(&[
                svc("migrate", "sleep 1; echo migrated", "exit", &[]),
                svc("api", "echo api up; sleep 30", "none", &["migrate"]),
            ]);
            h.start(&["api"]);

            std::thread::sleep(Duration::from_millis(400));
            let api = h.view("api");
            assert_eq!(api.status, Status::Waiting, "api must not start before migrate is done");
            assert_eq!(api.blocked_by.as_deref(), Some("migrate"));

            let api = h.wait_for("api", Status::Ready, Duration::from_secs(10));
            assert_eq!(h.view("migrate").status, Status::Completed);
            assert_eq!(h.view("migrate").exit_code, Some(0));
            assert!(h.sup.log("migrate").text.contains("migrated"));
            assert!(api.alive);

            h.stop(&["api"]);
            assert_eq!(h.view("api").status, Status::Stopped);
            assert!(!h.view("api").alive);
        }

        /// A dependency that fails takes its dependents with it, and says which one.
        #[test]
        fn a_failed_dependency_fails_its_dependents_by_name() {
            let h = Harness::new(&[
                svc("db", "echo cannot start; exit 7", "auto", &[]),
                svc("api", "sleep 30", "none", &["db"]),
            ]);
            h.start(&["api"]);
            let db = h.wait_for("db", Status::Failed, Duration::from_secs(10));
            assert_eq!(db.exit_code, Some(7));
            assert_eq!(db.error.as_deref(), Some("exitedBeforeReady"));
            let api = h.wait_for("api", Status::Failed, Duration::from_secs(5));
            assert_eq!(api.error.as_deref(), Some("dependencyFailed"));
            assert_eq!(api.blocked_by.as_deref(), Some("db"));
            assert!(!api.alive, "it was never launched");
        }

        /// Autorestart retries a crash, up to the cap, then leaves it failed rather than looping.
        #[test]
        fn a_crash_is_restarted_up_to_the_cap() {
            let mut crashing = svc("worker", "echo boom; exit 3", "none", &[]);
            crashing.autorestart = true;
            let h = Harness::new(&[crashing]);
            h.start(&["worker"]);
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let view = h.view("worker");
                if view.status == Status::Failed && view.restarts == MAX_AUTORESTARTS {
                    break;
                }
                assert!(Instant::now() < deadline, "never settled: {view:?}");
                std::thread::sleep(Duration::from_millis(40));
            }
            // `boom\r\n` is the output; the run markers quote the command, `echo boom; exit 3`.
            let runs = h.sup.log("worker").text.matches("boom\r\n").count();
            assert_eq!(runs, 1 + MAX_AUTORESTARTS as usize, "the first run and three restarts");
            // And a manual start refills the budget.
            h.start(&["worker"]);
            assert_eq!(h.view("worker").restarts, 0);
        }

        /// A log gate passes on the line, colour codes and all — and not before it.
        #[test]
        fn a_log_gate_waits_for_its_line() {
            let mut s = svc("web", "echo booting; sleep 1; printf '  \\033[32mVITE\\033[0m ready in \\033[1m5\\033[22m ms\\n'; sleep 30", "log", &[]);
            s.ready_value = "ready in 5 ms".into();
            let h = Harness::new(&[s]);
            h.start(&["web"]);
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(h.view("web").status, Status::Starting);
            h.wait_for("web", Status::Ready, Duration::from_secs(10));
            h.stop(&["web"]);
        }

        /// Stop means the whole tree: here a child that left the process group, so neither Ctrl-C
        /// nor a group signal can reach it — the case that left ports held after a stop.
        #[test]
        fn stop_takes_down_a_child_that_escaped_the_group() {
            let h = Harness::new(&[svc(
                "escapee",
                "perl -e 'setpgrp(0,0); sleep 300' & exec sleep 300",
                "none",
                &[],
            )]);
            h.start(&["escapee"]);
            let view = h.wait_for("escapee", Status::Ready, Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(500));
            let mut table = ProcessTable::new();
            table.refresh();
            let tree = table.tree(view.pid.expect("a pid"));
            assert!(tree.len() >= 2, "the root and the escaped child: {tree:?}");

            h.stop(&["escapee"]);
            assert_eq!(h.view("escapee").status, Status::Stopped);
            table.refresh();
            let survivors: Vec<&ProcId> = tree.iter().filter(|p| table.is_alive(**p)).collect();
            assert!(survivors.is_empty(), "left running after stop: {survivors:?}");
        }

        /// The port is found in the process tree — nobody typed it in — and that is what makes an
        /// `auto` service ready.
        #[test]
        fn auto_finds_the_port_the_tree_listens_on() {
            let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            let command = format!(
                "echo starting; sleep 1; perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"127.0.0.1\", LocalPort => {port}, Listen => 5, ReuseAddr => 1) or die $!; sleep 300'"
            );
            let h = Harness::new(&[svc("api", &command, "auto", &[])]);
            spawn_monitor(h.app.handle().clone());
            h.start(&["api"]);
            let ready = h.wait_for("api", Status::Ready, Duration::from_secs(15));
            assert_eq!(ready.ports, vec![port]);
            // Written down for next time.
            let stored = {
                let db = h.app.state::<Db>();
                let conn = db.0.lock().unwrap();
                service_queries::get_service(&conn, "api").unwrap().unwrap().detected_ports
            };
            assert_eq!(stored, format!("[{port}]"));
            h.stop(&["api"]);
            assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(), "the port is free again");
        }

        /// A port held outside the service's tree — Docker's, for a `docker run -p` — is its port
        /// once the pinned probe finds it: on the row, and in the Ports view under its name.
        #[test]
        fn a_pinned_port_held_outside_the_tree_is_the_services_once_it_answers() {
            // Held by this test process, which is nowhere in the service's tree: the shape of a port
            // published by Docker's daemon.
            let outside = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = outside.local_addr().unwrap().port();
            let mut container = svc("container", "echo running; sleep 30", "auto", &[]);
            container.ports = format!("[{port}]");
            let h = Harness::new(&[container]);
            spawn_monitor(h.app.handle().clone());
            h.start(&["container"]);
            let ready = h.wait_for("container", Status::Ready, Duration::from_secs(10));
            assert_eq!(ready.ports, vec![port]);
            // Kept across the monitor's passes, which rebuild the list from the tree each time.
            std::thread::sleep(Duration::from_millis(2500));
            assert_eq!(h.view("container").ports, vec![port]);
            let owner_of = |sup: &Supervisor| {
                sup.port_owners().by_port.into_iter().find(|(held, _)| *held == port).map(|(_, owner)| owner.0)
            };
            assert_eq!(owner_of(&h.sup).as_deref(), Some("container"));
            h.stop(&["container"]);
            assert!(h.view("container").ports.is_empty(), "not the service's once it stopped");
            assert_eq!(owner_of(&h.sup), None);
        }

        /// A group goes down dependents-first and comes back in order on restart.
        #[test]
        fn a_group_restarts_in_order() {
            let h = Harness::new(&[
                svc("db", "echo db; sleep 30", "none", &[]),
                svc("api", "echo api; sleep 30", "none", &["db"]),
            ]);
            h.start(&["db", "api"]);
            h.wait_for("api", Status::Ready, Duration::from_secs(10));
            let first_api = h.view("api").session_id;
            tauri::async_runtime::block_on(h.sup.restart(h.app.handle(), "w1", &["db".into(), "api".into()])).unwrap();
            h.wait_for("api", Status::Ready, Duration::from_secs(10));
            assert_ne!(h.view("api").session_id, first_api, "a new process");
            let log = h.sup.log("api").text;
            assert!(log.matches("▶").count() >= 2, "both runs are in one log: {log}");
            h.stop(&["db", "api"]);
            assert_eq!(h.view("db").status, Status::Stopped);
            assert_eq!(h.view("api").status, Status::Stopped);
        }
    }

    #[tokio::test]
    async fn a_port_probe_finds_ipv4_and_ipv6_listeners() {
        let v4 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let v4_port = v4.local_addr().unwrap().port();
        assert_eq!(answering_ports(&[v4_port]).await, vec![v4_port]);
        if let Ok(v6) = std::net::TcpListener::bind("[::1]:0") {
            let v6_port = v6.local_addr().unwrap().port();
            assert_eq!(answering_ports(&[v6_port]).await, vec![v6_port], "a server on ::1 is up too");
        }
        // Every port is asked, and only the ones that answer are named.
        assert_eq!(answering_ports(&[1, v4_port]).await, vec![v4_port]);
        assert!(answering_ports(&[1]).await.is_empty());
    }
}
