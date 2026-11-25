//! `app_run`: a script over CodeFlow's commands, for a model — Cloudflare's "Code Mode" for the
//! app's own gateway (`crate::app_gateway`).
//!
//! **Why.** `app_call` hands every answer back to the model: a task of ten calls is ten round trips,
//! and ten answers read whole — logs, listings, rows — to keep two lines of each. A script makes the
//! calls, loops and filters where the data is, and only what it returns reaches the model. The user's
//! call (2026-11-24): use it *when it is needed*, for every provider the app drives, and show each
//! step it took.
//!
//! **The sandbox** is a fresh QuickJS runtime per script, on a thread of its own (a runtime is not
//! `Send`), the engine Flujos' Code node runs in (`flows::expr`): no file, no socket, no process, no
//! timer. Its one door out is `app.call(command, args)`, which goes through `app_gateway::admit` and
//! `app_gateway::invoke` — the gates `app_call` has (plan mode, the workspace, a database's switch,
//! the blocked commands) — and comes back scrubbed of every secret the app knows. `app.call` returns
//! the answer directly (awaiting it works too) and throws on a refusal or a failure, with the
//! command's name on the error.
//!
//! **What it may not do.** A destructive command is refused inside a script: it needs the user's
//! yes, and a script that stops halfway waiting for one — or goes on after a no — is a worse thing to
//! approve than one call. The model calls it with `app_call`. A script also has bounds: [`Limits`].
//!
//! **What the user sees.** The run's log gets records ([`MARK`]) the chat draws as one step that
//! opens: the code, every call with its outcome and time, and what the script returned
//! (`src/lib/appScript.ts`). Written by the app as it runs, so every provider's turn shows the same
//! card — whatever its CLI's own log looks like.
//!
//! **Who gets it.** A provider setting, `app_scripts:<provider>` ([`enabled_for`]): on by default
//! for the CLIs, off for the local models, whose small models write worse code.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use rquickjs::{CatchResultExt, Context, Function, Promise, Runtime};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

/// What the model reads about the tool. It is the whole of the guidance on *when*: the rest is the
/// hint `app_call` adds when a task turns into many calls (`app_gateway::script_hint`).
pub const DESCRIPTION: &str = "Run a short JavaScript script over CodeFlow's commands (the ones app_commands lists) and get back only what it returns. Use it when a task needs 3 or more calls, a loop, one answer feeding the next call, or filtering a large answer; for one or two calls use app_call. The code is the body of an async function: `const svc = app.call(\"list_services\", { workspaceId: app.workspaceId });` returns the answer (await is optional) and throws on failure; `return` what the user needs — small. app.workspaceId, app.projectId and app.root say where this run is. console.log is returned too. No files, network or timers. Destructive commands are refused here: call them with app_call, so the user can approve each. Limits: 40 calls and 5 minutes a script, 200 calls a turn.";

/// [`DESCRIPTION`] for a run that has no `app_call` — a local model's (`app_gateway::tools_for`):
/// the script is its one door to the app, so nothing here sends it to another, and a destructive
/// command is the user's to do.
pub const DESCRIPTION_SCRIPT_ONLY: &str = "Run a short JavaScript script over CodeFlow's commands (the ones app_commands lists) and get back only what it returns — for one call too: a one-line script. The code is the body of an async function: `const svc = app.call(\"list_services\", { workspaceId: app.workspaceId });` returns the answer (await is optional) and throws on failure; `return` what the user needs — small. app.workspaceId, app.projectId and app.root say where this run is. console.log is returned too. No files, network or timers. Destructive commands are refused: tell the user what to do in CodeFlow instead. Limits: 40 calls and 5 minutes a script, 200 calls a turn.";

/// The prefix of the records in a run's log — read by `src/lib/appScript.ts`.
pub const MARK: &str = "⎔ ";

/// How far one script may go.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// `app.call`s, failed ones included. The first call past it is refused — catchable, so the script
    /// can return what it has — and the next one ends the script: a `try`/`catch` loop does not go on
    /// knocking until the clock runs out.
    pub calls: usize,
    /// Wall time, the calls included: a deadline the interrupt handler and every call check.
    pub time: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { calls: 40, time: Duration::from_secs(300) }
    }
}

/// The `app.call`s all of one turn's scripts may make together. A script has its own 40, and a model
/// that ran script after script would get 40 more each time: this is the ceiling over them — five
/// full scripts, far past a task's need and short of a loop that never ends (2026-11-24).
pub const TURN_CALLS: usize = 200;
/// A turn the app cannot name (a CLI's run with no link to one) is its session, until it has made no
/// script call for this long.
const TURN_IDLE: Duration = Duration::from_secs(30 * 60);

/// Calls made by scripts per turn (its run id, or its session): when the last was, and how many.
static TURN_SPENT: LazyLock<Mutex<HashMap<String, (Instant, usize)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// What is left of `turn`'s [`TURN_CALLS`].
fn turn_left(turn: &str) -> usize {
    let Ok(mut spent) = TURN_SPENT.lock() else { return TURN_CALLS };
    let now = Instant::now();
    spent.retain(|_, (at, _)| now.duration_since(*at) < TURN_IDLE);
    TURN_CALLS.saturating_sub(spent.get(turn).map(|(_, n)| *n).unwrap_or(0))
}

