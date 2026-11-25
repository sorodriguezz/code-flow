//! The Agent Client Protocol (ACP) transport: Gemini (`agy acp`), Grok (`grok agent stdio`) and
//! opencode (`opencode acp`) driven as **agent servers** over JSON-RPC on stdio, instead of one
//! `-p` process per turn.
//!
//! **Why** (measured on macOS, 2026-11-24 — agy 1.5.16, grok 1.0.92, opencode 2.4.1):
//! - A Gemini turn took ~2 s over ACP against ~5 s for `agy -p`; the process and its login are
//!   already up when the next turn comes ([`pool`]).
//! - The app's MCP servers ride on `session/new` — no file written into the repository for agy or
//!   Grok (`codemap::mcp::for_agy`/`for_grok`), and a read-only turn gets them too.
//! - Every tool that needs permission is **asked of the app** (`session/request_permission`) and
//!   answered by the same policy Claude's permission prompt goes through ([`decide`]) — instead of
//!   `--dangerously-skip-permissions` approving everything, or print mode soft-denying everything.
//! - A turn reports its tokens (cache and reasoning included), the context it filled
//!   (`usage_update`), and opencode and Grok their cost.
//! - The three CLIs keep one store of sessions: an id a `-p` turn printed is loaded over ACP, and the
//!   other way round (verified for all three), so switching transport loses no conversation.
//!
//! **What stays on the CLI** ([`eligible`]): a turn that needs `--json-schema` (ACP has no
//! structured-output parameter), a read-only turn of an engine whose CLI *enforces* read-only
//! (Grok's `--tools` allow-list — over ACP the limit would be our answers to its prompts, which is
//! less), and every turn when the user chose «CLI» in Settings › Proveedores. A server that will not
//! start or initialize falls back to the CLI for that turn ([`Outcome::Unavailable`]).
//!
//! **What the UI reads.** The run log gets Claude-shaped `assistant` events (`tool_use`, `text`) —
//! the shape `agentLog.ts` and the step list already understand best — written by [`Translator`]
//! from ACP's `session/update`s, so a Gemini turn now shows its reads, edits and commands as steps.
//! The answer itself is assembled here ([`AiRun`]), not re-parsed from the log.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::ai::{AiEngine, AiInvocation, AiRun, AiUsage, QUOTA_MARKER};
use crate::ai_runs::{self, RunCtx};

/// The providers that speak ACP, and the setting that picks the transport for each.
pub const PROVIDERS: [&str; 3] = ["gemini", "grok", "opencode"];

/// `ai_transport:<provider>` — `acp` (the default) or `cli`.
pub fn setting_key(provider: &str) -> String {
    format!("ai_transport:{provider}")
}

/// Whether `provider` runs over ACP — the user's choice, ACP when unset.
pub fn enabled_for(provider: &str) -> bool {
    PROVIDERS.contains(&provider) && crate::ai_usage::setting(&setting_key(provider)).as_deref() != Some("cli")
}

/// Whether this turn goes over ACP. See the module docs for what stays on the CLI and why.
pub fn eligible(engine: &dyn AiEngine, inv: &AiInvocation<'_>) -> bool {
    engine.acp_args(false).is_some()
        && enabled_for(engine.id())
        && inv.json_schema.is_none()
        && !(inv.read_only && engine.enforces_read_only())
        && !ai_runs::stopping()
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC over a child's stdio
// ---------------------------------------------------------------------------------------------

/// What the server sent that is not an answer to one of our requests.
#[derive(Debug)]
pub(crate) enum Incoming {
    Notification { method: String, params: Value },
    Request { id: Value, method: String, params: Value },
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// One agent server: its process, the requests in flight, and what it sends unasked.
///
/// Protocol-agnostic JSON-RPC 2.0 on newline-delimited stdio — Codex's `app-server` is spoken
/// through it too (`ai_quota`), and it answers without a `jsonrpc` field, which is accepted.
pub(crate) struct Connection {
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    /// Taken by whoever is driving a turn; returned when it is done ([`Connection::events`]).
    events: tokio::sync::Mutex<mpsc::UnboundedReceiver<Incoming>>,
    alive: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<String>>,
    pid: Option<u32>,
    /// On the quit path's list for as long as the process lives (`ai_runs::stop_all`).
    _live: Option<ai_runs::LiveProcess>,
    child: Mutex<Option<tokio::process::Child>>,
    /// What `initialize` answered: capabilities, auth methods, the agent's `_meta`.
    pub init: Value,
}

/// The last few KB of what the server printed on stderr — the reason, when it dies at start.
const STDERR_TAIL: usize = 4_000;

impl Connection {
    /// Starts `cmd` (stdio piped by this function) and speaks JSON-RPC to it — no handshake yet.
    pub(crate) fn start(mut cmd: tokio::process::Command) -> Result<Connection, String> {
        cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("could not start the agent server: {e}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("the agent server has no stdin")?;
        let stdout = child.stdout.take().ok_or("the agent server has no stdout")?;
        let stderr = child.stderr.take();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let (sender, receiver) = mpsc::unbounded_channel();
        {
            let (pending, alive) = (pending.clone(), alive.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let line = line.trim();
                    if !line.starts_with('{') {
                        continue;
                    }
                    let Ok(message) = serde_json::from_str::<Value>(line) else { continue };
                    route(message, &pending, &sender);
                }
                alive.store(false, Ordering::SeqCst);
                // Everyone still waiting learns the server is gone, rather than waiting forever.
                if let Ok(mut pending) = pending.lock() {
                    for (_, waiter) in pending.drain() {
                        let _ = waiter.send(Err("the agent server exited".into()));
                    }
                }
            });
        }
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = stderr {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Ok(mut tail) = tail.lock() {
                        tail.push_str(&line);
                        tail.push('\n');
                        if tail.len() > STDERR_TAIL {
                            let mut cut = tail.len() - STDERR_TAIL;
                            while !tail.is_char_boundary(cut) {
                                cut += 1;
                            }
                            tail.drain(..cut);
                        }
                    }
                }
            });
        }
        Ok(Connection {
            stdin: tokio::sync::Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            events: tokio::sync::Mutex::new(receiver),
            alive,
            stderr_tail,
            _live: pid.map(|pid| ai_runs::register_process(pid, None)),
            pid,
            child: Mutex::new(Some(child)),
            init: Value::Null,
        })
    }

    pub(crate) fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub(crate) fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().map(|t| t.trim().to_string()).unwrap_or_default()
    }

    async fn write(&self, message: &Value) -> Result<(), String> {
        let mut line = message.to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| format!("the agent server stopped reading: {e}"))?;
        stdin.flush().await.map_err(|e| format!("the agent server stopped reading: {e}"))
    }

    /// Sends `method` and waits for its answer, up to `timeout`.
    pub(crate) async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, sender);
        }
        if let Err(error) = self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await {
            self.forget(id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("the agent server exited".into()),
            Err(_) => {
                self.forget(id);
                Err(format!("the agent server did not answer {method} in {} s", timeout.as_secs()))
            }
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    pub(crate) async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({"jsonrpc": "2.0", "method": method, "params": params})).await
    }

    pub(crate) async fn respond(&self, id: Value, result: Result<Value, (i64, String)>) {
        let message = match result {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, text)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": text}}),
        };
        let _ = self.write(&message).await;
    }

    /// The ACP handshake. The client offers no file system and no terminal: the agent uses its own
    /// tools, and the app answers only permission prompts.
    pub(crate) async fn initialize(&mut self) -> Result<(), String> {
        let params = json!({
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
            "clientInfo": {"name": "CodeFlow", "version": env!("CARGO_PKG_VERSION")},
        });
        match self.request("initialize", params, Duration::from_secs(60)).await {
            Ok(init) => {
                self.init = init;
                Ok(())
            }
            Err(error) => {
                let tail = self.stderr_tail();
                Err(if tail.is_empty() { error } else { format!("{error}: {}", last_line(&tail)) })
            }
        }
    }

    /// Whether the agent said it can do `capability` of `sessionCapabilities` (`close`, `load`…).
    fn can(&self, capability: &str) -> bool {
        let caps = &self.init["agentCapabilities"];
        caps["sessionCapabilities"].get(capability).is_some() || (capability == "load" && caps["loadSession"].as_bool() == Some(true))
    }

    /// Ends the process and every helper it started (its process group), now.
    pub(crate) fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(pid) = self.pid {
            kill_group(pid);
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.start_kill();
            }
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    // SAFETY: `kill` takes only integers; a group that is already gone answers ESRCH.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
}

