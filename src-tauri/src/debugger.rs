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
//!
//! **Paths cross it twice, and V8 spells them its own way both times.** It names a script by the
//! URL of its *real* path — symlinks resolved, every space and accent percent-encoded — so a
//! breakpoint set by the path the editor has open (`/var/folders/…/Mi Proyecto/app.js`) never
//! matched the script V8 loaded (`file:///private/var/folders/…/Mi%20Proyecto/app.js`) and simply
//! never fired, and a stack frame's URL opened nothing when clicked. Breakpoints are therefore set
//! by a `urlRegex` that accepts either spelling (see [`url_regex`]), and a frame's URL is decoded
//! and mapped back onto the path the user knows (see [`PathMap`]).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
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
    /// Object id of this frame's local scope, for expanding variables. Every scope of any frame
    /// is available through [`scopes`]; this is the one a panel opens on.
    pub scope_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PausedEvent {
    /// `breakpoint`, `step`, `exception`, `debugCommand`…
    pub reason: String,
    pub frames: Vec<StackFrame>,
    /// What the stop is about, when there is more to say than the reason: the exception's own
    /// message for a pause on an exception.
    pub description: Option<String>,
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

/// One breakpoint, as the editor sets it. Shared with [`crate::dap`], which sends the same three
/// fields to an adapter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointSpec {
    /// 1-based.
    pub line: u32,
    /// Stop only when this expression is truthy in the paused frame.
    #[serde(default)]
    pub condition: Option<String>,
    /// A logpoint: print this instead of stopping. `{expression}` is interpolated.
    #[serde(default)]
    pub log_message: Option<String>,
}

/// What a breakpoint may arrive as over IPC: a bare line — every caller sent that before conditions
/// existed — or the whole spec.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum BreakpointInput {
    Line(u32),
    Spec(BreakpointSpec),
}

impl From<BreakpointInput> for BreakpointSpec {
    fn from(input: BreakpointInput) -> Self {
        match input {
            BreakpointInput::Line(line) => BreakpointSpec { line, ..BreakpointSpec::default() },
            BreakpointInput::Spec(spec) => spec,
        }
    }
}

/// Breakpoints per absolute file path.
pub type Breakpoints = HashMap<String, Vec<BreakpointSpec>>;

/// A kind of exception a backend can stop on. Node's two are fixed ([`NODE_EXCEPTION_FILTERS`]);
/// an adapter lists its own in `initialize`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionFilter {
    pub filter: String,
    pub label: String,
    /// On unless the user said otherwise — the adapter's own recommendation.
    pub default: bool,
}

/// What `Debugger.setPauseOnExceptions` can be asked for, as filters: stopping on the exceptions
/// nothing catches, or on every one thrown.
pub const NODE_EXCEPTION_FILTERS: [(&str, &str); 2] = [("uncaught", "Uncaught exceptions"), ("all", "All exceptions")];

pub fn node_exception_filters() -> Vec<ExceptionFilter> {
    NODE_EXCEPTION_FILTERS
        .iter()
        .map(|(filter, label)| ExceptionFilter { filter: filter.to_string(), label: label.to_string(), default: false })
        .collect()
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
    /// How the paths V8 reports map back onto the ones the user opened. See [`PathMap`].
    paths: Mutex<PathMap>,
    /// The stop the program is sitting in: the event as the panel was sent it, and CDP's own
    /// parameters, whose scope chains [`scopes`] answers from. Kept so a webview that reloads in
    /// the middle of a pause can be told where it is — see [`paused_state`].
    paused: Mutex<Option<(PausedEvent, Value)>>,
    /// The program's own execution context. Its destruction is the program finishing — see the
    /// reader in [`start`].
    main_context: Mutex<Option<i64>>,
}

type SessionSlot = Mutex<Option<Arc<Session>>>;

fn slot() -> &'static SessionSlot {
    static SLOT: std::sync::OnceLock<SessionSlot> = std::sync::OnceLock::new();
    SLOT.get_or_init(SessionSlot::default)
}

fn current() -> Option<Arc<Session>> {
    slot().lock().ok()?.clone()
}

/// A path as a file URL carries it — slash-separated, rooted: `/home/dev/app.js`, `/C:/repo/app.js`,
/// or `//server/share/app.js` for a UNC path.
fn url_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    }
}

/// Whether `ch` stands for itself in a file URL Node writes. Node 24's `pathToFileURL` leaves these
/// alone and percent-encodes everything else — a space, `#`, `~`, every non-ASCII byte. Earlier
/// versions encode less, which is why breakpoints are matched by [`url_regex`] rather than by this
/// spelling: it is kept as the reference the tests hold the decoding and the pattern to.
#[cfg(test)]
fn is_url_literal(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || "-._/;=&'()!*,@$+:".contains(ch)
}

