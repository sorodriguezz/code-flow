//! The repository map as MCP tools for the CLI agents CodeFlow runs — Claude Code and Codex get
//! `find_symbol`, `find_usages`, `file_outline` and `project_map` beside their own Grep and Read.
//!
//! **Streamable HTTP at `/mcp/code` on the webhook port**, the same server and the same plain-JSON
//! answers as the Flujos tools (`flows::mcp`), so nothing is spawned per run and nothing is
//! installed. Each run that gets the server gets its **own bearer token**, bound to that run's
//! repository: the token is the only way a request names a repository, so a client can read the
//! map of the folder its run works in and of nothing else. The token dies with the run ([`Grant`]).
//! A request that came through a public tunnel is refused — this is for agents on this machine.
//!
//! Read-only by construction: every tool is a query over the map. That is why a read-only run (a
//! review, a chat in plan mode) gets it too — it is the one server such a run may load.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use crate::mcp_registry::LiveServer;

/// The server's name in a run's MCP config — and so the `mcp__codeflow_map__…` prefix of its tools.
pub const SERVER_NAME: &str = "codeflow_map";
pub const PATH: &str = "/mcp/code";
const PROTOCOL: &str = "2025-06-18";
const SUPPORTED: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// Characters of the project map a client is sent.
const MAP_CHARS: usize = 12_000;

static RUNS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A run's access to the map of its repository. Dropping it revokes the token.
pub struct Grant {
    token: String,
}

impl Drop for Grant {
    fn drop(&mut self) {
        if let Ok(mut runs) = RUNS.lock() {
            runs.remove(&self.token);
        }
    }
}

/// The server entry for a run in `root`, and the grant that keeps it valid — `None` when the
/// webhook server cannot listen (its port is taken), in which case the run simply goes without.
pub fn for_run(root: &str) -> Option<(LiveServer, Grant)> {
    let app = crate::ai_usage::app()?;
    crate::flows::triggers::webhook::ensure_server(app).ok()?;
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    RUNS.lock().ok()?.insert(token.clone(), root.to_string());
    let server = LiveServer {
        name: SERVER_NAME.to_string(),
        transport: "http".to_string(),
        command: String::new(),
        args: Vec::new(),
        env: Vec::new(),
        url: format!("http://127.0.0.1:{}{PATH}", crate::flows::triggers::webhook::port()),
        headers: vec![("Authorization".to_string(), format!("Bearer {token}"))],
    };
    Some((server, Grant { token }))
}

/// Where an Antigravity (`agy`) run finds the map: a workspace plugin, the one place besides the
/// user's global config that agy reads MCP servers from.
const AGY_PLUGIN: &str = ".agents/plugins/codeflow-map";

/// Repositories with a live agy plugin: how many runs hold it, and the token in its URL.
static AGY_RUNS: LazyLock<Mutex<HashMap<std::path::PathBuf, (usize, String)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// An agy run's access to the map. The plugin folder goes when the last run in its repository ends.
pub struct AgyGrant {
    root: std::path::PathBuf,
}

impl Drop for AgyGrant {
    fn drop(&mut self) {
        let Ok(mut runs) = AGY_RUNS.lock() else { return };
        let Some(entry) = runs.get_mut(&self.root) else { return };
        entry.0 = entry.0.saturating_sub(1);
        if entry.0 > 0 {
            return;
        }
        let (_, token) = runs.remove(&self.root).unwrap_or_default();
        if let Ok(mut tokens) = RUNS.lock() {
            tokens.remove(&token);
        }
        let plugin = self.root.join(AGY_PLUGIN);
        let _ = std::fs::remove_dir_all(&plugin);
        // The folders above it only if this made them and nothing else lives there.
        if let Some(plugins) = plugin.parent() {
            let _ = std::fs::remove_dir(plugins);
            if let Some(agents) = plugins.parent() {
                let _ = std::fs::remove_dir(agents);
            }
        }
    }
}

