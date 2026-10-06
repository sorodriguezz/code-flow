//! Runs inside the app: starting one, reporting it as it goes, keeping what it produced, and
//! letting old ones go.
//!
//! **Three places a run lives.** The rows (`flow_runs`, `flow_run_nodes`) are the index the
//! Executions view lists and the waterfall draws. The files under `paths::flow_runs_dir()/<run>` are
//! the data: `nodes/<node>.json.gz` per node (its input, where each input item came from, and its
//! output) and `log.jsonl`. The events (`flows:run`, `flows:node`, `flows:log`) are what the canvas
//! paints while it happens. A node's file is written before its row says it finished, so whoever
//! reacts to `flows:node` can already open its data.
//!
//! **Run isolation.** Every event carries `workspaceId` and `flowId`: the store files each one under
//! the flow it belongs to, whichever flow is on screen when it lands (see
//! [[codeflow-run-isolation]]'s capture-before-await rule — a run outlives the view that started it).
//!
//! **Retention** is the decision the plan records: 100 runs per flow, successes 14 days, failures 30,
//! and 2 GB for everything — applied after every run and at launch. A run still going is never
//! touched.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use super::engine::{self, Credential, LogStream, NodeReport, NodeStatus, RunContext, RunHost};
use super::expr::RunLookup;
use super::run::{self, Item, Origin, Ports, RunMode};
use super::spec::{self, FlowNode, FlowSpec};
use crate::db::flow_run_queries::{self as queries, FlowRunNodeRow, FlowRunRow};
use crate::db::{flow_queries, Db};

const KEEP_PER_FLOW: i64 = 100;
const SUCCESS_DAYS: i64 = 14;
const FAILURE_DAYS: i64 = 30;
const TOTAL_BYTES: i64 = 2 * 1024 * 1024 * 1024;

/// What a run's log keeps on disk; the live view gets every line regardless.
const LOG_FILE_LIMIT: u64 = 8 * 1024 * 1024;

/// How often buffered log lines are sent to the window.
const LOG_FLUSH: Duration = Duration::from_millis(150);

// ------------------------------------------------------------------------------------- registry

struct Active {
    cancel: CancellationToken,
    workspace_id: String,
    flow_id: String,
}

static ACTIVE: LazyLock<Mutex<HashMap<String, Active>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Stops a run. False when it is not running (any more).
pub fn cancel(run_id: &str) -> bool {
    let active = ACTIVE.lock().ok();
    match active.as_ref().and_then(|map| map.get(run_id)) {
        Some(run) => {
            run.cancel.cancel();
            true
        }
        None => false,
    }
}