/// A path as V8 reports it: `file:///C:/dir/app.js`, `file:///Users/me/Mi%20Proyecto/app.js`,
/// `file://server/share/app.js`.
#[cfg(test)]
fn file_url(path: &str) -> String {
    let rooted = url_path(path);
    // A UNC path's server is the URL's host, so it takes the place of the third slash.
    let body = rooted.strip_prefix("//").unwrap_or(&rooted);
    let mut out = String::from("file://");
    for ch in body.chars() {
        if is_url_literal(ch) {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            for byte in ch.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

/// Decodes `%XX` sequences, the inverse of the encoding above. A malformed escape is left as it
/// was written rather than refused: this is for display and for opening a file, not validation.
fn percent_decode(text: &str) -> String {
    fn hex(byte: u8) -> Option<u8> {
        (byte as char).to_digit(16).map(|d| d as u8)
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// The inverse, for turning a frame's script url back into something the editor can open.
fn url_to_path(url: &str) -> String {
    let Some(rest) = url.strip_prefix("file://") else { return url.to_string() };
    let decoded = percent_decode(rest);
    match decoded.strip_prefix('/') {
        // A Windows path comes back as `C:/…`; a POSIX one lost its leading slash to the prefix.
        Some(local) if local.len() > 1 && local.as_bytes()[1] == b':' && local.as_bytes()[0].is_ascii_alphabetic() => {
            local.replace('/', "\\")
        }
        Some(local) => format!("/{local}"),
        // No third slash: the URL has a host, which on Windows is a UNC share.
        None => format!("\\\\{}", decoded.replace('/', "\\")),
    }
}

/// `path` with its symlinks resolved — which is what Node's module loader does before it runs a
/// file, and so what V8 reports. `None` for a path that does not resolve (not written yet).
fn canonical(path: &str) -> Option<String> {
    let resolved = std::fs::canonicalize(path).ok()?;
    Some(strip_verbatim(&resolved.to_string_lossy()))
}

/// Windows canonicalises to the verbatim form (`\\?\C:\…`), which no URL and no editor spells.
fn strip_verbatim(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(local) = path.strip_prefix(r"\\?\") {
        local.to_string()
    } else {
        path.to_string()
    }
}

/// `text` with every JavaScript regex metacharacter escaped.
fn escape_regex(ch: char) -> String {
    if "\\^$.|?*+()[]{}/".contains(ch) {
        format!("\\{ch}")
    } else {
        ch.to_string()
    }
}

/// A hex digit that matches in either case — `%c3%a9` and `%C3%A9` are the same URL.
fn hex_pattern(byte: u8) -> String {
    format!("%{byte:02X}")
        .chars()
        .map(|c| if c.is_ascii_alphabetic() { format!("[{}{}]", c.to_ascii_lowercase(), c) } else { c.to_string() })
        .collect()
}

/// The pattern for one path's URL. Every character that is not a plain letter, digit or `-._/`
/// may arrive written out or percent-encoded, because Node versions disagree about which
/// punctuation to encode (Node 24 encodes `~` and `[`; older releases do not); letters match either
/// case where the file system does not care.
fn url_pattern(path: &str, ignore_case: bool) -> String {
    let rooted = url_path(path);
    let body = rooted.strip_prefix("//").unwrap_or(&rooted);
    let mut out = String::from("file:\\/\\/");
    for ch in body.chars() {
        match ch {
            '/' => out.push_str("\\/"),
            c if c.is_ascii_alphabetic() && ignore_case => {
                out.push_str(&format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase()));
            }
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' => out.push(c),
            '.' => out.push_str("\\."),
            c => {
                let mut buf = [0u8; 4];
                let encoded: String = c.encode_utf8(&mut buf).bytes().map(hex_pattern).collect();
                out.push_str(&format!("(?:{}|{encoded})", escape_regex(c)));
            }
        }
    }
    out
}

/// The `urlRegex` a breakpoint in `spellings` is set with: any of them, spelled any way V8 might.
///
/// More than one spelling because a file has more than one path. The editor's is the one the user
/// opened; V8's is the real one, symlinks resolved — `/var/folders` on macOS is `/private/var/folders`,
/// and a repository opened through a linked folder is the same. Node still runs a file by the path
/// it was given when `--preserve-symlinks` is on, so the editor's spelling stays in the pattern too.
fn url_regex(spellings: &[String], ignore_case: bool) -> String {
    let mut seen = HashSet::new();
    let alternatives: Vec<String> = spellings
        .iter()
        .map(|path| url_pattern(path, ignore_case))
        .filter(|pattern| seen.insert(pattern.clone()))
        .collect();
    format!("^(?:{})$", alternatives.join("|"))
}

/// Maps the paths V8 reports back onto the ones the user knows.
///
/// V8 names a script by its real path, so a frame in a repository opened through a symlink — or in
/// the temp folder, which is one on macOS — would come back under a name the editor has never seen:
/// clicking it would open a second tab for the same file, and the stopped-line highlight would
/// never land on the tab already open. Each path the session was given (the working folder, the
/// program, every file with a breakpoint) is resolved once, and any reported path under a resolved
/// one is rewritten back.
#[derive(Default)]
struct PathMap {
    /// (resolved, as given), only where the two differ.
    pairs: Vec<(String, String)>,
}

/// Compared the way the platform's file system compares: separators either way, and without case
/// on Windows. Byte length is preserved, so an index found in the key is valid in the original.
fn path_key(path: &str) -> String {
    let unified = path.replace('\\', "/");
    if cfg!(windows) {
        unified.to_ascii_lowercase()
    } else {
        unified
    }
}

/// Whether `path` is `base` or inside it.
fn is_within(path: &str, base: &str) -> bool {
    let (path, base) = (path_key(path), path_key(base));
    let base = base.trim_end_matches('/');
    path == base || (path.starts_with(base) && path.as_bytes().get(base.len()) == Some(&b'/'))
}

impl PathMap {
    fn learn(&mut self, given: &str) {
        let Some(resolved) = canonical(given) else { return };
        self.remember(resolved, given.to_string());
    }

    fn remember(&mut self, resolved: String, given: String) {
        let unchanged = path_key(&resolved).trim_end_matches('/') == path_key(&given).trim_end_matches('/');
        if unchanged || self.pairs.iter().any(|(known, _)| path_key(known) == path_key(&resolved)) {
            return;
        }
        self.pairs.push((resolved, given));
    }

    /// `path` under the name the user gave it, or unchanged when nothing given resolves to it.
    fn to_user(&self, path: &str) -> String {
        let best = self
            .pairs
            .iter()
            .filter(|(resolved, _)| is_within(path, resolved))
            .max_by_key(|(resolved, _)| resolved.trim_end_matches(['/', '\\']).len());
        match best {
            Some((resolved, given)) => {
                let cut = resolved.trim_end_matches(['/', '\\']).len();
                format!("{}{}", given.trim_end_matches(['/', '\\']), &path[cut..])
            }
            None => path.to_string(),
        }
    }
}

/// A logpoint's message as a JavaScript expression producing the string: literal text quoted, and
/// every `{expression}` evaluated in the paused frame. An expression that throws prints its error
/// in place rather than silencing the whole line — a condition that throws is simply false to V8,
/// and a logpoint that says nothing when it is wrong is one nobody can debug.
fn logpoint_expression(message: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut literal = String::new();
    let mut rest = message;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open + 1..].find('}') else { break };
        let expression = rest[open + 1..open + 1 + close].trim();
        literal.push_str(&rest[..open]);
        if expression.is_empty() {
            literal.push_str("{}");
        } else {
            if !literal.is_empty() {
                parts.push(serde_json::to_string(&literal).unwrap_or_default());
                literal.clear();
            }
            parts.push(format!(
                "(() => {{ try {{ return String({expression}); }} catch (e) {{ return '<' + e + '>'; }} }})()"
            ));
        }
        rest = &rest[open + 1 + close + 1..];
    }
    literal.push_str(rest);
    if !literal.is_empty() || parts.is_empty() {
        parts.push(serde_json::to_string(&literal).unwrap_or_default());
    }
    parts.join(" + ")
}

/// The CDP `condition` a breakpoint is set with.
///
/// CDP has conditions but no logpoints, so a logpoint *is* a condition: one that prints and then
/// answers `false`, so the program never stops there. With both, the print only happens when the
/// user's condition holds — VS Code's semantics.
fn node_condition(spec: &BreakpointSpec) -> Option<String> {
    // A trailing `;` is how a statement ends and nothing else; left on, it made a condition combined
    // with a logpoint a syntax error, which V8 reads as "false" — a logpoint that never printed.
    let condition = spec
        .condition
        .as_deref()
        .map(|c| c.trim().trim_end_matches(';').trim_end())
        .filter(|c| !c.is_empty());
    let message = spec.log_message.as_deref().filter(|m| !m.trim().is_empty());
    match (condition, message) {
        (None, None) => None,
        (Some(condition), None) => Some(condition.to_string()),
        (condition, Some(message)) => {
            let print = format!("(console.log({}), false)", logpoint_expression(message));
            Some(match condition {
                Some(condition) => format!("({condition}) && {print}"),
                None => print,
            })
        }
    }
}

/// `Debugger.setPauseOnExceptions`'s state for a set of enabled filters.
fn pause_state(filters: &[String]) -> &'static str {
    if filters.iter().any(|f| f == "all") {
        "all"
    } else if filters.iter().any(|f| f == "uncaught") {
        "uncaught"
    } else {
        "none"
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

/// The name a scope is shown under: `Local`, `Closure (compute)`, `Global`.
fn scope_name(scope: &Value) -> String {
    let kind = scope.get("type").and_then(Value::as_str).unwrap_or("scope");
    let mut title: String = kind.chars().take(1).flat_map(char::to_uppercase).collect();
    title.push_str(&kind[kind.chars().next().map(char::len_utf8).unwrap_or(0)..]);
    match scope.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) {
        Some(name) => format!("{title} ({name})"),
        None => title,
    }
}

/// Every scope of one CDP call frame, innermost first, as rows the variables panel can expand.
fn scope_rows(frame: &Value) -> Vec<Variable> {
    frame
        .get("scopeChain")
        .and_then(Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(|scope| {
                    let object_id = scope.get("object")?.get("objectId")?.as_str()?;
                    Some(Variable { name: scope_name(scope), value: String::new(), object_id: Some(object_id.to_string()) })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Reads `Debugger.paused` into the frame list the UI renders. `scripts` maps script ids to
/// urls (see [`Session::scripts`]); `paths` puts each file back under the name the user knows.
fn parse_paused(params: &Value, scripts: &HashMap<String, String>, paths: &PathMap) -> PausedEvent {
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
                        file: paths.to_user(&url_to_path(&url)),
                        line: location.get("lineNumber").and_then(Value::as_u64).unwrap_or(0) as u32 + 1,
                        scope_id,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    // A pause on an exception carries the exception itself; its first line is the message.
    let description = params
        .get("data")
        .filter(|_| reason == "exception" || reason == "promiseRejection")
        .map(|data| render_value(data).value)
        .map(|text| text.lines().next().unwrap_or_default().to_string())
        .filter(|text| !text.is_empty());
    PausedEvent { reason, frames, description }
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

/// Whether `Runtime.executionContextDestroyed` is the program finishing.
///
/// A finished program under `--inspect-brk` does not exit: Node prints "Waiting for the debugger
/// to disconnect…" and holds the process open for as long as a debugger is attached, so without
/// this the panel sat at "Running" beside a program that had ended. The context that goes away is
/// the program's own — `vm` contexts come and go too, and must not end the session — so it is
/// told apart by the id recorded when V8 announced the default context. With none recorded (an old
/// Node that never flagged it), any destruction counts.
fn ends_the_program(main_context: Option<i64>, params: &Value) -> bool {
    let destroyed = params.get("executionContextId").and_then(Value::as_i64);
    match (main_context, destroyed) {
        (Some(main), Some(id)) => main == id,
        _ => true,
    }
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
    // One client for the process rather than one per attach. Building a reqwest client is not free
    // even for plain HTTP — rustls still constructs a `ClientConfig` and a root certificate store —
    // and this runs on the path where the user just pressed "Debug" and is watching the button.
    // Cloning is free (a `reqwest::Client` is an `Arc` around the inner state); the loop below then
    // reuses the same kept-alive connection to the inspector across every poll, as it already did.
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(reqwest::Client::new).clone();
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

/// Launches `program` under Node's inspector and attaches. `breakpoints` and the exception
/// filters are applied before the program is allowed to run, so a breakpoint on line 1 is
/// honoured.
pub async fn start<R: Runtime>(
    app: AppHandle<R>,
    cwd: &str,
    node_binary: &str,
    program: &str,
    args: &[String],
    breakpoints: &Breakpoints,
    exception_filters: &[String],
) -> Result<(), String> {
    stop().await;

    // Port 0 would be ideal, but the inspector prints its port to stderr rather than reporting
    // it anywhere queryable, so a free one is picked here instead.
    let port = pick_free_port()?;
    let mut command = crate::proc::command(node_binary);
    command
        .arg(format!("--inspect-brk=127.0.0.1:{port}"))
        .arg(program)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // A group of its own, so Stop — and quitting the app — reaches whatever the program started,
    // not only the `node` at its root. See `ai_runs::kill_tree`.
    crate::proc::own_process_group(&mut command);
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
            crate::ai_runs::kill_tree(&mut child).await;
            return Err(format!("could not attach to Node's inspector: {e}"));
        }
    };

    let socket = match tokio_tungstenite::connect_async(&ws_url).await {
        Ok((socket, _)) => socket,
        Err(e) => {
            crate::ai_runs::kill_tree(&mut child).await;
            return Err(format!("inspector connection failed: {e}"));
        }
    };
    let (mut sink, mut stream) = socket.split();

    let (outbound, mut rx) = mpsc::unbounded_channel::<Message>();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
    });

    let mut paths = PathMap::default();
    paths.learn(cwd);
    paths.learn(&std::path::Path::new(cwd).join(program).to_string_lossy());
    let session = Arc::new(Session {
        outbound,
        next_id: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
        child: Mutex::new(Some(child)),
        breakpoint_ids: Mutex::new(Vec::new()),
        scripts: Mutex::new(HashMap::new()),
        paths: Mutex::new(paths),
        paused: Mutex::new(None),
        main_context: Mutex::new(None),
    });

    let reader_session = Arc::clone(&session);
    let reader_app = app.clone();
    // `--inspect-brk`'s halt on the first statement is consumed here, once.
    let entry_seen = AtomicBool::new(false);
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

            let params = value.get("params").cloned().unwrap_or(Value::Null);
            match value.get("method").and_then(Value::as_str) {
                Some("Debugger.paused") => {
                    if is_entry_break(!entry_seen.swap(true, Ordering::Relaxed), &params) {
                        // Fire-and-forget: nothing waits on this reply, and the next thing the UI
                        // should see is a real stop.
                        let id = reader_session.next_id.fetch_add(1, Ordering::Relaxed);
                        let resume = json!({ "id": id, "method": "Debugger.resume", "params": {} });
                        let _ = reader_session.outbound.send(Message::Text(resume.to_string().into()));
                        continue;
                    }
                    let scripts = reader_session.scripts.lock().map(|s| s.clone()).unwrap_or_default();
                    let event = match reader_session.paths.lock() {
                        Ok(paths) => parse_paused(&params, &scripts, &paths),
                        Err(_) => parse_paused(&params, &scripts, &PathMap::default()),
                    };
                    if let Ok(mut paused) = reader_session.paused.lock() {
                        *paused = Some((event.clone(), params));
                    }
                    let _ = reader_app.emit("debug:paused", event);
                }
                Some("Debugger.scriptParsed") => {
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
                    if let Ok(mut paused) = reader_session.paused.lock() {
                        paused.take();
                    }
                    let _ = reader_app.emit("debug:resumed", ());
                }
                Some("Runtime.executionContextCreated") => {
                    let context = params.get("context").unwrap_or(&Value::Null);
                    let is_default = context
                        .get("auxData")
                        .and_then(|aux| aux.get("isDefault"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if let (true, Some(id)) = (is_default, context.get("id").and_then(Value::as_i64)) {
                        if let Ok(mut main) = reader_session.main_context.lock() {
                            main.get_or_insert(id);
                        }
                    }
                }
                Some("Runtime.executionContextDestroyed") => {
                    let main = reader_session.main_context.lock().ok().and_then(|m| *m);
                    if ends_the_program(main, &params) {
                        // Disconnecting is what lets Node exit; the socket closing then ends the
                        // loop, and the session with it.
                        let _ = reader_session.outbound.send(Message::Close(None));
                    }
                }
                // `Runtime.consoleAPICalled` is deliberately not forwarded. Node writes every
                // `console.*` call to its stdout/stderr *as well as* announcing it here, and those
                // streams are already piped into the console above — so forwarding both printed
                // every line twice, a logpoint's included.
                _ => {}
            }
        }
        // The socket closing *is* the program ending: nothing else tears it down.
        finish(&reader_app, &reader_session).await;
    });

    // In the slot before the first call, so that a Stop pressed while this attaches — or a failure
    // below — reaches the process instead of leaving it waiting on its first line forever.
    if let Ok(mut slot) = slot().lock() {
        *slot = Some(Arc::clone(&session));
    }
    let configured = async {
        session.call("Runtime.enable", json!({})).await?;
        session.call("Debugger.enable", json!({})).await?;
        apply_breakpoints(&session, breakpoints).await?;
        session
            .call("Debugger.setPauseOnExceptions", json!({ "state": pause_state(exception_filters) }))
            .await?;
        // Only now is the program allowed past its first line.
        session.call("Runtime.runIfWaitingForDebugger", json!({})).await?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = configured {
        stop().await;
        return Err(e);
    }
    Ok(())
}

/// A session whose socket has closed: told to the panel — unless it was stopped from here, which
/// the panel already knows about, or replaced by a newer run, which a stale "terminated" would reset
/// — and whatever is left of its process ended.
async fn finish<R: Runtime>(app: &AppHandle<R>, session: &Arc<Session>) {
    // Every call still waiting for a reply is answered with an error now, rather than hanging on a
    // socket that will never speak again.
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
    let child = session.child.lock().ok().and_then(|mut c| c.take());
    if let Some(mut child) = child {
        crate::ai_runs::kill_tree(&mut child).await;
    }
}

fn pipe_output<R: Runtime, P: tokio::io::AsyncRead + Unpin + Send + 'static>(
    app: AppHandle<R>,
    pipe: Option<P>,
    kind: &'static str,
) {
    let Some(pipe) = pipe else { return };
    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if kind == "stderr" && is_inspector_chatter(&line) {
                continue;
            }
            let _ = app.emit("debug:output", OutputEvent { kind: kind.to_string(), text: line });
        }
    });
}

