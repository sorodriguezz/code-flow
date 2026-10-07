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

mod bots;
mod desk;
mod github;
mod inbox;
mod infra;
mod listen;
mod more;
mod poll;
mod queue;
mod watch;
pub mod watchers;
pub mod webhook;

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio_util::sync::CancellationToken;

use super::params;
use super::run::Item;
use super::runs::{self, Finished, RunOrigin, StartRequest};
use super::schedule::{self, Decision};
use super::spec::{self, FlowNode, FlowSpec};
use crate::db::flow_run_queries::FlowRunRow;
use crate::db::{flow_queries, flow_run_queries, Db};

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
    /// The same webhook's address on the internet, while a tunnel is up (`flows::tunnel`).
    pub public_url: Option<String>,
    pub next: Option<String>,
    /// A schedule's occurrences in the day from its next one, for the ruler (`schedule::outlook`).
    pub upcoming: Vec<String>,
    /// Instead of `upcoming`, for a schedule too busy to list: the stretches that hold any.
    pub busy: Vec<Stretch>,
    pub last_fired: Option<String>,
    pub last_outcome: Option<String>,
    pub problem: Option<String>,
}

/// A stretch of a busy schedule's day in which every five minutes run at least once.
#[derive(Debug, Clone, Serialize)]
pub struct Stretch {
    pub from: String,
    pub to: String,
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
    /// The fire held behind a running one: node, items, and how deep in a chain it was raised.
    queued: Option<(String, Vec<Item>, u32)>,
    /// "Evento de CodeFlow" triggers on something the app raises (`app_event`): node, event, params.
    app_events: Vec<(String, String, Value)>,
    /// «Otro flujo terminó»: node, the outcome it waits for, which flows (`None` = every one).
    done_watch: Vec<(String, String, Option<Vec<String>>)>,
    /// «Esperar calma»: events closer together than this are gathered into one run (zero: off).
    settle: Duration,
    /// The events gathered so far, per trigger node, how many times each batch grew, and the deepest
    /// chain any of them came from (the batch runs at that depth, so gathering never resets it).
    settling: HashMap<String, (Vec<Item>, u64, u32)>,
}

/// The most events one gathered run takes; past it the batch starts at once.
const SETTLE_MAX_ITEMS: usize = 1_000;

/// Every gathered event's number, across batches and flows. One counter for all, never restarted:
/// a batch released early (full) and a new one begun used to count from one again, and the timer of
/// the old batch's first event — still asleep — took the new batch for its own and released it.
static SETTLE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// How deep flows may set each other off — «Otro flujo terminó» and the error triggers — before the
/// next one is refused, like flows calling flows. The depth travels with every fire, including one
/// held in the queue or gathered by «Esperar calma»: one that restarted at zero there let two flows
/// ping-pong for ever.
const MAX_CHAIN: u32 = 5;

/// «Menú contextual»: what an active flow offers on a right click, and where.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEntry {
    pub flow_id: String,
    pub node_id: String,
    pub flow_name: String,
    pub workspace_id: String,
    pub scope: String,
    pub label: String,
    /// `file`, `folder`, `selection`, `commit`, `pr`.
    pub places: Vec<String>,
    pub glob: String,
    pub ask_first: bool,
}

static CONTEXT: LazyLock<Mutex<Vec<ContextEntry>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// «Chat»: an active flow the Chat app can talk to, as if it were a model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAssistant {
    pub flow_id: String,
    pub node_id: String,
    pub flow_name: String,
    pub workspace_id: String,
    pub scope: String,
    pub name: String,
    pub description: String,
    pub history_turns: u32,
}

