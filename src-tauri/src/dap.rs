//! A Debug Adapter Protocol client — the generic half of debugging.
//!
//! Node is special: it ships its own debugger, so [`crate::debugger`] talks to it directly. Every
//! other language works the way VS Code works — you point the editor at a *debug adapter* for that
//! language and speak DAP to it:
//!
//! | Language | Adapter | How it's launched |
//! |---|---|---|
//! | Python | `debugpy` | `python -m debugpy.adapter` |
//! | C# / .NET | `netcoredbg` | `netcoredbg --interpreter=vscode` |
//! | Ruby | `rdbg` | `rdbg --open --stdio` |
//! | Go, Rust, Java | `dlv dap`, `codelldb`, `java-debug` | TCP (see the module's limits) |
//!
//! The adapter is a separate program the user installs — the same deal as in VS Code, where it
//! arrives inside an extension. What this module owns is the protocol, so adding a language is
//! configuration rather than code.
//!
//! Everything here reports through the same events and shapes as the Node backend
//! ([`StackFrame`], [`Variable`], `debug:paused`…), so the whole UI is backend-agnostic.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::debugger::{OutputEvent, PausedEvent, StackFrame, Variable};

struct Session {
    outbound: mpsc::UnboundedSender<String>,
    next_seq: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    child: Mutex<Option<tokio::process::Child>>,
    /// Raised when the adapter sends `initialized`, which is the only moment breakpoints may be
    /// configured — DAP is explicit about that ordering.
    ready: Arc<Notify>,
    /// The thread the adapter last stopped; stepping and stack requests are per-thread.
    stopped_thread: Mutex<Option<i64>>,
}

type SessionSlot = Mutex<Option<Arc<Session>>>;

fn slot() -> &'static SessionSlot {
    static SLOT: std::sync::OnceLock<SessionSlot> = std::sync::OnceLock::new();
    SLOT.get_or_init(SessionSlot::default)
}

fn current() -> Option<Arc<Session>> {
    slot().lock().ok()?.clone()
}

pub fn is_running() -> bool {
    current().is_some()
}

/// DAP frames a message with an HTTP-style header, exactly like LSP does.
pub fn frame(payload: &str) -> String {
    format!("Content-Length: {}\r\n\r\n{payload}", payload.as_bytes().len())
}

/// Reads one framed message. `None` means the stream ended.
pub async fn read_message<R: AsyncReadExt + Unpin>(reader: &mut R) -> Option<Value> {
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    // Headers are read a byte at a time rather than buffered: the body that follows must not be
    // swallowed by a buffered reader that overshoots the blank line.
    loop {
        if reader.read_exact(&mut byte).await.is_err() {
            return None;
        }
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if header.len() > 8192 {
            return None;
        }
    }
    let header = String::from_utf8_lossy(&header);
    let length: usize = header
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length:"))
        .and_then(|value| value.trim().parse().ok())?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await.ok()?;
    serde_json::from_slice(&body).ok()
}

impl Session {
    async fn request(&self, command: &str, arguments: Value) -> Result<Value, String> {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(seq, tx);
        let payload = json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments });
        self.outbound
            .send(payload.to_string())
            .map_err(|_| "debug adapter is gone".to_string())?;
        let response = rx.await.map_err(|_| "debug adapter closed before replying".to_string())?;
        if response.get("success").and_then(Value::as_bool) == Some(false) {
            let message = response
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the debug adapter rejected the request");
            return Err(message.to_string());
        }
        Ok(response.get("body").cloned().unwrap_or(Value::Null))
    }

    /// Fire-and-forget, for the handful of calls whose reply nothing waits on.
    fn notify(&self, command: &str, arguments: Value) {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let payload = json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments });
        let _ = self.outbound.send(payload.to_string());
    }
}

