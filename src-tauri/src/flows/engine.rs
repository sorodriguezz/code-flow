//! The scheduler: runs a [`Plan`]'s nodes in dependency order, independent branches in parallel.
//!
//! **When a node runs.** A node waits for every connection into it whose source takes part in the
//! run, and runs once all of them have delivered — the confirmed decision ("un nodo corre cuando
//! terminaron todas sus entradas conectadas"). A node all of whose inputs delivered nothing does
//! not run: it is *skipped*, delivers nothing in turn, and the skip travels down the branch — which
//! is what makes the "no" side of an If go quiet when every item went "yes".
//!
//! **Failure.** Per node, after its retries: *stop* (the default) cancels everything still running
//! and fails the run; *continue* turns the failure into an item and carries on; *error output*
//! sends the failed items out of the node's extra "error" port.
//!
//! **Stopping.** One [`CancellationToken`] per run. Every executor waits on it alongside whatever it
//! is waiting for — a process, a request, a timer, the JavaScript — and a node's own time limit is
//! a child token cancelled when the limit passes, so the same path stops a process tree either way.
//!
//! Nothing here knows about Tauri: what a run reports and what it may ask for go through
//! [`RunHost`], which `flows::runs` implements over the app and the tests implement in memory.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::catalog::LOOP_TYPE;
use super::expr::{ExprWorker, RunLookup};
use super::nodes::{self, NodeCtx, NodeError};
use super::run::{has_error_output, output_count, Item, NodeSettings, OnError, Origin, Plan, Ports};
use super::spec::{FlowNode, FlowSpec};

/// Nodes of one run executing at once. Branches are mostly waiting — on a process, the network, a
/// model — so this is about not starting forty processes at once, not about CPU.
const MAX_PARALLEL: usize = 8;

/// Batches one loop node may hand out in a run — far beyond any real list, low enough that a body
/// wired to grow its own input stops instead of running all night.
const MAX_BATCHES: u32 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
    /// `console.log` from a Code node.
    Console,
    /// What the engine itself says: a request and its status, a retry.
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatus {
    Running,
    Success,
    Error,
    Skipped,
    Canceled,
    /// Not executed: its pinned output stood in.
    Pinned,
    /// Not executed: its output was read from an earlier run (a step run's parents).
    Reused,
    /// Not executed: switched off, its input passed straight through.
    Disabled,
}

impl NodeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeStatus::Running => "running",
            NodeStatus::Success => "success",
            NodeStatus::Error => "error",
            NodeStatus::Skipped => "skipped",
            NodeStatus::Canceled => "canceled",
            NodeStatus::Pinned => "pinned",
            NodeStatus::Reused => "reused",
            NodeStatus::Disabled => "disabled",
        }
    }
}

/// One node, done — whatever "done" turned out to mean.
#[derive(Debug, Clone)]
pub struct NodeReport {
    pub node_id: String,
    pub status: NodeStatus,
    pub seq: u32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub attempts: u32,
    pub error: Option<String>,
    pub inputs: Arc<Ports>,
    /// Where each input item came from, per input port — what `$('Nodo').item` walks.
    pub origins: Arc<Vec<Vec<Origin>>>,
    pub outputs: Arc<Ports>,
    /// Which batch of a loop this report is about: 0 outside loops and for a loop's first batch. A
    /// node inside a loop reports once per batch.
    pub iteration: u32,
}

/// What a run sends back to the webhook that started it — from a Respond node, or the last node's
/// output when the trigger waits for the end.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// A boxed future, for the host calls that wait on something outside the run.
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A credential, secret included — read when a node needs it and dropped after.
pub struct Credential {
    pub kind: String,
    pub meta: Value,
    pub secret: String,
}

/// Which engine an AI node runs on: one of the six CLIs with its model and account, or `"local"` —
/// the local model set up in Settings (`model`, when set, overriding the one chosen there). An empty
/// provider is the "Flujos" routing row's engine; an empty account is the automatic one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct EngineChoice {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub account: String,
}

impl EngineChoice {
    pub fn is_local(&self) -> bool {
        self.provider == "local"
    }
}

/// One turn of a subscription CLI, as an AI node asks for it.
#[derive(Debug, Clone, Default)]
pub struct AiCall {
    pub engine: EngineChoice,
    /// The ask (`-p`).
    pub prompt: String,
    /// What it is to read — on stdin.
    pub data: String,
    pub system: Option<String>,
    pub cwd: Option<String>,
    /// May write: edits auto-approved, the user's tool allow-list. Otherwise the engine's strongest
    /// read-only mode.
    pub can_edit: bool,
    /// Handed to the CLIs that enforce one (`--json-schema`, `--output-schema`).
    pub schema: Option<Value>,
    /// An engine session to resume.
    pub session: Option<String>,
    /// CodeFlow's own MCP servers to run with, by name.
    pub mcp: Vec<String>,
    pub effort: Option<String>,
    /// For the status bar: which node is asking.
    pub node_name: String,
}

#[derive(Debug, Clone, Default)]
pub struct AiAnswer {
    pub text: String,
    pub provider: String,
    pub model: String,
    /// The account it ran as — `None` for the CLI's own login.
    pub account: Option<String>,
    pub session: Option<String>,
    /// `{ inputTokens, outputTokens, cacheReadTokens, costUsd }` as the CLI reported it.
    pub usage: Option<Value>,
}

/// One request to a local model server.
#[derive(Debug, Clone, Default)]
pub struct LocalCall {
    /// `auto` (Settings' server) | `bundled` | `ollama` | `openai`.
    pub server: String,
    /// Empty: the server's address from Settings, or its default.
    pub url: String,
    /// Empty: the model chosen in Settings.
    pub model: String,
    pub api_key: Option<String>,
    pub system: String,
    pub prompt: String,
    pub schema: Option<Value>,
    pub temperature: f32,
    pub max_tokens: u32,
    /// The window to load the model with; `0` for Settings' (or the model's suggested one).
    pub context: u32,
    pub node_name: String,
}