/// The map for an agy run in `cwd`: a git-excluded workspace plugin whose MCP config points at this
/// server, the token in the URL.
///
/// agy (Antigravity CLI 1.2) takes no MCP server on its command line — only from
/// `~/.gemini/config/mcp_config.json` or a plugin's `mcp_config.json` — and its Streamable HTTP
/// transport has a `url` and nothing else, no headers. The user's global file is theirs and is
/// never written; a plugin under the repository's own `.agents/` is discovered for that workspace
/// alone, kept out of git through `info/exclude`, and removed when the run ends.
pub fn for_agy(cwd: &str) -> Option<AgyGrant> {
    if crate::ai_usage::setting("codemap_mcp").as_deref() == Some("false") {
        return None;
    }
    let root = std::path::Path::new(cwd).canonicalize().ok()?;
    let repo = git2::Repository::open(&root).ok()?;
    if repo.workdir()?.canonicalize().ok()? != root {
        return None;
    }
    let app = crate::ai_usage::app()?;
    crate::flows::triggers::webhook::ensure_server(app).ok()?;
    let port = crate::flows::triggers::webhook::port();
    install_agy_plugin(&root, port)
}

fn install_agy_plugin(root: &std::path::Path, port: u16) -> Option<AgyGrant> {
    let mut runs = AGY_RUNS.lock().ok()?;
    let entry = runs.entry(root.to_path_buf()).or_insert_with(|| (0, format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())));
    entry.0 += 1;
    let token = entry.1.clone();
    drop(runs);
    RUNS.lock().ok()?.insert(token.clone(), root.to_string_lossy().to_string());
    let grant = AgyGrant { root: root.to_path_buf() };
    let plugin = root.join(AGY_PLUGIN);
    std::fs::create_dir_all(&plugin).ok()?;
    let manifest = json!({
        "name": "codeflow-map",
        "description": "CodeFlow's map of this repository, for this run: where each symbol is declared and which files use it. Written by CodeFlow and removed when the run ends.",
    });
    let config = json!({ "mcpServers": { SERVER_NAME: { "url": format!("http://127.0.0.1:{port}{PATH}/{token}") } } });
    std::fs::write(plugin.join("plugin.json"), serde_json::to_string_pretty(&manifest).ok()?).ok()?;
    std::fs::write(plugin.join("mcp_config.json"), serde_json::to_string_pretty(&config).ok()?).ok()?;
    let _ = crate::git_exclude::exclude(root, &format!("/{AGY_PLUGIN}/"));
    Some(grant)
}

/// The tool-permission rule that lets Claude Code call every tool of the server unasked.
pub fn allow_rule() -> String {
    format!("mcp__{SERVER_NAME}")
}

/// The servers of `servers` a run may load: all of them normally, only this one in a read-only run
/// — it is a query over the map and nothing else, the one server such a run can be given safely.
pub fn loadable(servers: &[LiveServer], read_only: bool) -> Vec<LiveServer> {
    servers.iter().filter(|server| !read_only || server.name == SERVER_NAME).cloned().collect()
}

/// The server for a CLI run in `cwd`, when that is a repository's working tree and the user has
/// not switched it off (Settings › Herramientas de IA › MCP). The grant must outlive the run.
pub fn for_repository(cwd: &str) -> Option<(LiveServer, Grant)> {
    if crate::ai_usage::setting("codemap_mcp").as_deref() == Some("false") {
        return None;
    }
    let root = std::path::Path::new(cwd).canonicalize().ok()?;
    let repo = git2::Repository::open(&root).ok()?;
    let workdir = repo.workdir()?.canonicalize().ok()?;
    if workdir != root {
        return None;
    }
    for_run(&root.to_string_lossy())
}

