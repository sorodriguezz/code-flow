//! Windows: the window list from `EnumWindows`, the text through UI Automation, the fallback through
//! `PrintWindow` and `Windows.Media.Ocr` — the screenshot never leaves memory.

use std::time::{Duration, Instant};

use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker, UIA_DataItemControlTypeId, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
    UIA_GroupControlTypeId, UIA_HeaderItemControlTypeId, UIA_HyperlinkControlTypeId, UIA_ListItemControlTypeId, UIA_TextControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
    PW_RENDERFULLCONTENT, WS_EX_TOOLWINDOW,
};

use super::{OpenWindow, Permissions};

const MAX_NODES: usize = 8_000;
const MAX_DEPTH: usize = 60;
const BUDGET: Duration = Duration::from_secs(4);

pub fn permissions() -> Permissions {
    Permissions { accessibility: true, screen: true, supported: true }
}

/// Windows asks nothing of the user to read another app.
pub fn ask(_kind: &str) {}

fn hwnd_of(id: u64) -> HWND {
    HWND(id as usize as *mut core::ffi::c_void)
}

fn window_title(hwnd: HWND) -> String {
    // SAFETY: reads into a buffer of the length the window reports.
    unsafe {
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let read = GetWindowTextW(hwnd, &mut buffer);
        String::from_utf16_lossy(&buffer[..read.max(0) as usize])
    }
}

fn exe_path(pid: u32) -> Option<String> {
    // SAFETY: a limited query handle, closed below; the buffer's size goes in and comes back.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        let done = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size);
        let _ = CloseHandle(process);
        done.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

/// An executable's «File description» (`ms-teams.exe` → «Microsoft Teams»), the name people know.
fn description(path: &str) -> Option<String> {
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the version block is read into a buffer of the size Windows reports, and every pointer
    // VerQueryValueW hands back points into that buffer, which outlives its use here.
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut block = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(wide.as_ptr()), None, size, block.as_mut_ptr().cast()).ok()?;
        let query = |sub: &str| -> Option<(*mut core::ffi::c_void, u32)> {
            let sub: Vec<u16> = sub.encode_utf16().chain(Some(0)).collect();
            let mut value = std::ptr::null_mut();
            let mut length = 0u32;
            VerQueryValueW(block.as_ptr().cast(), PCWSTR(sub.as_ptr()), &mut value, &mut length).as_bool().then_some((value, length))
        };
        let (translation, length) = query(r"\VarFileInfo\Translation")?;
        if length < 4 {
            return None;
        }
        let pair = translation as *const u16;
        let (language, codepage) = (*pair, *pair.add(1));
        let (text, length) = query(&format!(r"\StringFileInfo\{language:04x}{codepage:04x}\FileDescription"))?;
        let chars = std::slice::from_raw_parts(text as *const u16, length.saturating_sub(1) as usize);
        let name = String::from_utf16_lossy(chars).trim().to_string();
        (!name.is_empty()).then_some(name)
    }
}

unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
    let found = &mut *(found.0 as *mut Vec<HWND>);
    found.push(hwnd);
    BOOL(1)
}

pub fn windows() -> Result<Vec<OpenWindow>, String> {
    let mut found: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into the vector whose address it is given, for this call.
    unsafe { EnumWindows(Some(collect), LPARAM(&mut found as *mut Vec<HWND> as isize)) }.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for hwnd in found {
        // SAFETY: plain queries on a window handle EnumWindows just gave.
        let (visible, tool, owned) = unsafe {
            (
                IsWindowVisible(hwnd).as_bool(),
                GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0,
                GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.0.is_null()),
            )
        };
        if !visible || tool || owned {
            continue;
        }
        let title = window_title(hwnd);
        if title.trim().is_empty() {
            continue;
        }
        let mut pid = 0u32;
        // SAFETY: as above.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let path = exe_path(pid).unwrap_or_default();
        let stem = std::path::Path::new(&path).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let app = description(&path).unwrap_or(stem);
        out.push(OpenWindow { app, title, pid: pid as i32, id: hwnd.0 as usize as u64 });
    }
    Ok(out)
}

fn automation() -> Result<IUIAutomation, String> {
    // SAFETY: COM for this thread (a blocking worker); an already initialised thread answers S_FALSE
    // or RPC_E_CHANGED_MODE, and either way the in-process automation object can be created.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|e| format!("UI Automation is not available: {e}"))
    }
}

