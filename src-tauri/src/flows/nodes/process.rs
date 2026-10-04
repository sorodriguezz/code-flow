//! Shell, Python, Node, Command and Script — every node that starts a process.
//!
//! **Items in, items out, through the pipes.** The input items go to the process as a JSON array
//! on stdin (one array per run, or a one-item array per item with "for each item"), and what the
//! process prints becomes the output: JSON when stdout is JSON, text otherwise, or one item per line.
//! Python and Node get the array as variables too (`items`, `item`), set before the user's code runs
//! without shifting its line numbers.
//!
//! **Stopping.** Each process is the leader of a process group of its own (`proc::own_process_group`)
//! and is stopped as a tree (`ai_runs::kill_tree`) when the run is stopped or the node's time limit
//! passes — a `npm run build` that spawned a compiler must not keep compiling after Stop. The pids
//! also sit in [`LIVE`] so the quit path can reach any the cancellation did not.
//!
//! Scripts are written to files in the run's work directory and run from there — never passed in
//! argv, where a long script meets the platform's limit and every script shows up in `ps`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};

use super::{flag, pairs, strings, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};

/// The most of one stream kept to read the output from. Past it the process keeps running and its
/// output keeps being drained; only the tail is not kept.
const CAPTURE_LIMIT: usize = 32 * 1024 * 1024;

/// Lines of one stream copied into the run's log; the rest is in the node's output.
const LOGGED_LINES: usize = 2000;

/// The pid (= process group) of every process a flow node is running.
static LIVE: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// The quit path: every process a flow started gets SIGTERM, then SIGKILL once `grace` is up.
/// Blocking; the runs themselves have already been cancelled by the time this is called.
pub fn shutdown(grace: Duration) {
    let pids = || -> Vec<u32> { LIVE.lock().map(|live| live.iter().copied().collect()).unwrap_or_default() };
    for pid in pids() {
        signal(pid, false);
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && !pids().is_empty() {
        std::thread::sleep(Duration::from_millis(25));
    }
    for pid in pids() {
        signal(pid, true);
    }
}

fn signal(pid: u32, kill: bool) {
    #[cfg(unix)]
    {
        // SAFETY: integers only; the pid is the group id (see `proc::own_process_group`), and a
        // group that has gone answers ESRCH, which is fine.
        unsafe { libc::kill(-(pid as i32), if kill { libc::SIGKILL } else { libc::SIGTERM }) };
    }
    #[cfg(windows)]
    {
        let _ = kill;
        let _ = crate::proc::std_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// One process to start.
struct Invocation {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    env: Vec<(String, String)>,
    stdin: Option<Vec<u8>>,
    /// How the error message names it: `bash`, `python3`, `npm run build`.
    label: String,
}

struct Outcome {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    code: Option<i32>,
    truncated: bool,
}

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let each = ctx.node.type_id != "code.script" && ctx.param_str("runFor") == "each";
    let items = ctx.items();
    let mut out = Vec::new();
    if each && !items.is_empty() {
        let resolved = ctx.resolve_each().await?;
        for (index, item) in items.iter().enumerate() {
            let params = &resolved[index.min(resolved.len() - 1)];
            let stdin = serde_json::to_vec(&json!([item.json])).unwrap_or_default();
            let invocation = build(ctx, params, stdin, &[&item.json], index).await?;
            let outcome = run(ctx, invocation.clone_label(), invocation).await?;
            out.extend(read_output(ctx, params, outcome, Some(index))?);
        }
    } else {
        let params = ctx.resolve_once().await?;
        let all: Vec<&Value> = items.iter().map(|item| &item.json).collect();
        let stdin = serde_json::to_vec(&all).unwrap_or_default();
        let invocation = build(ctx, &params, stdin, &all, 0).await?;
        let outcome = run(ctx, invocation.clone_label(), invocation).await?;
        let mut produced = read_output(ctx, &params, outcome, None)?;
        // As many out as in: the n-th came from the n-th.
        if produced.len() == items.len() {
            for (index, item) in produced.iter_mut().enumerate() {
                item.paired = Some(index as u32);
            }
        }
        out = produced;
    }
    Ok(vec![out])
}

impl Invocation {
    fn clone_label(&self) -> String {
        self.label.clone()
    }
}

// ------------------------------------------------------------------------------- building commands

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// The folder a process runs in: the parameter, `~` expanded, else the user's home.
fn working_dir(params: &Value) -> Result<PathBuf, NodeError> {
    let raw = text(params, "cwd").trim().to_string();
    if raw.is_empty() {
        return Ok(home());
    }
    let path = match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        Some(rest) => home().join(rest),
        None if raw == "~" => home(),
        None => PathBuf::from(&raw),
    };
    if !path.is_dir() {
        return Err(NodeError::failed(format!("The folder {} does not exist", path.display())));
    }
    Ok(path)
}

/// A program by name on `PATH` (with Windows' extensions), or as given when it is a path.
fn which(program: &str) -> Option<PathBuf> {
    let candidate = Path::new(program);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }
    let path = std::env::var("PATH").unwrap_or_default();
    crate::scaffold::tools::which_in(&path, program)
}

