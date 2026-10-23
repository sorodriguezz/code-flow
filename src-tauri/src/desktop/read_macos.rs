//! macOS: the window list from the window server, the text through Accessibility (`AXUIElement`),
//! the fallback through `screencapture` and Vision's text recognizer.

use std::ffi::c_void;
use std::time::{Duration, Instant};

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};

use super::{OpenWindow, Permissions};

type AXUIElementRef = CFTypeRef;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

// Vision's classes are looked up by name at run time; this is what loads them.
#[link(name = "Vision", kind = "framework")]
extern "C" {}

const ON_SCREEN_ONLY: u32 = 1 << 0;
const EXCLUDE_DESKTOP: u32 = 1 << 4;

/// How many elements one reading visits, and for how long: a chat's history can be thousands deep,
/// and the end of it is what is asked about.
const MAX_NODES: usize = 8_000;
const MAX_DEPTH: usize = 60;
const BUDGET: Duration = Duration::from_secs(4);

pub fn permissions() -> Permissions {
    // SAFETY: plain queries, no arguments.
    unsafe { Permissions { accessibility: AXIsProcessTrusted(), screen: CGPreflightScreenCaptureAccess(), supported: true } }
}

pub fn ask(kind: &str) {
    match kind {
        "screen" => {
            // SAFETY: the system's own prompt; answers at once, the user answers in Settings.
            unsafe { CGRequestScreenCaptureAccess() };
            let _ = open::that_detached("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        }
        _ => {
            let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
            let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
            // SAFETY: a dictionary of the one documented key; the prompt is the system's.
            unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) };
            let _ = open::that_detached("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        }
    }
}

fn dict_string(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<String> {
    dict.find(CFString::new(key)).and_then(|value| value.downcast::<CFString>()).map(|s| s.to_string())
}

fn dict_number(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<i64> {
    dict.find(CFString::new(key)).and_then(|value| value.downcast::<CFNumber>()).and_then(|n| n.to_i64())
}

pub fn windows() -> Result<Vec<OpenWindow>, String> {
    // SAFETY: the window server's list, owned by us (Create rule), wrapped so it is released.
    let list = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) };
    if list.is_null() {
        return Err("the window list could not be read".into());
    }
    let list: CFArray<CFDictionary<CFString, CFType>> = unsafe { CFArray::wrap_under_create_rule(list) };
    let mut out = Vec::new();
    for dict in list.iter() {
        // Layer 0 is ordinary windows: not the menu bar, the Dock or a status item.
        if dict_number(&dict, "kCGWindowLayer") != Some(0) {
            continue;
        }
        let (Some(app), Some(pid), Some(id)) = (dict_string(&dict, "kCGWindowOwnerName"), dict_number(&dict, "kCGWindowOwnerPID"), dict_number(&dict, "kCGWindowNumber")) else {
            continue;
        };
        // The title needs Screen Recording; without it the app's name is what there is.
        let title = dict_string(&dict, "kCGWindowName").unwrap_or_default();
        out.push(OpenWindow { app, title, pid: pid as i32, id: id as u64 });
    }
    Ok(out)
}

/// One attribute of an element, owned.
fn attr(element: AXUIElementRef, name: &str) -> Option<CFType> {
    let key = CFString::new(name);
    let mut value: CFTypeRef = std::ptr::null();
    // SAFETY: `element` is a live AXUIElement; the value comes back under the Create rule.
    let error = unsafe { AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut value) };
    (error == 0 && !value.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(value) })
}

fn attr_string(element: AXUIElementRef, name: &str) -> Option<String> {
    attr(element, name).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
}

fn children(element: AXUIElementRef) -> Vec<CFType> {
    let Some(value) = attr(element, "AXChildren") else { return Vec::new() };
    let Some(array) = value.downcast::<CFArray>() else { return Vec::new() };
    array
        .get_all_values()
        .into_iter()
        .filter(|item| !item.is_null())
        // SAFETY: the array's items, retained here so they outlive it.
        .map(|item| unsafe { CFType::wrap_under_get_rule(item) })
        .collect()
}

/// Roles whose words are what a window says. Buttons, menus and images are the furniture around it.
const TEXT_ROLES: &[&str] = &["AXStaticText", "AXTextArea", "AXTextField", "AXHeading", "AXLink", "AXCell", "AXComboBox"];

