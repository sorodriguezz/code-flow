//! Runs parked at a node until someone decides: the approval node, the wait node's "until its URL
//! is called", and timed waits long enough to outlive the app.
//!
//! **Two ways out of a wait.** While the app runs, the waiting node's task awaits a channel and the
//! decision travels down it. After a restart there is no task: the decision *resumes* the run from
//! its records instead — every node that had finished becomes a seed with its stored output, the
//! node that waited gets the decision as its output, and the engine carries on under the same run
//! id. What that needs is written when the wait starts: the flow as it ran (`spec.json`, so editing
//! the flow meanwhile changes nothing) and what reached the node (`waits/<node>.json.gz`). A wait
//! inside a loop cannot be picked up that way — where the loop was in its list is not on record —
//! and says so.
//!
//! **Deciding twice is impossible.** The desk and the phone may both press Approve: the row is
//! settled by `UPDATE … WHERE decided_at IS NULL`, and only the update that changed it acts.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::catalog::LOOP_TYPE;
use super::engine::{self, HostFuture, WaitAnswer, WaitRequest};
use super::run::{self, Plan, Ports};
use super::runs::{self, AppHost, Launch};
use super::spec::FlowSpec;
use crate::db::flow_run_queries::{self as queries, FlowWaitRow};
use crate::db::Db;

/// The waits whose node is still waiting in this session, by wait id.
static WAITERS: LazyLock<Mutex<HashMap<String, oneshot::Sender<WaitAnswer>>>> = LazyLock::new(Default::default);

/// Set when the app is quitting. Every run is cancelled then, and a wait cancelled that way is not an
/// answer: its row stays open and its run `waiting`, for the next launch to pick up.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// The quit path, before it cancels the runs — see [`QUITTING`].
pub fn quitting() {
    QUITTING.store(true, Ordering::SeqCst);
}

/// Whether a run that just ended was cancelled by the app quitting while it waited.
pub fn parked_by_quit(app: &AppHandle, run_id: &str) -> bool {
    QUITTING.load(Ordering::SeqCst)
        && with_db(app, |conn| queries::get_run(conn, run_id)).ok().flatten().is_some_and(|run| run.status == "waiting")
}

fn wait_dir(run_id: &str) -> std::path::PathBuf {
    runs::run_dir(run_id).join("waits")
}

fn write_gz(path: &std::path::Path, value: &impl serde::Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
    serde_json::to_writer(&mut encoder, value).map_err(|e| e.to_string())?;
    encoder.finish().and_then(|mut file| file.flush()).map_err(|e| e.to_string())
}

fn read_gz<T: serde::de::DeserializeOwned>(path: &std::path::Path) -> Result<T, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut text = String::new();
    flate2::read::GzDecoder::new(file).read_to_string(&mut text).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn with_db<T>(app: &AppHandle, work: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    work(&conn).map_err(|e| e.to_string())
}

/// Tells every window the run's row changed — `waiting`, or `running` again.
fn emit_run(app: &AppHandle, run_id: &str) {
    if let Ok(Some(row)) = with_db(app, |conn| queries::get_run(conn, run_id)) {
        let _ = app.emit("flows:run", row);
    }
}

/// Sent with no payload whenever a wait opens or closes — what the phone listens to.
pub const CHANGED_EVENT: &str = "flows:waits-changed";

fn emit_wait(app: &AppHandle, wait: &FlowWaitRow) {
    let _ = app.emit("flows:wait", wait.clone());
    let _ = app.emit(CHANGED_EVENT, ());
}

/// The decision a wait reaches when its time limit comes.
fn on_timeout(kind: &str) -> &'static str {
    if kind == "time" {
        "resumed"
    } else {
        "expired"
    }
}

/// Settles an open wait in the database. `None` when it was already settled.
fn settle(app: &AppHandle, wait_id: &str, decision: &str, by: &str, payload: &Value) -> Result<Option<(FlowWaitRow, WaitAnswer)>, String> {
    let at = engine::now_text();
    let changed = with_db(app, |conn| queries::decide_wait(conn, wait_id, decision, by, payload, &at))?;
    if !changed {
        return Ok(None);
    }
    let row = with_db(app, |conn| queries::get_wait(conn, wait_id))?.ok_or("The wait vanished")?;
    emit_wait(app, &row);
    Ok(Some((row, WaitAnswer { decision: decision.to_string(), by: by.to_string(), at, payload: payload.clone() })))
}

