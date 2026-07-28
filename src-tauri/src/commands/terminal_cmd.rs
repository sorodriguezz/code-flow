use tauri::{AppHandle, State};

use crate::db::Db;
use crate::shell_profiles::{self, ShellProfile};
use crate::terminal::{self, TerminalRegistry};

/// Every shell the terminal can open with — detected built-ins plus the user's own profiles.
/// Re-read on each call rather than cached, so a shell installed while the app is running (or a
/// profile edited in Settings) shows up in the picker without a restart.
#[tauri::command]
pub fn list_shell_profiles(db: State<Db>) -> Result<Vec<ShellProfile>, String> {
    shell_profiles::list(&db)
}

/// `profile_id` is the id of a profile from [`list_shell_profiles`]; omitting it opens the
/// configured default. The frontend never passes a command line — see `shell_profiles` for why.
#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    db: State<Db>,
    cwd: String,
    profile_id: Option<String>,
) -> Result<TerminalOpened, String> {
    let profile = shell_profiles::resolve(&db, profile_id.as_deref())?;
    let id = terminal::open_terminal(app, &registry, cwd, &profile)?;
    // The resolved profile goes back with the session id so the tab can be titled after the shell
    // that actually started — which is not necessarily the one asked for, since an unset default
    // resolves here rather than on the frontend.
    Ok(TerminalOpened { id, profile_id: profile.id, profile_name: profile.name })
}

#[derive(serde::Serialize)]
pub struct TerminalOpened {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
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