fn turn_spend(turn: &str, calls: usize) {
    if let Ok(mut spent) = TURN_SPENT.lock() {
        let entry = spent.entry(turn.to_string()).or_insert((Instant::now(), 0));
        entry.0 = Instant::now();
        entry.1 += calls;
    }
}

/// The longest script taken. A script that size is a program, not a few calls and a filter.
const MAX_CODE: usize = 20_000;
/// What one script's JavaScript may hold at once.
const MEMORY_LIMIT: usize = 128 * 1024 * 1024;
const JS_STACK: usize = 2 * 1024 * 1024;
const THREAD_STACK: usize = 8 * 1024 * 1024;
/// The largest answer handed into a script. Far past what a model could read — the point — but
/// not a dump of a whole database into the sandbox.
const MAX_VALUE: usize = 8 * 1024 * 1024;
/// `console.log` kept, in all.
const MAX_LOG: usize = 4_000;
/// Of the model's answer, what the return value may take: the rest is the trace.
const MAX_RETURN: usize = crate::app_gateway::MAX_ANSWER - 6_000;
/// What the UI's record keeps of the return value.
const RETURN_PREVIEW: usize = 600;

/// One `app.call`, as the trace shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CallRecord {
    pub command: String,
    /// The arguments, short, without the ones every call carries (`workspaceId`).
    pub about: String,
    pub ok: bool,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// How a script ended.
#[derive(Debug)]
pub struct Outcome {
    /// What it returned, as JSON — `None` when it threw.
    pub value: Option<Value>,
    /// Why it stopped, when it did not return.
    pub error: Option<String>,
    pub calls: Vec<CallRecord>,
    pub logs: String,
    pub ms: u64,
    /// It ran out of time or was stopped, rather than throwing.
    pub interrupted: bool,
    /// The bytes of every answer the script read — what calling one command at a time would have
    /// handed the model, and the script kept out of its context.
    pub read_bytes: u64,
}

impl Outcome {
    pub fn ok(&self) -> bool {
        self.error.is_none()
    }

    /// The call the script stopped at: the last one, when it failed and the script then threw.
    pub fn failed_at(&self) -> Option<usize> {
        if self.ok() {
            return None;
        }
        self.calls.last().filter(|call| !call.ok).map(|_| self.calls.len() - 1)
    }
}

/// The door out of the sandbox: one command by name, its arguments, its answer.
pub type Host = Arc<dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync>;
/// Told about each call as it finishes, for a live trace.
pub type OnCall = Arc<dyn Fn(usize, &CallRecord) + Send + Sync>;

/// Sets the flag when dropped: a script whose caller went away (the run stopped, the request was
/// dropped) stops at its next instruction or call.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Runs `code` against `host`. `context` becomes `app.workspaceId`, `app.projectId` and `app.root`.
/// Never fails as a Rust error: an engine that would not start is an [`Outcome`] with its error.
pub async fn execute(code: &str, context: Value, host: Host, on_call: OnCall, stop: Arc<AtomicBool>, limits: Limits) -> Outcome {
    let started = Instant::now();
    if code.trim().is_empty() {
        return refused("The script is empty: send its code in `code`.", started);
    }
    if code.chars().count() > MAX_CODE {
        return refused(&format!("The script is longer than {MAX_CODE} characters: keep it to the calls and the filtering, and return less."), started);
    }
    let (reply, answer) = oneshot::channel();
    let source = code.to_string();
    let flag = stop.clone();
    let spawned = std::thread::Builder::new()
        .name("app-script".into())
        .stack_size(THREAD_STACK)
        .spawn(move || {
            let outcome = run_in_thread(&source, &context, host, on_call, flag, limits, started);
            let _ = reply.send(outcome);
        });
    if let Err(error) = spawned {
        return refused(&format!("Could not start the script engine: {error}"), started);
    }
    let _guard = StopOnDrop(stop);
    answer.await.unwrap_or_else(|_| refused("The script engine stopped mid-script", started))
}

fn refused(why: &str, started: Instant) -> Outcome {
    Outcome { value: None, error: Some(why.to_string()), calls: Vec::new(), logs: String::new(), ms: started.elapsed().as_millis() as u64, interrupted: false, read_bytes: 0 }
}

/// The JavaScript around the model's code: `app` and `console`, then the code as the body of an
/// async function, on the wrapper's first line so an error's line number is the code's own.
const PRELUDE: &str = r#"(() => {
  const call = __cf_call, log = __cf_log, where = JSON.parse(__cf_where);
  const text = (v) => { if (typeof v === "string") return v; try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (_) { return String(v); } };
  const say = (...parts) => log(parts.map(text).join(" "));
  globalThis.console = Object.freeze({ log: say, info: say, warn: say, error: say, debug: say });
  globalThis.app = Object.freeze({
    workspaceId: where.workspaceId ?? null,
    projectId: where.projectId ?? null,
    root: where.root ?? null,
    call(command, args) {
      if (typeof command !== "string" || !command.trim()) throw new TypeError("app.call(command, args): command is the command's name, as app_commands lists it");
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) throw new TypeError("app.call(" + JSON.stringify(command) + ", args): args must be an object");
      const answer = JSON.parse(call(command, JSON.stringify(args ?? {})));
      if (Object.prototype.hasOwnProperty.call(answer, "error")) {
        const error = new Error(command + ": " + answer.error);
        error.command = command;
        throw error;
      }
      return answer.ok;
    },
  });
  delete globalThis.__cf_call;
  delete globalThis.__cf_log;
  delete globalThis.__cf_where;
})();
"#;

