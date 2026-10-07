//! The triggers that watch the machine's infrastructure: a container engine's events, a Kubernetes
//! cluster's pods, deployments and nodes, and a line in a log — a file followed as it grows, or a
//! container's or a pod's output.
//!
//! **Through the same CLIs as the Contenedores panel** (`crate::containers`): `docker events`,
//! `kubectl get … -o json`, `docker logs -f`, `kubectl logs -f`. A stream that ends — the engine
//! stopped, the laptop slept, the pod was replaced — is started again after a pause, with the reason
//! in the Programación view meanwhile. A log picks up where it left off (`--since` the last line it
//! read), so what a crash-looping container printed between two attempts is still read.
//!
//! **A cluster is polled and compared.** The first look only learns the state; afterwards a pod that
//! enters `CrashLoopBackOff`, fails, restarts or stops being ready, a deployment that loses its
//! availability, a node that stops being Ready, or a new warning event fires — once per episode, not
//! once per look.

use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, FixedOffset, SecondsFormat};
use regex::Regex;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncSeekExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::TriggerView;
use crate::containers::{self, cli, engine, kube};
use crate::flows::run::Item;

fn text(params: &Value, name: &str) -> String {
    params.get(name).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn strings(params: &Value, name: &str) -> Vec<String> {
    params.get(name).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn fire(app: &AppHandle, flow_id: &str, node_id: &str, view: &Arc<Mutex<TriggerView>>, item: Value) {
    if let Err(error) = super::fire(app, flow_id, node_id, vec![Item::new(item)]) {
        super::note_problem(view, Some(error));
    }
}

/// How long a stream that ended waits before it is started again.
const RESTART_AFTER: Duration = Duration::from_secs(15);

/// The longest log line a stream hands on; the rest of a longer one is dropped, so a binary blob or a
/// minified bundle printed to a log cannot grow a buffer without bound.
const LOG_LINE_CAP: usize = 16 * 1024;

/// An engine event is a JSON document a line carrying every label of its container — and some images
/// label themselves with tens of kilobytes of build metadata (Cloud Native Buildpacks) — so it is cut
/// far later: a document cut short no longer parses, and the event would be lost.
const EVENT_LINE_CAP: usize = 1024 * 1024;

/// A pipe read a line at a time, whatever its bytes: invalid UTF-8 becomes U+FFFD instead of ending
/// the read. (`Lines::next_line` fails on it — and a pipe nobody reads any more fills until the tool
/// writing to it blocks: a trigger silently dead behind a process still running.) Cancel-safe: what
/// was read before a `select!` moved on is kept for the next call.
pub struct LineReader<R> {
    reader: BufReader<R>,
    line: Vec<u8>,
    cap: usize,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    pub fn new(inner: R, cap: usize) -> Self {
        Self { reader: BufReader::new(inner), line: Vec::new(), cap }
    }

    /// The next line without its `\n` (or `\r\n`), cut at the reader's cap; `None` once the pipe ends.
    pub async fn next_line(&mut self) -> std::io::Result<Option<String>> {
        loop {
            // The only await, and nothing is consumed before it answers: a cancel here loses nothing.
            let available = self.reader.fill_buf().await?;
            if available.is_empty() {
                return Ok((!self.line.is_empty()).then(|| self.take()));
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let body = &available[..newline.unwrap_or(available.len())];
            let room = self.cap.saturating_sub(self.line.len());
            self.line.extend_from_slice(&body[..body.len().min(room)]);
            let used = newline.map_or(available.len(), |at| at + 1);
            self.reader.consume(used);
            if newline.is_some() {
                return Ok(Some(self.take()));
            }
        }
    }

    fn take(&mut self) -> String {
        let mut bytes = std::mem::take(&mut self.line);
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// A log line as `--timestamps` prints it — `2026-10-07T03:15:22.123456789Z message` — as its moment,
/// the moment as written, and the message. `None` for a line without one: in a stream asked for
/// timestamps that is the tool talking (`Error response from daemon: No such container`), not the log.
pub fn split_stamp(line: &str) -> Option<(DateTime<FixedOffset>, &str, &str)> {
    let (stamp, message) = line.split_once(' ').unwrap_or((line, ""));
    let at = DateTime::parse_from_rfc3339(stamp).ok()?;
    Some((at, stamp, message))
}

/// What a stream's lines are.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lines {
    /// A log asked for `--timestamps`: every line of the watched thing carries one, on stdout or on
    /// stderr (`docker logs` hands a container's stderr back on its own stderr). A line without one is
    /// the tool's own — never matched, kept as the stream's problem instead.
    Log,
    /// An event stream: stdout is the events, stderr the tool's complaints.
    Events,
}

/// What a kept-up stream hands its consumer: a line, or word that a new attempt began — what was
/// learnt from the last one may be stale after the gap.
enum Streamed {
    Restarted,
    Line(String),
}

/// Where a log stream got to: the stamp of the last line handed on, as printed and as a moment.
type Mark = Option<(String, DateTime<FixedOffset>)>;

/// Runs `program args` and hands each line of the watched thing to `on_line`, until it ends or
/// `cancel` — then answers what the tool last complained of, for the view. A log moves `seen` to the
/// latest line it hands on, and skips a line at or before where `seen` stood when it started: a
/// reconnect asks for `--since` that moment, which the tools answer inclusively (kubectl, to the
/// second). Only then — stdout and stderr are two pipes, so within one attempt a line may arrive after
/// a later one and is still new.
async fn stream_lines<F>(program: &str, args: &[String], lines: Lines, seen: &mut Mark, cancel: &CancellationToken, on_line: &mut F) -> Result<(), String>
where
    F: FnMut(Streamed),
{
    let mut cmd = crate::proc::command(program);
    cmd.args(args)
        .env("PATH", cli::search_path())
        .envs(cli::engine_env().await.iter().cloned())
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("could not start {program}: {e}"))?;
    let cap = if lines == Lines::Log { LOG_LINE_CAP } else { EVENT_LINE_CAP };
    let mut out = LineReader::new(child.stdout.take().ok_or("no output")?, cap);
    let mut err = LineReader::new(child.stderr.take().ok_or("no output")?, cap);
    let mut complaint = String::new();
    let resume = seen.as_ref().map(|(_, at)| *at);
    let (mut out_open, mut err_open) = (true, true);
    while out_open || err_open {
        let (line, on_stderr) = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            line = out.next_line(), if out_open => match line {
                Ok(Some(line)) => (line, false),
                _ => {
                    out_open = false;
                    continue;
                }
            },
            line = err.next_line(), if err_open => match line {
                Ok(Some(line)) => (line, true),
                _ => {
                    err_open = false;
                    continue;
                }
            },
        };
        if lines == Lines::Log {
            if let Some((at, stamp, message)) = split_stamp(&line) {
                if resume.is_some_and(|resume| at <= resume) {
                    continue;
                }
                if seen.as_ref().is_none_or(|(_, last)| at > *last) {
                    *seen = Some((stamp.to_string(), at));
                }
                on_line(Streamed::Line(message.to_string()));
                continue;
            }
        } else if !on_stderr {
            on_line(Streamed::Line(line));
            continue;
        }
        if !line.trim().is_empty() {
            complaint = line;
        }
    }
    let _ = child.wait().await;
    Err(if complaint.is_empty() { format!("{program} stopped") } else { containers::tidy_problem(&complaint) })
}

/// Keeps a stream going: started again after [`RESTART_AFTER`] whenever it ends. `args` builds each
/// attempt's command from where the stream left off — `None` the first time (from now on), then the
/// stamp of the last line read or, before there was one, the moment it was armed.
fn keep_streaming<A, F>(program: String, args: A, lines: Lines, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken, mut on_line: F)
where
    A: Fn(Option<&str>) -> Vec<String> + Send + 'static,
    F: FnMut(Streamed) + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let armed = chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true);
        let mut seen: Mark = None;
        let mut first = true;
        loop {
            super::note_problem(&view, None);
            let started = Instant::now();
            let from = (!first).then(|| seen.as_ref().map_or(armed.clone(), |(stamp, _)| stamp.clone()));
            if !first {
                on_line(Streamed::Restarted);
            }
            first = false;
            if let Err(problem) = stream_lines(&program, &args(from.as_deref()), lines, &mut seen, &cancel, &mut on_line).await {
                super::note_problem(&view, Some(problem));
            }
            if cancel.is_cancelled() {
                return;
            }
            // A stream that died at once waits the full pause; one that ran a while comes back sooner.
            let pause = if started.elapsed() < RESTART_AFTER { RESTART_AFTER } else { Duration::from_secs(2) };
            tokio::select! {
                _ = tokio::time::sleep(pause) => {}
                _ = cancel.cancelled() => return,
            }
        }
    });
}

