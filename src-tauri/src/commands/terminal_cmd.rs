use tauri::{AppHandle, State};

use crate::terminal::{self, TerminalRegistry};

#[tauri::command]
pub fn open_terminal(app: AppHandle, registry: State<TerminalRegistry>, cwd: String) -> Result<String, String> {
    terminal::open_terminal(app, &registry, cwd)
}

#[tauri::command]
pub fn write_terminal(registry: State<TerminalRegistry>, id: String, data: String) -> Result<(), String> {
    terminal::write_terminal(&registry, &id, &data)
}

#[tauri::command]
pub fn resize_terminal(registry: State<TerminalRegistry>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    terminal::resize_terminal(&registry, &id, cols, rows)
}

#[tauri::command]
pub fn close_terminal(registry: State<TerminalRegistry>, id: String) -> Result<(), String> {
    terminal::close_terminal(&registry, &id)
}
