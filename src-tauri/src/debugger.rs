//! A working debugger for Node/JavaScript, driven over the V8 Inspector Protocol.
//!
//! Node ships the debugger; `node --inspect-brk` opens a WebSocket and speaks CDP over it. That
//! makes this the one runtime the app can debug with no adapter to install, no extension
//! marketplace, and nothing for the user to configure — which is why it's where debugging starts
//! rather than where it ends. Other languages need their own debug adapters (DAP), and the
//! session shape here — start, breakpoints, pause with frames, step, evaluate, stop — is
//! deliberately the DAP shape so a second backend can slot in beside this one.
//!
//! Line numbers cross this boundary 1-based, the way editors count them; CDP counts from 0 and
//! the conversion happens here so nothing above has to remember which side it's on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

/// How long to wait for Node to open its inspector port before giving up.
const ATTACH_TIMEOUT_MS: u64 = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackFrame {
    /// CDP's frame id — passed back to evaluate an expression in this frame's scope.
    pub id: String,
    pub name: String,
    /// Absolute path when the frame belongs to a real file; the raw script url otherwise
    /// (`node:internal/...` for runtime internals).
    pub file: String,
    /// 1-based.
    pub line: u32,
    /// Object id of this frame's local scope, for expanding variables.
    pub scope_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PausedEvent {
    /// `breakpoint`, `step`, `exception`, `debugCommand`…
    pub reason: String,
    pub frames: Vec<StackFrame>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputEvent {
    /// `log`, `error`, `stdout`, `stderr`.
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variable {
    pub name: String,
    /// Rendered value — a primitive's text, or a class/type name for objects.
    pub value: String,
    /// Set when the value can be expanded further.
    pub object_id: Option<String>,
}

struct Session {
    /// Outbound CDP messages. The writer task owns the socket's sink.
    outbound: mpsc::UnboundedSender<Message>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    child: Mutex<Option<tokio::process::Child>>,
    /// Breakpoints currently set, keyed by absolute file path — resent on every change because
    /// CDP has no "replace all" call.
    breakpoint_ids: Mutex<Vec<String>>,
    /// scriptId → url, accumulated from `Debugger.scriptParsed`. A paused frame identifies its
    /// script only by id on current V8 (the `url` field on a call frame is deprecated and comes
    /// back empty), so without this table a stack has line numbers and no files.
    scripts: Mutex<HashMap<String, String>>,
}

type SessionSlot = Mutex<Option<Arc<Session>>>;

fn slot() -> &'static SessionSlot {
    static SLOT: std::sync::OnceLock<SessionSlot> = std::sync::OnceLock::new();
    SLOT.get_or_init(SessionSlot::default)
}

fn current() -> Option<Arc<Session>> {
    slot().lock().ok()?.clone()
}

/// A file path as V8 reports and expects it: `file:///C:/dir/app.js`.
fn file_url(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    }
}

/// The inverse, for turning a frame's script url back into something the editor can open.
fn url_to_path(url: &str) -> String {
    match url.strip_prefix("file:///") {
        // A Windows path comes back as `C:/…`; a POSIX one lost its leading slash to the prefix.
        Some(rest) if rest.len() > 1 && rest.as_bytes()[1] == b':' => rest.replace('/', "\\"),
        Some(rest) => format!("/{rest}"),
        None => url.to_string(),
    }
}

impl Session {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        let payload = json!({ "id": id, "method": method, "params": params });
        self.outbound
            .send(Message::Text(payload.to_string().into()))
            .map_err(|_| "debug session is closed".to_string())?;
        let result = rx.await.map_err(|_| "debug session ended before replying".to_string())?;
        if let Some(error) = result.get("error") {
            return Err(error.get("message").and_then(Value::as_str).unwrap_or("CDP error").to_string());
        }
        Ok(result.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// Reads `Debugger.paused` into the frame list the UI renders. `scripts` maps script ids to
/// urls (see [`Session::scripts`]).
fn parse_paused(params: &Value, scripts: &HashMap<String, String>) -> PausedEvent {
    let reason = params.get("reason").and_then(Value::as_str).unwrap_or("pause").to_string();
    let frames = params
        .get("callFrames")
        .and_then(Value::as_array)
        .map(|frames| {
            frames
                .iter()
                .map(|frame| {
                    let location = frame.get("location").cloned().unwrap_or(Value::Null);
                    // Prefer the frame's own url when it has one, then the script table.
                    let url = frame
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|u| !u.is_empty())
                        .map(str::to_string)
                        .or_else(|| {
                            location
                                .get("scriptId")
                                .and_then(Value::as_str)
                                .and_then(|id| scripts.get(id).cloned())
                        })
                        .unwrap_or_default();
                    // The first "local" scope holds the frame's own variables; anything before it
                    // in the chain is a closure or the global object.
                    let scope_id = frame
                        .get("scopeChain")
                        .and_then(Value::as_array)
                        .and_then(|scopes| {
                            scopes
                                .iter()
                                .find(|s| s.get("type").and_then(Value::as_str) == Some("local"))
                                .or_else(|| scopes.first())
                        })
                        .and_then(|scope| scope.get("object"))
                        .and_then(|object| object.get("objectId"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    StackFrame {
                        id: frame.get("callFrameId").and_then(Value::as_str).unwrap_or_default().to_string(),
                        name: match frame.get("functionName").and_then(Value::as_str) {
                            Some(name) if !name.is_empty() => name.to_string(),
                            _ => "(anonymous)".to_string(),
                        },
                        file: url_to_path(&url),
                        line: location.get("lineNumber").and_then(Value::as_u64).unwrap_or(0) as u32 + 1,
                        scope_id,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    PausedEvent { reason, frames }
}

/// Whether a pause is the halt `--inspect-brk` always performs on the program's first statement.
///
/// Attaching requires that flag — without it the process races past any breakpoint in code that
/// runs at import time — but nobody asked to stop on line 1, so the session steps past it before
/// the UI ever hears about it. Told apart from a real stop by being the first pause of the
/// session with no breakpoint hit; an exception on the first line is still worth showing.
fn is_entry_break(is_first: bool, params: &Value) -> bool {
    if !is_first {
        return false;
    }
    // V8 labels this halt "Break on start"; older Node reports a bare "other". Matching on the
    // reason (rather than just "first pause with no breakpoint hit") is what keeps a step or a
    // manual pause that happens to be first from being swallowed as the entry break.
    let reason = params.get("reason").and_then(Value::as_str).unwrap_or_default();
    if reason != "Break on start" && reason != "other" {
        return false;
    }
    params
        .get("hitBreakpoints")
        .and_then(Value::as_array)
        .map(|hits| hits.is_empty())
        .unwrap_or(true)
}

/// Flattens a CDP `RemoteObject` into the one-line rendering the variables panel shows.
fn render_value(object: &Value) -> Variable {
    let value = object.get("value");
    let text = match object.get("type").and_then(Value::as_str) {
        Some("string") => format!("\"{}\"", value.and_then(Value::as_str).unwrap_or_default()),
        Some("undefined") => "undefined".to_string(),
        Some("function") => object
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("function")
            .lines()
            .next()
            .unwrap_or("function")
            .to_string(),
        Some("object") => object
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Object")
            .to_string(),
        _ => value
            .map(|v| v.to_string())
            .or_else(|| object.get("description").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| "undefined".to_string()),
    };
    Variable {
        name: String::new(),
        value: text,
        object_id: object.get("objectId").and_then(Value::as_str).map(str::to_string),
    }
}

/// Asks Node where its inspector WebSocket is. Polled rather than assumed: the port is open a
/// beat after the process starts, and connecting too early just fails.
async fn discover_ws_url(port: u16) -> Result<String, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ATTACH_TIMEOUT_MS);
    let client = reqwest::Client::new();
    let mut last_error = "inspector never answered".to_string();
    while std::time::Instant::now() < deadline {
        match client.get(format!("http://127.0.0.1:{port}/json/list")).send().await {
            Ok(response) => match response.json::<Vec<Value>>().await {
                Ok(targets) => {
                    if let Some(url) = targets
                        .first()
                        .and_then(|t| t.get("webSocketDebuggerUrl"))
                        .and_then(Value::as_str)
                    {
                        return Ok(url.to_string());
                    }
                    last_error = "inspector reported no debuggable target".to_string();
                }
                Err(e) => last_error = e.to_string(),
            },
            Err(e) => last_error = e.to_string(),
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
    Err(last_error)
}

/// Launches `program` under Node's inspector and attaches. `breakpoints` are applied before the
/// program is allowed to run, so a breakpoint on line 1 is honoured.
pub async fn start(
    app: AppHandle,
    cwd: &str,
    node_binary: &str,
    program: &str,
    args: &[String],
    breakpoints: &HashMap<String, Vec<u32>>,
) -> Result<(), String> {
    stop().await;

    // Port 0 would be ideal, but the inspector prints its port to stderr rather than reporting
    // it anywhere queryable, so a free one is picked here instead.
    let port = pick_free_port()?;
    let mut command = tokio::process::Command::new(node_binary);
    command
        .arg(format!("--inspect-brk=127.0.0.1:{port}"))
        .arg(program)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to launch '{node_binary}': {e}"))?;

    // The program's own stdout/stderr are the other half of debugging — without them a run that
    // prints its way to the bug tells you nothing.
    pipe_output(app.clone(), child.stdout.take(), "stdout");
    pipe_output(app.clone(), child.stderr.take(), "stderr");

    let ws_url = match discover_ws_url(port).await {
        Ok(url) => url,
        Err(e) => {
            let _ = child.kill().await;
            return Err(format!("could not attach to Node's inspector: {e}"));
        }
    };

    let (socket, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("inspector connection failed: {e}"))?;
    let (mut sink, mut stream) = socket.split();

    let (outbound, mut rx) = mpsc::unbounded_channel::<Message>();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let session = Arc::new(Session {
        outbound,
        next_id: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
        child: Mutex::new(Some(child)),
        breakpoint_ids: Mutex::new(Vec::new()),
        scripts: Mutex::new(HashMap::new()),
    });

    let reader_session = Arc::clone(&session);
    let reader_app = app.clone();
    // `--inspect-brk`'s halt on the first statement is consumed here, once.
    let entry_seen = std::sync::atomic::AtomicBool::new(false);
    tokio::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
            let Message::Text(text) = message else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };

            if let Some(id) = value.get("id").and_then(Value::as_i64) {
                if let Ok(mut pending) = reader_session.pending.lock() {
                    if let Some(tx) = pending.remove(&id) {
                        let _ = tx.send(value);
                    }
                }
                continue;
            }

            match value.get("method").and_then(Value::as_str) {
                Some("Debugger.paused") => {
                    let params = value.get("params").cloned().unwrap_or(Value::Null);
                    if is_entry_break(!entry_seen.swap(true, Ordering::Relaxed), &params) {
                        // Fire-and-forget: nothing waits on this reply, and the next thing the UI
                        // should see is a real stop.
                        let id = reader_session.next_id.fetch_add(1, Ordering::Relaxed);
                        let resume = json!({ "id": id, "method": "Debugger.resume", "params": {} });
                        let _ = reader_session.outbound.send(Message::Text(resume.to_string().into()));
                        continue;
                    }
                    let scripts = reader_session.scripts.lock().map(|s| s.clone()).unwrap_or_default();
                    let _ = reader_app.emit("debug:paused", parse_paused(&params, &scripts));
                }
                Some("Debugger.scriptParsed") => {
                    let params = value.get("params").unwrap_or(&Value::Null);
                    let id = params.get("scriptId").and_then(Value::as_str);
                    let url = params
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|u| !u.is_empty())
                        .or_else(|| params.get("embedderName").and_then(Value::as_str));
                    if let (Some(id), Some(url)) = (id, url) {
                        if let Ok(mut scripts) = reader_session.scripts.lock() {
                            scripts.insert(id.to_string(), url.to_string());
                        }
                    }
                }
                Some("Debugger.resumed") => {
                    let _ = reader_app.emit("debug:resumed", ());
                }
                Some("Runtime.consoleAPICalled") => {
                    let params = value.get("params").cloned().unwrap_or(Value::Null);
                    let kind = params.get("type").and_then(Value::as_str).unwrap_or("log").to_string();
                    let text = params
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|args| args.iter().map(|a| render_value(a).value).collect::<Vec<_>>().join(" "))
                        .unwrap_or_default();
                    let _ = reader_app.emit("debug:output", OutputEvent { kind, text });
                }
                _ => {}
            }
        }
        // The socket closing *is* the program ending: nothing else tears it down.
        let _ = reader_app.emit("debug:terminated", ());
        if let Ok(mut slot) = slot().lock() {
            slot.take();
        }
    });

    session.call("Runtime.enable", json!({})).await?;
    session.call("Debugger.enable", json!({})).await?;
    apply_breakpoints(&session, breakpoints).await?;
    // Only now is the program allowed past its first line.
    session.call("Runtime.runIfWaitingForDebugger", json!({})).await?;

    if let Ok(mut slot) = slot().lock() {
        *slot = Some(session);
    }
    Ok(())
}

fn pipe_output<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    app: AppHandle,
    pipe: Option<R>,
    kind: &'static str,
) {
    let Some(pipe) = pipe else { return };
    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit("debug:output", OutputEvent { kind: kind.to_string(), text: line });
        }
    });
}

fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

async fn apply_breakpoints(
    session: &Session,
    breakpoints: &HashMap<String, Vec<u32>>,
) -> Result<(), String> {
    let existing: Vec<String> = session
        .breakpoint_ids
        .lock()
        .map(|ids| ids.clone())
        .unwrap_or_default();
    for id in existing {
        let _ = session.call("Debugger.removeBreakpoint", json!({ "breakpointId": id })).await;
    }

    let mut fresh = Vec::new();
    for (path, lines) in breakpoints {
        for line in lines {
            let result = session
                .call(
                    "Debugger.setBreakpointByUrl",
                    json!({ "lineNumber": line.saturating_sub(1), "url": file_url(path) }),
                )
                .await?;
            if let Some(id) = result.get("breakpointId").and_then(Value::as_str) {
                fresh.push(id.to_string());
            }
        }
    }
    if let Ok(mut ids) = session.breakpoint_ids.lock() {
        *ids = fresh;
    }
    Ok(())
}

pub async fn set_breakpoints(breakpoints: &HashMap<String, Vec<u32>>) -> Result<(), String> {
    // No session yet is not an error: breakpoints are edited before a run starts far more often
    // than during one, and they're sent again at launch.
    let Some(session) = current() else { return Ok(()) };
    apply_breakpoints(&session, breakpoints).await
}

