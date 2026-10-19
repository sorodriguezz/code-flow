//! `cf`: the little command an agent runs to reach the app it is working inside.
//!
//! # What this is for
//!
//! An agent in one of this app's shells can already do anything a shell can — it has the working
//! copy, git, and the whole machine. What it *cannot* do is reach the window: it cannot say "I am
//! about to do something irreversible, ask the user", it cannot put a line in front of somebody who
//! is looking at another view, and it cannot open the diff it just wrote. That is the entire purpose
//! of this surface, and the reason it is four verbs and not a second command registry.
//!
//! ```text
//!   cf notify "tests are green"      a line in the app, wherever the user is
//!   cf ask "drop the column?"        blocks, prints what the user answered
//!   cf status                        what the app has in focus, as JSON
//!   cf review                        opens the diff of the task this folder belongs to
//! ```
//!
//! # Why this is not `remotectl`
//!
//! That one is the phone's bridge: pairing, TLS, device tokens, and a dispatch table that is an
//! explicit security boundary over ~40 of the app's commands. This has no overlap with it — it
//! cannot read a repository, run git, or touch the keyring. It reaches the *interface*, for a
//! process that already has everything else.
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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// How long `cf ask` waits for a human. Generous — the user may be in another app — but finite:
/// a pending question that nobody ever answers must not pin a map entry and a socket for the life
/// of the process.
const ASK_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The largest request this reads. A verb and a sentence; anything bigger is not one of ours.
const MAX_REQUEST: usize = 64 * 1024;

/// Where the endpoint is listening and the token that opens it. `None` until `start` has bound.
static ENDPOINT: OnceLock<(u16, String)> = OnceLock::new();

/// Questions waiting on a human, by id.
static PENDING: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>> {
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
    #[serde(default)]
    text: String,
    /// The folder the agent is in, for `review`.
    #[serde(default)]
    cwd: String,
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
#[derive(Debug, Clone, Serialize)]
struct AskEvent {
    id: String,
    question: String,
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

/// The answer to a question `cf ask` is waiting on, or `None` when the user dismissed it.
#[tauri::command]
pub fn agentcli_answer(id: String, answer: Option<String>) {
    let sender = pending().lock().ok().and_then(|mut held| held.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(answer);
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

/// One verb.
async fn handle(body: &str, app: &AppHandle, token: &str) -> Reply {
    let Ok(request) = serde_json::from_str::<Request>(body) else {
        return Reply::no("malformed request");
    };
    // Constant-time is not the point — the token never leaves this machine and a wrong one is a
    // process that was not started by the app — but a mismatch must say nothing about the token.
    if request.token != token {
        return Reply::no("not from this app");
    }

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
            let id = uuid::Uuid::new_v4().to_string();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if let Ok(mut held) = pending().lock() {
                held.insert(id.clone(), sender);
            }
            let _ = app.emit("agentcli:ask", AskEvent { id: id.clone(), question: question.to_string() });
            match tokio::time::timeout(ASK_TIMEOUT, receiver).await {
                Ok(Ok(Some(answer))) => Reply::ok(answer),
                Ok(Ok(None)) => Reply::no("dismissed"),
                // The window went away, or the question timed out: the entry goes either way, which
                // is the only thing here that could have grown without bound.
                _ => {
                    if let Ok(mut held) = pending().lock() {
                        held.remove(&id);
                    }
                    Reply::no("no answer")
                }
            }
        }
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
            let _ = app.emit("agentcli:review", cwd.to_string());
            Reply::ok("")
        }
        other => Reply::no(format!("unknown verb: {other}")),
    }
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

    #[test]
    fn says_nothing_about_the_endpoint_before_it_is_bound() {
        // `shell_env` is what a shell is told. Before `start` there is nothing to tell, and a shell
        // with no `CODEFLOW_PORT` is exactly what `cf` reports as "not inside CodeFlow".
        if ENDPOINT.get().is_none() {
            assert!(shell_env().is_empty());
        }
    }
}
