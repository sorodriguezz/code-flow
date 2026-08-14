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
/// `trigger` is `"poll"`, `"open"` or `"refresh"` — who asked. It decides both whether the cache is
/// bypassed and whether a provider that reads its quota by *running its CLI* may start one, which a
/// background timer must never do: on Windows that flashes a console window at whatever the user
/// was doing. Anything unrecognised is treated as a poll, the most conservative of the three.
///
/// **Only engines that are actually installed are asked.** The binary is resolved exactly as a run
/// would resolve it — the user's `{provider}_binary_path` first, the engine's default second — and
/// a provider whose CLI is nowhere on the machine is dropped before any credential is read. That
/// is what stops the panel giving impossible advice: a leftover `auth.json` from an uninstalled CLI
/// still answers "your token expired", and the row then told the user to run an engine they do not
/// have. It also means nothing is spent probing engines this install does not use.
#[tauri::command]
pub async fn ai_quota_status(
    db: State<'_, Db>,
    trigger: Option<String>,
) -> Result<Vec<crate::ai_quota::ProviderQuota>, String> {
    use crate::ai_quota::Trigger;
    let trigger = match trigger.as_deref() {
        Some("refresh") => Trigger::Refresh,
        Some("open") => Trigger::Open,
        _ => Trigger::Poll,
    };

    let engines = {
        // Scoped so the lock is released before the awaits below — the reads are a few settings
        // rows, and holding the global mutex across a network call would stall every other command.
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::ai_quota::QUOTA_PROVIDERS
            .iter()
            .filter_map(|provider| {
                let configured = crate::db::queries::get_setting(&conn, &format!("{provider}_binary_path"))
                    .ok()
                    .flatten()
                    .filter(|path| !path.trim().is_empty());
                let binary = configured
                    .unwrap_or_else(|| crate::ai::engine_for(provider).default_binary().to_string());
                crate::ai::find_on_path(&binary).map(|binary| crate::ai_quota::QuotaEngine {
                    provider: provider.to_string(),
                    binary,
                })
            })
            .collect::<Vec<_>>()
    };

    Ok(crate::ai_quota::fetch_all(engines, trigger).await)
}

/// Battery level and whether the machine is on mains, or `None` on a machine with no battery.
///
/// `None` is the desktop answer and the UI draws nothing for it — a permanently full icon is a
/// pixel that never changes and stops being read. Cheap enough to poll: a native read, no
/// subprocess, so unlike the quota providers this one can run on a timer without putting a console
/// window on screen.
#[tauri::command]
pub fn power_status() -> Option<crate::power::PowerStatus> {
    crate::power::status()
}

/// CPU, memory and disk for the whole machine, plus this app's own share of the first two.
///
/// `(async)` — off the main thread — because unlike the battery this one can walk the process
/// table, which is milliseconds rather than microseconds, and the very first call deliberately
/// sleeps for sysinfo's minimum sampling interval so the first reading carries a real CPU figure
/// instead of a zero (see [`crate::sysload::read`]). Neither belongs on the thread drawing the
/// window.
///
/// `detail` asks for the app's own share, which is the part that needs that process walk. The
/// status bar passes false and the hover panel passes true, so the expensive half is paid while
/// someone is looking at it rather than every 2.5 seconds for the life of the window. The figures
/// come back either way — stale by one poll at worst when it is false.
///
/// Infallible by design: a status bar has nothing to do with an error about a detail nobody asked
/// to be told about, so anything unreadable comes back as zero.
#[tauri::command(async)]
pub fn system_load(detail: bool) -> crate::sysload::SystemLoad {
    crate::sysload::read(detail)
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