#[derive(Debug, Clone, Default)]
pub struct LocalAnswer {
    pub text: String,
    pub server: String,
    pub model: String,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    /// The answer ran into `max_tokens` and is cut.
    pub cut: bool,
}

/// A task for the Agents console: one agent with an instruction, or a saved chain template, in one
/// repository of the workspace.
#[derive(Debug, Clone, Default)]
pub struct AgentRequest {
    /// The node asking — what its log lines are filed under.
    pub node_id: String,
    pub agent_id: String,
    pub template_id: String,
    pub project_id: String,
    pub instruction: String,
    pub title: String,
    /// Wait for it to end (done, failed, stopped) and answer with its outcome.
    pub wait: bool,
}

/// A run parked at a node until someone decides — see [`RunHost::wait_for`].
#[derive(Debug, Clone)]
pub struct WaitRequest {
    pub node_id: String,
    pub node_name: String,
    /// `approval`, `webhook` or `time`.
    pub kind: String,
    /// What the person deciding reads.
    pub message: String,
    /// When it stops waiting on its own; `None` waits until decided.
    pub timeout: Option<Duration>,
    /// The node's input, kept so a run picked up after a restart can hand it on.
    pub inputs: Ports,
}

/// How a wait ended.
#[derive(Debug, Clone, PartialEq)]
pub struct WaitAnswer {
    /// `approved`, `rejected`, `resumed` (its URL was called, or its time came) or `expired`.
    pub decision: String,
    /// `desktop`, `phone`, `webhook` or `timer`.
    pub by: String,
    pub at: String,
    /// A call's body, or what an approver wrote.
    pub payload: Value,
}

fn not_here<'a, T: Send + 'a>(what: &'static str) -> HostFuture<'a, Result<T, String>> {
    Box::pin(async move { Err(format!("{what} is not available in this run")) })
}

/// What a run reports to, and asks of, the app around it.
pub trait RunHost: Send + Sync {
    fn node_started(&self, node: &FlowNode, seq: u32, items_in: usize, started_at: &str);
    fn node_finished(&self, node: &FlowNode, report: NodeReport);
    fn log(&self, node_id: &str, stream: LogStream, text: &str);
    fn notify(&self, title: &str, body: &str);
    fn state_get(&self, key: &str) -> Result<Option<Value>, String>;
    fn state_set(&self, key: &str, value: Option<&Value>) -> Result<(), String>;
    /// A workspace variable as it is now — `$vars` is the run's snapshot from when it started.
    fn var_get(&self, name: &str) -> Result<Option<String>, String>;
    fn var_set(&self, name: &str, value: Option<&str>) -> Result<(), String>;
    fn credential(&self, id: &str) -> Result<Credential, String>;
    /// A folder of this run's own for scripts and scratch files.
    fn work_dir(&self) -> PathBuf;
    /// Runs another flow from its "called by another flow" trigger with `items`; with `wait`, until
    /// it ends, answering with its last node's output.
    fn subflow(&self, flow_id: &str, items: Vec<Item>, wait: bool) -> HostFuture<'_, Result<Vec<Item>, String>>;
    /// Starts, stops or restarts one of the workspace's services, or reads where it is.
    fn service(&self, service_id: &str, action: &str, wait: bool, timeout: Duration) -> HostFuture<'_, Result<Value, String>>;

    // ---- AI (milestone 3). Defaults refuse, so a host without them still builds.

    /// One turn of a subscription CLI; `cancel` stops it (and its process tree).
    fn ai(&self, call: AiCall, cancel: CancellationToken) -> HostFuture<'_, Result<AiAnswer, String>> {
        let _ = (call, cancel);
        not_here("AI")
    }
    /// One request to a local model.
    fn local_ai(&self, call: LocalCall, cancel: CancellationToken) -> HostFuture<'_, Result<LocalAnswer, String>> {
        let _ = (call, cancel);
        not_here("A local model")
    }
    /// Starts an Agents task (and, with `wait`, waits for its end).
    fn agent_task(&self, request: AgentRequest, cancel: CancellationToken) -> HostFuture<'_, Result<Value, String>> {
        let _ = (request, cancel);
        not_here("The Agents console")
    }
    /// A repository of the workspace, by id: its folder on disk.
    fn project_path(&self, project_id: &str) -> Result<String, String> {
        Err(format!("Unknown repository {project_id}"))
    }
    /// The prompt template the user keeps for `kind` (`commit`, `pr`, `review`), or `""` for the
    /// built-in one.
    fn ai_template(&self, kind: &str) -> String {
        let _ = kind;
        String::new()
    }
    /// How spent the engine's plan was at the last reading — `(used %, resets_at RFC 3339)` — without
    /// asking the provider.
    fn quota(&self, engine: &EngineChoice) -> Option<(f64, String)> {
        let _ = engine;
        None
    }
    /// A node of this run may have edited the repository at `path`: its restore point exists, and the
    /// run should offer to undo it.
    fn edits_recorded(&self, path: &str) {
        let _ = path;
    }
    /// A secret this run is holding (a Llavero value, a credential): what the run stores — its node
    /// data and its log — shows it redacted from now on.
    fn secret_used(&self, value: &str) {
        let _ = value;
    }

    // ---- The app's own things (milestone 4).

    /// A saved connection of the Databases workspace, password attached from the keychain.
    fn db_connection(&self, connection_id: &str) -> Result<crate::datasource::DbConnectionConfig, String> {
        Err(format!("Unknown database connection {connection_id}"))
    }
    /// A host of the Remote workspace.
    fn remote_host(&self, host_id: &str) -> Result<crate::remotes::RemoteHostSpec, String> {
        Err(format!("Unknown remote host {host_id}"))
    }
    /// One of the app's operations by name, with JSON in and out — pull requests, pipelines, notes,
    /// the Reviewer, the Llavero, windows. See `flows::app_ops` for the list.
    /// Parks the run at a node until it is decided: approved or rejected (on the desk or the phone),
    /// its resume URL called, its time come. The run reads as waiting meanwhile, and a wait the app
    /// restarted under picks up where it was once decided.
    fn wait_for(&self, request: WaitRequest, cancel: CancellationToken) -> HostFuture<'_, Result<WaitAnswer, String>> {
        let _ = (request, cancel);
        not_here("Waiting")
    }
    /// The URL whose call resumes this run's "wait for a call" node; `None` where nothing listens.
    fn resume_url(&self) -> Option<String> {
        None
    }
    fn app_call(&self, op: &str, args: Value, cancel: CancellationToken) -> HostFuture<'_, Result<Value, String>> {
        let _ = (args, cancel);
        let op = op.to_string();
        Box::pin(async move { Err(format!("{op} is not available in this run")) })
    }
    /// An access token of an `oauth2` credential good for at least another minute — renewed with
    /// its refresh token, and stored, when it was not (`flows::oauth`).
    fn oauth_token(&self, id: &str, meta: &Value) -> HostFuture<'_, Result<String, String>> {
        let _ = (id, meta);
        not_here("An OAuth 2 credential")
    }
    /// Where the "Base vectorial" node keeps its own store.
    fn vectors_path(&self) -> PathBuf {
        crate::paths::flow_vectors_path()
    }
}