fn walk(walker: &IUIAutomationTreeWalker, element: &IUIAutomationElement, depth: usize, seen: &mut usize, started: Instant, out: &mut Vec<String>) {
    if depth > MAX_DEPTH || *seen >= MAX_NODES || started.elapsed() > BUDGET {
        return;
    }
    *seen += 1;
    // SAFETY: property reads on a live element of the tree being walked.
    unsafe {
        // A password field is never read — not its value, not its label.
        if element.CurrentIsPassword().is_ok_and(|p| p.as_bool()) {
            return;
        }
        let kind = element.CurrentControlType().unwrap_or_default();
        let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
        let wanted = [UIA_TextControlTypeId, UIA_HyperlinkControlTypeId, UIA_ListItemControlTypeId, UIA_DataItemControlTypeId, UIA_HeaderItemControlTypeId, UIA_EditControlTypeId, UIA_DocumentControlTypeId];
        if wanted.contains(&kind) && !name.trim().is_empty() {
            out.push(name);
        } else if kind == UIA_GroupControlTypeId && name.chars().count() > 15 {
            // A chat message is often a group named as a whole («Juan, 10:42, hola…»).
            out.push(name);
        }
        let mut child = walker.GetFirstChildElement(element).ok();
        while let Some(current) = child {
            walk(walker, &current, depth + 1, seen, started, out);
            if *seen >= MAX_NODES || started.elapsed() > BUDGET {
                break;
            }
            child = walker.GetNextSiblingElement(&current).ok();
        }
    }
}

pub fn accessible_text(window: &OpenWindow) -> Result<String, String> {
    let uia = automation()?;
    // SAFETY: the element for a window handle from the list, and the control view's walker.
    let (root, walker) = unsafe {
        (
            uia.ElementFromHandle(hwnd_of(window.id)).map_err(|e| format!("{}'s window could not be read: {e}", window.app))?,
            uia.ControlViewWalker().map_err(|e| e.to_string())?,
        )
    };
    let read = || {
        let mut out = Vec::new();
        let mut seen = 0;
        walk(&walker, &root, 0, &mut seen, Instant::now(), &mut out);
        out.join("\n")
    };
    // Chromium and WebView2 (the new Teams) build their tree when a client first asks: read again
    // until it is there.
    let asked = Instant::now();
    let mut text = read();
    while text.chars().count() < 60 && asked.elapsed() < Duration::from_millis(3_000) {
        std::thread::sleep(Duration::from_millis(400));
        text = read();
    }
    Ok(text)
}

/// The window's pixels, BGRA top-down, in memory: `PrintWindow` asks the app to draw itself, so a
/// window behind others is read whole.
fn capture(hwnd: HWND) -> Result<(Vec<u8>, i32, i32), String> {
    // SAFETY: GDI objects created here are selected out and deleted on every path; the pixel buffer
    // is the size GetDIBits is told.
    unsafe {
        if IsIconic(hwnd).as_bool() {
            return Err("the window is minimized — bring it up to read it".into());
        }
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
        if width <= 0 || height <= 0 {
            return Err("the window has no size".into());
        }
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        let drawn = PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative: top-down rows.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let rows = GetDIBits(memory, bitmap, 0, height as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(memory, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        if !drawn || rows == 0 {
            return Err("the window could not be captured".into());
        }
        // GDI leaves alpha at 0: opaque, or the recognizer reads nothing.
        for alpha in pixels.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }
        Ok((pixels, width, height))
    }
}

pub fn screenshot_text(window: &OpenWindow) -> Result<String, String> {
    let (pixels, width, height) = capture(hwnd_of(window.id))?;
    let ocr = || -> windows::core::Result<String> {
        let buffer = CryptographicBuffer::CreateFromByteArray(&pixels)?;
        let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Bgra8, width, height, BitmapAlphaMode::Premultiplied)?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let result = engine.RecognizeAsync(&bitmap)?.get()?;
        let lines = result.Lines()?;
        let mut out = Vec::new();
        for index in 0..lines.Size()? {
            out.push(lines.GetAt(index)?.Text()?.to_string());
        }
        Ok(out.join("\n"))
    };
    // The pixels go with this function: nothing of the screenshot is kept.
    ocr().map_err(|e| format!("the text recognizer failed: {e}"))
}
