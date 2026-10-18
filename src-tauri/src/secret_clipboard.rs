//! Copying a secret — a vault password, a TOTP code — and taking it back.
//!
//! The webview's `navigator.clipboard` could do the copy but not the rest:
//!
//! - **The clear outlived nothing.** It was a `setTimeout` in the page, so quitting within the delay
//!   left the password on the clipboard for the rest of the day; and it re-read the clipboard to
//!   check the text was still ours, a read WKWebView may refuse — silently, so nothing was cleared.
//! - **The secret went into clipboard history.** Win+V's history (and its cloud sync) and macOS
//!   clipboard managers kept a copy that no clear reaches.
//!
//! So the copy is native. The text is marked for monitors to skip — `org.nspasteboard.ConcealedType`
//! on macOS (the convention 1Password and Bitwarden use), and on Windows the three formats the
//! system's history and cloud clipboard honour. "Still ours" is the system's change counter, read
//! back right after the write: no re-read of the contents, and a clear never overwrites something
//! the user copied since. The pending clear also runs from the shutdown path.

use std::sync::Mutex;
use std::time::Duration;

/// The change counter right after the last secret was written, while its clear is still due.
static PENDING: Mutex<Option<i64>> = Mutex::new(None);

/// Puts `text` on the clipboard, hidden from clipboard history, and clears it after `clear_after`
/// unless something else has been copied in the meantime.
pub fn copy(text: &str, clear_after: Duration) -> Result<(), String> {
    let stamp = platform::write_concealed(text)?;
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(stamp);
    std::thread::Builder::new()
        .name("secret-clipboard".into())
        .spawn(move || {
            std::thread::sleep(clear_after);
            clear_if_still(stamp);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The shutdown path's step: a secret whose clear has not come round yet is cleared now.
pub fn clear_on_exit() {
    let pending = *PENDING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(stamp) = pending {
        clear_if_still(stamp);
    }
}

fn clear_if_still(stamp: i64) {
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    // A later copy owns the clear now.
    if *pending != Some(stamp) {
        return;
    }
    *pending = None;
    if platform::stamp() == Some(stamp) {
        platform::clear();
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;

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

    pub fn write_concealed(text: &str) -> Result<i64, String> {
        let board = pasteboard().ok_or("the clipboard is not available")?;
        autoreleasepool(|_| {
            let value = NSString::from_str(text);
            let plain = NSString::from_str("public.utf8-plain-text");
            let concealed = NSString::from_str("org.nspasteboard.ConcealedType");
            let empty = NSString::from_str("");
            // SAFETY: documented NSPasteboard messages with NSString arguments that outlive the calls.
            unsafe {
                let _: isize = msg_send![board, clearContents];
                let ok: Bool = msg_send![board, setString: &*value, forType: &*plain];
                if !ok.as_bool() {
                    return Err("couldn't write to the clipboard".to_string());
                }
                let _: Bool = msg_send![board, setString: &*empty, forType: &*concealed];
            }
            Ok(())
        })?;
        stamp().ok_or_else(|| "the clipboard is not available".to_string())
    }

    pub fn clear() {
        if let Some(board) = pasteboard() {
            // SAFETY: `clearContents` takes nothing and returns the new change count.
            let _: isize = unsafe { msg_send![board, clearContents] };
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW,
        SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    const CF_UNICODETEXT: u32 = 13;

    pub fn stamp() -> Option<i64> {
        // SAFETY: takes nothing; a counter the system bumps on every change.
        Some(i64::from(unsafe { GetClipboardSequenceNumber() }))
    }

    /// Another process may hold the clipboard for a moment; a few short tries before giving up.
    fn open() -> bool {
        for _ in 0..10 {
            // SAFETY: no owner window; paired with `CloseClipboard` by every caller.
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        false
    }

    /// Copies `bytes` into a movable global block, as `SetClipboardData` wants. The clipboard owns
    /// the block once that call succeeds; the caller frees it otherwise.
    unsafe fn global(bytes: &[u8]) -> Option<HANDLE> {
        let block = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
        if block.is_null() {
            return None;
        }
        let at = GlobalLock(block) as *mut u8;
        if at.is_null() {
            GlobalFree(block);
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), at, bytes.len());
        GlobalUnlock(block);
        Some(block)
    }

    unsafe fn set(format: u32, bytes: &[u8]) -> bool {
        let Some(block) = global(bytes) else { return false };
        if SetClipboardData(format, block).is_null() {
            GlobalFree(block);
            return false;
        }
        true
    }

    fn format(name: &str) -> u32 {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated wide string.
        unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
    }

    pub fn write_concealed(text: &str) -> Result<i64, String> {
        let wide: Vec<u8> = text
            .encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        let zero = 0u32.to_le_bytes();
        if !open() {
            return Err("the clipboard is busy".into());
        }
        // SAFETY: the clipboard is open for this block and closed at its end.
        let ok = unsafe {
            EmptyClipboard();
            let ok = set(CF_UNICODETEXT, &wide);
            if ok {
                // Kept out of Win+V's history and the cloud clipboard, and skipped by monitors.
                set(format("ExcludeClipboardContentFromMonitorProcessing"), &zero);
                set(format("CanIncludeInClipboardHistory"), &zero);
                set(format("CanUploadToCloudClipboard"), &zero);
            }
            CloseClipboard();
            ok
        };
        if !ok {
            return Err("couldn't write to the clipboard".into());
        }
        stamp().ok_or_else(|| "the clipboard is not available".into())
    }

    pub fn clear() {
        if open() {
            // SAFETY: opened just above.
            unsafe {
                EmptyClipboard();
                CloseClipboard();
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub fn stamp() -> Option<i64> {
        None
    }

    pub fn write_concealed(_text: &str) -> Result<i64, String> {
        Err("copying a secret is not supported on this system".into())
    }

    pub fn clear() {}
}
