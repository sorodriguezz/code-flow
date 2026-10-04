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

use super::expr::{ExprWorker, RunLookup};
use super::nodes::{self, NodeCtx, NodeError};
use super::run::{has_error_output, output_count, Item, NodeSettings, OnError, Origin, Plan, Ports};
use super::spec::{FlowNode, FlowSpec};

/// Nodes of one run executing at once. Branches are mostly waiting — on a process, the network, a
/// model — so this is about not starting forty processes at once, not about CPU.
const MAX_PARALLEL: usize = 8;

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
            let Some(origin) = slot.origins.iter().flatten().nth(position) else {
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
        let origin = slots.get(id)?.origins.iter().flatten().nth(index)?.clone();
        let name = self.names.get(&origin.node).cloned().unwrap_or_default();
        Some(json!({"name": name, "outputIndex": origin.output, "runIndex": 0}).to_string())
    }
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
    {
        let mut slots = graph.slots.lock().expect("fresh lock");
        for id in &plan.active {
            let Some(node) = graph.node(id) else { continue };
            let inputs = super::catalog::find(&node.type_id).map(|d| d.inputs as usize).unwrap_or(0).max(1);
            let pending = spec
                .connections
                .iter()
                .filter(|wire| wire.to == *id && participating.contains(&wire.from))
                .count();
            slots.insert(id.clone(), Slot { inputs: vec![Vec::new(); inputs], origins: vec![Vec::new(); inputs], pending, outputs: None });
        }
    }

    let mut ready: VecDeque<String> = VecDeque::new();
    let mut seq: u32 = 0;
    let mut finished_nodes: HashSet<String> = HashSet::new();

    // Delivers a finished node's output along its connections; returns the nodes that became ready.
    let deliver = |from: &str, outputs: &Arc<Ports>, graph: &Graph, finished: &HashSet<String>| -> Vec<String> {
        let mut now_ready = Vec::new();
        let mut slots = graph.slots.lock().expect("run state");
        for wire in spec.connections.iter().filter(|w| w.from == from) {
            if finished.contains(&wire.to) {
                continue;
            }
            let Some(slot) = slots.get_mut(&wire.to) else { continue };
            let port = wire.input as usize;
            if port >= slot.inputs.len() {
                continue;
            }
            if let Some(items) = outputs.get(wire.out as usize) {
                for (index, item) in items.iter().enumerate() {
                    slot.inputs[port].push(item.clone());
                    slot.origins[port].push(Origin { node: from.to_string(), output: wire.out as u16, index: index as u32 });
                }
            }
            slot.pending = slot.pending.saturating_sub(1);
            if slot.pending == 0 {
                now_ready.push(wire.to.clone());
            }
        }
        now_ready
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
        run.host.node_finished(
            &node,
            NodeReport {
                node_id: id.clone(),
                status: if *pinned { NodeStatus::Pinned } else { NodeStatus::Reused },
                seq,
                started_at: None,
                finished_at: None,
                duration_ms: None,
                attempts: 0,
                error: None,
                inputs: Arc::new(vec![]),
                origins: Arc::new(vec![]),
                outputs: outputs.clone(),
            },
        );
        ready.extend(deliver(id, &outputs, &graph, &finished_nodes));
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
                },
            );
            last_output = Some(outputs.clone());
            ready.extend(deliver(&start, &outputs, &graph, &finished_nodes));
        }
    }

    loop {
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
                    },
                );
                ready.extend(deliver(&id, &outputs, &graph, &finished_nodes));
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
                // Switched off: the items go through untouched, out of the first output.
                let mut ports: Ports = vec![Vec::new(); output_count(&node) as usize];
                if let Some(first) = ports.first_mut() {
                    *first = inputs.iter().flatten().enumerate().map(|(i, item)| Item::paired(item.json.clone(), i)).collect();
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
                    },
                );
                ready.extend(deliver(&id, &outputs, &graph, &finished_nodes));
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
            break;
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
            },
        );
        if status == NodeStatus::Success {
            last_output = Some(outputs.clone());
        }
        let carries_on = status == NodeStatus::Success || (status == NodeStatus::Error && settings.on_error != OnError::Stop);
        if carries_on && failure.is_none() && !run.cancel.is_cancelled() {
            ready.extend(deliver(&id, &outputs, &graph, &finished_nodes));
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