#[cfg(windows)]
fn kill_group(pid: u32) {
    let _ = crate::proc::std_command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}

fn route(message: Value, pending: &Pending, sender: &mpsc::UnboundedSender<Incoming>) {
    let method = message.get("method").and_then(Value::as_str).map(str::to_string);
    match (method, message.get("id")) {
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let waiter = pending.lock().ok().and_then(|mut pending| pending.remove(&id));
            if let Some(waiter) = waiter {
                let answer = match message.get("error") {
                    Some(error) => Err(rpc_error(error)),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = waiter.send(answer);
            }
        }
        (Some(method), Some(id)) => {
            let _ = sender.send(Incoming::Request { id: id.clone(), method, params: message.get("params").cloned().unwrap_or(Value::Null) });
        }
        (Some(method), None) => {
            let _ = sender.send(Incoming::Notification { method, params: message.get("params").cloned().unwrap_or(Value::Null) });
        }
        (None, None) => {}
    }
}

/// An error object as one readable line: its message, and its `data` when that says more.
fn rpc_error(error: &Value) -> String {
    let message = error.get("message").and_then(Value::as_str).unwrap_or("error").trim().to_string();
    match error.get("data") {
        Some(Value::String(data)) if !data.trim().is_empty() && !message.contains(data.trim()) => format!("{message}: {}", data.trim()),
        _ => message,
    }
}

fn last_line(text: &str) -> &str {
    text.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or(text).trim()
}

// ---------------------------------------------------------------------------------------------
// The pool: servers kept warm between turns
// ---------------------------------------------------------------------------------------------

/// How long an idle server is kept for the next turn. Long enough to span a conversation's pauses;
/// short enough that a chat left alone does not hold a login and a few hundred MB for the afternoon.
const POOL_IDLE: Duration = Duration::from_secs(10 * 60);
/// Idle servers kept per key: a second chat on the same engine finds one warm too.
const POOL_PER_KEY: usize = 2;

struct Pooled {
    key: String,
    connection: Arc<Connection>,
    since: Instant,
}

static POOL: LazyLock<Mutex<Vec<Pooled>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static SWEEPER: std::sync::Once = std::sync::Once::new();

mod pool {
    use super::*;

    /// A warm server for `key`, taken out of the pool — the caller has it alone until [`put`].
    pub(super) fn take(key: &str) -> Option<Arc<Connection>> {
        let mut pool = POOL.lock().ok()?;
        sweep(&mut pool);
        let at = pool.iter().position(|entry| entry.key == key)?;
        Some(pool.remove(at).connection)
    }

    /// Gives a server back after a turn that left it healthy.
    pub(super) fn put(key: String, connection: Arc<Connection>) {
        if !connection.alive() || ai_runs::stopping() {
            return;
        }
        SWEEPER.call_once(|| {
            tokio::spawn(async {
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    if let Ok(mut pool) = POOL.lock() {
                        sweep(&mut pool);
                    }
                }
            });
        });
        if let Ok(mut pool) = POOL.lock() {
            sweep(&mut pool);
            if pool.iter().filter(|entry| entry.key == key).count() < POOL_PER_KEY {
                pool.push(Pooled { key, connection, since: Instant::now() });
            }
        }
    }

    /// Drops what died or sat idle too long — dropping a [`Connection`] ends its process.
    fn sweep(pool: &mut Vec<Pooled>) {
        pool.retain(|entry| entry.connection.alive() && entry.since.elapsed() < POOL_IDLE && !ai_runs::stopping());
    }

    /// Ends every warm server — the transport was switched, or an account changed.
    pub fn clear() {
        if let Ok(mut pool) = POOL.lock() {
            pool.clear();
        }
    }
}

pub use pool::clear as clear_pool;

// ---------------------------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------------------------

/// How a turn over ACP went.
pub(crate) enum Outcome {
    /// It ran: the answer or the turn's own error.
    Ran(Result<AiRun, String>),
    /// The server could not be started or would not initialize — the caller runs the CLI instead.
    Unavailable(String),
}

/// The longest one turn's `session/prompt` may take. The idle watchdog is what ends a hung turn;
/// this only keeps a request from outliving everything.
const PROMPT_CEILING: Duration = Duration::from_secs(6 * 60 * 60);
/// How long a cancelled turn is given to answer `cancelled` before its server is killed.
const CANCEL_GRACE: Duration = Duration::from_secs(8);

/// Runs one turn of `engine` over ACP. `binary` is the resolved program.
pub(crate) async fn run(
    engine: &dyn AiEngine,
    binary: &str,
    inv: &AiInvocation<'_>,
    servers: &[crate::mcp_registry::LiveServer],
    ctx: &Option<RunCtx>,
    cancel: &mut Option<tokio::sync::watch::Receiver<bool>>,
) -> Outcome {
    let read_only = inv.read_only || inv.text_only;
    // agy's `--sandbox` is a process flag: a read-only turn gets a server started with it.
    let sandbox = engine.id() == "gemini" && read_only;
    let Some(args) = engine.acp_args(sandbox) else { return Outcome::Unavailable("this engine has no ACP mode".into()) };
    let account = engine.account().map(|env| env.key()).unwrap_or_default();
    let team_cf = inv.cwd.map(crate::team::cf_env_for).unwrap_or_default();
    // A team member's turn carries its own `cf` environment, so it gets a server of its own.
    let poolable = team_cf.vars.is_empty() && team_cf.cf_dir.is_none();
    let key = format!("{}|{account}|{binary}|{sandbox}", engine.id());

    // A warm server first; one that cannot open a session (it died since, or its reader went with a
    // runtime that ended) is dropped, and a fresh one gets the turn.
    let mut warm = if poolable { pool::take(&key) } else { None };
    loop {
        let from_pool = warm.is_some();
        let connection = match warm.take() {
            Some(connection) => connection,
            None => {
                let cmd = crate::ai::acp_command(engine, binary, &args, &team_cf);
                let mut connection = match Connection::start(cmd) {
                    Ok(connection) => connection,
                    Err(error) => return Outcome::Unavailable(error),
                };
                if let Err(error) = connection.initialize().await {
                    return Outcome::Unavailable(error);
                }
                Arc::new(connection)
            }
        };
        if let (Some(ctx), Some(pid)) = (ctx, connection.pid()) {
            ai_runs::tag_process(pid, Some(&ctx.run_id));
        }
        let outcome = turn(engine, &connection, inv, servers, read_only, ctx, cancel).await;
        if let Some(pid) = connection.pid() {
            ai_runs::tag_process(pid, None);
        }
        return match outcome {
            Turn::Done(result, healthy) => {
                if healthy && poolable {
                    pool::put(key, connection);
                }
                Outcome::Ran(result)
            }
            Turn::NoSession(_) if from_pool => {
                connection.kill();
                continue;
            }
            Turn::NoSession(error) => Outcome::Unavailable(error),
        };
    }
}

enum Turn {
    /// The turn's result, and whether its server can serve another.
    Done(Result<AiRun, String>, bool),
    /// No session could be opened — treated as the server being unavailable.
    NoSession(String),
}