fn wrap(code: &str) -> String {
    format!(
        "(async () => {{ try {{ const __value = await (async () => {{ {code}\n}})(); let __text; try {{ __text = JSON.stringify(__value === undefined ? null : __value); }} catch (e) {{ return JSON.stringify({{ error: \"What the script returned cannot be turned into JSON: \" + (e && e.message) }}); }} return '{{\"ok\":' + (__text === undefined ? \"null\" : __text) + '}}'; }} catch (e) {{ return JSON.stringify({{ error: e && e.message !== undefined ? String(e.message) : String(e), stack: e && e.stack ? String(e.stack) : undefined }}); }} }})()"
    )
}

fn run_in_thread(code: &str, context: &Value, host: Host, on_call: OnCall, stop: Arc<AtomicBool>, limits: Limits, started: Instant) -> Outcome {
    let deadline = started + limits.time;
    let calls: Arc<Mutex<Vec<CallRecord>>> = Arc::new(Mutex::new(Vec::new()));
    let logs: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let timed_out = Arc::new(AtomicBool::new(false));
    let spent = Arc::new(AtomicBool::new(false));
    let read = Arc::new(AtomicU64::new(0));
    let finish = |value: Option<Value>, error: Option<String>, interrupted: bool| Outcome {
        value,
        error,
        calls: calls.lock().map(|c| c.clone()).unwrap_or_default(),
        logs: logs.lock().map(|l| l.clone()).unwrap_or_default(),
        ms: started.elapsed().as_millis() as u64,
        interrupted,
        read_bytes: read.load(Ordering::Relaxed),
    };

    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => return finish(None, Some(format!("Could not start the script engine: {error}")), false),
    };
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(JS_STACK);
    {
        let (stop, timed_out, spent) = (stop.clone(), timed_out.clone(), spent.clone());
        runtime.set_interrupt_handler(Some(Box::new(move || {
            if stop.load(Ordering::Relaxed) || spent.load(Ordering::Relaxed) {
                return true;
            }
            if Instant::now() >= deadline {
                timed_out.store(true, Ordering::Relaxed);
                return true;
            }
            false
        })));
    }
    let context_js = match Context::full(&runtime) {
        Ok(context) => context,
        Err(error) => return finish(None, Some(format!("Could not start the script engine: {error}")), false),
    };

    let answer: Result<String, String> = context_js.with(|ctx| {
        let install = || -> rquickjs::Result<()> {
            let globals = ctx.globals();
            let (calls, stop, timed_out, spent, read) = (calls.clone(), stop.clone(), timed_out.clone(), spent.clone(), read.clone());
            globals.set(
                "__cf_call",
                Function::new(ctx.clone(), move |command: String, args: String| -> String {
                    let bounds = Bounds { stop: &stop, timed_out: &timed_out, spent: &spent, read: &read, deadline, limits };
                    one_call(&command, &args, &host, &on_call, &calls, &bounds)
                })?,
            )?;
            let logs = logs.clone();
            globals.set(
                "__cf_log",
                Function::new(ctx.clone(), move |line: String| {
                    if let Ok(mut logs) = logs.lock() {
                        if logs.len() < MAX_LOG {
                            let room = MAX_LOG - logs.len();
                            let mut line: String = line.chars().take(room).collect();
                            if !logs.is_empty() {
                                line.insert(0, '\n');
                            }
                            logs.push_str(&line);
                        }
                    }
                })?,
            )?;
            globals.set("__cf_where", context.to_string())?;
            ctx.eval::<rquickjs::Value, _>(PRELUDE)?;
            Ok(())
        };
        install().catch(&ctx).map_err(|e| format!("The script engine did not start: {e}"))?;
        let run = || -> Result<String, rquickjs::CaughtError<'_>> {
            let promise: Promise = ctx.eval(wrap(code)).catch(&ctx)?;
            promise.finish::<String>().catch(&ctx)
        };
        run().map_err(|error| match &error {
            rquickjs::CaughtError::Error(rquickjs::Error::WouldBlock) => {
                "The script awaited something that never settles — there are no timers or network here, and app.call answers at once".to_string()
            }
            other => other.to_string(),
        })
    });

    if stop.load(Ordering::Relaxed) {
        return finish(None, Some("The script was stopped.".into()), true);
    }
    if spent.load(Ordering::Relaxed) {
        return finish(None, Some(format!("The script kept calling after its limit of {} calls and was ended: return what you have once a call says the limit is reached, or split the work.", limits.calls)), true);
    }
    if timed_out.load(Ordering::Relaxed) && answer.is_err() {
        return finish(None, Some(format!("The script ran out of time ({} s).", limits.time.as_secs())), true);
    }
    match answer {
        Err(message) => finish(None, Some(message), false),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(mut parsed) => {
                if let Some(value) = parsed.get_mut("ok") {
                    finish(Some(value.take()), None, false)
                } else {
                    let message = parsed.get("error").and_then(Value::as_str).unwrap_or("The script failed").to_string();
                    let interrupted = timed_out.load(Ordering::Relaxed);
                    let message = if interrupted { format!("The script ran out of time ({} s).", limits.time.as_secs()) } else { message };
                    finish(None, Some(message), interrupted)
                }
            }
            Err(error) => finish(None, Some(format!("Unreadable answer from the script engine: {error}")), false),
        },
    }
}

