//! A Language Server Protocol client — the generic half of language intelligence.
//!
//! The editor's own answers stop at the file it has open: Monaco's TypeScript worker type-checks
//! each buffer in isolation (see `monacoSetup.ts`), and `definitions.ts` resolves a symbol by
//! reading imports and grepping. Both are good guesses. A language server is the thing that
//! *knows*, because it reads the project from disk — `tsconfig.json`, `node_modules`, `Cargo.toml`,
//! every sibling file — which a webview cannot do at any price.
//!
//! So this is the same deal as [`crate::dap`], one layer up:
//!
//! | Language | Server | How it's launched |
//! |---|---|---|
//! | Rust | `rust-analyzer` | the binary, on stdio |
//! | Go | `gopls` | `gopls serve` |
//! | C / C++ | `clangd` | the binary, on stdio |
//! | Python | `pyright-langserver` | `npx --package pyright pyright-langserver --stdio` |
//!
//! **TypeScript and JavaScript are deliberately not in that list.** `useTypeScript.ts` drives the
//! project's own `tsserver` through `tsserver.rs`, and an entry here would be a second, worse
//! answer competing with it in the same completion list — see the header of `src/lib/lsp/servers.ts`,
//! which is the catalogue.
//!
//! The server is a separate program the user installs — in VS Code it arrives inside an extension;
//! here it is named in that catalogue and either found on `PATH` or run through an `npx` that
//! refuses to fetch. What this module owns is the
//! protocol, so adding a language is configuration rather than code.
//!
//! **This is transport, not translation.** Requests come in as a method name and a `params` blob
//! and go out as whatever the server replied — the same invariant the API client holds. The
//! LSP↔Monaco mapping lives in `src/lib/lsp/protocol.ts`, next to the Monaco types it maps onto;
//! restating `CompletionItem`, `Hover` and `WorkspaceEdit` in Rust only to serialize them straight
//! back to JSON would buy nothing and drift.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

// The header framing is LSP's own; DAP copied it verbatim. `dap` got here first, which is the
// only reason the parser lives there — sharing it keeps one implementation of the one thing on
// this wire that has ever desynchronized a stream.
use crate::dap::{frame, read_message};

/// How long a request waits before the caller gets an error instead of a hang.
///
/// A language server that is still indexing genuinely takes its time — `rust-analyzer` on a cold
/// cache can spend a minute before it answers anything — but a completion nobody will ever get is
/// worse than a completion that failed, because the editor keeps the request alive and the next
/// keystroke queues behind it.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

struct Session {
    root: String,
    outbound: mpsc::UnboundedSender<String>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    child: Mutex<Option<tokio::process::Child>>,
    /// What this server gets when it asks (`workspace/configuration`). Servers differ on whether
    /// they read configuration from `initializationOptions`, from the notification, or from the
    /// pull request — so it is held here and handed over through all three.
    settings: Value,
}

/// Every running server, keyed by the id the frontend made up (`{projectId}:{serverId}`).
///
/// More than one at a time is the normal case, not the exception: a repo with a Rust backend and a
/// TypeScript frontend runs both, and two open projects double that again. That is the difference
/// from [`crate::dap`], which holds a single slot because a person debugs one thing at a time.
type Registry = Mutex<HashMap<String, Arc<Session>>>;

fn registry() -> &'static Registry {
    static REGISTRY: std::sync::OnceLock<Registry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

fn session(id: &str) -> Option<Arc<Session>> {
    registry().lock().ok()?.get(id).cloned()
}

pub fn is_running(id: &str) -> bool {
    session(id).is_some()
}

impl Session {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.outbound
            .send(payload.to_string())
            .map_err(|_| "the language server is gone".to_string())?;