/// The runs going on now, for a window that opened after they started.
pub fn active_ids(workspace_id: Option<&str>) -> Vec<(String, String)> {
    ACTIVE
        .lock()
        .map(|map| {
            map.iter()
                .filter(|(_, run)| workspace_id.is_none_or(|ws| run.workspace_id == ws))
                .map(|(id, run)| (id.clone(), run.flow_id.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// The quit path: every run is stopped, and given `grace` to say so before the processes they
/// started are ended directly. Blocking.
pub fn shutdown(grace: Duration) {
    super::waits::quitting();
    if let Ok(map) = ACTIVE.lock() {
        for run in map.values() {
            run.cancel.cancel();
        }
    }
    let deadline = std::time::Instant::now() + grace;
    while std::time::Instant::now() < deadline && ACTIVE.lock().map(|map| !map.is_empty()).unwrap_or(false) {
        std::thread::sleep(Duration::from_millis(25));
    }
    super::nodes::shutdown_processes(Duration::from_secs(2));
}

// ---------------------------------------------------------------------------------------- files

pub fn run_dir(run_id: &str) -> PathBuf {
    crate::paths::flow_runs_dir().join(run_id)
}

fn node_file(run_id: &str, node_id: &str) -> PathBuf {
    run_dir(run_id).join("nodes").join(format!("{node_id}.json.gz"))
}

/// One node's record in a run.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodeData {
    #[serde(default)]
    pub inputs: Ports,
    #[serde(default)]
    pub origins: Vec<Vec<Origin>>,
    #[serde(default)]
    pub outputs: Ports,
}

fn write_node_data(run_id: &str, node_id: &str, data: &NodeData) -> std::io::Result<u64> {
    let path = node_file(run_id, node_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::File::create(&path)?;
    let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
    serde_json::to_writer(&mut encoder, data)?;
    encoder.finish()?.sync_all()?;
    Ok(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
}

pub fn read_node_data(run_id: &str, node_id: &str) -> Option<NodeData> {
    let file = std::fs::File::open(node_file(run_id, node_id)).ok()?;
    let mut text = String::new();
    flate2::read::GzDecoder::new(file).read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => dir_size(&entry.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

fn remove_run_files(run_id: &str) {
    // A run id is a UUID this module minted; the check keeps a corrupt row from naming `..`.
    if uuid::Uuid::parse_str(run_id).is_ok() {
        drop_restore_points(run_id);
        let _ = std::fs::remove_dir_all(run_dir(run_id));
    }
}

// ------------------------------------------------------------------------------- restore points

/// The repositories a run's editing AI nodes took a restore point in, one path per line of JSON.
/// Kept beside the run, so the point lives exactly as long as the run that can undo it.
const RESTORE_FILE: &str = "restore.json";

/// Serialises the read-modify-write of [`RESTORE_FILE`]: two editing nodes of one run can finish at
/// the same moment.
static RESTORE_LOCK: Mutex<()> = Mutex::new(());

/// Where a run's editing nodes took restore points — `refs/codeflow/flows/<run>` in each.
pub fn restore_points(run_id: &str) -> Vec<String> {
    std::fs::read_to_string(run_dir(run_id).join(RESTORE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn record_restore_point(run_id: &str, path: &str) {
    let _guard = RESTORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut paths = restore_points(run_id);
    if paths.iter().any(|known| known == path) {
        return;
    }
    paths.push(path.to_string());
    let _ = std::fs::write(run_dir(run_id).join(RESTORE_FILE), serde_json::to_string(&paths).unwrap_or_default());
}

fn drop_restore_points(run_id: &str) {
    for path in restore_points(run_id) {
        crate::git::checkpoint::remove_flow_baseline(&path, run_id);
    }
}

/// What a run's editing nodes changed, per repository: the files and the diff against the restore
/// point.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEdits {
    pub path: String,
    pub files: Vec<String>,
    pub diff: String,
    /// The restore point is gone (the repository moved, or someone deleted the ref).
    pub missing: bool,
}

pub fn edits(run_id: &str) -> Vec<RunEdits> {
    restore_points(run_id)
        .into_iter()
        .map(|path| match crate::git::checkpoint::flow_changed_paths(&path, run_id) {
            Ok(files) => {
                let diff = crate::git::checkpoint::flow_diff(&path, run_id, 200_000).unwrap_or_default();
                RunEdits { path, files, diff, missing: false }
            }
            Err(_) => RunEdits { path, files: Vec::new(), diff: String::new(), missing: true },
        })
        .collect()
}

/// Puts every repository a run edited back as it was before the run's first editing node.
pub fn undo_edits(run_id: &str) -> Result<Vec<String>, String> {
    let mut touched = Vec::new();
    for path in restore_points(run_id) {
        for file in crate::git::checkpoint::restore_flow(&path, run_id)? {
            touched.push(format!("{}/{file}", path.trim_end_matches('/')));
        }
    }
    Ok(touched)
}

// --------------------------------------------------------------------------------------- events

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub node_id: String,
    pub stream: LogStream,
    pub text: String,
    pub ts: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NodeEvent {
    run_id: String,
    flow_id: String,
    workspace_id: String,
    node: FlowRunNodeRow,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    run_id: String,
    flow_id: String,
    workspace_id: String,
    lines: Vec<LogLine>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotifyEvent {
    run_id: String,
    flow_id: String,
    workspace_id: String,
    flow_name: String,
    title: String,
    body: String,
}

// ----------------------------------------------------------------------------------------- host

/// The largest index at most `at` that falls between two characters of `text`.
fn char_boundary(text: &str, at: usize) -> usize {
    let mut cut = at.min(text.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

pub(super) struct AppHost {
    pub(super) app: AppHandle,
    pub(super) run_id: String,
    pub(super) flow_id: String,
    pub(super) flow_name: String,
    pub(super) workspace_id: String,
    depth: u32,
    lines: Mutex<Vec<LogLine>>,
    log_bytes: AtomicU64,
    /// Secret values this run has read — its credentials, a Llavero item — kept out of everything it
    /// stores. The items passed between nodes keep the real value; the files and the log do not.
    secrets: Mutex<Vec<String>>,
    /// Nodes that reported more than once — inside a loop — with what their batches add up to.
    looped: Mutex<HashMap<String, Looped>>,
    /// The flow as this run executes it — written beside the run when it waits, so a restart can
    /// pick it up even if the flow was edited meanwhile.
    pub(super) spec: Arc<FlowSpec>,
}

/// A node inside a loop: its batches so far, kept whole so the inspector shows all of them.
#[derive(Default)]
struct Looped {
    /// `None` until a second batch arrives; the first one's data is read back from its file then.
    data: Option<NodeData>,
    items_in: i64,
    items_out: Vec<i64>,
    duration_ms: i64,
    /// The data has batches its file does not.
    dirty: bool,
    written: Option<Instant>,
    /// More than this many items on a port and later batches are only counted.
    full: bool,
}

/// Items per port a looped node's record keeps; the counts go on past it.
const LOOPED_ITEMS_KEPT: usize = 10_000;
/// A looped node's file is rewritten at most this often while its loop runs.
const LOOPED_WRITE_EVERY: Duration = Duration::from_secs(1);

/// What a redacted secret reads as.
const REDACTED_SECRET: &str = "••••••";

/// Every string in `value` with `secrets` replaced, at any depth.
fn redact_value(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => {
            if secrets.iter().any(|secret| text.contains(secret.as_str())) {
                *text = redact_text(text, secrets);
            }
        }
        Value::Array(list) => list.iter_mut().for_each(|entry| redact_value(entry, secrets)),
        Value::Object(map) => map.values_mut().for_each(|entry| redact_value(entry, secrets)),
        _ => {}
    }
}

fn redact_text(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), REDACTED_SECRET);
        }
    }
    out
}

impl AppHost {
    fn with_db<T>(&self, work: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let db = self.app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        work(&conn).map_err(|e| e.to_string())
    }

    fn row(&self, node: &FlowNode, status: NodeStatus, seq: u32) -> FlowRunNodeRow {
        FlowRunNodeRow {
            run_id: self.run_id.clone(),
            node_id: node.id.clone(),
            node_name: node.name.clone(),
            node_type: node.type_id.clone(),
            status: status.as_str().to_string(),
            started_at: None,
            finished_at: None,
            duration_ms: None,
            items_in: 0,
            items_out: vec![],
            attempts: 0,
            error: String::new(),
            seq: seq as i64,
        }
    }

    fn publish(&self, row: FlowRunNodeRow) {
        let _ = self.with_db(|conn| queries::upsert_run_node(conn, &row));
        let _ = self.app.emit(
            "flows:node",
            NodeEvent { run_id: self.run_id.clone(), flow_id: self.flow_id.clone(), workspace_id: self.workspace_id.clone(), node: row },
        );
    }

    /// Writes what loops added to their nodes' records since the last write.
    fn flush_looped(&self) {
        let Ok(mut looped) = self.looped.lock() else { return };
        for (node_id, entry) in looped.iter_mut() {
            if entry.dirty {
                if let Some(kept) = &entry.data {
                    let _ = write_node_data(&self.run_id, node_id, kept);
                }
                entry.dirty = false;
            }
        }
    }

    /// Sends the buffered log lines to the window and appends them to the run's log file.
    fn flush(&self) {
        let lines: Vec<LogLine> = match self.lines.lock() {
            Ok(mut buffer) if !buffer.is_empty() => std::mem::take(&mut *buffer),
            _ => return,
        };
        if self.log_bytes.load(Ordering::Relaxed) < LOG_FILE_LIMIT {
            if let Ok(mut file) =
                std::fs::OpenOptions::new().create(true).append(true).open(run_dir(&self.run_id).join("log.jsonl"))
            {
                let mut written = 0u64;
                for line in &lines {
                    if let Ok(text) = serde_json::to_string(line) {
                        if writeln!(file, "{text}").is_ok() {
                            written += text.len() as u64 + 1;
                        }
                    }
                }
                self.log_bytes.fetch_add(written, Ordering::Relaxed);
            }
        }
        let _ = self.app.emit(
            "flows:log",
            LogEvent { run_id: self.run_id.clone(), flow_id: self.flow_id.clone(), workspace_id: self.workspace_id.clone(), lines },
        );
    }
}

impl RunHost for AppHost {
    fn node_started(&self, node: &FlowNode, seq: u32, items_in: usize, started_at: &str) {
        let mut row = self.row(node, NodeStatus::Running, seq);
        row.started_at = Some(started_at.to_string());
        row.items_in = items_in as i64;
        self.publish(row);
    }

    fn node_finished(&self, node: &FlowNode, report: NodeReport) {
        let mut data = NodeData {
            inputs: (*report.inputs).clone(),
            origins: (*report.origins).clone(),
            outputs: (*report.outputs).clone(),
        };
        let secrets = self.secrets.lock().map(|list| list.clone()).unwrap_or_default();
        if !secrets.is_empty() {
            for item in data.inputs.iter_mut().chain(data.outputs.iter_mut()).flatten() {
                redact_value(&mut item.json, &secrets);
            }
        }
        let mut items_in = report.inputs.iter().map(Vec::len).sum::<usize>() as i64;
        let mut items_out: Vec<i64> = report.outputs.iter().map(|port| port.len() as i64).collect();
        let mut duration_ms = report.duration_ms;
        if report.iteration == 0 {
            if let Err(error) = write_node_data(&self.run_id, &report.node_id, &data) {
                self.log(&node.id, LogStream::Info, &format!("Could not keep this node's data: {error}"));
            }
            if let Ok(mut looped) = self.looped.lock() {
                looped.insert(
                    report.node_id.clone(),
                    Looped { items_in, items_out: items_out.clone(), duration_ms: duration_ms.unwrap_or(0), ..Looped::default() },
                );
            }
        } else if let Ok(mut looped) = self.looped.lock() {
            // A later batch of a loop: the record grows rather than being replaced.
            let entry = looped.entry(report.node_id.clone()).or_default();
            let kept = entry.data.get_or_insert_with(|| {
                let mut first = read_node_data(&self.run_id, &report.node_id).unwrap_or_default();
                // Batches are told apart by position only; links to a source's items do not survive.
                first.origins.clear();
                first
            });
            if !entry.full {
                for (port, items) in data.inputs.into_iter().enumerate() {
                    if kept.inputs.len() <= port {
                        kept.inputs.resize(port + 1, Vec::new());
                    }
                    kept.inputs[port].extend(items);
                }
                for (port, items) in data.outputs.into_iter().enumerate() {
                    if kept.outputs.len() <= port {
                        kept.outputs.resize(port + 1, Vec::new());
                    }
                    kept.outputs[port].extend(items);
                }
                if kept.inputs.iter().chain(kept.outputs.iter()).any(|port| port.len() > LOOPED_ITEMS_KEPT) {
                    entry.full = true;
                    self.log(&node.id, LogStream::Info, &format!("Only the first {LOOPED_ITEMS_KEPT} items of this node's batches are kept"));
                }
                entry.dirty = true;
            }
            entry.items_in += items_in;
            if entry.items_out.len() < items_out.len() {
                entry.items_out.resize(items_out.len(), 0);
            }
            for (port, count) in items_out.iter().enumerate() {
                entry.items_out[port] += count;
            }
            entry.duration_ms += duration_ms.unwrap_or(0);
            items_in = entry.items_in;
            items_out = entry.items_out.clone();
            duration_ms = Some(entry.duration_ms);
            if entry.dirty && entry.written.is_none_or(|at| at.elapsed() >= LOOPED_WRITE_EVERY) {
                if let Some(kept) = &entry.data {
                    let _ = write_node_data(&self.run_id, &report.node_id, kept);
                }
                entry.dirty = false;
                entry.written = Some(Instant::now());
            }
        }
        let mut row = self.row(node, report.status, report.seq);
        row.started_at = report.started_at;
        row.finished_at = report.finished_at;
        row.duration_ms = duration_ms;
        row.items_in = items_in;
        row.items_out = items_out;
        row.attempts = report.attempts as i64;
        row.error = report.error.unwrap_or_default();
        self.publish(row);
    }

    fn log(&self, node_id: &str, stream: LogStream, text: &str) {
        let secrets = self.secrets.lock().map(|list| list.clone()).unwrap_or_default();
        let redacted;
        let text = if secrets.iter().any(|secret| text.contains(secret.as_str())) {
            redacted = redact_text(text, &secrets);
            redacted.as_str()
        } else {
            text
        };
        let line = LogLine {
            node_id: node_id.to_string(),
            stream,
            // One line of the log is not the place for a megabyte of minified JSON.
            text: if text.len() > 8192 { format!("{}…", &text[..char_boundary(text, 8192)]) } else { text.to_string() },
            ts: chrono::Utc::now().timestamp_millis(),
        };
        if let Ok(mut buffer) = self.lines.lock() {
            if buffer.len() < 20_000 {
                buffer.push(line);
            }
        }
    }

    fn notify(&self, title: &str, body: &str) {
        let _ = self.app.emit(
            "flows:notify",
            NotifyEvent {
                run_id: self.run_id.clone(),
                flow_id: self.flow_id.clone(),
                workspace_id: self.workspace_id.clone(),
                flow_name: self.flow_name.clone(),
                title: title.to_string(),
                body: body.to_string(),
            },
        );
    }

    fn state_get(&self, key: &str) -> Result<Option<Value>, String> {
        self.with_db(|conn| queries::state_get(conn, &self.flow_id, key))
    }

    fn state_set(&self, key: &str, value: Option<&Value>) -> Result<(), String> {
        let now = engine::now_text();
        self.with_db(|conn| match value {
            Some(value) => queries::state_set(conn, &self.flow_id, key, value, &now),
            None => queries::state_delete(conn, &self.flow_id, key),
        })
    }

    fn var_get(&self, name: &str) -> Result<Option<String>, String> {
        self.with_db(|conn| queries::variables_map(conn, &self.workspace_id))
            .map(|map| map.get(name).and_then(Value::as_str).map(str::to_string))
    }

    fn var_set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        let now = engine::now_text();
        self.with_db(|conn| match value {
            Some(value) => queries::put_variable(conn, &self.workspace_id, name, value, &now).map(|_| ()),
            None => queries::delete_variable_named(conn, &self.workspace_id, name).map(|_| ()),
        })
    }

    fn credential(&self, id: &str) -> Result<Credential, String> {
        let row = self
            .with_db(|conn| queries::get_credential(conn, id))?
            .ok_or_else(|| "The credential this node uses no longer exists".to_string())?;
        if row.workspace_id != self.workspace_id && row.scope != "global" {
            return Err(format!("The credential \"{}\" belongs to another workspace", row.name));
        }
        let secret = crate::secrets::get_secret(&crate::secrets::flow_credential_key(id))?
            .ok_or_else(|| format!("The credential \"{}\" has no secret stored on this computer", row.name))?;
        if row.kind == "oauth2" {
            // The stored bundle is never sent whole; its client secret and refresh token could be.
            let tokens = super::oauth::Tokens::read(&secret);
            self.secret_used(&tokens.client_secret);
            self.secret_used(&tokens.refresh_token);
        } else {
            self.secret_used(&secret);
        }
        Ok(Credential { kind: row.kind, meta: row.meta, secret })
    }

    fn wait_for(&self, request: engine::WaitRequest, cancel: CancellationToken) -> engine::HostFuture<'_, Result<engine::WaitAnswer, String>> {
        super::waits::wait_for(self, request, cancel)
    }

    fn resume_url(&self) -> Option<String> {
        Some(super::triggers::webhook::resume_url(&self.run_id))
    }

    fn secret_used(&self, value: &str) {
        // Shorter than this, a "secret" would redact ordinary words out of every output.
        if value.chars().count() < 4 {
            return;
        }
        if let Ok(mut list) = self.secrets.lock() {
            if !list.iter().any(|known| known == value) {
                list.push(value.to_string());
                // Longest first, so a secret that contains another is replaced whole.
                list.sort_by_key(|known| std::cmp::Reverse(known.len()));
            }
        }
    }

    fn work_dir(&self) -> PathBuf {
        run_dir(&self.run_id).join("work")
    }

    fn subflow(&self, flow_id: &str, items: Vec<Item>, wait: bool) -> engine::HostFuture<'_, Result<Vec<Item>, String>> {
        let flow_id = flow_id.to_string();
        Box::pin(async move {
            let (target, workspace_ok) = {
                let db = self.app.state::<Db>();
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                let row = flow_queries::get_flow(&conn, &flow_id).map_err(|e| e.to_string())?.ok_or("The flow to run no longer exists")?;
                let ok = row.meta.workspace_id == self.workspace_id || row.meta.scope == "global";
                (row, ok)
            };
            if !workspace_ok {
                return Err(format!("\"{}\" belongs to another workspace", target.meta.name));
            }
            let parsed = spec::parse(&target.spec)?;
            let entry = parsed
                .nodes
                .iter()
                .find(|n| n.type_id == "trigger.subflow" && !n.disabled)
                .map(|n| n.id.clone())
                .ok_or_else(|| format!("\"{}\" has no \"called by another flow\" trigger", target.meta.name))?;
            let mut request = StartRequest::fired(&entry, items, RunOrigin::Subflow);
            request.depth = self.depth + 1;
            request.wait = wait;
            if request.depth > 5 {
                return Err("Flows calling flows stop five levels deep".into());
            }
            let (_, done) = start_with(&self.app, &flow_id, request)?;
            match done {
                Some(done) => {
                    let finished = done.await.map_err(|_| "The called flow ended without saying how".to_string())?;
                    if finished.status == "success" {
                        Ok(finished.last_output)
                    } else {
                        Err(format!(
                            "\"{}\" {}{}",
                            target.meta.name,
                            if finished.status == "canceled" { "was stopped" } else { "failed" },
                            if finished.error.is_empty() { String::new() } else { format!(": {}", finished.error) }
                        ))
                    }
                }
                None => Ok(vec![]),
            }
        })
    }

    fn service(&self, service_id: &str, action: &str, wait: bool, timeout: Duration) -> engine::HostFuture<'_, Result<Value, String>> {
        let service_id = service_id.to_string();
        let action = action.to_string();
        Box::pin(async move { super::services::act(&self.app, &self.workspace_id, &service_id, &action, wait, timeout).await })
    }

    fn ai(&self, call: engine::AiCall, cancel: CancellationToken) -> engine::HostFuture<'_, Result<engine::AiAnswer, String>> {
        Box::pin(super::ai_host::cli(self, call, cancel))
    }

    fn local_ai(&self, call: engine::LocalCall, cancel: CancellationToken) -> engine::HostFuture<'_, Result<engine::LocalAnswer, String>> {
        Box::pin(super::ai_host::local(self, call, cancel))
    }

    fn agent_task(&self, request: engine::AgentRequest, cancel: CancellationToken) -> engine::HostFuture<'_, Result<Value, String>> {
        Box::pin(super::ai_host::agent_task(self, request, cancel))
    }

    fn project_path(&self, project_id: &str) -> Result<String, String> {
        let project = self
            .with_db(|conn| crate::db::queries::get_project(conn, project_id))?
            .ok_or_else(|| format!("The repository {project_id} is no longer in CodeFlow"))?;
        Ok(project.local_path)
    }

    fn ai_template(&self, kind: &str) -> String {
        super::ai_host::template(self, kind)
    }

    fn quota(&self, engine: &engine::EngineChoice) -> Option<(f64, String)> {
        super::ai_host::quota(self, engine)
    }

    fn edits_recorded(&self, path: &str) {
        record_restore_point(&self.run_id, path);
    }

    fn db_connection(&self, connection_id: &str) -> Result<crate::datasource::DbConnectionConfig, String> {
        super::app_ops::db_connection(self, connection_id)
    }

    fn remote_host(&self, host_id: &str) -> Result<crate::remotes::RemoteHostSpec, String> {
        super::app_ops::remote_host(self, host_id)
    }

    fn app_call(&self, op: &str, args: Value, cancel: CancellationToken) -> engine::HostFuture<'_, Result<Value, String>> {
        let op = op.to_string();
        Box::pin(async move { super::app_ops::call(self, &op, args, cancel).await })
    }

    fn oauth_token(&self, id: &str, meta: &Value) -> engine::HostFuture<'_, Result<String, String>> {
        let (id, meta) = (id.to_string(), meta.clone());
        Box::pin(async move { super::oauth::access_token(&id, &meta).await })
    }
}

