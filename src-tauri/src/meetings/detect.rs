//! Noticing a call: which other apps are using the microphone right now, by name, so the window can
//! ask «¿Tomar notas de esta reunión?». It only ever asks — nothing records until the user says so.
//!
//! - **macOS** (14.2+): Core Audio's process objects (`kAudioHardwarePropertyProcessObjectList`),
//!   each with `IsRunningInput` and its bundle id — the same list Control Center's microphone dot is
//!   built from.
//! - **Windows**: the privacy store the system writes when an app opens the microphone
//!   (`CapabilityAccessManager\ConsentStore\microphone`): an entry whose `LastUsedTimeStop` is 0 is
//!   using it now. Packaged apps (the new Teams) are listed by package name, desktop apps by path.
//!
//! Only call apps and browsers count (a browser tab is how Meet runs); a dictation app or a voice
//! memo is not a meeting.

use serde::Serialize;

/// An app using the microphone that looks like a call.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    /// Stable: the bundle id, package name or executable.
    pub id: String,
    pub name: String,
}

/// Known call apps and browsers, by a fragment of their id, lowercase.
const KNOWN: &[(&str, &str)] = &[
    ("com.microsoft.teams", "Microsoft Teams"),
    ("msteams", "Microsoft Teams"),
    ("teams.exe", "Microsoft Teams"),
    ("us.zoom", "Zoom"),
    ("zoom.exe", "Zoom"),
    ("webex", "Webex"),
    ("cisco", "Webex"),
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("slack.exe", "Slack"),
    ("com.hnc.discord", "Discord"),
    ("discord.exe", "Discord"),
    ("com.apple.facetime", "FaceTime"),
    ("whatsapp", "WhatsApp"),
    ("com.google.chrome", "Google Chrome"),
    ("chrome.exe", "Google Chrome"),
    ("com.microsoft.edgemac", "Microsoft Edge"),
    ("msedge.exe", "Microsoft Edge"),
    ("org.mozilla.firefox", "Firefox"),
    ("firefox.exe", "Firefox"),
    ("com.apple.safari", "Safari"),
    ("com.apple.webkit.gpu", "Safari"),
    ("company.thebrowser", "Arc"),
    ("com.brave.browser", "Brave"),
    ("brave.exe", "Brave"),
    ("com.operasoftware", "Opera"),
    ("opera.exe", "Opera"),
    ("com.vivaldi", "Vivaldi"),
    ("gotomeeting", "GoTo Meeting"),
    ("skype", "Skype"),
];

pub fn known(id: &str) -> Option<&'static str> {
    let lower = id.to_lowercase();
    // This app's own capture is not a call.
    if lower.contains("codeflow") {
        return None;
    }
    KNOWN.iter().find(|(fragment, _)| lower.contains(fragment)).map(|(_, name)| *name)
}

