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

#[macro_export]
#[doc(hidden)]
/// `work`'s value, or — when a model call failed on this item and the node goes on after errors — the
/// item recorded as failed and the next one taken. A cancellation, and every failure of a node set to
/// stop, still ends the node.
macro_rules! or_next {
    ($ctx:expr, $index:expr, $failed:expr, $work:expr) => {
        match $work {
            Ok(value) => value,
            Err(error) if error != NodeError::Cancelled && $crate::flows::nodes::carry_on($ctx) => {
                $failed.push($crate::flows::nodes::failed_item($ctx, $index, &error));
                continue;
            }
            Err(error) => return Err(error),
        }
    };
}

pub(crate) mod ai;
mod app;
pub(crate) mod binary;
mod browser;
pub(crate) mod connector;
mod containers;
pub(crate) mod data;
mod database;
pub(crate) mod devtools;
pub(crate) mod docs;
pub(crate) mod feed;
mod files;
pub(crate) mod formats;
mod google;
mod http;
mod imap;
mod integrations;
mod knowhow;
mod llm;
mod logic;
mod media;
mod microsoft;
mod net;
mod notebook;
mod process;
pub(crate) use process::{missing_programs, MissingProgram};
mod prs;
pub(crate) mod queue;
pub(crate) mod redact;
mod remote;
mod table;
mod textkit;
mod tools;
mod transcribe;
mod transform;
pub(crate) mod utils;
mod vision;
pub(crate) mod web;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::catalog::{self, Family};
use super::engine::{Credential, LogStream, RunContext};
use super::expr::{has_expression, ExprWorker, JsError};
use super::params;
use super::run::{Item, NodeSettings, OnError, Ports};
use super::spec::FlowNode;

pub use process::shutdown as shutdown_processes;

/// A path as a node writes it — `~` for the home folder.
/// What a decided wait hands on — for a run picking up after a restart. See `logic::decided_ports`.
pub use logic::decided_ports;

pub use llm::list_models;

pub fn expand_path(path: &str) -> std::path::PathBuf {
    files::expand(path)
}

// ------------------------------------------------------------------------------- one item failing

/// Whether the node is set to go on after an error (`continue` or `errorOutput`) rather than stop the run.
pub(crate) fn carry_on(ctx: &NodeCtx) -> bool {
    NodeSettings::read(&ctx.node.settings).on_error != OnError::Stop
}

/// An item whose model call failed, as the node hands it on: what it came in with, and what went wrong.
pub(crate) fn failed_item(ctx: &NodeCtx, index: usize, error: &NodeError) -> Item {
    let mut json = match ctx.items().get(index) {
        Some(item) if item.json.is_object() => item.json.clone(),
        Some(item) => json!({ "value": item.json }),
        None => json!({}),
    };
    json["error"] = json!(error.to_string());
    Item::paired(json, index)
}

/// The ports a per-item node answers with, once its failed items are known. With the node set to
/// «send errors to their own output» they go there; with «continue» they travel with the rest, on
/// `home`, each carrying its `error`. Either way the answers the other items got are kept — one item the
/// model could not answer no longer takes the whole batch with it.
pub(crate) fn with_failures(ctx: &NodeCtx, mut ports: Ports, failed: Vec<Item>, home: usize) -> Ports {
    if failed.is_empty() {
        return ports;
    }
    ctx.log(LogStream::Stderr, &format!("{} item(s) could not be answered and went on with an `error`", failed.len()));
    let wanted = crate::flows::run::output_count(&ctx.node) as usize;
    if ports.len() < wanted {
        ports.resize(wanted, Vec::new());
    }
    if crate::flows::run::has_error_output(&ctx.node) && wanted > 0 {
        ports[wanted - 1].extend(failed);
    } else if let Some(port) = ports.get_mut(home) {
        port.extend(failed);
    }
    ports
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

/// How a run treats what the flow remembers between runs — see [`NodeCtx::memory_use`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryUse {
    /// Reads it, and adds what it sees once the run ends well.
    Keep,
    /// Reads it, leaves it as it was.
    Read,
    /// Starts from nothing and leaves it as it was.
    Ignore,
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
    /// How many items have had their effect so far — a message sent, a record written. Kept across
    /// attempts: see [`NodeCtx::mark_sent`].
    sent: std::sync::atomic::AtomicUsize,
    /// What the attempts of this node have been answered, by the position each question had — see
    /// [`NodeCtx::recall`].
    memo: std::sync::Mutex<Memo>,
}