fn walk(element: AXUIElementRef, depth: usize, seen: &mut usize, started: Instant, out: &mut Vec<String>) {
    if depth > MAX_DEPTH || *seen >= MAX_NODES || started.elapsed() > BUDGET {
        return;
    }
    *seen += 1;
    let role = attr_string(element, "AXRole").unwrap_or_default();
    let subrole = attr_string(element, "AXSubrole").unwrap_or_default();
    // A password field is never read — not its value, not its label.
    if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
        return;
    }
    if TEXT_ROLES.contains(&role.as_str()) {
        if let Some(text) = attr_string(element, "AXValue").or_else(|| attr_string(element, "AXTitle")).or_else(|| attr_string(element, "AXDescription")) {
            out.push(text);
        }
    } else if role == "AXGroup" || role == "AXRow" || role == "AXListItem" {
        // A chat message is often a group described as a whole («Juan, 10:42, hola…»).
        if let Some(text) = attr_string(element, "AXDescription").filter(|t| t.chars().count() > 15) {
            out.push(text);
        }
    }
    for child in children(element) {
        walk(child.as_CFTypeRef(), depth + 1, seen, started, out);
    }
}

/// The app's window to read: the main one, the focused one, or the first.
fn front_window(app: AXUIElementRef) -> Option<CFType> {
    attr(app, "AXMainWindow").or_else(|| attr(app, "AXFocusedWindow")).or_else(|| {
        let windows = attr(app, "AXWindows")?.downcast::<CFArray>()?;
        let first = *windows.get_all_values().first()?;
        // SAFETY: an item of the array, retained.
        (!first.is_null()).then(|| unsafe { CFType::wrap_under_get_rule(first) })
    })
}

pub fn accessible_text(window: &OpenWindow) -> Result<String, String> {
    // SAFETY: plain query.
    if !unsafe { AXIsProcessTrusted() } {
        return Err("CodeFlow needs the Accessibility permission to read other apps".into());
    }
    // SAFETY: an element for a running process, released by the wrapper.
    let app = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(window.pid)) };
    unsafe { AXUIElementSetMessagingTimeout(app.as_CFTypeRef(), 1.5) };
    let read = || {
        let mut out = Vec::new();
        if let Some(front) = front_window(app.as_CFTypeRef()) {
            let mut seen = 0;
            walk(front.as_CFTypeRef(), 0, &mut seen, Instant::now(), &mut out);
        }
        out.join("\n")
    };
    let text = read();
    if text.chars().count() >= 60 {
        return Ok(text);
    }
    // Electron and Chromium build their tree only for an assistive app that says it is one.
    let key = CFString::from_static_string("AXManualAccessibility");
    // SAFETY: a documented attribute set on the app element; an app without it answers an error.
    let enabled = unsafe { AXUIElementSetAttributeValue(app.as_CFTypeRef(), key.as_concrete_TypeRef(), CFBoolean::true_value().as_CFTypeRef()) } == 0;
    if !enabled {
        return Ok(text);
    }
    // The tree is built in the background once asked for: read again until it is there (measured on
    // an Electron app: empty at 600 ms the first time, whole on the next read).
    let asked = Instant::now();
    let mut text = text;
    while asked.elapsed() < Duration::from_millis(3_000) {
        std::thread::sleep(Duration::from_millis(400));
        text = read();
        if text.chars().count() >= 60 {
            break;
        }
    }
    Ok(text)
}

pub fn screenshot_text(window: &OpenWindow) -> Result<String, String> {
    // SAFETY: plain query.
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err("reading it from a screenshot needs the Screen Recording permission".into());
    }
    let shot = super::shot_path(window.pid)?;
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-t", "png", "-l"])
        .arg(window.id.to_string())
        .arg(&shot.0)
        .status()
        .map_err(|e| format!("the screenshot did not run: {e}"))?;
    if !status.success() {
        return Err(format!("{}'s window could not be captured", window.app));
    }
    let png = std::fs::read(&shot.0).map_err(|e| e.to_string())?;
    // Gone from disk before it is even read: from here it lives in memory only.
    drop(shot);
    recognize(&png)
}

