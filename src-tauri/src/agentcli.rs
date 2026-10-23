//! `cf`: the little command an agent runs to reach the app it is working inside.
//!
//! # What this is for
//!
//! An agent in one of this app's shells can already do anything a shell can — it has the working
//! copy, git, and the whole machine. What it *cannot* do is reach what only the app has: the window
//! (ask the user, put a line in front of them, open the diff it just wrote or a file at a line), what
//! the app runs (a service's log, a restart, another terminal's output), what the app knows (the code
//! map, the knowledge index, memories, the task tree, the local model), and what the app keeps
//! (saved database connections, API requests, Llavero entries) — the last *used* on the agent's
//! behalf after the user approves, never handed over. `cf help` lists the verbs; the ones that need
//! more than a few lines live in `agentcli/`:
//!
//! - `work.rs` — services, terminals, opening files, the agent's card, tasks;
//! - `knowhow.rs` — the code map, knowledge, memory and the local model;
//! - `vault.rs` — saved credentials, used and never shown;
//! - `place.rs` — which project and workspace the folder `cf` ran in belongs to.
//!
//! ```text
//!   cf notify "tests are green"      a line in the app, wherever the user is
//!   cf ask "drop the column?"        blocks; exits 0 on Yes, 1 on No
//!   cf choose "which db?" pg mysql   blocks; prints the option picked
//!   cf status                        what the app has in focus, as JSON
//!   cf review                        opens the diff of the task this folder belongs to
//!   cf hook <agent> <event>          an agent's status hook (stdin: its JSON); never prints
//!   cf guard                         a destructive shell command, held for the user's approval
//! ```
//!
//! # Why this is not `remotectl`
//!
//! That one is the phone's bridge: pairing, TLS, device tokens, and a dispatch table that is an
//! explicit security boundary over ~40 of the app's commands. This has no overlap with it — it does
//! not run git or edit a repository for the agent, which can do both itself. What it reads is what
//! the app already shows the user; what it *uses* of the app's secrets it uses only with the user's
//! approval in the window, and the secret itself never travels back to the agent.
//!
//! # What it costs
//!
//! One socket and one tokio task, bound to `127.0.0.1` on a port the OS picks. A connection is read,
//! answered and dropped; nothing is kept per client and there is no polling anywhere. A pending
//! `ask` is one entry in a map, removed when it is answered or when it times out — the one place
//! this could have leaked, and the reason the timeout exists at all.
//!
//! # How a shell is told where to call
//!
//! `CODEFLOW_PORT` and `CODEFLOW_TOKEN` go into the environment of every shell the app opens (see
//! `terminal.rs`). A process that was not started by this app has neither, so the endpoint answers
//! nothing to anything else on the machine — the token is the whole of the authentication, which is
//! exactly as strong as "you were started by this app" and no stronger. Bound to loopback, so
//! nothing off this machine can even connect.

mod knowhow;
mod place;
mod vault;
mod work;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// How long `cf ask` waits for a human. Generous — the user may be in another app — but finite:
/// a pending question that nobody ever answers must not pin a map entry and a socket for the life
/// of the process.
const ASK_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The largest request this reads. A verb and a sentence — except `cf llm`, which carries what was
/// piped into it, cut by `cf` at 2 MB (escaping can grow it, hence the margin).
const MAX_REQUEST: usize = 3 << 20;

/// Where the endpoint is listening and the token that opens it. `None` until `start` has bound.
static ENDPOINT: OnceLock<(u16, String)> = OnceLock::new();

/// What the user said to a `cf ask`: yes or no, and whatever they typed with it.
///
/// The verdict is its own field and never read out of the text: `cf ask "drop it?" && …` runs the
/// second half on a zero exit, so an answer box where typing "no" and pressing Enter counted as a
/// reply — and so as success — was a yes to everything.
#[derive(Debug)]
struct Answer {
    yes: bool,
    text: String,
    /// "Allow in this terminal": the same use, by the same terminal, is not asked again until the app
    /// restarts. Read only where the question offered it (see [`AskEvent::always`]).
    always: bool,
}

type AnswerSender = tokio::sync::oneshot::Sender<Answer>;