async fn turn(
    engine: &dyn AiEngine,
    connection: &Connection,
    inv: &AiInvocation<'_>,
    servers: &[crate::mcp_registry::LiveServer],
    read_only: bool,
    ctx: &Option<RunCtx>,
    cancel: &mut Option<tokio::sync::watch::Receiver<bool>>,
) -> Turn {
    let mut events = connection.events.lock().await;
    // Whatever a previous turn left unread (a late update) is not this turn's.
    while events.try_recv().is_ok() {}

    // A text-only turn answers from its brief alone, in an empty folder of its own.
    let scratch = if inv.text_only { inv.prompt_files.dir("acp-scratch") } else { None };
    let cwd = scratch
        .as_ref()
        .map(|dir| dir.to_string_lossy().to_string())
        .or_else(|| inv.cwd.map(str::to_string))
        .unwrap_or_else(|| dirs::home_dir().map(|home| home.to_string_lossy().to_string()).unwrap_or_else(|| ".".into()));
    let mcp_servers: Vec<Value> = if inv.text_only { Vec::new() } else { servers.iter().filter_map(mcp_server).collect() };
    let mut open = json!({"cwd": cwd, "mcpServers": mcp_servers});
    if !inv.extra_dirs.is_empty() && connection.can("additionalDirectories") {
        open["additionalDirectories"] = json!(inv.extra_dirs);
    }

    // Resume the conversation when there is one to resume, else open a new one. Loading replays the
    // history as updates before it answers; those are drained below, not shown again.
    let resume = inv.resume_session_id.map(str::trim).filter(|id| is_session_id(id)).filter(|_| connection.can("load"));
    let opened = match resume {
        Some(id) => {
            let mut load = open.clone();
            load["sessionId"] = json!(id);
            match connection.request("session/load", load, Duration::from_secs(120)).await {
                Ok(result) => Ok((id.to_string(), result)),
                // A session the agent no longer has opens a new one, as `--conversation` on a stale id
                // would fail: the chat goes on, without the history it cannot get back.
                Err(_) => new_session(connection, open).await,
            }
        }
        None => new_session(connection, open).await,
    };
    let (session, opened) = match opened {
        Ok(opened) => opened,
        Err(error) => return Turn::NoSession(error),
    };
    while events.try_recv().is_ok() {}

    // The model and the reasoning level, by the session's own config options.
    let model = match configure(engine, connection, &session, &opened, inv).await {
        Ok(model) => model,
        Err(error) => {
            close(connection, &session).await;
            return Turn::Done(Err(error), true);
        }
    };

    let brief = brief(inv);
    let policy = Policy::of(engine, inv, read_only, connection_servers(servers));
    let prompt = connection.request(
        "session/prompt",
        json!({"sessionId": session, "prompt": [{"type": "text", "text": brief}]}),
        PROMPT_CEILING,
    );
    tokio::pin!(prompt);

    let activity = ai_runs::Activity::new();
    let idle_limit = crate::ai::idle_limit_for(engine);
    let mut translator = Translator::new(connection_servers(servers));
    let mut cancelled_at: Option<Instant> = None;
    let answer = loop {
        let grace = async {
            match cancelled_at {
                Some(at) => tokio::time::sleep(CANCEL_GRACE.saturating_sub(at.elapsed())).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            answer = &mut prompt => break Some(answer),
            event = events.recv() => {
                let Some(event) = event else { break None };
                activity.touch();
                match event {
                    Incoming::Notification { method, params } => {
                        for line in translator.notification(&method, &params, &session) {
                            if let Some(ctx) = ctx {
                                ai_runs::emit_line(ctx, "stdout", &line);
                            }
                        }
                        // The same call over and over: the turn is told to stop, and ends as a
                        // failure that says what it was doing — never as a Stop the user pressed.
                        if cancelled_at.is_none() {
                            if let Some(what) = translator.looped.clone() {
                                if let Some(ctx) = ctx {
                                    ai_runs::emit_line(ctx, "stdout", &note(&format!("Detenido: repetía la misma llamada ({what}).")));
                                }
                                cancelled_at = Some(Instant::now());
                                let _ = connection.notify("session/cancel", json!({"sessionId": session})).await;
                            }
                        }
                        // The reply as it is written, when somebody is watching it (a chat turn).
                        let live = translator.take_live();
                        if let (Some(ctx), Some(sink)) = (ctx, inv.stream_deltas.as_ref()) {
                            for (kind, text) in live {
                                ai_runs::emit_delta(ctx, &sink.conversation_id, &sink.message_id, kind, &text);
                            }
                        }
                    }
                    Incoming::Request { id, method, params } => {
                        if let Some(refused) = answer_request(connection, id, &method, params, &policy).await {
                            translator.refused.push(refused);
                        }
                        // Waiting on the user's answer is not the agent going quiet.
                        activity.touch();
                    }
                }
            }
            _ = ai_runs::cancelled(cancel), if cancelled_at.is_none() => {
                cancelled_at = Some(Instant::now());
                let _ = connection.notify("session/cancel", json!({"sessionId": session})).await;
            }
            _ = grace => {
                // It did not stop when asked: the process goes, and the pool never sees it.
                connection.kill();
                let error = translator.looped.as_deref().map(looped_error).unwrap_or_else(|| ai_runs::CANCELLED_MARKER.to_string());
                return Turn::Done(Err(error), false);
            }
            limit = ai_runs::gone_quiet(&activity, idle_limit), if cancelled_at.is_none() => {
                connection.kill();
                return Turn::Done(Err(ai_runs::idle_error(engine.label(), limit)), false);
            }
        }
    };
    for line in translator.finish() {
        if let Some(ctx) = ctx {
            ai_runs::emit_line(ctx, "stdout", &line);
        }
    }
    let healthy = connection.alive();
    close(connection, &session).await;

    let looped = translator.looped.clone();
    let result = match answer {
        _ if looped.is_some() => Err(looped_error(looped.as_deref().unwrap_or_default())),
        None => Err(format!("{} se cerró en medio de la respuesta.", engine.label())),
        Some(Err(error)) => Err(failure(&error)),
        Some(Ok(result)) => finish(engine, &result, translator, session, model, cancelled_at.is_some()),
    };
    Turn::Done(result, healthy)
}

async fn new_session(connection: &Connection, open: Value) -> Result<(String, Value), String> {
    let result = connection.request("session/new", open, Duration::from_secs(120)).await?;
    let session = result.get("sessionId").and_then(Value::as_str).ok_or("session/new answered no sessionId")?.to_string();
    Ok((session, result))
}

/// Ends the session on the server, so its tools and subagents stop and the next turn — which may
/// bring a new MCP token — loads it fresh. A server that cannot close keeps it; nothing depends on it.
async fn close(connection: &Connection, session: &str) {
    if connection.alive() && connection.can("close") {
        let _ = connection.request("session/close", json!({"sessionId": session}), Duration::from_secs(10)).await;
    }
}

/// A session id the agent could have printed — not Gemini's sentinel for "no id was given".
fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id != "agy-last"
}

/// The whole brief as one text block: system instructions, the ask, the skills note and the data —
/// what `gemini.rs` passes as `-p`, here with no command-line limit to route around.
fn brief(inv: &AiInvocation<'_>) -> String {
    let mut brief = String::new();
    if let Some(system) = inv.system_prompt.filter(|s| !s.trim().is_empty()) {
        brief.push_str(system);
        brief.push_str("\n\n");
    }
    brief.push_str(inv.prompt);
    if !inv.skills_note.is_empty() {
        brief.push_str("\n\n");
        brief.push_str(inv.skills_note.trim_end());
    }
    if !inv.stdin_content.trim().is_empty() {
        brief.push_str("\n\n----- INPUT -----\n\n");
        brief.push_str(inv.stdin_content);
    }
    brief
}