pub async fn resume() -> Result<(), String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    session.call("Debugger.resume", json!({})).await.map(|_| ())
}

pub async fn pause() -> Result<(), String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    session.call("Debugger.pause", json!({})).await.map(|_| ())
}

/// `over` | `into` | `out`.
pub async fn step(kind: &str) -> Result<(), String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let method = match kind {
        "into" => "Debugger.stepInto",
        "out" => "Debugger.stepOut",
        _ => "Debugger.stepOver",
    };
    session.call(method, json!({})).await.map(|_| ())
}

/// Expands an object into its properties — one level, on demand, because a deep object graph
/// fetched eagerly is both slow and mostly unread.
pub async fn properties(object_id: &str) -> Result<Vec<Variable>, String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let result = session
        .call(
            "Runtime.getProperties",
            json!({ "objectId": object_id, "ownProperties": true, "generatePreview": false }),
        )
        .await?;
    let mut out = Vec::new();
    if let Some(list) = result.get("result").and_then(Value::as_array) {
        for entry in list {
            let name = entry.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            // A getter has no `value` until it's called; showing it as "(getter)" beats invoking
            // side effects behind the user's back just to fill a row.
            let Some(value) = entry.get("value") else {
                out.push(Variable { name, value: "(getter)".to_string(), object_id: None });
                continue;
            };
            let mut rendered = render_value(value);
            rendered.name = name;
            out.push(rendered);
        }
    }
    Ok(out)
}

