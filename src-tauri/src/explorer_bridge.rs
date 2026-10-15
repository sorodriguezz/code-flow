//! What the editor's explorer needs from outside its own webview: the files the user copied in the
//! system's file manager, and which of this app's other windows a drag was released over.
//!
//! # The system clipboard, read only for files
//!
//! The explorer's own Copy/Cut never touches the system clipboard (see `explorerClipboardStore`):
//! it keeps paths in the app. But a ⌘C on a file in Finder or Explorer puts *file references* on the
//! system clipboard, and ⌘V in the tree should paste those. So the tree asks two things:
//! - [`system_clipboard_stamp`]: the system's change counter (`NSPasteboard.changeCount`,
//!   `GetClipboardSequenceNumber`). The explorer records it when it copies; when it has moved on by
//!   the time of the paste, something was copied *after* the explorer's Copy, and if that something
//!   is files, those win.
//! - [`system_clipboard_files`]: the absolute paths of the files on it, and the counter they were
//!   read at. Nothing else is ever read — text on the clipboard stays the user's business.
//!
//! A Finder "cut" (⌘C then ⌥⌘V) is a decision made at the paste, not something the clipboard says,
//! so a paste from outside is always a copy.
//!
//! # A drag released over another window
//!
//! The explorer's drag is pointer-driven (Tauri's native drop handler swallows HTML5 drags, see
//! `treeDragStore`), so the window it started in keeps getting the pointer until the button comes
//! up — wherever that is. [`window_under_cursor`] answers where it came up: which of this app's
//! *other* windows is under the pointer, frontmost first, and where in its page. The page then
//! hands the paths to that window over the window bus.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// The files on the system clipboard, and the change counter they were read at.
#[derive(Debug, Clone, Serialize)]
pub struct SystemClipboardFiles {
    /// `None` where the platform keeps no counter (Linux).
    pub stamp: Option<i64>,
    /// Absolute paths, in the order the file manager put them there. Empty when what is on the
    /// clipboard is not files.
    pub paths: Vec<String>,
}

/// The system clipboard's change counter, `None` where there is none.
///
/// A plain (not `async`) command, so it runs on the main thread: AppKit's pasteboard is read there.
#[tauri::command]
pub fn system_clipboard_stamp() -> Option<i64> {
    platform::stamp()
}

/// The file paths on the system clipboard — see the module note.
#[tauri::command]
pub fn system_clipboard_files() -> SystemClipboardFiles {
    let stamp = platform::stamp();
    let paths = platform::files()
        .into_iter()
        .filter(|path| std::path::Path::new(path).exists())
        .collect();
    SystemClipboardFiles { stamp, paths }
}

/// Another window of this app, and a point in its page in CSS pixels.
#[derive(Debug, Clone, Serialize)]
pub struct WindowPoint {
    pub label: String,
    pub x: f64,
    pub y: f64,
}

struct Hit<R: Runtime> {
    window: tauri::WebviewWindow<R>,
    x: f64,
    y: f64,
}

