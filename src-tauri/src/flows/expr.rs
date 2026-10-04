//! Expressions and the Code node: an embedded QuickJS, one per run, on a thread of its own.
//!
//! **Why a thread.** A QuickJS runtime is not `Send`: it has to live and die on the thread that
//! made it. So each run gets an [`ExprWorker`] — a thread holding one runtime with `intl.js`, Luxon
//! and `prelude.js` loaded — and the engine's async tasks hand it jobs over a channel. One per run
//! rather than one per node because loading Luxon is the expensive part, and a flow evaluates
//! expressions in nearly every node; one per run rather than one for the app because a run's
//! expressions can see that run's data and nothing else's.
//!
//! **Why QuickJS at all.** Expressions are user JavaScript (`{{ $json.total * 1.19 }}`), and the
//! alternatives were running them in the webview — which does not exist while the window is closed
//! and a schedule fires — or spawning Node, which the user may not have. QuickJS is a few hundred
//! kilobytes, starts in milliseconds and has no I/O: an expression cannot open a file, a socket or a
//! process, which is the sandbox the Code node's description promises.
//!
//! **Limits.** Memory is capped per runtime, and every job carries a deadline that the interrupt
//! handler enforces — `while (true) {}` in a Code node ends as a timeout, not as a hung run. Stop
//! works the same way: [`ExprWorker::cancel`] makes the handler answer "interrupt" from then on.
//!
//! The protocol is JSON text both ways (`__cf_job` in `prelude.js`): the job in, `{"ok": …}` or
//! `{"error": …}` out. What a job cannot carry — another node's output, the item a value came from —
//! the JavaScript asks for through `__host`, which reads [`RunLookup`].

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{Datelike, Offset, TimeZone, Timelike, Utc};
use rquickjs::{CatchResultExt, Context, Function, Object, Promise, Runtime};
use serde_json::Value;
use tokio::sync::oneshot;

const INTL: &str = include_str!("js/intl.js");
const LUXON: &str = include_str!("js/luxon.min.js");
const PRELUDE: &str = include_str!("js/prelude.js");

/// What one run's JavaScript may hold at once. Generous — a Code node over ten thousand items
/// builds objects several times the size of their JSON — but finite, so a runaway allocation fails
/// the node instead of the app.
const MEMORY_LIMIT: usize = 512 * 1024 * 1024;

/// The JavaScript stack. Deep enough for honest recursion; the thread's own stack is larger still.
const JS_STACK: usize = 4 * 1024 * 1024;
const THREAD_STACK: usize = 16 * 1024 * 1024;

/// The questions a run's expressions can ask about the run. Answers are JSON text, read by
/// `prelude.js`; the engine implements it over its record of what each node produced.
pub trait RunLookup: Send + Sync {
    /// `{"executed": bool, "outputs": [[json, …], …]}` for a node by name; `None` when no node in
    /// the flow is called that.
    fn node_output(&self, name: &str) -> Option<String>;
    /// `{"json": …}` — the item of `target` that item `index` of `node`'s input descends from — or
    /// `{"error": "…"}` saying why there is none.
    fn paired_item(&self, target: &str, node: &str, index: usize) -> String;
    /// `{"name", "outputIndex", "runIndex"}`: the node that item `index` of `node`'s input came from.
    fn origin(&self, node: &str, index: usize) -> Option<String>;
}

/// Why a job did not produce an answer.
#[derive(Debug, Clone, PartialEq)]
pub enum JsError {
    /// The JavaScript threw: a bad expression, a Code node's own `throw`, a missing node.
    Script { message: String, expression: Option<String>, stack: Option<String> },
    /// The job ran past its deadline.
    Timeout,
    /// The run was stopped.
    Cancelled,
    /// The worker could not run the job at all — it failed to start, or its thread is gone.
    Internal(String),
}

impl std::fmt::Display for JsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JsError::Script { message, expression: Some(expression), .. } => {
                write!(f, "{message} (in {{{{ {expression} }}}})")
            }
            JsError::Script { message, .. } => f.write_str(message),
            JsError::Timeout => f.write_str("JavaScript ran past its time limit"),
            JsError::Cancelled => f.write_str("Stopped"),
            JsError::Internal(message) => f.write_str(message),
        }
    }
}

