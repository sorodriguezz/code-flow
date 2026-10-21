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
//! # TypeScript 7 has no tsserver
//!
//! 7.0 is the native port: one executable per platform, no `tsserver.js` and no JavaScript API. Its
//! language service is that executable run with `--lsp --stdio`, which is LSP, so a project on 7 is
//! not served here at all — [`ts_start`] answers [`Started::Native`] with the executable, and the
//! editor starts it through `lsp.rs` like any other language server. Looking only for `tsserver.js`
//! answered such a project "No TypeScript in node_modules", which was false, and left it with the
//! isolated Monaco worker that knows nothing of the project.
//!
//! # Framing
//!
//! Requests go out as one JSON object per line. Replies come back LSP-style, `Content-Length` header
//! then the body, and the two directions are deliberately not symmetric — that is tsserver's
//! protocol, not a choice made here.
//!
//! Notifications (`open`, `change`, `close`) get **no reply at all**, which is why they have their
//! own entry point: awaiting a response for one would hang until the session died.
//!
//! # Events
//!
//! Almost everything tsserver says unprompted is dropped. The exception is diagnostics: `geterr`
//! and `geterrForProject` answer *only* with events — one `syntaxDiag`/`semanticDiag`/
//! `suggestionDiag` per file, then `requestCompleted` — and those are what the Problems panel lists
//! for files nobody has open. They go out as `tsserver:event`, tagged with the repository the
//! session belongs to, so a window looking at another repository can tell them apart.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
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
    /// The `tsserver.js` it runs — handed back again when `start` keeps this session.
    script: String,
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
///
/// Searched up the folders above the repository too, and not only in its own `node_modules`. A
/// package of a monorepo opened on its own — `packages/api`, `apps/web` — has its TypeScript
/// installed once at the workspace root, which is where pnpm and npm workspaces put it; looking
/// only at the folder that was opened answered "no TypeScript here" for the arrangement most
/// repositories this app opens actually use. The walk stops at the first hit, so a package that
/// does pin its own compiler still wins over the root's — whichever kind it is.
fn find_compiler(root: &str) -> Option<Compiler> {
    let mut dir = Some(Path::new(root));
    // A handful of levels: enough for `apps/web` or `packages/x/y`, and not a walk to the drive root.
    for _ in 0..6 {
        let at = dir?;
        let package = at.join("node_modules").join("typescript");
        let script = package.join("lib").join("tsserver.js");
        if script.exists() {
            return Some(Compiler::Server(script));
        }
        if let Some(manifest) = manifest_of(&package) {
            if let Some(script) = compatibility_server(&package, &manifest) {
                return Some(Compiler::Server(script));
            }
            if let Some(version) = native_version(&manifest) {
                return Some(Compiler::Native { executable: native_executable(&package), version });
            }
        }
        dir = at.parent();
    }
    None
}

/// The TypeScript a repository builds with, by how the editor has to talk to it.
#[derive(Debug, PartialEq)]
enum Compiler {
    /// TypeScript 6 or earlier: its `tsserver.js`, run here.
    Server(PathBuf),
    /// TypeScript 7 or later. `executable` is `None` when the package is installed and its
    /// platform package — the one holding the binary — is not.
    Native { executable: Option<PathBuf>, version: String },
}

fn manifest_of(package: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(package.join("package.json")).ok()?).ok()
}

/// The version of a `typescript` package that is the native port — 7 or later.
fn native_version(manifest: &Value) -> Option<String> {
    let version = manifest.get("version")?.as_str()?;
    let major: u32 = version.split('.').next()?.parse().ok()?;
    (major >= 7).then(|| version.to_string())
}

/// `typescript` aliased to `@typescript/typescript6`, the package TypeScript 7 ships for the tools
/// that still need 6's API. It keeps 6 in a dependency of its own (`@typescript/old`), and the
/// `tsserver.js` is there rather than in the package `node_modules/typescript` names.
fn compatibility_server(package: &Path, manifest: &Value) -> Option<PathBuf> {
    if manifest.get("name")?.as_str()? != "@typescript/typescript6" {
        return None;
    }
    resolve_beside(package, &["@typescript", "old", "lib", "tsserver.js"])
}

/// Where the native port keeps its executable: `@typescript/typescript-<platform>-<arch>/lib/tsc`,
/// an optional dependency of `typescript` installed for this machine only. The same lookup the
/// package's own `getExePath` makes, under Node's names for the platform.
fn native_executable(package: &Path) -> Option<PathBuf> {
    let (name, file) = native_package()?;
    resolve_beside(package, &["@typescript", &name, "lib", file])
}

