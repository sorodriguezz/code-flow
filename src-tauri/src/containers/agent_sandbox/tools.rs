//! The sandbox as tools of the MCP server CodeFlow serves its CLI agents (`codemap::mcp`): a run whose
//! working tree is a running sandbox's checkout is offered `sandbox_exec`, `sandbox_read_file`,
//! `sandbox_write_file`, `sandbox_logs` and `sandbox_ports`, and they reach **that sandbox and no
//! other** — the binding is the run's own folder, which the server already fixed when the run's token
//! was made, so no argument can name another sandbox. Nothing here hands the agent the engine: every
//! call is one of the broker's operations, recorded as evidence like a command from the window.
//!
//! The file tools work on the checkout from this side (the same folder `/workspace` is), confined
//! to it: `..`, another absolute path, a link that leads out and the checkout's `.git` are refused.
//!
//! **One set of tools, every agent.** The MCP server is how Claude Code, Codex, opencode and Cline
//! reach them, and agy and Grok too — over ACP with their turn's own token, on their CLI with the
//! token written into a file (`codemap::mcp::Access::sandbox_acts` says why that token may still run
//! these two actions). The local agent answers them in-process (`local_agent::tools`). All of them
//! decide with [`offered`] / [`schemas`] and answer with [`call`], so the binding (the run's own
//! folder), the "may act" gate and the evidence are the same code for each.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::Manager;

use super::{spec, store, Sandbox};
use crate::db::Db;

pub const EXEC: &str = "sandbox_exec";
pub const READ_FILE: &str = "sandbox_read_file";
pub const WRITE_FILE: &str = "sandbox_write_file";
pub const LOGS: &str = "sandbox_logs";
pub const PORTS: &str = "sandbox_ports";
const NAMES: [&str; 5] = [EXEC, READ_FILE, WRITE_FILE, LOGS, PORTS];
/// The tools that change something: offered only to a run that may act.
const ACTIONS: [&str; 2] = [EXEC, WRITE_FILE];

const MAX_READ: u64 = 256 * 1024;
const MAX_WRITE: usize = 1024 * 1024;

pub fn is_tool(name: &str) -> bool {
    NAMES.contains(&name)
}

pub fn is_action(name: &str) -> bool {
    ACTIONS.contains(&name)
}

fn db() -> Option<tauri::State<'static, Db>> {
    crate::ai_usage::app()?.try_state::<Db>()
}

/// The running sandbox whose checkout is `root`, the run's working tree.
pub fn bound(root: &str) -> Option<Sandbox> {
    let db = db()?;
    let conn = db.0.lock().ok()?;
    let found = store::running_at(&conn, root).ok().flatten();
    found.or_else(|| {
        let canonical = Path::new(root).canonicalize().ok()?.to_string_lossy().into_owned();
        store::running_at(&conn, &canonical).ok().flatten()
    })
}

/// The names [`schemas`] defines for a run bound to a sandbox, in the same order: the reads, and
/// for a run that may act ([`is_action`]) `sandbox_exec` and `sandbox_write_file` as well.
pub fn offered(acts: bool) -> Vec<&'static str> {
    let mut names = vec![READ_FILE, LOGS, PORTS];
    if acts {
        names.extend([EXEC, WRITE_FILE]);
    }
    names
}

/// The definitions, for a run bound to a sandbox. `acts`: a run that may change things.
pub fn schemas(acts: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": READ_FILE,
            "description": "Read a file of this run's sandbox checkout (/workspace). The path is relative to /workspace or starts with /workspace/.",
            "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "description": "e.g. src/main.ts or /workspace/src/main.ts"}}, "required": ["path"]},
            "annotations": {"readOnlyHint": true},
        }),
        json!({
            "name": LOGS,
            "description": "The sandbox container's log (what its main process printed), its last lines.",
            "inputSchema": {"type": "object", "properties": {"lines": {"type": "integer", "description": "How many of the last lines. Default 200."}}},
            "annotations": {"readOnlyHint": true},
        }),
        json!({
            "name": PORTS,
            "description": "The ports the sandbox publishes on this computer (127.0.0.1), if its network policy allows any.",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true},
        }),
    ];
    if acts {
        tools.push(json!({
            "name": EXEC,
            "description": "Run a command inside this run's isolated sandbox container, in /workspace (this run's checkout): its own limits and network policy, a non-root user, no access to the host. Use it to build and run tests where they cannot touch this computer. Returns the exit code, the duration and the end of stdout/stderr; every command is recorded as evidence for the user.",
            "inputSchema": {"type": "object", "properties": {
                "argv": {"type": "array", "items": {"type": "string"}, "description": "The program and its arguments, e.g. [\"npm\", \"test\"]. For a shell line use [\"sh\", \"-c\", \"…\"]."},
                "command": {"type": "string", "description": "Instead of argv: a command line, split into words like a shell would (no pipes or expansion)."},
                "timeout_s": {"type": "number", "description": "Seconds before it is stopped. Default 120, at most 1800."}
            }},
        }));
        tools.push(json!({
            "name": WRITE_FILE,
            "description": "Write a file of this run's sandbox checkout (/workspace), creating its folders. The path is relative to /workspace or starts with /workspace/.",
            "inputSchema": {"type": "object", "properties": {
                "path": {"type": "string"},
                "content": {"type": "string", "description": "The file's whole new content (at most 1 MB)."}
            }, "required": ["path", "content"]},
        }));
    }
    tools
}