/// An app MCP server as ACP's `McpServer`: stdio, or HTTP/SSE by URL with its headers.
fn mcp_server(server: &crate::mcp_registry::LiveServer) -> Option<Value> {
    let pairs = |list: &[(String, String)]| -> Vec<Value> { list.iter().map(|(name, value)| json!({"name": name, "value": value})).collect() };
    match server.transport.as_str() {
        "stdio" if !server.command.is_empty() => {
            Some(json!({"name": server.name, "command": server.command, "args": server.args, "env": pairs(&server.env)}))
        }
        "sse" if !server.url.is_empty() => Some(json!({"type": "sse", "name": server.name, "url": server.url, "headers": pairs(&server.headers)})),
        _ if !server.url.is_empty() => Some(json!({"type": "http", "name": server.name, "url": server.url, "headers": pairs(&server.headers)})),
        _ => None,
    }
}

fn connection_servers(servers: &[crate::mcp_registry::LiveServer]) -> Vec<String> {
    servers.iter().map(|server| server.name.clone()).collect()
}

/// Sets the model (and, for Gemini, the variant that is its reasoning level) and the reasoning level
/// where the session offers one. Returns the model the turn runs on, when one was chosen.
async fn configure(engine: &dyn AiEngine, connection: &Connection, session: &str, opened: &Value, inv: &AiInvocation<'_>) -> Result<Option<String>, String> {
    let options = opened.get("configOptions").and_then(Value::as_array).cloned().unwrap_or_default();
    let model_option = options.iter().find(|option| option["category"] == "model" || option["id"] == "model");
    let current = model_option.and_then(|option| option["currentValue"].as_str()).map(str::to_string);
    let requested = inv.model.split_whitespace().next().unwrap_or("");
    let level = inv.effort.filter(|level| crate::ai::effort::valid(level));
    let mut target = requested.to_string();
    // agy's levels are model variants (`gemini-3.8-flash` at `high` is `gemini-3.8-flash-high`).
    if engine.id() == "gemini" && !target.is_empty() {
        if let Some(level) = level.filter(|_| engine.model_supports_effort(requested)) {
            if let Some(fitted) = engine.effort_args_for(level, requested).get(1) {
                target = format!("{requested}-{fitted}");
            }
        }
    }
    let mut model = current.clone();
    if let Some(option) = model_option.filter(|_| !target.is_empty() && current.as_deref() != Some(target.as_str())) {
        let id = option["id"].as_str().unwrap_or("model");
        connection
            .request("session/set_config_option", json!({"sessionId": session, "configId": id, "value": target}), Duration::from_secs(30))
            .await
            .map_err(|error| format!("{} no acepta el modelo «{target}»: {error}", engine.label()))?;
        model = Some(target.clone());
    }
    // Grok's and opencode's reasoning dial, by whatever the session calls it.
    if engine.id() != "gemini" {
        if let Some(level) = level {
            if let Some(option) = options.iter().find(|option| option["category"] == "thought_level") {
                let offered: Vec<String> = option["options"].as_array().into_iter().flatten().filter_map(|o| o["value"].as_str().map(str::to_string)).collect();
                if let Some(value) = crate::ai::fit_effort(level, &offered) {
                    if option["currentValue"].as_str() != Some(value.as_str()) {
                        let id = option["id"].as_str().unwrap_or("reasoning_effort");
                        let _ = connection
                            .request("session/set_config_option", json!({"sessionId": session, "configId": id, "value": value}), Duration::from_secs(30))
                            .await;
                    }
                }
            }
        }
    }
    Ok(model.filter(|m| !m.is_empty()))
}

/// The turn's answer from its `session/prompt` result and what the translator collected.
fn finish(engine: &dyn AiEngine, result: &Value, translator: Translator, session: String, model: Option<String>, cancelled: bool) -> Result<AiRun, String> {
    let stop = result.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn");
    if stop == "cancelled" || cancelled {
        return Err(ai_runs::CANCELLED_MARKER.to_string());
    }
    let usage = usage_of(result);
    let text = translator.answer.trim().to_string();
    if stop == "refusal" {
        return Err(format!("{} se negó a responder.", engine.label()));
    }
    if text.is_empty() {
        // agy ends a turn in silence once a tool it needed was refused: say which, and why.
        if !translator.refused.is_empty() {
            let what = translator.refused.iter().map(|r| format!("«{}»", short(r, 80))).collect::<Vec<_>>().join(", ");
            return Err(format!(
                "{} se detuvo: CodeFlow no permitió {what}. En un turno de solo lectura no se escriben archivos ni se ejecutan comandos fuera del sandbox; en uno que actúa, lo que no apruebes.",
                engine.label()
            ));
        }
        return Err(format!("{} no devolvió texto (stopReason: {stop}).", engine.label()));
    }
    let generated = usage.as_ref().map(|u| u.output_tokens);
    if crate::ai::refusal_reply(&text, generated) {
        return Err(format!("{QUOTA_MARKER}{text}"));
    }
    Ok(AiRun { text, session_id: Some(session), model, usage: usage.filter(|u| !u.is_empty()), context_tokens: translator.context_used })
}

/// A failed `session/prompt` as the error the chat shows — a quota refusal marked as one.
fn failure(error: &str) -> String {
    if crate::ai::quota_signal(error) {
        format!("{QUOTA_MARKER}{error}")
    } else {
        error.to_string()
    }
}

/// The usage a `session/prompt` result reports — ACP's `usage` (agy, opencode) or Grok's
/// `_meta.usage`. Reasoning tokens count as output: they are generated and billed as such.
fn usage_of(result: &Value) -> Option<AiUsage> {
    let usage = result.get("usage").filter(|u| u.is_object()).or_else(|| result.get("_meta").and_then(|m| m.get("usage")))?;
    let n = |key: &str| usage.get(key).and_then(Value::as_i64).unwrap_or(0);
    let thought = n("thoughtTokens").max(n("reasoningTokens"));
    // Grok's cost comes in ticks of 1e-10 USD (`costUsdTicks`).
    let cost = usage.get("costUsdTicks").and_then(Value::as_f64).map(|ticks| ticks / 1e10);
    Some(AiUsage {
        input_tokens: n("inputTokens"),
        output_tokens: n("outputTokens") + thought,
        cache_read_tokens: n("cachedReadTokens"),
        cache_write_tokens: n("cachedWriteTokens").max(n("cacheCreationTokens")),
        cost_usd: cost,
    })
}

// ---------------------------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------------------------

/// How this turn answers the agent's permission prompts — the policy Claude's permission prompt
/// follows (`codemap::mcp::answer_permission_prompt`), read off the invocation.
struct Policy {
    /// The turn may change things (`auto_approve_edits` and not read-only).
    acts: bool,
    /// «Completo»: asks the user nothing.
    full: bool,
    /// The turn reads material someone else wrote: tools that act are refused outright.
    grounding: bool,
    /// The server was started with a sandbox around its terminal (agy `--sandbox`).
    sandboxed: bool,
    root: String,
    /// The app's MCP servers this turn was given, by name — their tools are judged as theirs.
    servers: Vec<String>,
}

impl Policy {
    fn of(engine: &dyn AiEngine, inv: &AiInvocation<'_>, read_only: bool, servers: Vec<String>) -> Policy {
        let acts = inv.auto_approve_edits && !read_only;
        Policy {
            acts,
            full: acts && inv.full_access,
            grounding: crate::ai::is_grounding_task(inv.task),
            sandboxed: engine.id() == "gemini" && read_only,
            root: inv.cwd.unwrap_or_default().to_string(),
            servers,
        }
    }
}

/// What the app answers one permission prompt with.
#[derive(Debug, PartialEq)]
enum Decision {
    Allow,
    Deny,
    /// Ask the user in the window — with the command when it is a shell line.
    AskUser(String),
    /// A dangerous shell line on a turn that acts: `cf guard`'s question.
    Guard(String, String),
}