/// `typescript-<platform>-<arch>` for this machine, and the executable's file name in it.
fn native_package() -> Option<(String, &'static str)> {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        "freebsd" => "freebsd",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "arm" => "arm",
        _ => return None,
    };
    Some((format!("typescript-{platform}-{arch}"), if cfg!(windows) { "tsc.exe" } else { "tsc" }))
}

/// A file of another package, found the way Node would find it from inside `package`.
///
/// From where the package really is, not where `node_modules` links it from: pnpm links
/// `node_modules/typescript` into its store and installs the package's own dependencies beside it
/// there, which the top level does not have. Every folder above is tried, skipping the
/// `node_modules` folders themselves, as Node does.
fn resolve_beside(package: &Path, parts: &[&str]) -> Option<PathBuf> {
    let real = dunce::canonicalize(package).ok()?;
    real.ancestors()
        .filter(|dir| dir.file_name().is_some_and(|name| name != "node_modules"))
        .map(|dir| parts.iter().fold(dir.join("node_modules"), |path, part| path.join(part)))
        .find(|path| path.is_file())
}

/// What [`ts_start`] started, or found to start elsewhere.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Started {
    /// tsserver is up; `script` is the `tsserver.js` answering — "which TypeScript is this" is the
    /// first question when an answer looks wrong.
    Server { script: String },
    /// TypeScript 7: nothing was started here. `executable` is its language server, for the editor
    /// to start over LSP.
    Native { executable: String, version: String },
}

/// The `node` to run `tsserver.js` with.
///
/// `Command::new("node")` resolves against the `PATH` *this process* was started with, and a GUI
/// app on Windows or macOS is started by the desktop shell, not by a terminal — so a Node installed
/// through nvm, fnm or Volta, whose `PATH` entry is written by a shell profile, is simply not there.
/// The spawn then fails with "program not found" and the editor quietly has no diagnostics at all.
/// `scaffold::tools` already resolves programs the way the user's own shell would (and caches it),
/// so the lookup is shared with the rest of the app rather than re-invented here. Falls back to the
/// bare name, which is still right whenever the inherited `PATH` does name Node.
fn node_program() -> PathBuf {
    let path = crate::scaffold::tools::current_path(false);
    crate::scaffold::tools::which_in(&path, "node").unwrap_or_else(|| PathBuf::from("node"))
}

/// What the reader does with one message off the wire.
#[derive(Debug, PartialEq)]
enum Route {
    /// The answer to a request: resolves whoever is waiting on that `seq`.
    Response(i64),
    /// An event worth forwarding to the editor, by name.
    Event(String),
    /// Everything else — progress, telemetry, `projectLoadingStart`, stray lines.
    Drop,
}

/// The events the editor listens for — the diagnostics `geterr` and `geterrForProject` produce,
/// and the marker that says a batch of them is complete. Kept to these on purpose: tsserver is
/// chatty (`typingsInstallerPid`, `projectsUpdatedInBackground`, telemetry), and every forwarded
/// event is an IPC hop into every window.
const FORWARDED_EVENTS: [&str; 4] = ["syntaxDiag", "semanticDiag", "suggestionDiag", "requestCompleted"];

fn route(message: &Value) -> Route {
    match message.get("type").and_then(Value::as_str) {
        Some("response") => match message.get("request_seq").and_then(Value::as_i64) {
            Some(seq) => Route::Response(seq),
            None => Route::Drop,
        },
        Some("event") => match message.get("event").and_then(Value::as_str) {
            Some(name) if FORWARDED_EVENTS.contains(&name) => Route::Event(name.to_string()),
            _ => Route::Drop,
        },
        _ => Route::Drop,
    }
}