/// The interrupt handler's view of the job in flight: a deadline (milliseconds after `base`, 0 =
/// none) and the run's stop flag.
struct Interrupt {
    base: Instant,
    deadline: AtomicU64,
    cancelled: AtomicBool,
    /// Which of the two ended the last job — read after QuickJS reports an interruption.
    timed_out: AtomicBool,
}

impl Interrupt {
    fn should_stop(&self) -> bool {
        if self.cancelled.load(Ordering::Relaxed) {
            return true;
        }
        let deadline = self.deadline.load(Ordering::Relaxed);
        if deadline != 0 && self.base.elapsed().as_millis() as u64 >= deadline {
            self.timed_out.store(true, Ordering::Relaxed);
            return true;
        }
        false
    }
}

struct Request {
    job: String,
    timeout: Duration,
    reply: oneshot::Sender<Result<Value, JsError>>,
}

/// One run's JavaScript. Dropping it ends the thread once the job in flight (if any) returns.
pub struct ExprWorker {
    jobs: mpsc::Sender<Request>,
    interrupt: Arc<Interrupt>,
}

impl ExprWorker {
    /// Starts the thread and loads the runtime; returns once it is ready to take jobs, so a broken
    /// prelude fails here rather than on the first expression.
    pub fn start(lookup: Arc<dyn RunLookup>, locale: &str) -> Result<Self, String> {
        let interrupt = Arc::new(Interrupt {
            base: Instant::now(),
            deadline: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            timed_out: AtomicBool::new(false),
        });
        let (jobs, inbox) = mpsc::channel::<Request>();
        let (ready, started) = mpsc::channel::<Result<(), String>>();
        let locale = locale.to_string();
        let flag = interrupt.clone();
        std::thread::Builder::new()
            .name("flows-js".into())
            .stack_size(THREAD_STACK)
            .spawn(move || worker(lookup, locale, flag, inbox, ready))
            .map_err(|e| format!("Could not start the JavaScript engine: {e}"))?;
        started
            .recv()
            .map_err(|_| "The JavaScript engine stopped while starting".to_string())??;
        Ok(Self { jobs, interrupt })
    }

    /// Runs one job (see `prelude.js` for the kinds) and returns what `ok` held.
    pub async fn run(&self, job: &Value, timeout: Duration) -> Result<Value, JsError> {
        if self.interrupt.cancelled.load(Ordering::Relaxed) {
            return Err(JsError::Cancelled);
        }
        let (reply, answer) = oneshot::channel();
        let request = Request { job: job.to_string(), timeout, reply };
        self.jobs
            .send(request)
            .map_err(|_| JsError::Internal("The JavaScript engine is no longer running".into()))?;
        answer
            .await
            .map_err(|_| JsError::Internal("The JavaScript engine stopped mid-job".into()))?
    }

    /// Interrupts the job in flight and refuses every later one: the run is stopping.
    pub fn cancel(&self) {
        self.interrupt.cancelled.store(true, Ordering::SeqCst);
    }
}

fn worker(
    lookup: Arc<dyn RunLookup>,
    locale: String,
    interrupt: Arc<Interrupt>,
    inbox: mpsc::Receiver<Request>,
    ready: mpsc::Sender<Result<(), String>>,
) {
    let setup = || -> Result<(Runtime, Context), String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        runtime.set_max_stack_size(JS_STACK);
        let flag = interrupt.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || flag.should_stop())));
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        context.with(|ctx| -> Result<(), String> {
            install_host(&ctx, lookup, &locale).map_err(|e| e.to_string())?;
            for (name, source) in [("intl.js", INTL), ("luxon.js", LUXON), ("prelude.js", PRELUDE)] {
                ctx.eval::<rquickjs::Value, _>(source)
                    .catch(&ctx)
                    .map_err(|e| format!("{name} failed to load: {e}"))?;
            }
            Ok(())
        })?;
        Ok((runtime, context))
    };
    let (runtime, context) = match setup() {
        Ok(pair) => {
            let _ = ready.send(Ok(()));
            pair
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    for request in inbox {
        if interrupt.cancelled.load(Ordering::Relaxed) {
            let _ = request.reply.send(Err(JsError::Cancelled));
            continue;
        }
        let limit = interrupt.base.elapsed() + request.timeout;
        interrupt.timed_out.store(false, Ordering::Relaxed);
        interrupt.deadline.store(limit.as_millis().max(1) as u64, Ordering::Relaxed);
        let answer = context.with(|ctx| -> Result<String, String> {
            let call = || -> Result<String, rquickjs::CaughtError<'_>> {
                let entry: Function = ctx.globals().get("__cf_job").catch(&ctx)?;
                let promise: Promise = entry.call((request.job.as_str(),)).catch(&ctx)?;
                promise.finish::<String>().catch(&ctx)
            };
            call().map_err(describe_caught)
        });
        interrupt.deadline.store(0, Ordering::Relaxed);
        let outcome = match answer {
            Ok(text) => decode(&text),
            Err(_) if interrupt.cancelled.load(Ordering::Relaxed) => Err(JsError::Cancelled),
            Err(_) if interrupt.timed_out.load(Ordering::Relaxed) => Err(JsError::Timeout),
            Err(message) => Err(JsError::Script { message, expression: None, stack: None }),
        };
        // A job that ran out of memory leaves garbage the next one should not pay for.
        runtime.run_gc();
        let _ = request.reply.send(outcome);
    }
}