/// The answers one attempt got and the previous attempt's, side by side.
#[derive(Default)]
struct Memo {
    previous: Vec<Option<(u64, Box<dyn std::any::Any + Send>)>>,
    current: Vec<Option<(u64, Box<dyn std::any::Any + Send>)>>,
    cursor: usize,
}

impl NodeCtx {
    pub fn new(node: FlowNode, inputs: Ports, js: Arc<ExprWorker>, run: Arc<RunContext>, cancel: CancellationToken) -> Self {
        let params = params::with_defaults(&node.type_id, &node.params);
        Self { node, params, inputs, js, run, cancel, timeout: None, sent: std::sync::atomic::AtomicUsize::new(0), memo: Default::default() }
    }

    /// Starts an attempt: what the last one kept is what this one may reuse.
    pub fn begin_attempt(&self) {
        if let Ok(mut memo) = self.memo.lock() {
            memo.previous = std::mem::take(&mut memo.current);
            memo.cursor = 0;
        }
    }

    /// For a node that asks for something costly one item after another (a model, an API that bills): the
    /// answer the *previous attempt* got to the same question at the same position, so a retry after a
    /// failure at item 61 asks for item 61 and what follows — not for the sixty it already paid for.
    /// Returns the question's position, to hand to [`NodeCtx::keep`] when it is answered, and the earlier
    /// answer if there is one. `key` identifies the question; a different one at that position is no match.
    pub fn recall<T: Clone + 'static>(&self, key: u64) -> (usize, Option<T>)
    where
        T: Send,
    {
        let Ok(mut memo) = self.memo.lock() else { return (usize::MAX, None) };
        let position = memo.cursor;
        memo.cursor += 1;
        let found = memo
            .previous
            .get(position)
            .and_then(|slot| slot.as_ref())
            .filter(|(earlier, _)| *earlier == key)
            .and_then(|(_, value)| value.downcast_ref::<T>())
            .cloned();
        if let Some(value) = &found {
            if memo.current.len() <= position {
                memo.current.resize_with(position + 1, || None);
            }
            memo.current[position] = Some((key, Box::new(value.clone())));
        }
        (position, found)
    }