/// The text Vision recognizes in a PNG, top to bottom, in Spanish and English.
pub fn recognize(png: &[u8]) -> Result<String, String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;
    let class = |name: &std::ffi::CStr| AnyClass::get(name).ok_or_else(|| format!("{} is not available", name.to_string_lossy()));
    objc2::rc::autoreleasepool(|_| {
        // SAFETY: Foundation and Vision called as documented, on objects created here; the two
        // `alloc`ed ones are released before returning, everything else is autoreleased.
        unsafe {
            let data: *mut AnyObject = msg_send![class(c"NSData")?, dataWithBytes: png.as_ptr() as *const c_void, length: png.len()];
            let options: *mut AnyObject = msg_send![class(c"NSDictionary")?, dictionary];
            let handler: *mut AnyObject = msg_send![class(c"VNImageRequestHandler")?, alloc];
            let handler: *mut AnyObject = msg_send![handler, initWithData: data, options: options];
            let request: *mut AnyObject = msg_send![class(c"VNRecognizeTextRequest")?, alloc];
            let request: *mut AnyObject = msg_send![request, init];
            if handler.is_null() || request.is_null() {
                return Err("the text recognizer could not start".to_string());
            }
            // Accurate (0), corrected, and in the app's two languages.
            let _: () = msg_send![request, setRecognitionLevel: 0isize];
            let _: () = msg_send![request, setUsesLanguageCorrection: true];
            let es = NSString::from_str("es-ES");
            let en = NSString::from_str("en-US");
            let languages: [*const NSString; 2] = [&*es, &*en];
            let languages: *mut AnyObject = msg_send![class(c"NSArray")?, arrayWithObjects: languages.as_ptr(), count: 2usize];
            let _: () = msg_send![request, setRecognitionLanguages: languages];
            let requests: *mut AnyObject = msg_send![class(c"NSArray")?, arrayWithObject: request];
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let ok: bool = msg_send![handler, performRequests: requests, error: &mut error];
            let mut lines = Vec::new();
            if ok {
                let results: *mut AnyObject = msg_send![request, results];
                let count: usize = if results.is_null() { 0 } else { msg_send![results, count] };
                for index in 0..count {
                    let observation: *mut AnyObject = msg_send![results, objectAtIndex: index];
                    let candidates: *mut AnyObject = msg_send![observation, topCandidates: 1usize];
                    let found: usize = msg_send![candidates, count];
                    if found == 0 {
                        continue;
                    }
                    let best: *mut AnyObject = msg_send![candidates, objectAtIndex: 0usize];
                    let text: *mut NSString = msg_send![best, string];
                    if !text.is_null() {
                        lines.push((*text).to_string());
                    }
                }
            }
            let _: () = msg_send![request, release];
            let _: () = msg_send![handler, release];
            if ok {
                Ok(lines.join("\n"))
            } else {
                Err("the text recognizer failed on the screenshot".to_string())
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window list needs no permission; the app running the tests is not necessarily on it.
    #[test]
    fn the_window_list_reads() {
        assert!(windows().is_ok());
    }

    /// What this machine shows and grants, and the front window of `CODI_READ_APP` (an app's name)
    /// read — the harness for trying it live: `CODI_READ_APP=Notes cargo test --lib live_read -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_read() {
        println!("{:?}", permissions());
        for window in windows().unwrap() {
            println!("{} · {} · pid {} · id {}", window.app, window.title, window.pid, window.id);
        }
        if let Ok(name) = std::env::var("CODI_READ_APP") {
            if let Some(window) = windows().unwrap().into_iter().find(|w| w.app == name) {
                let started = Instant::now();
                let ax = accessible_text(&window);
                println!("accessibility in {:?}: {:?}", started.elapsed(), ax.as_ref().map(|t| t.chars().take(300).collect::<String>()));
            }
            match super::super::read(&name) {
                Ok(reading) => println!("via {}:\n{}", reading.via, reading.text.chars().take(1500).collect::<String>()),
                Err(error) => println!("error: {error}"),
            }
        }
    }

    /// Vision reads a rendered page of text (`cupsfilter` + `sips`, both part of macOS). Ignored:
    /// it shells out and takes a second.
    #[test]
    #[ignore]
    fn vision_reads_text_off_an_image() {
        let dir = std::env::temp_dir().join(format!("codi-ocr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("a.txt");
        std::fs::write(&txt, "Mensaje nuevo de Juan: la reunion es a las 15:30\n").unwrap();
        let pdf = std::process::Command::new("/usr/sbin/cupsfilter").arg(&txt).output().unwrap();
        std::fs::write(dir.join("a.pdf"), &pdf.stdout).unwrap();
        // JPEG: no alpha. A PDF rendered to PNG is black text on transparency, which reads as black on black.
        let ok = std::process::Command::new("sips").args(["-s", "format", "jpeg"]).arg(dir.join("a.pdf")).arg("--out").arg(dir.join("a.png")).status().unwrap();
        assert!(ok.success());
        let text = recognize(&std::fs::read(dir.join("a.png")).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(text.contains("Juan") && text.contains("15:30"), "{text}");
    }
}
