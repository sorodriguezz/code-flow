//! «Iniciar CodeFlow al iniciar sesión», beyond what `tauri-plugin-autostart` checks.
//!
//! The plugin (auto-launch 0.5) registers the login item and answers "is it on?" from the
//! registration alone — which, on both systems, can say "on" for an item that will never start
//! CodeFlow (checked 2026-10-07 against its source):
//!
//! - **Windows** writes the Run value as `C:\path\codeflow.exe --autostarted`, unquoted, so a path
//!   with a space in it — a profile such as `C:\Users\Ana María\…`, an install under `Program
//!   Files` — is cut at the space and nothing starts. [`fix_windows_command`] writes it quoted after
//!   every enable and at every launch.
//! - **macOS** answers from the LaunchAgent plist existing. Since macOS 13 the item can be switched
//!   off in System Settings › General › Login Items ("Allow in the Background") — by the user or an
//!   MDM profile — and launchd then ignores a plist that is still there. [`status`] reads
//!   `launchctl print-disabled` for that. The plist also names the copy of the app that enabled it:
//!   one moved since, or running from App Translocation's temporary folder, points at nothing.
//!
//! And whether it works is answered by the one fact that cannot be wrong: when the login item last
//! started the app (`--autostarted`), recorded at launch and shown under the box.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::db::{queries, Db};

/// RFC 3339 of the last launch the login item made.
const LAST_AUTOSTART_KEY: &str = "app_last_autostart_at";

/// What the login item is, and whether it will work.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    /// What the plugin answers — the box.
    pub enabled: bool,
    /// The program the system starts at login, as registered.
    pub target: Option<String>,
    /// What stands in the way: `blocked` (macOS: off in Login Items), `translocated` (macOS: this copy
    /// runs from a temporary folder — move it to Applications), `missing` (the registered program is
    /// gone), `taskManager` (Windows: off in Task Manager › Startup apps).
    pub problem: Option<String>,
    /// When the login item last started CodeFlow.
    pub last_autostart: Option<String>,
}

/// At every launch: the time, when the login item made this one, and the registration pointed back
/// at this copy of the app when it has moved or was written unquoted.
pub fn on_launch(app: &AppHandle, autostarted: bool) {
    if autostarted {
        if let Some(db) = app.try_state::<Db>() {
            if let Ok(conn) = db.0.lock() {
                let _ = queries::set_setting(&conn, LAST_AUTOSTART_KEY, &chrono::Utc::now().to_rfc3339());
            }
        }
        crate::applog::info("app: started by the login item");
    }
    if app.autolaunch().is_enabled().unwrap_or(false) {
        heal(app);
    }
}

/// After the plugin turned it on: what it wrote, put right.
pub fn after_enable(app: &AppHandle) {
    #[cfg(windows)]
    fix_windows_command(app);
    #[cfg(not(windows))]
    let _ = app;
}

fn heal(app: &AppHandle) {
    #[cfg(windows)]
    fix_windows_command(app);
    #[cfg(target_os = "macos")]
    {
        let Some(current) = current_program() else { return };
        // A temporary copy would be registered for the next login, when it no longer exists.
        if translocated(&current) {
            return;
        }
        if mac::registered_program(&app_name(app)).is_some_and(|registered| registered != current) {
            if let Err(e) = app.autolaunch().enable() {
                crate::applog::warn(&format!("app: could not point the login item at {current}: {e}"));
            } else {
                crate::applog::info(&format!("app: login item now starts {current}"));
            }
        }
    }
}

fn app_name(app: &AppHandle) -> String {
    app.package_info().name.clone()
}

/// The executable the plugin registers: `current_exe`, canonical — as it does.
fn current_program() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.canonicalize().ok())
        .map(|exe| exe.display().to_string())
}

/// Gatekeeper runs an app that was opened where it was downloaded from a randomized read-only copy;
/// that path is gone by the next login.
fn translocated(program: &str) -> bool {
    program.contains("/AppTranslocation/")
}

#[tauri::command(async)]
pub fn autostart_status(app: AppHandle) -> AutostartStatus {
    status(&app)
}