// ---------------------------------------------------------------------------------------- start

/// Pinned output per node, as stored: `[[json, …], …]` per port.
pub fn load_pins(conn: &rusqlite::Connection, flow_id: &str) -> rusqlite::Result<HashMap<String, Ports>> {
    let mut out = HashMap::new();
    for (node_id, text) in queries::list_pins(conn, flow_id)? {
        let Ok(ports) = serde_json::from_str::<Vec<Vec<Value>>>(&text) else { continue };
        out.insert(node_id, ports.into_iter().map(|port| port.into_iter().map(Item::new).collect()).collect());
    }
    Ok(out)
}

/// The app's language, for `toLocaleString` and Luxon's names in expressions.
fn locale(conn: &rusqlite::Connection) -> String {
    let stored = crate::db::queries::get_setting(conn, "app_language").ok().flatten();
    match stored.as_deref().map(str::trim) {
        Some("es") => "es".into(),
        Some("en") => "en-US".into(),
        _ => match tauri_plugin_os::locale() {
            Some(locale) if locale.to_ascii_lowercase().starts_with("es") => "es".into(),
            _ => "en-US".into(),
        },
    }
}

/// Where a run came from — what its row's `mode` says and whether pins stand in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOrigin {
    /// A button: the whole flow, up to a node, or a step. Pins stand in for their nodes.
    Manual,
    /// A trigger that fired on its own. Pins are ignored: this is the real thing.
    Trigger,
    /// Another flow's Execute flow node.
    Subflow,
    /// A flow's "when a flow fails" trigger, for another flow's failure.
    Error,
    /// A past run started again from the executions list — its trigger's input replayed, and,
    /// from where it failed, the nodes that had succeeded reused. Pins are ignored: what is being
    /// retried was a real run.
    Retry,
}