/// Questions waiting on a human, by id.
static PENDING: OnceLock<Mutex<HashMap<String, AnswerSender>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, AnswerSender>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What a shell needs in its environment to reach the app — `(key, value)` pairs, empty until the
/// endpoint is up. Read by `terminal.rs` for every shell it opens.
pub fn shell_env() -> Vec<(String, String)> {
    match ENDPOINT.get() {
        Some((port, token)) => vec![
            ("CODEFLOW_PORT".to_string(), port.to_string()),
            ("CODEFLOW_TOKEN".to_string(), token.clone()),
        ],
        None => Vec::new(),
    }
}

/// One request from `cf`.
#[derive(Debug, Deserialize)]
struct Request {
    token: String,
    verb: String,
    /// The arguments joined by spaces, for the verbs that take a sentence.
    #[serde(default)]
    text: String,
    /// The arguments as given, for the verbs that take several (`choose`, `logs --tail 20`, …).
    #[serde(default)]
    args: Vec<String>,
    /// What was piped into `cf llm`. Empty for every other verb.
    #[serde(default)]
    stdin: String,
    /// The folder the agent is in.
    #[serde(default)]
    cwd: String,
    /// The pty session the agent runs in (`CODEFLOW_SESSION`) — sent by every verb, empty in a shell
    /// that has none. For `hook`, also the agent and the few fields of its hook payload a card can
    /// use — picked out by `cf`, so a reply of any length never has to fit in a request.
    #[serde(default)]
    session: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    reply: String,
    #[serde(default)]
    tool: String,
}

/// What the app answers. `ok` is what `cf` turns into its exit code.
#[derive(Debug, Serialize)]
struct Reply {
    ok: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    text: String,
}

impl Reply {
    fn ok(text: impl Into<String>) -> Self {
        Reply { ok: true, text: text.into() }
    }
    fn no(text: impl Into<String>) -> Self {
        Reply { ok: false, text: text.into() }
    }
}

/// A question the app is showing, on its way to the window.
#[derive(Debug, Clone, Serialize, Default)]
struct AskEvent {
    id: String,
    /// What the modal is for: `ask` (yes or no), `choose` (one of `options`), `guard` (a destructive
    /// command), `secret`, `db` or `http` (a saved credential about to be used).
    kind: &'static str,
    question: String,
    /// The folder `cf` ran in. Several agents can ask at once (a race is several of them), and an
    /// answer given to the wrong worktree is the failure that matters.
    cwd: String,
    /// `choose`: the answers to pick from.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    options: Vec<String>,
    /// The exact thing being approved — the command, the SQL, the request — shown verbatim, because
    /// approving a summary of a command is not approving the command.
    #[serde(skip_serializing_if = "String::is_empty")]
    detail: String,
    /// Offer "allow in this terminal". Never for the guard or a Llavero secret: each of those is a
    /// different command every time, and one click must not approve the next one unseen.
    always: bool,
}

impl AskEvent {
    fn new(kind: &'static str, question: impl Into<String>, cwd: &str) -> Self {
        AskEvent { id: uuid::Uuid::new_v4().to_string(), kind, question: question.into(), cwd: cwd.trim().to_string(), ..Default::default() }
    }
}

/// Uses a terminal has been allowed for the rest of the app's run: `session|kind|target`.
static ALLOWED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

/// Puts a question in front of the user and waits for the answer — the one door every verb that needs
/// a human goes through. `None` when nobody answered in [`ASK_TIMEOUT`] or the window went away.
async fn ask_user(app: &AppHandle, event: AskEvent) -> Option<Answer> {
    let id = event.id.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if let Ok(mut held) = pending().lock() {
        held.insert(id.clone(), sender);
    }
    // A shell is blocked on the answer, so the window has to be where it can be seen: an agent that
    // asked from behind another application would otherwise look hung.
    raise(app);
    let _ = app.emit("agentcli:ask", event);
    match tokio::time::timeout(ASK_TIMEOUT, receiver).await {
        Ok(Ok(answer)) => Some(answer),
        // The window went away, or the question timed out: the entry goes either way, which is the
        // only thing here that could have grown without bound.
        _ => {
            if let Ok(mut held) = pending().lock() {
                held.remove(&id);
            }
            None
        }
    }
}

