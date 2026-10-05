//! Triggers that fire on their own: what makes an *active* flow run without anyone pressing Run.
//!
//! **Arming.** A flow switched to active has each of its enabled automatic triggers *armed*: a
//! schedule gets a loop that sleeps until its next occurrence, a webhook a route on the local
//! server, a folder a watcher, a repository / pull requests / pipelines a poller, a hotkey a
//! system-wide chord. Arming is all or nothing — a trigger that cannot be armed (a cron expression
//! that does not parse, a port somebody else holds, a chord another app owns) keeps the flow from
//! being switched on, with the reason, instead of leaving half of it listening. A save of an active
//! flow re-arms it, so what runs is always what is on the canvas.
//!
//! **While CodeFlow is open.** The confirmed decision: flows run while the app is open or in the
//! tray, and "open at login" covers restarts. Everything here is torn down with the process; the
//! next launch arms the active flows again at startup.
//!
//! **Overlap.** A trigger that fires while the same flow is still running follows the flow's
//! `overlap` setting: *skip* (the default — a 15-minute job that takes 20 must not stack up), *queue*
//! (one waiting run, the newest event), or *parallel*.
//!
//! The error trigger and the "called by another flow" trigger arm nothing: the first is fired from
//! [`run_finished`] when another flow fails, the second by an Execute flow node.

mod listen;
mod poll;
mod watch;
pub mod webhook;

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use super::params;
use super::run::Item;
use super::runs::{self, Finished, RunOrigin, StartRequest};
use super::schedule::{self, Decision};
use super::spec::{self, FlowNode, FlowSpec};
use crate::db::flow_run_queries::FlowRunRow;
use crate::db::{flow_queries, Db};

/// What starts a flow without a person: every trigger but the manual one.
pub fn is_automatic(type_id: &str) -> bool {
    type_id.starts_with("trigger.") && type_id != "trigger.manual"
}