static CHATS: LazyLock<Mutex<Vec<ChatAssistant>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// A «Solo archivos como» list split into patterns, on the commas outside braces (`*.{ts,tsx}` is one).
/// The same reading as `splitPatterns` in flowContextStore.ts.
fn split_globs(patterns: &str) -> Vec<String> {
    let (mut out, mut current, mut depth) = (Vec::new(), String::new(), 0usize);
    for c in patterns.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if c == ',' && depth == 0 {
            out.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    out.push(current);
    out.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

/// Whether a file at `path` (its path in the repository) fits a «Solo archivos como» list: a pattern
/// with a folder in it against the path, any other against the name — as `globMatches` reads it.
fn glob_fits(patterns: &str, path: &str) -> bool {
    let relative = path.replace('\\', "/");
    let name = relative.rsplit('/').next().unwrap_or_default().to_string();
    let list = split_globs(patterns);
    if list.is_empty() || name.is_empty() {
        return true;
    }
    list.iter().any(|pattern| {
        let pattern = pattern.strip_prefix("**/").unwrap_or(pattern);
        let target = if pattern.contains('/') { &relative } else { &name };
        // `*` stays inside one folder, as in the menu's reading (and unlike a container name's glob).
        match globset::GlobBuilder::new(pattern).case_insensitive(true).literal_separator(true).build() {
            Ok(glob) => glob.compile_matcher().is_match(target),
            Err(_) => target.to_lowercase().contains(&pattern.to_lowercase()),
        }
    })
}

/// The right-click entries for `place` in a workspace — for a file, or a selection in one, only
/// those whose pattern fits it; a folder is not filtered (the pattern is about files).
pub fn context_entries(workspace_id: &str, place: &str, path: Option<&str>) -> Vec<ContextEntry> {
    let filtered = matches!(place, "file" | "selection");
    let Ok(entries) = CONTEXT.lock() else { return vec![] };
    let mut out: Vec<ContextEntry> = entries
        .iter()
        .filter(|e| e.workspace_id == workspace_id || e.scope == "global")
        .filter(|e| e.places.iter().any(|p| p == place))
        .filter(|e| e.glob.is_empty() || !filtered || path.is_none_or(|p| glob_fits(&e.glob, p)))
        .cloned()
        .collect();
    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    out
}

/// Starts a flow from its right-click entry, with what was right-clicked as the item.
pub fn fire_context(app: &AppHandle, flow_id: &str, node_id: &str, payload: Value) -> Result<Value, String> {
    let known = CONTEXT.lock().map(|entries| entries.iter().any(|e| e.flow_id == flow_id && e.node_id == node_id)).unwrap_or(false);
    if !known {
        return Err("That flow is no longer active".into());
    }
    let mut item = payload;
    if let Some(map) = item.as_object_mut() {
        map.insert("at".into(), json!(Utc::now().to_rfc3339()));
    }
    let fired = fire(app, flow_id, node_id, vec![Item::new(item)])?;
    Ok(json!({"held": fired.held, "runId": fired.run.map(|r| r.id)}))
}

/// The flows the Chat app can talk to in a workspace.
pub fn chat_assistants(workspace_id: &str) -> Vec<ChatAssistant> {
    let Ok(chats) = CHATS.lock() else { return vec![] };
    let mut out: Vec<ChatAssistant> = chats.iter().filter(|c| c.workspace_id == workspace_id || c.scope == "global").cloned().collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// What a flow's answer to a chat message says: the text of its last node's first item — `text`,
/// `answer`, `reply`, `output`, `message` or `content`, whichever it has — or the item itself.
pub fn chat_reply(items: &[Item]) -> String {
    let Some(first) = items.first() else { return String::new() };
    for key in ["text", "answer", "reply", "output", "message", "content"] {
        if let Some(said) = first.json.get(key).and_then(Value::as_str) {
            return said.to_string();
        }
    }
    match &first.json {
        Value::String(said) => said.clone(),
        other => format!("```json\n{}\n```", serde_json::to_string_pretty(other).unwrap_or_default()),
    }
}

/// One message to a chat flow: it runs with the message (and the conversation so far, as many
/// turns as its trigger keeps) and its answer comes back as text.
///
/// `workspace_id` is the conversation's: a flow kept to another workspace does not answer there.
/// `stop` resolves when the person presses Stop — the flow's run is cancelled with the turn, and the
/// error starts with `ai_runs::CANCELLED_MARKER`, the way a stopped engine turn's does.
pub async fn chat_turn(
    app: &AppHandle,
    flow_id: &str,
    message: &str,
    history: Vec<Value>,
    conversation_id: &str,
    workspace_id: &str,
    stop: impl std::future::Future<Output = ()>,
) -> Result<Value, String> {
    let assistant = CHATS.lock().ok().and_then(|chats| chats.iter().find(|c| c.flow_id == flow_id).cloned()).ok_or("That flow no longer answers in the chat — switch it on in Flujos")?;
    if assistant.scope != "global" && !workspace_id.is_empty() && assistant.workspace_id != workspace_id {
        return Err(format!("“{}” answers in another workspace's chats", assistant.name));
    }
    let keep = assistant.history_turns as usize * 2;
    let history: Vec<Value> = history.iter().skip(history.len().saturating_sub(keep)).cloned().collect();
    let item = json!({"message": message, "history": history, "conversationId": conversation_id, "at": Utc::now().to_rfc3339()});
    let fired = fire_with(app, flow_id, &assistant.node_id, vec![Item::new(item)], None, true)?;
    if fired.held {
        return Err("The flow is still answering another message".into());
    }
    let run_id = fired.run.as_ref().map(|r| r.id.clone());
    let done = fired.done.ok_or("The flow did not start")?;
    let finished = tokio::select! {
        finished = tokio::time::timeout(Duration::from_secs(15 * 60), done) => finished
            .map_err(|_| "The flow is taking longer than 15 minutes; it carries on in Flujos".to_string())?
            .map_err(|_| "The run ended without an answer".to_string())?,
        _ = stop => {
            if let Some(id) = &run_id {
                runs::cancel(id);
            }
            return Err(format!("{}stopped", crate::ai_runs::CANCELLED_MARKER));
        }
    };
    if finished.status != "success" {
        return Err(if finished.error.is_empty() { format!("The flow ended as {}", finished.status) } else { finished.error });
    }
    Ok(json!({"text": chat_reply(&finished.last_output), "runId": run_id, "name": assistant.name}))
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
            triggers: armed
                .triggers
                .iter()
                .filter_map(|t| t.lock().ok().map(|v| v.clone()))
                .map(|mut view| {
                    // Read now rather than stored: the tunnel comes up (and changes address) on its own clock.
                    if view.type_id == "trigger.webhook" {
                        view.public_url = view.url.as_deref().and_then(|url| crate::flows::tunnel::public_hook(url.trim_start_matches(&webhook::base_url())));
                    }
                    view
                })
                .collect(),
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
        crate::flows::mcp::forget_flow(flow_id);
        watchers::forget_links(flow_id);
        if let Ok(mut entries) = CONTEXT.lock() {
            entries.retain(|e| e.flow_id != flow_id);
        }
        if let Ok(mut chats) = CHATS.lock() {
            chats.retain(|c| c.flow_id != flow_id);
        }
        unbind_hotkeys(app, &armed.hotkeys);
        emit_changed(app);
    }
}

/// The app, for the parts of it that raise events without holding a handle (`note_saved`).
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Saves of each note since its last «Nota guardada»: the debounce's generation counter, and who
/// made them — whether a person did, and which flows.
static NOTE_SAVES: LazyLock<Mutex<HashMap<String, (u64, bool, HashSet<String>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

thread_local! {
    /// The flow whose run is saving a note on this thread right now (`saving_note_as`).
    static NOTE_WRITER: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Runs `save` — a synchronous note save — as one made by `flow_id`'s run (a flow's note operations).
/// A flow that appends to the note it watches must not set itself off again: it did, every 30
/// seconds, for as long as it was switched on.
pub fn saving_note_as<T>(flow_id: &str, save: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            NOTE_WRITER.with(|writer| *writer.borrow_mut() = None);
        }
    }
    NOTE_WRITER.with(|writer| *writer.borrow_mut() = Some(flow_id.to_string()));
    let _reset = Reset;
    save()
}

/// A note was saved. «Nota guardada» fires once the note has been quiet for 30 seconds, so an
/// autosave every few keystrokes is one event, carrying the note as it ended up. A flow whose own
/// saves are the only ones in that stretch is not told about them.
pub fn note_saved(note_id: &str) {
    let Some(app) = APP.get().cloned() else { return };
    let listening = HUB.lock().map(|hub| hub.values().any(|armed| armed.app_events.iter().any(|(_, event, _)| event == "noteSaved"))).unwrap_or(false);
    if !listening {
        return;
    }
    let writer = NOTE_WRITER.with(|writer| writer.borrow().clone());
    let generation = {
        let Ok(mut saves) = NOTE_SAVES.lock() else { return };
        let entry = saves.entry(note_id.to_string()).or_insert_with(|| (0, false, HashSet::new()));
        entry.0 += 1;
        match writer {
            Some(flow) => {
                entry.2.insert(flow);
            }
            None => entry.1 = true,
        }
        entry.0
    };
    let note_id = note_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let batch = {
            let Ok(mut saves) = NOTE_SAVES.lock() else { return };
            if saves.get(&note_id).map(|entry| entry.0) != Some(generation) {
                return;
            }
            saves.remove(&note_id)
        };
        // The one flow that made every save of the stretch, if one did: it is skipped below.
        let only_writer = batch.and_then(|(_, by_person, flows)| (!by_person && flows.len() == 1).then(|| flows.into_iter().next()).flatten());
        let note = {
            let db = app.state::<Db>();
            let found = db.0.lock().ok().and_then(|conn| crate::db::note_queries::get_note(&conn, &note_id).ok().flatten());
            found
        };
        let Some(note) = note else { return };
        let tags: Value = serde_json::from_str(&note.tags).unwrap_or_else(|_| json!([]));
        app_event_except(
            &app,
            "noteSaved",
            json!({"noteId": note.id, "workspaceId": note.workspace_id, "title": note.title, "tags": tags, "content": note.content, "updatedAt": note.updated_at}),
            only_writer.as_deref(),
        );
    });
}

