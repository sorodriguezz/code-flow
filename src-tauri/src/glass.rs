//! The see-through window — Apariencia › Modo y color › Transparencia. **macOS only.**
//!
//! Two halves, on opposite sides of the bridge on purpose:
//!
//! - **The backdrop is native.** Only the platform can blur what is behind a window: the window
//!   server's background blur, a plain blur with no tone of its own. Applied here, per window, by
//!   [`apply_native`].
//! - **The tint is CSS.** How much of the scheme's own colours covers that backdrop is the slider,
//!   and `index.css` paints it from `data-glass` plus the percentages [`fills`] computes. The
//!   frontend's `lib/windowGlass.ts` computes the same numbers; the tests on both sides pin them to
//!   each other.
//!
//! ## Why not Windows
//!
//! Windows had the setting until 2.3.40 and lost it (the user's call, 2026-10-18). Every DWM blur —
//! the accent policy's blur and acrylic, the system Acrylic — is composited as an opaque fallback
//! colour whenever DWM decides not to blur (transparency effects off, energy saver, a DWM policy in
//! the registry, or one changed since DWM started), and nothing an app can ask says beforehand when
//! that is: the clear blur came out **black**, the Acrylic a flat grey. A window that may turn black
//! on a user's machine is worse than no setting. So [`stored`] reads it as off there, the switch is
//! not shown, and [`apply_native`] does nothing.
//!
//! ## Every window is created transparent, always
//!
//! macOS cannot make an opaque window transparent after it exists — the flag reaches the window,
//! the webview and the webview's `drawsBackground` at creation only. So the windows are always built
//! transparent and the page decides: with the setting off, `body` paints its own opaque tone edge to
//! edge and nothing behind it can show, which is exactly the window this app always had. That is
//! what lets the switch work live instead of after a restart. (Windows builds them transparent too,
//! as it has since the setting arrived there; with the switch gone the page is always opaque.)
//!
//! ## Why not Tauri's own `setEffects`
//!
//! On macOS it cannot be undone and it cannot be repeated: `clearEffects` does nothing there (the
//! macOS arm of `set_window_effects(None)` is empty), and every `setEffects` adds *another* effect
//! view on top of the last — so switching twice stacked two blurs. `window-vibrancy` (already in the
//! tree through Tauri, so naming it compiles nothing) tags the view it adds and removes it by tag.

use tauri::{AppHandle, Manager, Theme, WebviewWindow};

/// `"true"` when the window lets the desktop through. Unset means off: a window you can see
/// through is a look to ask for, not one to find.
pub const ENABLED_KEY: &str = "window_glass";
/// 0–100, how see-through. Unset means [`DEFAULT_LEVEL`].
pub const LEVEL_KEY: &str = "window_glass_level";
/// The light/dark preference `themeStore` writes — read here so the backdrop starts in the
/// appearance the page is about to paint.
const THEME_KEY: &str = "theme_preference";
pub const DEFAULT_LEVEL: u8 = 50;

/// What the database says, read once when a window is built.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glass {
    pub enabled: bool,
    pub level: u8,
    /// `None` is "follow the system" — both the stored `"system"` and a missing row.
    pub theme: Option<Theme>,
}

/// How much of each layer's own colour covers the backdrop, in percent.
///
/// Two layers because the window has two: the **frame** (title row, projects, rail, status bar)
/// and the **sheets** on it (the view, the assistant, the dock). A sheet sits over the frame, so
/// what shows through a sheet is what gets through both — which is why the sheet's own number
/// falls more slowly: at the far end of the slider the frame is mostly backdrop and the work is
/// still mostly the work. `solo` is the two combined, for a window that is one sheet and no frame
/// (the quick-ask box).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fills {
    pub frame: f64,
    pub sheet: f64,
    pub solo: f64,
}

pub fn fills(level: u8) -> Fills {
    let t = f64::from(level.min(100)) / 100.0;
    let frame = 60.0 - 55.0 * t;
    let sheet = 70.0 - 50.0 * t;
    let solo = 100.0 - (100.0 - frame) * (100.0 - sheet) / 100.0;
    Fills { frame, sheet, solo }
}