/// One armed trigger, as the Programación view shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerView {
    pub node_id: String,
    pub node_name: String,
    pub type_id: String,
    /// What it listens for, in a few words: `cada 15 minutos`, `POST /hooks/pagos`, a folder.
    pub detail: String,
    /// The webhook's full URL, for copying.
    pub url: Option<String>,
    pub next: Option<String>,
    /// A schedule's occurrences in the next 24 hours, for the ruler.
    pub upcoming: Vec<String>,
    pub last_fired: Option<String>,
    pub last_outcome: Option<String>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmedFlowView {
    pub flow_id: String,
    pub flow_name: String,
    pub workspace_id: String,
    pub scope: String,
    pub overlap: String,
    pub triggers: Vec<TriggerView>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Overlap {
    Skip,
    Queue,
    Parallel,
}

struct Armed {
    flow_name: String,
    workspace_id: String,
    scope: String,
    overlap: Overlap,
    cancel: CancellationToken,
    triggers: Vec<Arc<Mutex<TriggerView>>>,
    /// Error triggers: which flows' failures they answer (`None` = every flow of the workspace).
    error_watch: Vec<(String, Option<Vec<String>>)>,
    hotkeys: Vec<String>,
    queued: Option<(String, Vec<Item>)>,
}

static HUB: LazyLock<Mutex<HashMap<String, Armed>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn spanish(app: &AppHandle) -> bool {
    crate::tray::spanish(app)
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("flows:triggers", ());
}

/// Every armed flow, optionally only those a workspace sees (its own and global ones).
pub fn status(workspace_id: Option<&str>) -> Vec<ArmedFlowView> {
    let Ok(hub) = HUB.lock() else { return vec![] };
    let mut out: Vec<ArmedFlowView> = hub
        .iter()
        .filter(|(_, armed)| workspace_id.is_none_or(|ws| armed.workspace_id == ws || armed.scope == "global"))
        .map(|(id, armed)| ArmedFlowView {
            flow_id: id.clone(),
            flow_name: armed.flow_name.clone(),
            workspace_id: armed.workspace_id.clone(),
            scope: armed.scope.clone(),
            overlap: match armed.overlap {
                Overlap::Skip => "skip",
                Overlap::Queue => "queue",
                Overlap::Parallel => "parallel",
            }
            .to_string(),
            triggers: armed.triggers.iter().filter_map(|t| t.lock().ok().map(|v| v.clone())).collect(),
        })
        .collect();
    out.sort_by(|a, b| a.flow_name.to_lowercase().cmp(&b.flow_name.to_lowercase()));
    out
}

/// The armed flows a paired phone may start: one button per phone trigger, labelled as the node says.
pub fn phone_buttons() -> Vec<Value> {
    let Ok(hub) = HUB.lock() else { return vec![] };
    let mut out: Vec<Value> = hub
        .iter()
        .flat_map(|(flow_id, armed)| {
            armed.triggers.iter().filter_map(move |view| {
                let view = view.lock().ok()?;
                (view.type_id == "trigger.phone").then(|| {
                    json!({
                        "flowId": flow_id,
                        "nodeId": view.node_id,
                        "flowName": armed.flow_name,
                        "label": view.detail,
                        "workspaceId": armed.workspace_id,
                    })
                })
            })
        })
        .collect();
    out.sort_by_key(|button| button["label"].as_str().unwrap_or_default().to_lowercase());
    out
}

/// Starts an armed flow from its phone trigger. Refused for a flow that is not armed, or a node that
/// is not one of its phone triggers — the phone can only press the buttons it was shown.
pub fn fire_from_phone(app: &AppHandle, flow_id: &str, node_id: &str, text: &str) -> Result<Value, String> {
    let allowed = phone_buttons().iter().any(|b| b["flowId"] == json!(flow_id) && b["nodeId"] == json!(node_id));
    if !allowed {
        return Err("That flow cannot be started from the phone".into());
    }
    let item = Item::new(json!({"source": "phone", "text": text, "at": chrono::Utc::now().to_rfc3339()}));
    let fired = fire(app, flow_id, node_id, vec![item])?;
    Ok(json!({"held": fired.held}))
}

/// How many flows are armed — for the quit question.
pub fn armed_names() -> Vec<String> {
    HUB.lock().map(|hub| hub.values().map(|armed| armed.flow_name.clone()).collect()).unwrap_or_default()
}

/// Stops everything one flow listens for.
pub fn disarm(app: &AppHandle, flow_id: &str) {
    let removed = HUB.lock().ok().and_then(|mut hub| hub.remove(flow_id));
    if let Some(armed) = removed {
        armed.cancel.cancel();
        webhook::forget_flow(flow_id);
        unbind_hotkeys(app, &armed.hotkeys);
        emit_changed(app);
    }
}

/// Startup: arms every active flow, then fires the "CodeFlow opened" triggers once.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // After the window has had its moment; nothing here is urgent enough to compete with it.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let ids: Vec<String> = {
            let db = app.state::<Db>();
            let Ok(conn) = db.0.lock() else { return };
            flow_queries::active_flow_ids(&conn).unwrap_or_default()
        };
        for id in &ids {
            if let Err(error) = arm(&app, id) {
                crate::applog::warn(&format!("flows: could not arm {id} at startup — {error}"));
            }
        }
        let starters: Vec<(String, String)> = HUB
            .lock()
            .map(|hub| {
                hub.iter()
                    .flat_map(|(flow, armed)| {
                        armed
                            .triggers
                            .iter()
                            .filter_map(|t| t.lock().ok().map(|v| (v.type_id.clone(), v.node_id.clone(), v.detail.clone())))
                            .filter(|(type_id, _, detail)| type_id == "trigger.app" && detail == "appStart")
                            .map(|(_, node, _)| (flow.clone(), node))
                            .collect::<Vec<_>>()
                    })
                    .collect()
            })
            .unwrap_or_default();
        for (flow, node) in starters {
            let item = json!({"event": "appStart", "at": Utc::now().to_rfc3339(), "version": app.package_info().version.to_string()});
            let _ = fire(&app, &flow, &node, vec![Item::new(item)]);
        }
    });
}

/// Stops every trigger — the quit path.
pub fn shutdown() {
    if let Ok(mut hub) = HUB.lock() {
        for (_, armed) in hub.drain() {
            armed.cancel.cancel();
        }
    }
    webhook::shutdown();
}