/// Everything about a run that is not the graph.
pub struct RunContext {
    pub run_id: String,
    pub flow_id: String,
    pub flow_name: String,
    pub workspace_id: String,
    /// What `$execution.mode` says: `manual`, `partial`, `step`.
    pub mode: String,
    /// `$vars`: the workspace's variables when the run started.
    pub vars: Map<String, Value>,
    pub timezone: Option<String>,
    pub locale: String,
    pub host: Arc<dyn RunHost>,
    pub cancel: CancellationToken,
    /// The webhook request waiting for this run's answer, if a webhook started it and waits.
    pub respond: Mutex<Option<tokio::sync::oneshot::Sender<Reply>>>,
    /// How many flows deep this run is: 0 for one started by hand or by a trigger, one more for
    /// each Execute flow that led to it. Bounded, so a flow calling itself ends.
    pub depth: u32,
    /// The flow's cap on AI calls an hour (`settings.aiPerHour`); `0` is no cap.
    pub ai_per_hour: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Success,
    Error,
    Canceled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Success => "success",
            RunStatus::Error => "error",
            RunStatus::Canceled => "canceled",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    pub status: RunStatus,
    pub error: Option<String>,
    pub error_node: Option<String>,
    /// The main output of the last node to finish successfully — what an Execute flow node and a
    /// webhook that waits for the end receive.
    pub last_output: Vec<Item>,
}

pub fn now_text() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ------------------------------------------------------------------------------------- run state

#[derive(Default)]
struct Slot {
    inputs: Ports,
    origins: Vec<Vec<Origin>>,
    pending: usize,
    outputs: Option<Arc<Ports>>,
}

/// The run's record of what each node took and gave — what the scheduler routes from and what
/// `$('Nodo')` reads.
struct Graph {
    spec: Arc<FlowSpec>,
    by_name: HashMap<String, String>,
    names: HashMap<String, String>,
    slots: Mutex<HashMap<String, Slot>>,
}

impl Graph {
    fn node(&self, id: &str) -> Option<&FlowNode> {
        self.spec.nodes.iter().find(|node| node.id == id)
    }

    fn origins(&self, id: &str) -> Arc<Vec<Vec<Origin>>> {
        Arc::new(self.slots.lock().ok().and_then(|slots| slots.get(id).map(|slot| slot.origins.clone())).unwrap_or_default())
    }
}

/// The `index`-th item origin across a node's input ports — by the ports' lengths, not by walking
/// every item before it: `$('X').item` asks once per item, and a walk would make that quadratic.
fn nth_origin(origins: &[Vec<Origin>], mut index: usize) -> Option<&Origin> {
    for port in origins {
        if index < port.len() {
            return port.get(index);
        }
        index -= port.len();
    }
    None
}

impl RunLookup for Graph {
    fn node_output(&self, name: &str) -> Option<String> {
        let id = self.by_name.get(name)?;
        let slots = self.slots.lock().ok()?;
        let answer = match slots.get(id).and_then(|slot| slot.outputs.as_ref()) {
            Some(outputs) => {
                let ports: Vec<Vec<&Value>> = outputs.iter().map(|port| port.iter().map(|item| &item.json).collect()).collect();
                json!({"executed": true, "outputs": ports})
            }
            None => json!({"executed": false, "outputs": []}),
        };
        Some(answer.to_string())
    }