/// The decision for a tool of ACP `kind`, with the shell line when it runs one, and its
/// `mcp__<server>__<tool>` name when it is one of the app's MCP servers'. Pure, so it is tested as
/// a table.
fn decide(policy: &Policy, kind: &str, command: Option<&str>, title: &str, mcp: Option<&str>) -> Decision {
    // The app's own servers first: Claude Code is handed them pre-approved (`codemap::mcp::allow_rule`),
    // agy asks — and the answer has to be the same.
    if let Some(tool) = mcp {
        // The map: its token is the limit (queries only on a plan or grounding turn).
        if tool.starts_with(&format!("mcp__{}__", crate::codemap::mcp::SERVER_NAME)) {
            return Decision::Allow;
        }
        if let Some(allowed) = crate::chat_exec::browser_allows(tool, policy.acts) {
            if policy.grounding {
                return Decision::Deny;
            }
            if policy.acts && !policy.full && crate::chat_exec::browser_asks(tool) {
                return Decision::AskUser(title.to_string());
            }
            return if allowed { Decision::Allow } else { Decision::Deny };
        }
        // One of the user's servers the chat turned on.
        if policy.grounding {
            return Decision::Deny;
        }
        return if policy.acts { Decision::Allow } else { Decision::AskUser(title.to_string()) };
    }
    let reads = matches!(kind, "read" | "search" | "think" | "fetch");
    if reads {
        return Decision::Allow;
    }
    if policy.grounding {
        return Decision::Deny;
    }
    if policy.full {
        return Decision::Allow;
    }
    if kind == "execute" {
        let command = command.unwrap_or(title);
        if policy.acts {
            return match crate::shell_rules::dangerous(command) {
                Some(reason) => Decision::Guard(command.to_string(), reason.to_string()),
                None => Decision::Allow,
            };
        }
        // A plan turn: what looks, inside the agent's own sandbox — and nothing without one.
        if policy.sandboxed && crate::chat_exec::plan_refusal(command).is_none() {
            return Decision::Allow;
        }
        return Decision::Deny;
    }
    if policy.acts {
        return Decision::Allow;
    }
    match kind {
        "edit" | "delete" | "move" => Decision::Deny,
        // An MCP tool or anything else unnamed, on a plan turn: the servers it has are the
        // read-only set (`codemap::mcp::loadable`), so their tools run; the rest ask.
        _ => Decision::AskUser(title.to_string()),
    }
}

/// Answers what the agent asked of the client. Returns the tool it was refused, when it was — a
/// turn that ends with nothing to say after that is explained by it.
async fn answer_request(connection: &Connection, id: Value, method: &str, params: Value, policy: &Policy) -> Option<String> {
    if method != "session/request_permission" {
        connection.respond(id, Err((-32601, format!("{method} is not offered by CodeFlow")))).await;
        return None;
    }
    let tool = &params["toolCall"];
    let kind = tool["kind"].as_str().unwrap_or("other");
    let title = tool["title"].as_str().unwrap_or("tool").to_string();
    let command = command_of(&tool["rawInput"]);
    let options = params["options"].as_array().cloned().unwrap_or_default();
    let named = [tool["name"].as_str(), tool["rawInput"]["tool_name"].as_str(), tool["title"].as_str()]
        .into_iter()
        .flatten()
        .map(|name| mcp_name(&policy.servers, name))
        .find(|name| name.starts_with("mcp__"));
    let decision = decide(policy, kind, command.as_deref(), &title, named.as_deref());
    let allowed = match decision {
        Decision::Allow => true,
        Decision::Deny => false,
        Decision::AskUser(detail) => match crate::ai_usage::app() {
            Some(app) => crate::agentcli::approve_tool_use(app, &policy.root, "", &title, &detail).await.is_ok(),
            None => false,
        },
        Decision::Guard(command, reason) => match crate::ai_usage::app() {
            Some(app) => crate::agentcli::guard(app, &command, &reason, &policy.root).await.is_ok(),
            None => false,
        },
    };
    let pick = |kinds: &[&str]| options.iter().find(|o| o["kind"].as_str().is_some_and(|k| kinds.contains(&k))).and_then(|o| o["optionId"].as_str()).map(str::to_string);
    let chosen = if allowed { pick(&["allow_once", "allow_always"]) } else { pick(&["reject_once", "reject_always"]) };
    let outcome = match chosen {
        Some(option) => json!({"outcome": {"outcome": "selected", "optionId": option}}),
        None => json!({"outcome": {"outcome": "cancelled"}}),
    };
    connection.respond(id, Ok(outcome)).await;
    (!allowed).then(|| command.unwrap_or(title))
}

/// The shell line a tool call runs, by the names the three agents give it.
fn command_of(input: &Value) -> Option<String> {
    ["CommandLine", "command", "cmd", "commandLine"].iter().find_map(|key| input.get(*key).and_then(Value::as_str)).map(str::to_string)
}

// ---------------------------------------------------------------------------------------------
// From ACP updates to the run log
// ---------------------------------------------------------------------------------------------

/// Turns `session/update`s into Claude-shaped log lines, and keeps the answer and the context fill.
/// How many times in a row an agent may make the very same call before the turn is stopped.
const SAME_CALL_STREAK: usize = 6;
/// How many times it may look at the very same thing — read a file, run a search — without
/// changing anything in between.
const SAME_LOOK_LIMIT: usize = 10;

/// Watches an agent's tool calls for the one thing a CLI's own turn never stops by itself: the
/// same call, again and again. The local agent answers a repeat with «you already have this»
/// (`local_agent`); an ACP agent runs its tools in its own process, so the app cannot answer for
/// them — it can only see them go by, and stop the turn. Two patterns count: one call made
/// [`SAME_CALL_STREAK`] times in a row, and one look repeated [`SAME_LOOK_LIMIT`] times with
/// nothing changed in between (an edit or a command resets it: reading a file again after
/// changing it is not a loop).
#[derive(Default)]
pub struct LoopGuard {
    last: String,
    streak: usize,
    looks: HashMap<String, usize>,
}

impl LoopGuard {
    /// One more call. `Some` is the turn being a loop, with what it kept doing.
    pub fn see(&mut self, name: &str, input: &Value) -> Option<String> {
        let key = format!("{name}:{input}");
        if key == self.last {
            self.streak += 1;
        } else {
            self.last = key.clone();
            self.streak = 1;
        }
        let looks = matches!(name, "Read" | "Grep" | "WebFetch");
        let seen = if looks {
            let count = self.looks.entry(key).or_insert(0);
            *count += 1;
            *count
        } else {
            // Something may have changed: looking again is fair.
            self.looks.clear();
            0
        };
        (self.streak >= SAME_CALL_STREAK || seen >= SAME_LOOK_LIMIT).then(|| {
            let what = ["file_path", "command", "pattern", "url"].iter().find_map(|field| input.get(*field).and_then(Value::as_str)).unwrap_or_default();
            format!("{name} {}", short(what, 120)).trim().to_string()
        })
    }
}

struct Translator {
    /// The app's MCP servers by name, to name their tools `mcp__<server>__<tool>` as the UI expects.
    servers: Vec<String>,
    answer: String,
    /// The text of the message block in progress, logged when a tool call or the end closes it.
    block: String,
    seen_tools: std::collections::HashSet<String>,
    context_used: Option<i64>,
    /// What the app refused the agent this turn ([`answer_request`]).
    refused: Vec<String>,
    /// A tool call came since the last text: the next text opens a paragraph.
    after_tool: bool,
    /// Text and thinking fragments for the chat to type as they arrive (`ai:chat-delta`), taken
    /// after each update ([`Translator::take_live`]).
    live: Vec<(&'static str, String)>,
    guard: LoopGuard,
    /// What the agent kept calling, once it is a loop ([`LoopGuard`]).
    looped: Option<String>,
}

impl Translator {
    fn new(servers: Vec<String>) -> Translator {
        Translator { servers, answer: String::new(), block: String::new(), seen_tools: Default::default(), context_used: None, refused: Vec::new(), after_tool: false, live: Vec::new(), guard: LoopGuard::default(), looped: None }
    }

