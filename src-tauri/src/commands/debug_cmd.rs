//! Tauri commands for the debugger. The session itself lives in [`crate::debugger`]; these are
//! the calls the debug toolbar, the breakpoint gutter and the variables panel make.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::dap;
use crate::debugger::{self, BreakpointInput, Breakpoints, ExceptionFilter, PausedEvent, Variable};

/// Which backend a running session belongs to. Node has its own protocol built in; everything
/// else goes through a debug adapter, and only one session runs at a time either way.
fn using_adapter() -> bool {
    dap::is_running()
}

/// Breakpoints as they arrive over IPC — bare lines or whole specs — in the one shape both
/// backends take.
fn specs(breakpoints: HashMap<String, Vec<BreakpointInput>>) -> Breakpoints {
    breakpoints
        .into_iter()
        .map(|(path, inputs)| (path, inputs.into_iter().map(Into::into).collect()))
        .collect()
}

/// Launches `program` under Node with the inspector attached, applying `breakpoints`
/// (absolute path → 1-based lines, or line specs with a condition or log message) and the
/// exception filters before the first statement runs.
#[tauri::command]
pub async fn debug_start(
    app: AppHandle,
    cwd: String,
    node_binary: Option<String>,
    program: String,
    args: Vec<String>,
    breakpoints: HashMap<String, Vec<BreakpointInput>>,
    exception_filters: Option<Vec<String>>,
) -> Result<(), String> {
    let binary = node_binary.filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "node".to_string());
    let filters = exception_filters.unwrap_or_default();
    debugger::start(app, &cwd, &binary, &program, &args, &specs(breakpoints), &filters).await
}

/// Starts a session through a debug adapter — the path for Python, C#, Ruby and anything else
/// with a DAP adapter installed. `launch_config` is that adapter's own launch object, the same
/// JSON a VS Code `launch.json` entry would carry. Answers with the exception filters the adapter
/// offers; `exception_filters` is `None` when the user never chose for this adapter, which takes
/// its defaults.
#[tauri::command]
pub async fn debug_start_adapter(
    app: AppHandle,
    cwd: String,
    command: String,
    args: Vec<String>,
    launch_config: serde_json::Value,
    breakpoints: HashMap<String, Vec<BreakpointInput>>,
    exception_filters: Option<Vec<String>>,
) -> Result<Vec<ExceptionFilter>, String> {
    dap::start(app, &cwd, &command, &args, launch_config, &specs(breakpoints), exception_filters.as_deref()).await
}

#[tauri::command]
pub async fn debug_stop() -> Result<(), String> {
    stop_all().await;
    Ok(())
}

/// Both backends are asked to stop: whichever isn't running treats it as a no-op, which is cheaper
/// than tracking which one owned the last session. Also what quitting the app runs — see
/// `shutdown::shutdown_cleanup`.
pub async fn stop_all() {
    dap::stop().await;
    debugger::stop().await;
}

#[tauri::command]
pub async fn debug_continue() -> Result<(), String> {
    if using_adapter() { dap::resume().await } else { debugger::resume().await }
}

#[tauri::command]
pub async fn debug_pause() -> Result<(), String> {
    if using_adapter() { dap::pause().await } else { debugger::pause().await }
}

/// `over` | `into` | `out`.
#[tauri::command]
pub async fn debug_step(kind: String) -> Result<(), String> {
    if using_adapter() { dap::step(&kind).await } else { debugger::step(&kind).await }
}

#[tauri::command]
pub async fn debug_set_breakpoints(breakpoints: HashMap<String, Vec<BreakpointInput>>) -> Result<(), String> {
    let breakpoints = specs(breakpoints);
    if using_adapter() {
        dap::set_breakpoints(&breakpoints).await
    } else {
        debugger::set_breakpoints(&breakpoints).await
    }
}

/// Which exceptions stop the running program — ids from the session's own list.
#[tauri::command]
pub async fn debug_set_exception_filters(filters: Vec<String>) -> Result<(), String> {
    if using_adapter() {
        dap::set_exception_filters(&filters).await
    } else {
        debugger::set_exception_filters(&filters).await
    }
}

#[tauri::command]
pub async fn debug_properties(object_id: String) -> Result<Vec<Variable>, String> {
    if using_adapter() { dap::properties(&object_id).await } else { debugger::properties(&object_id).await }
}

/// The scopes of any paused frame, as expandable rows: `Local`, `Closure`, `Global`…
#[tauri::command]
pub async fn debug_scopes(frame_id: String) -> Result<Vec<Variable>, String> {
    if using_adapter() { dap::scopes(&frame_id).await } else { debugger::scopes(&frame_id) }
}