    fn paired_item(&self, target: &str, node: &str, index: usize) -> String {
        let fail = |message: String| json!({"error": message}).to_string();
        let Some(mut current) = self.by_name.get(node).cloned() else {
            return fail(format!("No node is called \"{node}\""));
        };
        let Ok(slots) = self.slots.lock() else { return fail("The run's data is unavailable".into()) };
        let mut position = index;
        // A flow is a DAG outside loops, so the walk ends; the bound is for a corrupt record.
        for _ in 0..10_000 {
            let Some(slot) = slots.get(&current) else { break };
            let Some(origin) = nth_origin(&slot.origins, position) else {
                return fail(format!("No item from \"{target}\" leads to item {index} of \"{node}\""));
            };
            let source_name = self.names.get(&origin.node).cloned().unwrap_or_default();
            let Some(item) = slots
                .get(&origin.node)
                .and_then(|source| source.outputs.as_ref())
                .and_then(|outputs| outputs.get(origin.output as usize))
                .and_then(|port| port.get(origin.index as usize))
            else {
                break;
            };
            if source_name == target {
                return json!({"json": item.json}).to_string();
            }
            match item.paired {
                Some(paired) => {
                    current = origin.node.clone();
                    position = paired as usize;
                }
                None => {
                    return fail(format!(
                        "\"{source_name}\" made an item without saying which of its input items it came from, so \
                         the matching item of \"{target}\" is unknown — use $('{target}').first() or .all()"
                    ))
                }
            }
        }
        fail(format!("No item from \"{target}\" leads to this one"))
    }

    fn origin(&self, node: &str, index: usize) -> Option<String> {
        let id = self.by_name.get(node)?;
        let slots = self.slots.lock().ok()?;
        let origin = nth_origin(&slots.get(id)?.origins, index)?.clone();
        let name = self.names.get(&origin.node).cloned().unwrap_or_default();
        Some(json!({"name": name, "outputIndex": origin.output, "runIndex": 0}).to_string())
    }
}

// ------------------------------------------------------------------------------------------ loops

/// What the loop nodes of a run repeat — worked out once from the graph.
///
/// A loop node's **body** is everything reachable from its first output ("loop") without passing
/// back through it: those nodes run once per batch. Wires from the body into the loop node are its
/// **back wires** — they bring a batch's results home instead of counting towards the loop node
/// being ready. A loop inside another loop's body is that body's member like any node, and its own
/// body is its own: each node counts towards the innermost loop that repeats it.
#[derive(Default)]
struct LoopPlan {
    body: HashMap<String, HashSet<String>>,
    /// The body minus inner loops' bodies — the nodes whose finishing ends one of this loop's batches.
    direct: HashMap<String, HashSet<String>>,
    owner: HashMap<String, String>,
    /// Indices into `spec.connections`.
    back: HashSet<usize>,
}

impl LoopPlan {
    fn new(spec: &FlowSpec, active: &HashSet<String>) -> Self {
        let mut plan = LoopPlan::default();
        let loops: Vec<&String> = spec.nodes.iter().filter(|n| n.type_id == LOOP_TYPE && active.contains(&n.id)).map(|n| &n.id).collect();
        for id in &loops {
            let mut body = HashSet::new();
            let mut queue: VecDeque<String> = spec.connections.iter().filter(|w| w.from == **id && w.out == 0).map(|w| w.to.clone()).collect();
            while let Some(next) = queue.pop_front() {
                if next == **id || !active.contains(&next) || !body.insert(next.clone()) {
                    continue;
                }
                queue.extend(spec.connections.iter().filter(|w| w.from == next).map(|w| w.to.clone()));
            }
            for (index, wire) in spec.connections.iter().enumerate() {
                if wire.to == **id && body.contains(&wire.from) {
                    plan.back.insert(index);
                }
            }
            plan.body.insert((*id).clone(), body);
        }
        for id in &loops {
            let mut direct = plan.body[*id].clone();
            for inner in &loops {
                if inner != id && plan.body[*id].contains(*inner) {
                    for member in &plan.body[*inner] {
                        direct.remove(member);
                    }
                }
            }
            for member in &direct {
                plan.owner.insert(member.clone(), (*id).clone());
            }
            plan.direct.insert((*id).clone(), direct);
        }
        plan
    }
}

/// A loop node part way through its list.
struct LoopRun {
    /// What is still to hand out, with each item's position in what the loop node was given.
    queue: VecDeque<(usize, Item)>,
    given: Vec<Item>,
    batch: usize,
    /// Batches handed out so far.
    emitted: u32,
    /// Body nodes still to finish before the batch counts as done.
    remaining: usize,
}

/// Delivers a finished node's output along its wires (only those of `port`, when given); returns
/// the nodes that became ready. A back wire's items go to the loop's results instead.
#[allow(clippy::too_many_arguments)]
fn deliver(
    spec: &FlowSpec,
    graph: &Graph,
    from: &str,
    outputs: &Ports,
    finished: &HashSet<String>,
    back: &HashSet<usize>,
    returned: &mut HashMap<String, Vec<Item>>,
    port: Option<u8>,
) -> Vec<String> {
    let mut now_ready = Vec::new();
    let mut slots = graph.slots.lock().expect("run state");
    for (index, wire) in spec.connections.iter().enumerate() {
        if wire.from != from || port.is_some_and(|only| wire.out != only) {
            continue;
        }
        if back.contains(&index) {
            if let Some(items) = outputs.get(wire.out as usize) {
                returned.entry(wire.to.clone()).or_default().extend(items.iter().map(|item| Item::new(item.json.clone())));
            }
            continue;
        }
        if finished.contains(&wire.to) {
            continue;
        }
        let Some(slot) = slots.get_mut(&wire.to) else { continue };
        let input = wire.input as usize;
        if input >= slot.inputs.len() {
            continue;
        }
        if let Some(items) = outputs.get(wire.out as usize) {
            for (position, item) in items.iter().enumerate() {
                slot.inputs[input].push(item.clone());
                slot.origins[input].push(Origin { node: from.to_string(), output: wire.out as u16, index: position as u32 });
            }
        }
        slot.pending = slot.pending.saturating_sub(1);
        if slot.pending == 0 {
            now_ready.push(wire.to.clone());
        }
    }
    now_ready
}