/// Evaluates an expression in a paused frame — the debug console.
pub async fn evaluate(frame_id: &str, expression: &str) -> Result<Variable, String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let result = session
        .call(
            "Debugger.evaluateOnCallFrame",
            json!({ "callFrameId": frame_id, "expression": expression, "returnByValue": false }),
        )
        .await?;
    if let Some(details) = result.get("exceptionDetails") {
        let text = details
            .get("exception")
            .map(|e| render_value(e).value)
            .or_else(|| details.get("text").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| "evaluation failed".to_string());
        return Err(text);
    }
    let object = result.get("result").cloned().unwrap_or(Value::Null);
    Ok(render_value(&object))
}

/// Ends the session and the process it was debugging. Safe to call when nothing is running.
pub async fn stop() {
    let session = slot().lock().ok().and_then(|mut s| s.take());
    let Some(session) = session else { return };
    let child = session.child.lock().ok().and_then(|mut c| c.take());
    if let Some(mut child) = child {
        crate::ai_runs::kill_tree(&mut child).await;
    }
}

pub fn is_running() -> bool {
    current().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_become_file_urls_and_back() {
        let url = file_url("C:\\repo\\src\\app.js");
        assert_eq!(url, "file:///C:/repo/src/app.js");
        assert_eq!(url_to_path(&url), "C:\\repo\\src\\app.js");
    }

    #[test]
    fn posix_paths_survive_the_round_trip() {
        let url = file_url("/home/dev/app.js");
        assert_eq!(url, "file:///home/dev/app.js");
        assert_eq!(url_to_path(&url), "/home/dev/app.js");
    }

    #[test]
    fn a_runtime_internal_url_is_left_alone() {
        assert_eq!(url_to_path("node:internal/modules/cjs/loader"), "node:internal/modules/cjs/loader");
    }

    #[test]
    fn paused_frames_carry_one_based_lines_and_their_local_scope() {
        let params = json!({
            "reason": "other",
            "callFrames": [{
                "callFrameId": "frame-1",
                "functionName": "compute",
                "url": "file:///C:/repo/app.js",
                "location": { "lineNumber": 4 },
                "scopeChain": [
                    { "type": "global", "object": { "objectId": "global-1" } },
                    { "type": "local", "object": { "objectId": "local-1" } }
                ]
            }]
        });
        let event = parse_paused(&params, &HashMap::new());
        assert_eq!(event.reason, "other");
        let frame = &event.frames[0];
        assert_eq!(frame.name, "compute");
        // CDP said 4; editors count that line as 5.
        assert_eq!(frame.line, 5);
        assert_eq!(frame.file, "C:\\repo\\app.js");
        assert_eq!(frame.scope_id.as_deref(), Some("local-1"));
    }

    #[test]
    fn the_inspect_brk_halt_is_recognized_but_a_step_never_is() {
        let entry = json!({ "reason": "Break on start", "hitBreakpoints": [] });
        assert!(is_entry_break(true, &entry));
        // Not the first pause any more: a later "other" is a genuine stop.
        assert!(!is_entry_break(false, &entry));
        // A step or a hit breakpoint must never be mistaken for it, even arriving first.
        assert!(!is_entry_break(true, &json!({ "reason": "step", "hitBreakpoints": [] })));
        assert!(!is_entry_break(true, &json!({ "reason": "other", "hitBreakpoints": ["bp-1"] })));
        assert!(!is_entry_break(true, &json!({ "reason": "exception" })));
    }

    #[test]
    fn an_anonymous_frame_still_gets_a_name() {
        let params = json!({
            "reason": "step",
            "callFrames": [{ "callFrameId": "f", "functionName": "", "url": "", "location": { "lineNumber": 0 } }]
        });
        assert_eq!(parse_paused(&params, &HashMap::new()).frames[0].name, "(anonymous)");
    }

    #[test]
    fn values_render_the_way_a_variables_panel_wants_them() {
        assert_eq!(render_value(&json!({ "type": "string", "value": "hi" })).value, "\"hi\"");
        assert_eq!(render_value(&json!({ "type": "number", "value": 42 })).value, "42");
        assert_eq!(render_value(&json!({ "type": "undefined" })).value, "undefined");
        let object = render_value(&json!({ "type": "object", "description": "Array(3)", "objectId": "o-1" }));
        assert_eq!(object.value, "Array(3)");
        assert_eq!(object.object_id.as_deref(), Some("o-1"));
    }
}