/// An exception that escaped `__cf_job` — which catches everything it can, so this is an
/// interruption, an unsettled promise, or the engine itself failing. Read inside the context,
/// since the error borrows it.
fn describe_caught(error: rquickjs::CaughtError<'_>) -> String {
    match &error {
        rquickjs::CaughtError::Error(rquickjs::Error::WouldBlock) => {
            "The code awaited something that never settles — there are no timers or network here".to_string()
        }
        other => other.to_string(),
    }
}

fn decode(text: &str) -> Result<Value, JsError> {
    let mut answer: Value =
        serde_json::from_str(text).map_err(|e| JsError::Internal(format!("Unreadable answer from JavaScript: {e}")))?;
    if let Some(ok) = answer.get_mut("ok") {
        return Ok(ok.take());
    }
    let error = answer.get("error").cloned().unwrap_or(Value::Null);
    let text_of = |key: &str| error.get(key).and_then(Value::as_str).map(str::to_string);
    Err(JsError::Script {
        message: text_of("message").unwrap_or_else(|| "JavaScript error".into()),
        expression: text_of("expression"),
        stack: text_of("stack"),
    })
}

/// `__host`: the functions `intl.js` and `prelude.js` call back into.
fn install_host(ctx: &rquickjs::Ctx<'_>, lookup: Arc<dyn RunLookup>, locale: &str) -> rquickjs::Result<()> {
    let host = Object::new(ctx.clone())?;
    let locale = locale.to_string();
    host.set("locale", Function::new(ctx.clone(), move || locale.clone())?)?;
    host.set("systemZone", Function::new(ctx.clone(), system_zone)?)?;
    host.set("tzValid", Function::new(ctx.clone(), |zone: String| zone.parse::<chrono_tz::Tz>().is_ok())?)?;
    host.set(
        "tzParts",
        Function::new(ctx.clone(), |zone: String, ms: f64| tz_parts(&zone, ms).unwrap_or_default())?,
    )?;
    let outputs = lookup.clone();
    host.set(
        "nodeOutput",
        Function::new(ctx.clone(), move |name: String| outputs.node_output(&name).unwrap_or_default())?,
    )?;
    let pairs = lookup.clone();
    host.set(
        "pairedItem",
        Function::new(ctx.clone(), move |target: String, node: String, index: f64| {
            pairs.paired_item(&target, &node, index.max(0.0) as usize)
        })?,
    )?;
    host.set(
        "origin",
        Function::new(ctx.clone(), move |node: String, index: f64| {
            lookup.origin(&node, index.max(0.0) as usize).unwrap_or_default()
        })?,
    )?;
    ctx.globals().set("__host", host)
}

/// The machine's IANA zone, for `DateTime.local()` to name. UTC when the OS will not say.
pub fn system_zone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

/// The wall clock of instant `ms` in `zone`, as `intl.js` reads it:
/// `[year, month, day, hour, minute, second, weekday (1 = Monday), offset minutes, abbreviation]`.
fn tz_parts(zone: &str, ms: f64) -> Option<String> {
    let tz: chrono_tz::Tz = zone.parse().ok()?;
    let instant = Utc.timestamp_millis_opt(ms.floor() as i64).single()?;
    let local = instant.with_timezone(&tz);
    let offset = local.offset().fix().local_minus_utc() / 60;
    let abbreviation = local.format("%Z").to_string();
    Some(
        serde_json::json!([
            local.year(),
            local.month(),
            local.day(),
            local.hour(),
            local.minute(),
            local.second(),
            local.weekday().number_from_monday(),
            offset,
            abbreviation
        ])
        .to_string(),
    )
}