/// What a run ended with, for whoever is waiting on it.
#[derive(Debug, Clone)]
pub struct Finished {
    pub status: String,
    pub error: String,
    pub last_output: Vec<Item>,
}

/// Everything a run can be started with.
pub struct StartRequest {
    pub mode: RunMode,
    pub trigger: Option<String>,
    /// What an outside event gave the trigger — `None` lets a trigger make its own item.
    pub trigger_items: Option<Vec<Item>>,
    /// What the run's form was filled with, when its manual trigger has one (`flows::form`).
    pub form_input: Option<Value>,
    pub origin: RunOrigin,
    pub respond: Option<tokio::sync::oneshot::Sender<engine::Reply>>,
    pub depth: u32,
    /// Hand back a receiver for the run's end.
    pub wait: bool,
    /// Outputs known from an earlier run, by node id — seeded instead of executed when the node is
    /// in the plan. A retry from where a run failed.
    pub reuse: HashMap<String, Ports>,
}

impl StartRequest {
    pub fn manual(mode: RunMode, trigger: Option<String>) -> Self {
        Self { mode, trigger, trigger_items: None, form_input: None, origin: RunOrigin::Manual, respond: None, depth: 0, wait: false, reuse: HashMap::new() }
    }

    pub fn fired(trigger: &str, items: Vec<Item>, origin: RunOrigin) -> Self {
        Self {
            mode: RunMode::Full,
            trigger: Some(trigger.to_string()),
            trigger_items: Some(items),
            form_input: None,
            origin,
            respond: None,
            depth: 0,
            wait: false,
            reuse: HashMap::new(),
        }
    }
}