fn require(program: &str) -> Result<PathBuf, NodeError> {
    which(program).ok_or_else(|| NodeError::failed(format!("{program} was not found on this computer's PATH")))
}

/// Where this node's scripts are written for this attempt.
fn script_dir(ctx: &NodeCtx, index: usize) -> Result<PathBuf, NodeError> {
    let dir = ctx.run.host.work_dir().join(&ctx.node.id).join(format!("{index}"));
    std::fs::create_dir_all(&dir).map_err(|e| NodeError::failed(format!("Could not prepare a work folder: {e}")))?;
    Ok(dir)
}

fn write_file(path: &Path, contents: &str) -> Result<(), NodeError> {
    std::fs::write(path, contents).map_err(|e| NodeError::failed(format!("Could not write {}: {e}", path.display())))
}

fn base_env(ctx: &NodeCtx, params: &Value) -> Vec<(String, String)> {
    let mut env = vec![
        ("CODEFLOW_FLOW_ID".to_string(), ctx.run.flow_id.clone()),
        ("CODEFLOW_RUN_ID".to_string(), ctx.run.run_id.clone()),
        ("CODEFLOW_NODE".to_string(), ctx.node.name.clone()),
    ];
    env.extend(pairs(params, "env"));
    env
}

const PYTHON_PRELUDE: &str = "import json, sys\n\
_cf_raw = sys.stdin.read()\n\
items = json.loads(_cf_raw) if _cf_raw.strip() else []\n\
item = items[0] if items else {}\n\
_cf_path = sys.argv[1]\n\
sys.argv = sys.argv[1:]\n\
with open(_cf_path, encoding='utf-8') as _cf_file:\n    _cf_code = compile(_cf_file.read(), _cf_path, 'exec')\n\
exec(_cf_code, {'__name__': '__main__', '__file__': _cf_path, 'items': items, 'item': item, 'json': json})\n";

fn python_interpreter(params: &Value, cwd: &Path) -> Result<PathBuf, NodeError> {
    let chosen = text(params, "interpreter").trim().to_string();
    if !chosen.is_empty() {
        let path = match chosen.strip_prefix("~/") {
            Some(rest) => home().join(rest).to_string_lossy().into_owned(),
            None => chosen.clone(),
        };
        let relative = cwd.join(&path);
        if relative.is_file() {
            return Ok(relative);
        }
        return require(&path);
    }
    for venv in [".venv", "venv", "env"] {
        let candidate = if cfg!(windows) {
            cwd.join(venv).join("Scripts").join("python.exe")
        } else {
            cwd.join(venv).join("bin").join("python")
        };
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let names: &[&str] = if cfg!(windows) { &["python", "python3", "py"] } else { &["python3", "python"] };
    names
        .iter()
        .find_map(|name| which(name))
        .ok_or_else(|| NodeError::failed("No Python was found: install python3 or name an interpreter"))
}

/// The package manager a folder uses, by its lockfile.
fn package_manager(cwd: &Path) -> &'static str {
    if cwd.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if cwd.join("yarn.lock").is_file() {
        "yarn"
    } else if cwd.join("bun.lockb").is_file() || cwd.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    }
}