// --------------------------------------------------------------------------------- container events

fn target_of(params: &Value) -> engine::Target {
    let context = text(params, "containerContext");
    engine::Target { runtime: text(params, "engineKind"), context: (!context.is_empty()).then_some(context) }
}

/// nerdctl's event body: a JSON document *inside a string* (`"Event": "{\"container_id\":…}"`) — read
/// whichever way it comes.
fn payload(event: &Value) -> Value {
    match event.get("Event") {
        Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or(Value::Null),
        Some(other) => other.clone(),
        None => Value::Null,
    }
}

/// The container an event is about: Docker's `Actor.ID`, Podman's `ID`, containerd's `container_id`.
pub fn container_id(event: &Value) -> String {
    let body = payload(event);
    let candidates = if event.get("Topic").is_some() {
        [body.get("container_id"), body.get("id"), event.get("ID")]
    } else {
        [event.pointer("/Actor/ID"), event.get("ID"), event.get("id")]
    };
    let id = candidates.into_iter().flatten().filter_map(Value::as_str).find(|id| !id.is_empty()).unwrap_or_default().to_string();
    id
}

/// The trigger's own name for an engine event, from any of the three dialects.
pub fn event_kind(event: &Value) -> Option<(&'static str, Value)> {
    let action = event
        .get("Action")
        .or_else(|| event.get("action"))
        .or_else(|| event.get("Status"))
        .or_else(|| event.get("status"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let topic = event.get("Topic").and_then(Value::as_str).unwrap_or_default();
    // containerd says `/tasks/exit` when an `exec`'s process ends too — under that process's own id,
    // where the container's main task carries the container's.
    if topic == "/tasks/exit" {
        let body = payload(event);
        let container = body.get("container_id").and_then(Value::as_str).unwrap_or_default();
        let process = body.get("id").and_then(Value::as_str).unwrap_or_default();
        if !container.is_empty() && !process.is_empty() && process != container {
            return None;
        }
    }
    let health = event.get("HealthStatus").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    let kind = match (action.as_str(), topic) {
        (_, "/tasks/exit") => "evDie",
        (_, "/tasks/start") => "evStart",
        (_, "/tasks/oom") => "evOom",
        (_, "/containers/create") => "evCreate",
        (_, "/containers/delete") => "evDestroy",
        ("die" | "died", _) => "evDie",
        ("start", _) => "evStart",
        ("stop", _) => "evStop",
        ("restart", _) => "evRestart",
        ("oom", _) => "evOom",
        ("create", _) => "evCreate",
        ("destroy" | "remove", _) => "evDestroy",
        (a, _) if a.starts_with("health_status") => {
            let state = if health.is_empty() { a.rsplit(':').next().unwrap_or_default().trim().to_string() } else { health };
            match state.as_str() {
                "unhealthy" => "evUnhealthy",
                "healthy" => "evHealthy",
                _ => return None,
            }
        }
        _ => return None,
    };
    let attributes = event.pointer("/Actor/Attributes").or_else(|| event.get("Attributes")).cloned().unwrap_or_else(|| json!({}));
    Some((kind, attributes))
}

/// The item a container event becomes.
pub fn event_item(event: &Value, kind: &str, attributes: &Value, engine_id: &str) -> Value {
    let attr = |name: &str| attributes.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
    let body = payload(event);
    let id = container_id(event);
    let name = Some(attr("name")).filter(|n| !n.is_empty()).or_else(|| event.get("Name").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| id.chars().take(12).collect());
    let image = Some(attr("image"))
        .filter(|n| !n.is_empty())
        .or_else(|| event.get("Image").and_then(Value::as_str).map(str::to_string))
        .or_else(|| body.get("image").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let exit = Some(attr("exitCode"))
        .filter(|c| !c.is_empty())
        .and_then(|c| c.parse::<i64>().ok())
        .or_else(|| event.get("ContainerExitCode").and_then(Value::as_i64))
        // containerd leaves `exit_status` out when it is 0.
        .or_else(|| (event.get("Topic").and_then(Value::as_str) == Some("/tasks/exit")).then(|| body.get("exit_status").and_then(Value::as_i64).unwrap_or(0)));
    json!({
        "event": kind.trim_start_matches("ev").to_lowercase(),
        "container": name,
        "id": id.chars().take(12).collect::<String>(),
        "image": image,
        "exitCode": exit,
        "composeProject": attr("com.docker.compose.project"),
        "composeService": attr("com.docker.compose.service"),
        "engine": engine_id,
        "at": chrono::Utc::now().to_rfc3339(),
    })
}

/// The health each container last reported, so a health event fires on a change only. Docker reports
/// `health_status` when the health changes; Podman after every check — each interval, unhealthy or not.
/// A container that starts or stops begins again from no health, and so does every container after
/// the stream's own gap, which may have hidden anything.
#[derive(Default)]
pub struct HealthMemory {
    last: HashMap<String, &'static str>,
}

impl HealthMemory {
    /// Whether an event of `kind` about container `id` is news: a health event only when the health
    /// changed (the first heard of a container is); every other event always.
    pub fn news(&mut self, id: &str, kind: &'static str) -> bool {
        match kind {
            "evUnhealthy" | "evHealthy" => self.last.insert(id.to_string(), kind) != Some(kind),
            "evStart" | "evRestart" | "evStop" | "evDie" | "evDestroy" => {
                self.last.remove(id);
                true
            }
            _ => true,
        }
    }

    pub fn forget_all(&mut self) {
        self.last.clear();
    }
}

pub fn containers(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let target = target_of(params);
    let engine = target.engine()?;
    if cli::find(engine.id()).is_none() && engine.program() == engine.id() {
        return Err(format!("{} is not installed", engine.id()));
    }
    let wanted: HashSet<String> = strings(params, "ctrEvents").into_iter().collect();
    if wanted.is_empty() {
        return Err("choose at least one event".into());
    }
    let (names, images, project) = (text(params, "nameFilter"), text(params, "imageFilter"), text(params, "composeProject"));
    let skip_clean_exit = params.get("ignoreExitZero").and_then(Value::as_bool).unwrap_or(true);
    let mut args = target.global_args();
    match engine {
        engine::EngineKind::Docker => args.extend(["events", "--format", "{{json .}}", "--filter", "type=container"].map(String::from)),
        engine::EngineKind::Podman => args.extend(["events", "--format", "json", "--filter", "type=container"].map(String::from)),
        engine::EngineKind::Nerdctl => args.extend(["events", "--format", "{{json .}}"].map(String::from)),
        engine::EngineKind::Ctr => return Err("ctr has no event stream — use nerdctl".into()),
    }
    let (app, flow_id, node_id, fire_view) = (app.clone(), flow_id.to_string(), node_id.to_string(), view.clone());
    let engine_id = engine.id().to_string();
    let mut health = HealthMemory::default();
    keep_streaming(engine.program(), move |_| args.clone(), Lines::Events, view, cancel, move |streamed| {
        let line = match streamed {
            Streamed::Line(line) => line,
            Streamed::Restarted => {
                health.forget_all();
                return;
            }
        };
        let Ok(event) = serde_json::from_str::<Value>(line.trim()) else { return };
        let Some((kind, attributes)) = event_kind(&event) else { return };
        // Every event moves the memory along, wanted or not: a `start` resets a container's health.
        if !health.news(&container_id(&event), kind) || !wanted.contains(kind) {
            return;
        }
        let item = event_item(&event, kind, &attributes, &engine_id);
        if skip_clean_exit && kind == "evDie" && item["exitCode"] == json!(0) {
            return;
        }
        if !containers::glob_match(&names, item["container"].as_str().unwrap_or_default())
            || !containers::glob_match(&images, item["image"].as_str().unwrap_or_default())
            || (!project.is_empty() && item["composeProject"].as_str() != Some(project.as_str()))
        {
            return;
        }
        fire(&app, &flow_id, &node_id, &fire_view, item);
    });
    Ok(())
}

// ----------------------------------------------------------------------------------------- cluster

/// What one look at the cluster saw, by object.
#[derive(Debug, Default, Clone)]
pub struct ClusterState {
    /// `ns/pod` → (phase, restarts, every container ready, crash-looping, polls seen pending).
    pods: HashMap<String, (String, i64, bool, bool, u32)>,
    /// `ns/deployment` → looks in a row it has been in trouble (see [`deployment_changes`]).
    deployments: HashMap<String, u32>,
    /// node → ready.
    nodes: HashMap<String, bool>,
    /// The warning events of the last look (`uid|count`).
    events: HashSet<String>,
}

fn key_of(item: &Value) -> String {
    format!(
        "{}/{}",
        item.pointer("/metadata/namespace").and_then(Value::as_str).unwrap_or_default(),
        item.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default()
    )
}

/// Reads the pods of one look.
pub fn read_pods(list: &Value) -> HashMap<String, (String, i64, bool, bool, u32)> {
    let mut out = HashMap::new();
    for pod in list.get("items").and_then(Value::as_array).into_iter().flatten() {
        let phase = pod.pointer("/status/phase").and_then(Value::as_str).unwrap_or_default().to_string();
        let statuses = pod.pointer("/status/containerStatuses").and_then(Value::as_array).cloned().unwrap_or_default();
        let restarts = statuses.iter().filter_map(|s| s.get("restartCount").and_then(Value::as_i64)).sum();
        let ready = !statuses.is_empty() && statuses.iter().all(|s| s.get("ready").and_then(Value::as_bool) == Some(true));
        let crashing = statuses.iter().any(|s| s.pointer("/state/waiting/reason").and_then(Value::as_str) == Some("CrashLoopBackOff"));
        out.insert(key_of(pod), (phase, restarts, ready, crashing, 0));
    }
    out
}

/// The changes between two looks that the trigger's events ask about, as items — and the state to
/// keep (pending counters carried over).
pub fn pod_changes(before: &HashMap<String, (String, i64, bool, bool, u32)>, now: &mut HashMap<String, (String, i64, bool, bool, u32)>, wanted: &HashSet<String>) -> Vec<Value> {
    let mut out = Vec::new();
    for (key, (phase, restarts, ready, crashing, pending)) in now.iter_mut() {
        let (namespace, name) = key.split_once('/').unwrap_or(("", key));
        let item = |event: &str, reason: String| json!({"event": event, "kind": "pod", "namespace": namespace, "name": name, "phase": phase, "restarts": restarts, "reason": reason});
        let Some((old_phase, old_restarts, old_ready, old_crashing, old_pending)) = before.get(key) else {
            // A pod first seen now (a new one) is compared from here on; only a crash already under
            // way is worth saying at once.
            if *crashing && wanted.contains("podCrashLoop") {
                out.push(item("podCrashLoop", "CrashLoopBackOff".into()));
            }
            if phase == "Pending" {
                *pending = 1;
            }
            continue;
        };
        if *crashing && !old_crashing && wanted.contains("podCrashLoop") {
            out.push(item("podCrashLoop", "CrashLoopBackOff".into()));
        }
        if phase == "Failed" && old_phase != "Failed" && wanted.contains("podFailed") {
            out.push(item("podFailed", "Failed".into()));
        }
        if *restarts > *old_restarts && wanted.contains("podRestarted") {
            out.push(item("podRestarted", format!("{} → {}", old_restarts, restarts)));
        }
        if phase == "Running" && !*ready && *old_ready && wanted.contains("podNotReady") {
            out.push(item("podNotReady", "NotReady".into()));
        }
        if phase == "Pending" {
            *pending = old_pending + 1;
            // Pending for three looks in a row: stuck, said once.
            if *pending == 3 && wanted.contains("podPending") {
                out.push(item("podPending", "Pending".into()));
            }
        }
    }
    out
}

/// Why a Deployment the controller has caught up with (`observedGeneration` ≥ `generation`) is in
/// trouble: its rollout gave up (`Progressing` False — `ProgressDeadlineExceeded`), or it is below its
/// minimum availability (`Available` False) outside a rollout. A rollout in progress is not trouble —
/// its old pods serve until the new ones are ready — and neither is `availableReplicas < replicas`,
/// which every scale-up and rolling update passes through.
pub fn deployment_trouble(deployment: &Value) -> Option<String> {
    let generation = deployment.pointer("/metadata/generation").and_then(Value::as_i64).unwrap_or(0);
    let observed = deployment.pointer("/status/observedGeneration").and_then(Value::as_i64).unwrap_or(0);
    if observed < generation {
        return None;
    }
    let condition = |kind: &str| {
        deployment
            .pointer("/status/conditions")
            .and_then(Value::as_array)
            .and_then(|list| list.iter().find(|c| c.get("type").and_then(Value::as_str) == Some(kind)))
            .map(|c| {
                let field = |name: &str| c.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
                (field("status"), field("reason"))
            })
    };
    let progressing = condition("Progressing");
    if let Some((status, reason)) = &progressing {
        if status == "False" {
            return Some(if reason.is_empty() { "ProgressDeadlineExceeded".into() } else { reason.clone() });
        }
    }
    let rolling_out = progressing.as_ref().is_some_and(|(status, reason)| status == "True" && reason != "NewReplicaSetAvailable");
    match condition("Available") {
        Some((status, reason)) if status == "False" && !rolling_out => Some(if reason.is_empty() { "MinimumReplicasUnavailable".into() } else { reason }),
        _ => None,
    }
}

/// Looks in a row a deployment must be in trouble to be an episode: one is a scale-up still bringing
/// its new pods up.
const TROUBLE_LOOKS: u32 = 2;

/// The deployments of one look that began an episode of trouble, as items — and the counts to keep.
/// Said once per episode: again only after the deployment has recovered. The first look only learns.
pub fn deployment_changes(before: Option<&HashMap<String, u32>>, list: &Value) -> (HashMap<String, u32>, Vec<Value>) {
    let mut seen = HashMap::new();
    let mut items = Vec::new();
    for deployment in list.get("items").and_then(Value::as_array).into_iter().flatten() {
        let key = key_of(deployment);
        let looks = match (deployment_trouble(deployment), before) {
            (None, _) => 0,
            (Some(_), None) => TROUBLE_LOOKS,
            (Some(reason), Some(before)) => {
                let earlier = before.get(&key).copied().unwrap_or(0);
                let looks = (earlier + 1).min(TROUBLE_LOOKS);
                if looks == TROUBLE_LOOKS && earlier < TROUBLE_LOOKS {
                    let (namespace, name) = key.split_once('/').unwrap_or(("", &key));
                    items.push(json!({
                        "event": "deployDegraded",
                        "kind": "deployment",
                        "namespace": namespace,
                        "name": name,
                        "reason": reason,
                        "available": deployment.pointer("/status/availableReplicas").and_then(Value::as_i64).unwrap_or(0),
                        "replicas": deployment.pointer("/spec/replicas").and_then(Value::as_i64).unwrap_or(1),
                    }));
                }
                looks
            }
        };
        seen.insert(key, looks);
    }
    (seen, items)
}

/// The warning events of one look that the last did not have (`uid|count` — a repeat bumps its count),
/// as items, and the set to keep: exactly this look's events. Bounded by the list itself, so it is never
/// cleared wholesale — that made the next look take every warning for new, and every look after it.
pub fn warning_changes(before: Option<&HashSet<String>>, list: &Value) -> (HashSet<String>, Vec<Value>) {
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for event in list.get("items").and_then(Value::as_array).into_iter().flatten() {
        let id = format!(
            "{}|{}",
            event.pointer("/metadata/uid").and_then(Value::as_str).unwrap_or_default(),
            event.get("count").and_then(Value::as_i64).unwrap_or(1)
        );
        if before.is_some_and(|before| !before.contains(&id)) {
            items.push(json!({
                "event": "warningEvent",
                "kind": event.pointer("/involvedObject/kind"),
                "namespace": event.pointer("/involvedObject/namespace"),
                "name": event.pointer("/involvedObject/name"),
                "reason": event.get("reason"),
                "message": event.get("message"),
                "count": event.get("count"),
            }));
        }
        seen.insert(id);
    }
    (seen, items)
}

async fn kubectl_json(target: &kube::KubeTarget, args: Vec<String>) -> Result<Value, String> {
    let text = target.run(args, None, Duration::from_secs(30)).await?;
    serde_json::from_str(&text).map_err(|e| format!("kubectl answered something that is not JSON: {e}"))
}

pub fn cluster(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    if cli::find("kubectl").is_none() {
        return Err("kubectl is not installed".into());
    }
    let wanted: HashSet<String> = strings(params, "k8sEvents").into_iter().collect();
    if wanted.is_empty() {
        return Err("choose at least one event".into());
    }
    let context = text(params, "kubeContext");
    let namespace = text(params, "namespace");
    let target = kube::KubeTarget { context: (!context.is_empty()).then_some(context.clone()), namespace: (!namespace.is_empty()).then_some(namespace) };
    let selector = text(params, "labelSelector");
    let interval = Duration::from_secs(params.get("intervalSec").and_then(Value::as_f64).unwrap_or(30.0).max(10.0) as u64);
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    tauri::async_runtime::spawn(async move {
        let mut state: Option<ClusterState> = None;
        loop {
            let scope = match target.namespace() {
                Some(ns) => vec!["-n".to_string(), ns.to_string()],
                None => vec!["-A".to_string()],
            };
            let with_selector = |mut args: Vec<String>| {
                if !selector.is_empty() {
                    args.extend(["-l".to_string(), selector.clone()]);
                }
                args
            };
            let look = async {
                let mut seen = ClusterState::default();
                let mut items = Vec::new();
                let previous = state.clone();
                let wants_pods = wanted.iter().any(|e| e.starts_with("pod"));
                if wants_pods {
                    let mut args = vec!["get".to_string(), "pods".to_string(), "-o".to_string(), "json".to_string()];
                    args.extend(scope.clone());
                    let list = kubectl_json(&target, with_selector(args)).await?;
                    seen.pods = read_pods(&list);
                    if let Some(previous) = &previous {
                        items.extend(pod_changes(&previous.pods, &mut seen.pods, &wanted));
                    }
                }
                if wanted.contains("deployDegraded") {
                    let mut args = vec!["get".to_string(), "deployments".to_string(), "-o".to_string(), "json".to_string()];
                    args.extend(scope.clone());
                    let list = kubectl_json(&target, with_selector(args)).await?;
                    let (deployments, degraded) = deployment_changes(previous.as_ref().map(|p| &p.deployments), &list);
                    seen.deployments = deployments;
                    items.extend(degraded);
                }
                if wanted.contains("nodeNotReady") {
                    let list = kubectl_json(&target, vec!["get".into(), "nodes".into(), "-o".into(), "json".into()]).await?;
                    for node in list.get("items").and_then(Value::as_array).into_iter().flatten() {
                        let name = node.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default().to_string();
                        let ready = node
                            .pointer("/status/conditions")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .any(|c| c.get("type").and_then(Value::as_str) == Some("Ready") && c.get("status").and_then(Value::as_str) == Some("True"));
                        if !ready && previous.as_ref().is_some_and(|p| p.nodes.get(&name) == Some(&true)) {
                            items.push(json!({"event": "nodeNotReady", "kind": "node", "name": name}));
                        }
                        seen.nodes.insert(name, ready);
                    }
                }
                if wanted.contains("warningEvent") {
                    let mut args = vec!["get".to_string(), "events".to_string(), "--field-selector".to_string(), "type=Warning".to_string(), "-o".to_string(), "json".to_string()];
                    args.extend(scope.clone());
                    let list = kubectl_json(&target, args).await?;
                    let (events, fresh) = warning_changes(previous.as_ref().map(|p| &p.events), &list);
                    seen.events = events;
                    items.extend(fresh);
                }
                Ok::<(ClusterState, Vec<Value>), String>((seen, items))
            };
            match look.await {
                Ok((seen, items)) => {
                    super::note_problem(&view, None);
                    state = Some(seen);
                    for mut item in items {
                        item["context"] = json!(context);
                        item["at"] = json!(chrono::Utc::now().to_rfc3339());
                        fire(&app, &flow_id, &node_id, &view, item);
                    }
                }
                Err(problem) => super::note_problem(&view, Some(problem)),
            }
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = cancel.cancelled() => return,
            }
        }
    });
    Ok(())
}

// ----------------------------------------------------------------------------------------- log line

/// What a line must hold to fire.
#[derive(Clone)]
pub enum Matcher {
    Any,
    Text(String),
    Pattern(Regex),
}

impl Matcher {
    pub fn of(params: &Value) -> Result<Matcher, String> {
        let pattern = text(params, "pattern");
        if pattern.is_empty() {
            return Ok(Matcher::Any);
        }
        if params.get("regex").and_then(Value::as_bool).unwrap_or(true) {
            Regex::new(&pattern).map(Matcher::Pattern).map_err(|e| format!("the pattern is not a valid regular expression: {e}"))
        } else {
            Ok(Matcher::Text(pattern.to_lowercase()))
        }
    }

    /// `None` when the line does not match; the groups it captured when it does.
    pub fn check(&self, line: &str) -> Option<Value> {
        match self {
            Matcher::Any => Some(json!([])),
            Matcher::Text(wanted) => line.to_lowercase().contains(wanted).then(|| json!([])),
            Matcher::Pattern(regex) => {
                let captures = regex.captures(line)?;
                let mut named = serde_json::Map::new();
                for name in regex.capture_names().flatten() {
                    if let Some(found) = captures.name(name) {
                        named.insert(name.to_string(), json!(found.as_str()));
                    }
                }
                if !named.is_empty() {
                    return Some(Value::Object(named));
                }
                Some(Value::Array(captures.iter().skip(1).map(|g| json!(g.map(|m| m.as_str()))).collect()))
            }
        }
    }
}

/// Lines in, items out: the match, the lines before it, and a cap on how many fire a minute.
pub struct LineWatch {
    matcher: Matcher,
    before: VecDeque<String>,
    keep: usize,
    per_minute: usize,
    fired: VecDeque<Instant>,
    suppressed: u64,
}

impl LineWatch {
    pub fn new(matcher: Matcher, keep: usize, per_minute: usize) -> Self {
        Self { matcher, before: VecDeque::new(), keep, per_minute, fired: VecDeque::new(), suppressed: 0 }
    }

    pub fn feed(&mut self, line: &str, source: &str) -> Option<Value> {
        let line = line.trim_end_matches(['\r', '\n']);
        let found = self.matcher.check(line);
        let item = found.and_then(|groups| {
            let now = Instant::now();
            while self.fired.front().is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60)) {
                self.fired.pop_front();
            }
            if self.per_minute > 0 && self.fired.len() >= self.per_minute {
                self.suppressed += 1;
                return None;
            }
            self.fired.push_back(now);
            let item = json!({
                "line": line,
                "groups": groups,
                "context": self.before.iter().cloned().collect::<Vec<_>>(),
                "source": source,
                "suppressedBefore": self.suppressed,
                "at": chrono::Utc::now().to_rfc3339(),
            });
            self.suppressed = 0;
            Some(item)
        });
        if self.keep > 0 {
            self.before.push_back(line.to_string());
            while self.before.len() > self.keep {
                self.before.pop_front();
            }
        }
        item
    }
}