/// End-to-end checks against a real `node --inspect-brk`. Skipped when node isn't on PATH so a
/// machine without it still gets a green suite — but where node *is* available (any machine that
/// can build this app's frontend), these are what prove the debugger actually debugs.
#[cfg(test)]
mod live_tests {
    use super::*;

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    struct Fixture {
        dir: std::path::PathBuf,
        script: String,
    }

    impl Fixture {
        fn new(body: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cf-debug-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("program.js");
            std::fs::write(&script, body).unwrap();
            Fixture { script: script.to_string_lossy().into_owned(), dir }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// Drives a session without a Tauri AppHandle by talking to the inspector the same way
    /// `start` does — the parts under test (attach, breakpoints, pause, inspect, step) are all
    /// on this side of the event emitting.
    async fn attach(fixture: &Fixture, breakpoint_line: u32) -> (Arc<Session>, mpsc::UnboundedReceiver<Value>) {
        let port = pick_free_port().unwrap();
        let child = tokio::process::Command::new("node")
            .arg(format!("--inspect-brk=127.0.0.1:{port}"))
            .arg(&fixture.script)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();

        let ws_url = discover_ws_url(port).await.expect("node opened its inspector");
        let (socket, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
        let (mut sink, mut stream) = socket.split();
        let (outbound, mut out_rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(message) = out_rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });

        let session = Arc::new(Session {
            outbound,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(Some(child)),
            breakpoint_ids: Mutex::new(Vec::new()),
            scripts: Mutex::new(HashMap::new()),
        });

        let (events_tx, events_rx) = mpsc::unbounded_channel::<Value>();
        let reader = Arc::clone(&session);
        tokio::spawn(async move {
            while let Some(Ok(Message::Text(text))) = stream.next().await {
                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = value.get("id").and_then(Value::as_i64) {
                    if let Some(tx) = reader.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(value);
                    }
                    continue;
                }
                if value.get("method").and_then(Value::as_str) == Some("Debugger.scriptParsed") {
                    let params = value.get("params").unwrap_or(&Value::Null);
                    let id = params.get("scriptId").and_then(Value::as_str);
                    let url = params
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|u| !u.is_empty())
                        .or_else(|| params.get("embedderName").and_then(Value::as_str));
                    if let (Some(id), Some(url)) = (id, url) {
                        reader.scripts.lock().unwrap().insert(id.to_string(), url.to_string());
                    }
                }
                let _ = events_tx.send(value);
            }
        });