/// Starts a past run again — the flow as it is now, from the trigger the run started at, with the
/// input it had then. `from_failed` also reuses what every node that succeeded produced, so only the
/// failed node and what follows it run again: the retry for a webhook whose request cannot be sent
/// twice, or an expensive step that does not need repeating.
///
/// A node inside a loop's body is never reused: its output is one batch's, and the loop would read
/// it as the whole.
pub fn retry(app: &AppHandle, run_id: &str, from_failed: bool) -> Result<FlowRunRow, String> {
    let db = app.state::<Db>();
    let (row, nodes, parsed) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let row = queries::get_run(&conn, run_id).map_err(|e| e.to_string())?.ok_or("This run is no longer on record")?;
        let nodes = queries::run_nodes(&conn, run_id).map_err(|e| e.to_string())?;
        let flow = flow_queries::get_flow(&conn, &row.flow_id).map_err(|e| e.to_string())?.ok_or("This flow no longer exists")?;
        (row, nodes, spec::parse(&flow.spec)?)
    };
    if row.trigger_node.is_empty() {
        return Err("This run started from a step, not a trigger: there is no input to replay".into());
    }
    if !parsed.nodes.iter().any(|n| n.id == row.trigger_node && !n.disabled) {
        return Err("The trigger this run started from is no longer in the flow, or is disabled".into());
    }
    let input = read_node_data(run_id, &row.trigger_node)
        .and_then(|data| data.outputs.into_iter().next())
        .ok_or("The run's input is no longer on record")?;
    let mut request = StartRequest::fired(&row.trigger_node, input, RunOrigin::Retry);
    if from_failed {
        let in_loops: HashSet<String> = parsed
            .nodes
            .iter()
            .filter(|n| n.type_id == crate::flows::catalog::LOOP_TYPE)
            .flat_map(|n| run::downstream(&parsed, &n.id))
            .collect();
        let current: HashSet<&str> = parsed.nodes.iter().map(|n| n.id.as_str()).collect();
        for node in nodes.iter().filter(|n| n.status == "success" || n.status == "reused") {
            if node.node_id == row.trigger_node || in_loops.contains(&node.node_id) || !current.contains(node.node_id.as_str()) {
                continue;
            }
            if let Some(data) = read_node_data(run_id, &node.node_id) {
                request.reuse.insert(node.node_id.clone(), data.outputs);
            }
        }
    }
    start_with(app, &row.flow_id, request).map(|(row, _)| row)
}

/// AI calls a flow may make in an hour, from its settings — 60 when it never said, `0` for no cap.
/// A runaway loop over a thousand items should stop at the cap, not at the end of the plan.
pub fn ai_per_hour(spec: &FlowSpec) -> u32 {
    match spec.settings.get("aiPerHour") {
        Some(Value::Number(n)) => n.as_u64().map_or(DEFAULT_AI_PER_HOUR, |n| n.min(10_000) as u32),
        _ => DEFAULT_AI_PER_HOUR,
    }
}

pub const DEFAULT_AI_PER_HOUR: u32 = 60;

/// When a flow's runs end in a notification: never, when they fail, or always. Read from the flow's
/// settings for the runs nobody is watching; a run started by hand answers to the window instead.
pub(super) fn notify_setting(spec: &FlowSpec, origin: RunOrigin) -> Option<String> {
    if origin == RunOrigin::Manual || origin == RunOrigin::Retry {
        return None;
    }
    let chosen = spec.settings.get("notifyOn").and_then(Value::as_str).unwrap_or("failure");
    Some(match chosen {
        "never" | "always" => chosen.to_string(),
        _ => "failure".to_string(),
    })
}

/// The form a run of `flow_id` in `mode` asks for: the fields of the manual trigger its plan starts
/// from — `None` when that trigger has none, is pinned, or is not a manual trigger.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunForm {
    pub trigger_id: String,
    pub trigger_name: String,
    pub fields: Vec<crate::flows::form::FormField>,
}

pub fn run_form(app: &AppHandle, flow_id: &str, mode: &RunMode, trigger: Option<&str>) -> Result<Option<RunForm>, String> {
    let db = app.state::<Db>();
    let (parsed, pins) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let flow = flow_queries::get_flow(&conn, flow_id).map_err(|e| e.to_string())?.ok_or("This flow no longer exists")?;
        (spec::parse(&flow.spec)?, load_pins(&conn, flow_id).map_err(|e| e.to_string())?)
    };
    let plan = match run::plan(&parsed, mode, trigger, &pins, &HashMap::new()) {
        Ok(plan) => plan,
        // A step with nothing to read from runs up to its node instead — so does its form.
        Err(code) if code == "needs-upstream" => {
            let node = mode.target().unwrap_or_default().to_string();
            run::plan(&parsed, &RunMode::UpTo { node }, trigger, &pins, &HashMap::new())?
        }
        Err(_) => return Ok(None),
    };
    let Some(start) = plan.trigger.as_deref().and_then(|id| parsed.nodes.iter().find(|n| n.id == id)) else { return Ok(None) };
    if start.type_id != "trigger.manual" || pins.contains_key(&start.id) {
        return Ok(None);
    }
    let fields = crate::flows::form::fields_of(&start.params);
    Ok((!fields.is_empty()).then(|| RunForm { trigger_id: start.id.clone(), trigger_name: start.name.clone(), fields }))
}