/// What Node's inspector prints to stderr about itself: where it listens, the help link, "Debugger
/// attached.", and on the way out "Waiting for the debugger to disconnect...". None of it is the
/// program's, and in a console that paints stderr red it read as a handful of errors on every run.
fn is_inspector_chatter(line: &str) -> bool {
    line.starts_with("Debugger listening on ws://")
        || line.starts_with("Debugger ending on ws://")
        || line.starts_with("For help, see: https://nodejs.org")
        || line.starts_with("Waiting for the debugger to disconnect")
        || line == "Debugger attached."
}

fn pick_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

async fn apply_breakpoints(session: &Session, breakpoints: &Breakpoints) -> Result<(), String> {
    let existing: Vec<String> = session
        .breakpoint_ids
        .lock()
        .map(|ids| ids.clone())
        .unwrap_or_default();
    for id in existing {
        let _ = session.call("Debugger.removeBreakpoint", json!({ "breakpointId": id })).await;
    }

    let mut fresh = Vec::new();
    for (path, specs) in breakpoints {
        let mut spellings = vec![path.clone()];
        spellings.extend(canonical(path));
        if let Ok(mut paths) = session.paths.lock() {
            paths.learn(path);
        }
        let pattern = url_regex(&spellings, cfg!(windows));
        // V8 refuses a second breakpoint on a location that already has one.
        let mut lines = HashSet::new();
        for spec in specs.iter().filter(|spec| lines.insert(spec.line)) {
            let mut params = json!({ "lineNumber": spec.line.saturating_sub(1), "urlRegex": pattern });
            if let Some(condition) = node_condition(spec) {
                params["condition"] = json!(condition);
            }
            let result = session.call("Debugger.setBreakpointByUrl", params).await?;
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

pub async fn set_breakpoints(breakpoints: &Breakpoints) -> Result<(), String> {
    // No session yet is not an error: breakpoints are edited before a run starts far more often
    // than during one, and they're sent again at launch.
    let Some(session) = current() else { return Ok(()) };
    apply_breakpoints(&session, breakpoints).await
}

pub async fn set_exception_filters(filters: &[String]) -> Result<(), String> {
    let Some(session) = current() else { return Ok(()) };
    session
        .call("Debugger.setPauseOnExceptions", json!({ "state": pause_state(filters) }))
        .await
        .map(|_| ())
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

/// The scopes of one paused frame — any frame, not only the top one. CDP hands every frame's scope
/// chain over in the pause itself, so this answers from what the pause said.
pub fn scopes(frame_id: &str) -> Result<Vec<Variable>, String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let paused = session.paused.lock().map_err(|e| e.to_string())?;
    let (_, params) = paused.as_ref().ok_or_else(|| "the program is not paused".to_string())?;
    params
        .get("callFrames")
        .and_then(Value::as_array)
        .and_then(|frames| {
            frames
                .iter()
                .find(|frame| frame.get("callFrameId").and_then(Value::as_str) == Some(frame_id))
        })
        .map(scope_rows)
        .ok_or_else(|| "that frame is no longer on the stack".to_string())
}

/// Evaluates an expression in a paused frame — the debug console, and the watch list. A watch is
/// evaluated `silent`: it runs on every stop, and an exception in one must never itself stop the
/// program or print.
pub async fn evaluate(frame_id: &str, expression: &str, context: Option<&str>) -> Result<Variable, String> {
    let session = current().ok_or_else(|| "no debug session".to_string())?;
    let result = session
        .call(
            "Debugger.evaluateOnCallFrame",
            json!({
                "callFrameId": frame_id,
                "expression": expression,
                "returnByValue": false,
                "silent": context == Some("watch"),
            }),
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

/// Where the running program is stopped, if it is — for a panel mounting over a session it did not
/// start (the webview reloaded).
pub fn paused_state() -> Option<PausedEvent> {
    let session = current()?;
    let paused = session.paused.lock().ok()?;
    paused.as_ref().map(|(event, _)| event.clone())
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

    /// The spelling Node itself produces — checked against `url.pathToFileURL` on Node 24 — for the
    /// characters that broke breakpoints: a space, an accent, and punctuation Node encodes.
    #[test]
    fn spaces_and_accents_are_percent_encoded_the_way_node_writes_them() {
        assert_eq!(
            file_url("/Users/me/Mi Proyecto é/app.js"),
            "file:///Users/me/Mi%20Proyecto%20%C3%A9/app.js"
        );
        assert_eq!(file_url("C:\\Users\\Mi Proyecto\\app.js"), "file:///C:/Users/Mi%20Proyecto/app.js");
        assert_eq!(file_url("/tmp/a#b?c~d[e]f"), "file:///tmp/a%23b%3Fc%7Ed%5Be%5Df");
        // What Node leaves alone stays alone.
        assert_eq!(file_url("/tmp/a(b)+c@d,e;f"), "file:///tmp/a(b)+c@d,e;f");
    }

    /// Clicking a frame opens the file: the URL has to decode back to the path on disk, spaces and
    /// accents included — this is what `url_to_path` used to leave encoded.
    #[test]
    fn a_reported_url_decodes_back_to_the_path_on_disk() {
        assert_eq!(
            url_to_path("file:///private/tmp/Mi%20Proyecto%20%C3%A9/prog.js"),
            "/private/tmp/Mi Proyecto é/prog.js"
        );
        assert_eq!(url_to_path("file:///c:/Mi%20Proyecto/app.js"), "c:\\Mi Proyecto\\app.js");
        assert_eq!(url_to_path("file://server/share/x%20y.js"), "\\\\server\\share\\x y.js");
        // A stray `%` that is not an escape is kept rather than refused.
        assert_eq!(url_to_path("file:///tmp/100%/a.js"), "/tmp/100%/a.js");
        for path in ["/Users/me/Mi Proyecto é/app.js", "/tmp/a#b?c~d[e]f.js", "/tmp/日本/x.js"] {
            assert_eq!(url_to_path(&file_url(path)), path);
        }
    }

    #[test]
    fn a_runtime_internal_url_is_left_alone() {
        assert_eq!(url_to_path("node:internal/modules/cjs/loader"), "node:internal/modules/cjs/loader");
    }

    /// Checks a pattern the way V8 will: as an anchored regular expression over the script's URL.
    fn matches(pattern: &str, url: &str) -> bool {
        regex::Regex::new(pattern).unwrap().is_match(url)
    }

    /// The breakpoint's pattern has to match the URL V8 actually reports for a file the editor
    /// knows by another name — the symlinked temp folder and the encoded space are the two cases
    /// that made breakpoints silently never fire.
    #[test]
    fn a_breakpoint_pattern_matches_the_real_path_however_it_is_spelled() {
        let pattern = url_regex(
            &["/var/folders/x/Mi Proyecto é/app.js".into(), "/private/var/folders/x/Mi Proyecto é/app.js".into()],
            false,
        );
        assert!(matches(&pattern, "file:///private/var/folders/x/Mi%20Proyecto%20%C3%A9/app.js"));
        assert!(matches(&pattern, "file:///var/folders/x/Mi%20Proyecto%20%C3%A9/app.js"));
        // Hex in either case, and punctuation Node versions disagree about.
        assert!(matches(&pattern, "file:///var/folders/x/Mi%20Proyecto%20%c3%a9/app.js"));
        // Anchored: another file whose URL merely contains this one's is not it.
        assert!(!matches(&pattern, "file:///var/folders/x/Mi%20Proyecto%20%C3%A9/app.jsx"));
        assert!(!matches(&pattern, "file:///other/var/folders/x/Mi%20Proyecto%20%C3%A9/app.js"));
        // `.` is a dot, not "any character".
        assert!(!matches(&url_regex(&["/a/app.js".into()], false), "file:///a/appxjs"));

        let tilde = url_regex(&["/home/me/~work/a.js".into()], false);
        assert!(matches(&tilde, "file:///home/me/~work/a.js"));
        assert!(matches(&tilde, "file:///home/me/%7Ework/a.js"));
    }

    /// Windows paths are matched without case — a drive letter typed `c:` is the same drive V8
    /// reports as `C:` — and with the colon either way.
    #[test]
    fn windows_breakpoint_patterns_ignore_case() {
        let pattern = url_regex(&["c:\\Repo\\Mi App\\app.js".into()], true);
        assert!(matches(&pattern, "file:///C:/repo/Mi%20App/app.js"));
        assert!(matches(&pattern, "file:///c:/REPO/mi%20app/APP.js"));
        assert!(matches(&pattern, "file:///C%3A/repo/Mi%20App/app.js"));
        assert!(!matches(&pattern, "file:///D:/repo/Mi%20App/app.js"));
    }

    /// A frame reported under the resolved path comes back under the name the user opened —
    /// otherwise the stopped-line highlight never lands in the tab that is open.
    #[test]
    fn reported_paths_map_back_to_the_names_the_user_gave() {
        let mut paths = PathMap::default();
        paths.remember("/private/var/folders/x/project".into(), "/var/folders/x/project".into());
        paths.remember("/Volumes/Data/code/app".into(), "/Users/me/code/app".into());
        assert_eq!(paths.to_user("/private/var/folders/x/project/src/a.js"), "/var/folders/x/project/src/a.js");
        assert_eq!(paths.to_user("/Volumes/Data/code/app"), "/Users/me/code/app");
        // A sibling that only shares a prefix is not inside it.
        assert_eq!(paths.to_user("/Volumes/Data/code/application/a.js"), "/Volumes/Data/code/application/a.js");
        assert_eq!(paths.to_user("node:internal/x"), "node:internal/x");
        // The most specific mapping wins.
        paths.remember("/Volumes/Data/code/app/vendor".into(), "/Users/me/vendor".into());
        assert_eq!(paths.to_user("/Volumes/Data/code/app/vendor/lib.js"), "/Users/me/vendor/lib.js");
    }

    /// The same, end to end on the real file system: the temp folder is a symlink on macOS, which
    /// is exactly how the two live tests below were failing.
    #[test]
    fn a_symlinked_folder_is_learned_from_disk() {
        let base = std::env::temp_dir().join(format!("cf-paths-{}", uuid::Uuid::new_v4()));
        let real = base.join("real dir");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("app.js"), "").unwrap();
        let linked = base.join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        #[cfg(unix)]
        {
            let given = linked.join("app.js").to_string_lossy().into_owned();
            let resolved = canonical(&given).unwrap();
            assert!(resolved.contains("real dir"), "{resolved}");
            let mut paths = PathMap::default();
            paths.learn(&given);
            assert_eq!(paths.to_user(&resolved), given);
            let pattern = url_regex(&[given.clone(), resolved.clone()], false);
            assert!(matches(&pattern, &file_url(&resolved)));
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_verbatim_windows_path_loses_its_prefix() {
        assert_eq!(strip_verbatim(r"\\?\C:\repo\app.js"), r"C:\repo\app.js");
        assert_eq!(strip_verbatim(r"\\?\UNC\server\share\app.js"), r"\\server\share\app.js");
        assert_eq!(strip_verbatim("/home/dev/app.js"), "/home/dev/app.js");
    }

    #[test]
    fn a_condition_and_a_logpoint_become_one_cdp_condition() {
        let plain = BreakpointSpec { line: 3, ..BreakpointSpec::default() };
        assert_eq!(node_condition(&plain), None);

        let conditional = BreakpointSpec { line: 3, condition: Some(" i > 2; ".into()), log_message: None };
        assert_eq!(node_condition(&conditional).as_deref(), Some("i > 2"));

        // A logpoint prints and answers false, so the program never stops there.
        let log = BreakpointSpec { line: 3, condition: None, log_message: Some("i is {i}".into()) };
        let expression = node_condition(&log).unwrap();
        assert!(expression.starts_with("(console.log(\"i is \" + "), "{expression}");
        assert!(expression.ends_with(", false)"), "{expression}");

        // Both: only prints when the condition holds.
        let both = BreakpointSpec { line: 3, condition: Some("i > 2".into()), log_message: Some("hit".into()) };
        assert_eq!(node_condition(&both).as_deref(), Some("(i > 2) && (console.log(\"hit\"), false)"));

        // A blank condition or message is no condition at all.
        let blank = BreakpointSpec { line: 3, condition: Some("  ".into()), log_message: Some(" ".into()) };
        assert_eq!(node_condition(&blank), None);
    }

    #[test]
    fn logpoint_messages_quote_their_text_and_evaluate_their_braces() {
        assert_eq!(logpoint_expression("plain"), "\"plain\"");
        assert_eq!(logpoint_expression("quote \" and \\"), "\"quote \\\" and \\\\\"");
        let interpolated = logpoint_expression("a={a} b={ obj.b }!");
        assert!(interpolated.starts_with("\"a=\" + (() => { try { return String(a); }"), "{interpolated}");
        assert!(interpolated.contains("String(obj.b)"), "{interpolated}");
        assert!(interpolated.ends_with(" + \"!\""), "{interpolated}");
        // An unclosed brace, or an empty pair, is text.
        assert_eq!(logpoint_expression("open { brace"), "\"open { brace\"");
        assert_eq!(logpoint_expression("empty {} pair"), "\"empty {} pair\"");
    }

    #[test]
    fn the_inspectors_own_chatter_is_not_the_programs_output() {
        assert!(is_inspector_chatter("Debugger listening on ws://127.0.0.1:9333/cb83"));
        assert!(is_inspector_chatter("For help, see: https://nodejs.org/learn/getting-started/debugging"));
        assert!(is_inspector_chatter("Debugger attached."));
        assert!(is_inspector_chatter("Waiting for the debugger to disconnect..."));
        assert!(!is_inspector_chatter("TypeError: Debugger attached. is not a function"));
        assert!(!is_inspector_chatter("Error: listen EADDRINUSE"));
    }

    #[test]
    fn exception_filters_pick_the_widest_state() {
        assert_eq!(pause_state(&[]), "none");
        assert_eq!(pause_state(&["uncaught".into()]), "uncaught");
        assert_eq!(pause_state(&["uncaught".into(), "all".into()]), "all");
        assert_eq!(pause_state(&["something-else".into()]), "none");
    }

    /// Breakpoints sent the old way — bare line numbers — still arrive.
    #[test]
    fn breakpoints_arrive_as_lines_or_as_specs() {
        let parsed: HashMap<String, Vec<BreakpointInput>> =
            serde_json::from_value(json!({ "/a.js": [4, { "line": 7, "condition": "x", "logMessage": "hi" }] })).unwrap();
        let specs: Vec<BreakpointSpec> = parsed["/a.js"].iter().cloned().map(BreakpointSpec::from).collect();
        assert_eq!(specs[0], BreakpointSpec { line: 4, condition: None, log_message: None });
        assert_eq!(specs[1], BreakpointSpec { line: 7, condition: Some("x".into()), log_message: Some("hi".into()) });
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
        let event = parse_paused(&params, &HashMap::new(), &PathMap::default());
        assert_eq!(event.reason, "other");
        let frame = &event.frames[0];
        assert_eq!(frame.name, "compute");
        // CDP said 4; editors count that line as 5.
        assert_eq!(frame.line, 5);
        assert_eq!(frame.file, "C:\\repo\\app.js");
        assert_eq!(frame.scope_id.as_deref(), Some("local-1"));
        assert_eq!(event.description, None);
    }

    #[test]
    fn a_pause_on_an_exception_says_which() {
        let params = json!({
            "reason": "exception",
            "data": { "type": "object", "description": "TypeError: x is not a function\n    at compute (app.js:3:5)" },
            "callFrames": []
        });
        let event = parse_paused(&params, &HashMap::new(), &PathMap::default());
        assert_eq!(event.description.as_deref(), Some("TypeError: x is not a function"));
    }

    /// Every scope of a frame, innermost first, each expandable — including a closure's name.
    #[test]
    fn every_scope_of_a_frame_is_listed() {
        let frame = json!({
            "callFrameId": "f",
            "scopeChain": [
                { "type": "local", "object": { "objectId": "l" } },
                { "type": "closure", "name": "outer", "object": { "objectId": "c" } },
                { "type": "global", "object": { "objectId": "g" } },
                { "type": "block" }
            ]
        });
        let rows = scope_rows(&frame);
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["Local", "Closure (outer)", "Global"]);
        assert_eq!(rows[1].object_id.as_deref(), Some("c"));
    }

    /// The program's own context going away ends the session; a `vm` context does not.
    #[test]
    fn only_the_programs_own_context_ending_ends_the_session() {
        assert!(ends_the_program(Some(1), &json!({ "executionContextId": 1 })));
        assert!(!ends_the_program(Some(1), &json!({ "executionContextId": 2 })));
        assert!(ends_the_program(None, &json!({ "executionContextId": 2 })));
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
        assert_eq!(parse_paused(&params, &HashMap::new(), &PathMap::default()).frames[0].name, "(anonymous)");
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
            Self::in_folder("", body)
        }

        /// The script inside `folder` under the temp dir — which on macOS is itself reached through
        /// a symlink, so every fixture already exercises that case.
        fn in_folder(folder: &str, body: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cf-debug-{}", uuid::Uuid::new_v4()));
            let home = if folder.is_empty() { dir.clone() } else { dir.join(folder) };
            std::fs::create_dir_all(&home).unwrap();
            let script = home.join("program.js");
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
    /// on this side of the event emitting. The program's stdout arrives on the second channel.
    async fn attach(
        fixture: &Fixture,
        breakpoints: Vec<BreakpointSpec>,
    ) -> (Arc<Session>, mpsc::UnboundedReceiver<Value>, mpsc::UnboundedReceiver<String>) {
        let port = pick_free_port().unwrap();
        let mut child = tokio::process::Command::new("node")
            .arg(format!("--inspect-brk=127.0.0.1:{port}"))
            .arg(&fixture.script)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();
        let stdout = child.stdout.take().unwrap();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = stdout_tx.send(line);
            }
        });

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
            paths: Mutex::new(PathMap::default()),
            paused: Mutex::new(None),
            main_context: Mutex::new(None),
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
        let mut map = HashMap::new();
        map.insert(fixture.script.clone(), breakpoints);
        apply_breakpoints(&session, &map).await.unwrap();
        session.call("Runtime.runIfWaitingForDebugger", json!({})).await.unwrap();
        (session, events_rx, stdout_rx)
    }

    fn at(line: u32) -> Vec<BreakpointSpec> {
        vec![BreakpointSpec { line, ..BreakpointSpec::default() }]
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
            let paths = session.paths.lock().unwrap();
            return parse_paused(&params, &scripts, &paths);
        }
    }

    fn kill(session: &Session) {
        let child = session.child.lock().unwrap().take();
        drop(child.map(|mut c| c.start_kill()));
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
        let (session, mut events, _) = attach(&fixture, at(4)).await;

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

        kill(&session);
    }

    #[tokio::test]
    async fn stepping_over_advances_one_line() {
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        let fixture = Fixture::new("let a = 1;\nlet b = 2;\nlet c = a + b;\nconsole.log(c);\n");
        let (session, mut events, _) = attach(&fixture, at(2)).await;

        let mut first_pause = true;
        let first = next_pause(&session, &mut events, &mut first_pause).await;
        assert_eq!(first.frames[0].line, 2);

        session.call("Debugger.stepOver", json!({})).await.unwrap();
        let second = next_pause(&session, &mut events, &mut first_pause).await;
        assert_eq!(second.reason, "step");
        assert_eq!(second.frames[0].line, 3);

        kill(&session);
    }

    /// The path the bug report was about: a project folder with a space and an accent in it. The
    /// breakpoint binds, and the frame comes back under the path the editor has open.
    #[tokio::test]
    async fn a_breakpoint_binds_in_a_folder_with_spaces_and_accents() {
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        let fixture = Fixture::in_folder("Mi Proyecto é", "let a = 1;\nlet b = a + 1;\nconsole.log(b);\n");
        let (session, mut events, _) = attach(&fixture, at(2)).await;
        let mut first_pause = true;
        let paused = next_pause(&session, &mut events, &mut first_pause).await;
        assert_eq!(paused.frames[0].line, 2);
        assert_eq!(paused.frames[0].file, fixture.script);
        kill(&session);
    }

    /// A condition is honoured by V8 itself, and a logpoint prints without ever stopping.
    #[tokio::test]
    async fn conditions_and_logpoints_are_honoured() {
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        let fixture = Fixture::new("let total = 0;\nfor (let i = 0; i < 5; i++) {\n  total += i;\n}\nconsole.log('end', total);\n");
        let breakpoints = vec![
            BreakpointSpec { line: 3, condition: Some("i === 3".into()), log_message: None },
            BreakpointSpec { line: 5, condition: None, log_message: Some("total is {total}, oops {nope.x}".into()) },
        ];
        let (session, mut events, mut stdout) = attach(&fixture, breakpoints).await;
        let mut first_pause = true;
        let paused = next_pause(&session, &mut events, &mut first_pause).await;
        assert_eq!(paused.frames[0].line, 3);
        let i = session
            .call("Debugger.evaluateOnCallFrame", json!({ "callFrameId": paused.frames[0].id, "expression": "i" }))
            .await
            .unwrap();
        assert_eq!(render_value(&i["result"]).value, "3", "stopped only when the condition held");
        session.call("Debugger.resume", json!({})).await.unwrap();

        // The logpoint on line 5 prints; the program's own line follows; nothing else pauses.
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(10);
        let mut printed = Vec::new();
        while printed.len() < 2 {
            let line = tokio::time::timeout_at(deadline, stdout.recv()).await.expect("output").expect("stdout open");
            printed.push(line);
        }
        assert!(printed[0].starts_with("total is 10, oops <ReferenceError"), "{printed:?}");
        assert_eq!(printed[1], "end 10");
        while let Ok(message) = events.try_recv() {
            assert_ne!(message.get("method").and_then(Value::as_str), Some("Debugger.paused"), "a logpoint stopped");
        }
        kill(&session);
    }

    /// The whole session through `start`, as the app runs it: a program that runs to its end must
    /// end the session — Node would otherwise sit at "Waiting for the debugger to disconnect" and
    /// the panel at "Running" for ever.
    #[tokio::test]
    async fn a_program_that_finishes_ends_its_session() {
        use tauri::Listener;
        if !node_available() {
            eprintln!("skipping: node not on PATH");
            return;
        }
        let fixture = Fixture::in_folder("with space", "console.log('ran');\n");
        let app = tauri::test::mock_app();
        let (tx, mut rx) = mpsc::unbounded_channel::<&'static str>();
        let terminated = tx.clone();
        app.listen_any("debug:terminated", move |_| {
            let _ = terminated.send("terminated");
        });
        app.listen_any("debug:output", move |event| {
            if event.payload().contains("ran") {
                let _ = tx.send("output");
            }
        });
        let cwd = std::path::Path::new(&fixture.script).parent().unwrap().to_string_lossy().into_owned();
        start(app.handle().clone(), &cwd, "node", &fixture.script, &[], &HashMap::new(), &[])
            .await
            .expect("the session starts");

        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(15);
        while !seen.contains(&"terminated") {
            let next = tokio::time::timeout_at(deadline, rx.recv()).await.expect("the session ended").unwrap();
            seen.push(next);
        }
        assert!(seen.contains(&"output"), "the program's output reached the console once: {seen:?}");
        assert!(!is_running());
    }
}