/// Turns a DAP `stackFrame` into the app's own shape. `scope_id` is filled in afterwards, once
/// the frame's scopes have been asked for.
fn parse_frame(frame: &Value) -> StackFrame {
    StackFrame {
        id: frame.get("id").map(|id| id.to_string()).unwrap_or_default(),
        name: frame.get("name").and_then(Value::as_str).unwrap_or("(anonymous)").to_string(),
        file: frame
            .get("source")
            .and_then(|source| source.get("path"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // The client asked for 1-based lines in `initialize`, so this needs no adjusting.
        line: frame.get("line").and_then(Value::as_u64).unwrap_or(0) as u32,
        scope_id: None,
    }
}

/// DAP addresses expandable values by an integer `variablesReference`; the rest of the app
/// speaks in opaque string ids. Stringifying here keeps the frontend identical across backends.
fn parse_variable(variable: &Value) -> Variable {
    let reference = variable.get("variablesReference").and_then(Value::as_i64).unwrap_or(0);
    Variable {
        name: variable.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        value: variable.get("value").and_then(Value::as_str).unwrap_or_default().to_string(),
        // 0 means "not expandable" in DAP.
        object_id: (reference != 0).then(|| reference.to_string()),
    }
}

/// After a `stopped` event, assembles the stack the UI shows. DAP splits this across three
/// round trips (threads → stackTrace → scopes) where CDP hands it over in the event itself.
async fn collect_stack(session: &Session, thread_id: i64, reason: String) -> PausedEvent {
    let frames = session
        .request("stackTrace", json!({ "threadId": thread_id, "startFrame": 0, "levels": 20 }))
        .await
        .ok()
        .and_then(|body| body.get("stackFrames").and_then(Value::as_array).cloned())
        .unwrap_or_default();

    let mut parsed: Vec<StackFrame> = frames.iter().map(parse_frame).collect();

    // Only the top frame's scope is resolved eagerly — it's the one whose variables are shown on
    // arrival, and the rest are fetched when a frame is clicked.
    if let Some(top) = parsed.first_mut() {
        if let Ok(id) = top.id.parse::<i64>() {
            if let Ok(body) = session.request("scopes", json!({ "frameId": id })).await {
                top.scope_id = body
                    .get("scopes")
                    .and_then(Value::as_array)
                    .and_then(|scopes| {
                        // Prefer the innermost non-global scope: "Locals" in most adapters.
                        scopes
                            .iter()
                            .find(|s| {
                                let name = s.get("name").and_then(Value::as_str).unwrap_or_default();
                                !name.eq_ignore_ascii_case("globals")
                            })
                            .or_else(|| scopes.first())
                    })
                    .and_then(|scope| scope.get("variablesReference"))
                    .and_then(Value::as_i64)
                    .map(|reference| reference.to_string());
            }
        }
    }

    PausedEvent { reason, frames: parsed }
}

/// Launches `command args…` as a debug adapter and starts a session with it over stdio.
///
/// `launch` is the adapter-specific configuration object — the same JSON that would live in a
/// VS Code `launch.json` entry, minus the editor-specific keys.
pub async fn start(
    app: AppHandle,
    cwd: &str,
    command: &str,
    args: &[String],
    launch: Value,
    breakpoints: &HashMap<String, Vec<u32>>,
) -> Result<(), String> {
    stop().await;

    let mut child = tokio::process::Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch the debug adapter '{command}': {e}"))?;

    let mut stdin = child.stdin.take().ok_or_else(|| "adapter has no stdin".to_string())?;
    let mut stdout = child.stdout.take().ok_or_else(|| "adapter has no stdout".to_string())?;

    let (outbound, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(payload) = rx.recv().await {
            if stdin.write_all(frame(&payload).as_bytes()).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    let session = Arc::new(Session {
        outbound,
        next_seq: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
        child: Mutex::new(Some(child)),
        ready: Arc::new(Notify::new()),
        stopped_thread: Mutex::new(None),
    });

    let reader_session = Arc::clone(&session);
    let reader_app = app.clone();
    tokio::spawn(async move {
        while let Some(message) = read_message(&mut stdout).await {
            match message.get("type").and_then(Value::as_str) {
                Some("response") => {
                    let seq = message.get("request_seq").and_then(Value::as_i64).unwrap_or(-1);
                    if let Ok(mut pending) = reader_session.pending.lock() {
                        if let Some(tx) = pending.remove(&seq) {
                            let _ = tx.send(message);
                        }
                    }
                }
                Some("event") => {
                    let body = message.get("body").cloned().unwrap_or(Value::Null);
                    match message.get("event").and_then(Value::as_str) {
                        Some("initialized") => reader_session.ready.notify_waiters(),
                        Some("stopped") => {
                            let thread_id = body.get("threadId").and_then(Value::as_i64).unwrap_or(1);
                            if let Ok(mut stopped) = reader_session.stopped_thread.lock() {
                                *stopped = Some(thread_id);
                            }
                            let reason =
                                body.get("reason").and_then(Value::as_str).unwrap_or("pause").to_string();
                            // Assembling the stack needs more round trips, which can't happen on
                            // the reader task without deadlocking on itself.
                            let stack_session = Arc::clone(&reader_session);
                            let stack_app = reader_app.clone();
                            tokio::spawn(async move {
                                let event = collect_stack(&stack_session, thread_id, reason).await;
                                let _ = stack_app.emit("debug:paused", event);
                            });
                        }
                        Some("continued") => {
                            let _ = reader_app.emit("debug:resumed", ());
                        }
                        Some("output") => {
                            let kind = match body.get("category").and_then(Value::as_str) {
                                Some("stderr") => "stderr",
                                Some("stdout") => "stdout",
                                _ => "log",
                            };
                            let text = body
                                .get("output")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .trim_end_matches('\n')
                                .to_string();
                            if !text.is_empty() {
                                let _ = reader_app
                                    .emit("debug:output", OutputEvent { kind: kind.to_string(), text });
                            }
                        }
                        Some("terminated") | Some("exited") => {
                            let _ = reader_app.emit("debug:terminated", ());
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        let _ = reader_app.emit("debug:terminated", ());
        if let Ok(mut slot) = slot().lock() {
            slot.take();
        }
    });

    // Lines and columns 1-based on the wire, so nothing downstream has to convert.
    session
        .request(
            "initialize",
            json!({
                "clientID": "codeflow",
                "clientName": "CodeFlow",
                "adapterID": launch.get("type").and_then(Value::as_str).unwrap_or("debug"),
                "locale": "en",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsVariableType": true,
                "supportsRunInTerminalRequest": false,
            }),
        )
        .await?;

    // The launch reply only arrives once the program is actually up, and some adapters withhold
    // it until `configurationDone` — so it is deliberately not awaited here.
    session.notify("launch", launch);

    // Breakpoints may only be sent between `initialized` and `configurationDone`.
    tokio::time::timeout(std::time::Duration::from_secs(10), session.ready.notified())
        .await
        .map_err(|_| "the debug adapter never reported it was initialized".to_string())?;

    for (path, lines) in breakpoints {
        let points: Vec<Value> = lines.iter().map(|line| json!({ "line": line })).collect();
        let _ = session
            .request(
                "setBreakpoints",
                json!({ "source": { "path": path }, "breakpoints": points }),
            )
            .await;
    }
    let _ = session.request("configurationDone", json!({})).await;

    if let Ok(mut slot) = slot().lock() {
        *slot = Some(session);
    }
    Ok(())
}

pub async fn set_breakpoints(breakpoints: &HashMap<String, Vec<u32>>) -> Result<(), String> {
    let Some(session) = current() else { return Ok(()) };
    for (path, lines) in breakpoints {
        let points: Vec<Value> = lines.iter().map(|line| json!({ "line": line })).collect();
        session
            .request("setBreakpoints", json!({ "source": { "path": path }, "breakpoints": points }))
            .await?;
    }
    Ok(())
}

fn stopped_thread(session: &Session) -> i64 {
    session.stopped_thread.lock().ok().and_then(|t| *t).unwrap_or(1)
}

pub async fn resume() -> Result<(), String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let thread = stopped_thread(&session);
    session.request("continue", json!({ "threadId": thread })).await?;
    Ok(())
}

pub async fn pause() -> Result<(), String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let thread = stopped_thread(&session);
    session.request("pause", json!({ "threadId": thread })).await?;
    Ok(())
}

pub async fn step(kind: &str) -> Result<(), String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let thread = stopped_thread(&session);
    let command = match kind {
        "into" => "stepIn",
        "out" => "stepOut",
        _ => "next",
    };
    session.request(command, json!({ "threadId": thread })).await?;
    Ok(())
}

pub async fn properties(object_id: &str) -> Result<Vec<Variable>, String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let reference: i64 = object_id.parse().map_err(|_| "not an expandable value".to_string())?;
    let body = session.request("variables", json!({ "variablesReference": reference })).await?;
    Ok(body
        .get("variables")
        .and_then(Value::as_array)
        .map(|list| list.iter().map(parse_variable).collect())
        .unwrap_or_default())
}

pub async fn evaluate(frame_id: &str, expression: &str) -> Result<Variable, String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let frame: i64 = frame_id.parse().map_err(|_| "no frame selected".to_string())?;
    let body = session
        .request(
            "evaluate",
            json!({ "expression": expression, "frameId": frame, "context": "repl" }),
        )
        .await?;
    let reference = body.get("variablesReference").and_then(Value::as_i64).unwrap_or(0);
    Ok(Variable {
        name: String::new(),
        value: body.get("result").and_then(Value::as_str).unwrap_or_default().to_string(),
        object_id: (reference != 0).then(|| reference.to_string()),
    })
}

pub async fn stop() {
    let session = slot().lock().ok().and_then(|mut s| s.take());
    let Some(session) = session else { return };
    // Ask politely first: `disconnect` lets the adapter kill the debuggee it started and clean
    // up, which killing the adapter outright would skip.
    session.notify("disconnect", json!({ "terminateDebuggee": true }));
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let child = session.child.lock().ok().and_then(|mut c| c.take());
    if let Some(mut child) = child {
        crate::ai_runs::kill_tree(&mut child).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_framed_with_their_byte_length() {
        // Byte length, not character count — a header that counts characters desynchronizes the
        // stream the first time an adapter sends a non-ASCII value.
        assert_eq!(frame("{\"a\":1}"), "Content-Length: 7\r\n\r\n{\"a\":1}");
        assert_eq!(frame("{\"a\":\"ñ\"}"), "Content-Length: 10\r\n\r\n{\"a\":\"ñ\"}");
    }

    #[tokio::test]
    async fn reads_back_a_framed_message() {
        let mut stream = std::io::Cursor::new(frame("{\"type\":\"event\",\"event\":\"initialized\"}").into_bytes());
        let message = read_message(&mut stream).await.expect("a message");
        assert_eq!(message["event"], "initialized");
    }

    #[tokio::test]
    async fn reads_consecutive_messages_without_losing_the_second() {
        let mut bytes = frame("{\"seq\":1}").into_bytes();
        bytes.extend(frame("{\"seq\":2}").into_bytes());
        let mut stream = std::io::Cursor::new(bytes);
        assert_eq!(read_message(&mut stream).await.unwrap()["seq"], 1);
        assert_eq!(read_message(&mut stream).await.unwrap()["seq"], 2);
        assert!(read_message(&mut stream).await.is_none());
    }

    #[test]
    fn frames_and_variables_map_onto_the_shared_shapes() {
        let frame = parse_frame(&json!({
            "id": 7,
            "name": "compute",
            "line": 12,
            "source": { "path": "C:\\repo\\app.py" }
        }));
        assert_eq!(frame.id, "7");
        assert_eq!(frame.name, "compute");
        assert_eq!(frame.line, 12);
        assert_eq!(frame.file, "C:\\repo\\app.py");

        let expandable = parse_variable(&json!({ "name": "items", "value": "list", "variablesReference": 3 }));
        assert_eq!(expandable.object_id.as_deref(), Some("3"));
        // 0 is DAP's "nothing to expand".
        let plain = parse_variable(&json!({ "name": "n", "value": "42", "variablesReference": 0 }));
        assert_eq!(plain.object_id, None);
    }
}

/// End-to-end against a real adapter. Python's `debugpy` stands in for the whole family: if the
/// protocol works with one adapter it works with the others, because the adapter is exactly the
/// part that isn't ours. Skipped when debugpy isn't installed.
#[cfg(test)]
mod live_tests {
    use super::*;
    use tokio::io::BufReader;
    use tokio::process::Command;

    fn debugpy_available() -> bool {
        std::process::Command::new("python")
            .args(["-c", "import debugpy"])
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
            let dir = std::env::temp_dir().join(format!("cf-dap-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("program.py");
            std::fs::write(&script, body).unwrap();
            Fixture { script: script.to_string_lossy().into_owned(), dir }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// Runs a session against `python -m debugpy.adapter`, returning the session plus a channel
    /// of the events it emitted — the same plumbing `start` builds, minus the Tauri handle.
    async fn attach(fixture: &Fixture, line: u32) -> (Arc<Session>, mpsc::UnboundedReceiver<Value>) {
        let mut child = Command::new("python")
            .args(["-m", "debugpy.adapter"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let (outbound, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(payload) = rx.recv().await {
                if stdin.write_all(frame(&payload).as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        let session = Arc::new(Session {
            outbound,
            next_seq: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(Some(child)),
            ready: Arc::new(Notify::new()),
            stopped_thread: Mutex::new(None),
        });

        let (events_tx, events_rx) = mpsc::unbounded_channel::<Value>();
        let reader = Arc::clone(&session);
        tokio::spawn(async move {
            let mut stdout = BufReader::new(stdout);
            while let Some(message) = read_message(&mut stdout).await {
                if message.get("type").and_then(Value::as_str) == Some("response") {
                    let seq = message.get("request_seq").and_then(Value::as_i64).unwrap_or(-1);
                    if let Some(tx) = reader.pending.lock().unwrap().remove(&seq) {
                        let _ = tx.send(message);
                    }
                    continue;
                }
                if message.get("event").and_then(Value::as_str) == Some("initialized") {
                    reader.ready.notify_waiters();
                }
                if message.get("event").and_then(Value::as_str) == Some("stopped") {
                    let thread = message["body"]["threadId"].as_i64().unwrap_or(1);
                    *reader.stopped_thread.lock().unwrap() = Some(thread);
                }
                let _ = events_tx.send(message);
            }
        });

        session
            .request(
                "initialize",
                json!({
                    "clientID": "codeflow-test",
                    "adapterID": "python",
                    "linesStartAt1": true,
                    "columnsStartAt1": true,
                    "pathFormat": "path",
                }),
            )
            .await
            .expect("adapter initialized");

        session.notify(
            "launch",
            json!({
                "type": "python",
                "request": "launch",
                "program": fixture.script,
                "console": "internalConsole",
                "justMyCode": true,
                "python": ["python"],
            }),
        );

        tokio::time::timeout(std::time::Duration::from_secs(20), session.ready.notified())
            .await
            .expect("adapter reported initialized");

        session
            .request(
                "setBreakpoints",
                json!({ "source": { "path": fixture.script }, "breakpoints": [{ "line": line }] }),
            )
            .await
            .expect("breakpoint accepted");
        session.request("configurationDone", json!({})).await.ok();
        (session, events_rx)
    }

    async fn next_stop(events: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(25);
        loop {
            let message = tokio::time::timeout_at(deadline, events.recv())
                .await
                .expect("timed out waiting for a stop")
                .expect("adapter closed");
            if message.get("event").and_then(Value::as_str) == Some("stopped") {
                return message;
            }
        }
    }

    #[tokio::test]
    async fn debugs_python_through_debugpy() {
        if !debugpy_available() {
            eprintln!("skipping: debugpy not installed");
            return;
        }
        // Breakpoint on line 3, where `total` is already bound.
        let fixture = Fixture::new("def add(a, b):\n    total = a + b\n    return total\n\nadd(2, 40)\n");
        let (session, mut events) = attach(&fixture, 3).await;

        let stopped = next_stop(&mut events).await;
        assert_eq!(stopped["body"]["reason"], "breakpoint");

        let thread = stopped["body"]["threadId"].as_i64().unwrap();
        let paused = collect_stack(&session, thread, "breakpoint".to_string()).await;
        assert_eq!(paused.frames[0].name, "add");
        assert_eq!(paused.frames[0].line, 3);
        assert_eq!(paused.frames[0].file, fixture.script);

        // The locals of the stopped frame, through the same call the variables panel makes.
        let scope = paused.frames[0].scope_id.clone().expect("a local scope");
        let reference: i64 = scope.parse().unwrap();
        let body = session
            .request("variables", json!({ "variablesReference": reference }))
            .await
            .unwrap();
        let variables: Vec<Variable> = body["variables"].as_array().unwrap().iter().map(parse_variable).collect();
        let total = variables.iter().find(|v| v.name == "total").expect("total is in scope");
        assert_eq!(total.value, "42");

        // And an expression evaluated in that frame sees them too.
        let evaluated = session
            .request(
                "evaluate",
                json!({ "expression": "a * b", "frameId": paused.frames[0].id.parse::<i64>().unwrap(), "context": "repl" }),
            )
            .await
            .unwrap();
        assert_eq!(evaluated["result"], "80");

        session.notify("disconnect", json!({ "terminateDebuggee": true }));
        let child = session.child.lock().unwrap().take();
        drop(child.map(|mut c| c.start_kill()));
    }
}