/// Starts the server for a repository, reusing the one already running for it — or, for a project
/// on TypeScript 7, starts nothing and says where its own language server is (see the module note).
#[tauri::command]
pub async fn ts_start(app: AppHandle, repo_path: String) -> Result<Started, String> {
    // Already serving this repository. Restarting would throw away a loaded project — seconds of
    // work — to arrive at the same place.
    if let Some(existing) = current() {
        if existing.root == repo_path {
            return Ok(Started::Server { script: existing.script.clone() });
        }
    }
    ts_stop().await;

    // Blocking, both of them: `find_compiler` stats a few folders and `node_program` can ask a
    // login shell for its `PATH`. Off the async runtime rather than on a worker thread it would
    // hold for as long as that shell takes to start.
    let repo = repo_path.clone();
    let compiler = tokio::task::spawn_blocking(move || find_compiler(&repo))
        .await
        .map_err(|e| e.to_string())?;
    let script = match compiler {
        Some(Compiler::Server(script)) => script,
        Some(Compiler::Native { executable: Some(executable), version }) => {
            return Ok(Started::Native { executable: executable.to_string_lossy().to_string(), version });
        }
        Some(Compiler::Native { executable: None, version }) => {
            return Err(format!(
                "TypeScript {version} is installed without its executable for this computer (the @typescript/typescript-<platform> package) — reinstall the project's dependencies"
            ));
        }
        None => {
            return Err(format!(
                "No TypeScript in {repo_path}/node_modules, nor in the folders above it — install it to get diagnostics and completions"
            ));
        }
    };
    let node = tokio::task::spawn_blocking(node_program).await.map_err(|e| e.to_string())?;

    // `proc::command`, not `Command::new`: on Windows every console child this app starts gets
    // its own `conhost` window unless `CREATE_NO_WINDOW` is set, and `node` is a console binary.
    // Starting a TypeScript project flashed a black window on screen every time. See `proc.rs`,
    // whose whole reason for existing is that a spawn site added later must not be able to
    // reintroduce this by forgetting the flag.
    let mut child = crate::proc::command(&node)
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
        .map_err(|e| format!("Could not start tsserver with {}: {e}", node.display()))?;

    let stdin = child.stdin.take().ok_or("tsserver gave no stdin")?;
    let stdout = child.stdout.take().ok_or("tsserver gave no stdout")?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let session = Arc::new(Session {
        outbound: tx,
        next_seq: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
        child: Mutex::new(Some(child)),
        root: repo_path.clone(),
        script: script.to_string_lossy().to_string(),
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

    // Reader. Resolves whichever request each response belongs to, and forwards the diagnostics
    // events (see the module note).
    let reader_session = session.clone();
    let reader_root = repo_path.clone();
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

            match route(&message) {
                Route::Response(seq) => {
                    if let Ok(mut pending) = reader_session.pending.lock() {
                        if let Some(tx) = pending.remove(&seq) {
                            let _ = tx.send(message);
                        }
                    }
                }
                Route::Event(name) => {
                    let _ = app.emit(
                        "tsserver:event",
                        json!({
                            "root": reader_root,
                            "event": name,
                            "body": message.get("body").cloned().unwrap_or(Value::Null),
                        }),
                    );
                }
                Route::Drop => {}
            }
        }
    });

    let started = Started::Server { script: session.script.clone() };
    if let Ok(mut guard) = slot().lock() {
        *guard = Some(session);
    }
    Ok(started)
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