        let message = match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(message)) => message,
            Ok(Err(_)) => return Err("the language server closed before replying".to_string()),
            Err(_) => {
                // Dropped rather than left behind: a reply that arrives after the timeout has
                // nowhere to go, and the map would otherwise grow one entry per slow request.
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                return Err(format!("'{method}' timed out"));
            }
        };

        if let Some(error) = message.get("error") {
            let text = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the language server rejected the request");
            return Err(text.to_string());
        }
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    }

    fn notify(&self, method: &str, params: Value) {
        let payload = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.outbound.send(payload.to_string());
    }

    /// Answers a request the *server* made of us. Every one of them must be answered, including
    /// the ones we have nothing to say to — a server that asked and never heard back waits, and
    /// several of them do the asking during `initialize`, so the whole session stalls before it
    /// starts.
    fn respond(&self, id: &Value, result: Value) {
        let payload = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        let _ = self.outbound.send(payload.to_string());
    }

    fn respond_unsupported(&self, id: &Value, method: &str) {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("CodeFlow does not implement '{method}'") }
        });
        let _ = self.outbound.send(payload.to_string());
    }
}

/// What this client can do, declared up front.
///
/// Servers gate their behaviour on this rather than sending everything and letting the client
/// cope: omit `snippetSupport` and `typescript-language-server` stops offering the call
/// parentheses; omit `hierarchicalDocumentSymbolSupport` and the outline arrives flat. So this
/// list is not boilerplate — it is the feature set, and anything missing from it is a feature the
/// editor silently will not receive.
fn client_capabilities() -> Value {
    json!({
        "workspace": {
            "applyEdit": false,
            "workspaceFolders": true,
            "configuration": true,
            "didChangeConfiguration": { "dynamicRegistration": false },
            "symbol": { "dynamicRegistration": false }
        },
        "textDocument": {
            "synchronization": {
                "dynamicRegistration": false,
                // The editor sends the whole buffer on every change, unconditionally: the
                // server's own `textDocumentSync` declaration is deliberately not consulted,
                // since incremental sync means tracking the server's idea of the document
                // alongside Monaco's, and the two disagreeing is a class of bug that ends in
                // completions for text that is not on screen. See the Document sync section
                // of `client.ts`.
                "willSave": false,
                "willSaveWaitUntil": false,
                "didSave": true
            },
            "completion": {
                "dynamicRegistration": false,
                "contextSupport": true,
                "completionItem": {
                    "snippetSupport": true,
                    "insertReplaceSupport": true,
                    "documentationFormat": ["markdown", "plaintext"],
                    "labelDetailsSupport": true,
                    "resolveSupport": { "properties": ["documentation", "detail", "additionalTextEdits"] }
                },
                "completionItemKind": { "valueSet": (1..=25).collect::<Vec<i32>>() }
            },
            "hover": { "dynamicRegistration": false, "contentFormat": ["markdown", "plaintext"] },
            "signatureHelp": {
                "dynamicRegistration": false,
                "signatureInformation": {
                    "documentationFormat": ["markdown", "plaintext"],
                    "parameterInformation": { "labelOffsetSupport": true }
                }
            },
            "definition": { "dynamicRegistration": false, "linkSupport": false },
            "typeDefinition": { "dynamicRegistration": false, "linkSupport": false },
            "implementation": { "dynamicRegistration": false, "linkSupport": false },
            "references": { "dynamicRegistration": false },
            "documentHighlight": { "dynamicRegistration": false },
            "documentSymbol": {
                "dynamicRegistration": false,
                "hierarchicalDocumentSymbolSupport": true,
                "symbolKind": { "valueSet": (1..=26).collect::<Vec<i32>>() }
            },
            "formatting": { "dynamicRegistration": false },
            "rangeFormatting": { "dynamicRegistration": false },
            "rename": { "dynamicRegistration": false, "prepareSupport": true },
            "codeAction": {
                "dynamicRegistration": false,
                "codeActionLiteralSupport": {
                    "codeActionKind": {
                        "valueSet": ["quickfix", "refactor", "refactor.extract", "refactor.inline",
                                     "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"]
                    }
                },
                "isPreferredSupport": true,
                "resolveSupport": { "properties": ["edit"] }
            },
            "publishDiagnostics": {
                "relatedInformation": true,
                "versionSupport": true,
                "tagSupport": { "valueSet": [1, 2] }
            }
        },
        "window": { "workDoneProgress": true }
    })
}

