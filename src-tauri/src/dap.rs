//! A Debug Adapter Protocol client — the generic half of debugging.
//!
//! Node is special: it ships its own debugger, so [`crate::debugger`] talks to it directly. Every
//! other language works the way VS Code works — you point the editor at a *debug adapter* for that
//! language and speak DAP to it:
//!
//! | Language | Adapter | How it's launched |
//! |---|---|---|
//! | Python | `debugpy` | `python3 -m debugpy.adapter` |
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
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::debugger::{BreakpointSpec, Breakpoints, ExceptionFilter, OutputEvent, PausedEvent, StackFrame, Variable};

/// How long an adapter gets to answer `initialize` and to raise `initialized`.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long `start` waits for the answer to `launch` once configuration is done, before letting the
/// session run and watching for a late refusal in the background.
const LAUNCH_REPLY_TIMEOUT: Duration = Duration::from_secs(8);

struct Session {
    outbound: mpsc::UnboundedSender<String>,
    next_seq: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    child: Mutex<Option<tokio::process::Child>>,
    /// Raised when the adapter sends `initialized`, which is the only moment breakpoints may be
    /// configured — DAP is explicit about that ordering.
    ///
    /// Raised with `notify_one`, which **stores a permit** when nobody is waiting yet. That is the
    /// fix for the one race this handshake has: most adapters (netcoredbg, and nearly every custom
    /// one) send `initialized` straight after answering `initialize` — before `start` has got as far
    /// as waiting for it. `notify_waiters`, which it used to be, wakes only a waiter that already
    /// exists, so the event was dropped on the floor and every such adapter timed out after ten
    /// seconds; only debugpy, which raises it later, ever worked.
    ready: Notify,
    /// The thread the adapter last stopped; stepping and stack requests are per-thread.
    stopped_thread: Mutex<Option<i64>>,
    /// The exception filters the adapter offered in its `initialize` reply.
    exception_filters: Mutex<Vec<ExceptionFilter>>,
    /// The stop the program is sitting in, for a panel that mounts mid-pause (the webview
    /// reloaded) — see [`paused_state`].
    paused: Mutex<Option<PausedEvent>>,
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

/// A response's body, or the adapter's own words for why it refused.
fn response_body(response: Value) -> Result<Value, String> {
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        let message = response
            .get("body")
            .and_then(|body| body.get("error"))
            .and_then(|error| error.get("format"))
            .and_then(Value::as_str)
            .or_else(|| response.get("message").and_then(Value::as_str))
            .unwrap_or("the debug adapter rejected the request");
        return Err(message.to_string());
    }
    Ok(response.get("body").cloned().unwrap_or(Value::Null))
}