/// Which of this app's windows — other than the one asking — is under the pointer, and where.
/// `None` when the pointer is over none of them (the desktop, another app), or when the asking
/// window is the frontmost one there.
///
/// Where windows overlap the frontmost one wins: AppKit's `orderedWindows` on macOS, and the window
/// `WindowFromPoint` names on Windows. Elsewhere the first one found.
#[tauri::command]
pub fn window_under_cursor<R: Runtime>(app: AppHandle<R>, window: tauri::Window<R>) -> Option<WindowPoint> {
    let cursor = app.cursor_position().ok()?;
    let mut hits: Vec<Hit<R>> = Vec::new();
    // The asking window is a candidate too: when it is in front at the pointer, the drag was
    // released over itself, and whatever is behind it is not where the user aimed.
    for (_, candidate) in app.webview_windows() {
        if !candidate.is_visible().unwrap_or(false) || candidate.is_minimized().unwrap_or(false) {
            continue;
        }
        let (Ok(position), Ok(size)) = (candidate.inner_position(), candidate.inner_size()) else {
            continue;
        };
        let (left, top) = (f64::from(position.x), f64::from(position.y));
        let inside = cursor.x >= left
            && cursor.y >= top
            && cursor.x < left + f64::from(size.width)
            && cursor.y < top + f64::from(size.height);
        if !inside {
            continue;
        }
        let scale = candidate.scale_factor().unwrap_or(1.0).max(0.1);
        hits.push(Hit { window: candidate, x: (cursor.x - left) / scale, y: (cursor.y - top) / scale });
    }
    let asking = window.label();
    let index = platform::frontmost(&hits, cursor.x, cursor.y)
        .or_else(|| hits.iter().position(|hit| hit.window.label() != asking))?;
    let hit = hits.into_iter().nth(index)?;
    if hit.window.label() == asking {
        return None;
    }
    Some(WindowPoint { label: hit.window.label().to_string(), x: hit.x, y: hit.y })
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Hit;
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;
    use tauri::Runtime;

    fn pasteboard() -> Option<*mut AnyObject> {
        let class = AnyClass::get(c"NSPasteboard")?;
        // SAFETY: a class method returning the shared general pasteboard (never released).
        let board: *mut AnyObject = unsafe { msg_send![class, generalPasteboard] };
        (!board.is_null()).then_some(board)
    }

    pub fn stamp() -> Option<i64> {
        let board = pasteboard()?;
        // SAFETY: `changeCount` is an NSInteger property of NSPasteboard.
        let count: isize = unsafe { msg_send![board, changeCount] };
        Some(count as i64)
    }

    /// Every item's `public.file-url`, as a path. Through `NSURL`'s `filePathURL` rather than by
    /// decoding the string by hand, so a file *reference* URL (`file:///.file/id=…`) resolves too.
    pub fn files() -> Vec<String> {
        let Some(board) = pasteboard() else { return Vec::new() };
        let Some(url_class) = AnyClass::get(c"NSURL") else { return Vec::new() };
        autoreleasepool(|_| {
            let mut out = Vec::new();
            let file_url = NSString::from_str("public.file-url");
            // SAFETY: documented NSPasteboard / NSPasteboardItem / NSURL messages, each checked for
            // nil before use; everything returned is autoreleased into the pool around this block,
            // and the strings are copied out before it drains.
            unsafe {
                let items: *mut AnyObject = msg_send![board, pasteboardItems];
                if items.is_null() {
                    return out;
                }
                let count: usize = msg_send![items, count];
                for index in 0..count {
                    let item: *mut AnyObject = msg_send![items, objectAtIndex: index];
                    if item.is_null() {
                        continue;
                    }
                    let text: *mut NSString = msg_send![item, stringForType: &*file_url];
                    if text.is_null() {
                        continue;
                    }
                    let url: *mut AnyObject = msg_send![url_class, URLWithString: text];
                    if url.is_null() {
                        continue;
                    }
                    let resolved: *mut AnyObject = msg_send![url, filePathURL];
                    if resolved.is_null() {
                        continue;
                    }
                    let path: *mut NSString = msg_send![resolved, path];
                    if path.is_null() {
                        continue;
                    }
                    out.push((*path).to_string());
                }
            }
            out
        })
    }

    /// The hit whose `NSWindow` comes first in the app's front-to-back window order.
    pub fn frontmost<R: Runtime>(hits: &[Hit<R>], _x: f64, _y: f64) -> Option<usize> {
        if hits.len() < 2 {
            return None;
        }
        let handles: Vec<*mut std::ffi::c_void> =
            hits.iter().map(|hit| hit.window.ns_window().unwrap_or(std::ptr::null_mut())).collect();
        let class = AnyClass::get(c"NSApplication")?;
        autoreleasepool(|_| {
            // SAFETY: `sharedApplication` and `orderedWindows` are main-thread AppKit calls, and this
            // runs from a plain (main-thread) command; the array is read before the pool drains.
            unsafe {
                let app: *mut AnyObject = msg_send![class, sharedApplication];
                if app.is_null() {
                    return None;
                }
                let ordered: *mut AnyObject = msg_send![app, orderedWindows];
                if ordered.is_null() {
                    return None;
                }
                let count: usize = msg_send![ordered, count];
                for index in 0..count {
                    let window: *mut AnyObject = msg_send![ordered, objectAtIndex: index];
                    if let Some(found) = handles.iter().position(|h| !h.is_null() && *h == window.cast()) {
                        return Some(found);
                    }
                }
                None
            }
        })
    }
}

#[cfg(windows)]
mod platform {
    use super::Hit;
    use tauri::Runtime;
    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
        OpenClipboard,
    };
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};

    /// `CF_HDROP`: the list of files Explorer puts on the clipboard.
    const CF_HDROP: u32 = 15;

    pub fn stamp() -> Option<i64> {
        // SAFETY: takes nothing; a counter the system bumps on every change.
        Some(i64::from(unsafe { GetClipboardSequenceNumber() }))
    }

    pub fn files() -> Vec<String> {
        let mut out = Vec::new();
        // SAFETY: the clipboard is opened, read and closed within this block; the handle it hands
        // out stays valid until `CloseClipboard`, and every buffer passed is sized to the length
        // `DragQueryFileW` reported, plus the terminator.
        unsafe {
            if IsClipboardFormatAvailable(CF_HDROP) == 0 {
                return out;
            }
            // Another process may hold it for a moment; a few short tries before giving up.
            let mut opened = false;
            for _ in 0..5 {
                if OpenClipboard(std::ptr::null_mut()) != 0 {
                    opened = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if !opened {
                return out;
            }
            let handle = GetClipboardData(CF_HDROP);
            if !handle.is_null() {
                let drop = handle as HDROP;
                let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
                for index in 0..count {
                    let len = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
                    if len == 0 {
                        continue;
                    }
                    let mut buffer = vec![0u16; len as usize + 1];
                    let written = DragQueryFileW(drop, index, buffer.as_mut_ptr(), len + 1);
                    out.push(String::from_utf16_lossy(&buffer[..written as usize]));
                }
            }
            CloseClipboard();
        }
        out
    }

    /// The hit whose window is the top-level window `WindowFromPoint` finds at the cursor.
    pub fn frontmost<R: Runtime>(hits: &[Hit<R>], x: f64, y: f64) -> Option<usize> {
        if hits.len() < 2 {
            return None;
        }
        let point = POINT { x: x.round() as i32, y: y.round() as i32 };
        // SAFETY: plain window-manager queries on a point and the handle they return.
        let top: HWND = unsafe {
            let under = WindowFromPoint(point);
            if under.is_null() {
                return None;
            }
            GetAncestor(under, GA_ROOT)
        };
        hits.iter().position(|hit| hit.window.hwnd().is_ok_and(|handle| handle.0 as HWND == top))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::Hit;
    use tauri::Runtime;

    pub fn stamp() -> Option<i64> {
        None
    }

    pub fn files() -> Vec<String> {
        Vec::new()
    }

    pub fn frontmost<R: Runtime>(_hits: &[Hit<R>], _x: f64, _y: f64) -> Option<usize> {
        None
    }
}