/// A `file://` URI for a local path, which is what every server wants and no server will guess.
///
/// Windows is the whole reason this is a function: `C:\repo` has to become `file:///C%3A/repo`,
/// and a server handed `C:\repo` treats the backslashes as part of a single opaque name and
/// reports that the workspace does not exist.
pub fn path_to_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let encoded: String = normalized
        .split('/')
        .map(|segment| {
            segment
                .chars()
                .map(|c| match c {
                    'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
                    other => other
                        .to_string()
                        .as_bytes()
                        .iter()
                        .map(|b| format!("%{b:02X}"))
                        .collect::<String>(),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/");
    if normalized.starts_with('/') {
        format!("file://{encoded}")
    } else {
        // A drive-letter path has no leading slash of its own; the authority is empty, so the
        // third slash is ours to add.
        format!("file:///{encoded}")
    }
}

/// Starts `command args…` as a language server rooted at `root`, and returns what it says it can
/// do — the `capabilities` object the frontend uses to decide which Monaco providers to register.
pub async fn start(
    app: AppHandle,
    session_id: &str,
    root: &str,
    command: &str,
    args: &[String],
    initialization_options: Value,
    settings: Value,
) -> Result<Value, String> {
    // Restarting is the common case (the user reopened the project, or the server died), so an
    // id that is already taken is replaced rather than refused.
    stop(session_id).await;

    let mut child = crate::proc::command(command)
        .args(args)
        .current_dir(root)
        // Everything between here and the registry insert below is `?`: the stdin/stdout takes, and
        // `initialize` itself. Each returns early, dropping this `Child` — and a dropped tokio child
        // keeps running. The session is not in the registry yet, so `stop`, `stop_prefix` and
        // `stop_all` cannot reach it either: a server that fails to initialize would be left running
        // for the life of the app, one orphan per retry. Every other long-lived child in this
        // codebase sets this (`tsserver.rs`, `remotes/sftp.rs`, `datasource/tunnel.rs`).
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch the language server '{command}': {e}"))?;

    let mut stdin = child.stdin.take().ok_or_else(|| "the server has no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "the server has no stdout".to_string())?;
    let stderr = child.stderr.take();

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
        root: root.to_string(),
        outbound,
        next_id: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
        child: Mutex::new(Some(child)),
        settings: settings.clone(),
    });

    // stderr is drained rather than ignored. A pipe nobody reads fills, and the write that fills
    // it blocks the server — `rust-analyzer` and `gopls` are both chatty enough to get there, and
    // the symptom is a server that answers for a while and then stops.
    if let Some(stderr) = stderr {
        let log_app = app.clone();
        let log_id = session_id.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = log_app.emit(
                    "lsp:log",
                    json!({ "session_id": log_id, "level": "stderr", "message": line }),
                );
            }
        });
    }

    let reader_session = Arc::clone(&session);
    let reader_app = app.clone();
    let reader_id = session_id.to_string();
    tokio::spawn(async move {
        let mut stdout = BufReader::new(stdout);
        while let Some(message) = read_message(&mut stdout).await {
            let method = message.get("method").and_then(Value::as_str);
            match (method, message.get("id")) {
                // A reply to something we asked.
                (None, Some(id)) => {
                    let Some(id) = id.as_i64() else { continue };
                    if let Ok(mut pending) = reader_session.pending.lock() {
                        if let Some(tx) = pending.remove(&id) {
                            let _ = tx.send(message);
                        }
                    }
                }
                // A request *from* the server. Answer everything, even with a refusal.
                (Some(method), Some(id)) => {
                    handle_server_request(&reader_session, method, id, &message);
                }
                // A notification.
                (Some(method), None) => {
                    handle_notification(&reader_app, &reader_id, method, &message);
                }
                _ => {}
            }
        }
        // The stream ended: the server exited, was killed, or crashed. Either way the session is
        // no longer usable, and leaving it in the registry would make every later request wait
        // out the full timeout before failing.
        //
        // The requests *already* waiting have to be told too, and dropping their senders is how:
        // each `rx` in `request` then resolves as `Err`, which is the arm that reports "closed
        // before replying". Without this that arm is unreachable — the `Arc<Session>` holding the
        // map outlives the stream, so nothing is dropped and every in-flight call takes the full
        // `REQUEST_TIMEOUT` instead. The one that matters is `initialize`: `start_for_project`
        // awaits it, so a single binary that exits on launch stalled the whole sweep for twenty
        // seconds, during which no server at all was told about an open file.
        if let Ok(mut pending) = reader_session.pending.lock() {
            pending.clear();
        }
        if let Ok(mut registry) = registry().lock() {
            registry.remove(&reader_id);
        }
        let _ = reader_app.emit("lsp:exited", json!({ "session_id": reader_id }));
    });

    let root_uri = path_to_uri(root);
    let capabilities = session
        .request(
            "initialize",
            json!({
                // Real servers branch on this — `typescript-language-server` reads it to decide
                // which commands to expose — but none of them have heard of us, so `processId`
                // and the folder are what actually matter.
                "processId": std::process::id(),
                "clientInfo": { "name": "CodeFlow" },
                "locale": "en",
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
                "initializationOptions": initialization_options,
                "capabilities": client_capabilities(),
            }),
        )
        .await?;

    session.notify("initialized", json!({}));
    // Push configuration as well as answering the pull. Which of the two a server listens to is
    // not something the protocol settles, and the ones that ignore this notification cost nothing
    // by receiving it.
    if !settings.is_null() {
        session.notify("workspace/didChangeConfiguration", json!({ "settings": settings }));
    }

    if let Ok(mut registry) = registry().lock() {
        registry.insert(session_id.to_string(), Arc::clone(&session));
    }

    Ok(capabilities.get("capabilities").cloned().unwrap_or(Value::Null))
}