/// What bounds one script's calls, as `__cf_call` sees it.
struct Bounds<'a> {
    stop: &'a AtomicBool,
    timed_out: &'a AtomicBool,
    /// Set by a call past the limit after the refused one: the interrupt handler ends the script.
    spent: &'a AtomicBool,
    /// The bytes of the answers handed into the script, added up ([`Outcome::read_bytes`]).
    read: &'a AtomicU64,
    deadline: Instant,
    limits: Limits,
}

/// One `app.call`, inside the sandbox's thread: bounded, recorded, and answered as JSON text —
/// `{"ok": answer}` or `{"error": why}`.
fn one_call(command: &str, args: &str, host: &Host, on_call: &OnCall, calls: &Mutex<Vec<CallRecord>>, bounds: &Bounds) -> String {
    let Bounds { stop, timed_out, spent, read, deadline, limits } = *bounds;
    let began = Instant::now();
    let args: Value = serde_json::from_str(args).unwrap_or_else(|_| json!({}));
    let made = calls.lock().map(|c| c.len()).unwrap_or(usize::MAX);
    // Past the limit and already told once: no record, no event, and the script ends at its next
    // instruction — a loop that catches the refusal does not fill the run's log until the clock runs out.
    if made > limits.calls || stop.load(Ordering::Relaxed) || timed_out.load(Ordering::Relaxed) {
        if made > limits.calls {
            spent.store(true, Ordering::SeqCst);
        }
        return json!({ "error": "the script is over its bounds" }).to_string();
    }
    let result = if began >= deadline {
        timed_out.store(true, Ordering::Relaxed);
        Err(format!("the script ran out of time ({} s)", limits.time.as_secs()))
    } else if made >= limits.calls {
        Err(format!("the script reached its limit of {} calls: return what you have, or split the work", limits.calls))
    } else {
        host(command, args.clone())
    };
    let encoded = match result {
        Ok(value) => {
            let text = json!({ "ok": value }).to_string();
            if text.len() > MAX_VALUE {
                Err(format!("the answer is too large for a script ({} MB): ask for less — a filter, a page, one item", text.len() / (1024 * 1024)))
            } else {
                read.fetch_add(text.len() as u64, Ordering::Relaxed);
                Ok(text)
            }
        }
        Err(error) => Err(error),
    };
    let record = CallRecord {
        command: command.to_string(),
        about: about(&args),
        ok: encoded.is_ok(),
        ms: began.elapsed().as_millis() as u64,
        error: encoded.as_ref().err().map(|e| short(e, 300)),
    };
    let index = match calls.lock() {
        Ok(mut calls) => {
            calls.push(record.clone());
            calls.len() - 1
        }
        Err(_) => 0,
    };
    on_call(index, &record);
    encoded.unwrap_or_else(|error| json!({ "error": error }).to_string())
}

/// A call's arguments as the trace shows them: compact, without `workspaceId` (every call carries
/// it), cut short.
fn about(args: &Value) -> String {
    let Some(map) = args.as_object() else { return String::new() };
    let kept: serde_json::Map<String, Value> = map.iter().filter(|(key, _)| key.as_str() != "workspaceId").map(|(k, v)| (k.clone(), v.clone())).collect();
    if kept.is_empty() {
        return String::new();
    }
    // One argument says itself: `worker`, not `{"name":"worker"}`.
    if kept.len() == 1 {
        if let Some(Value::String(only)) = kept.values().next() {
            return short(only, 80);
        }
    }
    short(&Value::Object(kept).to_string(), 80)
}

fn short(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > max {
        format!("{}…", one_line.chars().take(max).collect::<String>())
    } else {
        one_line
    }
}

fn seconds(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms} ms")
    } else {
        format!("{:.1} s", ms as f64 / 1000.0)
    }
}