/// The user's approval for one use of something the app keeps, or the refusal to send back.
///
/// `target` names what is being used (a connection, a request): with `event.always` set, an "allow in
/// this terminal" answer lets the same terminal use the same target again without asking. A shell
/// with no session is keyed by its folder.
async fn approve(app: &AppHandle, request: &Request, target: &str, event: AskEvent) -> Result<(), Reply> {
    let who = if request.session.is_empty() { request.cwd.as_str() } else { request.session.as_str() };
    let key = format!("{who}|{}|{target}", event.kind);
    let allowed = || ALLOWED.get_or_init(Default::default);
    if event.always && allowed().lock().is_ok_and(|held| held.contains(&key)) {
        return Ok(());
    }
    let offered = event.always;
    match ask_user(app, event).await {
        Some(answer) if answer.yes => {
            if offered && answer.always {
                if let Ok(mut held) = allowed().lock() {
                    held.insert(key);
                }
            }
            Ok(())
        }
        Some(answer) => Err(reply_for(answer)),
        None => Err(Reply::no("no answer")),
    }
}

/// `cf ui` — CodeFlow's interface as actions (`codi::ui`): `state` (what every window shows),
/// `actions [area]` (what can be done), or `<action> [params as JSON]` (doing it). A destructive one
/// is confirmed by the user first: in Codi's window when Codi asked (its MCP session is `codi:…`),
/// in the app's approval dialog otherwise.
async fn interface(request: &Request, app: &AppHandle) -> Reply {
    use crate::codi::ui::{self, Asker};
    let lang = crate::codi::lang(app);
    let asker = if request.session.starts_with("codi:") { Asker::Codi } else { Asker::Agent };
    let mut args = request.args.iter().map(String::as_str);
    match args.next() {
        None | Some("state") => Reply::ok(ui::state(app).await.to_string()),
        Some("actions") | Some("list") => {
            if !ui::ready() {
                return Reply::no("the interface has not registered its actions yet");
            }
            Reply::ok(ui::actions_text(lang, args.next().unwrap_or("")))
        }
        Some(action) => {
            let raw: String = args.collect::<Vec<_>>().join(" ");
            let raw = if raw.trim().is_empty() { request.stdin.trim().to_string() } else { raw };
            let params = if raw.trim().is_empty() {
                serde_json::json!({})
            } else {
                match serde_json::from_str::<serde_json::Value>(&raw) {
                    Ok(value) if value.is_object() => value,
                    _ => return Reply::no(format!("the params must be a JSON object, not {raw}")),
                }
            };
            match ui::act(app, action, params.clone(), asker, false).await {
                Ok(result) => {
                    if asker == Asker::Codi {
                        crate::codi::brain::noted(crate::codi::Acted {
                            action: action.to_string(),
                            params,
                            ok: result.ok,
                            say: result.say.clone(),
                            error: result.error.clone(),
                            spoken: false,
                        });
                    }
                    let text = ui::result_text(&result);
                    if result.ok {
                        Reply::ok(text)
                    } else {
                        Reply::no(text)
                    }
                }
                Err(error) => Reply::no(error),
            }
        }
    }
}

/// What `cf status` prints — whatever the window has in focus. Filled by the UI, which is the only
/// side that knows; the endpoint keeps the last copy so a status asked a millisecond after a view
/// change is at worst one change stale.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Focus {
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub task: String,
}

static FOCUS: OnceLock<Mutex<Focus>> = OnceLock::new();

fn focus() -> &'static Mutex<Focus> {
    FOCUS.get_or_init(|| Mutex::new(Focus::default()))
}

/// Called by the UI whenever what it is showing changes. Cheap on purpose: three short strings.
#[tauri::command]
pub fn agentcli_focus(workspace: String, project: String, task: String) {
    if let Ok(mut held) = focus().lock() {
        *held = Focus { workspace, project, task };
    }
}

/// The answer to a question `cf ask` is waiting on: `yes` is what `cf` exits 0 on, and `text` is
/// printed either way. Dismissing is a no with nothing typed. `always` is "allow in this terminal",
/// read only where the question offered it.
#[tauri::command]
pub fn agentcli_answer(id: String, yes: bool, text: String, always: Option<bool>) {
    let sender = pending().lock().ok().and_then(|mut held| held.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(Answer { yes, text, always: always.unwrap_or(false) });
    }
}

