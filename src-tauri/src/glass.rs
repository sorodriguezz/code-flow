//! The see-through window — Apariencia › Modo y color › Transparencia.
//!
//! Two halves, on opposite sides of the bridge on purpose:
//!
//! - **The backdrop is native.** Only the platform can blur what is behind a window: macOS puts an
//!   `NSVisualEffectView` under the webview (vibrancy), Windows a DWM system backdrop. Applied here,
//!   per window, by [`apply_native`].
//! - **The tint is CSS.** How much of the scheme's own colours covers that backdrop is the slider,
//!   and `index.css` paints it from `data-glass` plus the percentages [`fills`] computes. The
//!   frontend's `lib/windowGlass.ts` computes the same numbers; the tests on both sides pin them to
//!   each other.
//!
//! ## Every window is created transparent, always
//!
//! Neither platform can make an opaque window transparent after it exists — the flag reaches the
//! window, the webview and (on macOS) the webview's `drawsBackground` at creation only. So the
//! windows are always built transparent and the page decides: with the setting off, `body` paints
//! its own opaque tone edge to edge and nothing behind it can show, which is exactly the window
//! this app always had. That is what lets the switch work live instead of after a restart.
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
    let frame = 80.0 - 65.0 * t;
    let sheet = 80.0 - 50.0 * t;
    let solo = 100.0 - (100.0 - frame) * (100.0 - sheet) / 100.0;
    Fills { frame, sheet, solo }
}

/// Reads the three rows in one lock. Anything unreadable is the default: off.
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
        enabled: rows.get(ENABLED_KEY).map(String::as_str) == Some("true"),
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
/// **The appearance travels with it.** Both platforms tint the backdrop by the *window's*
/// appearance, not the page's: a dark scheme over a light vibrancy (the system in light mode, the
/// app in dark) is a milky grey. So while the backdrop is on the window takes the app's explicit
/// light/dark choice — and "system" stays `None`, because an explicit appearance would also pin the
/// webview's `prefers-color-scheme`, and "system" is read from exactly that media query. Off, the
/// window goes back to following the system, which is what it did before this setting existed.
pub fn apply_native(window: &WebviewWindow, enabled: bool, theme: Option<Theme>) -> tauri::Result<()> {
    let target = window.clone();
    // AppKit refuses to be touched off the main thread (`apply_vibrancy` checks), and DWM is happiest
    // on the thread that owns the window.
    window.run_on_main_thread(move || backdrop(&target, enabled))?;
    window.set_theme(if enabled { theme } else { None })
}

#[cfg(target_os = "macos")]
fn backdrop(window: &WebviewWindow, enabled: bool) {
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    // Every `apply_vibrancy` adds a view and `clear_vibrancy` removes one, so a window switched on
    // twice would stack two blurs. Clear them all, then add one.
    while let Ok(true) = clear_vibrancy(window) {}
    if !enabled {
        return;
    }
    // `Active` rather than following the window's focus: the whole window is the effect here, and a
    // window that turns grey and opaque every time another app is clicked reads as a glitch.
    if let Err(e) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::UnderWindowBackground,
        Some(NSVisualEffectState::Active),
        None,
    ) {
        crate::applog::info(&format!("window: vibrancy refused — {e:?}"));
    }
}

#[cfg(windows)]
fn backdrop(window: &WebviewWindow, enabled: bool) {
    use window_vibrancy::{apply_acrylic, apply_blur, apply_mica, clear_acrylic, clear_blur, clear_mica};
    // All three, whatever was applied: switching builds of Windows is not a thing, but a failed
    // apply of one kind after a successful one of another is, and clearing is harmless.
    let _ = clear_acrylic(window);
    let _ = clear_mica(window);
    let _ = clear_blur(window);
    if !enabled {
        return;
    }
    let result = match windows_backdrop(windows_build()) {
        WindowsBackdrop::Acrylic => apply_acrylic(window, None),
        WindowsBackdrop::Mica => apply_mica(window, None),
        // No tint of its own: the page paints the scheme's colour over it.
        WindowsBackdrop::Blur => apply_blur(window, Some((0, 0, 0, 0))),
    };
    if let Err(e) = result {
        crate::applog::info(&format!("window: backdrop refused — {e:?}"));
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn backdrop(_window: &WebviewWindow, _enabled: bool) {}

#[cfg(windows)]
fn windows_build() -> u64 {
    match tauri_plugin_os::version() {
        tauri_plugin_os::Version::Semantic(_, _, build) => build,
        _ => 0,
    }
}

/// Which of the three DWM backdrops a build of Windows can draw without dragging.
///
/// Acrylic is the one that shows what is behind the window, which is the look — but before the
/// system backdrop API (build 22523, 22H2 in practice) it goes through `SetWindowCompositionAttribute`,
/// and there the window lags a frame behind the cursor on every move and resize. So 21H2 gets Mica
/// (the wallpaper's colour, no lag) and Windows 10 the plain blur, which is smooth there.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq)]
enum WindowsBackdrop {
    Acrylic,
    Mica,
    Blur,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_backdrop(build: u64) -> WindowsBackdrop {
    if build >= 22523 {
        WindowsBackdrop::Acrylic
    } else if build >= 22000 {
        WindowsBackdrop::Mica
    } else {
        WindowsBackdrop::Blur
    }
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
        assert_eq!(fills(0), Fills { frame: 80.0, sheet: 80.0, solo: 96.0 });
        assert_eq!(fills(50), Fills { frame: 47.5, sheet: 55.0, solo: 76.375 });
        assert_eq!(fills(100), Fills { frame: 15.0, sheet: 30.0, solo: 40.5 });
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
        assert!(script.contains(r#""--cf-glass-frame", "15.0%""#));
        assert!(script.contains(r#""--cf-glass-sheet", "30.0%""#));
        assert!(script.contains(r#""--cf-glass-solo", "40.5%""#));
    }

    #[test]
    fn only_explicit_modes_pin_the_appearance() {
        assert_eq!(parse_theme(Some("dark")), Some(Theme::Dark));
        assert_eq!(parse_theme(Some("light")), Some(Theme::Light));
        assert_eq!(parse_theme(Some("system")), None);
        assert_eq!(parse_theme(None), None);
    }

    #[test]
    fn windows_backdrop_by_build() {
        assert_eq!(windows_backdrop(22631), WindowsBackdrop::Acrylic);
        assert_eq!(windows_backdrop(22523), WindowsBackdrop::Acrylic);
        assert_eq!(windows_backdrop(22000), WindowsBackdrop::Mica);
        assert_eq!(windows_backdrop(19045), WindowsBackdrop::Blur);
    }
}
