//! TypeScript's own language service, as a child process.
//!
//! # Why a real `tsserver` and not Monaco's bundled TypeScript worker
//!
//! Monaco ships a TypeScript worker, and it is genuinely easy to turn on. It also cannot answer the
//! question people actually ask. It knows the files you hand it, so to complete an import from a
//! package you must first find and feed it every `.d.ts` in `node_modules`; it does not read
//! `tsconfig.json`, so `paths`, project references and `baseUrl` — the things that make a monorepo a
//! monorepo — are invisible to it; and holding a large project's types in the webview's heap is how
//! an editor starts pausing. Every one of those failures lands precisely where this feature was
//! asked for: a freshly installed library, in a workspace package, that the editor should just know.
//!
//! `tsserver` is what VS Code runs, and it resolves all of that because it *is* the compiler.
//!
//! # It is the project's TypeScript, not ours
//!
//! The binary is looked for in the repository's own `node_modules`. Shipping a copy would add tens
//! of megabytes to every release to answer with a compiler version that disagrees with the one the
//! project builds with — which is worse than not answering, because the disagreement shows up as
//! phantom errors on code that compiles. A project without TypeScript installed gets a clear "not
//! found" rather than a silent fallback.
//!
//! # Framing
//!
//! Requests go out as one JSON object per line. Replies come back LSP-style, `Content-Length` header
//! then the body, and the two directions are deliberately not symmetric — that is tsserver's
//! protocol, not a choice made here.
//!
//! Notifications (`open`, `change`, `close`) get **no reply at all**, which is why they have their
//! own entry point: awaiting a response for one would hang until the session died.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

/// How long a request may wait before the caller is told the server is not answering.
///
/// Generous compared to the rest of the app's timeouts because the first request after a cold start
/// is behind the whole project being loaded — on a large monorepo that is genuinely seconds — and a
/// completion that gives up at two seconds would fail exactly when the user first tries it.
const TIMEOUT_SECS: u64 = 20;

struct Session {
    /// One JSON line per message. The writer task owns stdin.
    outbound: mpsc::UnboundedSender<String>,
    next_seq: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    child: Mutex<Option<tokio::process::Child>>,
    /// The repository this server was started for. A request naming a file outside it is a bug
    /// upstream, and the field is what lets `start` decide whether an existing session can be kept.
    root: String,
}

type SessionSlot = Mutex<Option<Arc<Session>>>;

fn slot() -> &'static SessionSlot {
    static SLOT: std::sync::OnceLock<SessionSlot> = std::sync::OnceLock::new();
    SLOT.get_or_init(SessionSlot::default)
}

fn current() -> Option<Arc<Session>> {
    slot().lock().ok()?.clone()
}

/// Where the project keeps its own TypeScript.
///
/// `tsserver.js` run through `node` rather than the `.bin/tsserver` shim: the shim is a shell script
/// on Unix and a `.cmd` on Windows, so spawning it means either a shell or a platform branch, and
/// the file it ultimately runs is this one.
fn tsserver_script(root: &str) -> Option<PathBuf> {
    let path = Path::new(root).join("node_modules").join("typescript").join("lib").join("tsserver.js");
    path.exists().then_some(path)
}