async fn build(ctx: &NodeCtx, params: &Value, stdin: Vec<u8>, items: &[&Value], index: usize) -> Result<Invocation, NodeError> {
    let cwd = working_dir(params)?;
    let mut env = base_env(ctx, params);
    let invocation = match ctx.node.type_id.as_str() {
        "code.shell" => {
            let script = text(params, "script");
            if script.trim().is_empty() {
                return Err(NodeError::failed("The script is empty"));
            }
            let mut shell = text(params, "shell");
            if shell.is_empty() || shell == "auto" {
                shell = if cfg!(windows) {
                    if which("pwsh").is_some() { "pwsh".into() } else { "powershell".into() }
                } else if which("bash").is_some() {
                    "bash".into()
                } else {
                    "sh".into()
                };
            }
            if shell == "powershell" && !cfg!(windows) {
                shell = "pwsh".into();
            }
            let dir = script_dir(ctx, index)?;
            let (file, args): (PathBuf, Vec<String>) = match shell.as_str() {
                "pwsh" | "powershell" => {
                    let file = dir.join("script.ps1");
                    let args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]
                        .iter()
                        .map(|s| s.to_string())
                        .chain([file.to_string_lossy().into_owned()])
                        .collect();
                    (file, args)
                }
                "cmd" => {
                    if !cfg!(windows) {
                        return Err(NodeError::failed("cmd is only available on Windows"));
                    }
                    let file = dir.join("script.cmd");
                    (file.clone(), vec!["/D".into(), "/C".into(), file.to_string_lossy().into_owned()])
                }
                _ => {
                    let file = dir.join("script.sh");
                    (file.clone(), vec![file.to_string_lossy().into_owned()])
                }
            };
            write_file(&file, &script)?;
            Invocation { program: require(&shell)?, args, cwd, env, stdin: Some(stdin), label: shell }
        }
        "code.python" => {
            let code = text(params, "code");
            if code.trim().is_empty() {
                return Err(NodeError::failed("The code is empty"));
            }
            let dir = script_dir(ctx, index)?;
            let file = dir.join("main.py");
            write_file(&file, &code)?;
            let program = python_interpreter(params, &cwd)?;
            env.push(("PYTHONUNBUFFERED".into(), "1".into()));
            env.push(("PYTHONIOENCODING".into(), "utf-8".into()));
            let label = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "python".into());
            Invocation {
                program,
                args: vec!["-c".into(), PYTHON_PRELUDE.into(), file.to_string_lossy().into_owned()],
                cwd,
                env,
                stdin: Some(stdin),
                label,
            }
        }
        "code.node" => {
            let code = text(params, "code");
            if code.trim().is_empty() {
                return Err(NodeError::failed("The code is empty"));
            }
            let runtime = match text(params, "runtime").as_str() {
                "deno" => "deno",
                "bun" => "bun",
                _ => "node",
            };
            let typescript = text(params, "language") == "typescript";
            let dir = script_dir(ctx, index)?;
            let main = match (runtime, typescript) {
                (_, false) => "main.mjs",
                ("node", true) => "main.mts",
                (_, true) => "main.ts",
            };
            write_file(&dir.join(main), &code)?;
            let data = serde_json::to_string(items).unwrap_or_else(|_| "[]".into());
            let wrapper = format!(
                "globalThis.items = {data};\nglobalThis.item = globalThis.items[0] ?? {{}};\nawait import(\"./{main}\");\n"
            );
            let entry = dir.join("run.mjs");
            write_file(&entry, &wrapper)?;
            let entry = entry.to_string_lossy().into_owned();
            let args = match (runtime, typescript) {
                ("node", true) => vec!["--experimental-strip-types".into(), "--disable-warning=ExperimentalWarning".into(), entry],
                ("node", false) => vec![entry],
                ("deno", _) => vec!["run".into(), "-A".into(), "--quiet".into(), entry],
                _ => vec!["run".into(), entry],
            };
            Invocation { program: require(runtime)?, args, cwd, env, stdin: Some(stdin), label: runtime.into() }
        }
        "code.command" => {
            let program = text(params, "program").trim().to_string();
            if program.is_empty() {
                return Err(NodeError::failed("Name the program to run"));
            }
            let resolved = match which(&program) {
                Some(path) => path,
                None if cwd.join(&program).is_file() => cwd.join(&program),
                None => return Err(NodeError::failed(format!("{program} was not found on this computer's PATH"))),
            };
            let feed = text(params, "stdin") == "json";
            Invocation {
                program: resolved,
                args: strings(params, "args"),
                cwd,
                env,
                stdin: feed.then_some(stdin),
                label: program,
            }
        }
        "code.script" => {
            let args = strings(params, "args");
            let name = text(params, "name").trim().to_string();
            match text(params, "source").as_str() {
                "file" => {
                    let raw = text(params, "path").trim().to_string();
                    if raw.is_empty() {
                        return Err(NodeError::failed("Name the file to run"));
                    }
                    let path = if Path::new(&raw).is_absolute() { PathBuf::from(&raw) } else { cwd.join(&raw) };
                    if !path.is_file() {
                        return Err(NodeError::failed(format!("{} does not exist", path.display())));
                    }
                    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                    let file = path.to_string_lossy().into_owned();
                    let (program, mut lead): (PathBuf, Vec<String>) = match extension.as_str() {
                        "sh" | "bash" => (require(if which("bash").is_some() { "bash" } else { "sh" })?, vec![file]),
                        "py" => (python_interpreter(&json!({}), &cwd)?, vec![file]),
                        "js" | "mjs" | "cjs" => (require("node")?, vec![file]),
                        "ts" | "mts" => (require("deno").or_else(|_| require("bun"))?, vec!["run".into(), file]),
                        "ps1" => (
                            require(if cfg!(windows) && which("pwsh").is_none() { "powershell" } else { "pwsh" })?,
                            vec!["-NoProfile".into(), "-File".into(), file],
                        ),
                        _ => (path.clone(), vec![]),
                    };
                    lead.extend(args);
                    Invocation { program, args: lead, cwd, env, stdin: None, label: raw }
                }
                source => {
                    if name.is_empty() {
                        return Err(NodeError::failed("Name the script to run"));
                    }
                    let (tool, mut lead) = match source {
                        "make" => ("make", vec![name.clone()]),
                        "mise" => ("mise", vec!["run".to_string(), name.clone()]),
                        _ => {
                            if !cwd.join("package.json").is_file() {
                                return Err(NodeError::failed(format!("{} has no package.json", cwd.display())));
                            }
                            (package_manager(&cwd), vec!["run".to_string(), name.clone()])
                        }
                    };
                    if !args.is_empty() {
                        if tool == "npm" {
                            lead.push("--".into());
                        }
                        lead.extend(args);
                    }
                    let label = format!("{tool} {}", lead.join(" "));
                    Invocation { program: require(tool)?, args: lead, cwd, env, stdin: None, label }
                }
            }
        }
        other => return Err(NodeError::failed(format!("{other} is not a process node"))),
    };
    Ok(invocation)
}