/// What `cf` is told for an answer. A no with nothing typed still says "no", so a script that
/// prints the reply never prints an empty line for a refusal.
fn reply_for(answer: Answer) -> Reply {
    let text = answer.text.trim().to_string();
    if answer.yes {
        Reply::ok(text)
    } else if text.is_empty() {
        Reply::no("no")
    } else {
        Reply::no(text)
    }
}

/// Where the endpoint is, for the settings pane that says whether it is up.
#[tauri::command]
pub fn agentcli_endpoint() -> Option<u16> {
    ENDPOINT.get().map(|(port, _)| *port)
}

/// Binds the endpoint and serves it. Called once, from `setup`.
///
/// A bind that fails is logged and nothing else: the app works without this, and the shells it opens
/// simply carry no `CODEFLOW_PORT`, which is exactly the state `cf` reports as "not inside CodeFlow".
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(listener) => listener,
            Err(error) => {
                crate::applog::warn(&format!("agentcli: no endpoint ({error})"));
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(_) => return,
        };
        let token = uuid::Uuid::new_v4().to_string();
        let _ = ENDPOINT.set((port, token.clone()));
        crate::applog::info(&format!("agentcli: listening on 127.0.0.1:{port}"));

        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let app = app.clone();
            let token = token.clone();
            // One task per connection, which ends with it. Nothing is held between clients.
            tauri::async_runtime::spawn(async move {
                let _ = serve(stream, app, token).await;
            });
        }
    });
}

/// Reads one request, answers it, and lets the connection go.
async fn serve(mut stream: TcpStream, app: AppHandle, token: String) -> std::io::Result<()> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    // Read until the body is in hand or the client stops: `cf` sends one request and shuts its
    // writing half, which is what ends this loop.
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_REQUEST {
            break;
        }
        if body_of(&buffer).is_some() {
            break;
        }
    }

    let reply = match body_of(&buffer) {
        Some(body) => handle(body, &app, &token).await,
        None => Reply::no("malformed request"),
    };
    let json = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"ok\":false}".into());
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
        json.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

/// The JSON body of an HTTP request, once all of it has arrived.
///
/// Deliberately tiny: this speaks exactly as much HTTP as `cf` writes, and anything else is refused
/// rather than parsed. Separated out so it can be tested without a socket.
fn body_of(buffer: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(buffer).ok()?;
    let at = text.find("\r\n\r\n")?;
    let head = &text[..at];
    let body = &text[at + 4..];
    // `Content-Length` is what says the body is complete. Without it there is nothing to wait for.
    let length: usize = head
        .lines()
        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|rest| rest.trim().to_string()))?
        .parse()
        .ok()?;
    if body.len() < length {
        return None;
    }
    Some(&body[..length])
}

/// `a == b` in time that depends only on their lengths.
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// One verb.
async fn handle(body: &str, app: &AppHandle, token: &str) -> Reply {
    let Ok(request) = serde_json::from_str::<Request>(body) else {
        return Reply::no("malformed request");
    };
    // The token never leaves this machine and a wrong one is a process the app did not start, but
    // any local process can knock on the port: compared in constant time, so the knocking learns
    // nothing about it, and a mismatch says nothing either.
    if !same_secret(&request.token, token) {
        return Reply::no("not from this app");
    }
    dispatch(request, app).await
}

/// A verb on behalf of a chat's MCP call (`codemap::mcp`) instead of a `cf` in a shell — the same
/// code, answered as a `Result`. `cwd` is the run's repository; `session` keys "allow in this
/// terminal", and a chat passes its run there, so an allowance lasts the turn that was given it.
pub(crate) async fn run_verb(app: &AppHandle, verb: &str, args: Vec<String>, stdin: String, cwd: &str, session: &str) -> Result<String, String> {
    let request = Request {
        token: String::new(),
        verb: verb.to_string(),
        text: args.join(" "),
        args,
        stdin,
        cwd: cwd.to_string(),
        session: session.to_string(),
        agent: String::new(),
        prompt: String::new(),
        reply: String::new(),
        tool: String::new(),
    };
    let reply = dispatch(request, app).await;
    match (reply.ok, reply.text) {
        (true, text) => Ok(text),
        (false, text) if text.is_empty() => Err("no".to_string()),
        (false, text) => Err(text),
    }
}