/// `path` under the checkout, refused when it — or the nearest folder of it that exists — leads out.
fn confined(root: &Path, path: &str) -> Result<PathBuf, String> {
    let file = spec::workspace_file(root, path)?;
    let root = root.canonicalize().map_err(|_| "the sandbox's checkout is gone".to_string())?;
    let mut probe = file.clone();
    loop {
        if let Ok(real) = probe.canonicalize() {
            if !real.starts_with(&root) {
                return Err(format!("{path} leads out of /workspace"));
            }
            break;
        }
        if !probe.pop() {
            return Err(format!("{path} is not under /workspace"));
        }
    }
    Ok(file)
}

/// Answers one call for the run whose working tree is `root`.
pub async fn call(root: &str, name: &str, args: &Value, acts: bool) -> Result<String, String> {
    if is_action(name) && !acts {
        return Err(format!("{name} is not available to a run that may not act"));
    }
    let sandbox = bound(root).ok_or_else(|| "no running sandbox is bound to this run (its working tree is not a sandbox's checkout)".to_string())?;
    let db = db().ok_or_else(|| "CodeFlow is not ready yet".to_string())?;
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let checkout = PathBuf::from(&sandbox.worktree_path);
    match name {
        EXEC => {
            let mut argv: Vec<String> = args.get("argv").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            if argv.is_empty() {
                argv = crate::containers::run::split_command(&text("command"))?;
            }
            let timeout = args.get("timeout_s").and_then(Value::as_f64);
            let result = super::exec(&db, &sandbox.id, argv, timeout).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        READ_FILE => {
            let file = confined(&checkout, &text("path"))?;
            let meta = std::fs::metadata(&file).map_err(|_| format!("{} does not exist in /workspace", text("path")))?;
            if !meta.is_file() {
                return Err(format!("{} is not a file", text("path")));
            }
            if meta.len() > MAX_READ {
                return Err(format!("{} is {} KB; read it in the sandbox with sandbox_exec (head, sed -n)", text("path"), meta.len() / 1024));
            }
            let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
            String::from_utf8(bytes).map_err(|_| format!("{} is not text", text("path")))
        }
        WRITE_FILE => {
            let content = text("content");
            if content.len() > MAX_WRITE {
                return Err("the content is larger than 1 MB".into());
            }
            let file = confined(&checkout, &text("path"))?;
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            // Again after the folders exist: one of them could have been a link.
            let file = confined(&checkout, &text("path"))?;
            std::fs::write(&file, content.as_bytes()).map_err(|e| e.to_string())?;
            let shown = file.strip_prefix(&checkout).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| text("path"));
            if let Ok(conn) = db.0.lock() {
                let _ = store::add_evidence(&conn, &sandbox.id, "write", &format!("Wrote /workspace/{shown}"), &json!({"path": shown, "bytes": content.len()}));
            }
            Ok(format!("wrote /workspace/{shown} ({} bytes)", content.len()))
        }
        LOGS => {
            let lines = args.get("lines").and_then(Value::as_u64).map(|n| n.min(10_000) as u32);
            super::logs(&db, &sandbox.id, lines).await
        }
        PORTS => {
            let ports = super::ports(&db, &sandbox.id).await?;
            Ok(if ports.is_empty() { format!("the sandbox publishes no port (network: {})", sandbox.network) } else { serde_json::to_string_pretty(&ports).unwrap_or_default() })
        }
        other => Err(format!("unknown tool {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_actions_are_only_offered_to_a_run_that_may_act() {
        let names = |acts: bool| schemas(acts).into_iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names(false), vec![READ_FILE, LOGS, PORTS]);
        assert_eq!(names(true), vec![READ_FILE, LOGS, PORTS, EXEC, WRITE_FILE]);
        assert!(NAMES.iter().all(|n| is_tool(n)) && !is_tool("containers"));
        for acts in [false, true] {
            assert_eq!(offered(acts), names(acts), "the names and the definitions agree");
            assert_eq!(offered(acts).iter().any(|n| is_action(n)), acts);
        }
    }

    #[tokio::test]
    async fn without_a_bound_sandbox_nothing_runs() {
        let error = call("/nowhere", EXEC, &json!({"argv": ["ls"]}), false).await.unwrap_err();
        assert!(error.contains("may not act"), "{error}");
        assert!(call("/nowhere", LOGS, &json!({}), true).await.unwrap_err().contains("no running sandbox"));
    }

    #[test]
    fn a_link_out_of_the_checkout_is_refused() {
        let root = std::env::temp_dir().join(format!("cf-sbx-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        assert!(confined(&root, "src/new/file.ts").is_ok(), "a file still to be made");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc", root.join("out")).unwrap();
            assert!(confined(&root, "out/passwd").unwrap_err().contains("leads out"));
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
