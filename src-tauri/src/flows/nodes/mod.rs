//! What each node type does when it runs.
//!
//! Every executor has the same shape: it gets a [`NodeCtx`] — the node, its parameters with
//! defaults filled in, its input items per port, the run's JavaScript and a way to log — and returns
//! its output items per port, or a [`NodeError`]. Retries, time limits, "continue on error" and
//! "execute once" are the engine's business, applied around this call, so no executor repeats them.
//!
//! Parameters are resolved here, not by each executor: [`NodeCtx::resolve_each`] evaluates every
//! expression in a node's parameters once per input item (one JavaScript round trip for all of
//! them), and skips the trip altogether when nothing in the parameters is an expression.

mod ai;
mod app;
mod connector;
mod data;
mod files;
mod formats;
mod http;
mod integrations;
mod logic;
mod net;
mod notebook;
mod process;
mod remote;
mod transform;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::catalog::{self, Family};
use super::engine::{LogStream, RunContext};
use super::expr::{has_expression, ExprWorker, JsError};
use super::params;
use super::run::{Item, Ports};
use super::spec::FlowNode;

pub use process::shutdown as shutdown_processes;

/// A path as a node writes it — `~` for the home folder.
/// What a decided wait hands on — for a run picking up after a restart. See `logic::decided_ports`.
pub use logic::decided_ports;

pub fn expand_path(path: &str) -> std::path::PathBuf {
    files::expand(path)
}

/// How long one expression job may take. Expressions are meant to be one-liners; a Code node gets
/// its own, longer limit.
const EXPRESSION_TIMEOUT: Duration = Duration::from_secs(10);

/// A Code node with no time limit of its own.
const CODE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq)]
pub enum NodeError {
    Failed(String),
    Cancelled,
    TimedOut(Duration),
}

impl NodeError {
    pub fn failed(message: impl Into<String>) -> Self {
        NodeError::Failed(message.into())
    }
}

impl std::fmt::Display for NodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeError::Failed(message) => f.write_str(message),
            NodeError::Cancelled => f.write_str("Stopped"),
            NodeError::TimedOut(limit) => write!(f, "Timed out after {}", human_duration(*limit)),
        }
    }
}

fn human_duration(limit: Duration) -> String {
    let seconds = limit.as_secs_f64();
    if seconds < 1.0 {
        format!("{} ms", limit.as_millis())
    } else if seconds < 120.0 {
        format!("{} s", (seconds * 10.0).round() / 10.0)
    } else {
        format!("{} min", (seconds / 60.0 * 10.0).round() / 10.0)
    }
}

impl From<JsError> for NodeError {
    fn from(error: JsError) -> Self {
        match error {
            JsError::Cancelled => NodeError::Cancelled,
            JsError::Timeout => NodeError::Failed("JavaScript ran past its time limit".into()),
            other => NodeError::Failed(other.to_string()),
        }
    }
}

/// One node, about to run.
pub struct NodeCtx {
    pub node: FlowNode,
    /// The node's parameters with every missing one defaulted; expressions not yet evaluated.
    pub params: Value,
    pub inputs: Ports,
    pub js: Arc<ExprWorker>,
    pub run: Arc<RunContext>,
    /// Cancelled when the run stops or this attempt times out. Executors that wait on anything —
    /// a process, a request, a timer — wait on this too.
    pub cancel: CancellationToken,
    /// The attempt's own time limit, if the node has one — a Code node uses it as its deadline.
    pub timeout: Option<Duration>,
}

impl NodeCtx {
    pub fn new(node: FlowNode, inputs: Ports, js: Arc<ExprWorker>, run: Arc<RunContext>, cancel: CancellationToken) -> Self {
        let params = params::with_defaults(&node.type_id, &node.params);
        Self { node, params, inputs, js, run, cancel, timeout: None }
    }

    /// Every input item, all ports in order — the list `paired` indexes into.
    pub fn items(&self) -> Vec<&Item> {
        self.inputs.iter().flatten().collect()
    }

    fn items_json(&self) -> Vec<&Value> {
        self.inputs.iter().flatten().map(|item| &item.json).collect()
    }