// ------------------------------------------------------------------------------------ running one

async fn pump<R: AsyncRead + Unpin>(
    reader: R,
    stream: LogStream,
    ctx_log: impl Fn(LogStream, &str),
) -> (Vec<u8>, bool) {
    let mut reader = BufReader::new(reader);
    let mut kept = Vec::new();
    let mut truncated = false;
    let mut line = Vec::new();
    let mut logged = 0usize;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if kept.len() + line.len() <= CAPTURE_LIMIT {
                    kept.extend_from_slice(&line);
                } else {
                    truncated = true;
                }
                if logged < LOGGED_LINES {
                    let text = String::from_utf8_lossy(&line);
                    ctx_log(stream, text.trim_end_matches(['\n', '\r']));
                    logged += 1;
                    if logged == LOGGED_LINES {
                        ctx_log(LogStream::Info, "… the rest of this output is in the node's result, not the log");
                    }
                }
            }
        }
    }
    (kept, truncated)
}

async fn run(ctx: &NodeCtx, label: String, invocation: Invocation) -> Result<Outcome, NodeError> {
    let mut command = crate::proc::command(&invocation.program);
    command
        .args(&invocation.args)
        .current_dir(&invocation.cwd)
        .envs(invocation.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(if invocation.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::proc::own_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| NodeError::failed(format!("Could not start {label}: {e}")))?;
    let pid = child.id();
    if let Some(pid) = pid {
        if let Ok(mut live) = LIVE.lock() {
            live.insert(pid);
        }
    }
    let forget = || {
        if let Some(pid) = pid {
            if let Ok(mut live) = LIVE.lock() {
                live.remove(&pid);
            }
        }
    };

    if let (Some(bytes), Some(mut pipe)) = (invocation.stdin, child.stdin.take()) {
        tokio::spawn(async move {
            // A process that does not read its input closes the pipe; that is not an error here.
            let _ = pipe.write_all(&bytes).await;
            let _ = pipe.shutdown().await;
        });
    }
    let host = ctx.run.host.clone();
    let node_id = ctx.node.id.clone();
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let (host_out, id_out) = (host.clone(), node_id.clone());
    let out_task = tokio::spawn(async move { pump(stdout, LogStream::Stdout, move |s, t| host_out.log(&id_out, s, t)).await });
    let err_task = tokio::spawn(async move { pump(stderr, LogStream::Stderr, move |s, t| host.log(&node_id, s, t)).await });

    let status = tokio::select! {
        status = child.wait() => status,
        _ = ctx.cancel.cancelled() => {
            crate::ai_runs::kill_tree(&mut child).await;
            forget();
            out_task.abort();
            err_task.abort();
            return Err(NodeError::Cancelled);
        }
    };
    forget();
    let (stdout, out_cut) = out_task.await.unwrap_or_default();
    let (stderr, err_cut) = err_task.await.unwrap_or_default();
    let status = status.map_err(|e| NodeError::failed(format!("{label} could not be waited for: {e}")))?;
    Ok(Outcome { stdout, stderr, code: status.code(), truncated: out_cut || err_cut })
}

// ----------------------------------------------------------------------------- reading the output

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn read_output(ctx: &NodeCtx, params: &Value, outcome: Outcome, paired: Option<usize>) -> Result<Vec<Item>, NodeError> {
    let stdout = String::from_utf8_lossy(&outcome.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&outcome.stderr).into_owned();
    let code = outcome.code;
    let fail_on_exit = flag(params, "failOnExit");
    if code != Some(0) && fail_on_exit {
        let detail = tail(if stderr.trim().is_empty() { &stdout } else { &stderr }, 6);
        let how = match code {
            Some(code) => format!("exited with code {code}"),
            None => "was ended by a signal".to_string(),
        };
        return Err(NodeError::failed(if detail.is_empty() { format!("The process {how}") } else { format!("The process {how}:\n{detail}") }));
    }
    if outcome.truncated {
        ctx.log(LogStream::Info, "Output past 32 MB was not kept");
    }
    let make = |json: Value| match paired {
        Some(index) => Item::paired(json, index),
        None => Item::new(json),
    };
    let text_item = || make(json!({"stdout": stdout.trim_end(), "stderr": stderr.trim_end(), "exitCode": code}));
    let from_json = |value: Value| -> Vec<Item> {
        match value {
            Value::Array(list) => list
                .into_iter()
                .map(|entry| make(if entry.is_object() { entry } else { json!({"value": entry}) }))
                .collect(),
            Value::Object(_) => vec![make(value)],
            other => vec![make(json!({"value": other}))],
        }
    };
    let mode = text(params, "output");
    match mode.as_str() {
        "text" => Ok(vec![text_item()]),
        "lines" => Ok(stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| make(json!({"line": line})))
            .collect()),
        "json" => {
            let trimmed = stdout.trim();
            if trimmed.is_empty() {
                return Ok(vec![]);
            }
            serde_json::from_str::<Value>(trimmed)
                .map(from_json)
                .map_err(|e| NodeError::failed(format!("The output is not JSON: {e}")))
        }
        _ => {
            let trimmed = stdout.trim();
            match serde_json::from_str::<Value>(trimmed) {
                Ok(value @ (Value::Array(_) | Value::Object(_))) => Ok(from_json(value)),
                _ => Ok(vec![text_item()]),
            }
        }
    }
}