/// The `cf guard` approval for a command the app's own agent is about to run (`local_agent`'s
/// `run_command`): the same modal, the reason as its question and the command verbatim as what is
/// approved — which `run_verb` cannot say, since it joins the arguments into one text.
pub(crate) async fn guard(app: &AppHandle, command: &str, reason: &str, cwd: &str) -> Result<String, String> {
    let mut event = AskEvent::new("guard", reason, cwd);
    event.detail = command.trim().to_string();
    let reply = match ask_user(app, event).await {
        Some(answer) => reply_for(answer),
        None => Reply::no("no answer"),
    };
    if reply.ok {
        Ok(reply.text)
    } else {
        Err(reply.text)
    }
}

/// One verb, from a request that is known to be the app's own.
async fn dispatch(request: Request, app: &AppHandle) -> Reply {
    match request.verb.as_str() {
        "notify" => {
            let text = request.text.trim();
            if text.is_empty() {
                return Reply::no("nothing to say");
            }
            let _ = app.emit("agentcli:notify", text.to_string());
            Reply::ok("")
        }
        "ask" => {
            let question = request.text.trim();
            if question.is_empty() {
                return Reply::no("nothing to ask");
            }
            match ask_user(app, AskEvent::new("ask", question, &request.cwd)).await {
                Some(answer) => reply_for(answer),
                None => Reply::no("no answer"),
            }
        }
        // One of several answers. The option picked is printed — and anything typed instead of
        // picking, which is the user's answer too.
        "choose" => {
            let [question, options @ ..] = request.args.as_slice() else {
                return Reply::no("usage: cf choose <question> <option> <option> ...");
            };
            let options: Vec<String> = options.iter().map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).collect();
            if question.trim().is_empty() || options.len() < 2 {
                return Reply::no("usage: cf choose <question> <option> <option> ...");
            }
            let mut event = AskEvent::new("choose", question.trim(), &request.cwd);
            event.options = options;
            match ask_user(app, event).await {
                Some(answer) => reply_for(answer),
                None => Reply::no("no answer"),
            }
        }
        // `cf guard`, the PreToolUse hook: a destructive command the agent is about to run. `text` is
        // the command, the one argument why `cf` held it.
        "guard" => {
            let reason = request.args.first().map(String::as_str).unwrap_or_default();
            let mut event = AskEvent::new("guard", reason, &request.cwd);
            event.detail = request.text.trim().to_string();
            match ask_user(app, event).await {
                Some(answer) => reply_for(answer),
                None => Reply::no("no answer"),
            }
        }
        "open" => work::open(&request, app),
        "logs" => work::logs(&request, app),
        "restart" => work::restart(&request, app).await,
        "wait" => work::wait(&request, app).await,
        "term" => work::term(&request, app),
        "progress" => work::progress(&request),
        "done" => work::done(&request, app),
        "task" => work::task(&request, app),
        "symbol" | "usages" | "outline" | "map" | "search" | "recall" => knowhow::tool(&request, app).await,
        "remember" => knowhow::remember(&request, app),
        "llm" => knowhow::llm(&request).await,
        "secret" => vault::secret(&request, app).await,
        "db" => vault::db(&request, app).await,
        "http" => vault::http(&request, app).await,
        "ui" => interface(&request, app).await,
        "status" => {
            let snapshot = focus().lock().ok().map(|held| held.clone()).unwrap_or_default();
            Reply::ok(serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".into()))
        }
        "review" => {
            let cwd = request.cwd.trim();
            if cwd.is_empty() {
                return Reply::no("no folder");
            }
            // The app matches the folder to a task — the same rule the terminal's menu uses — and
            // opens its diff. Answered as soon as it is asked for: the window may be behind another
            // app, and an agent should not block on a view it cannot see.
            // Asked for *by name* — "show me this" — so the window comes forward with it. Switching
            // view inside a window nobody is looking at is a no-op the agent cannot tell apart from
            // success.
            raise(app);
            let _ = app.emit("agentcli:review", cwd.to_string());
            Reply::ok("")
        }
        // An agent's status hook: what it is doing, for its line on the «Worktrees» rail. Never
        // raises the window — this is the agent talking about itself on every turn, not to the user.
        "hook" => {
            let event = request.text.trim();
            if event.is_empty() || request.session.trim().is_empty() {
                return Reply::no("no session");
            }
            if crate::agentstatus::hook(
                request.session.trim(),
                request.agent.trim(),
                event,
                &request.prompt,
                &request.reply,
                request.tool.trim(),
            ) {
                Reply::ok("")
            } else {
                Reply::no("no such terminal")
            }
        }
        other => Reply::no(format!("unknown verb: {other}")),
    }
}