/// The slice of `settings` one configuration item asked for.
///
/// **A server asks for a named section and expects what is inside it, not the envelope.**
/// `rust-analyzer` asks for `"rust-analyzer"` and, handed back `{"rust-analyzer": {…}}`, finds no
/// key it recognises and runs on defaults — so every `settings` block in the catalogue is
/// decoration until this walks the path. Worse, the reply arrives *after* `initialize`, so a
/// wrongly-shaped one re-applies defaults on top of whatever `initializationOptions` had set.
///
/// The section is a dotted path (`rust-analyzer.cargo.buildScripts`), and an item with no section
/// is asking for the whole object. A path that is not there answers `null`, which is what the
/// protocol says "I have no value for that" looks like.
fn section_of(settings: &Value, item: &Value) -> Value {
    match item.get("section").and_then(Value::as_str) {
        None | Some("") => settings.clone(),
        Some(section) => {
            let mut current = Some(settings);
            for key in section.split('.') {
                current = current.and_then(|value| value.get(key));
            }
            current.cloned().unwrap_or(Value::Null)
        }
    }
}

fn handle_server_request(session: &Session, method: &str, id: &Value, message: &Value) {
    match method {
        // "Tell me my settings." The reply is an array with one entry per requested item, in
        // order — a shape mismatch here is read as "no configuration", and servers that gate
        // features on a setting then quietly run with none.
        "workspace/configuration" => {
            let items = message
                .get("params")
                .and_then(|params| params.get("items"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let answer: Vec<Value> = if items.is_empty() {
                vec![session.settings.clone()]
            } else {
                items.iter().map(|item| section_of(&session.settings, item)).collect()
            };
            session.respond(id, Value::Array(answer));
        }
        "workspace/workspaceFolders" => {
            session.respond(
                id,
                json!([{ "uri": path_to_uri(&session.root), "name": "workspace" }]),
            );
        }
        // Dynamic registration is accepted and then ignored. The frontend registers its Monaco
        // providers unconditionally and reads the static capabilities for exactly one decision —
        // whether a server can answer `textDocument/definition`, which is what stops the
        // text-search fallback standing aside for a server that cannot (see `lspCanDefine`). A
        // server told "no" here would disable features it would otherwise have offered, for
        // nothing.
        "client/registerCapability" | "client/unregisterCapability" => session.respond(id, Value::Null),
        "window/workDoneProgress/create" => session.respond(id, Value::Null),
        // Server-driven edits are declared unsupported in `client_capabilities`, so this should
        // never arrive; a server that sends it anyway gets an honest "no" rather than silence.
        "workspace/applyEdit" => session.respond(id, json!({ "applied": false })),
        "workspace/semanticTokens/refresh"
        | "workspace/codeLens/refresh"
        | "workspace/inlayHint/refresh"
        | "workspace/diagnostic/refresh" => session.respond(id, Value::Null),
        other => session.respond_unsupported(id, other),
    }
}

fn handle_notification(app: &AppHandle, session_id: &str, method: &str, message: &Value) {
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "textDocument/publishDiagnostics" => {
            let _ = app.emit(
                "lsp:diagnostics",
                json!({
                    "session_id": session_id,
                    "uri": params.get("uri").and_then(Value::as_str).unwrap_or_default(),
                    "diagnostics": params.get("diagnostics").cloned().unwrap_or(json!([])),
                }),
            );
        }
        // Indexing progress. `rust-analyzer` spends its first minute here answering nothing
        // useful, which is worth surfacing — but nothing subscribes to it yet (`onLspProgress` in
        // `events.ts` has no consumer), so today it is forwarded and dropped. The cold index is as
        // invisible as it was; a status-bar reader is what would change that.
        "$/progress" => {
            let _ = app.emit("lsp:progress", json!({ "session_id": session_id, "params": params }));
        }
        "window/logMessage" | "window/showMessage" => {
            let _ = app.emit(
                "lsp:log",
                json!({
                    "session_id": session_id,
                    "level": params.get("type").cloned().unwrap_or(json!(3)),
                    "message": params.get("message").and_then(Value::as_str).unwrap_or_default(),
                }),
            );
        }
        _ => {}
    }
}

pub async fn request(session_id: &str, method: &str, params: Value) -> Result<Value, String> {
    let session = session(session_id).ok_or_else(|| format!("no language server '{session_id}'"))?;
    session.request(method, params).await
}

pub fn notify(session_id: &str, method: &str, params: Value) -> Result<(), String> {
    let session = session(session_id).ok_or_else(|| format!("no language server '{session_id}'"))?;
    session.notify(method, params);
    Ok(())
}

pub async fn stop(session_id: &str) {
    let session = registry().lock().ok().and_then(|mut r| r.remove(session_id));
    let Some(session) = session else { return };
    // The protocol's own goodbye: `shutdown` lets the server flush caches it took minutes to
    // build (rust-analyzer's, notably), and `exit` is what it waits for afterwards. Killing it
    // outright throws that away and it re-indexes from cold on the next open.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        session.request("shutdown", Value::Null),
    )
    .await;
    session.notify("exit", Value::Null);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let child = session.child.lock().ok().and_then(|mut c| c.take());
    if let Some(mut child) = child {
        crate::ai_runs::kill_tree(&mut child).await;
    }
}