fn respond(status: StatusCode, value: Option<Value>) -> Response {
    let mut builder = Response::builder().status(status);
    let body = match value {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    builder.body(body).unwrap_or_else(|_| Response::new(Body::empty()))
}

/// The repository a request may read: its bearer token's, or — for a client whose HTTP transport
/// sends no headers (the Antigravity CLI) — the token as the last segment of the path,
/// `/mcp/code/<token>`.
fn root_for(headers: &HeaderMap, path: &str) -> Option<String> {
    let from_header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.trim().strip_prefix("Bearer ").map(|t| t.trim().to_string()));
    let from_path = path.trim_end_matches('/').strip_prefix(PATH).and_then(|rest| rest.strip_prefix('/')).map(str::to_string);
    let token = from_header.or(from_path).filter(|t| !t.is_empty())?;
    RUNS.lock().ok()?.get(&token).cloned()
}

/// Whether a request path is this server's, with or without a token segment.
pub fn serves(path: &str) -> bool {
    let path = path.trim_end_matches('/');
    path == PATH || path.strip_prefix(PATH).is_some_and(|rest| rest.starts_with('/') && !rest[1..].contains('/'))
}

/// One HTTP request to [`PATH`] (or `PATH/<token>`).
pub async fn handle(method: &Method, path: &str, headers: &HeaderMap, body: &Bytes, tunnelled: bool) -> Response {
    if tunnelled {
        return respond(StatusCode::FORBIDDEN, Some(json!({"error": "the code map is only served on this machine"})));
    }
    let Some(root) = root_for(headers, path) else {
        return respond(StatusCode::UNAUTHORIZED, Some(json!({"error": "a run's bearer token is required"})));
    };
    if method != Method::POST {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("allow", "POST")
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    let Ok(message) = serde_json::from_slice::<Value>(body) else {
        return respond(StatusCode::BAD_REQUEST, Some(error_reply(Value::Null, -32700, "parse error")));
    };
    match message {
        Value::Array(batch) => {
            let mut replies = Vec::new();
            for one in batch {
                if let Some(reply) = answer(&root, one).await {
                    replies.push(reply);
                }
            }
            if replies.is_empty() {
                respond(StatusCode::ACCEPTED, None)
            } else {
                respond(StatusCode::OK, Some(Value::Array(replies)))
            }
        }
        one => match answer(&root, one).await {
            Some(reply) => respond(StatusCode::OK, Some(reply)),
            None => respond(StatusCode::ACCEPTED, None),
        },
    }
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn result_reply(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn text_result(id: Value, text: String, error: bool) -> Value {
    result_reply(id, json!({"content": [{"type": "text", "text": text}], "isError": error}))
}

/// Every tool here is a query over the map: no side effects, nothing outside the repository. Said in
/// the protocol's own terms, because a client decides on them — Codex refuses an unannotated MCP
/// call under `approval_policy="never"` ("requires approval"), and a read-only one it runs.
fn read_only(mut tool: Value) -> Value {
    tool["annotations"] = json!({ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false });
    tool
}

pub fn tools() -> Vec<Value> {
    [

        json!({
            "name": "find_symbol",
            "description": "Find where a function, method, class, interface or type is declared in this repository, by name (exact, then prefix). `Class.method` narrows to a member. Returns file:line ranges. Faster and more precise than a text search for a definition.",
            "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "description": "The symbol's name, e.g. applyDiscount or PagoService.pagar"}}, "required": ["name"]},
        }),
        json!({
            "name": "find_usages",
            "description": "List the files that use a symbol, with the line and the enclosing function. Files that only mention a namesake without importing the declaring module are left out. Use it before changing a signature, or to see who depends on something.",
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string", "description": "The symbol's name"},
                "path": {"type": "string", "description": "The file that declares it, when the name is declared in several places. Optional."}
            }, "required": ["name"]},
        }),
        json!({
            "name": "file_outline",
            "description": "A file's declarations with their line ranges (so a Read can jump straight to one), the project files it imports and the files that import it.",
            "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "description": "Path relative to the repository root"}}, "required": ["path"]},
        }),
        json!({
            "name": "project_map",
            "description": "An overview of the repository: its folders, what each file declares (small projects) or the most-used declarations and where they live (large ones).",
            "inputSchema": {"type": "object", "properties": {}},
        }),
    ]
    .into_iter()
    .map(read_only)
    .collect()
}

/// Runs one tool against `root`'s map — shared by the MCP server and anything else that wants the
/// same answers as text.
pub async fn call_tool(root: &str, name: &str, args: &Value) -> Result<String, String> {
    let root = root.to_string();
    let name = name.to_string();
    let args = args.clone();
    tokio::task::spawn_blocking(move || {
        let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let (map, _) = super::snapshot(&root)?;
        match name.as_str() {
            "find_symbol" => {
                let query = text("name");
                Ok(super::summary::symbols_text(&map.find_symbol(&query, 25), &query))
            }
            "find_usages" => {
                let symbol = text("name");
                let path = text("path");
                let report = map.usages(&symbol, (!path.is_empty()).then_some(path.as_str()), 60);
                Ok(super::summary::usages_text(&report, &symbol))
            }
            "file_outline" => {
                let path = text("path");
                map.outline(&path)
                    .map(|outline| super::summary::outline_text(&outline))
                    .ok_or_else(|| format!("{path} is not a code file this map knows (check the path, or it may be generated or ignored)"))
            }
            "project_map" => {
                let all: Vec<String> = map.files.iter().map(|f| f.path.clone()).collect();
                Ok(super::summary::project_map(&map, &all, MAP_CHARS))
            }
            other => Err(format!("no tool called {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn answer(root: &str, message: Value) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Some(match method.as_str() {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL);
            let version = if SUPPORTED.contains(&asked) { asked } else { PROTOCOL };
            result_reply(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "codeflow-map", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": "CodeFlow's map of this repository: where each symbol is declared and which files really use it (imports resolved, namesakes left out). Prefer find_symbol over a text search to locate a definition, and find_usages before changing a signature.",
                }),
            )
        }
        "ping" => result_reply(id, json!({})),
        "tools/list" => result_reply(id, json!({"tools": tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match call_tool(root, name, &args).await {
                Ok(text) => text_result(id, text, false),
                Err(error) => text_result(id, error, true),
            }
        }
        _ => error_reply(id, -32601, &format!("method not found: {method}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_token(root: &str) -> (HeaderMap, Grant) {
        let token = "test-token-".to_string() + &uuid::Uuid::new_v4().simple().to_string();
        RUNS.lock().unwrap().insert(token.clone(), root.to_string());
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        (headers, Grant { token })
    }

    async fn post(headers: &HeaderMap, body: Value) -> (StatusCode, Value) {
        let response = handle(&Method::POST, PATH, headers, &Bytes::from(body.to_string()), false).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn a_token_names_the_repository_and_dies_with_its_run() {
        let dir = std::env::temp_dir().join(format!("codeflow-codemap-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        git2::Repository::init(&dir).unwrap();
        std::fs::write(dir.join("src/pricing.ts"), "export function applyDiscount(p: number) { return p; }\n").unwrap();
        std::fs::write(dir.join("src/cart.ts"), "import { applyDiscount } from './pricing';\nexport const t = applyDiscount(1);\n").unwrap();
        let root = dir.to_string_lossy().to_string();
        let (headers, grant) = with_token(&root);

        let (status, reply) = post(&headers, json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply["result"]["tools"].as_array().unwrap().len(), 4);

        let (_, reply) = post(
            &headers,
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "find_usages", "arguments": {"name": "applyDiscount"}}}),
        )
        .await;
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("src/pricing.ts:1"), "{text}");
        assert!(text.contains("src/cart.ts:1"), "{text}");

        drop(grant);
        let (status, _) = post(&headers, json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "the token went with the run");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_tool_says_it_only_reads() {
        for tool in tools() {
            assert_eq!(tool["annotations"]["readOnlyHint"], true, "{}", tool["name"]);
        }
    }

    #[test]
    fn an_agy_plugin_lives_as_long_as_its_last_run_and_stays_out_of_git() {
        let dir = std::env::temp_dir().join(format!("codeflow-agy-plugin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        let root = dir.canonicalize().unwrap();
        let first = install_agy_plugin(&root, 47811).unwrap();
        let second = install_agy_plugin(&root, 47811).unwrap();
        let config = std::fs::read_to_string(root.join(AGY_PLUGIN).join("mcp_config.json")).unwrap();
        assert!(config.contains("http://127.0.0.1:47811/mcp/code/"), "{config}");
        let exclude = std::fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert!(exclude.contains("/.agents/plugins/codeflow-map/"), "{exclude}");
        drop(first);
        assert!(root.join(AGY_PLUGIN).exists(), "another run still holds it");
        drop(second);
        assert!(!root.join(".agents").exists(), "gone, with the folders it made");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_tunnelled_request_is_refused() {
        let (headers, _grant) = with_token("/tmp");
        let response = handle(&Method::POST, PATH, &headers, &Bytes::from("{}"), true).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_token_in_the_path_works_for_a_client_without_headers() {
        let (_, grant) = with_token("/tmp");
        let path = format!("{PATH}/{}", grant.token);
        assert!(serves(&path) && serves(PATH) && !serves("/mcp") && !serves(&format!("{path}/x")));
        let body = Bytes::from(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}).to_string());
        let response = handle(&Method::POST, &path, &HeaderMap::new(), &body, false).await;
        assert_eq!(response.status(), StatusCode::OK);
        let wrong = handle(&Method::POST, &format!("{PATH}/nope"), &HeaderMap::new(), &body, false).await;
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    }
}

/// Against the real CLIs, so ignored by default — and it spends a little of the user's quota (Claude
/// on Haiku, Codex on its configured model). Serves this module on a free port the way the webhook
/// server does, builds each engine's command with the app's own builder (`build_command` with the
/// server in `app_mcp`, as `ai::run` hands it over), and asserts the CLI loaded the server and
/// called a map tool:
/// `CODEMAP_LIVE_CLI=claude|codex|both cargo test --lib codemap::mcp::live -- --ignored --nocapture --test-threads=1`
#[cfg(test)]
mod live {
    use super::*;
    use crate::ai::{AiEngine, AiInvocation};

    async fn serve() -> u16 {
        async fn route(method: Method, uri: axum::http::Uri, headers: HeaderMap, body: Bytes) -> Response {
            handle(&method, uri.path(), &headers, &body, false).await
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = axum::Router::new().fallback(route);
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        port
    }

    fn write(dir: &std::path::Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codeflow-map-live-{}", uuid::Uuid::new_v4()));
        git2::Repository::init(&dir).unwrap();
        write(&dir, "src/lib/pricing.js", "function applyDiscount(price, percent) {\n  return price - price * percent / 100;\n}\n\nmodule.exports = { applyDiscount };\n");
        write(&dir, "src/cart/cart.js", "const { applyDiscount } = require('../lib/pricing');\n\nfunction cartTotal(items, discount) {\n  const sum = items.reduce((a, i) => a + i.price, 0);\n  return discount ? applyDiscount(sum, discount) : sum;\n}\n\nmodule.exports = { cartTotal };\n");
        write(&dir, "src/checkout/checkout.js", "const { cartTotal } = require('../cart/cart');\n\nfunction checkout(items) {\n  return cartTotal(items, 10);\n}\n\nmodule.exports = { checkout };\n");
        write(&dir, "src/legacy/old.js", "// A namesake: not the shared helper.\nfunction applyDiscount(x) {\n  return x;\n}\nmodule.exports = { applyDiscount };\n");
        dir.canonicalize().unwrap()
    }

    const PROMPT: &str = "Use the codeflow_map tools (find_symbol, find_usages) to answer: where is the applyDiscount that src/cart/cart.js uses declared, and which files use it? Answer in one short paragraph.";

    struct Run {
        stdout: String,
        stderr: String,
    }

    async fn run(engine: &dyn AiEngine, binary: &str, model: &str, root: &str, port: u16, read_only: bool) -> Run {
        let (server, _grant) = {
            let token = format!("live-{}", uuid::Uuid::new_v4().simple());
            RUNS.lock().unwrap().insert(token.clone(), root.to_string());
            let server = LiveServer {
                name: SERVER_NAME.to_string(),
                transport: "http".to_string(),
                command: String::new(),
                args: Vec::new(),
                env: Vec::new(),
                url: format!("http://127.0.0.1:{port}{PATH}"),
                headers: vec![("Authorization".to_string(), format!("Bearer {token}"))],
            };
            (server, Grant { token })
        };
        let mut inv = AiInvocation::new(PROMPT, "");
        inv.model = model;
        inv.cwd = Some(root);
        inv.read_only = read_only;
        if read_only {
            // What a read-only run is given in the app: the engine's read-only tool set.
            inv.allowed_tools = Box::leak(Box::new(engine.read_only_tools()));
        }
        inv.app_mcp = vec![server];
        let mut cmd = engine.build_command(binary, &inv);
        crate::ai::apply_command_path(&mut cmd);
        cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        eprintln!("$ {binary} {}", cmd.as_std().get_args().map(|a| a.to_string_lossy().to_string()).collect::<Vec<_>>().join(" "));
        // What `ai::spawn_once` writes: Codex takes its whole brief on stdin.
        let payload = engine.stdin_payload(&inv);
        let mut child = cmd.spawn().expect("the CLI started");
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(payload.as_bytes()).await;
        }
        let output = tokio::time::timeout(std::time::Duration::from_secs(240), child.wait_with_output()).await.expect("the CLI took over 4 minutes").expect("the CLI ran");
        drop(inv);
        Run { stdout: String::from_utf8_lossy(&output.stdout).to_string(), stderr: String::from_utf8_lossy(&output.stderr).to_string() }
    }

    fn wanted(cli: &str) -> bool {
        std::env::var("CODEMAP_LIVE_CLI").is_ok_and(|v| v == cli || v == "both")
    }

    #[tokio::test]
    #[ignore]
    async fn claude_code_loads_the_map_and_calls_it() {
        if !wanted("claude") {
            return;
        }
        let dir = repo();
        let root = dir.to_string_lossy().to_string();
        let port = serve().await;
        for read_only in [false, true] {
            let out = run(&crate::claude::ClaudeEngine, "claude", "haiku", &root, port, read_only).await;
            let init = out.stdout.lines().find(|l| l.contains("\"subtype\":\"init\"")).unwrap_or_default();
            let status: Vec<String> = serde_json::from_str::<Value>(init)
                .ok()
                .and_then(|v| v["mcp_servers"].as_array().cloned())
                .unwrap_or_default()
                .iter()
                .map(|s| format!("{}={}", s["name"].as_str().unwrap_or("?"), s["status"].as_str().unwrap_or("?")))
                .collect();
            let calls: Vec<String> = out
                .stdout
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .filter(|v| v["type"] == "assistant")
                .flat_map(|v| v["message"]["content"].as_array().cloned().unwrap_or_default())
                .filter(|c| c["type"] == "tool_use")
                .map(|c| format!("{} {}", c["name"].as_str().unwrap_or("?"), c["input"]))
                .collect();
            let answer = out
                .stdout
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .find(|v| v["type"] == "result")
                .map(|v| v["result"].as_str().unwrap_or_default().to_string())
                .unwrap_or_default();
            eprintln!("\n[claude read_only={read_only}] servers: {status:?}\n  calls: {calls:#?}\n  answer: {answer}\n  stderr: {}", out.stderr.trim());
            assert!(status.iter().any(|s| s == "codeflow_map=connected"), "the server did not connect: {status:?}");
            assert!(calls.iter().any(|c| c.starts_with("mcp__codeflow_map__")), "no map tool was called: {calls:?}");
            assert!(answer.contains("src/lib/pricing.js"), "{answer}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// agy has no MCP flag: the map arrives as the run's workspace plugin, as `ai::run` installs it —
    /// only for a run that skips agy's permission prompts. Measured 2026-10-10 on agy with
    /// gemini-3.8-flash-low: such a run called find_symbol/find_usages and answered right; a read-only
    /// one had the call denied ("a tool required the \"mcp\" permission that headless mode cannot
    /// prompt for") and replied with nothing, which is why read-only runs get no plugin.
    #[tokio::test]
    #[ignore]
    async fn agy_loads_the_map_and_calls_it() {
        if !wanted("agy") {
            return;
        }
        let dir = repo();
        let root = dir.to_string_lossy().to_string();
        let port = serve().await;
        let model = std::env::var("CODEMAP_LIVE_AGY_MODEL").unwrap_or_else(|_| "gemini-3.8-flash-low".to_string());
        for read_only in [false] {
            let grant = install_agy_plugin(&dir, port).expect("plugin written");
            let mut inv = AiInvocation::new(PROMPT, "");
            inv.model = &model;
            inv.cwd = Some(&root);
            inv.read_only = read_only;
            inv.auto_approve_edits = !read_only;
            let engine = crate::gemini::GeminiEngine;
            let mut cmd = engine.build_command("agy", &inv);
            crate::ai::apply_command_path(&mut cmd);
            cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
            eprintln!("$ agy {}", cmd.as_std().get_args().map(|a| a.to_string_lossy().to_string()).collect::<Vec<_>>().join(" "));
            let output = tokio::time::timeout(std::time::Duration::from_secs(240), cmd.output()).await.expect("under 4 minutes").expect("agy ran");
            drop(grant);
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let mentions: Vec<&str> = stdout.lines().filter(|l| l.contains("codeflow_map") || l.contains("find_symbol") || l.contains("find_usages")).collect();
            eprintln!("\n[agy read_only={read_only}] map lines: {mentions:#?}\n  last lines:\n{}\n  stderr: {}", stdout.lines().rev().take(4).collect::<Vec<_>>().join("\n"), String::from_utf8_lossy(&output.stderr).lines().rev().take(8).collect::<Vec<_>>().join("\n"));
            assert!(!dir.join(AGY_PLUGIN).exists(), "the plugin went with the run");
            let called = stdout.lines().any(|l| l.contains("\"call_mcp_tool\"") && l.contains("\"state\":\"DONE\"") && l.contains("codeflow_map"));
            assert!(called, "no map tool call completed");
            let answer = stdout
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .find(|v| v["event"] == "result")
                .and_then(|v| v["result"]["response"].as_str().map(str::to_string))
                .unwrap_or_default();
            assert!(answer.contains("pricing.js"), "{answer}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[ignore]
    async fn codex_loads_the_map_and_calls_it() {
        if !wanted("codex") {
            return;
        }
        let dir = repo();
        let root = dir.to_string_lossy().to_string();
        let port = serve().await;
        // The app's own Codex model (`codex_chat_model`): the CLI's config default may not be one a
        // ChatGPT account can use.
        let model = std::env::var("CODEMAP_LIVE_CODEX_MODEL").unwrap_or_else(|_| "gpt-6-luna".to_string());
        let out = run(&crate::codex::CodexEngine, "codex", &model, &root, port, false).await;
        let events: Vec<Value> = out.stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect();
        let calls: Vec<String> = events
            .iter()
            .filter(|v| v["item"]["type"] == "mcp_tool_call")
            .map(|v| format!("{} {}", v["type"].as_str().unwrap_or("?"), v["item"]))
            .collect();
        let answer: String = events
            .iter()
            .filter(|v| v["item"]["type"] == "agent_message")
            .filter_map(|v| v["item"]["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        eprintln!("\n[codex] calls: {calls:#?}\n  answer: {answer}\n  stderr: {}", out.stderr.lines().rev().take(15).collect::<Vec<_>>().join("\n"));
        assert!(
            calls.iter().any(|c| c.starts_with("item.completed") && c.contains("cf_codeflow_map") && c.contains("\"status\":\"completed\"")),
            "no map tool call completed: {calls:?}\nstdout: {}",
            out.stdout
        );
        assert!(answer.contains("src/lib/pricing.js"), "{answer}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