/// Starts a run of `flow_id` by hand. Returns as soon as it is under way; the rest arrives as events.
pub fn start(app: &AppHandle, flow_id: &str, mode: RunMode, trigger: Option<String>, input: Option<Value>) -> Result<FlowRunRow, String> {
    let mut request = StartRequest::manual(mode, trigger);
    request.form_input = input;
    start_with(app, flow_id, request).map(|(row, _)| row)
}

/// Starts a run of `flow_id`, however it was asked for.
pub fn start_with(
    app: &AppHandle,
    flow_id: &str,
    request: StartRequest,
) -> Result<(FlowRunRow, Option<tokio::sync::oneshot::Receiver<Finished>>), String> {
    let StartRequest { mode, trigger, trigger_items, form_input, origin, respond, depth, wait, reuse } = request;
    let db = app.state::<Db>();
    let (flow, parsed, pins, vars, locale, previous, mode) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let flow = flow_queries::get_flow(&conn, flow_id).map_err(|e| e.to_string())?.ok_or("This flow no longer exists")?;
        // Nothing runs what the user has not trusted — by hand, from a trigger, or called by another flow.
        if !flow.meta.trusted {
            return Err("untrusted".into());
        }
        let parsed = spec::parse(&flow.spec)?;
        // «No correr con batería»: a heavy flow waits for the cable — unless a person asked for it.
        if !matches!(origin, RunOrigin::Manual | RunOrigin::Retry)
            && parsed.settings.get("skipOnBattery").and_then(Value::as_bool) == Some(true)
            && crate::power::status().is_some_and(|power| !power.plugged_in)
        {
            return Err("on-battery: this flow is set not to run on battery".into());
        }
        // Pins are for designing: a run something else started is the real thing.
        let pins = if origin == RunOrigin::Manual { load_pins(&conn, flow_id).map_err(|e| e.to_string())? } else { HashMap::new() };
        let vars = queries::variables_map(&conn, &flow.meta.workspace_id).map_err(|e| e.to_string())?;
        // A step reads its parents' output from the newest run that has all of it.
        let mut previous = HashMap::new();
        if let RunMode::Step { node } = &mode {
            let parents = run::parents_of(&parsed, node);
            let missing: Vec<String> = parents.iter().filter(|p| !pins.contains_key(*p)).cloned().collect();
            if let Some(source) = queries::latest_run_covering(&conn, flow_id, &missing).map_err(|e| e.to_string())? {
                for parent in &missing {
                    if let Some(data) = read_node_data(&source, parent) {
                        previous.insert(parent.clone(), data.outputs);
                    }
                }
            }
        }
        (flow, parsed, pins, vars, locale(&conn), previous, mode)
    };
    let parsed = Arc::new(parsed);
    let (mut plan, mode) = match run::plan(&parsed, &mode, trigger.as_deref(), &pins, &previous) {
        Ok(plan) => (plan, mode),
        // Nothing to read a step's input from: run what leads to it instead.
        Err(code) if code == "needs-upstream" => {
            let node = mode.target().unwrap_or_default().to_string();
            let wider = RunMode::UpTo { node };
            (run::plan(&parsed, &wider, trigger.as_deref(), &pins, &previous)?, wider)
        }
        Err(error) => return Err(error),
    };
    // What an earlier run already produced, standing in for the nodes that produced it.
    for (id, outputs) in reuse {
        if plan.active.contains(&id) && !plan.seeds.contains_key(&id) {
            plan.seeds.insert(id, (outputs, false));
        }
    }
    if let Some(items) = trigger_items {
        plan.trigger_output = Some(vec![items]);
    } else if let Some(input) = form_input {
        // The form's answers are the manual trigger's item — typed against its fields here.
        if let Some(start) = plan.trigger.as_deref().and_then(|id| parsed.nodes.iter().find(|n| n.id == id)) {
            if start.type_id == "trigger.manual" && !pins.contains_key(&start.id) {
                let item = crate::flows::form::coerce(&crate::flows::form::fields_of(&start.params), &input)?;
                plan.trigger_output = Some(vec![vec![Item::new(item)]]);
            }
        }
    }
    let label = match origin {
        RunOrigin::Manual => mode.label(),
        RunOrigin::Trigger => "trigger",
        RunOrigin::Subflow => "subflow",
        RunOrigin::Error => "error",
        RunOrigin::Retry => "retry",
    };

    let run_id = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(run_dir(&run_id).join("work")).map_err(|e| format!("Could not prepare the run's folder: {e}"))?;
    let row = FlowRunRow {
        id: run_id.clone(),
        flow_id: flow.meta.id.clone(),
        workspace_id: flow.meta.workspace_id.clone(),
        flow_name: flow.meta.name.clone(),
        flow_version: flow.meta.version,
        mode: label.to_string(),
        trigger_node: plan.trigger.clone().unwrap_or_default(),
        target_node: mode.target().unwrap_or_default().to_string(),
        status: "running".into(),
        error: String::new(),
        error_node: String::new(),
        started_at: engine::now_text(),
        finished_at: None,
        duration_ms: None,
        data_bytes: 0,
        notify: notify_setting(&parsed, origin),
    };
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::insert_run(&conn, &row).map_err(|e| e.to_string())?;
    }
    let done_rx = launch(app, Launch { row: row.clone(), parsed, plan, vars, locale, label: label.to_string(), origin, respond, depth, wait });
    Ok((row, done_rx))
}

/// A run ready to execute: its row (new, or picked up after waiting) and everything it carries.
pub(super) struct Launch {
    pub row: FlowRunRow,
    pub parsed: Arc<FlowSpec>,
    pub plan: run::Plan,
    pub vars: serde_json::Map<String, Value>,
    pub locale: String,
    pub label: String,
    pub origin: RunOrigin,
    pub respond: Option<tokio::sync::oneshot::Sender<engine::Reply>>,
    pub depth: u32,
    pub wait: bool,
}