/// Every session there is — what quitting calls.
///
/// A language server is precisely the kind of child `process::exit` walks straight past: it is a
/// separate process holding an index of the whole repository, which for `rust-analyzer` or `gopls`
/// is several hundred megabytes. Reparented to init it keeps every byte of that, and nothing left
/// running has any way to reap it. Same reasoning as the Remote workspace's `hold::release_all`,
/// and called from the same place.
pub async fn stop_all() {
    let ids: Vec<String> = registry()
        .lock()
        .ok()
        .map(|registry| registry.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        stop(&id).await;
    }
}

/// Every session belonging to a project — what closing a repo calls.
pub async fn stop_prefix(prefix: &str) {
    let ids: Vec<String> = registry()
        .lock()
        .ok()
        .map(|registry| registry.keys().filter(|id| id.starts_with(prefix)).cloned().collect())
        .unwrap_or_default();
    for id in ids {
        stop(&id).await;
    }
}

/// Is this server installed, and which version? The string is shown verbatim beside the language
/// in Settings, the same way [`crate::requirements`] quotes what it found.
pub async fn probe(command: &str, args: &[String]) -> Result<String, String> {
    let output = crate::proc::command(command)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| format!("{command}: {e}"))?;
    // The exit status decides, not whether anything was printed. A tool that reports its version
    // exits 0 — and the case this guards is not hypothetical: `rust-analyzer` installed as a rustup
    // shim without the component behind it prints `error: Unknown binary 'rust-analyzer'` and exits
    // non-zero. Reading "it said something" as "it is there" marks it installed in Settings and
    // then fails at launch, which is a worse answer than "not found".
    if !output.status.success() {
        let complaint = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = complaint.lines().next().unwrap_or("").trim();
        return Err(if detail.is_empty() {
            format!("{command} exited with {}", output.status)
        } else {
            format!("{command}: {detail}")
        });
    }
    // Version on stdout for most, stderr for a few. Some print a banner; the version is its first
    // line.
    let text = if output.stdout.is_empty() { &output.stderr } else { &output.stdout };
    let text = String::from_utf8_lossy(text).trim().to_string();
    Ok(text.lines().next().unwrap_or(&text).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_configuration_item_gets_the_inside_of_its_section() {
        let settings = json!({ "rust-analyzer": { "cargo": { "buildScripts": { "enable": true } } } });
        // What the server asked for is what is *under* the key, not the object containing it.
        assert_eq!(
            section_of(&settings, &json!({ "section": "rust-analyzer" })),
            json!({ "cargo": { "buildScripts": { "enable": true } } })
        );
        // Dotted paths walk all the way down.
        assert_eq!(
            section_of(&settings, &json!({ "section": "rust-analyzer.cargo.buildScripts" })),
            json!({ "enable": true })
        );
    }

    #[test]
    fn an_item_with_no_section_gets_everything_and_a_missing_one_gets_null() {
        let settings = json!({ "gopls": { "usePlaceholders": true } });
        assert_eq!(section_of(&settings, &json!({})), settings);
        // `null`, not the whole blob: answering with everything is how a server ends up reading
        // another server's keys as its own.
        assert_eq!(section_of(&settings, &json!({ "section": "pyright" })), Value::Null);
        assert_eq!(section_of(&settings, &json!({ "section": "gopls.nope.deeper" })), Value::Null);
    }

    #[test]
    fn posix_paths_become_file_uris() {
        assert_eq!(path_to_uri("/home/dev/repo"), "file:///home/dev/repo");
    }

    #[test]
    fn windows_paths_get_the_third_slash_and_an_escaped_colon() {
        // `file://C:/repo` reads `C:` as the *authority* — a hostname — so the path a server
        // receives is `/repo`, which does not exist.
        assert_eq!(path_to_uri("C:\\repo\\app"), "file:///C%3A/repo/app");
    }

    #[test]
    fn separators_survive_and_everything_else_is_escaped() {
        // The slashes stay slashes; the space does not. Encoding the path as one blob would turn
        // the separators into `%2F` and hand the server a single very long file name.
        assert_eq!(path_to_uri("/home/my repo/src"), "file:///home/my%20repo/src");
        assert_eq!(path_to_uri("/home/café/x"), "file:///home/caf%C3%A9/x");
    }

    #[test]
    fn the_frontend_spells_a_path_the_same_way_this_does() {
        // Two functions name the same filesystem: this one builds `rootUri` and the workspace
        // folders, and `fileUriFor` in `protocol.ts` builds every document URI. They disagreed on
        // five characters, because `encodeURIComponent` leaves `!'()*` alone and this does not — so
        // a repo at `~/Documents (work)/api` was announced with `%28work%29` while its buffers
        // arrived with `(work)`, and a server matching workspace membership by URI prefix saw every
        // open file as outside it. The frontend now escapes those five too; this is the guard that
        // says so, since neither side's own tests would notice the two drifting apart again.
        assert_eq!(
            path_to_uri("/Users/john/Documents (work)/api"),
            "file:///Users/john/Documents%20%28work%29/api",
        );
        assert_eq!(path_to_uri("/repo/John's app"), "file:///repo/John%27s%20app");
        assert_eq!(path_to_uri("/repo/a!b*c"), "file:///repo/a%21b%2Ac");
    }

    #[test]
    fn a_missing_binary_reports_the_command_that_was_missing() {
        // The error a user sees when a server is not installed has to name it; "No such file or
        // directory (os error 2)" is the shape of this failure that helps nobody.
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(probe("cf-no-such-language-server", &["--version".into()]))
            .unwrap_err();
        assert!(error.contains("cf-no-such-language-server"), "got: {error}");
    }
}