        session.call("Runtime.enable", json!({})).await.unwrap();
        session.call("Debugger.enable", json!({})).await.unwrap();
        let mut breakpoints = HashMap::new();
        breakpoints.insert(fixture.script.clone(), vec![breakpoint_line]);
        apply_breakpoints(&session, &breakpoints).await.unwrap();
        session.call("Runtime.runIfWaitingForDebugger", json!({})).await.unwrap();
        (session, events_rx)
    }

    /// Waits for the next *meaningful* `Debugger.paused`, stepping past the entry break with the
    /// same predicate the real session uses.
    async fn next_pause(
        session: &Session,
        events: &mut mpsc::UnboundedReceiver<Value>,
        first: &mut bool,
    ) -> PausedEvent {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(10);
        loop {
            let message = tokio::time::timeout_at(deadline, events.recv())
                .await
                .expect("timed out waiting for a pause")
                .expect("inspector closed");
            if message.get("method").and_then(Value::as_str) != Some("Debugger.paused") {
                continue;
            }
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let was_first = *first;
            *first = false;
            if is_entry_break(was_first, &params) {
                session.call("Debugger.resume", json!({})).await.unwrap();
                continue;
            }
            let scripts = session.scripts.lock().unwrap().clone();
            return parse_paused(&params, &scripts);
        }
    }

    #[tokio::test]
    async fn stops_on_a_breakpoint_and_can_read_the_locals() {
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        // Line 4 is `const doubled = value * 2;` — paused there, `value` exists and `doubled`
        // does not yet.
        let fixture = Fixture::new(
            "function compute(value) {\n  const label = 'x';\n  console.log(label);\n  const doubled = value * 2;\n  return doubled;\n}\ncompute(21);\n",
        );
        let (session, mut events) = attach(&fixture, 4).await;

        let mut first_pause = true;
        let paused = next_pause(&session, &mut events, &mut first_pause).await;
        assert_eq!(paused.frames[0].name, "compute");
        assert_eq!(paused.frames[0].line, 4);
        assert_eq!(paused.frames[0].file, fixture.script);

        let scope = paused.frames[0].scope_id.clone().expect("local scope");
        let result = session
            .call("Runtime.getProperties", json!({ "objectId": scope, "ownProperties": true }))
            .await
            .unwrap();
        let names: Vec<String> = result["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert!(names.contains(&"value".to_string()), "locals were {names:?}");

        // And an expression evaluated in that frame sees them.
        let evaluated = session
            .call(
                "Debugger.evaluateOnCallFrame",
                json!({ "callFrameId": paused.frames[0].id, "expression": "value + 1" }),
            )
            .await
            .unwrap();
        assert_eq!(render_value(&evaluated["result"]).value, "22");

        let child = session.child.lock().unwrap().take();
        drop(child.map(|mut c| c.start_kill()));
    }

    #[tokio::test]
    async fn stepping_over_advances_one_line() {
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        let fixture = Fixture::new("let a = 1;\nlet b = 2;\nlet c = a + b;\nconsole.log(c);\n");
        let (session, mut events) = attach(&fixture, 2).await;

        let mut first_pause = true;
        let first = next_pause(&session, &mut events, &mut first_pause).await;
        assert_eq!(first.frames[0].line, 2);

        session.call("Debugger.stepOver", json!({})).await.unwrap();
        let second = next_pause(&session, &mut events, &mut first_pause).await;
        assert_eq!(second.reason, "step");
        assert_eq!(second.frames[0].line, 3);

        let child = session.child.lock().unwrap().take();
        drop(child.map(|mut c| c.start_kill()));
    }
}