    /// What every job tells the JavaScript about where it is running.
    fn js_context(&self) -> Value {
        json!({
            "node": self.node.name,
            "flow": {"id": self.run.flow_id, "name": self.run.flow_name, "active": false, "workspaceId": self.run.workspace_id},
            "execution": {"id": self.run.run_id, "mode": self.run.mode, "resumeUrl": self.run.host.resume_url()},
            "vars": self.run.vars,
            "timezone": self.run.timezone,
            "runIndex": 0,
        })
    }

    /// Runs one JavaScript job against this node's input.
    pub async fn js_job(&self, mut job: Value, timeout: Duration) -> Result<Value, NodeError> {
        if let Value::Object(map) = &mut job {
            map.insert("context".into(), self.js_context());
            map.insert("items".into(), json!(self.items_json()));
        }
        let run = self.js.run(&job, timeout);
        tokio::select! {
            result = run => result.map_err(NodeError::from),
            _ = self.cancel.cancelled() => Err(NodeError::Cancelled),
        }
    }

    /// The parameters evaluated for each input item — at least one entry, for a node that runs on
    /// nothing. Parameters the node type declares literal are left as they are.
    pub async fn resolve_each(&self) -> Result<Vec<Value>, NodeError> {
        let count = self.items().len().max(1);
        if !has_expression(&self.params) {
            return Ok(vec![self.params.clone(); count]);
        }
        let skip = params::literal_names(&self.node.type_id);
        let resolved = self
            .js_job(json!({"kind": "resolve", "params": self.params, "skip": skip}), EXPRESSION_TIMEOUT)
            .await?;
        match resolved {
            Value::Array(list) if !list.is_empty() => Ok(list),
            _ => Err(NodeError::failed("The expressions did not evaluate")),
        }
    }

    /// The parameters evaluated once, against the first input item.
    pub async fn resolve_once(&self) -> Result<Value, NodeError> {
        if !has_expression(&self.params) {
            return Ok(self.params.clone());
        }
        let skip = params::literal_names(&self.node.type_id);
        let resolved = self
            .js_job(json!({"kind": "resolve", "params": self.params, "skip": skip, "indices": [0]}), EXPRESSION_TIMEOUT)
            .await?;
        resolved.get(0).cloned().ok_or_else(|| NodeError::failed("The expressions did not evaluate"))
    }

    pub fn log(&self, stream: LogStream, text: &str) {
        self.run.host.log(&self.node.id, stream, text);
    }

    pub fn param_str(&self, name: &str) -> String {
        self.params.get(name).and_then(Value::as_str).unwrap_or_default().to_string()
    }

    /// Every input item passed straight through, paired to itself.
    pub fn passthrough(&self) -> Vec<Item> {
        self.items().into_iter().enumerate().map(|(index, item)| Item::paired(item.json.clone(), index)).collect()
    }
}

/// A string parameter out of a resolved parameter object.
pub fn text(params: &Value, name: &str) -> String {
    match params.get(name) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

pub fn flag(params: &Value, name: &str) -> bool {
    match params.get(name) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => matches!(text.trim(), "true" | "1" | "yes"),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => false,
    }
}

pub fn number(params: &Value, name: &str) -> Option<f64> {
    params.get(name).and_then(super::value::to_number)
}