/// `context` is `repl` (the console, the default) or `watch` (the watch list, evaluated on every
/// stop and never allowed to stop or print anything itself).
#[tauri::command]
pub async fn debug_evaluate(frame_id: String, expression: String, context: Option<String>) -> Result<Variable, String> {
    if using_adapter() {
        dap::evaluate(&frame_id, &expression, context.as_deref()).await
    } else {
        debugger::evaluate(&frame_id, &expression, context.as_deref()).await
    }
}

#[tauri::command]
pub fn debug_is_running() -> bool {
    debugger::is_running() || dap::is_running()
}

/// A running session, described for a panel that did not start it — after a webview reload the
/// panel's own state is gone while the program lives on, and without this it showed "idle" with
/// no Stop button beside a paused process.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionInfo {
    /// `node` or `adapter`.
    pub backend: &'static str,
    pub paused: Option<PausedEvent>,
    pub exception_filters: Vec<ExceptionFilter>,
}

#[tauri::command]
pub fn debug_session() -> Option<DebugSessionInfo> {
    if dap::is_running() {
        return Some(DebugSessionInfo {
            backend: "adapter",
            paused: dap::paused_state(),
            exception_filters: dap::offered_exception_filters(),
        });
    }
    if debugger::is_running() {
        return Some(DebugSessionInfo {
            backend: "node",
            paused: debugger::paused_state(),
            exception_filters: debugger::node_exception_filters(),
        });
    }
    None
}

/// Which Python runs debugpy, and which runs the program.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PythonChoice {
    /// The interpreter the adapter is launched with: the first of the two below that can import
    /// debugpy, so a debugpy installed only system-wide still debugs a project with a venv.
    pub adapter: String,
    /// The one the program runs under: the project's own virtual environment when it has one — its
    /// dependencies live there — else the system's.
    pub interpreter: String,
}

/// Picks the Python for a debug session in `cwd`.
///
/// It used to be the bare word `python`, which macOS does not have at all (only `python3`), and
/// which ignored the project's `.venv` — so the program ran without the packages it imports.
#[tauri::command(async)]
pub fn debug_python(cwd: String) -> PythonChoice {
    use crate::services::detect::{on_path, system_python, venv_python};
    let windows = cfg!(windows);
    let venv = venv_python(Path::new(&cwd), windows)
        .map(|relative| Path::new(&cwd).join(relative).to_string_lossy().into_owned());
    let system = system_python(windows, on_path).to_string();
    choose_python(venv, system, |python| {
        crate::proc::std_command(python)
            .args(["-c", "import debugpy"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}

/// [`debug_python`]'s decision, apart from the probing so it can be tested.
fn choose_python(venv: Option<String>, system: String, has_debugpy: impl Fn(&str) -> bool) -> PythonChoice {
    let interpreter = venv.clone().unwrap_or_else(|| system.clone());
    let adapter = [venv, Some(system)]
        .into_iter()
        .flatten()
        .find(|python| has_debugpy(python))
        // Neither has it: launched anyway, so the adapter's own "No module named debugpy" is what
        // the console shows, next to the install hint.
        .unwrap_or_else(|| interpreter.clone());
    PythonChoice { adapter, interpreter }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_projects_venv_runs_the_program_and_whoever_has_debugpy_runs_the_adapter() {
        let venv = Some("/p/.venv/bin/python".to_string());
        // debugpy installed in the venv: it does both.
        let both = choose_python(venv.clone(), "python3".into(), |_| true);
        assert_eq!(both, PythonChoice { adapter: "/p/.venv/bin/python".into(), interpreter: "/p/.venv/bin/python".into() });
        // Only system-wide: the adapter runs there, the program still in the venv.
        let split = choose_python(venv.clone(), "python3".into(), |python| python == "python3");
        assert_eq!(split, PythonChoice { adapter: "python3".into(), interpreter: "/p/.venv/bin/python".into() });
        // Nowhere: the venv anyway, so the missing module is what gets reported.
        let none = choose_python(venv, "python3".into(), |_| false);
        assert_eq!(none.adapter, "/p/.venv/bin/python");
        // No venv at all: the system's, for both.
        let bare = choose_python(None, "python3".into(), |_| false);
        assert_eq!(bare, PythonChoice { adapter: "python3".into(), interpreter: "python3".into() });
    }

    #[test]
    fn old_style_line_lists_still_arrive_as_breakpoints() {
        let input: HashMap<String, Vec<BreakpointInput>> =
            serde_json::from_value(serde_json::json!({ "/a.js": [3, { "line": 9, "condition": "x" }] })).unwrap();
        let converted = specs(input);
        assert_eq!(converted["/a.js"].iter().map(|b| b.line).collect::<Vec<_>>(), [3, 9]);
        assert_eq!(converted["/a.js"][1].condition.as_deref(), Some("x"));
    }
}