/// Starts the server for a repository, reusing the one already running for it.
///
/// Returns the path of the `tsserver.js` it started, which is the one piece of information worth
/// surfacing: "which TypeScript is answering" is the first question when an answer looks wrong.
#[tauri::command]
pub async fn ts_start(repo_path: String) -> Result<String, String> {
    // Already serving this repository. Restarting would throw away a loaded project — seconds of
    // work — to arrive at the same place.
    if let Some(existing) = current() {
        if existing.root == repo_path {
            return Ok(existing.root.clone());
        }
    }
    ts_stop().await;

    let script = tsserver_script(&repo_path)
        .ok_or_else(|| format!("No TypeScript in {repo_path}/node_modules — install it to get completions"))?;

    let mut child = tokio::process::Command::new("node")
        .arg(&script)
        // Single-threaded is deliberate: the separate syntax/semantic servers buy responsiveness in
        // an editor with many open files and cost a second process plus its own project load, which
        // on the sizes this app opens is the worse trade.
        .arg("--disableAutomaticTypingAcquisition")
        .current_dir(&repo_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start tsserver: {e}"))?;

    let stdin = child.stdin.take().ok_or("tsserver gave no stdin")?;
    let stdout = child.stdout.take().ok_or("tsserver gave no stdout")?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let session = Arc::new(Session {
        outbound: tx,
        next_seq: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
        child: Mutex::new(Some(child)),
        root: repo_path.clone(),
    });

    // Writer. Owns stdin so nothing else can interleave a half-written line into the protocol.
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    // Reader. Resolves whichever request each response belongs to.
    let reader_session = session.clone();
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout);
        loop {
            // `Content-Length: N`, then a blank line, then exactly N bytes. Anything else on the
            // way — tsserver prints the occasional bare line — is skipped rather than treated as a
            // framing error, because one stray line must not desynchronise the stream for good.
            let mut length: Option<usize> = None;
            loop {
                let mut header = String::new();
                match reader.read_line(&mut header).await {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(_) => return,
                }
                let trimmed = header.trim();
                if trimmed.is_empty() {
                    if length.is_some() {
                        break;
                    }
                    continue;
                }
                if let Some(value) = trimmed.strip_prefix("Content-Length:") {
                    length = value.trim().parse::<usize>().ok();
                }
            }
            let Some(size) = length else { continue };
            let mut body = vec![0u8; size];
            if reader.read_exact(&mut body).await.is_err() {
                return;
            }
            let Ok(message) = serde_json::from_slice::<Value>(&body) else { continue };

            // Only responses carry `request_seq`; events are dropped. Diagnostics arrive as events
            // and are not wired yet — see the note in `lib/tsserver.ts` — and dropping them costs
            // nothing until they are.
            if message.get("type").and_then(Value::as_str) != Some("response") {
                continue;
            }
            let Some(seq) = message.get("request_seq").and_then(Value::as_i64) else { continue };
            if let Ok(mut pending) = reader_session.pending.lock() {
                if let Some(tx) = pending.remove(&seq) {
                    let _ = tx.send(message);
                }
            }
        }
    });

    if let Ok(mut guard) = slot().lock() {
        *guard = Some(session);
    }
    Ok(script.to_string_lossy().to_string())
}

/// A request that expects an answer.
#[tauri::command]
pub async fn ts_request(command: String, arguments: Value) -> Result<Value, String> {
    let session = current().ok_or("tsserver is not running")?;
    let seq = session.next_seq.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    session
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(seq, tx);

    let payload = json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments });
    session
        .outbound
        .send(payload.to_string())
        .map_err(|_| "tsserver is not running".to_string())?;

    let answer = match tokio::time::timeout(std::time::Duration::from_secs(TIMEOUT_SECS), rx).await {
        Ok(Ok(value)) => value,
        // Both failures leave a row in `pending` that will never be taken, so it is removed here
        // rather than left to accumulate one entry per timed-out keystroke.
        _ => {
            let _ = session.pending.lock().map(|mut p| p.remove(&seq));
            return Err(format!("tsserver did not answer `{command}`"));
        }
    };

    if answer.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(answer
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("tsserver refused the request")
            .to_string());
    }
    Ok(answer.get("body").cloned().unwrap_or(Value::Null))
}

/// A message tsserver never replies to — `open`, `change`, `close`, `updateOpen`.
///
/// Its own command because awaiting these through `ts_request` would block for the full timeout on
/// every keystroke: there is no response coming, and the absence is correct rather than a fault.
#[tauri::command]
pub async fn ts_notify(command: String, arguments: Value) -> Result<(), String> {
    let session = current().ok_or("tsserver is not running")?;
    let seq = session.next_seq.fetch_add(1, Ordering::Relaxed);
    let payload = json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments });
    session
        .outbound
        .send(payload.to_string())
        .map_err(|_| "tsserver is not running".to_string())?;
    Ok(())
}

/// Whether a server is up, and for which repository — what the editor asks before wiring providers.
#[tauri::command]
pub fn ts_status() -> Option<String> {
    current().map(|session| session.root.clone())
}

#[tauri::command]
pub async fn ts_stop() {
    let session = { slot().lock().ok().and_then(|mut guard| guard.take()) };
    let Some(session) = session else { return };
    // Every waiter is dropped with the session, so a request in flight resolves as "ended before
    // replying" instead of waiting out its timeout against a process that is gone.
    if let Ok(mut pending) = session.pending.lock() {
        pending.clear();
    }
    let child = session.child.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        let _ = child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_typescript_only_where_it_is_installed() {
        // This repository has TypeScript as a dev dependency, so its own root is a positive case
        // that does not depend on a fixture existing.
        let root = env!("CARGO_MANIFEST_DIR");
        let repo = Path::new(root).parent().expect("src-tauri has a parent");
        assert!(tsserver_script(&repo.to_string_lossy()).is_some());
        assert!(tsserver_script("/definitely/not/a/project").is_none());
    }
}