// ------------------------------------------------------------------------------------- one node

struct Finished {
    node_id: String,
    result: Result<Ports, NodeError>,
    attempts: u32,
    started: Instant,
    started_at: String,
    seq: u32,
    inputs: Arc<Ports>,
}

/// Runs one node with its settings applied: retries, a time limit per attempt, execute-once.
async fn run_with_settings(ctx: &mut NodeCtx, settings: &NodeSettings) -> (Result<Ports, NodeError>, u32) {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let token = ctx.run.cancel.child_token();
        ctx.cancel = token.clone();
        ctx.timeout = settings.timeout;
        let outcome = match settings.timeout {
            Some(limit) => {
                let work = nodes::execute(ctx);
                tokio::pin!(work);
                tokio::select! {
                    result = &mut work => result,
                    _ = tokio::time::sleep(limit) => {
                        token.cancel();
                        // Let the executor stop what it started before the attempt is called over.
                        let _ = tokio::time::timeout(Duration::from_secs(5), &mut work).await;
                        Err(NodeError::TimedOut(limit))
                    }
                }
            }
            None => nodes::execute(ctx).await,
        };
        match outcome {
            Err(error) if error != NodeError::Cancelled && settings.retry_on_fail && attempt < settings.max_tries => {
                if ctx.run.cancel.is_cancelled() {
                    return (Err(NodeError::Cancelled), attempt);
                }
                ctx.log(LogStream::Info, &format!("Attempt {attempt} failed: {error}. Trying again."));
                tokio::select! {
                    _ = tokio::time::sleep(settings.wait_between) => {}
                    _ = ctx.run.cancel.cancelled() => return (Err(NodeError::Cancelled), attempt),
                }
            }
            other => return (other, attempt),
        }
    }
}

/// The ports of a node that failed but carries on.
fn error_ports(node: &FlowNode, inputs: &Ports, message: &str, settings: &NodeSettings) -> Ports {
    let catalogue_outputs = output_count(node) as usize - usize::from(has_error_output(node));
    let mut ports: Ports = vec![Vec::new(); output_count(node) as usize];
    match settings.on_error {
        OnError::ErrorOutput if has_error_output(node) => {
            let routed = inputs
                .iter()
                .flatten()
                .enumerate()
                .map(|(index, item)| {
                    let mut json = if item.json.is_object() { item.json.clone() } else { json!({"value": item.json}) };
                    json["error"] = Value::String(message.to_string());
                    Item::paired(json, index)
                })
                .collect();
            ports[catalogue_outputs] = routed;
        }
        _ => {
            if let Some(first) = ports.first_mut() {
                first.push(Item::paired(json!({"error": message}), 0));
            }
        }
    }
    ports
}

// --------------------------------------------------------------------------------------- the run