/// Reads the three rows in one lock. Anything unreadable is the default: off — and off everywhere
/// but macOS, whatever the row says (see "Why not Windows" above): a Windows install that switched it
/// on before 2.3.41 opens opaque.
pub fn stored(app: &AppHandle) -> Glass {
    let rows = app
        .state::<crate::db::Db>()
        .0
        .lock()
        .ok()
        .and_then(|conn| {
            let keys = [ENABLED_KEY, LEVEL_KEY, THEME_KEY].map(String::from);
            crate::db::queries::get_settings(&conn, &keys).ok()
        })
        .unwrap_or_default();
    Glass {
        enabled: cfg!(target_os = "macos") && rows.get(ENABLED_KEY).map(String::as_str) == Some("true"),
        level: rows
            .get(LEVEL_KEY)
            .and_then(|raw| raw.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .map(|value| value.round().clamp(0.0, 100.0) as u8)
            .unwrap_or(DEFAULT_LEVEL),
        theme: parse_theme(rows.get(THEME_KEY).map(String::as_str)),
    }
}

fn parse_theme(raw: Option<&str>) -> Option<Theme> {
    match raw {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        _ => None,
    }
}

/// A script that stamps `data-glass` on the page before its first paint.
///
/// Without it a window opening see-through would show the backdrop, then the opaque app (the CSS
/// has loaded, the setting has not been read yet), then the see-through app — a flash in the one
/// moment everybody looks at a window. The store re-reads the rows once it boots, so this only has
/// to be right for the first frames.
///
/// `document.documentElement` can still be null when WebView2 runs a document-created script
/// (WebKit already has it), hence the observer for the moment `<html>` arrives. Nothing at all when
/// the setting is off: that window is the one the app always had.
pub fn init_script(glass: &Glass) -> Option<String> {
    if !glass.enabled {
        return None;
    }
    let Fills { frame, sheet, solo } = fills(glass.level);
    Some(format!(
        r#"(function () {{
  var stamp = function () {{
    var root = document.documentElement;
    if (!root) return false;
    root.setAttribute("data-glass", "");
    root.style.setProperty("--cf-glass-frame", "{frame:.1}%");
    root.style.setProperty("--cf-glass-sheet", "{sheet:.1}%");
    root.style.setProperty("--cf-glass-solo", "{solo:.1}%");
    return true;
  }};
  if (!stamp()) {{
    var watch = new MutationObserver(function () {{ if (stamp()) watch.disconnect(); }});
    watch.observe(document, {{ childList: true }});
  }}
}})();"#
    ))
}

/// Puts the backdrop on a window that was just built, when the setting says so.
///
/// Before the page has painted anything, so a window opening see-through shows the blur from its
/// first frame rather than a bare hole in the desktop.
pub fn on_create(window: &WebviewWindow, glass: &Glass) {
    if !glass.enabled {
        return;
    }
    if let Err(e) = apply_native(window, true, glass.theme) {
        crate::applog::info(&format!("window: glass backdrop unavailable — {e}"));
    }
}

/// Switches one window's backdrop, and the appearance it is tinted in, on or off.
///
/// **The appearance travels with it.** macOS tints the backdrop by the *window's* appearance, not
/// the page's: a dark scheme over a light vibrancy (the system in light mode, the app in dark) is a
/// milky grey. So while the backdrop is on the window takes the app's explicit light/dark choice —
/// and "system" stays `None`, because an explicit appearance would also pin the webview's
/// `prefers-color-scheme`, and "system" is read from exactly that media query. Off, the window goes
/// back to following the system, which is what it did before this setting existed.
///
/// Nothing anywhere else — the setting is macOS's alone (see "Why not Windows" above).
pub fn apply_native(window: &WebviewWindow, enabled: bool, theme: Option<Theme>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        // AppKit refuses to be touched off the main thread (`apply_vibrancy` checks).
        window.run_on_main_thread(move || backdrop(&target, enabled))?;
        window.set_theme(if enabled { theme } else { None })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, enabled, theme);
        Ok(())
    }
}

/// How far the desktop behind a see-through window is blurred, in points.
#[cfg(target_os = "macos")]
const BLUR_RADIUS: i32 = 30;

/// **A plain blur, no material** (the user, 2026-10-18: "la gracia es que sea full
/// transparente/acrílico y el color del tema se pinte apenas"). Every `NSVisualEffectView` material
/// carries a tone of its own — the HUD one this used lifted a dark scheme to a milky grey, and the
/// theme could only win it back by covering it, which is the opaque window again. The window
/// server's background blur (what iTerm2, kitty and Ghostty use for the same look) blurs what is
/// behind and adds nothing, so the page's thin coat of the scheme is the only colour on it. Private
/// API, as `macos-private-api` already is for this window; should it ever refuse, the HUD material
/// is put back rather than leaving a sharp, unreadable desktop behind the text.
#[cfg(target_os = "macos")]
fn backdrop(window: &WebviewWindow, enabled: bool) {
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    // Every `apply_vibrancy` adds a view and `clear_vibrancy` removes one: clear them all, whatever
    // put them there.
    while let Ok(true) = clear_vibrancy(window) {}
    if !enabled {
        window_blur(window, 0);
        return;
    }
    // A rounded window (Codi's) takes the effect view, which rounds with it: the window server's
    // blur covers the window's whole rectangle and would leave its corners frosted.
    let rounded = (window.label() == crate::windows::codi_label()).then_some(crate::windows::CODI_CORNER_RADIUS);
    if rounded.is_none() && window_blur(window, BLUR_RADIUS) {
        return;
    }
    // `Active` rather than following the window's focus: a window that turns grey and opaque every
    // time another app is clicked reads as a glitch.
    if let Err(e) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::Active),
        rounded,
    ) {
        crate::applog::info(&format!("window: vibrancy refused — {e:?}"));
    }
}

