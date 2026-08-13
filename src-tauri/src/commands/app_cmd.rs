use tauri::{AppHandle, State};

use crate::db::Db;
use crate::paths;
use crate::tray::QuittingFlag;

/// The only path that actually terminates the process — everything else (title bar close
/// button, Alt+F4, the red traffic light) hides the window instead so background jobs and
/// terminals keep running, so this has to explicitly mark intent before exiting.
///
/// The last thing before exiting is the backup, when the user asked for one on quit: the session
/// that just ended is precisely the one a scheduled backup is most likely not to have caught.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    use tauri::Manager;
    crate::backup::auto::flush_on_exit(&app);
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

/// The statistics screen's whole payload for one window, in hours.
///
/// The only reader of what this app recorded, now that the status bar draws provider quota alone —
/// which is also why the retention sweep rides on this call (see `queries::ai_usage_stats`).
#[tauri::command]
pub fn ai_usage_stats(db: State<Db>, window_hours: i64) -> Result<crate::ai_usage::UsageStats, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::db::queries::ai_usage_stats(&conn, window_hours).map_err(|e| e.to_string())
}

/// How much of each provider's plan is left — the counterpart to [`ai_usage_stats`], read from
/// the providers themselves rather than from this app's own records.
///
/// Never fails as a whole. Each provider carries its own error, because "Gemini is signed out" is
/// not a reason to stop showing how much of the Claude week is left.
#[tauri::command]
pub async fn ai_quota_status() -> Vec<crate::ai_quota::ProviderQuota> {
    crate::ai_quota::fetch_all().await
}

/// What the app cannot do without, checked on the first launch after installing.
///
/// Called at most once per installation — the frontend remembers the answer in `app_settings`,
/// beside the tour's own flag and for the same reason (see `requirementsStore`). Cheap regardless:
/// one short-lived subprocess and one file write.
#[tauri::command]
pub fn check_requirements() -> Vec<crate::requirements::Requirement> {
    crate::requirements::check()
}