impl Session {
    /// Sends a request and hands back the channel its response will arrive on, without waiting —
    /// for `launch`, whose answer comes whenever the adapter decides.
    fn send(&self, command: &str, arguments: Value) -> Result<oneshot::Receiver<Value>, String> {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(seq, tx);
        let payload = json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments });
        self.outbound
            .send(payload.to_string())
            .map_err(|_| "debug adapter is gone".to_string())?;
        Ok(rx)
    }

    async fn request(&self, command: &str, arguments: Value) -> Result<Value, String> {
        let rx = self.send(command, arguments)?;
        let response = rx.await.map_err(|_| "debug adapter closed before replying".to_string())?;
        response_body(response)
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

/// A `scopes` reply as rows the variables panel can expand: "Locals", "Globals"…
fn parse_scopes(body: &Value) -> Vec<Variable> {
    body.get("scopes")
        .and_then(Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .map(|scope| Variable {
                    name: scope.get("name").and_then(Value::as_str).unwrap_or("Scope").to_string(),
                    value: String::new(),
                    object_id: scope
                        .get("variablesReference")
                        .and_then(Value::as_i64)
                        .filter(|reference| *reference != 0)
                        .map(|reference| reference.to_string()),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The exception filters an adapter's capabilities offer — debugpy's "Raised exceptions" and
/// "Uncaught exceptions", netcoredbg's "All" and "User-Unhandled".
fn parse_exception_filters(capabilities: &Value) -> Vec<ExceptionFilter> {
    capabilities
        .get("exceptionBreakpointFilters")
        .and_then(Value::as_array)
        .map(|filters| {
            filters
                .iter()
                .filter_map(|filter| {
                    let id = filter.get("filter").and_then(Value::as_str)?;
                    Some(ExceptionFilter {
                        filter: id.to_string(),
                        label: filter.get("label").and_then(Value::as_str).unwrap_or(id).to_string(),
                        default: filter.get("default").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The filters to enable: what the user chose, kept to the ones this adapter knows; or, when they
/// never chose for it, the adapter's own defaults.
fn chosen_filters(offered: &[ExceptionFilter], wanted: Option<&[String]>) -> Vec<String> {
    match wanted {
        Some(wanted) => offered
            .iter()
            .filter(|f| wanted.contains(&f.filter))
            .map(|f| f.filter.clone())
            .collect(),
        None => offered.iter().filter(|f| f.default).map(|f| f.filter.clone()).collect(),
    }
}

/// One file's breakpoints as `setBreakpoints` takes them. A condition or log message the adapter
/// does not support is ignored by it, which is the protocol's own rule.
fn source_breakpoints(specs: &[BreakpointSpec]) -> Vec<Value> {
    specs
        .iter()
        .map(|spec| {
            let mut point = json!({ "line": spec.line });
            if let Some(condition) = spec.condition.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                point["condition"] = json!(condition);
            }
            if let Some(message) = spec.log_message.as_deref().filter(|m| !m.trim().is_empty()) {
                point["logMessage"] = json!(message);
            }
            point
        })
        .collect()
}

/// After a `stopped` event, assembles the stack the UI shows. DAP splits this across three
/// round trips (threads → stackTrace → scopes) where CDP hands it over in the event itself.
async fn collect_stack(session: &Session, thread_id: i64, reason: String, description: Option<String>) -> PausedEvent {
    let frames = session
        .request("stackTrace", json!({ "threadId": thread_id, "startFrame": 0, "levels": 20 }))
        .await
        .ok()
        .and_then(|body| body.get("stackFrames").and_then(Value::as_array).cloned())
        .unwrap_or_default();

    let mut parsed: Vec<StackFrame> = frames.iter().map(parse_frame).collect();

    // Only the top frame's scope is resolved eagerly — it's the one whose variables are shown on
    // arrival. Any other frame's are asked for when it is clicked (see [`scopes`]).
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

    PausedEvent { reason, frames: parsed, description }
}

/// Launches `command args…` as a debug adapter and starts a session with it over stdio. Answers
/// with the exception filters the adapter offers, for the panel to show.
///
/// `launch` is the adapter-specific configuration object — the same JSON that would live in a
/// VS Code `launch.json` entry, minus the editor-specific keys. `exception_filters` is what the user
/// chose for this adapter; `None` takes the adapter's own defaults.
pub async fn start<R: Runtime>(
    app: AppHandle<R>,
    cwd: &str,
    command: &str,
    args: &[String],
    launch: Value,
    breakpoints: &Breakpoints,
    exception_filters: Option<&[String]>,
) -> Result<Vec<ExceptionFilter>, String> {
    stop().await;

    let mut adapter = crate::proc::command(command);
    adapter
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // A group of its own, so Stop — and quitting the app — reaches the debuggee the adapter started
    // as well as the adapter. See `ai_runs::kill_tree`.
    crate::proc::own_process_group(&mut adapter);
    let mut child = adapter
        .spawn()
        .map_err(|e| format!("failed to launch the debug adapter '{command}': {e}"))?;

    let mut stdin = child.stdin.take().ok_or_else(|| "adapter has no stdin".to_string())?;
    let mut stdout = child.stdout.take().ok_or_else(|| "adapter has no stdout".to_string())?;
    // Read, or a chatty adapter fills the pipe and blocks. It is also where an adapter that cannot
    // start says why — `No module named debugpy` — so it goes to the console rather than nowhere,
    // and its last line is kept for the error a failed start reports.
    let stderr_tail: Arc<Mutex<Option<String>>> = Arc::default();
    if let Some(stderr) = child.stderr.take() {
        let stderr_app = app.clone();
        let tail = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    if let Ok(mut tail) = tail.lock() {
                        *tail = Some(line.clone());
                    }
                }
                let _ = stderr_app.emit("debug:output", OutputEvent { kind: "stderr".into(), text: line });
            }
        });
    }

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
        ready: Notify::new(),
        stopped_thread: Mutex::new(None),
        exception_filters: Mutex::new(Vec::new()),
        paused: Mutex::new(None),
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
                        Some("initialized") => reader_session.ready.notify_one(),
                        Some("stopped") => {
                            let thread_id = body.get("threadId").and_then(Value::as_i64).unwrap_or(1);
                            if let Ok(mut stopped) = reader_session.stopped_thread.lock() {
                                *stopped = Some(thread_id);
                            }
                            let reason =
                                body.get("reason").and_then(Value::as_str).unwrap_or("pause").to_string();
                            let description = body
                                .get("text")
                                .or_else(|| body.get("description"))
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            // Assembling the stack needs more round trips, which can't happen on
                            // the reader task without deadlocking on itself.
                            let stack_session = Arc::clone(&reader_session);
                            let stack_app = reader_app.clone();
                            tokio::spawn(async move {
                                let event = collect_stack(&stack_session, thread_id, reason, description).await;
                                if let Ok(mut paused) = stack_session.paused.lock() {
                                    *paused = Some(event.clone());
                                }
                                let _ = stack_app.emit("debug:paused", event);
                            });
                        }
                        Some("continued") => {
                            if let Ok(mut paused) = reader_session.paused.lock() {
                                paused.take();
                            }
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
                        // The program is over; the adapter may linger, so the session is ended
                        // from here rather than left for the adapter to exit.
                        Some("terminated") => {
                            let ending = Arc::clone(&reader_session);
                            let ending_app = reader_app.clone();
                            tokio::spawn(async move { finish(&ending_app, &ending).await });
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        finish(&reader_app, &reader_session).await;
    });

    // In the slot before the handshake, so that a Stop pressed while it runs — or a failure in it —
    // reaches the adapter instead of leaving it running with nothing on screen to end it.
    if let Ok(mut slot) = slot().lock() {
        *slot = Some(Arc::clone(&session));
    }
    match handshake(&app, &session, launch, breakpoints, exception_filters).await {
        Ok(filters) => Ok(filters),
        Err(e) => {
            stop().await;
            // An adapter that died on the way up said why on stderr — a missing module, a bad flag.
            // That line is the error worth reading; "closed before replying" alone is not.
            let said = stderr_tail.lock().ok().and_then(|tail| tail.clone());
            Err(match said {
                Some(line) if e.contains("closed before") => format!("{e}: {line}"),
                _ => e,
            })
        }
    }
}

/// `initialize` → `launch` → (`initialized`) → breakpoints → `configurationDone`, with the launch's
/// own answer collected whenever it comes.
async fn handshake<R: Runtime>(
    app: &AppHandle<R>,
    session: &Arc<Session>,
    launch: Value,
    breakpoints: &Breakpoints,
    exception_filters: Option<&[String]>,
) -> Result<Vec<ExceptionFilter>, String> {
    // Lines and columns 1-based on the wire, so nothing downstream has to convert.
    let initialize = session.request(
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
    );
    let capabilities = tokio::time::timeout(INITIALIZE_TIMEOUT, initialize)
        .await
        .map_err(|_| "the debug adapter never answered `initialize`".to_string())??;
    let offered = parse_exception_filters(&capabilities);
    if let Ok(mut filters) = session.exception_filters.lock() {
        *filters = offered.clone();
    }

    // `launch` is answered whenever the adapter decides: at once (netcoredbg), or only after
    // `configurationDone` (debugpy). So it is sent now and its answer collected later — but it is a
    // real request, not fire-and-forget: a launch the adapter refuses ("program not found") is the
    // error the user needs to read, and it used to vanish, leaving a ten-second wait for an
    // `initialized` that a failed launch never sends.
    let mut launch_reply = session.send("launch", launch)?;
    let mut launched = false;

    // Breakpoints may only be sent between `initialized` and `configurationDone`.
    let deadline = tokio::time::sleep(INITIALIZE_TIMEOUT);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = session.ready.notified() => break,
            reply = &mut launch_reply, if !launched => {
                let reply = reply.map_err(|_| "the debug adapter closed before answering `launch`".to_string())?;
                response_body(reply)?;
                launched = true;
            }
            _ = &mut deadline => return Err("the debug adapter never reported it was initialized".to_string()),
        }
    }

    for (path, specs) in breakpoints {
        let _ = session
            .request(
                "setBreakpoints",
                json!({ "source": { "path": path }, "breakpoints": source_breakpoints(specs) }),
            )
            .await;
    }
    // Only for an adapter that offered filters — the protocol's own condition for sending it.
    if !offered.is_empty() {
        let filters = chosen_filters(&offered, exception_filters);
        let _ = session.request("setExceptionBreakpoints", json!({ "filters": filters })).await;
    }
    let _ = session.request("configurationDone", json!({})).await;

    if !launched {
        let waited = tokio::time::timeout(LAUNCH_REPLY_TIMEOUT, &mut launch_reply).await;
        match waited {
            Ok(Ok(reply)) => {
                response_body(reply)?;
            }
            Ok(Err(_)) => return Err("the debug adapter closed before answering `launch`".to_string()),
            // Still starting — a big program, a slow build. The session runs, and a refusal that
            // arrives later is still reported rather than lost.
            Err(_) => {
                let late_app = app.clone();
                let late_session = Arc::clone(session);
                tokio::spawn(async move {
                    let Ok(reply) = launch_reply.await else { return };
                    if let Err(message) = response_body(reply) {
                        let _ = late_app.emit("debug:output", OutputEvent { kind: "error".into(), text: message });
                        finish(&late_app, &late_session).await;
                    }
                });
            }
        }
    }
    Ok(offered)
}

/// A session that is over: told to the panel — unless it was stopped from here, which the panel
/// already knows, or replaced by a newer one, which a stale "terminated" would reset — and its
/// adapter ended. Safe to reach twice (the `terminated` event, then the adapter's stdout closing).
async fn finish<R: Runtime>(app: &AppHandle<R>, session: &Arc<Session>) {
    // Every request still waiting is answered with an error now, rather than hanging on an adapter
    // that will never speak again.
    if let Ok(mut pending) = session.pending.lock() {
        pending.clear();
    }
    let was_current = slot()
        .lock()
        .map(|mut slot| {
            let current = slot.as_ref().is_some_and(|live| Arc::ptr_eq(live, session));
            if current {
                slot.take();
            }
            current
        })
        .unwrap_or(false);
    if was_current {
        let _ = app.emit("debug:terminated", ());
    }
    end_adapter(session).await;
}

/// Asks the adapter to go, then makes sure it has.
async fn end_adapter(session: &Session) {
    let child = session.child.lock().ok().and_then(|mut c| c.take());
    let Some(mut child) = child else { return };
    // Ask politely first: `disconnect` lets the adapter kill the debuggee it started and clean
    // up, which killing the adapter outright would skip.
    session.notify("disconnect", json!({ "terminateDebuggee": true }));
    tokio::time::sleep(Duration::from_millis(150)).await;
    crate::ai_runs::kill_tree(&mut child).await;
}

pub async fn set_breakpoints(breakpoints: &Breakpoints) -> Result<(), String> {
    let Some(session) = current() else { return Ok(()) };
    for (path, specs) in breakpoints {
        session
            .request(
                "setBreakpoints",
                json!({ "source": { "path": path }, "breakpoints": source_breakpoints(specs) }),
            )
            .await?;
    }
    Ok(())
}

pub async fn set_exception_filters(filters: &[String]) -> Result<(), String> {
    let Some(session) = current() else { return Ok(()) };
    let offered = session.exception_filters.lock().map(|f| f.clone()).unwrap_or_default();
    if offered.is_empty() {
        return Ok(());
    }
    let chosen = chosen_filters(&offered, Some(filters));
    session.request("setExceptionBreakpoints", json!({ "filters": chosen })).await.map(|_| ())
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

/// The scopes of any paused frame, not only the top one — the call a click on a frame makes.
pub async fn scopes(frame_id: &str) -> Result<Vec<Variable>, String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let frame: i64 = frame_id.parse().map_err(|_| "no frame selected".to_string())?;
    let body = session.request("scopes", json!({ "frameId": frame })).await?;
    Ok(parse_scopes(&body))
}

/// `context` is DAP's own: `repl` for the console, `watch` for the watch list.
pub async fn evaluate(frame_id: &str, expression: &str, context: Option<&str>) -> Result<Variable, String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let frame: i64 = frame_id.parse().map_err(|_| "no frame selected".to_string())?;
    let body = session
        .request(
            "evaluate",
            json!({ "expression": expression, "frameId": frame, "context": context.unwrap_or("repl") }),
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
    end_adapter(&session).await;
}

/// Where the running program is stopped, if it is.
pub fn paused_state() -> Option<PausedEvent> {
    let session = current()?;
    let paused = session.paused.lock().ok()?;
    paused.clone()
}

/// The exception filters the running adapter offered.
pub fn offered_exception_filters() -> Vec<ExceptionFilter> {
    current()
        .and_then(|session| session.exception_filters.lock().ok().map(|f| f.clone()))
        .unwrap_or_default()
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

    #[test]
    fn scopes_become_expandable_rows() {
        let rows = parse_scopes(&json!({ "scopes": [
            { "name": "Locals", "variablesReference": 5 },
            { "name": "Globals", "variablesReference": 6, "expensive": true },
            { "name": "Empty", "variablesReference": 0 }
        ] }));
        assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["Locals", "Globals", "Empty"]);
        assert_eq!(rows[0].object_id.as_deref(), Some("5"));
        assert_eq!(rows[2].object_id, None);
    }

    #[test]
    fn breakpoints_carry_their_condition_and_log_message() {
        let points = source_breakpoints(&[
            BreakpointSpec { line: 3, condition: None, log_message: None },
            BreakpointSpec { line: 5, condition: Some("x > 1".into()), log_message: None },
            BreakpointSpec { line: 8, condition: Some(" ".into()), log_message: Some("x={x}".into()) },
        ]);
        assert_eq!(points[0], json!({ "line": 3 }));
        assert_eq!(points[1], json!({ "line": 5, "condition": "x > 1" }));
        assert_eq!(points[2], json!({ "line": 8, "logMessage": "x={x}" }));
    }

    #[test]
    fn exception_filters_follow_the_user_or_the_adapters_defaults() {
        let offered = parse_exception_filters(&json!({ "exceptionBreakpointFilters": [
            { "filter": "raised", "label": "Raised Exceptions", "default": false },
            { "filter": "uncaught", "label": "Uncaught Exceptions", "default": true },
            { "label": "no id, ignored" }
        ] }));
        assert_eq!(offered.len(), 2);
        assert_eq!(chosen_filters(&offered, None), vec!["uncaught".to_string()]);
        assert_eq!(chosen_filters(&offered, Some(&["raised".into(), "unknown".into()])), vec!["raised".to_string()]);
        assert!(chosen_filters(&offered, Some(&[])).is_empty());
    }

    #[test]
    fn a_refusal_is_reported_in_the_adapters_own_words() {
        assert_eq!(response_body(json!({ "success": true, "body": { "a": 1 } })).unwrap(), json!({ "a": 1 }));
        assert_eq!(
            response_body(json!({ "success": false, "message": "launch failed" })).unwrap_err(),
            "launch failed"
        );
        // The structured error, when there is one, says more than the short message.
        assert_eq!(
            response_body(json!({ "success": false, "message": "x", "body": { "error": { "format": "program not found: /a.py" } } }))
                .unwrap_err(),
            "program not found: /a.py"
        );
    }
}

/// A scripted adapter, written in JavaScript and run with Node, drives the real `start` through the
/// two handshakes that used to break: an adapter that raises `initialized` straight after answering
/// `initialize` (it timed out), and one that refuses `launch` (the error was lost). Skipped when
/// node isn't on PATH.
#[cfg(test)]
mod handshake_tests {
    use super::*;
    use tauri::Listener;

    const FAKE_ADAPTER: &str = r#"
const mode = process.argv[2];
let buffer = Buffer.alloc(0);
let seq = 1;
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const reply = (request, body, success = true, message) =>
  send({ type: "response", request_seq: request.seq, command: request.command, success, body, message });
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.slice(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const request = JSON.parse(buffer.slice(end + 4, end + 4 + length).toString());
    buffer = buffer.slice(end + 4 + length);
    handle(request);
  }
});
function handle(request) {
  switch (request.command) {
    case "initialize":
      reply(request, { exceptionBreakpointFilters: [{ filter: "all", label: "All", default: true }] });
      // Straight away, before anything else was asked: the race.
      if (mode === "eager") send({ type: "event", event: "initialized" });
      break;
    case "launch":
      if (mode === "refuse") reply(request, undefined, false, "program not found: nowhere.py");
      else reply(request, {});
      break;
    case "setBreakpoints":
      reply(request, { breakpoints: request.arguments.breakpoints.map((b) => ({ verified: true, line: b.line })) });
      break;
    case "setExceptionBreakpoints":
      process.stderr.write(`filters=${request.arguments.filters.join(",")}\n`);
      reply(request, {});
      break;
    case "configurationDone":
      reply(request, {});
      send({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } });
      break;
    case "stackTrace":
      reply(request, { stackFrames: [{ id: 11, name: "main", line: 4, source: { path: "/tmp/app.py" } }] });
      break;
    case "scopes":
      reply(request, { scopes: [{ name: "Locals", variablesReference: 21 }, { name: "Globals", variablesReference: 22 }] });
      break;
    case "disconnect":
      reply(request, {});
      process.exit(0);
    default:
      reply(request, {});
  }
}
"#;

    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// One test, not two: both runs go through the one global session slot, and two tests on it in
    /// parallel would stop each other.
    #[tokio::test]
    async fn an_eager_initialized_is_not_missed_and_a_refused_launch_is_reported() {
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        let dir = std::env::temp_dir().join(format!("cf-dap-fake-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("adapter.js");
        std::fs::write(&script, FAKE_ADAPTER).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let app = tauri::test::mock_app();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let paused = tx.clone();
        app.listen_any("debug:paused", move |event| {
            let _ = paused.send(format!("paused {}", event.payload()));
        });
        app.listen_any("debug:output", move |event| {
            let _ = tx.send(format!("output {}", event.payload()));
        });

        // An adapter that raises `initialized` as it answers `initialize`: this used to time out.
        let mut breakpoints = Breakpoints::new();
        breakpoints.insert("/tmp/app.py".into(), vec![BreakpointSpec { line: 4, ..BreakpointSpec::default() }]);
        let started = tokio::time::Instant::now();
        let offered = start(
            app.handle().clone(),
            &cwd,
            "node",
            &[script.to_string_lossy().into_owned(), "eager".into()],
            json!({ "type": "fake", "request": "launch" }),
            &breakpoints,
            None,
        )
        .await
        .expect("the eager adapter starts");
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
        assert_eq!(offered, vec![ExceptionFilter { filter: "all".into(), label: "All".into(), default: true }]);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut seen: Vec<String> = Vec::new();
        // The stop, and the adapter's default filter applied — the user never chose one.
        while !(seen.iter().any(|line| line.starts_with("paused")) && seen.iter().any(|line| line.contains("filters=all"))) {
            seen.push(tokio::time::timeout_at(deadline, rx.recv()).await.expect("a stop and the filters").unwrap());
        }
        let stop_line = seen.iter().find(|line| line.starts_with("paused")).unwrap();
        assert!(stop_line.contains("\"line\":4"), "{stop_line}");
        // Any frame's scopes, on demand.
        let rows = scopes("11").await.unwrap();
        assert_eq!(rows[1].name, "Globals");
        assert!(paused_state().is_some());
        stop().await;
        assert!(!is_running());

        // An adapter that refuses `launch`: its reason is the error, not a ten-second silence.
        let started = tokio::time::Instant::now();
        let refused = start(
            app.handle().clone(),
            &cwd,
            "node",
            &[script.to_string_lossy().into_owned(), "refuse".into()],
            json!({ "type": "fake", "request": "launch" }),
            &Breakpoints::new(),
            Some(&[]),
        )
        .await
        .expect_err("a refused launch fails the start");
        assert_eq!(refused, "program not found: nowhere.py");
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
        assert!(!is_running(), "a failed start leaves nothing behind");

        std::fs::remove_dir_all(&dir).ok();
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

    /// `python3` first: it is the name every current system ships, and macOS has no `python` at all.
    fn python_with_debugpy() -> Option<&'static str> {
        ["python3", "python"].into_iter().find(|python| {
            std::process::Command::new(python)
                .args(["-c", "import debugpy"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
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
    async fn attach(python: &str, fixture: &Fixture, line: u32) -> (Arc<Session>, mpsc::UnboundedReceiver<Value>) {
        let mut child = Command::new(python)
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
            ready: Notify::new(),
            stopped_thread: Mutex::new(None),
            exception_filters: Mutex::new(Vec::new()),
            paused: Mutex::new(None),
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
                    reader.ready.notify_one();
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
                "python": [python],
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
        let Some(python) = python_with_debugpy() else {
            eprintln!("skipping: debugpy not installed");
            return;
        };
        // Breakpoint on line 3, where `total` is already bound.
        let fixture = Fixture::new("def add(a, b):\n    total = a + b\n    return total\n\nadd(2, 40)\n");
        let (session, mut events) = attach(python, &fixture, 3).await;

        let stopped = next_stop(&mut events).await;
        assert_eq!(stopped["body"]["reason"], "breakpoint");

        let thread = stopped["body"]["threadId"].as_i64().unwrap();
        let paused = collect_stack(&session, thread, "breakpoint".to_string(), None).await;
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