/// Executes a run in the background and records how it ends; hands back a receiver for its end when
/// `wait` asked for one.
pub(super) fn launch(app: &AppHandle, launch: Launch) -> Option<tokio::sync::oneshot::Receiver<Finished>> {
    let Launch { row, parsed, plan, vars, locale, label, origin, respond, depth, wait } = launch;
    let run_id = row.id.clone();
    let cancel = CancellationToken::new();
    if let Ok(mut active) = ACTIVE.lock() {
        active.insert(
            run_id.clone(),
            Active { cancel: cancel.clone(), workspace_id: row.workspace_id.clone(), flow_id: row.flow_id.clone() },
        );
    }
    let _ = app.emit("flows:run", row.clone());

    let host = Arc::new(AppHost {
        app: app.clone(),
        run_id: run_id.clone(),
        flow_id: row.flow_id.clone(),
        flow_name: row.flow_name.clone(),
        workspace_id: row.workspace_id.clone(),
        depth,
        lines: Mutex::new(Vec::new()),
        log_bytes: AtomicU64::new(0),
        secrets: Mutex::new(Vec::new()),
        looped: Mutex::new(HashMap::new()),
        spec: parsed.clone(),
    });
    let timezone = parsed
        .settings
        .get("timezone")
        .and_then(Value::as_str)
        .filter(|zone| !zone.trim().is_empty())
        .map(str::to_string)
        .or_else(|| Some(super::expr::system_zone()));
    let context = Arc::new(RunContext {
        run_id: run_id.clone(),
        flow_id: row.flow_id.clone(),
        flow_name: row.flow_name.clone(),
        workspace_id: row.workspace_id.clone(),
        mode: label.clone(),
        vars,
        timezone,
        locale,
        host: host.clone(),
        cancel: cancel.clone(),
        respond: Mutex::new(respond),
        depth,
        ai_per_hour: ai_per_hour(&parsed),
    });

    let (done_tx, done_rx) = if wait {
        let (tx, rx) = tokio::sync::oneshot::channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let app = app.clone();
    let started = row.clone();
    tauri::async_runtime::spawn(async move {
        let flusher = {
            let host = host.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(LOG_FLUSH).await;
                    host.flush();
                }
            })
        };
        let outcome = engine::execute(parsed, plan, context).await;
        flusher.abort();
        host.flush();
        host.flush_looped();
        // Quitting while it waited: the run is not over — its row stays `waiting` for the next launch.
        if super::waits::parked_by_quit(&app, &started.id) {
            if let Ok(mut active) = ACTIVE.lock() {
                active.remove(&started.id);
            }
            return;
        }

        let finished_at = engine::now_text();
        let duration = chrono::DateTime::parse_from_rfc3339(&started.started_at)
            .map(|start| (chrono::Utc::now() - start.with_timezone(&chrono::Utc)).num_milliseconds())
            .unwrap_or(0);
        let bytes = dir_size(&run_dir(&started.id)) as i64;
        let _ = std::fs::remove_dir_all(run_dir(&started.id).join("work"));
        let mut row = started.clone();
        row.status = outcome.status.as_str().to_string();
        row.error = outcome.error.clone().unwrap_or_default();
        row.error_node = outcome.error_node.clone().unwrap_or_default();
        row.finished_at = Some(finished_at.clone());
        row.duration_ms = Some(duration);
        row.data_bytes = bytes;
        if let Ok(conn) = app.state::<Db>().0.lock() {
            let _ = queries::finish_run(&conn, &row.id, &row.status, &row.error, &row.error_node, &finished_at, duration, bytes);
        }
        if let Ok(mut active) = ACTIVE.lock() {
            active.remove(&row.id);
        }
        let _ = app.emit("flows:run", row.clone());
        if let Some(tx) = done_tx {
            let _ = tx.send(Finished { status: row.status.clone(), error: row.error.clone(), last_output: outcome.last_output.clone() });
        }
        super::triggers::run_finished(&app, &row, origin);
        let pruner = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(conn) = pruner.state::<Db>().0.lock() {
                prune(&conn);
            }
        })
        .await;
    });
    done_rx
}

/// The origin a stored run's `mode` stands for — for a run picked up after it waited.
pub(super) fn origin_of(mode: &str) -> RunOrigin {
    match mode {
        "trigger" => RunOrigin::Trigger,
        "subflow" => RunOrigin::Subflow,
        "error" => RunOrigin::Error,
        "retry" => RunOrigin::Retry,
        _ => RunOrigin::Manual,
    }
}

/// The workspace variables and the language a run picked up after waiting starts again with.
pub(super) fn run_environment(app: &AppHandle, workspace_id: &str) -> Result<(serde_json::Map<String, Value>, String), String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let vars = queries::variables_map(&conn, workspace_id).map_err(|e| e.to_string())?;
    Ok((vars, locale(&conn)))
}

// ------------------------------------------------------------------------------------ retention

/// Applies the retention policy; returns how many runs went.
pub fn prune(conn: &rusqlite::Connection) -> usize {
    let now = chrono::Utc::now();
    let success_before = (now - chrono::Duration::days(SUCCESS_DAYS)).to_rfc3339();
    let failure_before = (now - chrono::Duration::days(FAILURE_DAYS)).to_rfc3339();
    let mut doomed: Vec<String> = Vec::new();
    for flow in queries::flows_with_runs(conn).unwrap_or_default() {
        doomed.extend(queries::runs_past_retention(conn, &flow, KEEP_PER_FLOW, &success_before, &failure_before).unwrap_or_default());
    }
    doomed.extend(queries::orphan_runs(conn).unwrap_or_default());
    doomed.sort();
    doomed.dedup();
    // Then the size cap, oldest first, counting what is left.
    let mut total: i64 = 0;
    let by_age = queries::runs_by_age(conn).unwrap_or_default();
    let kept: Vec<&(String, i64)> = by_age.iter().filter(|(id, _)| !doomed.contains(id)).collect();
    for (_, bytes) in &kept {
        total += bytes;
    }
    for (id, bytes) in kept {
        if total <= TOTAL_BYTES {
            break;
        }
        doomed.push(id.clone());
        total -= bytes;
    }
    for id in &doomed {
        let _ = queries::delete_run(conn, id);
        remove_run_files(id);
    }
    doomed.len()
}

/// At launch: a run the last session left `running` was interrupted by it ending; folders with no
/// row are deleted; retention runs once.
pub fn recover(conn: &rusqlite::Connection) {
    let _ = queries::mark_interrupted(conn, &engine::now_text());
    if let Ok(entries) = std::fs::read_dir(crate::paths::flow_runs_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if uuid::Uuid::parse_str(&name).is_ok() && matches!(queries::get_run(conn, &name), Ok(None)) {
                drop_restore_points(&name);
                let _ = std::fs::remove_dir_all(entry.path());
            } else if uuid::Uuid::parse_str(&name).is_ok() {
                // Scratch folders of runs that ended with the app.
                let _ = std::fs::remove_dir_all(entry.path().join("work"));
            }
        }
    }
    prune(conn);
}