/// The one item whose name is `wanted` — exactly (any case), else by prefix, else by substring. On
/// no match or several, the names that matched at the closest level (none: empty).
pub(crate) fn pick<T>(items: Vec<T>, wanted: &str, name: impl Fn(&T) -> &str) -> Result<T, Vec<String>> {
    let wanted = wanted.trim().to_lowercase();
    let tests: [&dyn Fn(&str) -> bool; 3] = [&|n| n == wanted, &|n| n.starts_with(&wanted), &|n| n.contains(&wanted)];
    for test in tests {
        let matching: Vec<usize> = items.iter().enumerate().filter(|(_, item)| test(&name(item).to_lowercase())).map(|(i, _)| i).collect();
        match matching.as_slice() {
            [] => continue,
            [one] => return Ok(items.into_iter().nth(*one).expect("index from the same list")),
            many => return Err(many.iter().map(|i| name(&items[*i]).to_string()).collect()),
        }
    }
    Err(Vec::new())
}

/// Brings the main window forward: unminimised, shown, focused.
///
/// Best effort on every step. A window the platform refuses to focus — macOS does this when the app
/// is not the active one and has no user gesture behind the request — is still unminimised and
/// shown, which is the part that matters for a question nobody can otherwise answer.
fn raise(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(body: &str) -> Vec<u8> {
        format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn waits_until_the_whole_body_has_arrived() {
        let whole = request(r#"{"token":"t","verb":"status"}"#);
        let half = &whole[..whole.len() - 5];
        assert!(body_of(half).is_none(), "a partial body is not a request yet");
        assert_eq!(body_of(&whole), Some(r#"{"token":"t","verb":"status"}"#));
    }

    #[test]
    fn refuses_what_is_not_a_request() {
        assert!(body_of(b"GET / HTTP/1.1\r\n\r\n").is_none(), "no content-length, nothing to wait for");
        assert!(body_of(b"hello").is_none());
    }

    /// The header may be spelled any way an HTTP client likes.
    #[test]
    fn reads_the_length_header_whatever_its_case() {
        let raw = b"POST / HTTP/1.1\r\nCONTENT-LENGTH: 2\r\n\r\n{}".to_vec();
        assert_eq!(body_of(&raw), Some("{}"));
    }

    /// A body longer than the header claims is read up to the claim and no further.
    #[test]
    fn reads_exactly_what_was_declared() {
        let raw = b"POST / HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}trailing".to_vec();
        assert_eq!(body_of(&raw), Some("{}"));
    }

    /// The exit code is the verdict, never the words: "no" typed into the box is still a no only
    /// because the user pressed No, and a Yes with a note is still a yes.
    #[test]
    fn the_verdict_decides_the_exit_code_not_the_text() {
        let yes = reply_for(Answer { yes: true, text: " go ahead ".into(), always: false });
        assert!(yes.ok);
        assert_eq!(yes.text, "go ahead");
        let typed_no = reply_for(Answer { yes: false, text: "not the prod table".into(), always: false });
        assert!(!typed_no.ok);
        assert_eq!(typed_no.text, "not the prod table");
        let dismissed = reply_for(Answer { yes: false, text: String::new(), always: false });
        assert!(!dismissed.ok);
        assert_eq!(dismissed.text, "no");
        assert!(!reply_for(Answer { yes: true, text: "no".into(), always: false }).text.is_empty(), "a yes keeps what was typed");
    }

    #[test]
    fn says_nothing_about_the_endpoint_before_it_is_bound() {
        // `shell_env` is what a shell is told. Before `start` there is nothing to tell, and a shell
        // with no `CODEFLOW_PORT` is exactly what `cf` reports as "not inside CodeFlow".
        if ENDPOINT.get().is_none() {
            assert!(shell_env().is_empty());
        }
    }
}