/// End-to-end against a real server. `clangd` stands in for the whole catalogue: if the protocol
/// works with one server it works with the others, because the server is exactly the part that
/// isn't ours. Skipped when clangd isn't installed.
#[cfg(test)]
mod live_tests {
    use super::*;
    use tokio::io::BufReader;

    fn clangd_available() -> bool {
        std::process::Command::new("clangd")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// The same plumbing [`start`] builds, minus the Tauri handle: a child on stdio, a writer task
    /// and a reader that resolves pending requests.
    async fn connect(root: &str) -> (Arc<Session>, Value) {
        let mut child = crate::proc::command("clangd")
            .current_dir(root)
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
            root: root.to_string(),
            outbound,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(Some(child)),
            settings: Value::Null,
        });

        let reader = Arc::clone(&session);
        tokio::spawn(async move {
            let mut stdout = BufReader::new(stdout);
            while let Some(message) = read_message(&mut stdout).await {
                let method = message.get("method").and_then(Value::as_str);
                match (method, message.get("id")) {
                    (None, Some(id)) => {
                        if let Some(id) = id.as_i64() {
                            if let Some(tx) = reader.pending.lock().unwrap().remove(&id) {
                                let _ = tx.send(message);
                            }
                        }
                    }
                    (Some(method), Some(id)) => handle_server_request(&reader, method, id, &message),
                    _ => {}
                }
            }
        });