/// What the model reads: the return value (or why the script stopped), then the trace — and what it
/// logged.
///
/// **The trace is the model's, not the window's.** The window has every call with its arguments and
/// time from the records ([`MARK`]); the model needs to know what ran and what went wrong. So the
/// calls that went through are counted by command — `service_log ×10` — and only a failed one gets a
/// line of its own, with its arguments and why (2026-11-24). Forty calls cost one line, not forty.
pub fn render(outcome: &Outcome) -> String {
    let mut out = String::new();
    match (&outcome.value, &outcome.error) {
        (_, Some(error)) => {
            out.push_str("The script stopped: ");
            out.push_str(error);
            if let Some(at) = outcome.failed_at() {
                out.push_str(&format!(" (call #{} below)", at + 1));
            }
        }
        (Some(Value::String(text)), None) => out.push_str(text),
        (Some(value), None) => out.push_str(&value.to_string()),
        (None, None) => out.push_str("null"),
    }
    if out.len() > MAX_RETURN {
        let mut cut = MAX_RETURN;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n[… return value cut: return less]");
    }
    out.push_str(&format!(
        "\n\n— app_run: {} call{} · {}{}",
        outcome.calls.len(),
        if outcome.calls.len() == 1 { "" } else { "s" },
        seconds(outcome.ms),
        if outcome.ok() { "" } else { " · stopped" }
    ));
    let tally = tally(outcome.calls.iter().filter(|call| call.ok).map(|call| call.command.as_str()));
    if !tally.is_empty() {
        out.push_str(&format!("\n✓ {tally}"));
    }
    let failed: Vec<(usize, &CallRecord)> = outcome.calls.iter().enumerate().filter(|(_, call)| !call.ok).collect();
    for (index, call) in failed.iter().take(MAX_FAILED_LINES) {
        let about = if call.about.is_empty() { String::new() } else { format!(" {}", call.about) };
        let why = call.error.as_deref().map(|e| format!(": {e}")).unwrap_or_default();
        out.push_str(&format!("\n✗ #{} {}{about}{why}", index + 1, call.command));
    }
    if failed.len() > MAX_FAILED_LINES {
        out.push_str(&format!("\n✗ … {} more failed", failed.len() - MAX_FAILED_LINES));
    }
    if !outcome.logs.is_empty() {
        out.push_str("\nconsole:\n");
        out.push_str(&outcome.logs);
    }
    out
}

/// Failed calls the model is told one by one; past these, how many more.
const MAX_FAILED_LINES: usize = 8;
/// Commands a tally names; past these, how many more.
const MAX_TALLIED: usize = 10;

/// `list_services, service_log ×10, services_restart ×2` — commands in the order first called.
fn tally<'a>(commands: impl Iterator<Item = &'a str>) -> String {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for command in commands {
        match counts.iter_mut().find(|(name, _)| *name == command) {
            Some((_, n)) => *n += 1,
            None => counts.push((command, 1)),
        }
    }
    let mut parts: Vec<String> = counts.iter().take(MAX_TALLIED).map(|(name, n)| if *n == 1 { name.to_string() } else { format!("{name} ×{n}") }).collect();
    if counts.len() > MAX_TALLIED {
        parts.push(format!("+{} more", counts.len() - MAX_TALLIED));
    }
    parts.join(", ")
}

/// The record lines the run's log carries — see [`MARK`]. `start` has the code; each call follows as
/// it finishes; `end` says how it went and a preview of what came back.
fn record(value: Value) -> String {
    format!("{MARK}{value}")
}

fn preview(outcome: &Outcome) -> Option<String> {
    let value = outcome.value.as_ref()?;
    let text = match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    Some(if text.chars().count() > RETURN_PREVIEW { format!("{}…", text.chars().take(RETURN_PREVIEW).collect::<String>()) } else { text })
}

/// Whether `provider`'s runs get `app_run` — the setting `app_scripts:<provider>`, `on` or `off`;
/// unset is the provider's default ([`default_on`]).
pub fn enabled_for(provider: &str) -> bool {
    if provider.is_empty() {
        return false;
    }
    match crate::ai_usage::setting(&format!("app_scripts:{provider}")).as_deref() {
        Some("on") => true,
        Some("off") => false,
        _ => default_on(provider),
    }
}

/// On for the CLIs; off for the local models (small ones write worse code) and for the user's own
/// command, which gets no CodeFlow tools at all.
pub fn default_on(provider: &str) -> bool {
    provider != crate::local_agent::PROVIDER_ID && provider != crate::custom::PROVIDER_ID
}