pub fn status(app: &AppHandle) -> AutostartStatus {
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let last_autostart = app
        .try_state::<Db>()
        .and_then(|db| db.0.lock().ok().and_then(|conn| queries::get_setting(&conn, LAST_AUTOSTART_KEY).ok().flatten()))
        .filter(|stamp| !stamp.is_empty());
    let name = app_name(app);
    #[cfg(target_os = "macos")]
    let (target, problem) = {
        let target = mac::registered_program(&name);
        let problem = if !enabled {
            None
        } else if current_program().is_some_and(|program| translocated(&program)) {
            Some("translocated")
        } else if target.as_deref().is_some_and(|program| !std::path::Path::new(program).exists()) {
            Some("missing")
        } else if mac::switched_off(&name) {
            Some("blocked")
        } else {
            None
        };
        (target, problem)
    };
    #[cfg(windows)]
    let (target, problem) = {
        let command = win::run_value(&name);
        let target = command.as_deref().map(win::program_of);
        let problem = match (&command, enabled) {
            // A Run entry the plugin calls off: Task Manager's switch (StartupApproved) says so.
            (Some(_), false) => Some("taskManager"),
            (Some(_), true) if target.as_deref().is_some_and(|program| !std::path::Path::new(program).exists()) => Some("missing"),
            _ => None,
        };
        (target, problem)
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let (target, problem): (Option<String>, Option<&str>) = {
        let _ = &name;
        (None, None)
    };
    AutostartStatus { enabled, target, problem: problem.map(str::to_string), last_autostart }
}

/// Opens the system's own list of what starts at login — where `blocked` and `taskManager` are undone.
#[tauri::command]
pub fn autostart_open_system_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let target = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";
    #[cfg(windows)]
    let target = "ms-settings:startupapps";
    #[cfg(not(any(target_os = "macos", windows)))]
    return Err("not available on this system".into());
    #[cfg(any(target_os = "macos", windows))]
    open::that(target).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn fix_windows_command(app: &AppHandle) {
    let Some(program) = std::env::current_exe().ok().map(|exe| exe.display().to_string()) else { return };
    let name = app_name(app);
    let wanted = win::quoted_command(&program);
    if win::run_value(&name).as_deref() == Some(wanted.as_str()) {
        return;
    }
    match win::set_run_value(&name, &wanted) {
        Ok(()) => crate::applog::info(&format!("app: login item now runs {wanted}")),
        Err(e) => crate::applog::warn(&format!("app: could not rewrite the login item: {e}")),
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::PathBuf;

    fn plist(name: &str) -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join("Library").join("LaunchAgents").join(format!("{name}.plist")))
    }

    /// The program the LaunchAgent starts: the first `<string>` of `ProgramArguments`, in the shape
    /// auto-launch writes.
    pub fn registered_program(name: &str) -> Option<String> {
        let text = std::fs::read_to_string(plist(name)?).ok()?;
        super::first_program_argument(&text)
    }

    /// Whether launchd holds the label as disabled — what switching the item off in Login Items
    /// ("Allow in the Background") leaves, as `"<label>" => disabled`.
    pub fn switched_off(name: &str) -> bool {
        // SAFETY: `getuid` has no preconditions.
        let uid = unsafe { libc::getuid() };
        let Ok(output) = std::process::Command::new("/bin/launchctl").args(["print-disabled", &format!("gui/{uid}")]).output() else {
            return false;
        };
        super::disabled_in(&String::from_utf8_lossy(&output.stdout), name)
    }
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
    };

    const RUN: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open(access: u32) -> Option<HKEY> {
        let path = wide(RUN);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: `path` is NUL-terminated and outlives the call; `key` is written on success.
        let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, access, &mut key) };
        (status == ERROR_SUCCESS).then_some(key)
    }

    /// The Run entry's command line, as written.
    pub fn run_value(name: &str) -> Option<String> {
        let key = open(KEY_QUERY_VALUE)?;
        let value = wide(name);
        let mut kind = 0u32;
        let mut size = 0u32;
        // SAFETY: a size query (null buffer) first, then a read into a buffer of that size.
        let found = unsafe { RegQueryValueExW(key, value.as_ptr(), std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut size) } == ERROR_SUCCESS;
        let mut text = None;
        if found && kind == REG_SZ && size > 0 {
            let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
            let read = unsafe { RegQueryValueExW(key, value.as_ptr(), std::ptr::null(), &mut kind, buffer.as_mut_ptr().cast(), &mut size) } == ERROR_SUCCESS;
            if read {
                let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
                text = Some(String::from_utf16_lossy(&buffer[..end]));
            }
        }
        // SAFETY: `key` was opened above.
        unsafe { RegCloseKey(key) };
        text
    }

    pub fn set_run_value(name: &str, command: &str) -> Result<(), String> {
        let key = open(KEY_SET_VALUE).ok_or("the Run key could not be opened")?;
        let value = wide(name);
        let data = wide(command);
        // SAFETY: `data` is a NUL-terminated UTF-16 string, its byte length passed with the NUL.
        let status = unsafe { RegSetValueExW(key, value.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) };
        unsafe { RegCloseKey(key) };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("RegSetValueExW failed ({status})"))
        }
    }

    pub fn quoted_command(program: &str) -> String {
        super::quoted_command(program)
    }

    pub fn program_of(command: &str) -> String {
        super::program_of(command)
    }
}