    /// Keeps an answer for the next attempt — see [`NodeCtx::recall`].
    pub fn keep<T: Send + 'static>(&self, position: usize, key: u64, value: T) {
        if position == usize::MAX {
            return;
        }
        if let Ok(mut memo) = self.memo.lock() {
            if memo.current.len() <= position {
                memo.current.resize_with(position + 1, || None);
            }
            memo.current[position] = Some((key, Box::new(value)));
        }
    }

    /// Says an item's effect has happened: its message went out, its record was written. A node that
    /// then fails on a later item is not tried again by the retry setting — a retry starts from the first
    /// item, and what was already sent would be sent twice (a second charge, a second SMS).
    pub fn mark_sent(&self) {
        self.sent.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// How many items have had their effect — see [`NodeCtx::mark_sent`].
    pub fn sent_count(&self) -> usize {
        self.sent.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// What a node that remembers between runs (a dedupe across runs, «only what changed») does with its memory
    /// in this one. A run somebody started to look at the flow must not use up what the real runs will be
    /// asked about: a test that records «seen» makes the first real event look like a repeat.
    pub fn memory_use(&self) -> MemoryUse {
        match self.run.mode.as_str() {
            "trigger" | "subflow" | "error" => MemoryUse::Keep,
            // Replaying a run, or a test: the events are the ones the memory already saw, and nothing is learnt.
            "retry" | "test" => MemoryUse::Ignore,
            // manual, partial, step: shows what a real run would do now, and leaves the memory as it was.
            _ => MemoryUse::Read,
        }
    }

    /// A credential as a node sends it: an `oauth2` one comes back as a `bearer` holding a fresh
    /// access token, so every node that signs with a bearer token takes it as it is.
    pub async fn credential(&self, id: &str) -> Result<Credential, NodeError> {
        let credential = self.run.host.credential(id).map_err(NodeError::Failed)?;
        if credential.kind != "oauth2" {
            return Ok(credential);
        }
        let token = tokio::select! {
            token = self.run.host.oauth_token(id, &credential.meta) => token.map_err(NodeError::Failed)?,
            _ = self.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        self.run.host.secret_used(&token);
        Ok(Credential { kind: "bearer".into(), meta: credential.meta, secret: token })
    }

    /// The credential again after a service refused its access token (a 401): an `oauth2` one with a renewed token, so the
    /// call can be made once more. `None` for every other kind — a pasted token that is refused stays refused.
    pub async fn renewed_credential(&self, id: &str, refused: &str) -> Result<Option<Credential>, NodeError> {
        let credential = self.run.host.credential(id).map_err(NodeError::Failed)?;
        if credential.kind != "oauth2" {
            return Ok(None);
        }
        let token = tokio::select! {
            token = self.run.host.oauth_token_renewed(id, &credential.meta, refused) => token.map_err(NodeError::Failed)?,
            _ = self.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        if token == refused {
            return Ok(None);
        }
        self.run.host.secret_used(&token);
        Ok(Some(Credential { kind: "bearer".into(), meta: credential.meta, secret: token }))
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
            "execution": {
                "id": self.run.run_id,
                "mode": self.run.mode,
                "resumeUrl": self.run.host.resume_url(),
                // A waiting form's page (`Esperar → un formulario`), through the tunnel when one is up.
                "resumeFormUrl": self.run.host.resume_url().map(|url| crate::flows::triggers::webhook::public_or_local(&url.replacen("/resume/", "/form/", 1))),
            },
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

/// A program's arguments, as written: not trimmed and not stripped of blanks — `sed -i '' s/a/b/ f` needs
/// its empty argument, `awk -F ' '` its space — except the empty rows at the end, an unfinished row in
/// the editor and not an argument.
pub fn arguments(params: &Value, name: &str) -> Vec<String> {
    let mut list: Vec<String> = params.get(name).and_then(Value::as_array).map(|list| list.iter().map(super::value::to_text).collect()).unwrap_or_default();
    while list.last().is_some_and(String::is_empty) {
        list.pop();
    }
    list
}

/// Runs one node. Ports in the result follow the catalogue (the error port is the engine's).
pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let Some(descriptor) = catalog::find(&ctx.node.type_id) else {
        return Err(NodeError::failed(format!("Unknown node type {}", ctx.node.type_id)));
    };
    if descriptor.family == Family::Trigger {
        return Ok(vec![trigger_output(&ctx.node.type_id, &ctx.node.params).map_err(NodeError::Failed)?]);
    }
    if descriptor.milestone > catalog::RUNS_THROUGH {
        return Err(NodeError::failed(format!(
            "\"{}\" ({}) does not run yet — it arrives in milestone {}",
            ctx.node.name, ctx.node.type_id, descriptor.milestone
        )));
    }
    match ctx.node.type_id.as_str() {
        "code.shell" | "code.python" | "code.node" | "code.command" | "code.script" | "code.osascript" => process::execute(ctx).await,
        "code.js" => code(ctx).await,
        "net.http" => http::execute(ctx).await,
        "logic.if" | "logic.switch" | "logic.merge" | "logic.wait" | "logic.stop" | "logic.noop" | "logic.approval" | "logic.businessHours"
        | "logic.assert" => {
            logic::execute(ctx).await
        }
        "transform.set" | "transform.filter" | "transform.sort" | "transform.split" | "transform.aggregate"
        | "transform.dedupe" | "transform.date" | "transform.text" => transform::execute(ctx).await,
        "app.notify" | "data.state" | "data.vars" | "net.respond" | "code.service" => app::execute(ctx).await,
        "logic.subflow" => logic::subflow(ctx).await,
        "ai.agent" | "ai.local" | "ai.classify" | "ai.extract" | "ai.summarize" | "ai.review" | "ai.prReview" | "ai.prFix" | "ai.prReply"
        | "ai.chat" | "ai.commit" | "app.agent" | "ai.vision" | "ai.guard" | "ai.transform" | "ai.compare" | "ai.image" | "ai.speech" => {
            ai::execute(ctx).await
        }
        "files.file" | "files.list" | "files.move" | "files.git" | "code.docker" => files::execute(ctx).await,
        "transform.convert" | "transform.crypto" | "transform.compress" | "transform.compare" => formats::execute(ctx).await,
        "logic.ratelimit" => logic::ratelimit(ctx).await,
        "net.graphql" | "net.websocket" | "net.socketio" | "net.grpc" | "net.mqtt" | "net.sse" | "net.download" | "net.email" => {
            net::execute(ctx).await
        }
        "net.connector" => connector::execute(ctx).await,
        "code.container" | "code.k8s" => containers::execute(ctx).await,
        "files.version" | "app.search" | "app.audit" | "app.process" => devtools::execute(ctx).await,
        "app.codemap" | "app.knowledge" | "app.memory" | "app.terminalOutput" | "app.ui" => knowhow::execute(ctx).await,
        "files.media" | "files.docx" | "files.ics" | "files.markdown" => docs::execute(ctx).await,
        "net.search" | "net.soap" | "net.aws" | "net.wol" => web::execute(ctx).await,
        "net.browser" => browser::execute(ctx).await,
        "transform.chatFormat" | "transform.number" | "transform.validate" | "transform.limit" | "data.fake" => textkit::execute(ctx).await,
        "net.google" => google::execute(ctx).await,
        "net.microsoft" => microsoft::execute(ctx).await,
        "ai.transcribe" => transcribe::execute(ctx).await,
        "transform.redact" => redact::execute(ctx).await,
        "net.imap" => imap::execute(ctx).await,
        "net.queue" => queue::execute(ctx).await,
        "net.feed" => feed::execute(ctx).await,
        "ai.api" | "ai.embed" | "ai.vectors" => llm::execute(ctx).await,
        "app.prList" | "app.prDecide" | "app.prComments" | "app.prMemory" => prs::execute(ctx).await,
        "net.webPage" | "net.check" | "logic.until" | "transform.changes" | "transform.template" | "transform.json" | "transform.sql" => {
            utils::execute(ctx).await
        }
        "files.pdf" | "files.image" => media::execute(ctx).await,
        "code.notebook" => notebook::execute(ctx).await,
        "data.sql" | "data.mongo" | "data.redis" | "data.sheet" | "data.dbml" | "data.schemaDiff" => data::execute(ctx).await,
        "data.table" => table::execute(ctx).await,
        "data.database" => database::execute(ctx).await,
        "code.ssh" | "net.transfer" | "net.storage" => remote::execute(ctx).await,
        "files.pr" | "files.pipeline" | "app.note" | "app.reviewer" | "app.open" | "app.terminal" | "app.clipboard" | "app.say" | "app.vault"
        | "app.apiRequest" | "app.apiCollection" | "app.diagram" | "app.story" | "app.aiUsage" | "app.runData" => {
            integrations::execute(ctx).await
        }
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

/// What a trigger emits when a run is started by hand: one item, the way n8n's manual trigger does,
/// with the moment for the ones that are about time. A trigger that is pinned never gets here.
///
/// A manual trigger with a form gives its fields' defaults here — the run was started from somewhere
/// that did not ask (`flows::form`); the form's own answers arrive as the trigger's items instead.
fn trigger_output(type_id: &str, params: &Value) -> Result<Vec<Item>, String> {
    let now = chrono::Utc::now();
    let json = match type_id {
        "trigger.schedule" => json!({
            "timestamp": now.to_rfc3339(),
            "manual": true,
        }),
        "trigger.manual" => crate::flows::form::defaults(&crate::flows::form::fields_of(params))?,
        // The rest: an item of the shape the trigger really emits, so what follows can be built
        // against it — a form's or a declared input's defaults, an event like the ones it waits for.
        // A sample, not the defaults: a required field with none would stop every step tried after
        // the trigger. A run started by hand asks the form instead (`runs::run_form`).
        "trigger.form" | "trigger.subflow" | "trigger.tool" => {
            let mut item = crate::flows::form::sample(&crate::flows::form::fields_of(params));
            if let Some(map) = item.as_object_mut() {
                map.insert("manual".into(), json!(true));
            }
            item
        }
        "trigger.chat" => json!({"message": "Hola", "history": [], "conversationId": "", "at": now.to_rfc3339(), "manual": true}),
        "trigger.clipboard" => json!({"text": "https://example.com", "kind": "url", "length": 19, "groups": [], "at": now.to_rfc3339(), "manual": true}),
        "trigger.context" => {
            let place = params.get("contextPlaces").and_then(Value::as_array).and_then(|p| p.first()).and_then(Value::as_str).unwrap_or("placeFile");
            json!({"place": place.trim_start_matches("place").to_lowercase(), "path": "", "relativePath": "", "repoPath": "", "at": now.to_rfc3339(), "manual": true})
        }
        "trigger.container" => json!({"event": "die", "container": "api", "id": "", "image": "", "exitCode": 1, "composeProject": "", "composeService": "", "engine": text(params, "engineKind"), "at": now.to_rfc3339(), "manual": true}),
        "trigger.k8s" => json!({"event": "podCrashLoop", "kind": "pod", "namespace": text(params, "namespace"), "name": "api-0", "reason": "CrashLoopBackOff", "restarts": 3, "context": text(params, "kubeContext"), "at": now.to_rfc3339(), "manual": true}),
        "trigger.logLine" => json!({"line": "ERROR example", "groups": [], "context": [], "source": text(params, "logPath"), "suppressedBefore": 0, "at": now.to_rfc3339(), "manual": true}),
        "trigger.package" => json!({"registry": text(params, "registry"), "package": text(params, "packageName"), "version": "", "previous": "", "url": "", "manual": true}),
        "trigger.flowDone" => json!({"flow": {"id": "", "name": ""}, "execution": {"id": "", "status": "success", "error": "", "customData": {}}, "output": [], "manual": true}),
        "trigger.connector" => json!({"_change": "new", "manual": true}),
        _ => json!({"manual": true}),
    };
    Ok(vec![Item::new(json)])
}

/// The Code node: JavaScript over the items, in the run's QuickJS.
async fn code(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mode = ctx.param_str("mode");
    let source = ctx.param_str("code");
    run_code(ctx, if mode == "each" { "each" } else { "all" }, &source).await
}

/// JavaScript run the Code node's way — `all` once over every item, `each` once per item — with its
/// console lines in the log.
pub(crate) async fn run_code(ctx: &NodeCtx, mode: &str, source: &str) -> Result<Ports, NodeError> {
    let limit = ctx.timeout.unwrap_or(CODE_TIMEOUT);
    let answer = ctx.js_job(json!({"kind": "code", "mode": mode, "code": source}), limit).await?;
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