/// The parameters a trigger node runs with: its own, defaults filled in.
fn trigger_params(node: &FlowNode) -> Value {
    params::with_defaults(&node.type_id, &node.params)
}

fn param_text(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// Checks that every automatic trigger of a flow can be armed, without arming any — what switching a
/// flow on asks first.
pub fn validate(app: &AppHandle, flow_id: &str, spec: &FlowSpec) -> Result<(), String> {
    let triggers: Vec<&FlowNode> = spec.nodes.iter().filter(|n| !n.disabled && is_automatic(&n.type_id)).collect();
    if triggers.is_empty() {
        return Err("no-automatic-trigger".into());
    }
    let zone = spec.settings.get("timezone").and_then(Value::as_str).map(str::to_string);
    for node in triggers {
        let params = trigger_params(node);
        let fail = |message: String| format!("\"{}\": {message}", node.name);
        match node.type_id.as_str() {
            "trigger.schedule" => {
                schedule::parse_all(&params, zone.as_deref()).map_err(fail)?;
            }
            "trigger.webhook" => {
                webhook::check(flow_id, node, &params).map_err(fail)?;
            }
            "trigger.file" => {
                let path = param_text(&params, "watchPath");
                if path.is_empty() || !std::path::Path::new(&path).exists() {
                    return Err(fail(format!("the folder {} does not exist", if path.is_empty() { "(none)" } else { &path })));
                }
            }
            "trigger.repo" | "trigger.pr" | "trigger.pipeline" => {
                let project = param_text(&params, "project");
                let db = app.state::<Db>();
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                if project.is_empty() || crate::db::queries::get_project(&conn, &project).ok().flatten().is_none() {
                    return Err(fail("choose a repository".into()));
                }
            }
            "trigger.hotkey" => {
                let accelerator = param_text(&params, "accelerator");
                tauri_plugin_global_shortcut::Shortcut::from_str(&accelerator)
                    .map_err(|e| fail(format!("\"{accelerator}\" is not a shortcut: {e}")))?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// (Re)arms a flow from what is saved: disarms it first, and arms it again only if it is active.
pub fn arm(app: &AppHandle, flow_id: &str) -> Result<(), String> {
    disarm(app, flow_id);
    let row = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        flow_queries::get_flow(&conn, flow_id).map_err(|e| e.to_string())?
    };
    let Some(row) = row else { return Ok(()) };
    if !row.meta.active {
        return Ok(());
    }
    // A flow runs on its own only with what the user trusted it to run.
    if !row.meta.trusted {
        return Err("untrusted".into());
    }
    let parsed = spec::parse(&row.spec)?;
    validate(app, flow_id, &parsed)?;
    let overlap = match parsed.settings.get("overlap").and_then(Value::as_str) {
        Some("queue") => Overlap::Queue,
        Some("parallel") => Overlap::Parallel,
        _ => Overlap::Skip,
    };
    let zone = parsed.settings.get("timezone").and_then(Value::as_str).map(str::to_string);
    let cancel = CancellationToken::new();
    let mut triggers = Vec::new();
    let mut error_watch = Vec::new();
    let mut hotkeys = Vec::new();
    let es = spanish(app);
    for node in parsed.nodes.iter().filter(|n| !n.disabled && is_automatic(&n.type_id)) {
        let params = trigger_params(node);
        let view = Arc::new(Mutex::new(TriggerView {
            node_id: node.id.clone(),
            node_name: node.name.clone(),
            type_id: node.type_id.clone(),
            detail: String::new(),
            url: None,
            next: None,
            upcoming: vec![],
            last_fired: None,
            last_outcome: None,
            problem: None,
        }));
        let set_detail = |detail: String| {
            if let Ok(mut v) = view.lock() {
                v.detail = detail;
            }
        };
        match node.type_id.as_str() {
            "trigger.schedule" => {
                let schedules = schedule::parse_all(&params, zone.as_deref())?;
                set_detail(schedule::describe(&params, es));
                let catch_up = params.get("catchUp").and_then(Value::as_bool).unwrap_or(true);
                spawn_schedule(app, flow_id, &node.id, schedules, catch_up, view.clone(), cancel.child_token());
            }
            "trigger.webhook" => {
                let url = webhook::register(app, flow_id, node, &params)?;
                set_detail(format!("{} {}", param_text(&params, "method"), url.trim_start_matches(&webhook::base_url())));
                if let Ok(mut v) = view.lock() {
                    v.url = Some(url);
                }
            }
            "trigger.file" => {
                set_detail(param_text(&params, "watchPath"));
                watch::spawn(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
            }
            "trigger.repo" | "trigger.pr" | "trigger.pipeline" => {
                let project = param_text(&params, "project");
                let name = {
                    let db = app.state::<Db>();
                    let conn = db.0.lock().map_err(|e| e.to_string())?;
                    crate::db::queries::get_project(&conn, &project).ok().flatten().map(|p| p.name).unwrap_or(project.clone())
                };
                set_detail(format!("{name} · {}", param_text(&params, "event")));
                poll::spawn(app, flow_id, node, &params, view.clone(), cancel.child_token());
            }
            "trigger.app" => {
                let event = param_text(&params, "event");
                set_detail(event.clone());
                if event != "appStart" {
                    poll::spawn_services(app, flow_id, &node.id, &params, view.clone(), cancel.child_token());
                }
            }
            "trigger.hotkey" => {
                let accelerator = param_text(&params, "accelerator");
                bind_hotkey(app, &accelerator, flow_id, &node.id)?;
                set_detail(accelerator.clone());
                hotkeys.push(accelerator);
            }
            "trigger.error" => {
                let which = param_text(&params, "which");
                let flows: Option<Vec<String>> = (which == "selected").then(|| {
                    params
                        .get("flows")
                        .and_then(Value::as_array)
                        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
                        .unwrap_or_default()
                });
                set_detail(if which == "selected" { "selected".into() } else { "all".into() });
                error_watch.push((node.id.clone(), flows));
            }
            "trigger.subflow" => set_detail("subflow".into()),
            // Nothing to listen to on this side: the phone asks, through `phone_buttons`.
            "trigger.phone" => {
                let label = param_text(&params, "label");
                set_detail(if label.is_empty() { row.meta.name.clone() } else { label });
            }
            "trigger.listen" => {
                let transport = param_text(&params, "transport");
                let label = match transport.as_str() {
                    "mqtt" => "MQTT",
                    "socketio" => "Socket.IO",
                    "sse" => "SSE",
                    _ => "WebSocket",
                };
                let topic = param_text(&params, "topic");
                set_detail(if transport == "mqtt" && !topic.is_empty() {
                    format!("{label} {} · {topic}", param_text(&params, "url"))
                } else {
                    format!("{label} {}", param_text(&params, "url"))
                });
                listen::spawn(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
            }
            _ => {}
        }
        triggers.push(view);
    }
    if let Ok(mut hub) = HUB.lock() {
        hub.insert(
            flow_id.to_string(),
            Armed {
                flow_name: row.meta.name.clone(),
                workspace_id: row.meta.workspace_id.clone(),
                scope: row.meta.scope.clone(),
                overlap,
                cancel,
                triggers,
                error_watch,
                hotkeys,
                queued: None,
            },
        );
    }
    emit_changed(app);
    Ok(())
}

fn note_fire(flow_id: &str, node_id: &str, outcome: &str) {
    let Ok(hub) = HUB.lock() else { return };
    let Some(armed) = hub.get(flow_id) else { return };
    for trigger in &armed.triggers {
        if let Ok(mut view) = trigger.lock() {
            if view.node_id == node_id {
                view.last_fired = Some(Utc::now().to_rfc3339());
                view.last_outcome = Some(outcome.to_string());
            }
        }
    }
}

fn note_problem(view: &Arc<Mutex<TriggerView>>, problem: Option<String>) {
    if let Ok(mut v) = view.lock() {
        v.problem = problem;
    }
}

/// A fire's result, for the webhook that may wait on it.
pub struct Fired {
    pub run: Option<FlowRunRow>,
    pub done: Option<tokio::sync::oneshot::Receiver<Finished>>,
    /// Not started: the flow was already running and its policy is to skip (or queue).
    pub held: bool,
}

/// A trigger fired: start the flow from it, unless its overlap policy says otherwise.
pub fn fire(app: &AppHandle, flow_id: &str, node_id: &str, items: Vec<Item>) -> Result<Fired, String> {
    fire_with(app, flow_id, node_id, items, None, false)
}

pub fn fire_with(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    items: Vec<Item>,
    respond: Option<tokio::sync::oneshot::Sender<super::engine::Reply>>,
    wait: bool,
) -> Result<Fired, String> {
    let overlap = HUB.lock().ok().and_then(|hub| hub.get(flow_id).map(|armed| armed.overlap)).unwrap_or(Overlap::Skip);
    let busy = runs::active_ids(None).iter().any(|(_, flow)| flow == flow_id);
    if busy && overlap != Overlap::Parallel {
        if overlap == Overlap::Queue {
            if let Ok(mut hub) = HUB.lock() {
                if let Some(armed) = hub.get_mut(flow_id) {
                    armed.queued = Some((node_id.to_string(), items));
                }
            }
            note_fire(flow_id, node_id, "queued");
        } else {
            note_fire(flow_id, node_id, "skipped");
        }
        emit_changed(app);
        return Ok(Fired { run: None, done: None, held: true });
    }
    let mut request = StartRequest::fired(node_id, items, RunOrigin::Trigger);
    request.respond = respond;
    request.wait = wait;
    let (row, done) = runs::start_with(app, flow_id, request)?;
    note_fire(flow_id, node_id, "started");
    emit_changed(app);
    Ok(Fired { run: Some(row), done, held: false })
}

/// A run ended: start the one queued behind it, and tell the error triggers about a failure.
pub fn run_finished(app: &AppHandle, row: &FlowRunRow, origin: RunOrigin) {
    let queued = HUB.lock().ok().and_then(|mut hub| hub.get_mut(&row.flow_id).and_then(|armed| armed.queued.take()));
    if let Some((node, items)) = queued {
        let _ = fire(app, &row.flow_id, &node, items);
    }
    if row.status != "error" || origin == RunOrigin::Error {
        return;
    }
    let targets: Vec<(String, String)> = HUB
        .lock()
        .map(|hub| {
            hub.iter()
                .filter(|(flow, armed)| {
                    **flow != row.flow_id && (armed.workspace_id == row.workspace_id || armed.scope == "global")
                })
                .flat_map(|(flow, armed)| {
                    armed
                        .error_watch
                        .iter()
                        .filter(|(_, only)| only.as_ref().is_none_or(|list| list.contains(&row.flow_id)))
                        .map(|(node, _)| (flow.clone(), node.clone()))
                        .collect::<Vec<_>>()
                })
                .collect()
        })
        .unwrap_or_default();
    for (flow, node) in targets {
        let item = json!({
            "flow": {"id": row.flow_id, "name": row.flow_name},
            "execution": {
                "id": row.id,
                "mode": row.mode,
                "error": row.error,
                "errorNode": row.error_node,
                "startedAt": row.started_at,
                "finishedAt": row.finished_at,
            }
        });
        let mut request = StartRequest::fired(&node, vec![Item::new(item)], RunOrigin::Error);
        request.depth = 1;
        if let Err(error) = runs::start_with(app, &flow, request) {
            crate::applog::warn(&format!("flows: the error flow {flow} did not start — {error}"));
        }
    }
}

// ------------------------------------------------------------------------------------ schedules

fn spawn_schedule(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    schedules: Vec<schedule::Schedule>,
    catch_up: bool,
    view: Arc<Mutex<TriggerView>>,
    cancel: CancellationToken,
) {
    let app = app.clone();
    let flow_id = flow_id.to_string();
    let node_id = node_id.to_string();
    tauri::async_runtime::spawn(async move {
        let set_next = |next: Option<DateTime<Utc>>| {
            let mut upcoming = Vec::new();
            if let Some(first) = next {
                let horizon = Utc::now() + chrono::Duration::hours(24);
                let mut at = first;
                while at <= horizon && upcoming.len() < 300 {
                    upcoming.push(at.to_rfc3339());
                    match schedule::next_of(&schedules, at) {
                        Some(following) => at = following,
                        None => break,
                    }
                }
            }
            if let Ok(mut v) = view.lock() {
                v.next = next.map(|n| n.to_rfc3339());
                v.upcoming = upcoming;
            }
        };
        let Some(mut pending) = schedule::next_of(&schedules, Utc::now()) else {
            note_problem(&view, Some("never fires".into()));
            return;
        };
        set_next(Some(pending));
        emit_changed(&app);
        loop {
            // Short sleeps against the wall clock, never one long one: a laptop that sleeps through
            // the moment wakes into the next check, and a timer measured in monotonic time would
            // not have counted the hours it was asleep.
            let wait = (pending - Utc::now()).to_std().unwrap_or_default().min(Duration::from_secs(15));
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => return,
            }
            match schedule::decide(&schedules, pending, Utc::now(), catch_up) {
                Decision::Wait(_) => continue,
                Decision::Fire { scheduled, late, next } => {
                    let item = json!({
                        "timestamp": Utc::now().to_rfc3339(),
                        "scheduledFor": scheduled.to_rfc3339(),
                        "late": late,
                    });
                    if let Err(error) = fire(&app, &flow_id, &node_id, vec![Item::new(item)]) {
                        note_problem(&view, Some(error));
                    }
                    let Some(next) = next else { return };
                    pending = next;
                    set_next(Some(next));
                    emit_changed(&app);
                }
                Decision::Skip { next, .. } => {
                    note_fire(&flow_id, &node_id, "missed");
                    let Some(next) = next else { return };
                    pending = next;
                    set_next(Some(next));
                    emit_changed(&app);
                }
            }
        }
    });
}

// -------------------------------------------------------------------------------------- hotkeys

static HOTKEYS: LazyLock<Mutex<HashMap<u32, (String, String, String)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn bind_hotkey(app: &AppHandle, accelerator: &str, flow_id: &str, node_id: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let shortcut = Shortcut::from_str(accelerator).map_err(|e| format!("\"{accelerator}\" is not a shortcut: {e}"))?;
    let taken = HOTKEYS.lock().map(|map| map.get(&shortcut.id()).is_some_and(|(flow, _, _)| flow != flow_id)).unwrap_or(false);
    if taken {
        return Err(format!("{accelerator} already starts another flow"));
    }
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| format!("could not bind {accelerator}: {e}"))?;
    if let Ok(mut map) = HOTKEYS.lock() {
        map.insert(shortcut.id(), (flow_id.to_string(), node_id.to_string(), accelerator.to_string()));
    }
    Ok(())
}

fn unbind_hotkeys(app: &AppHandle, accelerators: &[String]) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    for accelerator in accelerators {
        if let Ok(shortcut) = Shortcut::from_str(accelerator) {
            let _ = app.global_shortcut().unregister(shortcut);
            if let Ok(mut map) = HOTKEYS.lock() {
                map.remove(&shortcut.id());
            }
        }
    }
}

/// The process-wide shortcut handler asks this first: a chord that belongs to a flow starts it and
/// goes no further. True when it was one.
pub fn hotkey_pressed(app: &AppHandle, shortcut: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    let hit = HOTKEYS.lock().ok().and_then(|map| map.get(&shortcut.id()).cloned());
    let Some((flow, node, accelerator)) = hit else { return false };
    let item = json!({"accelerator": accelerator, "at": Utc::now().to_rfc3339()});
    let app = app.clone();
    // Off the shortcut thread: starting a run touches the database.
    tauri::async_runtime::spawn(async move {
        let _ = fire(&app, &flow, &node, vec![Item::new(item)]);
    });
    true
}

/// Binds every flow chord again — after something that clears all of the process's chords (the
/// quick-ask shortcut's rebinding does).
pub fn rebind_hotkeys(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let accelerators: Vec<String> = HOTKEYS.lock().map(|map| map.values().map(|(_, _, a)| a.clone()).collect()).unwrap_or_default();
    for accelerator in accelerators {
        if let Ok(shortcut) = Shortcut::from_str(&accelerator) {
            let _ = app.global_shortcut().register(shortcut);
        }
    }
}