/// Startup: arms every active flow, then fires the "CodeFlow opened" triggers once.
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    // A terminal ending is announced by the terminal itself (generic over the runtime, so it cannot
    // call `app_event`); its event carries what a "terminal ended" trigger filters on.
    let listener = app.clone();
    app.listen_any("terminal:exit", move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            let item = json!({
                "sessionId": payload.get("id").cloned().unwrap_or(Value::Null),
                "owner": payload.get("owner").cloned().unwrap_or(Value::Null),
                "code": payload.get("code").cloned().unwrap_or(Value::Null),
                "seconds": payload.get("seconds").cloned().unwrap_or(json!(0)),
            });
            app_event(&listener, "terminalExited", item);
        }
    });
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
        // A first launch by `codeflow --flow <name>`: the links are armed now.
        let argv: Vec<String> = std::env::args().collect();
        watchers::handle_args(&app, &argv);
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

/// A credential a trigger of `flow_id` signs with, and its secret: one of `kinds`, of the flow's
/// workspace or global — the same rule a run's nodes follow.
fn credential_row(app: &AppHandle, flow_id: &str, id: &str, kinds: &[&str]) -> Result<(flow_run_queries::FlowCredential, String), String> {
    let (row, workspace) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let row = flow_run_queries::get_credential(&conn, id).map_err(|e| e.to_string())?.ok_or("The credential no longer exists")?;
        let workspace = flow_queries::get_flow(&conn, flow_id).map_err(|e| e.to_string())?.map(|flow| flow.meta.workspace_id);
        (row, workspace)
    };
    if row.scope != "global" && workspace.as_deref() != Some(row.workspace_id.as_str()) {
        return Err(format!("The credential \"{}\" belongs to another workspace", row.name));
    }
    if !kinds.contains(&row.kind.as_str()) {
        return Err(format!("A {} credential cannot be used here", row.kind));
    }
    let secret = crate::secrets::get_secret(&crate::secrets::flow_credential_key(id))?
        .ok_or_else(|| format!("The credential \"{}\" has no secret stored on this computer", row.name))?;
    Ok((row, secret))
}