    fn notification(&mut self, method: &str, params: &Value, session: &str) -> Vec<String> {
        // Grok's own channel: a retry while rate-limited is worth a line.
        if method == "_x.ai/session_notification" {
            let update = &params["update"];
            if update["sessionUpdate"] == "retry_state" {
                if let Some(reason) = update["reason"].as_str() {
                    return vec![note(&format!("Reintentando: {}", short(reason, 140)))];
                }
            }
            return Vec::new();
        }
        if method != "session/update" || params["sessionId"].as_str().is_some_and(|id| id != session) {
            return Vec::new();
        }
        let update = &params["update"];
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                if let Some(text) = update["content"]["text"].as_str().filter(|text| !text.is_empty()) {
                    // Text that resumes after a tool call starts a paragraph of its own — in the answer
                    // and on screen alike, so what was typed live is what is kept.
                    let text = if self.after_tool && !self.answer.trim().is_empty() {
                        format!("\n\n{}", text.trim_start())
                    } else {
                        text.to_string()
                    };
                    self.after_tool = false;
                    self.answer.push_str(&text);
                    self.block.push_str(&text);
                    self.live.push(("text", text));
                }
                Vec::new()
            }
            "agent_thought_chunk" => {
                if let Some(text) = update["content"]["text"].as_str().filter(|text| !text.is_empty()) {
                    self.live.push(("thinking", text.to_string()));
                }
                Vec::new()
            }
            "usage_update" => {
                self.context_used = update["used"].as_i64().filter(|used| *used > 0).or(self.context_used);
                Vec::new()
            }
            "tool_call" => {
                let id = update["toolCallId"].as_str().unwrap_or("").to_string();
                if !id.is_empty() && !self.seen_tools.insert(id.clone()) {
                    return Vec::new();
                }
                self.after_tool = true;
                let mut lines = self.flush();
                if let Some((name, input)) = self.tool(update) {
                    if self.looped.is_none() {
                        self.looped = self.guard.see(&name, &input);
                    }
                    lines.push(json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}}).to_string());
                }
                lines
            }
            "tool_call_update" if update["status"] == "failed" => {
                let detail = update["content"].as_array().and_then(|c| c.iter().find_map(|part| part["content"]["text"].as_str())).unwrap_or("");
                if detail.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![note(&short(detail, 160))]
                }
            }
            _ => Vec::new(),
        }
    }

    fn take_live(&mut self) -> Vec<(&'static str, String)> {
        std::mem::take(&mut self.live)
    }

    /// The text block in progress as a log line, if it says anything.
    fn flush(&mut self) -> Vec<String> {
        let text = std::mem::take(&mut self.block);
        if text.trim().is_empty() {
            return Vec::new();
        }
        vec![json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text.trim()}]}}).to_string()]
    }

    fn finish(&mut self) -> Vec<String> {
        // The last block is the answer the chat shows a beat later; logging it too would repeat it.
        self.block.clear();
        Vec::new()
    }

    /// A tool call as the UI names it: Claude's tool names for the agent's own tools, `mcp__…` for
    /// an MCP server's. `None` for what is bookkeeping (thinking, Grok's tool search).
    fn tool(&self, update: &Value) -> Option<(String, Value)> {
        let kind = update["kind"].as_str().unwrap_or("other");
        let raw = &update["rawInput"];
        let title = update["title"].as_str().unwrap_or("");
        let name = update["name"].as_str().unwrap_or(title);
        let path = update["locations"].as_array().and_then(|l| l.first()).and_then(|l| l["path"].as_str()).map(str::to_string).or_else(|| {
            ["Path", "path", "file_path", "filePath", "AbsolutePath", "TargetFile"].iter().find_map(|k| raw.get(*k).and_then(Value::as_str)).map(str::to_string)
        });
        let text_arg = |keys: &[&str]| keys.iter().find_map(|k| raw.get(*k).and_then(Value::as_str)).map(str::to_string);
        match kind {
            "think" | "switch_mode" => None,
            "read" => Some(("Read".into(), json!({"file_path": path.unwrap_or_else(|| title.to_string())}))),
            "edit" | "delete" | "move" => Some(("Edit".into(), json!({"file_path": path.unwrap_or_else(|| title.to_string())}))),
            "search" => Some(("Grep".into(), json!({"pattern": text_arg(&["Query", "query", "pattern", "Pattern"]).unwrap_or_else(|| title.to_string())}))),
            "execute" => Some(("Bash".into(), json!({"command": command_of(raw).unwrap_or_else(|| title.to_string())}))),
            "fetch" => Some(("WebFetch".into(), json!({"url": text_arg(&["url", "Url", "URL"]).unwrap_or_else(|| title.to_string())}))),
            _ => {
                // Grok calls an MCP tool through `use_tool` and finds it through `search_tool`.
                if name == "search_tool" || title == "search_tool" {
                    return None;
                }
                if let Some(tool) = raw.get("tool_name").and_then(Value::as_str) {
                    return Some((self.mcp_name(tool), raw.get("tool_input").cloned().unwrap_or(Value::Null)));
                }
                Some((self.mcp_name(name), raw.clone()))
            }
        }
    }

    fn mcp_name(&self, name: &str) -> String {
        mcp_name(&self.servers, name)
    }
}

/// `mcp_codeflow_map_app_run` (agy) or `codeflow_map__app_run` (Grok) → `mcp__codeflow_map__app_run`,
/// for one of `servers`; anything else unchanged. The longest server name first, so `a_b` is not
/// read as server `a`.
/// What a turn stopped by the [`LoopGuard`] ends with — an ordinary failure, so a team counts the
/// attempt and tells the member what it was doing when it is tried again.
fn looped_error(what: &str) -> String {
    format!("El agente repetía la misma llamada una y otra vez ({what}) y se detuvo el turno: estaba en un bucle. Si de verdad necesita ese resultado, ya lo tiene; que cambie de enfoque.")
}

fn mcp_name(servers: &[String], name: &str) -> String {
    let mut servers: Vec<&String> = servers.iter().collect();
    servers.sort_by_key(|server| std::cmp::Reverse(server.len()));
    for server in servers {
        for prefix in [format!("mcp__{server}__"), format!("mcp_{server}_"), format!("{server}__")] {
            if let Some(tool) = name.strip_prefix(&prefix).filter(|tool| !tool.is_empty()) {
                return format!("mcp__{server}__{tool}");
            }
        }
    }
    name.to_string()
}

/// A status line in the run log, in the app's own record shape (`agentLog.ts`'s `codeflow` events).
fn note(text: &str) -> String {
    json!({"type": "codeflow", "event": "note", "text": text}).to_string()
}

fn short(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > max {
        format!("{}…", one_line.chars().take(max).collect::<String>())
    } else {
        one_line
    }
}

// ---------------------------------------------------------------------------------------------
// One-off calls: a quota read
// ---------------------------------------------------------------------------------------------