/// `[{ name, value }]` as pairs, skipping rows with no name.
pub fn pairs(params: &Value, name: &str) -> Vec<(String, String)> {
    params
        .get(name)
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let key = text(row, "name").trim().to_string();
                    (!key.is_empty()).then(|| (key, text(row, "value")))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `["a", "b"]` as strings, skipping blanks.
pub fn strings(params: &Value, name: &str) -> Vec<String> {
    params
        .get(name)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(super::value::to_text)
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Runs one node. Ports in the result follow the catalogue (the error port is the engine's).
pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let Some(descriptor) = catalog::find(&ctx.node.type_id) else {
        return Err(NodeError::failed(format!("Unknown node type {}", ctx.node.type_id)));
    };
    if descriptor.family == Family::Trigger {
        return Ok(vec![trigger_output(&ctx.node.type_id)]);
    }
    if descriptor.milestone > catalog::RUNS_THROUGH {
        return Err(NodeError::failed(format!(
            "\"{}\" ({}) does not run yet — it arrives in milestone {}",
            ctx.node.name, ctx.node.type_id, descriptor.milestone
        )));
    }
    match ctx.node.type_id.as_str() {
        "code.shell" | "code.python" | "code.node" | "code.command" | "code.script" => process::execute(ctx).await,
        "code.js" => code(ctx).await,
        "net.http" => http::execute(ctx).await,
        "logic.if" | "logic.switch" | "logic.merge" | "logic.wait" | "logic.stop" | "logic.noop" | "logic.approval" => {
            logic::execute(ctx).await
        }
        "transform.set" | "transform.filter" | "transform.sort" | "transform.split" | "transform.aggregate"
        | "transform.dedupe" | "transform.date" | "transform.text" => transform::execute(ctx).await,
        "app.notify" | "data.state" | "data.vars" | "net.respond" | "code.service" => app::execute(ctx).await,
        "logic.subflow" => logic::subflow(ctx).await,
        "ai.agent" | "ai.local" | "ai.classify" | "ai.extract" | "ai.summarize" | "ai.review" | "ai.commit" | "app.agent" => {
            ai::execute(ctx).await
        }
        "files.file" | "files.list" | "files.move" | "files.git" | "code.docker" => files::execute(ctx).await,
        "transform.convert" | "transform.crypto" | "transform.compress" | "transform.compare" => formats::execute(ctx).await,
        "logic.ratelimit" => logic::ratelimit(ctx).await,
        "net.graphql" | "net.websocket" | "net.socketio" | "net.grpc" | "net.mqtt" | "net.sse" | "net.download" | "net.email" => {
            net::execute(ctx).await
        }
        "net.connector" => connector::execute(ctx).await,
        "code.notebook" => notebook::execute(ctx).await,
        "data.sql" | "data.mongo" | "data.redis" | "data.sheet" => data::execute(ctx).await,
        "code.ssh" | "net.transfer" | "net.storage" => remote::execute(ctx).await,
        "files.pr" | "files.pipeline" | "app.note" | "app.reviewer" | "app.open" | "app.terminal" | "app.clipboard" | "app.vault" => {
            integrations::execute(ctx).await
        }
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

/// What a trigger emits when a run is started by hand: one item, the way n8n's manual trigger does,
/// with the moment for the ones that are about time. A trigger that is pinned never gets here.
fn trigger_output(type_id: &str) -> Vec<Item> {
    let now = chrono::Utc::now();
    let json = match type_id {
        "trigger.schedule" => json!({
            "timestamp": now.to_rfc3339(),
            "manual": true,
        }),
        "trigger.manual" => json!({}),
        _ => json!({"manual": true}),
    };
    vec![Item::new(json)]
}

/// The Code node: JavaScript over the items, in the run's QuickJS.
async fn code(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mode = ctx.param_str("mode");
    let source = ctx.param_str("code");
    let limit = ctx.timeout.unwrap_or(CODE_TIMEOUT);
    let answer = ctx
        .js_job(json!({"kind": "code", "mode": if mode == "each" { "each" } else { "all" }, "code": source}), limit)
        .await?;
    for line in answer.get("logs").and_then(Value::as_array).into_iter().flatten() {
        let level = line.get("level").and_then(Value::as_str).unwrap_or("log");
        let stream = if matches!(level, "error" | "warn") { LogStream::Stderr } else { LogStream::Console };
        ctx.log(stream, &text(line, "text"));
    }
    let count = ctx.items().len();
    let items = answer
        .get("items")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|entry| Item {
                    json: entry.get("json").cloned().unwrap_or(Value::Null),
                    paired: entry
                        .get("paired")
                        .and_then(Value::as_u64)
                        .filter(|index| (*index as usize) < count.max(1))
                        .map(|index| index as u32),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(vec![items])
}
