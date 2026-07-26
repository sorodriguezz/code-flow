//! Tauri commands for the debugger. The session itself lives in [`crate::debugger`]; these are
//! the calls the debug toolbar, the breakpoint gutter and the variables panel make.

use std::collections::HashMap;

use tauri::AppHandle;

use crate::dap;
use crate::debugger::{self, Variable};

/// Which backend a running session belongs to. Node has its own protocol built in; everything
/// else goes through a debug adapter, and only one session runs at a time either way.
fn using_adapter() -> bool {
    dap::is_running()
}

/// Launches `program` under Node with the inspector attached, applying `breakpoints`
/// (absolute path → 1-based lines) before the first statement runs.
#[tauri::command]
pub async fn debug_start(
    app: AppHandle,
    cwd: String,
    node_binary: Option<String>,
    program: String,
    args: Vec<String>,
    breakpoints: HashMap<String, Vec<u32>>,
) -> Result<(), String> {
    let binary = node_binary.filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "node".to_string());
    debugger::start(app, &cwd, &binary, &program, &args, &breakpoints).await
}

/// Starts a session through a debug adapter — the path for Python, C#, Ruby and anything else
/// with a DAP adapter installed. `launch_config` is that adapter's own launch object, the same
/// JSON a VS Code `launch.json` entry would carry.
#[tauri::command]
pub async fn debug_start_adapter(
    app: AppHandle,
    cwd: String,
    command: String,
    args: Vec<String>,
    launch_config: serde_json::Value,
    breakpoints: HashMap<String, Vec<u32>>,
) -> Result<(), String> {
    dap::start(app, &cwd, &command, &args, launch_config, &breakpoints).await
}

#[tauri::command]
pub async fn debug_stop() -> Result<(), String> {
    // Both are asked to stop: whichever isn't running treats it as a no-op, which is cheaper
    // than tracking which backend owned the last session.
    dap::stop().await;
    debugger::stop().await;
    Ok(())
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
pub async fn debug_set_breakpoints(breakpoints: HashMap<String, Vec<u32>>) -> Result<(), String> {
    if using_adapter() {
        dap::set_breakpoints(&breakpoints).await
    } else {
        debugger::set_breakpoints(&breakpoints).await
    }
}

#[tauri::command]
pub async fn debug_properties(object_id: String) -> Result<Vec<Variable>, String> {
    if using_adapter() { dap::properties(&object_id).await } else { debugger::properties(&object_id).await }
}

#[tauri::command]
pub async fn debug_evaluate(frame_id: String, expression: String) -> Result<Variable, String> {
    if using_adapter() {
        dap::evaluate(&frame_id, &expression).await
    } else {
        debugger::evaluate(&frame_id, &expression).await
    }
}

#[tauri::command]
pub fn debug_is_running() -> bool {
    debugger::is_running() || dap::is_running()
}