        let root_uri = path_to_uri(root);
        let capabilities = session
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "clientInfo": { "name": "CodeFlow" },
                    "rootUri": root_uri,
                    "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
                    "capabilities": client_capabilities(),
                }),
            )
            .await
            .expect("clangd initialized");
        session.notify("initialized", json!({}));
        (session, capabilities)
    }

    #[tokio::test]
    async fn completes_a_member_from_the_buffer_rather_than_from_disk() {
        if !clangd_available() {
            eprintln!("skipping: clangd not installed");
            return;
        }
        let dir = std::env::temp_dir().join(format!("cf-lsp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let file = dir.join("main.cpp");
        // Written empty on purpose. Everything below is sent as buffer text and never saved, so a
        // server reading the path would have nothing to say — which is the difference this whole
        // module exists for.
        std::fs::write(&file, "").unwrap();

        let (session, capabilities) = connect(&root).await;
        let server = capabilities.get("capabilities").expect("a capabilities object");
        assert!(server.get("completionProvider").is_some(), "clangd offers completion");

        let uri = path_to_uri(&file.to_string_lossy());
        let text = "struct Point { int x; int y; };\nint main() { Point p; p.\n";
        session.notify(
            "textDocument/didOpen",
            json!({ "textDocument": { "uri": uri, "languageId": "cpp", "version": 1, "text": text } }),
        );

        // Line 1, character 24 — just past the `p.` on the second line, which is 0-based line 1.
        let answer = session
            .request(
                "textDocument/completion",
                json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": 1, "character": 24 },
                    "context": { "triggerKind": 1 },
                }),
            )
            .await
            .expect("clangd answered");

        let items = answer
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| answer.as_array().cloned())
            .expect("a completion list");
        let labels: Vec<&str> = items.iter().filter_map(|item| item["label"].as_str()).collect();
        // The members of a type declared only in the unsaved buffer.
        assert!(labels.iter().any(|label| label.trim() == "x"), "got: {labels:?}");
        assert!(labels.iter().any(|label| label.trim() == "y"), "got: {labels:?}");

        let _ = session.request("shutdown", Value::Null).await;
        session.notify("exit", Value::Null);
        let child = session.child.lock().unwrap().take();
        drop(child.map(|mut c| c.start_kill()));
        std::fs::remove_dir_all(&dir).ok();
    }
}