/// Starts `cmd`, initializes it as an ACP server, calls `method` and ends it. For reads that cost
/// no model call — Grok's `_x.ai/billing`.
pub(crate) async fn call_once(cmd: tokio::process::Command, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let mut connection = Connection::start(cmd)?;
    tokio::time::timeout(timeout, async {
        connection.initialize().await?;
        connection.request(method, params, timeout).await
    })
    .await
    .map_err(|_| format!("the agent server did not answer in {} s", timeout.as_secs()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_call_over_and_over_is_a_loop_and_looking_again_after_a_change_is_not() {
        let read = |path: &str| json!({"file_path": path});
        // Six times in a row, whatever the call.
        let mut guard = LoopGuard::default();
        for _ in 0..SAME_CALL_STREAK - 1 {
            assert_eq!(guard.see("Bash", &json!({"command": "npm test"})), None);
        }
        assert_eq!(guard.see("Bash", &json!({"command": "npm test"})).as_deref(), Some("Bash npm test"));

        // Read, edit, read, edit…: every look comes after a change. Not a loop, however long.
        let mut guard = LoopGuard::default();
        for _ in 0..40 {
            assert_eq!(guard.see("Read", &read("src/a.ts")), None);
            assert_eq!(guard.see("Edit", &read("src/a.ts")), None);
        }

        // The same two files read in turn, nothing changed in between: a loop at the tenth look
        // at the first of them, though no call was ever made twice in a row.
        let mut guard = LoopGuard::default();
        for round in 1..SAME_LOOK_LIMIT {
            assert_eq!(guard.see("Read", &read("src/a.ts")), None, "round {round}");
            assert_eq!(guard.see("Read", &read("src/b.ts")), None, "round {round}");
        }
        assert_eq!(guard.see("Read", &read("src/a.ts")).as_deref(), Some("Read src/a.ts"));

        // Different things each time are just work.
        let mut guard = LoopGuard::default();
        for n in 0..200 {
            assert_eq!(guard.see("Read", &read(&format!("src/{n}.ts"))), None);
        }
    }

    #[test]
    fn a_turn_that_loops_ends_as_a_failure_not_as_a_stop() {
        let mut translator = Translator::new(vec![]);
        let call = |n: usize| json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": format!("t{n}"), "kind": "read", "title": "Read", "locations": [{"path": "/r/a.ts"}]}});
        for n in 0..SAME_CALL_STREAK {
            translator.notification("session/update", &call(n), "s");
        }
        // The same call announced twice is one step, not two.
        translator.notification("session/update", &call(0), "s");
        let what = translator.looped.clone().expect("six identical reads in a row");
        assert_eq!(what, "Read /r/a.ts");
        let error = looped_error(&what);
        assert!(!error.contains(ai_runs::CANCELLED_MARKER), "a loop counts as an attempt; a Stop hands it back");
        assert!(error.contains("Read /r/a.ts"));
    }

    fn policy(acts: bool, full: bool, grounding: bool, sandboxed: bool) -> Policy {
        Policy { acts, full, grounding, sandboxed, root: "/r".into(), servers: vec![] }
    }

    #[test]
    fn reads_always_run_and_a_grounding_turn_does_nothing_else() {
        for kind in ["read", "search", "think", "fetch"] {
            assert_eq!(decide(&policy(false, false, true, false), kind, None, "t", None), Decision::Allow);
        }
        for kind in ["edit", "execute", "delete", "other"] {
            assert_eq!(decide(&policy(true, true, true, false), kind, Some("ls"), "t", None), Decision::Deny, "{kind}");
        }
    }

    #[test]
    fn a_turn_that_acts_runs_everything_but_a_dangerous_line_which_cf_guard_asks_about() {
        let acts = policy(true, false, false, false);
        assert_eq!(decide(&acts, "edit", None, "t", None), Decision::Allow);
        assert_eq!(decide(&acts, "execute", Some("cargo test"), "t", None), Decision::Allow);
        assert!(matches!(decide(&acts, "execute", Some("rm -rf /"), "t", None), Decision::Guard(_, _)));
        assert_eq!(decide(&acts, "other", None, "mcp tool", None), Decision::Allow);
        // «Completo» asks nothing, the dangerous line included.
        assert_eq!(decide(&policy(true, true, false, false), "execute", Some("rm -rf /"), "t", None), Decision::Allow);
    }

    #[test]
    fn a_plan_turn_writes_nothing_and_runs_commands_only_inside_a_sandbox() {
        let plan = policy(false, false, false, false);
        assert_eq!(decide(&plan, "edit", None, "t", None), Decision::Deny);
        assert_eq!(decide(&plan, "delete", None, "t", None), Decision::Deny);
        assert_eq!(decide(&plan, "execute", Some("ls"), "t", None), Decision::Deny, "no sandbox, no command");
        assert_eq!(decide(&policy(false, false, false, true), "execute", Some("ls"), "t", None), Decision::Allow);
        assert!(matches!(decide(&plan, "other", None, "browser click", None), Decision::AskUser(_)));
    }

    #[test]
    fn the_app_s_own_servers_are_answered_as_claude_code_has_them_pre_approved() {
        let map = format!("mcp__{}__find_symbol", crate::codemap::mcp::SERVER_NAME);
        // The map runs on every kind of turn, grounding included: its token is the limit.
        for p in [policy(false, false, true, false), policy(false, false, false, false), policy(true, false, false, false)] {
            assert_eq!(decide(&p, "other", None, "t", Some(&map)), Decision::Allow);
        }
        let read_page = format!("mcp__{}__browser_snapshot", crate::chat_exec::BROWSER_SERVER);
        let click = format!("mcp__{}__browser_click", crate::chat_exec::BROWSER_SERVER);
        assert_eq!(decide(&policy(false, false, false, false), "other", None, "t", Some(&read_page)), Decision::Allow);
        assert_eq!(decide(&policy(false, false, false, false), "other", None, "t", Some(&click)), Decision::Deny, "a plan turn reads pages only");
        assert_eq!(decide(&policy(false, false, true, false), "other", None, "t", Some(&read_page)), Decision::Deny);
        // A user's server: runs on a turn that acts, asks on a plan turn, never on grounding.
        assert_eq!(decide(&policy(true, false, false, false), "other", None, "t", Some("mcp__gh__create_issue")), Decision::Allow);
        assert!(matches!(decide(&policy(false, false, false, false), "other", None, "t", Some("mcp__gh__create_issue")), Decision::AskUser(_)));
        assert_eq!(decide(&policy(false, false, true, false), "other", None, "t", Some("mcp__gh__x")), Decision::Deny);
    }

    /// agy and Grok over ACP get the sandbox tools on their turn's own token (`codemap::mcp::for_repository`),
    /// so the prompt lets them through on every kind of turn, as Claude Code has them pre-approved:
    /// whether `sandbox_exec` / `sandbox_write_file` exist and run is the token's "may act"
    /// (`codemap::mcp::Access::sandbox_acts`), the same as for every other CLI. In «Restringido» they
    /// ask nothing either — the command runs in the sandbox, not on this computer.
    #[test]
    fn the_sandbox_tools_are_judged_by_the_token_like_the_rest_of_the_map() {
        let servers = vec![crate::codemap::mcp::SERVER_NAME.to_string()];
        for tool in crate::containers::agent_sandbox::tools::offered(true) {
            let named = mcp_name(&servers, &format!("mcp_{}_{tool}", crate::codemap::mcp::SERVER_NAME));
            assert_eq!(named, format!("mcp__{}__{tool}", crate::codemap::mcp::SERVER_NAME));
            for p in [policy(true, false, false, false), policy(true, true, false, false), policy(false, false, false, false)] {
                assert_eq!(decide(&p, "execute", Some("npm test"), "t", Some(&named)), Decision::Allow, "{tool}");
            }
        }
    }

    #[test]
    fn mcp_names_are_read_off_each_agent_s_spelling() {
        let servers = vec!["codeflow_map".to_string(), "codeflow".to_string()];
        assert_eq!(mcp_name(&servers, "mcp_codeflow_map_app_run"), "mcp__codeflow_map__app_run");
        assert_eq!(mcp_name(&servers, "codeflow_map__find_symbol"), "mcp__codeflow_map__find_symbol");
        assert_eq!(mcp_name(&servers, "mcp_codeflow_x"), "mcp__codeflow__x");
        assert_eq!(mcp_name(&servers, "read_file"), "read_file");
    }

    #[test]
    fn tool_calls_become_claude_shaped_steps_and_mcp_tools_get_their_server() {
        let mut t = Translator::new(vec!["codeflow".into()]);
        let read = json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "1", "kind": "read", "title": "File x", "rawInput": {"Path": "/r/a.rs"}}});
        let line: Value = serde_json::from_str(&t.notification("session/update", &read, "s")[0]).unwrap();
        assert_eq!(line["message"]["content"][0]["name"], "Read");
        assert_eq!(line["message"]["content"][0]["input"]["file_path"], "/r/a.rs");
        // The same call announced twice is one step.
        assert!(t.notification("session/update", &read, "s").is_empty());

        t.notification("session/update", &json!({"sessionId": "s", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Mirando."}}}), "s");
        let agy = json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "2", "kind": "other", "name": "mcp_codeflow_app_run", "title": "Run", "rawInput": {"title": "x"}}});
        let lines = t.notification("session/update", &agy, "s");
        assert_eq!(lines.len(), 2, "the text before the call, then the call: {lines:?}");
        assert!(lines[0].contains("Mirando."));
        assert!(lines[1].contains("mcp__codeflow__app_run"));

        let grok = json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "3", "kind": "other", "title": "use_tool", "rawInput": {"tool_name": "codeflow__app_commands", "tool_input": {"query": "jira"}}}});
        assert!(t.notification("session/update", &grok, "s")[0].contains("mcp__codeflow__app_commands"));
        let search = json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "4", "kind": "other", "title": "search_tool", "rawInput": {}}});
        assert!(t.notification("session/update", &search, "s").is_empty());

        assert_eq!(t.answer, "Mirando.");
        // Another session's updates are not this turn's.
        let other = json!({"sessionId": "z", "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "no"}}});
        t.notification("session/update", &other, "s");
        assert_eq!(t.answer, "Mirando.");
    }

    #[test]
    fn the_reply_types_live_and_text_after_a_tool_opens_a_paragraph() {
        let mut t = Translator::new(vec![]);
        let chunk = |text: &str| json!({"sessionId": "s", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}});
        let thought = json!({"sessionId": "s", "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hmm"}}});
        t.notification("session/update", &thought, "s");
        t.notification("session/update", &chunk("Voy a "), "s");
        t.notification("session/update", &chunk("mirar."), "s");
        assert_eq!(t.take_live(), vec![("thinking", "hmm".to_string()), ("text", "Voy a ".to_string()), ("text", "mirar.".to_string())]);
        let tool = json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "1", "kind": "read", "title": "a", "rawInput": {"path": "/a"}}});
        t.notification("session/update", &tool, "s");
        t.notification("session/update", &chunk(" Listo."), "s");
        assert_eq!(t.take_live(), vec![("text", "\n\nListo.".to_string())]);
        assert_eq!(t.answer, "Voy a mirar.\n\nListo.", "the answer is what was typed");
        assert!(t.take_live().is_empty());
    }

    #[test]
    fn usage_reads_acp_s_block_and_grok_s_meta() {
        let agy = json!({"stopReason": "end_turn", "usage": {"inputTokens": 100, "outputTokens": 10, "thoughtTokens": 5, "cachedReadTokens": 50}});
        let u = usage_of(&agy).unwrap();
        assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cost_usd), (100, 15, 50, None));
        let grok = json!({"stopReason": "end_turn", "_meta": {"usage": {"inputTokens": 7, "outputTokens": 3, "reasoningTokens": 2, "cachedReadTokens": 1, "costUsdTicks": 315080000}}});
        let u = usage_of(&grok).unwrap();
        assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens), (7, 5, 1));
        assert!((u.cost_usd.unwrap() - 0.031508).abs() < 1e-9);
    }

    #[test]
    fn app_servers_become_acp_servers() {
        let http = crate::mcp_registry::LiveServer { name: "codeflow".into(), transport: "http".into(), command: String::new(), args: vec![], env: vec![], url: "http://127.0.0.1:1/mcp/code/t".into(), headers: vec![("A".into(), "b".into())] };
        assert_eq!(mcp_server(&http).unwrap(), json!({"type": "http", "name": "codeflow", "url": "http://127.0.0.1:1/mcp/code/t", "headers": [{"name": "A", "value": "b"}]}));
        let stdio = crate::mcp_registry::LiveServer { name: "gh".into(), transport: "stdio".into(), command: "gh-mcp".into(), args: vec!["--x".into()], env: vec![("T".into(), "1".into())], url: String::new(), headers: vec![] };
        assert_eq!(mcp_server(&stdio).unwrap(), json!({"name": "gh", "command": "gh-mcp", "args": ["--x"], "env": [{"name": "T", "value": "1"}]}));
    }

    #[test]
    fn the_sentinel_is_not_a_session_to_load() {
        assert!(!is_session_id("agy-last"));
        assert!(!is_session_id(""));
        assert!(is_session_id("4e82ba5c-fe10-4865-bbb5-8291faa7b88a"));
    }

    /// One real turn over ACP, end to end: a read tool, the answer, the session and its usage —
    /// then the same session resumed by a second turn. Spends a little of the account's quota, so it
    /// runs only when asked: `cargo test --lib acp::tests::live -- --ignored --nocapture`.
    async fn live_turn(engine: &dyn AiEngine, model: &str) {
        let dir = std::env::temp_dir().join(format!("cf-acp-live-{}-{}", engine.id(), uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.txt"), "secret-word: tangerine\n").unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let mut inv = AiInvocation::new("Read the file note.txt in the current directory and reply with only the secret word.", "");
        inv.cwd = Some(&cwd);
        inv.model = model;
        inv.auto_approve_edits = true;
        let started = Instant::now();
        let Outcome::Ran(first) = run(engine, engine.default_binary(), &inv, &[], &None, &mut None).await else { panic!("{} ACP unavailable", engine.id()) };
        let first = first.unwrap_or_else(|e| panic!("{}: {e}", engine.id()));
        eprintln!("{}: {:?} in {:?} — session {:?}, usage {:?}, context {:?}", engine.id(), first.text, started.elapsed(), first.session_id, first.usage, first.context_tokens);
        assert!(first.text.to_lowercase().contains("tangerine"), "{}", first.text);
        assert!(first.session_id.is_some());

        let session = first.session_id.clone().unwrap();
        let mut again = AiInvocation::new("In one word: what was the secret word you found before?", "");
        again.cwd = Some(&cwd);
        again.model = model;
        again.resume_session_id = Some(&session);
        let started = Instant::now();
        let Outcome::Ran(second) = run(engine, engine.default_binary(), &again, &[], &None, &mut None).await else { panic!("unavailable") };
        let second = second.unwrap_or_else(|e| panic!("{}: {e}", engine.id()));
        eprintln!("{} resumed: {:?} in {:?} (warm server)", engine.id(), second.text, started.elapsed());
        assert!(second.text.to_lowercase().contains("tangerine"), "{}", second.text);
        assert_eq!(second.session_id.as_deref(), Some(session.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Permissions, for real: a turn that acts writes the file it was asked for; a read-only one is
    /// refused the write by [`decide`] and the file never appears.
    #[tokio::test]
    #[ignore]
    async fn live_gemini_permissions() {
        let engine = crate::gemini::GeminiEngine;
        for acts in [true, false] {
            let dir = std::env::temp_dir().join(format!("cf-acp-perm-{acts}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            let cwd = dir.to_string_lossy().to_string();
            let mut inv = AiInvocation::new("Create a file named out.txt in the current directory containing exactly the word hello. Then reply DONE, or BLOCKED if you could not.", "");
            inv.cwd = Some(&cwd);
            inv.auto_approve_edits = acts;
            inv.read_only = !acts;
            let Outcome::Ran(result) = run(&engine, engine.default_binary(), &inv, &[], &None, &mut None).await else { panic!("unavailable") };
            let written = dir.join("out.txt").exists();
            eprintln!("acts={acts}: {:?} — out.txt written: {written}", result.as_ref().map(|r| r.text.clone()));
            assert_eq!(written, acts, "acts={acts}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_gemini() {
        live_turn(&crate::gemini::GeminiEngine, "").await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_grok() {
        live_turn(&crate::grok::GrokEngine, "").await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_opencode() {
        live_turn(&crate::opencode::OpenCodeEngine, "opencode/beam-free").await;
    }

    #[test]
    fn a_quota_refusal_is_marked_as_one() {
        assert!(failure("Insufficient balance. Top up").starts_with(QUOTA_MARKER));
        assert!(!failure("model not found").starts_with(QUOTA_MARKER));
    }
}