/// Whether a parameter value is an expression: n8n's rule, a string starting with `=`.
pub fn is_expression(value: &Value) -> bool {
    matches!(value, Value::String(text) if text.starts_with('='))
}

/// Whether anything in a parameter tree is an expression — the check that lets a node whose
/// parameters are all literal skip the JavaScript round trip entirely.
pub fn has_expression(value: &Value) -> bool {
    match value {
        Value::String(_) => is_expression(value),
        Value::Array(list) => list.iter().any(has_expression),
        Value::Object(map) => map.values().any(has_expression),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture;

    impl RunLookup for Fixture {
        fn node_output(&self, name: &str) -> Option<String> {
            (name == "HTTP").then(|| json!({"executed": true, "outputs": [[{"id": 10}, {"id": 20}]]}).to_string())
        }
        fn paired_item(&self, target: &str, _node: &str, index: usize) -> String {
            if target == "HTTP" {
                json!({"json": {"id": (index + 1) * 10}}).to_string()
            } else {
                json!({"error": "no item"}).to_string()
            }
        }
        fn origin(&self, _node: &str, _index: usize) -> Option<String> {
            Some(json!({"name": "HTTP", "outputIndex": 0, "runIndex": 0}).to_string())
        }
    }

    fn worker() -> ExprWorker {
        ExprWorker::start(Arc::new(Fixture), "en-US").expect("the engine starts")
    }

    fn context() -> Value {
        json!({"node": "Set", "flow": {"id": "f", "name": "Demo"}, "execution": {"id": "r", "mode": "manual"},
               "vars": {"region": "cl"}, "timezone": "America/Santiago"})
    }

    const SECOND: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn templates_keep_types_and_splice_text() {
        let js = worker();
        let job = json!({
            "kind": "resolve", "context": context(), "items": [{"name": "Ana", "n": 5}],
            "params": {"a": "={{ $json.n * 2 }}", "b": "=Hola {{ $json.name }}", "c": "literal",
                       "d": "={{ {x: {y: 1}} }}", "e": "={{ $vars.region }}", "f": "={{ $('HTTP').item.json.id }}",
                       "g": "={{ \"}}\" }}", "code": "={{ untouched"},
            "skip": ["code"]
        });
        let out = js.run(&job, SECOND).await.unwrap();
        assert_eq!(out[0]["a"], json!(10));
        assert_eq!(out[0]["b"], json!("Hola Ana"));
        assert_eq!(out[0]["c"], json!("literal"));
        assert_eq!(out[0]["d"], json!({"x": {"y": 1}}));
        assert_eq!(out[0]["e"], json!("cl"));
        assert_eq!(out[0]["f"], json!(10));
        assert_eq!(out[0]["g"], json!("}}"));
        assert_eq!(out[0]["code"], json!("={{ untouched"));
    }

    /// Luxon runs on the `Intl` shim: zones come from chrono-tz, names in both languages.
    #[tokio::test]
    async fn luxon_works_without_intl() {
        let js = worker();
        let job = json!({
            "kind": "resolve", "context": context(), "items": [{}],
            "params": {
                "fmt": "={{ DateTime.fromISO('2026-10-04T15:00:00Z').setZone('America/Santiago').toFormat('yyyy-MM-dd HH:mm cccc') }}",
                "es": "={{ DateTime.fromISO('2026-10-04T15:00:00Z').setLocale('es').toFormat('cccc d LLLL') }}",
                "dst": "={{ DateTime.fromISO('2026-07-04T15:00:00Z').setZone('America/New_York').offset }}",
                "bad": "={{ DateTime.now().setZone('Mars/Base').isValid }}",
                "human": "={{ Duration.fromObject({hours: 26}).shiftTo('days', 'hours').toHuman() }}",
                "now": "={{ $now.isValid && $now.zoneName }}"
            }
        });
        let out = js.run(&job, SECOND).await.unwrap();
        assert_eq!(out[0]["fmt"], json!("2026-10-04 12:00 Sunday"));
        assert_eq!(out[0]["es"], json!("domingo 4 octubre"));
        assert_eq!(out[0]["dst"], json!(-240));
        assert_eq!(out[0]["bad"], json!(false));
        assert_eq!(out[0]["human"], json!("1 day and 2 hours"));
        assert_eq!(out[0]["now"], json!("America/Santiago"));
    }

    #[tokio::test]
    async fn an_expression_error_names_the_expression() {
        let js = worker();
        let job = json!({"kind": "resolve", "context": context(), "items": [{}], "params": {"x": "={{ $('Nope').first() }}"}});
        match js.run(&job, SECOND).await {
            Err(JsError::Script { message, expression, .. }) => {
                assert!(message.contains("Nope"), "{message}");
                assert_eq!(expression.as_deref(), Some("$('Nope').first()"));
            }
            other => panic!("expected a script error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_code_node_maps_items_and_captures_the_console() {
        let js = worker();
        let job = json!({
            "kind": "code", "mode": "all", "context": context(), "items": [{"n": 1}, {"n": 2}],
            "code": "console.log('seen', items.length); const x = await Promise.resolve(2); return items.map(i => ({ n: i.json.n * x }));"
        });
        let out = js.run(&job, SECOND).await.unwrap();
        assert_eq!(out["items"], json!([{"json": {"n": 2}, "paired": 0}, {"json": {"n": 4}, "paired": 1}]));
        assert_eq!(out["logs"][0]["text"], json!("seen 2"));
    }

    #[tokio::test]
    async fn an_endless_loop_times_out_and_the_engine_survives_it() {
        let js = worker();
        let spin = json!({"kind": "code", "mode": "all", "context": context(), "items": [{}], "code": "while (true) {}"});
        let started = Instant::now();
        assert_eq!(js.run(&spin, Duration::from_millis(300)).await, Err(JsError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(3));
        let next = json!({"kind": "resolve", "context": context(), "items": [{}], "params": {"a": "={{ 1 + 1 }}"}});
        assert_eq!(js.run(&next, SECOND).await.unwrap()[0]["a"], json!(2));
    }

    #[tokio::test]
    async fn cancel_interrupts_the_job_in_flight() {
        let js = Arc::new(worker());
        let spin = json!({"kind": "code", "mode": "all", "context": context(), "items": [{}], "code": "while (true) {}"});
        let running = {
            let js = js.clone();
            tokio::spawn(async move { js.run(&spin, Duration::from_secs(60)).await })
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        js.cancel();
        let outcome = tokio::time::timeout(Duration::from_secs(5), running).await.expect("it stops").unwrap();
        assert_eq!(outcome, Err(JsError::Cancelled));
    }

    #[tokio::test]
    async fn a_promise_that_never_settles_is_an_error_not_a_hang() {
        let js = worker();
        let job = json!({"kind": "code", "mode": "all", "context": context(), "items": [{}], "code": "await new Promise(() => {}); return [];"});
        match js.run(&job, SECOND).await {
            Err(JsError::Script { message, .. }) => assert!(message.contains("never settles"), "{message}"),
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn conditions_and_switch_route_per_item() {
        let js = worker();
        let items = json!([{"n": 5, "name": "Ana"}, {"n": 12, "name": "bob"}]);
        let conditions = json!({"kind": "conditions", "context": context(), "items": items,
            "spec": {"combinator": "and", "conditions": [{"left": "={{ $json.n }}", "op": "gt", "right": "10"}]}});
        assert_eq!(js.run(&conditions, SECOND).await.unwrap(), json!([false, true]));
        let switch = json!({"kind": "switch", "context": context(), "items": items,
            "spec": {"rules": [{"output": 0, "left": "={{ $json.name }}", "op": "regex", "right": "/^a/i"},
                               {"output": 1, "left": "={{ $json.n }}", "op": "gte", "right": 10}]}});
        assert_eq!(js.run(&switch, SECOND).await.unwrap(), json!([[0], [1]]));
    }

    #[test]
    fn tz_parts_follow_daylight_saving() {
        // 2026-07-04 15:00 UTC is 11:00 in New York (EDT, -4) and a Saturday.
        let parts: Value = serde_json::from_str(&tz_parts("America/New_York", 1_783_177_200_000.0).unwrap()).unwrap();
        assert_eq!(parts, json!([2026, 7, 4, 11, 0, 0, 6, -240, "EDT"]));
        assert!(tz_parts("Mars/Base", 0.0).is_none());
    }

    #[test]
    fn expressions_are_found_anywhere_in_a_tree() {
        assert!(has_expression(&json!({"a": [1, {"b": "={{ 1 }}"}]})));
        assert!(!has_expression(&json!({"a": "plain", "b": ["x", 2, null]})));
    }
}