/// The app side of [`engine::RunHost::wait_for`].
pub(super) fn wait_for(host: &AppHost, request: WaitRequest, cancel: CancellationToken) -> HostFuture<'_, Result<WaitAnswer, String>> {
    Box::pin(async move {
        let app = host.app.clone();
        // A call, a form and an approval sent as links all arrive at the flows' server.
        if request.kind == "webhook" || request.kind == "form" || request.links {
            super::triggers::webhook::ensure_server(&app)?;
        }
        // What a pick-up after a restart needs: the flow as it ran and what reached this node.
        let dir = runs::run_dir(&host.run_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("spec.json"), serde_json::to_vec(&*host.spec).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        write_gz(&wait_dir(&host.run_id).join(format!("{}.json.gz", request.node_id)), &request.inputs)?;

        let id = uuid::Uuid::new_v4().to_string();
        let row = FlowWaitRow {
            id: id.clone(),
            run_id: host.run_id.clone(),
            flow_id: host.flow_id.clone(),
            workspace_id: host.workspace_id.clone(),
            flow_name: host.flow_name.clone(),
            node_id: request.node_id.clone(),
            node_name: request.node_name.clone(),
            kind: request.kind.clone(),
            message: request.message.clone(),
            created_at: engine::now_text(),
            expires_at: request.timeout.and_then(|limit| chrono::Duration::from_std(limit).ok()).map(|limit| (chrono::Utc::now() + limit).to_rfc3339()),
            decided_at: None,
            decision: String::new(),
            decided_by: String::new(),
            payload: Value::Null,
        };
        let (tx, rx) = oneshot::channel();
        WAITERS.lock().map_err(|e| e.to_string())?.insert(id.clone(), tx);
        with_db(&app, |conn| {
            queries::insert_wait(conn, &row)?;
            queries::set_run_status(conn, &host.run_id, "waiting")
        })?;
        emit_run(&app, &host.run_id);
        emit_wait(&app, &row);

        let limit = async {
            match request.timeout {
                Some(limit) => tokio::time::sleep(limit).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(rx);
        let outcome = tokio::select! {
            answer = &mut rx => answer.map_err(|_| "The wait was dropped".to_string()),
            _ = cancel.cancelled() => {
                if let Ok(mut waiters) = WAITERS.lock() {
                    waiters.remove(&id);
                }
                // Stopped by hand, it is over; stopped by the app quitting, it waits on.
                if !QUITTING.load(Ordering::SeqCst) {
                    let _ = settle(&app, &id, "canceled", "", &Value::Null);
                }
                Err(crate::ai_runs::CANCELLED_MARKER.to_string())
            }
            _ = limit => {
                if let Ok(mut waiters) = WAITERS.lock() {
                    waiters.remove(&id);
                }
                match settle(&app, &id, on_timeout(&request.kind), "timer", &Value::Null)? {
                    Some((_, answer)) => Ok(answer),
                    // Decided in the same instant: that decision is on its way down the channel.
                    None => rx.await.map_err(|_| "The wait was dropped".to_string()),
                }
            }
        };
        if outcome.is_ok() {
            let _ = with_db(&app, |conn| queries::set_run_status(conn, &host.run_id, "running"));
            emit_run(&app, &host.run_id);
        }
        outcome
    })
}

/// Decides an open wait — Approve or Reject on the desk or the phone, a call to a resume URL.
pub fn decide(app: &AppHandle, wait_id: &str, decision: &str, by: &str, payload: Value) -> Result<FlowWaitRow, String> {
    let row = with_db(app, |conn| queries::get_wait(conn, wait_id))?.ok_or("That wait no longer exists")?;
    let allowed: &[&str] = if row.kind == "approval" { &["approved", "rejected"] } else { &["resumed"] };
    if !allowed.contains(&decision) {
        return Err(format!("A {} wait cannot be {decision}", row.kind));
    }
    let Some((row, answer)) = settle(app, wait_id, decision, by, &payload)? else {
        return Err("already-decided".into());
    };
    let waiter = WAITERS.lock().map_err(|e| e.to_string())?.remove(wait_id);
    match waiter {
        Some(tx) => {
            let _ = tx.send(answer);
        }
        None => pick_up(app, &row, answer)?,
    }
    Ok(row)
}

/// A call to `/resume/<run>[/<node name>]`: resumes that run's open "wait for a call". Returns the
/// run id; `not-waiting` when nothing there waits for a call.
pub fn resume_by_call(app: &AppHandle, path: &str, call: Value) -> Result<String, String> {
    let (run_id, node_name) = match path.split_once('/') {
        Some((run, node)) => (run, Some(percent_encoding::percent_decode_str(node).decode_utf8_lossy().into_owned())),
        None => (path, None),
    };
    let open: Vec<FlowWaitRow> = with_db(app, |conn| queries::waits_of_run(conn, run_id))?
        .into_iter()
        .filter(|wait| wait.kind == "webhook" && wait.decided_at.is_none())
        .filter(|wait| node_name.as_ref().is_none_or(|name| &wait.node_name == name))
        .collect();
    match open.as_slice() {
        [] => Err("not-waiting".into()),
        [wait] => decide(app, &wait.id, "resumed", "webhook", call).map(|_| run_id.to_string()),
        _ => Err("Several nodes of this run wait for a call: add the node's name to the URL".into()),
    }
}

/// The open wait a page link points at — `<run>/<node name>`, or `<run>` alone when one node of
/// that run waits — of `kind` (`approval`, `form`).
pub fn open_wait_at(app: &AppHandle, path: &str, kind: &str) -> Result<FlowWaitRow, String> {
    let (run_id, node_name) = match path.split_once('/') {
        Some((run, node)) => (run, Some(percent_encoding::percent_decode_str(node).decode_utf8_lossy().into_owned())),
        None => (path, None),
    };
    let open: Vec<FlowWaitRow> = with_db(app, |conn| queries::waits_of_run(conn, run_id))?
        .into_iter()
        .filter(|wait| wait.kind == kind && wait.decided_at.is_none())
        .filter(|wait| node_name.as_ref().is_none_or(|name| &wait.node_name == name))
        .collect();
    match open.as_slice() {
        [wait] => Ok(wait.clone()),
        [] => Err("not-waiting".into()),
        _ => Err("Several nodes of this run wait: add the node's name to the link".into()),
    }
}

/// The open waits of a workspace (or all of them), oldest first.
pub fn open_waits(app: &AppHandle, workspace_id: Option<&str>) -> Result<Vec<FlowWaitRow>, String> {
    with_db(app, |conn| queries::open_waits(conn, workspace_id))
}

/// Stops a waiting run that has no task behind it — the app restarted while it waited.
pub fn cancel_parked(app: &AppHandle, run_id: &str) -> Result<bool, String> {
    let run = with_db(app, |conn| queries::get_run(conn, run_id))?;
    if run.as_ref().is_none_or(|run| run.status != "waiting") {
        return Ok(false);
    }
    for wait in with_db(app, |conn| queries::waits_of_run(conn, run_id))? {
        if wait.decided_at.is_none() {
            let _ = settle(app, &wait.id, "canceled", "desktop", &Value::Null);
        }
    }
    finish_parked(app, run_id, "canceled", "")?;
    Ok(true)
}

/// Ends a parked run without executing anything more.
fn finish_parked(app: &AppHandle, run_id: &str, status: &str, error: &str) -> Result<(), String> {
    let Some(run) = with_db(app, |conn| queries::get_run(conn, run_id))? else { return Ok(()) };
    let finished_at = engine::now_text();
    let duration = chrono::DateTime::parse_from_rfc3339(&run.started_at)
        .map(|start| (chrono::Utc::now() - start.with_timezone(&chrono::Utc)).num_milliseconds())
        .unwrap_or(0);
    with_db(app, |conn| queries::finish_run(conn, run_id, status, error, "", &finished_at, duration, run.data_bytes))?;
    emit_run(app, run_id);
    Ok(())
}

/// Whether `node` sits inside a loop's body in `spec`.
fn inside_a_loop(spec: &FlowSpec, node: &str) -> bool {
    spec.nodes.iter().filter(|n| n.type_id == LOOP_TYPE).any(|looping| {
        let mut seen = HashSet::new();
        let mut queue: Vec<String> = spec.connections.iter().filter(|w| w.from == looping.id && w.out == 0).map(|w| w.to.clone()).collect();
        while let Some(next) = queue.pop() {
            if next == looping.id || !seen.insert(next.clone()) {
                continue;
            }
            if next == node {
                return true;
            }
            queue.extend(spec.connections.iter().filter(|w| w.from == next).map(|w| w.to.clone()));
        }
        false
    })
}

/// A decision for a run whose node is no longer waiting in this session: the run carries on from
/// its records — see the module note.
fn pick_up(app: &AppHandle, wait: &FlowWaitRow, answer: WaitAnswer) -> Result<(), String> {
    let run = with_db(app, |conn| queries::get_run(conn, &wait.run_id))?.ok_or("The run no longer exists")?;
    if run.status != "waiting" {
        return Err("The run is no longer waiting".into());
    }
    let dir = runs::run_dir(&run.id);
    let spec: FlowSpec = std::fs::read(dir.join("spec.json"))
        .map_err(|e| e.to_string())
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
        .map_err(|e| format!("The run's records are incomplete ({e})"))?;
    let node = spec.nodes.iter().find(|n| n.id == wait.node_id).cloned().ok_or("The waiting node is not in the run's flow")?;
    if inside_a_loop(&spec, &node.id) {
        finish_parked(app, &run.id, "error", "A wait inside a loop cannot carry on after CodeFlow restarted")?;
        return Ok(());
    }
    // What a running node would have done with this ending.
    let fail_on_timeout = match node.type_id.as_str() {
        "logic.approval" => node.params.get("onTimeout").and_then(Value::as_str) == Some("fail"),
        _ => wait.kind == "webhook" || wait.kind == "form",
    };
    if answer.decision == "expired" && fail_on_timeout {
        let message = match wait.kind.as_str() {
            "webhook" => "No call arrived before the time limit",
            "form" => "Nobody filled in the form before the time limit",
            _ => "Nobody decided before the time limit",
        };
        finish_parked(app, &run.id, "error", message)?;
        return Ok(());
    }
    let inputs: Ports = read_gz(&wait_dir(&run.id).join(format!("{}.json.gz", node.id)))?;
    let decided = super::nodes::decided_ports(&node.type_id, &inputs, &answer);

    let mut seeds: HashMap<String, (Ports, bool)> = HashMap::new();
    let mut quiet = HashSet::new();
    for done in with_db(app, |conn| queries::run_nodes(conn, &run.id))? {
        let finished = matches!(done.status.as_str(), "success" | "skipped" | "disabled" | "pinned" | "reused" | "error");
        if !finished || done.node_id == node.id {
            continue;
        }
        if let Some(data) = runs::read_node_data(&run.id, &done.node_id) {
            seeds.insert(done.node_id.clone(), (data.outputs, false));
            quiet.insert(done.node_id.clone());
        }
    }
    seeds.insert(node.id.clone(), (decided, false));
    let active = if run.trigger_node.is_empty() {
        spec.nodes.iter().map(|n| n.id.clone()).collect()
    } else {
        run::downstream(&spec, &run.trigger_node)
    };
    let plan = Plan { trigger: None, active, seeds, trigger_output: None, quiet, decided: Some(node.id.clone()) };

    with_db(app, |conn| queries::set_run_status(conn, &run.id, "running"))?;
    let (vars, locale) = runs::run_environment(app, &run.workspace_id)?;
    let origin = runs::origin_of(&run.mode);
    let mut row = run.clone();
    row.status = "running".into();
    row.notify = runs::notify_setting(&spec, origin);
    let label = row.mode.clone();
    runs::launch(
        app,
        Launch { row, parsed: Arc::new(spec), plan, vars, locale, label, origin, respond: None, depth: 0, wait: false },
    );
    Ok(())
}

/// At launch: waits the last session left open keep waiting; the ones with a time limit get a timer
/// that settles them when it comes (at once, for a limit that passed while the app was closed).
pub fn arm(app: &AppHandle) {
    let Ok(open) = open_waits(app, None) else { return };
    for wait in open {
        let Some(expires) = wait.expires_at.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()) else { continue };
        let delay = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).to_std().unwrap_or(Duration::ZERO);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let decision = on_timeout(&wait.kind);
            if let Err(error) = decide_as(&app, &wait.id, decision) {
                if error != "already-decided" {
                    crate::applog::info(&format!("flows: a wait of \"{}\" could not end on time: {error}", wait.flow_name));
                }
            }
        });
    }
}

/// [`decide`] for the timer, which may settle what a person may not (`expired`).
fn decide_as(app: &AppHandle, wait_id: &str, decision: &str) -> Result<(), String> {
    let Some((row, answer)) = settle(app, wait_id, decision, "timer", &Value::Null)? else {
        return Err("already-decided".into());
    };
    let waiter = WAITERS.lock().map_err(|e| e.to_string())?.remove(wait_id);
    match waiter {
        Some(tx) => {
            let _ = tx.send(answer);
            Ok(())
        }
        None => pick_up(app, &row, answer),
    }
}

/// What a wait looks like to a phone — its own shape, so the phone never sees run internals.
pub fn phone_view(wait: &FlowWaitRow) -> Value {
    json!({
        "id": wait.id,
        "flowName": wait.flow_name,
        "nodeName": wait.node_name,
        "kind": wait.kind,
        "message": wait.message,
        "createdAt": wait.created_at,
        "expiresAt": wait.expires_at,
    })
}
