//! What «Evento del sistema» reads about the desk: how long since the last keystroke or click,
//! whether the screen is locked, which Wi-Fi network this is, how much disk is left.
//!
//! Each answers `None` when this system cannot say — the trigger then shows why instead of guessing.

use std::path::Path;

/// Seconds since the last keystroke, click or mouse move.
pub fn idle_seconds() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        }
        // kCGEventSourceStateHIDSystemState (1), kCGAnyInputEventType (~0).
        // SAFETY: plain values in, a plain `CFTimeInterval` out; reads the HID system's counter.
        let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) };
        return seconds.is_finite().then_some(seconds.max(0.0));
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetTickCount;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `info` is a properly sized LASTINPUTINFO the call fills in.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        // SAFETY: takes nothing; milliseconds since boot, wrapping like `dwTime` does.
        let now = unsafe { GetTickCount() };
        return Some(f64::from(now.wrapping_sub(info.dwTime)) / 1000.0);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let output = crate::proc::std_command("xprintidle").output().ok()?;
        let millis: f64 = String::from_utf8_lossy(&output.stdout).trim().parse().ok()?;
        return Some(millis / 1000.0);
    }
    #[allow(unreachable_code)]
    None
}

/// Whether the screen is locked.
pub fn screen_locked() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::{c_void, CString};
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGSessionCopyCurrentDictionary() -> *const c_void;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFStringCreateWithCString(alloc: *const c_void, text: *const std::os::raw::c_char, encoding: u32) -> *const c_void;
            fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
            fn CFBooleanGetValue(boolean: *const c_void) -> u8;
            fn CFGetTypeID(object: *const c_void) -> usize;
            fn CFBooleanGetTypeID() -> usize;
            fn CFRelease(object: *const c_void);
        }
        let key = CString::new("CGSSessionScreenIsLocked").ok()?;
        // SAFETY: the dictionary and the key are owned here and released below; the value is
        // borrowed from the dictionary and read (after its type is checked) before that.
        unsafe {
            let session = CGSessionCopyCurrentDictionary();
            if session.is_null() {
                return None;
            }
            let name = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), 0x0800_0100);
            let value = if name.is_null() { std::ptr::null() } else { CFDictionaryGetValue(session, name) };
            // The key is there only while locked.
            let locked = !value.is_null() && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(value) != 0;
            if !name.is_null() {
                CFRelease(name);
            }
            CFRelease(session);
            return Some(locked);
        }
    }
    #[cfg(windows)]
    {
        // The lock screen is LogonUI's: while it runs, the desktop is locked.
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        return Some(system.processes().values().any(|p| p.name().to_string_lossy().eq_ignore_ascii_case("LogonUI.exe")));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let session = std::env::var("XDG_SESSION_ID").ok()?;
        let output = crate::proc::std_command("loginctl").args(["show-session", &session, "-p", "LockedHint", "--value"]).output().ok()?;
        return match String::from_utf8_lossy(&output.stdout).trim() {
            "yes" => Some(true),
            "no" => Some(false),
            _ => None,
        };
    }
    #[allow(unreachable_code)]
    None
}

/// The Wi-Fi network this computer is on: `Ok(None)` when it is on none, `Err` when the system
/// will not say.
pub fn wifi_name() -> Result<Option<String>, String> {
    let run = |program: &str, args: &[&str]| -> Option<String> {
        let output = crate::proc::std_command(program).args(args).output().ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    };
    if cfg!(target_os = "macos") {
        let summary = run("ipconfig", &["getsummary", "en0"]).ok_or("ipconfig did not answer")?;
        for line in summary.lines() {
            let line = line.trim();
            if let Some(name) = line.strip_prefix("SSID : ") {
                if name.contains("redacted") {
                    return Err("macOS hides the network's name from apps without Location access".into());
                }
                return Ok(Some(name.trim().to_string()));
            }
        }
        return Ok(None);
    }
    if cfg!(windows) {
        let text = run("netsh", &["wlan", "show", "interfaces"]).ok_or("netsh did not answer")?;
        let name = text
            .lines()
            .map(str::trim)
            .find(|line| line.starts_with("SSID") && !line.starts_with("BSSID"))
            .and_then(|line| line.split_once(':'))
            .map(|(_, name)| name.trim().to_string())
            .filter(|name| !name.is_empty());
        return Ok(name);
    }
    if let Some(name) = run("iwgetid", &["-r"]) {
        let name = name.trim().to_string();
        return Ok((!name.is_empty()).then_some(name));
    }
    let text = run("nmcli", &["-t", "-f", "active,ssid", "dev", "wifi"]).ok_or("neither iwgetid nor nmcli is installed")?;
    Ok(text.lines().find_map(|line| line.strip_prefix("yes:").map(str::to_string)).filter(|n| !n.is_empty()))
}

/// Free space, in GB, of the disk `path` is on.
pub fn disk_free_gb(path: &str) -> Option<f64> {
    let target = crate::flows::nodes::expand_path(if path.trim().is_empty() { "/" } else { path });
    let target = std::fs::canonicalize(&target).unwrap_or(target);
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| target.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(|disk| disk.available_space() as f64 / 1_000_000_000.0)
}

/// Whether a path is worth watching for space: it must exist.
pub fn disk_path_ok(path: &str) -> bool {
    Path::new(&crate::flows::nodes::expand_path(if path.trim().is_empty() { "/" } else { path })).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_machine_answers_what_it_can() {
        // Not asserted beyond shape: a CI runner has no screen, no Wi-Fi and often no input.
        if let Some(idle) = idle_seconds() {
            assert!(idle >= 0.0);
        }
        let _ = screen_locked();
        let free = disk_free_gb("/").expect("the root disk is always there");
        assert!(free > 0.0);
        assert!(disk_path_ok("~"));
    }
}