/// Follows a file as it grows — from its end, like `tail -F`: a file truncated or replaced (a log
/// rotated) is read again from its start.
async fn follow_file(path: std::path::PathBuf, cancel: CancellationToken, view: Arc<Mutex<TriggerView>>, mut on_line: impl FnMut(String)) {
    let identity = |meta: &std::fs::Metadata| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            meta.ino()
        }
        #[cfg(not(unix))]
        {
            meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0)
        }
    };
    let mut position = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut file_id = std::fs::metadata(&path).map(|m| identity(&m)).unwrap_or(0);
    let mut partial = String::new();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            _ = cancel.cancelled() => return,
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            super::note_problem(&view, Some(format!("{} does not exist (yet)", path.display())));
            continue;
        };
        super::note_problem(&view, None);
        let id = identity(&meta);
        if id != file_id || meta.len() < position {
            file_id = id;
            position = 0;
            partial.clear();
        }
        if meta.len() == position {
            continue;
        }
        let Ok(mut file) = tokio::fs::File::open(&path).await else { continue };
        if file.seek(std::io::SeekFrom::Start(position)).await.is_err() {
            continue;
        }
        // At most 4 MB a second: a log that grows faster than that is read as it can be.
        let mut chunk = Vec::new();
        let read = (&mut file).take(4 * 1024 * 1024).read_to_end(&mut chunk).await.unwrap_or(0);
        position += read as u64;
        partial.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(at) = partial.find('\n') {
            let line: String = partial.drain(..=at).collect();
            on_line(line);
        }
        // A last line without its newline yet waits for it, unless it has grown absurdly long.
        if partial.len() > 64 * 1024 {
            on_line(std::mem::take(&mut partial));
        }
    }
}