/// A message tsserver never replies to — `open`, `change`, `close`, `updateOpen` — or replies to
/// only with events: `geterr` and `geterrForProject`.
///
/// Its own command because awaiting these through `ts_request` would block for the full timeout on
/// every keystroke: there is no response coming, and the absence is correct rather than a fault.
///
/// Answers with the message's `seq`, which is what the `requestCompleted` event names when a
/// `geterr` batch is done — the one way to know a project-wide check has finished.
#[tauri::command]
pub async fn ts_notify(command: String, arguments: Value) -> Result<i64, String> {
    let session = current().ok_or("tsserver is not running")?;
    let seq = session.next_seq.fetch_add(1, Ordering::Relaxed);
    let payload = json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments });
    session
        .outbound
        .send(payload.to_string())
        .map_err(|_| "tsserver is not running".to_string())?;
    Ok(seq)
}

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
        assert!(find_compiler(&repo.to_string_lossy()).is_some());
        assert!(find_compiler("/definitely/not/a/project").is_none());
    }

    /// A scratch folder for one test, removed when the test ends however it ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("cf-ts-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("scratch folder");
            Self(dunce::canonicalize(&root).expect("scratch folder"))
        }

        fn file(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().expect("a parent")).expect("parent folders");
            std::fs::write(&path, contents).expect("fixture file");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn manifest(name: &str, version: &str) -> String {
        format!(r#"{{ "name": "{name}", "version": "{version}" }}"#)
    }

    #[test]
    fn a_workspace_package_is_served_by_the_compiler_at_the_root() {
        // What pnpm and npm workspaces produce: one TypeScript at the root, packages with none of
        // their own. Opening `apps/web` on its own used to answer "no TypeScript here".
        let scratch = Scratch::new("workspace");
        let package = scratch.0.join("apps").join("web").join("src");
        std::fs::create_dir_all(&package).expect("temp package");
        let script = scratch.file("node_modules/typescript/lib/tsserver.js", "");

        assert_eq!(find_compiler(&package.to_string_lossy()), Some(Compiler::Server(script)));
    }

    #[test]
    fn typescript_7_is_its_native_executable_and_not_a_missing_tsserver() {
        // npm's layout: the platform package hoisted beside `typescript`.
        let Some((name, file)) = native_package() else { return };
        let scratch = Scratch::new("native");
        scratch.file("node_modules/typescript/package.json", &manifest("typescript", "7.0.2"));
        let executable = scratch.file(&format!("node_modules/@typescript/{name}/lib/{file}"), "");

        assert_eq!(
            find_compiler(&scratch.0.to_string_lossy()),
            Some(Compiler::Native { executable: Some(executable), version: "7.0.2".into() })
        );
    }

    #[test]
    fn typescript_7_without_its_platform_package_says_so() {
        let scratch = Scratch::new("native-missing");
        scratch.file("node_modules/typescript/package.json", &manifest("typescript", "7.1.0"));
        assert_eq!(
            find_compiler(&scratch.0.to_string_lossy()),
            Some(Compiler::Native { executable: None, version: "7.1.0".into() })
        );
    }

    #[cfg(unix)]
    #[test]
    fn under_pnpm_the_executable_is_found_beside_the_linked_package() {
        // pnpm's layout: `node_modules/typescript` is a link into the store, and the platform
        // package sits next to the real `typescript` there — not at the top level.
        let Some((name, file)) = native_package() else { return };
        let scratch = Scratch::new("pnpm");
        let store = "node_modules/.pnpm/typescript@7.0.2/node_modules";
        scratch.file(&format!("{store}/typescript/package.json"), &manifest("typescript", "7.0.2"));
        let executable = scratch.file(&format!("{store}/@typescript/{name}/lib/{file}"), "");
        std::os::unix::fs::symlink(scratch.0.join(store).join("typescript"), scratch.0.join("node_modules/typescript"))
            .expect("link");

        assert_eq!(
            find_compiler(&scratch.0.to_string_lossy()),
            Some(Compiler::Native { executable: Some(executable), version: "7.0.2".into() })
        );
    }

    #[test]
    fn the_typescript_6_compatibility_package_is_served_by_the_6_it_carries() {
        // `"typescript": "npm:@typescript/typescript6"`, what the TypeScript 7 announcement suggests
        // for tools that need 6's API: the real 6 is its dependency `@typescript/old`.
        let scratch = Scratch::new("compat");
        scratch.file("node_modules/typescript/package.json", &manifest("@typescript/typescript6", "6.0.2"));
        let script = scratch.file("node_modules/@typescript/old/lib/tsserver.js", "");

        assert_eq!(find_compiler(&scratch.0.to_string_lossy()), Some(Compiler::Server(script)));
    }

    #[test]
    fn the_nearest_typescript_wins_whatever_its_kind() {
        // A package of a monorepo pinned to 7, under a root still on 5: the package's own compiler.
        let scratch = Scratch::new("nearest");
        scratch.file("node_modules/typescript/lib/tsserver.js", "");
        scratch.file("apps/web/node_modules/typescript/package.json", &manifest("typescript", "7.0.2"));
        let found = find_compiler(&scratch.0.join("apps/web").to_string_lossy());
        assert!(matches!(found, Some(Compiler::Native { .. })), "{found:?}");
    }

    #[test]
    fn responses_resolve_by_their_request_seq() {
        let message = json!({ "type": "response", "request_seq": 7, "success": true, "body": {} });
        assert_eq!(route(&message), Route::Response(7));
        // A response with no seq has nobody to go to.
        assert_eq!(route(&json!({ "type": "response" })), Route::Drop);
    }

    #[test]
    fn only_the_diagnostics_events_are_forwarded() {
        for name in ["syntaxDiag", "semanticDiag", "suggestionDiag", "requestCompleted"] {
            let message = json!({ "type": "event", "event": name, "body": { "file": "/r/a.ts", "diagnostics": [] } });
            assert_eq!(route(&message), Route::Event(name.to_string()));
        }
        for name in ["projectLoadingStart", "telemetry", "typingsInstallerPid", "projectsUpdatedInBackground"] {
            assert_eq!(route(&json!({ "type": "event", "event": name })), Route::Drop);
        }
        assert_eq!(route(&json!({ "hello": "world" })), Route::Drop);
    }
}