/// Runs a plan to the end and says how it ended. Every node's report has gone to the host by the
/// time this returns.
pub async fn execute(spec: Arc<FlowSpec>, plan: Plan, run: Arc<RunContext>) -> RunOutcome {
    let names: HashMap<String, String> = spec.nodes.iter().map(|n| (n.id.clone(), n.name.clone())).collect();
    let by_name: HashMap<String, String> = spec.nodes.iter().map(|n| (n.name.clone(), n.id.clone())).collect();
    let graph = Arc::new(Graph { spec: spec.clone(), by_name, names, slots: Mutex::new(HashMap::new()) });

    let js = match ExprWorker::start(graph.clone(), &run.locale) {
        Ok(worker) => Arc::new(worker),
        Err(error) => {
            return RunOutcome { status: RunStatus::Error, error: Some(error), error_node: None, last_output: vec![] };
        }
    };

    // Slots for every node taking part, and how many deliveries each waits for.
    let participating: HashSet<&String> = plan.active.iter().chain(plan.seeds.keys()).collect();
    let loops = LoopPlan::new(&spec, &plan.active);
    // How many deliveries a node waits for: its wires from nodes taking part (from `among`, when
    // given), never a loop's back wires.
    let pending_of = |id: &str, among: Option<&HashSet<String>>| -> usize {
        spec.connections
            .iter()
            .enumerate()
            .filter(|(index, wire)| wire.to == id && participating.contains(&wire.from) && !loops.back.contains(index))
            .filter(|(_, wire)| among.is_none_or(|set| set.contains(&wire.from)))
            .count()
    };
    {
        let mut slots = graph.slots.lock().expect("fresh lock");
        for id in &plan.active {
            let Some(node) = graph.node(id) else { continue };
            let inputs = super::catalog::find(&node.type_id).map(|d| d.inputs as usize).unwrap_or(0).max(1);
            let pending = pending_of(id, None);
            slots.insert(id.clone(), Slot { inputs: vec![Vec::new(); inputs], origins: vec![Vec::new(); inputs], pending, outputs: None });
        }
    }

    let mut ready: VecDeque<String> = VecDeque::new();
    let mut seq: u32 = 0;
    let mut finished_nodes: HashSet<String> = HashSet::new();
    let mut loop_runs: HashMap<String, LoopRun> = HashMap::new();
    // What came back to each loop node through its back wires, all batches so far.
    let mut returned: HashMap<String, Vec<Item>> = HashMap::new();
    // Loop nodes whose batch just ended (or that just started), to hand out what comes next.
    let mut due_loops: VecDeque<String> = VecDeque::new();
    // The batch a node's report belongs to: its innermost loop's current one.
    let iteration_of = |id: &str, runs: &HashMap<String, LoopRun>| -> u32 {
        loops.owner.get(id).and_then(|owner| runs.get(owner)).map(|run| run.emitted.saturating_sub(1)).unwrap_or(0)
    };
    // A node finished: if it was the last of its loop's batch, that loop is due.
    let body_finished = |id: &str, runs: &mut HashMap<String, LoopRun>, due: &mut VecDeque<String>| {
        let Some(owner) = loops.owner.get(id) else { return };
        let Some(run) = runs.get_mut(owner) else { return };
        run.remaining = run.remaining.saturating_sub(1);
        if run.remaining == 0 {
            due.push_back(owner.clone());
        }
    };

    // Seeds first: pinned and reused output is known before anything runs.
    let mut seed_ids: Vec<&String> = plan.seeds.keys().collect();
    seed_ids.sort();
    for id in seed_ids {
        let (items, pinned) = &plan.seeds[id];
        let Some(node) = graph.node(id).cloned() else { continue };
        let outputs = Arc::new(items.clone());
        {
            let mut slots = graph.slots.lock().expect("run state");
            slots.entry(id.clone()).or_default().outputs = Some(outputs.clone());
        }
        finished_nodes.insert(id.clone());
        if plan.quiet.contains(id) {
            ready.extend(deliver(&spec, &graph, id, &outputs, &finished_nodes, &loops.back, &mut returned, None));
            continue;
        }
        let decided = plan.decided.as_deref() == Some(id.as_str());
        run.host.node_finished(
            &node,
            NodeReport {
                node_id: id.clone(),
                status: if decided {
                    NodeStatus::Success
                } else if *pinned {
                    NodeStatus::Pinned
                } else {
                    NodeStatus::Reused
                },
                seq,
                started_at: None,
                finished_at: None,
                duration_ms: None,
                attempts: 0,
                error: None,
                inputs: Arc::new(vec![]),
                origins: Arc::new(vec![]),
                outputs: outputs.clone(),
                iteration: 0,
            },
        );
        ready.extend(deliver(&spec, &graph, id, &outputs, &finished_nodes, &loops.back, &mut returned, None));
    }
    // The start: the trigger, or — in a step run — the target, ready once its seeds delivered.
    {
        let slots = graph.slots.lock().expect("run state");
        let mut starters: Vec<&String> = plan
            .active
            .iter()
            .filter(|id| !finished_nodes.contains(*id) && !ready.contains(*id))
            .filter(|id| slots.get(*id).is_some_and(|slot| slot.pending == 0))
            .collect();
        starters.sort();
        ready.extend(starters.into_iter().cloned());
    }

    let mut running: JoinSet<Finished> = JoinSet::new();
    let mut failure: Option<(String, String)> = None;
    let mut last_output: Option<Arc<Ports>> = None;

    // A trigger something outside fired: its output is what that event gave, not something it
    // computes — so it "runs" here, instantly, and the rest of the flow takes it from there.
    if let (Some(start), Some(given)) = (plan.trigger.clone(), plan.trigger_output.clone()) {
        if let Some(node) = graph.node(&start).cloned() {
            if let Some(position) = ready.iter().position(|id| *id == start) {
                ready.remove(position);
            }
            seq += 1;
            let at = now_text();
            run.host.node_started(&node, seq, 0, &at);
            let mut ports = given;
            ports.resize(output_count(&node).max(1) as usize, Vec::new());
            let outputs = Arc::new(ports);
            graph.slots.lock().expect("run state").get_mut(&start).expect("slot").outputs = Some(outputs.clone());
            finished_nodes.insert(start.clone());
            run.host.node_finished(
                &node,
                NodeReport {
                    node_id: start.clone(),
                    status: NodeStatus::Success,
                    seq,
                    started_at: Some(at.clone()),
                    finished_at: Some(now_text()),
                    duration_ms: Some(0),
                    attempts: 1,
                    error: None,
                    inputs: Arc::new(vec![]),
                    origins: Arc::new(vec![]),
                    outputs: outputs.clone(),
                    iteration: 0,
                },
            );
            last_output = Some(outputs.clone());
            ready.extend(deliver(&spec, &graph, &start, &outputs, &finished_nodes, &loops.back, &mut returned, None));
        }
    }

    loop {
        // Loops whose batch ended hand out the next one, or finish.
        while failure.is_none() && !run.cancel.is_cancelled() {
            let Some(loop_id) = due_loops.pop_front() else { break };
            let Some(node) = graph.node(&loop_id).cloned() else { continue };
            let Some(state) = loop_runs.get_mut(&loop_id) else { continue };
            if state.emitted >= MAX_BATCHES {
                failure.get_or_insert_with(|| (loop_id.clone(), format!("The loop handed out {MAX_BATCHES} batches and was stopped")));
                run.cancel.cancel();
                break;
            }
            seq += 1;
            let at = now_text();
            if !state.queue.is_empty() {
                let take = state.batch.min(state.queue.len());
                let batch: Vec<Item> = state.queue.drain(..take).map(|(position, item)| Item::paired(item.json, position)).collect();
                if state.emitted > 0 {
                    // The body runs again from scratch — and a loop inside it starts its list over.
                    let body = loops.body.get(&loop_id).cloned().unwrap_or_default();
                    let mut members = body.clone();
                    members.insert(loop_id.clone());
                    let mut slots = graph.slots.lock().expect("run state");
                    for member in &body {
                        finished_nodes.remove(member);
                        returned.remove(member);
                        if let Some(slot) = slots.get_mut(member) {
                            // Its inputs were taken when it ran: the port count comes from its type.
                            let inputs = graph.node(member).and_then(|n| super::catalog::find(&n.type_id)).map_or(1, |d| (d.inputs as usize).max(1));
                            *slot = Slot { inputs: vec![Vec::new(); inputs], origins: vec![Vec::new(); inputs], pending: pending_of(member, Some(&members)), outputs: None };
                        }
                    }
                    drop(slots);
                    for member in &body {
                        loop_runs.remove(member);
                    }
                }
                let state = loop_runs.get_mut(&loop_id).expect("still running");
                state.remaining = loops.direct.get(&loop_id).map_or(0, HashSet::len);
                state.emitted += 1;
                let iteration = state.emitted - 1;
                let empty_body = state.remaining == 0;
                let given = Arc::new(vec![batch.clone()]);
                let outputs = Arc::new(vec![batch, Vec::new()]);
                graph.slots.lock().expect("run state").get_mut(&loop_id).expect("slot").outputs = Some(outputs.clone());
                run.host.node_started(&node, seq, given[0].len(), &at);
                run.host.node_finished(
                    &node,
                    NodeReport {
                        node_id: loop_id.clone(),
                        status: NodeStatus::Running,
                        seq,
                        started_at: Some(at.clone()),
                        finished_at: None,
                        duration_ms: None,
                        attempts: 1,
                        error: None,
                        inputs: given,
                        origins: graph.origins(&loop_id),
                        outputs: outputs.clone(),
                        iteration,
                    },
                );
                ready.extend(deliver(&spec, &graph, &loop_id, &outputs, &finished_nodes, &loops.back, &mut returned, Some(0)));
                if empty_body {
                    due_loops.push_back(loop_id.clone());
                }
            } else {
                // The list is done: what came back, or — when nothing is wired back — what it was given.
                let done = match returned.remove(&loop_id) {
                    Some(items) => items,
                    None if loops.back.iter().any(|index| spec.connections[*index].to == loop_id) => Vec::new(),
                    None => state.given.iter().enumerate().map(|(position, item)| Item::paired(item.json.clone(), position)).collect(),
                };
                let iteration = state.emitted.saturating_sub(1);
                // Its input was reported batch by batch; the last report adds only what it hands on.
                let given = Arc::new(if state.emitted == 0 { vec![state.given.clone()] } else { vec![Vec::new()] });
                loop_runs.remove(&loop_id);
                let outputs = Arc::new(vec![Vec::new(), done]);
                graph.slots.lock().expect("run state").get_mut(&loop_id).expect("slot").outputs = Some(outputs.clone());
                finished_nodes.insert(loop_id.clone());
                run.host.node_finished(
                    &node,
                    NodeReport {
                        node_id: loop_id.clone(),
                        status: NodeStatus::Success,
                        seq,
                        started_at: Some(at.clone()),
                        finished_at: Some(now_text()),
                        duration_ms: Some(0),
                        attempts: 1,
                        error: None,
                        inputs: given,
                        origins: graph.origins(&loop_id),
                        outputs: outputs.clone(),
                        iteration,
                    },
                );
                last_output = Some(outputs.clone());
                ready.extend(deliver(&spec, &graph, &loop_id, &outputs, &finished_nodes, &loops.back, &mut returned, Some(1)));
                body_finished(&loop_id, &mut loop_runs, &mut due_loops);
            }
        }

        // Start whatever is ready, up to the limit.
        while running.len() < MAX_PARALLEL && failure.is_none() && !run.cancel.is_cancelled() {
            let Some(id) = ready.pop_front() else { break };
            if finished_nodes.contains(&id) {
                continue;
            }
            let Some(node) = graph.node(&id).cloned() else { continue };
            let (inputs, has_items) = {
                let mut slots = graph.slots.lock().expect("run state");
                let slot = slots.get_mut(&id).expect("active node has a slot");
                let inputs = std::mem::take(&mut slot.inputs);
                let has_items = inputs.iter().any(|port| !port.is_empty());
                (inputs, has_items)
            };
            let is_start = plan.trigger.as_deref() == Some(id.as_str());
            let empty_ports = || -> Arc<Ports> { Arc::new(vec![Vec::new(); output_count(&node) as usize]) };

            if !is_start && !has_items {
                // Nothing reached it: it does not run, and neither will what only it feeds.
                let outputs = empty_ports();
                graph.slots.lock().expect("run state").get_mut(&id).expect("slot").outputs = Some(outputs.clone());
                finished_nodes.insert(id.clone());
                run.host.node_finished(
                    &node,
                    NodeReport {
                        node_id: id.clone(),
                        status: NodeStatus::Skipped,
                        seq,
                        started_at: None,
                        finished_at: None,
                        duration_ms: None,
                        attempts: 0,
                        error: None,
                        inputs: Arc::new(inputs),
                        origins: graph.origins(&id),
                        outputs: outputs.clone(),
                        iteration: iteration_of(&id, &loop_runs),
                    },
                );
                ready.extend(deliver(&spec, &graph, &id, &outputs, &finished_nodes, &loops.back, &mut returned, None));
                body_finished(&id, &mut loop_runs, &mut due_loops);
                continue;
            }

            if node.type_id == LOOP_TYPE && !node.disabled {
                // A loop node is the engine's own: it takes its list and hands it out in batches.
                let given: Vec<Item> = inputs.into_iter().flatten().collect();
                let batch = node.params.get("batchSize").and_then(Value::as_f64).unwrap_or(10.0).clamp(1.0, 1_000_000.0) as usize;
                loop_runs.insert(id.clone(), LoopRun { queue: given.iter().cloned().enumerate().collect(), given, batch, emitted: 0, remaining: 0 });
                due_loops.push_back(id.clone());
                continue;
            }

            seq += 1;
            let settings = NodeSettings::read(&node.settings);
            let mut inputs = inputs;
            if settings.execute_once {
                let first = inputs.iter().flatten().next().cloned();
                inputs = vec![first.into_iter().collect()];
            }
            let inputs = Arc::new(inputs);
            let items_in = inputs.iter().map(Vec::len).sum();
            let started_at = now_text();
            run.host.node_started(&node, seq, items_in, &started_at);

            if node.disabled {
                // Switched off: the items go through untouched, out of the first output — a loop's
                // "done", so a switched-off loop skips its body rather than running it once.
                let mut ports: Ports = vec![Vec::new(); output_count(&node) as usize];
                let through = usize::from(node.type_id == LOOP_TYPE);
                if let Some(port) = ports.get_mut(through) {
                    *port = inputs.iter().flatten().enumerate().map(|(i, item)| Item::paired(item.json.clone(), i)).collect();
                }
                let outputs = Arc::new(ports);
                graph.slots.lock().expect("run state").get_mut(&id).expect("slot").outputs = Some(outputs.clone());
                finished_nodes.insert(id.clone());
                run.host.node_finished(
                    &node,
                    NodeReport {
                        node_id: id.clone(),
                        status: NodeStatus::Disabled,
                        seq,
                        started_at: Some(started_at.clone()),
                        finished_at: Some(now_text()),
                        duration_ms: Some(0),
                        attempts: 0,
                        error: None,
                        inputs: inputs.clone(),
                        origins: graph.origins(&id),
                        outputs: outputs.clone(),
                        iteration: iteration_of(&id, &loop_runs),
                    },
                );
                ready.extend(deliver(&spec, &graph, &id, &outputs, &finished_nodes, &loops.back, &mut returned, None));
                body_finished(&id, &mut loop_runs, &mut due_loops);
                continue;
            }

            let js = js.clone();
            let run_ctx = run.clone();
            let node_inputs = inputs.clone();
            running.spawn(async move {
                let started = Instant::now();
                let mut ctx = NodeCtx::new(node.clone(), (*node_inputs).clone(), js, run_ctx.clone(), run_ctx.cancel.child_token());
                let (result, attempts) = run_with_settings(&mut ctx, &settings).await;
                Finished { node_id: node.id.clone(), result, attempts, started, started_at, seq, inputs: node_inputs }
            });
        }

        if running.is_empty() {
            let stopped = failure.is_some() || run.cancel.is_cancelled();
            if stopped || (ready.is_empty() && due_loops.is_empty()) {
                break;
            }
            continue;
        }

        let Some(joined) = running.join_next().await else { break };
        let finished = match joined {
            Ok(finished) => finished,
            Err(error) => {
                // A node panicked. The run cannot say which outputs it would have had.
                failure.get_or_insert_with(|| (String::new(), format!("A node crashed: {error}")));
                run.cancel.cancel();
                continue;
            }
        };
        let Some(node) = graph.node(&finished.node_id).cloned() else { continue };
        let settings = NodeSettings::read(&node.settings);
        let duration = finished.started.elapsed().as_millis() as i64;
        let finished_at = now_text();
        let id = finished.node_id.clone();
        finished_nodes.insert(id.clone());

        let (status, error, outputs) = match finished.result {
            Ok(mut ports) => {
                // Ports the executor left out (a terminal node) or the error port it knows nothing of.
                ports.resize(output_count(&node) as usize, Vec::new());
                if settings.always_output && ports.iter().all(Vec::is_empty) {
                    if let Some(first) = ports.first_mut() {
                        first.push(Item::new(json!({})));
                    }
                }
                (NodeStatus::Success, None, Arc::new(ports))
            }
            Err(NodeError::Cancelled) => (NodeStatus::Canceled, None, Arc::new(vec![Vec::new(); output_count(&node) as usize])),
            Err(error) => {
                let message = error.to_string();
                if settings.on_error == OnError::Stop || run.cancel.is_cancelled() {
                    failure.get_or_insert_with(|| (id.clone(), message.clone()));
                    run.cancel.cancel();
                    (NodeStatus::Error, Some(message), Arc::new(vec![Vec::new(); output_count(&node) as usize]))
                } else {
                    let ports = error_ports(&node, &finished.inputs, &message, &settings);
                    (NodeStatus::Error, Some(message), Arc::new(ports))
                }
            }
        };
        graph.slots.lock().expect("run state").get_mut(&id).expect("slot").outputs = Some(outputs.clone());
        run.host.node_finished(
            &node,
            NodeReport {
                node_id: id.clone(),
                status,
                seq: finished.seq,
                started_at: Some(finished.started_at),
                finished_at: Some(finished_at),
                duration_ms: Some(duration),
                attempts: finished.attempts,
                error,
                inputs: finished.inputs,
                origins: graph.origins(&id),
                outputs: outputs.clone(),
                iteration: iteration_of(&id, &loop_runs),
            },
        );
        if status == NodeStatus::Success {
            last_output = Some(outputs.clone());
        }
        let carries_on = status == NodeStatus::Success || (status == NodeStatus::Error && settings.on_error != OnError::Stop);
        if carries_on && failure.is_none() && !run.cancel.is_cancelled() {
            ready.extend(deliver(&spec, &graph, &id, &outputs, &finished_nodes, &loops.back, &mut returned, None));
            body_finished(&id, &mut loop_runs, &mut due_loops);
        }
    }

    js.cancel();
    let last_output = last_output.and_then(|ports| ports.first().cloned()).unwrap_or_default();
    if let Some((node, message)) = failure {
        return RunOutcome {
            status: RunStatus::Error,
            error: Some(message),
            error_node: (!node.is_empty()).then_some(node),
            last_output,
        };
    }
    if run.cancel.is_cancelled() {
        return RunOutcome { status: RunStatus::Canceled, error: None, error_node: None, last_output };
    }
    RunOutcome { status: RunStatus::Success, error: None, error_node: None, last_output }
}

#[cfg(test)]
mod tests;