pub fn log_line(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let matcher = Matcher::of(params)?;
    let keep = params.get("contextLines").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 50.0) as usize;
    let per_minute = params.get("maxPerMinute").and_then(Value::as_f64).unwrap_or(30.0).clamp(0.0, 10_000.0) as usize;
    let watch = Arc::new(Mutex::new(LineWatch::new(matcher, keep, per_minute)));
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    match text(params, "logSource").as_str() {
        "logContainer" => {
            let container = text(params, "container");
            if container.is_empty() {
                return Err("write the container's name".into());
            }
            engine::check_ref(&container)?;
            let target = target_of(params);
            let engine = target.engine()?;
            let global = target.global_args();
            let name = container.clone();
            // Timestamps on every line: they tell the container's lines from the tool's own, and say
            // where to pick up after a reconnect.
            let args = move |from: Option<&str>| {
                let mut args = global.clone();
                args.extend(["logs".to_string(), "-f".to_string(), "--timestamps".to_string()]);
                match from {
                    Some(at) => args.extend(["--since".to_string(), at.to_string()]),
                    None => args.extend(["--tail".to_string(), "0".to_string()]),
                }
                args.push(name.clone());
                args
            };
            let fire_view = view.clone();
            keep_streaming(engine.program(), args, Lines::Log, view, cancel, move |streamed| {
                let Streamed::Line(line) = streamed else { return };
                let item = watch.lock().ok().and_then(|mut w| w.feed(&line, &container));
                if let Some(item) = item {
                    fire(&app, &flow_id, &node_id, &fire_view, item);
                }
            });
        }
        "logPod" => {
            let pod = text(params, "k8sName");
            if pod.is_empty() {
                return Err("write the pod's name".into());
            }
            engine::check_ref(&pod)?;
            if cli::find("kubectl").is_none() {
                return Err("kubectl is not installed".into());
            }
            let target = kube::KubeTarget { context: Some(text(params, "kubeContext")), namespace: Some(text(params, "namespace")) };
            let container = text(params, "container");
            let name = pod.clone();
            let args = move |from: Option<&str>| {
                let mut args = target.context_args();
                args.extend(["logs".to_string(), "-f".to_string(), "--timestamps".to_string()]);
                match from {
                    Some(at) => args.push(format!("--since-time={at}")),
                    None => args.push("--tail=0".to_string()),
                }
                if let Some(namespace) = target.namespace() {
                    args.extend(["-n".to_string(), namespace.to_string()]);
                }
                if !container.is_empty() {
                    args.extend(["-c".to_string(), container.clone()]);
                }
                args.push(name.clone());
                args
            };
            let fire_view = view.clone();
            keep_streaming(kube::program(), args, Lines::Log, view, cancel, move |streamed| {
                let Streamed::Line(line) = streamed else { return };
                let item = watch.lock().ok().and_then(|mut w| w.feed(&line, &pod));
                if let Some(item) = item {
                    fire(&app, &flow_id, &node_id, &fire_view, item);
                }
            });
        }
        _ => {
            let path = text(params, "logPath");
            if path.is_empty() {
                return Err("choose the log file".into());
            }
            let path = crate::flows::nodes::expand_path(&path);
            let source = path.to_string_lossy().into_owned();
            let fire_view = view.clone();
            tauri::async_runtime::spawn(follow_file(path, cancel, view, move |line| {
                let item = watch.lock().ok().and_then(|mut w| w.feed(&line, &source));
                if let Some(item) = item {
                    fire(&app, &flow_id, &node_id, &fire_view, item);
                }
            }));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_events_are_read_in_every_dialect() {
        let docker = json!({"Type": "container", "Action": "die", "Actor": {"ID": "abcdef0123456789", "Attributes": {"exitCode": "137", "image": "postgres:16", "name": "db", "com.docker.compose.project": "api"}}});
        let (kind, attributes) = event_kind(&docker).unwrap();
        assert_eq!(kind, "evDie");
        let item = event_item(&docker, kind, &attributes, "docker");
        assert_eq!(item["container"], "db");
        assert_eq!(item["exitCode"], 137);
        assert_eq!(item["composeProject"], "api");
        assert_eq!(item["id"], "abcdef012345");
        assert_eq!(item["event"], "die");

        let health = json!({"Action": "health_status: unhealthy", "Actor": {"ID": "x", "Attributes": {"name": "web"}}});
        assert_eq!(event_kind(&health).unwrap().0, "evUnhealthy");

        let podman = json!({"ID": "f00", "Name": "web", "Image": "nginx", "Status": "died", "ContainerExitCode": 1, "Type": "container"});
        let (kind, attributes) = event_kind(&podman).unwrap();
        let item = event_item(&podman, kind, &attributes, "podman");
        assert_eq!((kind, item["container"].as_str(), item["exitCode"].as_i64()), ("evDie", Some("web"), Some(1)));
        assert!(event_kind(&json!({"Action": "exec_create: sh"})).is_none());
    }

    /// nerdctl's `events --format '{{json .}}'`, as it prints them: the event's body is a JSON string.
    #[test]
    fn nerdctl_events_carry_their_body_as_a_string() {
        let line = |topic: &str, body: &str| json!({"Timestamp": "2026-10-07T03:00:00.000000000Z", "ID": "", "Namespace": "default", "Topic": topic, "Status": "UNKNOWN", "Event": body});
        let crashed = line("/tasks/exit", r#"{"container_id":"c0ffee1234567890","id":"c0ffee1234567890","pid":4242,"exit_status":137,"exited_at":"2026-10-07T03:00:00Z"}"#);
        let (kind, attributes) = event_kind(&crashed).unwrap();
        let item = event_item(&crashed, kind, &attributes, "nerdctl");
        assert_eq!((kind, item["id"].as_str(), item["exitCode"].as_i64()), ("evDie", Some("c0ffee123456"), Some(137)));
        // A clean exit has no `exit_status` at all (it is left out when 0): read as 0, so "ignore clean
        // exits" can skip it.
        let clean = line("/tasks/exit", r#"{"container_id":"c0ffee1234567890","id":"c0ffee1234567890","pid":4242,"exited_at":"2026-10-07T03:00:00Z"}"#);
        let (kind, attributes) = event_kind(&clean).unwrap();
        assert_eq!(event_item(&clean, kind, &attributes, "nerdctl")["exitCode"], 0);
        // An `exec` that ended is not the container dying.
        let exec = line("/tasks/exit", r#"{"container_id":"c0ffee1234567890","id":"exec-3f1a","pid":4300,"exit_status":1,"exited_at":"2026-10-07T03:00:00Z"}"#);
        assert!(event_kind(&exec).is_none());
        let oom = line("/tasks/oom", r#"{"container_id":"c0ffee1234567890"}"#);
        assert_eq!(event_kind(&oom).unwrap().0, "evOom");
        assert_eq!(container_id(&oom), "c0ffee1234567890");
    }

    #[test]
    fn health_fires_on_a_change_only() {
        let mut memory = HealthMemory::default();
        // Podman reports after every check: one fire per change, not per interval.
        let heard: Vec<bool> = ["evHealthy", "evHealthy", "evUnhealthy", "evUnhealthy", "evUnhealthy", "evHealthy"].iter().map(|kind| memory.news("web", kind)).collect();
        assert_eq!(heard, vec![true, false, true, false, false, true]);
        assert!(memory.news("db", "evUnhealthy"), "each container has its own");
        // A restart begins again: healthy after it is news, though it was healthy before.
        assert!(memory.news("web", "evStart"));
        assert!(memory.news("web", "evHealthy"));
        memory.forget_all();
        assert!(memory.news("db", "evUnhealthy"), "after a gap in the stream, anything may have happened");
    }

    #[test]
    fn pods_fire_once_per_episode() {
        let wanted: HashSet<String> = ["podCrashLoop", "podRestarted", "podFailed", "podPending", "podNotReady"].iter().map(|s| s.to_string()).collect();
        let pod = |phase: &str, restarts: i64, ready: bool, waiting: Option<&str>| {
            let mut status = json!({"restartCount": restarts, "ready": ready, "state": {}});
            if let Some(reason) = waiting {
                status["state"] = json!({"waiting": {"reason": reason}});
            }
            json!({"items": [{"metadata": {"namespace": "prod", "name": "api-1"}, "status": {"phase": phase, "containerStatuses": [status]}}]})
        };
        let first = read_pods(&pod("Running", 0, true, None));
        let mut second = read_pods(&pod("Running", 1, false, Some("CrashLoopBackOff")));
        let fired: Vec<String> = pod_changes(&first, &mut second, &wanted).iter().map(|i| i["event"].as_str().unwrap().to_string()).collect();
        assert_eq!(fired, vec!["podCrashLoop", "podRestarted", "podNotReady"]);
        let mut third = read_pods(&pod("Running", 1, false, Some("CrashLoopBackOff")));
        assert!(pod_changes(&second, &mut third, &wanted).is_empty(), "still crashing is not news");

        let mut pending = read_pods(&pod("Pending", 0, false, None));
        let mut looks = vec![];
        let mut previous = first.clone();
        for _ in 0..4 {
            looks.extend(pod_changes(&previous, &mut pending, &wanted));
            previous = pending.clone();
            pending = read_pods(&pod("Pending", 0, false, None));
        }
        assert_eq!(looks.iter().filter(|i| i["event"] == "podPending").count(), 1);
    }

    fn deployment(generation: i64, observed: i64, available: (&str, &str), progressing: (&str, &str)) -> Value {
        json!({
            "metadata": {"namespace": "prod", "name": "api", "generation": generation},
            "spec": {"replicas": 3},
            "status": {
                "observedGeneration": observed,
                "availableReplicas": 1,
                "conditions": [
                    {"type": "Available", "status": available.0, "reason": available.1},
                    {"type": "Progressing", "status": progressing.0, "reason": progressing.1},
                ],
            },
        })
    }

    #[test]
    fn a_deployment_in_trouble_is_not_one_scaling_or_rolling_out() {
        let fine = deployment(4, 4, ("True", "MinimumReplicasAvailable"), ("True", "NewReplicaSetAvailable"));
        assert_eq!(deployment_trouble(&fine), None);
        // A rolling update: its old pods serve until the new ones are ready.
        let rolling = deployment(5, 5, ("False", "MinimumReplicasUnavailable"), ("True", "ReplicaSetUpdated"));
        assert_eq!(deployment_trouble(&rolling), None);
        // The controller has not caught up with the new spec yet.
        let stale = deployment(6, 5, ("False", "MinimumReplicasUnavailable"), ("True", "NewReplicaSetAvailable"));
        assert_eq!(deployment_trouble(&stale), None);
        let down = deployment(4, 4, ("False", "MinimumReplicasUnavailable"), ("True", "NewReplicaSetAvailable"));
        assert_eq!(deployment_trouble(&down).as_deref(), Some("MinimumReplicasUnavailable"));
        let stuck = deployment(5, 5, ("True", "MinimumReplicasAvailable"), ("False", "ProgressDeadlineExceeded"));
        assert_eq!(deployment_trouble(&stuck).as_deref(), Some("ProgressDeadlineExceeded"));
    }

    #[test]
    fn a_degraded_deployment_fires_once_per_episode() {
        let list = |d: &Value| json!({"items": [d]});
        let fine = list(&deployment(4, 4, ("True", "MinimumReplicasAvailable"), ("True", "NewReplicaSetAvailable")));
        let down = list(&deployment(4, 4, ("False", "MinimumReplicasUnavailable"), ("True", "NewReplicaSetAvailable")));
        let (mut state, items) = deployment_changes(None, &fine);
        assert!(items.is_empty());
        // One look below availability is a scale-up bringing pods up; it is said on the second.
        let mut fired = vec![];
        for look in [&down, &fine, &down, &down, &down, &fine, &down, &down] {
            let (next, items) = deployment_changes(Some(&state), look);
            fired.push(items.len());
            state = next;
        }
        assert_eq!(fired, vec![0, 0, 0, 1, 0, 0, 0, 1]);
        // Armed while already degraded: the first look only learns.
        let (state, items) = deployment_changes(None, &down);
        assert!(items.is_empty());
        assert!(deployment_changes(Some(&state), &down).1.is_empty());
    }

    #[test]
    fn warning_events_fire_once_however_many_there_are() {
        let events = |count: usize| json!({"items": (0..count).map(|i| json!({"metadata": {"uid": format!("uid-{i}")}, "count": 1, "reason": "BackOff"})).collect::<Vec<_>>()});
        let (first, items) = warning_changes(None, &events(6_000));
        assert!(items.is_empty(), "the first look only learns");
        let (second, items) = warning_changes(Some(&first), &events(6_001));
        assert_eq!(items.len(), 1, "a busy cluster's warnings are not taken for new on the next look");
        let (_, items) = warning_changes(Some(&second), &events(6_001));
        assert!(items.is_empty());
        let mut bumped = events(2);
        bumped["items"][0]["count"] = json!(2);
        let (_, items) = warning_changes(Some(&warning_changes(None, &events(2)).0), &bumped);
        assert_eq!(items.len(), 1, "a warning that happened again is news");
    }

    #[tokio::test]
    async fn lines_are_read_whatever_their_bytes() {
        let mut long = vec![b'x'; LOG_LINE_CAP + 500];
        long.push(b'\n');
        let mut input: Vec<u8> = b"before \xff\xfe bytes\r\n".to_vec();
        input.extend_from_slice(&long);
        input.extend_from_slice(b"after\nlast without newline");
        let mut reader = LineReader::new(input.as_slice(), LOG_LINE_CAP);
        assert_eq!(reader.next_line().await.unwrap().as_deref(), Some("before \u{fffd}\u{fffd} bytes"));
        assert_eq!(reader.next_line().await.unwrap().map(|l| l.len()), Some(LOG_LINE_CAP), "a line too long is cut");
        assert_eq!(reader.next_line().await.unwrap().as_deref(), Some("after"), "and the next one starts where it should");
        assert_eq!(reader.next_line().await.unwrap().as_deref(), Some("last without newline"));
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[test]
    fn stamps_tell_the_log_from_the_tool() {
        let (at, stamp, message) = split_stamp("2026-10-07T07:02:47.798995537Z GET / 200").unwrap();
        assert_eq!((stamp, message), ("2026-10-07T07:02:47.798995537Z", "GET / 200"));
        assert!(at < split_stamp("2026-10-07T07:02:47.799048079Z x").unwrap().0);
        assert!(split_stamp("2026-10-07T04:02:47.798995537-03:00 podman's own offset").is_some());
        assert_eq!(split_stamp("2026-10-07T07:02:47Z ").map(|s| s.2), Some(""));
        assert!(split_stamp("Error response from daemon: No such container: api").is_none());
        assert!(split_stamp("error: pods \"api\" not found").is_none());
    }

    /// A stand-in for `docker logs -f --timestamps` after a reconnect `--since` the line it had read:
    /// that line again (the tools answer inclusively), stamped lines on both pipes — one arriving after
    /// a later one — a byte that is not UTF-8, and the tool's own complaint without a stamp.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_log_stream_hands_on_the_log_and_keeps_the_complaint() {
        let script = r#"printf '2026-10-07T07:00:01.000000001Z first\n'; printf '2026-10-07T07:00:03.000000001Z third\n'; sleep 0.2; printf '2026-10-07T07:00:02.000000001Z oops \377\n' >&2; printf 'Error response from daemon: No such container: api\n' >&2"#;
        let args: Vec<String> = vec!["-c".into(), script.into()];
        let mut seen: Mark = split_stamp("2026-10-07T07:00:01.000000001Z").map(|(at, stamp, _)| (stamp.to_string(), at));
        let mut lines = Vec::new();
        let result = stream_lines("sh", &args, Lines::Log, &mut seen, &CancellationToken::new(), &mut |streamed| {
            if let Streamed::Line(line) = streamed {
                lines.push(line);
            }
        })
        .await;
        assert_eq!(lines, vec!["third", "oops \u{fffd}"], "the line already read is skipped, a late one from the other pipe is not");
        assert_eq!(result, Err("Error response from daemon: No such container: api".to_string()), "the complaint is the problem, not a line");
        assert_eq!(seen.map(|(stamp, _)| stamp).as_deref(), Some("2026-10-07T07:00:03.000000001Z"), "the next reconnect starts from the latest");
    }

    #[test]
    fn log_lines_match_keep_context_and_are_capped() {
        let matcher = Matcher::of(&json!({"pattern": "ERROR (?P<code>E\\d+)", "regex": true})).unwrap();
        let mut watch = LineWatch::new(matcher, 2, 2);
        assert!(watch.feed("arrancando", "app.log").is_none());
        assert!(watch.feed("conectando a la base", "app.log").is_none());
        let item = watch.feed("ERROR E42 sin conexión\n", "app.log").unwrap();
        assert_eq!(item["groups"]["code"], "E42");
        assert_eq!(item["context"], json!(["arrancando", "conectando a la base"]));
        assert!(watch.feed("ERROR E43", "app.log").is_some());
        assert!(watch.feed("ERROR E44", "app.log").is_none(), "past the cap a minute");
        let plain = Matcher::of(&json!({"pattern": "Timeout", "regex": false})).unwrap();
        assert!(plain.check("read TIMEOUT after 30s").is_some());
        assert!(Matcher::of(&json!({"pattern": "(", "regex": true})).is_err());
    }
}