/// Rounds a frameless window's corners, `radius` points: its content view clips to them, and the
/// shadow is redrawn around the new shape. Elsewhere the page's own rounding is the whole of it — a
/// transparent window shows nothing past the sheet.
pub fn round_corners(window: &WebviewWindow, radius: f64) {
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2::runtime::AnyObject;
            let Ok(ns_window) = target.ns_window() else { return };
            let ns_window = ns_window.cast::<AnyObject>();
            // SAFETY: `ns_window` is this window's live `NSWindow`, used on the main thread; its
            // content view is an `NSView`, layer-backed once `wantsLayer` is set, and every call
            // below is a plain setter on those two.
            unsafe {
                let view: *mut AnyObject = objc2::msg_send![ns_window, contentView];
                if view.is_null() {
                    return;
                }
                let _: () = objc2::msg_send![view, setWantsLayer: true];
                let layer: *mut AnyObject = objc2::msg_send![view, layer];
                if !layer.is_null() {
                    let _: () = objc2::msg_send![layer, setCornerRadius: radius];
                    let _: () = objc2::msg_send![layer, setMasksToBounds: true];
                }
                let _: () = objc2::msg_send![ns_window, invalidateShadow];
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, radius);
}

/// Sets the window server's blur behind `window`; `0` takes it off. Whether it took.
#[cfg(target_os = "macos")]
fn window_blur(window: &WebviewWindow, radius: i32) -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSMainConnectionID() -> i32;
        fn CGSSetWindowBackgroundBlurRadius(connection: i32, window: isize, radius: i32) -> i32;
    }
    let Ok(ns_window) = window.ns_window() else { return false };
    // SAFETY: `ns_window` is this window's live `NSWindow`, read on the main thread; `windowNumber`
    // takes no arguments and returns an `NSInteger`.
    let number: isize = unsafe { objc2::msg_send![ns_window.cast::<objc2::runtime::AnyObject>(), windowNumber] };
    // SAFETY: both are plain C calls on the window server's connection, with the window's own number.
    let status = unsafe { CGSSetWindowBackgroundBlurRadius(CGSMainConnectionID(), number, radius) };
    if status != 0 {
        crate::applog::info(&format!("window: background blur refused — CGError {status}"));
    }
    status == 0
}

/// The page's half of the switch, and of the light/dark change while the switch is on — see
/// [`apply_native`]. `theme` is the stored preference as `themeStore` writes it.
#[tauri::command]
pub async fn set_window_glass(
    window: WebviewWindow,
    enabled: bool,
    theme: Option<String>,
) -> Result<(), String> {
    apply_native(&window, enabled, parse_theme(theme.as_deref())).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same three points `lib/windowGlass.test.ts` pins — the two sides must agree, or a window
    /// opens at one tint and jumps to another when its store boots.
    #[test]
    fn fills_match_the_frontend() {
        assert_eq!(fills(0), Fills { frame: 60.0, sheet: 70.0, solo: 88.0 });
        assert_eq!(fills(50), Fills { frame: 32.5, sheet: 45.0, solo: 62.875 });
        assert_eq!(fills(100), Fills { frame: 5.0, sheet: 20.0, solo: 24.0 });
    }

    #[test]
    fn a_level_past_the_end_is_the_end() {
        assert_eq!(fills(250), fills(100));
    }

    #[test]
    fn no_script_while_off() {
        let off = Glass { enabled: false, level: 50, theme: None };
        assert!(init_script(&off).is_none());
    }

    #[test]
    fn the_script_stamps_the_level_it_was_given() {
        let on = Glass { enabled: true, level: 100, theme: None };
        let script = init_script(&on).expect("a script while on");
        assert!(script.contains(r#"setAttribute("data-glass", "")"#));
        assert!(script.contains(r#""--cf-glass-frame", "5.0%""#));
        assert!(script.contains(r#""--cf-glass-sheet", "20.0%""#));
        assert!(script.contains(r#""--cf-glass-solo", "24.0%""#));
    }

    #[test]
    fn only_explicit_modes_pin_the_appearance() {
        assert_eq!(parse_theme(Some("dark")), Some(Theme::Dark));
        assert_eq!(parse_theme(Some("light")), Some(Theme::Light));
        assert_eq!(parse_theme(Some("system")), None);
        assert_eq!(parse_theme(None), None);
    }
}