/// Deletes one run and its files.
pub fn delete(conn: &rusqlite::Connection, run_id: &str) -> rusqlite::Result<()> {
    queries::delete_run(conn, run_id)?;
    remove_run_files(run_id);
    Ok(())
}

/// Removes the files of runs whose rows are already gone (a deleted flow's).
pub fn forget_files(run_ids: &[String]) {
    for id in run_ids {
        remove_run_files(id);
    }
}

/// A run's log, oldest line first, up to `limit` lines.
pub fn read_log(run_id: &str, limit: usize) -> Vec<Value> {
    let Ok(file) = std::fs::File::open(run_dir(run_id).join("log.jsonl")) else { return vec![] };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .take(limit)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect()
}

// ------------------------------------------------------------------------- reading a past run

/// A node's data as the inspector shows it: JSON per port, cut to `limit` items per port.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDataView {
    pub inputs: Vec<Vec<Value>>,
    pub outputs: Vec<Vec<Value>>,
    pub input_counts: Vec<usize>,
    pub output_counts: Vec<usize>,
}

pub fn node_data_view(run_id: &str, node_id: &str, limit: usize) -> Option<NodeDataView> {
    let data = read_node_data(run_id, node_id)?;
    let cut = |ports: &Ports| -> Vec<Vec<Value>> {
        ports.iter().map(|port| port.iter().take(limit).map(|item| item.json.clone()).collect()).collect()
    };
    Some(NodeDataView {
        inputs: cut(&data.inputs),
        outputs: cut(&data.outputs),
        input_counts: data.inputs.iter().map(Vec::len).collect(),
        output_counts: data.outputs.iter().map(Vec::len).collect(),
    })
}

/// `$('Nodo')` over a run that has finished, read from its files — what the inspector's expression
/// preview evaluates against.
pub struct StoredRun {
    run_id: String,
    spec: Arc<FlowSpec>,
    cache: Mutex<HashMap<String, Option<NodeData>>>,
    /// The node being previewed, whose input may be put together from its parents rather than read.
    current: Option<(String, NodeData)>,
}

impl StoredRun {
    pub fn new(run_id: &str, spec: Arc<FlowSpec>) -> Self {
        Self { run_id: run_id.to_string(), spec, cache: Mutex::new(HashMap::new()), current: None }
    }

    fn id_of(&self, name: &str) -> Option<String> {
        self.spec.nodes.iter().find(|n| n.name == name).map(|n| n.id.clone())
    }

    fn name_of(&self, id: &str) -> String {
        self.spec.nodes.iter().find(|n| n.id == id).map(|n| n.name.clone()).unwrap_or_default()
    }

    fn data(&self, id: &str) -> Option<NodeData> {
        if let Some((current, data)) = &self.current {
            if current == id {
                return Some(data.clone());
            }
        }
        let mut cache = self.cache.lock().ok()?;
        cache.entry(id.to_string()).or_insert_with(|| read_node_data(&self.run_id, id)).clone()
    }

    /// The input `node` had in this run — or, if it did not run, the one its parents' output makes.
    pub fn input_of(&mut self, node: &str) -> NodeData {
        if let Some(data) = read_node_data(&self.run_id, node).filter(|d| !d.inputs.iter().all(Vec::is_empty)) {
            self.current = Some((node.to_string(), data.clone()));
            return data;
        }
        let inputs = self
            .spec
            .nodes
            .iter()
            .find(|n| n.id == node)
            .and_then(|n| super::catalog::find(&n.type_id))
            .map(|d| d.inputs as usize)
            .unwrap_or(1)
            .max(1);
        let mut data = NodeData { inputs: vec![Vec::new(); inputs], origins: vec![Vec::new(); inputs], outputs: vec![] };
        for wire in self.spec.connections.iter().filter(|w| w.to == node) {
            let port = wire.input as usize;
            if port >= inputs {
                continue;
            }
            if let Some(parent) = self.data(&wire.from) {
                if let Some(items) = parent.outputs.get(wire.out as usize) {
                    for (index, item) in items.iter().enumerate() {
                        data.inputs[port].push(item.clone());
                        data.origins[port].push(Origin { node: wire.from.clone(), output: wire.out as u16, index: index as u32 });
                    }
                }
            }
        }
        self.current = Some((node.to_string(), data.clone()));
        data
    }
}

impl RunLookup for StoredRun {
    fn node_output(&self, name: &str) -> Option<String> {
        let id = self.id_of(name)?;
        Some(match self.data(&id) {
            Some(data) if !data.outputs.is_empty() => {
                let ports: Vec<Vec<&Value>> = data.outputs.iter().map(|port| port.iter().map(|item| &item.json).collect()).collect();
                json!({"executed": true, "outputs": ports}).to_string()
            }
            _ => json!({"executed": false, "outputs": []}).to_string(),
        })
    }

    fn paired_item(&self, target: &str, node: &str, index: usize) -> String {
        let fail = |message: &str| json!({"error": message}).to_string();
        let Some(mut current) = self.id_of(node) else { return fail("Unknown node") };
        let mut position = index;
        for _ in 0..10_000 {
            let Some(data) = self.data(&current) else { break };
            let Some(origin) = data.origins.iter().flatten().nth(position).cloned() else { break };
            let Some(source) = self.data(&origin.node) else { break };
            let Some(item) = source.outputs.get(origin.output as usize).and_then(|port| port.get(origin.index as usize)) else { break };
            if self.name_of(&origin.node) == target {
                return json!({"json": item.json}).to_string();
            }
            match item.paired {
                Some(paired) => {
                    current = origin.node;
                    position = paired as usize;
                }
                None => break,
            }
        }
        fail(&format!("No item from \"{target}\" leads to this one in the last run"))
    }

    fn origin(&self, node: &str, index: usize) -> Option<String> {
        let id = self.id_of(node)?;
        let data = self.data(&id)?;
        let origin = data.origins.iter().flatten().nth(index)?.clone();
        Some(json!({"name": self.name_of(&origin.node), "outputIndex": origin.output, "runIndex": 0}).to_string())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn secrets_are_redacted_at_any_depth_longest_first() {
        let secrets = vec!["s3cret-token-long".to_string(), "s3cret".to_string()];
        let mut value = json!({
            "headers": {"authorization": "Bearer s3cret-token-long"},
            "list": ["a s3cret b", 7, null],
            "plain": "nothing here",
        });
        redact_value(&mut value, &secrets);
        assert_eq!(
            value,
            json!({"headers": {"authorization": "Bearer ••••••"}, "list": ["a •••••• b", 7, null], "plain": "nothing here"})
        );
        assert_eq!(redact_text("token=s3cret&x=1", &secrets), "token=••••••&x=1");
    }
}