/// `app_run` for a run: the script, every call through the gateway as this run, its records in the
/// run's log (`run`), and the model's answer — an `Err` when the script did not return, so the
/// client marks the call failed.
pub async fn run(app: &tauri::AppHandle, scope: &crate::app_gateway::Scope<'_>, args: &Value, run: Option<crate::ai_runs::RunCtx>) -> Result<String, String> {
    let code = args.get("code").and_then(Value::as_str).unwrap_or_default().to_string();
    let title = args.get("title").and_then(Value::as_str).map(|t| short(t, 80)).filter(|t| !t.is_empty()).unwrap_or_else(|| "script".into());
    let id = uuid::Uuid::new_v4().simple().to_string();
    // The turn's ceiling over all its scripts: refused before anything runs once it is spent.
    let turn = run.as_ref().map(|ctx| ctx.run_id.clone()).unwrap_or_else(|| scope.session.to_string());
    let left = turn_left(&turn);
    if left == 0 {
        return Err(format!(
            "Not run: this turn's scripts already made {TURN_CALLS} calls. Answer with what you have, and ask the user before going on — or do what is left with single calls."
        ));
    }
    if let Some(ctx) = &run {
        crate::ai_runs::emit_record(ctx, &record(json!({ "id": id, "phase": "start", "title": title, "code": code, "acts": scope.acts })));
    }

    let (root, session, acts, with_call) = (scope.root.to_string(), scope.session.to_string(), scope.acts, scope.with_call);
    let (workspace_id, project) = (scope.workspace_id.clone(), scope.project.clone());
    let context = json!({ "workspaceId": workspace_id, "projectId": project.as_ref().map(|p| p.id.clone()), "root": root });
    let limits = Limits { calls: Limits::default().calls.min(left), ..Limits::default() };
    // The script's clock, as its calls see it: a call is given what is left of it, never the
    // gateway's own three minutes on top (2026-11-24).
    let deadline = Instant::now() + limits.time;
    // Stop, and the request going away, reach a call in flight — not only the next one: the window
    // is told to drop what it started (`flows::bridge::ask`).
    let cancel = tokio_util::sync::CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let handle = tokio::runtime::Handle::current();
    let host_app = app.clone();
    let host_cancel = cancel.clone();
    let host: Host = Arc::new(move |command: &str, args: Value| {
        let scope = crate::app_gateway::Scope { root: &root, session: &session, acts, workspace_id: workspace_id.clone(), project: project.clone(), scripts: true, with_call };
        let admitted = crate::app_gateway::admit(&scope, command, Some(&args))?;
        if admitted.destructive() {
            return Err(if with_call {
                format!("{command} is destructive and does not run inside a script: call it with app_call, so the user can approve it")
            } else {
                format!("{command} is destructive and does not run inside a script: tell the user what to do in CodeFlow instead")
            });
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!("the script ran out of time ({} s)", limits.time.as_secs()));
        }
        let timeout = left.min(crate::app_gateway::CALL_TIMEOUT);
        let value = handle.block_on(crate::app_gateway::invoke_within(&host_app, &admitted, timeout, host_cancel.clone())).map_err(|error| {
            if error == crate::ai_runs::CANCELLED_MARKER {
                "the script was stopped".to_string()
            } else {
                error
            }
        })?;
        Ok(crate::app_gateway::scrub_value(&host_app, value))
    });
    let live = run.clone();
    let live_id = id.clone();
    let on_call: OnCall = Arc::new(move |index: usize, call: &CallRecord| {
        if let Some(ctx) = &live {
            crate::ai_runs::emit_record(ctx, &record(json!({ "id": live_id, "phase": "call", "index": index, "call": call })));
        }
    });

    let stop = Arc::new(AtomicBool::new(false));
    // The run's Stop reaches the script too.
    let mut cancelled = run.as_ref().and_then(|ctx| crate::ai_runs::subscribe(&ctx.run_id));
    let watcher = cancelled.take().map(|mut rx| {
        let (stop, cancel) = (stop.clone(), cancel.clone());
        tokio::spawn(async move {
            let halt = || {
                stop.store(true, Ordering::SeqCst);
                cancel.cancel();
            };
            if *rx.borrow() {
                halt();
                return;
            }
            while rx.changed().await.is_ok() {
                if *rx.borrow() {
                    halt();
                    break;
                }
            }
        })
    });
    let outcome = execute(&code, context, host, on_call, stop, limits).await;
    if let Some(watcher) = watcher {
        watcher.abort();
    }
    turn_spend(&turn, outcome.calls.len());
    let text = crate::app_gateway::clip(render(&outcome));
    crate::usage_stats::app_script(scope.root, outcome.calls.len(), outcome.ms, outcome.read_bytes, text.len() as u64);

    if let Some(ctx) = &run {
        crate::ai_runs::emit_record(
            ctx,
            &record(json!({
                "id": id,
                "phase": "end",
                "ok": outcome.ok(),
                "ms": outcome.ms,
                "error": outcome.error,
                "failedAt": outcome.failed_at(),
                "interrupted": outcome.interrupted,
                "returned": preview(&outcome),
                "logs": if outcome.logs.is_empty() { None } else { Some(short(&outcome.logs, 600)) },
                // What the script read, and what of it reached the model — the card's "kept out".
                "readBytes": outcome.read_bytes,
                "returnedBytes": text.len(),
            })),
        );
    }
    if outcome.ok() {
        Ok(text)
    } else {
        Err(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn services() -> Value {
        json!([
            {"id": "a", "name": "api", "status": "running"},
            {"id": "w", "name": "worker", "status": "failed"},
            {"id": "u", "name": "auth", "status": "failed"}
        ])
    }

    /// A host that answers like the app would, refusing what the gateway refuses.
    fn host() -> Host {
        Arc::new(|command: &str, args: Value| match command {
            "list_services" => Ok(services()),
            "service_log" => Ok(json!({"text": format!("line 1\nERROR {} broke\nline 3", args["id"].as_str().unwrap_or("?"))})),
            "services_restart" => Ok(Value::Null),
            "delete_service" => Err("delete_service is destructive and does not run inside a script: call it with app_call".into()),
            other => Err(format!("no command named {other:?}")),
        })
    }

    fn quiet() -> OnCall {
        Arc::new(|_, _| {})
    }

    async fn go(code: &str) -> Outcome {
        execute(code, json!({"workspaceId": "ws1", "projectId": null, "root": "/r"}), host(), quiet(), Arc::new(AtomicBool::new(false)), Limits::default()).await
    }

    #[tokio::test]
    async fn a_script_loops_over_calls_and_only_what_it_returns_comes_back() {
        let outcome = go(r#"
            const down = app.call("list_services", { workspaceId: app.workspaceId }).filter((s) => s.status === "failed");
            const report = [];
            for (const s of down) {
              const log = await app.call("service_log", { id: s.id });
              app.call("services_restart", { workspaceId: app.workspaceId, ids: [s.id] });
              report.push({ name: s.name, lastError: log.text.split("\n").find((l) => l.startsWith("ERROR")) });
            }
            return report;
        "#)
        .await;
        assert!(outcome.ok(), "{:?}", outcome.error);
        assert_eq!(outcome.value, Some(json!([{"name": "worker", "lastError": "ERROR w broke"}, {"name": "auth", "lastError": "ERROR u broke"}])));
        let names: Vec<&str> = outcome.calls.iter().map(|c| c.command.as_str()).collect();
        assert_eq!(names, ["list_services", "service_log", "services_restart", "service_log", "services_restart"]);
        // The trace leaves out the workspace every call carries, and says a lone argument as itself.
        assert_eq!(outcome.calls[0].about, "");
        assert_eq!(outcome.calls[1].about, "w");
        let text = render(&outcome);
        assert!(text.starts_with("[{\"name\":\"worker\""), "{text}");
        assert!(text.contains("— app_run: 5 calls"), "{text}");
        assert!(text.contains("✓ list_services, service_log ×2, services_restart ×2"), "one line for the calls that went through: {text}");
        assert_eq!(text.lines().filter(|l| l.starts_with('✓')).collect::<Vec<_>>(), ["✓ list_services, service_log ×2, services_restart ×2"], "no per-call lines or times: {text}");
        assert!(!text.contains("line 3"), "the logs stayed in the sandbox: {text}");
    }

    #[tokio::test]
    async fn a_failed_call_throws_with_its_name_and_the_trace_says_where() {
        let outcome = go(r#"app.call("list_services", {}); app.call("delete_service", { id: "w" }); return "never";"#).await;
        assert!(!outcome.ok());
        assert!(outcome.error.as_deref().unwrap().contains("delete_service"), "{:?}", outcome.error);
        assert_eq!(outcome.failed_at(), Some(1));
        assert!(!outcome.calls[1].ok);
        let text = render(&outcome);
        assert!(text.contains("(call #2 below)"), "{text}");
        assert!(text.contains("\n✗ #2 delete_service w: "), "a failed call has its own line: {text}");
    }

    #[tokio::test]
    async fn a_script_may_catch_a_failure_and_go_on() {
        let outcome = go(r#"let note; try { app.call("nope", {}); } catch (e) { note = e.command; } return { note, n: app.call("list_services", {}).length };"#).await;
        assert!(outcome.ok(), "{:?}", outcome.error);
        assert_eq!(outcome.value, Some(json!({"note": "nope", "n": 3})));
        assert_eq!(outcome.failed_at(), None);
        assert!(!outcome.calls[0].ok && outcome.calls[1].ok);
    }

    #[tokio::test]
    async fn the_call_limit_and_the_clock_bound_a_script() {
        let limits = Limits { calls: 3, time: Duration::from_secs(30) };
        let outcome = execute("for (let i = 0; i < 10; i++) app.call(\"list_services\", {}); return 1;", json!({}), host(), quiet(), Arc::new(AtomicBool::new(false)), limits).await;
        assert!(outcome.error.as_deref().unwrap().contains("limit of 3 calls"), "{:?}", outcome.error);
        assert_eq!(outcome.calls.len(), 4, "the refused call is in the trace");

        let limits = Limits { calls: 3, time: Duration::from_millis(200) };
        let outcome = execute("while (true) {}", json!({}), host(), quiet(), Arc::new(AtomicBool::new(false)), limits).await;
        assert!(outcome.interrupted);
        assert!(outcome.error.as_deref().unwrap().contains("ran out of time"), "{:?}", outcome.error);
    }

    #[tokio::test]
    async fn a_script_that_catches_the_limit_and_keeps_calling_is_ended() {
        let limits = Limits { calls: 3, time: Duration::from_secs(30) };
        let seen = Arc::new(Mutex::new(0usize));
        let sink = seen.clone();
        let on_call: OnCall = Arc::new(move |_, _| *sink.lock().unwrap() += 1);
        let code = "let n = 0; while (true) { try { app.call(\"list_services\", {}); } catch (_) {} n++; } return n;";
        let outcome = execute(code, json!({}), host(), on_call, Arc::new(AtomicBool::new(false)), limits).await;
        assert!(outcome.interrupted);
        assert!(outcome.error.as_deref().unwrap().contains("kept calling after its limit of 3"), "{:?}", outcome.error);
        assert_eq!(outcome.calls.len(), 4, "the three calls and the one refusal, nothing after");
        assert_eq!(*seen.lock().unwrap(), 4, "no event per knock past the limit");
        assert!(outcome.ms < 5_000, "ended at once, not by the clock: {} ms", outcome.ms);

        // Told once, a script may still return what it has.
        let code = "const got = []; for (let i = 0; i < 5; i++) { try { got.push(app.call(\"list_services\", {}).length); } catch (_) { break; } } return got;";
        let outcome = execute(code, json!({}), host(), quiet(), Arc::new(AtomicBool::new(false)), limits).await;
        assert!(outcome.ok(), "{:?}", outcome.error);
        assert_eq!(outcome.value, Some(json!([3, 3, 3])));
    }

    #[test]
    fn a_turn_s_scripts_share_one_ceiling_and_an_idle_one_is_forgotten() {
        let turn = format!("turn-{}", uuid::Uuid::new_v4().simple());
        assert_eq!(turn_left(&turn), TURN_CALLS);
        turn_spend(&turn, 40);
        turn_spend(&turn, 40);
        assert_eq!(turn_left(&turn), TURN_CALLS - 80);
        turn_spend(&turn, TURN_CALLS);
        assert_eq!(turn_left(&turn), 0);
        let other = format!("turn-{}", uuid::Uuid::new_v4().simple());
        assert_eq!(turn_left(&other), TURN_CALLS, "another turn starts whole");
        if let Some(long_ago) = Instant::now().checked_sub(TURN_IDLE + Duration::from_secs(1)) {
            TURN_SPENT.lock().unwrap().get_mut(&turn).unwrap().0 = long_ago;
            assert_eq!(turn_left(&turn), TURN_CALLS);
        }
    }

    #[tokio::test]
    async fn what_a_script_read_is_counted() {
        let outcome = go(r#"app.call("list_services", {}); try { app.call("nope", {}); } catch (_) {} return 1;"#).await;
        assert_eq!(outcome.read_bytes as usize, json!({ "ok": services() }).to_string().len(), "only the answer that came in");
    }

    #[test]
    fn a_tally_counts_commands_in_the_order_first_called() {
        assert_eq!(tally(["a", "b", "b", "a", "c"].into_iter()), "a ×2, b ×2, c");
        let many: Vec<String> = (0..12).map(|i| format!("c{i}")).collect();
        assert!(tally(many.iter().map(String::as_str)).ends_with("c9, +2 more"));
    }

    #[test]
    fn the_script_only_description_never_sends_a_model_to_app_call() {
        assert!(!DESCRIPTION_SCRIPT_ONLY.contains("app_call"));
        assert!(DESCRIPTION.contains("app_call"));
    }

    #[tokio::test]
    async fn stop_ends_a_running_script() {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            flag.store(true, Ordering::SeqCst);
        });
        let outcome = execute("while (true) {}", json!({}), host(), quiet(), stop, Limits::default()).await;
        assert!(outcome.interrupted);
        assert_eq!(outcome.error.as_deref(), Some("The script was stopped."));
    }

    #[tokio::test]
    async fn there_is_no_way_out_of_the_sandbox_but_app_call() {
        let outcome = go(r#"return [typeof require, typeof fetch, typeof setTimeout, typeof __cf_call, typeof process, typeof std, typeof os];"#).await;
        assert_eq!(outcome.value, Some(json!(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "undefined"])));
    }

    #[tokio::test]
    async fn mistakes_come_back_readable() {
        let syntax = go("return (;").await;
        assert!(syntax.error.is_some());
        let never = go("await new Promise(() => {}); return 1;").await;
        assert!(never.error.as_deref().unwrap().contains("never settles"), "{:?}", never.error);
        let bad_args = go(r#"app.call("list_services", [1]);"#).await;
        assert!(bad_args.error.as_deref().unwrap().contains("args must be an object"), "{:?}", bad_args.error);
        let empty = go("  ").await;
        assert!(empty.error.as_deref().unwrap().contains("empty"));
        let nothing = go("const x = 1;").await;
        assert_eq!(nothing.value, Some(Value::Null));
    }

    #[tokio::test]
    async fn console_output_is_kept_short_and_returned() {
        let outcome = go(r#"console.log("found", 2, { a: 1 }); for (let i = 0; i < 2000; i++) console.log("noise " + i); return true;"#).await;
        assert!(outcome.logs.starts_with("found 2 {\"a\":1}"), "{}", &outcome.logs[..40]);
        assert!(outcome.logs.len() <= MAX_LOG + 4);
        assert!(render(&outcome).contains("console:\nfound 2"));
    }

    #[tokio::test]
    async fn every_call_is_told_as_it_finishes() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let on_call: OnCall = Arc::new(move |i, call| sink.lock().unwrap().push((i, call.command.clone(), call.ok)));
        execute(r#"app.call("list_services", {}); try { app.call("x", {}); } catch (_) {} return 0;"#, json!({}), host(), on_call, Arc::new(AtomicBool::new(false)), Limits::default()).await;
        assert_eq!(*seen.lock().unwrap(), vec![(0, "list_services".to_string(), true), (1, "x".to_string(), false)]);
    }

    #[test]
    fn local_models_and_the_custom_command_start_with_scripts_off() {
        assert!(default_on("claude") && default_on("codex") && default_on("gemini") && default_on("grok"));
        assert!(!default_on(crate::local_agent::PROVIDER_ID));
        assert!(!default_on(crate::custom::PROVIDER_ID));
        assert!(!enabled_for(""));
    }
}