/// The Run command line CodeFlow wants: the program quoted, then the flag the plugin passes.
#[cfg_attr(not(windows), allow(dead_code))]
fn quoted_command(program: &str) -> String {
    format!("\"{program}\" {}", crate::AUTOSTARTED_FLAG)
}

/// The program a Run command line starts: quoted, or — as auto-launch 0.5 writes it — bare, ahead of
/// the flag.
#[cfg_attr(not(windows), allow(dead_code))]
fn program_of(command: &str) -> String {
    let command = command.trim();
    if let Some(rest) = command.strip_prefix('"') {
        return rest.split('"').next().unwrap_or_default().to_string();
    }
    command.strip_suffix(crate::AUTOSTARTED_FLAG).unwrap_or(command).trim().to_string()
}

/// The first `<string>` after `<key>ProgramArguments</key>`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn first_program_argument(plist: &str) -> Option<String> {
    let after = plist.split_once("<key>ProgramArguments</key>")?.1;
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")? + start;
    let raw = &after[start..end];
    Some(raw.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'"))
}

/// Whether `launchctl print-disabled` lists `label` as disabled.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn disabled_in(listing: &str, label: &str) -> bool {
    let quoted = format!("\"{label}\"");
    listing.lines().map(str::trim).any(|line| {
        line.strip_prefix(&quoted)
            .and_then(|rest| rest.trim_start().strip_prefix("=>"))
            .map(str::trim)
            .is_some_and(|state| state == "disabled" || state == "true")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_run_command_is_quoted_and_both_shapes_read_back() {
        let program = r"C:\Users\Ana María\AppData\Local\CodeFlow\codeflow.exe";
        let command = quoted_command(program);
        assert_eq!(command, format!("\"{program}\" --autostarted"));
        assert_eq!(program_of(&command), program);
        // What auto-launch 0.5 writes: unquoted — the space is where Windows cut it.
        assert_eq!(program_of(&format!("{program} --autostarted")), program);
    }

    #[test]
    fn the_launch_agent_names_its_program() {
        // The shape auto-launch writes.
        let plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  <string>CodeFlow</string>\n  \
                     <key>ProgramArguments</key>\n  <array><string>/Applications/CodeFlow.app/Contents/MacOS/codeflow</string><string>--autostarted</string></array>\n  \
                     <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>";
        assert_eq!(first_program_argument(plist).as_deref(), Some("/Applications/CodeFlow.app/Contents/MacOS/codeflow"));
        assert_eq!(first_program_argument("<plist></plist>"), None);
    }

    #[test]
    fn a_label_switched_off_in_login_items_reads_disabled() {
        let listing = "\tdisabled services = {\n\t\t\"com.ollama.ollama\" => enabled\n\t\t\"CodeFlow\" => disabled\n\t}\n";
        assert!(disabled_in(listing, "CodeFlow"));
        assert!(!disabled_in(listing, "com.ollama.ollama"));
        assert!(!disabled_in(listing, "Code"));
        assert!(disabled_in("\"CodeFlow\" => true", "CodeFlow"));
    }

    #[test]
    fn a_translocated_copy_is_recognised() {
        assert!(translocated("/private/var/folders/x/T/AppTranslocation/0A1B/d/CodeFlow.app/Contents/MacOS/codeflow"));
        assert!(!translocated("/Applications/CodeFlow.app/Contents/MacOS/codeflow"));
    }
}
