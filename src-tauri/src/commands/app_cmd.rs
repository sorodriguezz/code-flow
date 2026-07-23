use tauri::AppHandle;

use crate::paths;
use crate::tray::QuittingFlag;

/// The only path that actually terminates the process — everything else (title bar close
/// button, Alt+F4, the red traffic light) hides the window instead so background jobs and
/// terminals keep running, so this has to explicitly mark intent before exiting.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    use tauri::Manager;
    app.state::<QuittingFlag>().mark_quitting();
    app.exit(0);
}

/// The in-app equivalent of the Windows installer's "delete my data" uninstall prompt — the
/// only way to get that same choice on macOS, since a DMG install has no uninstaller/hook
/// mechanism to intercept at all. Drops a marker and quits; the actual deletion happens on next
/// launch, before the database is opened (see `paths::reset_marker_path`).
#[tauri::command]
pub fn reset_app_data(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    std::fs::write(paths::reset_marker_path(), "").map_err(|e| e.to_string())?;
    app.state::<QuittingFlag>().mark_quitting();
    app.exit(0);
    Ok(())
}