fn credential_secret(app: &AppHandle, flow_id: &str, id: &str, kinds: &[&str]) -> Result<String, String> {
    credential_row(app, flow_id, id, kinds).map(|(_, secret)| secret)
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
                if params.get("skipHolidays").and_then(Value::as_bool) == Some(true) {
                    crate::flows::holidays::country_code(&param_text(&params, "holidayCountry")).map_err(fail)?;
                }
            }
            "trigger.webhook" => {
                webhook::check(flow_id, node, &params).map_err(fail)?;
            }
            "trigger.bot" => {
                if param_text(&params, "credential").is_empty() {
                    return Err(fail("choose the credential with the bot's token".into()));
                }
            }
            "trigger.tool" => crate::flows::mcp::check(flow_id, node, &params).map_err(fail)?,
            "trigger.feed" if param_text(&params, "feedUrl").is_empty() => return Err(fail("write the feed's address".into())),
            "trigger.db" if param_text(&params, "connection").is_empty() => return Err(fail("pick the database connection".into())),
            "trigger.remoteFile" if param_text(&params, "host").is_empty() => return Err(fail("pick the host".into())),
            "trigger.google" if param_text(&params, "credential").is_empty() => return Err(fail("choose the Google sign-in".into())),
            "trigger.queue" if param_text(&params, "broker") == "sqs" && param_text(&params, "credential").is_empty() => {
                return Err(fail("choose the AWS credential".into()))
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
            "trigger.github" => github::check(app, flow_id, &params).map_err(fail)?,
            "trigger.email" => inbox::check(app, flow_id, &params).map_err(fail)?,
            "trigger.form" => webhook::check_form(flow_id, node, &params).map_err(fail)?,
            "trigger.microsoft" if param_text(&params, "credential").is_empty() => return Err(fail("choose the Microsoft sign-in".into())),
            "trigger.package" if param_text(&params, "packageName").is_empty() => return Err(fail("write the package's name".into())),
            "trigger.connector" => {
                let call = params.get("call").cloned().unwrap_or(Value::Null);
                let connector = crate::flows::connectors::find(call.get("connector").and_then(Value::as_str).unwrap_or_default()).ok_or_else(|| fail("pick the service".into()))?;
                match connector.operation(call.get("operation").and_then(Value::as_str).unwrap_or_default()) {
                    None => return Err(fail("pick what to look at".into())),
                    Some(operation) if !more::reads(operation) => return Err(fail(format!("“{}” changes things — pick an operation that reads a list", operation.id))),
                    Some(_) => {}
                }
                if connector.auth != "none" && !connector.auth_optional && param_text(&params, "credential").is_empty() {
                    return Err(fail(format!("pick the credential for {}", connector.name)));
                }
            }
            "trigger.context" => {
                if params.get("contextPlaces").and_then(Value::as_array).is_none_or(|list| list.is_empty()) {
                    return Err(fail("choose where the entry appears".into()));
                }
            }
            "trigger.container" | "trigger.k8s" | "trigger.clipboard" | "trigger.logLine" => {
                if node.type_id == "trigger.k8s" && crate::containers::cli::find("kubectl").is_none() {
                    return Err(fail("kubectl is not installed".into()));
                }
                if matches!(node.type_id.as_str(), "trigger.clipboard" | "trigger.logLine") {
                    infra::Matcher::of(&params).map_err(fail)?;
                }
            }
            "trigger.chat" => {
                let taken = CHATS.lock().map(|chats| chats.iter().any(|c| c.flow_id != flow_id && c.name.eq_ignore_ascii_case(&chat_name(node, &params)))).unwrap_or(false);
                if taken {
                    return Err(fail(format!("another flow already answers in the chat as “{}”", chat_name(node, &params))));
                }
            }
            "trigger.flowDone" => {
                if param_text(&params, "which") == "selected" && params.get("flows").and_then(Value::as_array).is_none_or(|list| list.is_empty()) {
                    return Err(fail("choose the flows to wait for".into()));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// What only switching a flow on refuses — not `validate`, which also runs at every start-up re-arm:
/// a «Una sola vez» whose moment has passed. Accepted, it showed the flow on and never ran it; at a
/// re-arm the same schedule simply has nothing left to do, which is fine.
pub fn check_switch_on(spec: &FlowSpec) -> Result<(), String> {
    let zone = spec.settings.get("timezone").and_then(Value::as_str).map(str::to_string);
    for node in spec.nodes.iter().filter(|n| !n.disabled && n.type_id == "trigger.schedule") {
        let params = trigger_params(node);
        let passed = schedule::parse_all(&params, zone.as_deref())?
            .iter()
            .any(|s| matches!(s, schedule::Schedule::Once { at } if *at <= Utc::now()));
        if passed {
            return Err(format!("\"{}\": the moment to run at has already passed", node.name));
        }
    }
    Ok(())
}

/// Whether `node_id` is still one of the flow's live triggers — what a re-arm carries over must
/// still have somewhere to start from.
fn still_triggers(spec: &FlowSpec, node_id: &str) -> bool {
    spec.nodes.iter().any(|n| n.id == node_id && !n.disabled && is_automatic(&n.type_id))
}

fn chat_name(node: &FlowNode, params: &Value) -> String {
    let given = param_text(params, "assistantName");
    if given.is_empty() { node.name.clone() } else { given }
}

/// (Re)arms a flow from what is saved: disarms it first, and arms it again only if it is active.
pub fn arm(app: &AppHandle, flow_id: &str) -> Result<(), String> {
    // What was gathered («Esperar calma») or held in the queue survives a re-arm — saving the flow
    // re-arms it, and dropped those events on the floor. Their timers still run and still release
    // them: the generations carried over are the ones they are waiting for.
    let carried = HUB.lock().ok().and_then(|hub| hub.get(flow_id).map(|armed| (armed.settling.clone(), armed.queued.clone())));
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
    let mut app_events = Vec::new();
    let mut done_watch = Vec::new();
    let mut context_entries = Vec::new();
    let mut chat_entries = Vec::new();
    let es = spanish(app);
    // Every trigger armed in one go. When a later one refuses (a credential missing, a port taken),
    // what the earlier ones started is undone below: the schedule armed before a failing connector
    // kept running a flow the list showed as off, and `disarm` — which works from the HUB entry this
    // never got — could not stop it.
    let armed_all = (|| -> Result<(), String> {
        for node in parsed.nodes.iter().filter(|n| !n.disabled && is_automatic(&n.type_id)) {
            let params = trigger_params(node);
            let view = Arc::new(Mutex::new(TriggerView {
                node_id: node.id.clone(),
                node_name: node.name.clone(),
                type_id: node.type_id.clone(),
                detail: String::new(),
                url: None,
                public_url: None,
                next: None,
                upcoming: vec![],
                busy: vec![],
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
                    let holidays = (params.get("skipHolidays").and_then(Value::as_bool) == Some(true) && param_text(&params, "mode") != "once").then(|| {
                        let country = param_text(&params, "holidayCountry");
                        let country = if country.is_empty() { "CL".to_string() } else { country.to_uppercase() };
                        crate::flows::holidays::warm(&country);
                        country
                    });
                    spawn_schedule(app, flow_id, &node.id, schedules, catch_up, holidays, view.clone(), cancel.child_token());
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
                    match event.as_str() {
                        "appStart" => {}
                        "serviceReady" | "serviceFailed" | "serviceStopped" => {
                            poll::spawn_services(app, flow_id, &node.id, &params, view.clone(), cancel.child_token());
                        }
                        _ => app_events.push((node.id.clone(), event, params.clone())),
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
                "trigger.github" => {
                    set_detail(format!("{} · {}", param_text(&params, "repository"), param_text(&params, "event")));
                    github::spawn(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.email" => {
                    let mailbox = param_text(&params, "mailbox");
                    set_detail(if mailbox.is_empty() { "INBOX".into() } else { mailbox });
                    inbox::spawn(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.feed" => {
                    set_detail(param_text(&params, "feedUrl"));
                    watchers::feed(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.queue" => {
                    let broker = param_text(&params, "broker");
                    let target = match broker.as_str() {
                        "kafka" => format!("Kafka · {}", param_text(&params, "topic")),
                        "sqs" => format!("SQS · {}", param_text(&params, "queueUrl").rsplit('/').next().unwrap_or_default()),
                        _ => format!("RabbitMQ · {}", param_text(&params, "queueName")),
                    };
                    set_detail(target);
                    queue::spawn(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.db" => {
                    let event = param_text(&params, "dbEvent");
                    set_detail(match event.as_str() {
                        "newRow" => format!("{} · {}", param_text(&params, "table"), param_text(&params, "watermark")),
                        _ => param_text(&params, "channels"),
                    });
                    watchers::database(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.remoteFile" => {
                    set_detail(param_text(&params, "remotePath"));
                    watchers::remote_file(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.google" => {
                    set_detail(param_text(&params, "googleEvent"));
                    watchers::google(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.system" => {
                    set_detail(param_text(&params, "systemEvent"));
                    watchers::system(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.link" => {
                    let name = watchers::link_name(&params, &row.meta.name);
                    let ask = params.get("askFirst").and_then(Value::as_bool).unwrap_or(true);
                    watchers::register_link(flow_id, &node.id, &name, ask)?;
                    set_detail(format!("codeflow --flow {name}"));
                }
                "trigger.tool" => {
                    // The flow becomes a tool of the MCP server on the webhook port.
                    webhook::ensure_server(app)?;
                    let name = crate::flows::mcp::register(flow_id, &row.meta.name, node, &params)?;
                    set_detail(name);
                }
                "trigger.bot" => {
                    let platform = param_text(&params, "platform");
                    set_detail(match platform.as_str() {
                        "botSlack" => "Slack · Socket Mode".to_string(),
                        "botDiscord" => "Discord · Gateway".to_string(),
                        _ => "Telegram".to_string(),
                    });
                    bots::spawn(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.form" => {
                    let url = webhook::register_form(app, flow_id, node, &params)?;
                    set_detail(url.trim_start_matches(&webhook::base_url()).to_string());
                    if let Ok(mut v) = view.lock() {
                        v.url = Some(url);
                    }
                }
                "trigger.container" => {
                    let engine = param_text(&params, "engineKind");
                    let filter = [param_text(&params, "nameFilter"), param_text(&params, "composeProject")].into_iter().filter(|f| !f.is_empty()).collect::<Vec<_>>().join(" · ");
                    set_detail(if filter.is_empty() { engine } else { format!("{engine} · {filter}") });
                    infra::containers(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.k8s" => {
                    let context = param_text(&params, "kubeContext");
                    let namespace = param_text(&params, "namespace");
                    set_detail(format!("{}{}", if context.is_empty() { "kubectl".to_string() } else { context }, if namespace.is_empty() { String::new() } else { format!(" · {namespace}") }));
                    infra::cluster(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.logLine" => {
                    set_detail(match param_text(&params, "logSource").as_str() {
                        "logContainer" => format!("{} · {}", param_text(&params, "engineKind"), param_text(&params, "container")),
                        "logPod" => format!("pod {}", param_text(&params, "k8sName")),
                        _ => param_text(&params, "logPath"),
                    });
                    infra::log_line(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.package" => {
                    set_detail(format!("{} · {}", param_text(&params, "registry"), param_text(&params, "packageName")));
                    more::package(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.connector" => {
                    let call = params.get("call").cloned().unwrap_or(Value::Null);
                    set_detail(format!(
                        "{} · {}",
                        call.get("connector").and_then(Value::as_str).unwrap_or_default(),
                        call.get("operation").and_then(Value::as_str).unwrap_or_default()
                    ));
                    more::connector(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.clipboard" => {
                    set_detail(param_text(&params, "clipKind"));
                    more::clipboard(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.microsoft" => {
                    set_detail(param_text(&params, "msEvent"));
                    more::microsoft(app, flow_id, &node.id, &params, view.clone(), cancel.child_token())?;
                }
                "trigger.flowDone" => {
                    let which = param_text(&params, "which");
                    let flows: Option<Vec<String>> = (which == "selected").then(|| {
                        params.get("flows").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
                    });
                    set_detail(param_text(&params, "outcome"));
                    done_watch.push((node.id.clone(), param_text(&params, "outcome"), flows));
                }
                "trigger.context" => {
                    let label = { let l = param_text(&params, "menuLabel"); if l.is_empty() { node.name.clone() } else { l } };
                    let places: Vec<String> = params
                        .get("contextPlaces")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(|p| p.trim_start_matches("place").to_lowercase())
                        .collect();
                    set_detail(format!("{label} · {}", places.join(", ")));
                    context_entries.push(ContextEntry {
                        flow_id: flow_id.to_string(),
                        node_id: node.id.clone(),
                        flow_name: row.meta.name.clone(),
                        workspace_id: row.meta.workspace_id.clone(),
                        scope: row.meta.scope.clone(),
                        label,
                        places,
                        glob: param_text(&params, "fileGlob"),
                        ask_first: params.get("askFirst").and_then(Value::as_bool).unwrap_or(false),
                    });
                }
                "trigger.chat" => {
                    let name = chat_name(node, &params);
                    set_detail(name.clone());
                    chat_entries.push(ChatAssistant {
                        flow_id: flow_id.to_string(),
                        node_id: node.id.clone(),
                        flow_name: row.meta.name.clone(),
                        workspace_id: row.meta.workspace_id.clone(),
                        scope: row.meta.scope.clone(),
                        name,
                        description: param_text(&params, "assistantDescription"),
                        history_turns: params.get("historyTurns").and_then(Value::as_f64).unwrap_or(10.0).clamp(0.0, 100.0) as u32,
                    });
                }
                _ => {}
            }
            triggers.push(view);
        }
        Ok(())
    })();
    if let Err(error) = armed_all {
        cancel.cancel();
        webhook::forget_flow(flow_id);
        crate::flows::mcp::forget_flow(flow_id);
        watchers::forget_links(flow_id);
        unbind_hotkeys(app, &hotkeys);
        return Err(error);
    }
    if let Ok(mut entries) = CONTEXT.lock() {
        entries.extend(context_entries);
    }
    if let Ok(mut chats) = CHATS.lock() {
        chats.extend(chat_entries);
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
                queued: carried.as_ref().and_then(|(_, queued)| queued.clone()).filter(|(node, _, _)| still_triggers(&parsed, node)),
                app_events,
                done_watch,
                settle: Duration::from_secs_f64(parsed.settings.get("settleSec").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 3_600.0)),
                settling: carried.map(|(settling, _)| settling).unwrap_or_default().into_iter().filter(|(node, _)| still_triggers(&parsed, node)).collect(),
            },
        );
    }
    emit_changed(app);
    Ok(())
}

/// Something happened in CodeFlow itself — raised by the part of the app that knows (a commit made,
/// a push, a branch switched, a terminal that ended, an agents chain that finished, the Revisor's
/// verdict, a pull request analysed, an AI plan filling up) and matched here against every armed
/// "Evento de CodeFlow" trigger's own filter. Cheap when nothing listens: one lock and a scan.
///
/// `payload` becomes the trigger's item, with `event` and `at` added.
pub fn app_event(app: &AppHandle, event: &str, payload: Value) {
    app_event_except(app, event, payload, None)
}

/// `app_event`, leaving out one flow — the one whose own doing the event reports.
fn app_event_except(app: &AppHandle, event: &str, payload: Value, except: Option<&str>) {
    let listening: Vec<(String, String, Value)> = HUB
        .lock()
        .map(|hub| {
            hub.iter()
                .flat_map(|(flow, armed)| {
                    armed
                        .app_events
                        .iter()
                        .filter(|(_, wanted, _)| wanted == event)
                        .map(|(node, _, params)| (flow.clone(), node.clone(), params.clone()))
                        .collect::<Vec<_>>()
                })
                .collect()
        })
        .unwrap_or_default();
    if listening.is_empty() {
        return;
    }
    for (flow, node, params) in listening {
        if except == Some(flow.as_str()) || !app_event_matches(app, &flow, &node, event, &params, &payload) {
            continue;
        }
        let mut item = payload.clone();
        if let Some(fields) = item.as_object_mut() {
            fields.insert("event".into(), json!(event));
            fields.insert("at".into(), json!(Utc::now().to_rfc3339()));
        }
        let _ = fire(app, &flow, &node, vec![Item::new(item)]);
    }
}

/// Quota windows each AI-quota trigger has already fired for — once per window, not per check.
static QUOTA_FIRED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Whether an app event is one this trigger asked for: the repository and branch it names, a
/// terminal that ran long enough, a plan past its threshold (once per window).
fn app_event_matches(app: &AppHandle, flow: &str, node: &str, event: &str, params: &Value, payload: &Value) -> bool {
    let project = param_text(params, "project");
    if !project.is_empty() {
        let by_id = payload.get("projectId").and_then(Value::as_str) == Some(project.as_str());
        let by_path = payload.get("repoPath").and_then(Value::as_str).is_some_and(|path| {
            let db = app.state::<Db>();
            let found = db.0.lock().ok().and_then(|conn| crate::db::queries::get_project(&conn, &project).ok().flatten());
            found.is_some_and(|p| same_path(&p.local_path, path))
        });
        if !by_id && !by_path {
            return false;
        }
    }
    let branch = param_text(params, "branch");
    if !branch.is_empty() && matches!(event, "gitCommitted" | "gitPushed" | "branchSwitched") {
        if payload.get("branch").and_then(Value::as_str) != Some(branch.as_str()) {
            return false;
        }
    }
    if event == "noteSaved" {
        let tag = param_text(params, "noteTag").trim_start_matches('#').to_lowercase();
        let in_workspace = HUB.lock().ok().and_then(|hub| hub.get(flow).map(|armed| armed.scope == "global" || payload.get("workspaceId").and_then(Value::as_str) == Some(armed.workspace_id.as_str()))).unwrap_or(false);
        let tagged = tag.is_empty() || payload.get("tags").and_then(Value::as_array).is_some_and(|tags| tags.iter().any(|t| t.as_str().is_some_and(|t| t.to_lowercase() == tag)));
        return in_workspace && tagged;
    }
    match event {
        "terminalExited" => {
            let floor = params.get("minSeconds").and_then(Value::as_f64).unwrap_or(0.0);
            payload.get("seconds").and_then(Value::as_f64).unwrap_or(0.0) >= floor
        }
        "aiQuotaHigh" => {
            let threshold = params.get("threshold").and_then(Value::as_f64).unwrap_or(80.0);
            let used = payload.get("usedPercent").and_then(Value::as_f64).unwrap_or(0.0);
            if used < threshold {
                return false;
            }
            let window = format!(
                "{flow}|{node}|{}|{}|{}",
                payload.get("provider").and_then(Value::as_str).unwrap_or_default(),
                payload.get("kind").and_then(Value::as_str).unwrap_or_default(),
                payload.get("resetsAt").and_then(Value::as_str).unwrap_or_default()
            );
            QUOTA_FIRED.lock().map(|mut fired| fired.insert(window)).unwrap_or(false)
        }
        _ => true,
    }
}

/// Two spellings of one folder — trailing separators and case on the file systems that ignore it.
fn same_path(a: &str, b: &str) -> bool {
    let tidy = |p: &str| {
        let trimmed = p.trim_end_matches(['/', '\\']).to_string();
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            trimmed.to_lowercase()
        } else {
            trimmed
        }
    };
    tidy(a) == tidy(b)
}

/// The branch a repository has checked out, for a git event's item — `""` when detached or unreadable.
pub fn current_branch(repo_path: &str) -> String {
    git2::Repository::open(repo_path)
        .ok()
        .and_then(|repo| repo.head().ok().and_then(|head| head.shorthand().map(str::to_string)))
        .unwrap_or_default()
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
    /// Held and gone: skipped rather than queued or gathered, so nothing will ever run it. What a
    /// sender is told then is "busy, try again" — never "received".
    pub dropped: bool,
}

/// A trigger fired: start the flow from it, unless its overlap policy says otherwise — or, with
/// «Esperar calma», gather it with the events that follow until they stop for a while.
pub fn fire(app: &AppHandle, flow_id: &str, node_id: &str, items: Vec<Item>) -> Result<Fired, String> {
    fire_at(app, flow_id, node_id, items, 0)
}

/// `fire`, for a fire raised by another flow's run `depth` levels down a chain.
fn fire_at(app: &AppHandle, flow_id: &str, node_id: &str, items: Vec<Item>, depth: u32) -> Result<Fired, String> {
    let gathered = {
        let Ok(mut hub) = HUB.lock() else { return fire_with_at(app, flow_id, node_id, items, None, false, depth) };
        match hub.get_mut(flow_id).filter(|armed| !armed.settle.is_zero()) {
            None => None,
            Some(armed) => {
                let settle = armed.settle;
                let entry = armed.settling.entry(node_id.to_string()).or_insert_with(|| (Vec::new(), 0, 0));
                entry.0.extend(items.clone());
                entry.1 = SETTLE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                entry.2 = entry.2.max(depth);
                let full = entry.0.len() >= SETTLE_MAX_ITEMS;
                Some((settle, entry.1, full))
            }
        }
    };
    let Some((settle, generation, full)) = gathered else {
        return fire_with_at(app, flow_id, node_id, items, None, false, depth);
    };
    let release = |app: &AppHandle, flow_id: &str, node_id: &str| {
        let batch = HUB.lock().ok().and_then(|mut hub| hub.get_mut(flow_id).and_then(|armed| armed.settling.remove(node_id))).map(|(items, _, depth)| (items, depth));
        if let Some((batch, depth)) = batch.filter(|(b, _)| !b.is_empty()) {
            if let Err(error) = fire_with_at(app, flow_id, node_id, batch, None, false, depth) {
                crate::applog::warn(&format!("flows: a gathered run of {flow_id} did not start — {error}"));
            }
        }
    };
    if full {
        release(app, flow_id, node_id);
        return Ok(Fired { run: None, done: None, held: false, dropped: false });
    }
    note_fire(flow_id, node_id, "settling");
    emit_changed(app);
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(settle).await;
        let quiet = HUB.lock().ok().and_then(|hub| hub.get(&flow_id).and_then(|armed| armed.settling.get(&node_id).map(|(_, g, _)| *g == generation))).unwrap_or(false);
        if quiet {
            release(&app, &flow_id, &node_id);
        }
    });
    Ok(Fired { run: None, done: None, held: true, dropped: false })
}

pub fn fire_with(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    items: Vec<Item>,
    respond: Option<tokio::sync::oneshot::Sender<super::engine::Reply>>,
    wait: bool,
) -> Result<Fired, String> {
    fire_with_at(app, flow_id, node_id, items, respond, wait, 0)
}

fn fire_with_at(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    items: Vec<Item>,
    respond: Option<tokio::sync::oneshot::Sender<super::engine::Reply>>,
    wait: bool,
    depth: u32,
) -> Result<Fired, String> {
    let overlap = HUB.lock().ok().and_then(|hub| hub.get(flow_id).map(|armed| armed.overlap)).unwrap_or(Overlap::Skip);
    let busy = runs::active_ids(None).iter().any(|(_, flow)| flow == flow_id);
    if busy && overlap != Overlap::Parallel {
        // Someone waiting on the answer (a chat turn, a webhook holding its response) is never
        // queued: the queue keeps one fire and starts it later with nobody left to hear it, so the
        // caller is told the flow is busy instead.
        let queued = overlap == Overlap::Queue && respond.is_none() && !wait;
        if queued {
            if let Ok(mut hub) = HUB.lock() {
                if let Some(armed) = hub.get_mut(flow_id) {
                    armed.queued = Some((node_id.to_string(), items, depth));
                }
            }
            note_fire(flow_id, node_id, "queued");
        } else {
            note_fire(flow_id, node_id, "skipped");
        }
        emit_changed(app);
        return Ok(Fired { run: None, done: None, held: true, dropped: !queued });
    }
    let mut request = StartRequest::fired(node_id, items, RunOrigin::Trigger);
    request.respond = respond;
    request.wait = wait;
    request.depth = depth;
    let (row, done) = runs::start_with(app, flow_id, request)?;
    note_fire(flow_id, node_id, "started");
    emit_changed(app);
    Ok(Fired { run: Some(row), done, held: false, dropped: false })
}

/// A run ended: start the one queued behind it, and tell the error triggers about a failure.
pub fn run_finished(app: &AppHandle, row: &FlowRunRow, origin: RunOrigin, depth: u32, last_output: &[Item]) {
    let queued = HUB.lock().ok().and_then(|mut hub| hub.get_mut(&row.flow_id).and_then(|armed| armed.queued.take()));
    if let Some((node, items, queued_depth)) = queued {
        let _ = fire_at(app, &row.flow_id, &node, items, queued_depth);
    }
    // A test («Pruebas») is a rehearsal: its end — a failure it expects included — must not page
    // whoever the error flows page, nor start the flows that wait on this one.
    if origin == RunOrigin::Test {
        return;
    }
    flow_done(app, row, depth, last_output);
    if row.status != "error" || origin == RunOrigin::Error || depth >= MAX_CHAIN {
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
        // One level deeper than the run that failed, not back to one: an error flow that sets off a
        // «Otro flujo terminó» flow that fails again is a chain like any other.
        request.depth = depth + 1;
        if let Err(error) = runs::start_with(app, &flow, request) {
            crate::applog::warn(&format!("flows: the error flow {flow} did not start — {error}"));
        }
    }
}

/// «Otro flujo terminó»: the flows waiting on this one's end start, with how it ended and what its
/// last node produced. A chain of them stops five deep, like flows calling flows.
fn flow_done(app: &AppHandle, row: &FlowRunRow, depth: u32, last_output: &[Item]) {
    if depth >= MAX_CHAIN || !matches!(row.status.as_str(), "success" | "error" | "canceled") {
        return;
    }
    let targets: Vec<(String, String)> = HUB
        .lock()
        .map(|hub| {
            hub.iter()
                .filter(|(flow, armed)| **flow != row.flow_id && (armed.workspace_id == row.workspace_id || armed.scope == "global"))
                .flat_map(|(flow, armed)| {
                    armed
                        .done_watch
                        .iter()
                        .filter(|(_, outcome, only)| {
                            let wanted = match outcome.as_str() {
                                "outcomeError" => row.status == "error",
                                "outcomeAny" => true,
                                _ => row.status == "success",
                            };
                            wanted && only.as_ref().is_none_or(|list| list.contains(&row.flow_id))
                        })
                        .map(|(node, _, _)| (flow.clone(), node.clone()))
                        .collect::<Vec<_>>()
                })
                .collect()
        })
        .unwrap_or_default();
    if targets.is_empty() {
        return;
    }
    let custom = {
        let db = app.state::<Db>();
        let found = db.0.lock().ok().and_then(|conn| flow_run_queries::get_run(&conn, &row.id).ok().flatten());
        found.map(|run| run.custom_data).unwrap_or_else(|| json!({}))
    };
    let output: Vec<Value> = last_output.iter().take(50).map(|item| item.json.clone()).collect();
    for (flow, node) in targets {
        let item = json!({
            "flow": {"id": row.flow_id, "name": row.flow_name},
            "execution": {
                "id": row.id,
                "status": row.status,
                "mode": row.mode,
                "error": row.error,
                "errorNode": row.error_node,
                "startedAt": row.started_at,
                "finishedAt": row.finished_at,
                "durationMs": row.duration_ms,
                "customData": custom,
            },
            "output": output,
        });
        // As any fire: the waiting flow's own overlap policy and «Esperar calma» apply — one level
        // deeper in the chain. Started directly, an idle flow skipped its settle wait.
        if let Err(error) = fire_at(app, &flow, &node, vec![Item::new(item)], depth + 1) {
            crate::applog::warn(&format!("flows: the flow {flow} waiting on {} did not start — {error}", row.flow_name));
        }
    }
    emit_changed(app);
}

// ------------------------------------------------------------------------------------ schedules

#[allow(clippy::too_many_arguments)]
fn spawn_schedule(
    app: &AppHandle,
    flow_id: &str,
    node_id: &str,
    schedules: Vec<schedule::Schedule>,
    catch_up: bool,
    holidays: Option<String>,
    view: Arc<Mutex<TriggerView>>,
    cancel: CancellationToken,
) {
    let app = app.clone();
    let flow_id = flow_id.to_string();
    let node_id = node_id.to_string();
    tauri::async_runtime::spawn(async move {
        let set_next = |next: Option<DateTime<Utc>>| {
            let outlook = next.map(|first| schedule::outlook(&schedules, first)).unwrap_or_default();
            if let Ok(mut v) = view.lock() {
                v.next = next.map(|n| n.to_rfc3339());
                v.upcoming = outlook.points.iter().map(|at| at.to_rfc3339()).collect();
                v.busy = outlook.busy.iter().map(|(from, to)| Stretch { from: from.to_rfc3339(), to: to.to_rfc3339() }).collect();
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
                    // «Saltar feriados»: the occurrence on a holiday of the country is let go.
                    let holiday = holidays.as_deref().is_some_and(|country| {
                        let zone = schedule::zone_of_schedule(&schedules).unwrap_or(chrono_tz::UTC);
                        let day = scheduled.with_timezone(&zone).date_naive();
                        use chrono::Datelike;
                        crate::flows::holidays::known_now(country, day.year()).contains(&day)
                    });
                    if holiday {
                        note_fire(&flow_id, &node_id, "holiday");
                        let Some(next) = next else { return };
                        pending = next;
                        set_next(Some(next));
                        emit_changed(&app);
                        continue;
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_pattern_reads_like_the_menu_s() {
        assert_eq!(split_globs("*.{ts,tsx}, *.md ,"), vec!["*.{ts,tsx}", "*.md"]);
        assert!(glob_fits("*.csv", "data/ventas.CSV"));
        assert!(!glob_fits("*.csv", "data/ventas.json"));
        assert!(glob_fits("**/*.ts", "src/lib/a.ts"));
        assert!(glob_fits("*.{ts,tsx}", "src/App.tsx"));
        assert!(glob_fits("src/**/*.ts", "src/lib/flows/spec.ts"));
        assert!(!glob_fits("src/*.ts", "src/lib/spec.ts"));
        assert!(glob_fits("", "x.bin"));
    }
}