/// The call apps using the microphone right now.
pub fn callers() -> Vec<Caller> {
    let mut found: Vec<Caller> = platform::mic_users()
        .into_iter()
        .filter_map(|id| known(&id).map(|name| Caller { id, name: name.to_string() }))
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found.dedup_by(|a, b| a.name == b.name);
    found
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(object: u32, address: NonNull<Address>, qualifier_size: u32, qualifier: *const c_void, size: NonNull<u32>) -> i32;
        fn AudioObjectGetPropertyData(object: u32, address: NonNull<Address>, qualifier_size: u32, qualifier: *const c_void, size: NonNull<u32>, data: NonNull<c_void>) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(string: *const c_void, buffer: *mut u8, size: isize, encoding: u32) -> u8;
        fn CFRelease(object: *const c_void);
    }

    const SYSTEM_OBJECT: u32 = 1;
    const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const PROCESS_LIST: u32 = u32::from_be_bytes(*b"prs#");
    const RUNNING_INPUT: u32 = u32::from_be_bytes(*b"piri");
    const BUNDLE_ID: u32 = u32::from_be_bytes(*b"pbid");
    const PID: u32 = u32::from_be_bytes(*b"ppid");

    fn address(selector: u32) -> Address {
        Address { selector, scope: GLOBAL, element: 0 }
    }

    fn read<T: Copy + Default>(object: u32, selector: u32) -> Option<T> {
        let mut address = address(selector);
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>() as u32;
        // SAFETY: a property read into a value of the size given.
        let status = unsafe {
            AudioObjectGetPropertyData(object, NonNull::from(&mut address), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::from(&mut value).cast())
        };
        (status == 0).then_some(value)
    }

    fn bundle_id(object: u32) -> Option<String> {
        let string: *const c_void = read::<usize>(object, BUNDLE_ID)? as *const c_void;
        if string.is_null() {
            return None;
        }
        let mut buffer = [0u8; 512];
        // SAFETY: a CFString this call owns (the property hands out a +1 reference), read into a
        // buffer of the size given, then released.
        let ok = unsafe {
            let ok = CFStringGetCString(string, buffer.as_mut_ptr(), buffer.len() as isize, 0x0800_0100);
            CFRelease(string);
            ok
        };
        if ok == 0 {
            return None;
        }
        let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
        Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
    }

    pub fn mic_users() -> Vec<String> {
        let mut address = address(PROCESS_LIST);
        let mut size = 0u32;
        // SAFETY: size query, then a read into a buffer of that size.
        let processes: Vec<u32> = unsafe {
            if AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, NonNull::from(&mut address), 0, std::ptr::null(), NonNull::from(&mut size)) != 0 || size == 0 {
                return Vec::new();
            }
            let mut list = vec![0u32; size as usize / 4];
            if AudioObjectGetPropertyData(SYSTEM_OBJECT, NonNull::from(&mut address), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::new(list.as_mut_ptr().cast()).expect("non-null")) != 0 {
                return Vec::new();
            }
            list.truncate(size as usize / 4);
            list
        };
        let me = std::process::id() as i32;
        processes
            .into_iter()
            .filter(|object| read::<u32>(*object, RUNNING_INPUT).unwrap_or(0) != 0)
            .filter(|object| read::<i32>(*object, PID) != Some(me))
            .filter_map(bundle_id)
            .collect()
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ};

    const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open(parent: HKEY, path: &str) -> Option<HKEY> {
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: a registry open with a NUL-terminated path; closed by the caller.
        let status = unsafe { RegOpenKeyExW(parent, wide(path).as_ptr(), 0, KEY_READ, &mut key) };
        (status == ERROR_SUCCESS).then_some(key)
    }

    fn subkeys(key: HKEY) -> Vec<String> {
        let mut out = Vec::new();
        for index in 0.. {
            let mut name = [0u16; 512];
            let mut length = name.len() as u32;
            // SAFETY: enumerating into a buffer of the length given.
            let status = unsafe { RegEnumKeyExW(key, index, name.as_mut_ptr(), &mut length, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) };
            if status != ERROR_SUCCESS {
                break;
            }
            out.push(String::from_utf16_lossy(&name[..length as usize]));
        }
        out
    }

    fn qword(key: HKEY, value: &str) -> Option<u64> {
        let mut data = 0u64;
        let mut size = 8u32;
        // SAFETY: a QWORD read into eight bytes.
        let status = unsafe { RegQueryValueExW(key, wide(value).as_ptr(), std::ptr::null(), std::ptr::null_mut(), (&mut data as *mut u64).cast(), &mut size) };
        (status == ERROR_SUCCESS).then_some(data)
    }

    fn in_use(parent: HKEY, name: &str) -> bool {
        let Some(key) = open(parent, name) else { return false };
        let start = qword(key, "LastUsedTimeStart").unwrap_or(0);
        let stop = qword(key, "LastUsedTimeStop").unwrap_or(1);
        // SAFETY: a key this function opened.
        unsafe { RegCloseKey(key) };
        start != 0 && stop == 0
    }

    pub fn mic_users() -> Vec<String> {
        let Some(store) = open(HKEY_CURRENT_USER, STORE) else { return Vec::new() };
        let mut out = Vec::new();
        for name in subkeys(store) {
            if name == "NonPackaged" {
                if let Some(desktop) = open(store, "NonPackaged") {
                    for app in subkeys(desktop) {
                        if in_use(desktop, &app) {
                            // `C:#Program Files#…#Teams.exe` — the path with `#` for `\`.
                            out.push(app.rsplit('#').next().unwrap_or(&app).to_string());
                        }
                    }
                    // SAFETY: opened above.
                    unsafe { RegCloseKey(desktop) };
                }
            } else if in_use(store, &name) {
                out.push(name);
            }
        }
        // SAFETY: opened above.
        unsafe { RegCloseKey(store) };
        out
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn mic_users() -> Vec<String> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_apps_are_known_and_this_app_is_not() {
        assert_eq!(known("com.microsoft.teams2"), Some("Microsoft Teams"));
        assert_eq!(known("MSTeams_8wekyb3d8bbwe"), Some("Microsoft Teams"));
        assert_eq!(known("Zoom.exe"), Some("Zoom"));
        assert_eq!(known("com.google.Chrome.helper"), Some("Google Chrome"));
        assert_eq!(known("com.apple.VoiceMemos"), None);
        assert_eq!(known("dev.codeflow.app"), None);
    }

    /// Lists what is using the microphone on this machine — run with a call open.
    #[test]
    #[ignore]
    fn lists_the_microphone_users_here() {
        eprintln!("{:?}", platform::mic_users());
        eprintln!("{:?}", callers());
    }
}
