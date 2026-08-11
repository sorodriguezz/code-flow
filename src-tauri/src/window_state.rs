//! How big the window was, and whether it was maximized, carried across quits.
//!
//! Tauri puts the window back at the size named in `tauri.conf.json` on every launch, which is the
//! right answer exactly once. After that it is the app forgetting something the user said with a
//! drag: a window sized to sit beside an editor comes back covering it, and one that was maximized
//! comes back as a rectangle in the middle of the screen.
//!
//! ## Why this lives in Rust
//!
//! The frontend already tracks the same rectangle for the maximize button (see
//! `lib/windowControls.ts`), so persisting from there would have been fewer moving parts — but it
//! could only *apply* what it read once the webview was up, which is several hundred milliseconds
//! after the window is on screen. The user would watch the window open at the default size and then
//! jump. Restoring from `setup` happens before anything is shown at all, which is why the window is
//! created with `"visible": false` and why [`restore`] is what makes it visible.
//!
//! That flag has to be set in **both** `tauri.conf.json` and `tauri.macos.conf.json`. A platform
//! config file replaces the `app.windows` array wholesale rather than merging field by field, so a
//! `visible` set only in the base file is a flag macOS never sees — and the symptom is not a
//! failure but a flicker, which is exactly the kind of thing that survives review.
//!
//! ## What is remembered
//!
//! The last rectangle the window had **while it was an ordinary window** — not while maximized,
//! not while minimized, not while hidden in the tray — plus a flag for whether it was maximized
//! when the app ended. Those are two independent answers and both are needed: restoring a
//! maximized window still has to know what size to unmaximize back to.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window};

/// The single `settings` row this owns.
///
/// One JSON blob rather than the five keys the frontend's own settings use, because these five
/// numbers are only meaningful together: a half-written set — a new position against an old size —
/// describes a rectangle the window was never in.
const SETTING_KEY: &str = "window_state";

/// How much of the window has to land on a monitor for the saved position to be worth using.
///
/// A window is restored to coordinates that were true on a desk with two screens; opened later on
/// the laptop alone, those coordinates are off in space. Requiring a grabbable corner rather than
/// mere overlap is the difference between a window the user can drag back and one they can only
/// recover by reinstalling.
const MIN_VISIBLE_WIDTH: i32 = 120;
const MIN_VISIBLE_HEIGHT: i32 = 60;

/// Physical pixels throughout, the unit the platform reports and accepts.
///
/// Storing logical pixels would mean multiplying by a scale factor on the way out and dividing on
/// the way back — and the scale factor that matters is the one of the monitor the window is *going*
/// to, which is not known until it is placed there. Physical avoids the question entirely.
#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

/// The live rectangle, updated as the window is moved and resized.
///
/// In memory rather than written straight through, because a drag across the screen is hundreds of
/// events and each one would be a database write. The single write happens when the app is on its
/// way out — see [`save`], and the two places in `lib.rs` that call it.
#[derive(Default)]
pub struct WindowTracker(Mutex<Option<WindowState>>);

/// Notes where the window is now, if now is a moment worth remembering.
///
/// Called on every move and resize. Cheap by design: a few platform queries and a mutex, no disk.
pub fn record(window: &Window) {
    // Only the main window has a rectangle anyone wants back.
    if window.label() != "main" {
        return;
    }
    // A window that is hidden in the tray or sitting in the taskbar is not somewhere to reopen at.
    // Windows in particular reports a minimized window at (-32000, -32000), which restores as a
    // window nobody can find.
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }

    // Fullscreen counts as maximized here. It is a third state the app has no way to restore into
    // deliberately — the close button leaves fullscreen on the way out (see `hide_to_background`)
    // and ⌘Q from fullscreen would otherwise save the screen's own rectangle as an ordinary window
    // size, reopening as a borderless slab exactly covering the display.
    let filling_the_screen =
        window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false);

    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let Some(tracker) = window.app_handle().try_state::<WindowTracker>() else {
        return;
    };
    let Ok(mut slot) = tracker.0.lock() else {
        return;
    };

    match slot.as_mut() {
        // The rectangle being reported is the screen, not somewhere to come back to. Only the flag
        // moves; the windowed rectangle already in hand is the one worth keeping.
        Some(state) if filling_the_screen => state.maximized = true,
        // Everything else, including the first launch that starts maximized before any windowed
        // rectangle was ever seen — the screen's rectangle is a poor answer for "unmaximize to
        // what", but it is the only one available and it beats having none.
        _ => {
            *slot = Some(WindowState {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                maximized: filling_the_screen,
            })
        }
    }
}

/// Writes the tracked rectangle down. Called on the way out, from every path that has one.
pub fn save(app: &AppHandle) {
    let Some(state) = app
        .try_state::<WindowTracker>()
        .and_then(|tracker| tracker.0.lock().ok().and_then(|slot| *slot))
    else {
        return;
    };
    let Ok(json) = serde_json::to_string(&state) else {
        return;
    };
    let Some(db) = app.try_state::<crate::db::Db>() else {
        return;
    };
    let Ok(conn) = db.0.lock() else {
        return;
    };
    let _ = crate::db::queries::set_setting(&conn, SETTING_KEY, &json);
}

fn read(app: &AppHandle) -> Option<WindowState> {
    let db = app.try_state::<crate::db::Db>()?;
    let conn = db.0.lock().ok()?;
    let raw = crate::db::queries::get_setting(&conn, SETTING_KEY).ok().flatten()?;
    serde_json::from_str(&raw).ok()
}

/// Whether a window at `state` would show a grabbable corner on a screen spanning
/// `origin`..`origin + size`.
///
/// Split out from [`reachable`] and given nothing but numbers so it can be tested: everything
/// around it needs a live window and a real monitor, and this is the part where an inverted
/// comparison would go unnoticed right up until someone unplugs a second screen.
fn overlaps(state: &WindowState, origin: (i32, i32), size: (u32, u32)) -> bool {
    let visible_width =
        (state.x + state.width as i32).min(origin.0 + size.0 as i32) - state.x.max(origin.0);
    let visible_height =
        (state.y + state.height as i32).min(origin.1 + size.1 as i32) - state.y.max(origin.1);
    visible_width >= MIN_VISIBLE_WIDTH && visible_height >= MIN_VISIBLE_HEIGHT
}

/// Whether enough of `state` would land on a monitor that is actually plugged in.
fn reachable(window: &tauri::WebviewWindow, state: &WindowState) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        // No answer from the platform is not evidence the position is bad, but it is no evidence
        // it is good either — and centring a window that would have been fine is a far smaller
        // cost than opening one off the edge of the world.
        return false;
    };
    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        overlaps(state, (origin.x, origin.y), (size.width, size.height))
    })
}

/// Puts the window back the way the last session left it, then shows it.
///
/// The showing is this function's job and not the caller's, and nothing in here may return early
/// past the point the window would stay hidden: the window is created invisible so that the
/// resizing and the maximizing below don't happen in front of the user, which means a path through
/// this that skips `show` is an app that launches to nothing.
pub fn restore(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if let Some(state) = read(app) {
        // Seeded before anything is applied, so the tracker starts the session holding what the
        // last one ended with. Without this, a window restored maximized and quit while still
        // maximized would save a `None` over a perfectly good rectangle.
        if let Some(tracker) = app.try_state::<WindowTracker>() {
            if let Ok(mut slot) = tracker.0.lock() {
                *slot = Some(state);
            }
        }

        // A zero from a corrupted row would be clamped by `minWidth`/`minHeight` into something
        // arbitrary; skipping is the more honest answer, and leaves the config's own size standing.
        if state.width > 0 && state.height > 0 {
            // Size first, then position — the same order `windowControls.ts` uses for the maximize
            // button, and for the same reason: positioning a window that is still the old size can
            // have the platform clamp it back onto the monitor and land it somewhere else.
            let _ = window.set_size(PhysicalSize::new(state.width, state.height));
        }
        if reachable(&window, &state) {
            let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        } else {
            // The monitor it was on is gone. The size is still what the user chose, so only the
            // position is given up on.
            let _ = window.center();
        }
        if state.maximized {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1440×900 window at `(x, y)`, the size the app ships with.
    fn window_at(x: i32, y: i32) -> WindowState {
        WindowState { x, y, width: 1440, height: 900, maximized: false }
    }

    /// The built-in display, as the platform reports it: origin at zero.
    const LAPTOP: ((i32, i32), (u32, u32)) = ((0, 0), (1920, 1200));
    /// A second screen arranged to the left of it, which is where negative coordinates come from.
    const LEFT_OF_IT: ((i32, i32), (u32, u32)) = ((-2560, 0), (2560, 1440));

    #[test]
    fn a_window_in_the_middle_of_a_screen_is_reachable() {
        assert!(overlaps(&window_at(200, 100), LAPTOP.0, LAPTOP.1));
    }

    #[test]
    fn a_window_hanging_off_an_edge_is_still_reachable_while_a_corner_shows() {
        // Dragged mostly off the right edge, 200px still on screen — the state a user leaves a
        // window in on purpose, and one they can drag back.
        assert!(overlaps(&window_at(1920 - 200, 300), LAPTOP.0, LAPTOP.1));
        // 60px left: less than `MIN_VISIBLE_WIDTH`, and not worth reopening at.
        assert!(!overlaps(&window_at(1920 - 60, 300), LAPTOP.0, LAPTOP.1));
    }

    #[test]
    fn the_screen_that_went_away_takes_its_coordinates_with_it() {
        // Saved on the external monitor, reopened on the laptop alone.
        let on_the_external = window_at(-2000, 200);
        assert!(overlaps(&on_the_external, LEFT_OF_IT.0, LEFT_OF_IT.1));
        assert!(!overlaps(&on_the_external, LAPTOP.0, LAPTOP.1));
    }

    #[test]
    fn negative_coordinates_are_not_by_themselves_a_lost_window() {
        // The whole point of the arrangement above: a monitor left of the primary one has real,
        // negative coordinates, and a window there is exactly where the user left it.
        assert!(overlaps(&window_at(-1200, 400), LEFT_OF_IT.0, LEFT_OF_IT.1));
    }

    #[test]
    fn windows_reports_a_minimized_window_somewhere_nobody_can_reach() {
        // `record` refuses to store this, but if one ever survived from an older build it must not
        // be restored to. See the `is_minimized` guard.
        assert!(!overlaps(&window_at(-32000, -32000), LAPTOP.0, LAPTOP.1));
        assert!(!overlaps(&window_at(-32000, -32000), LEFT_OF_IT.0, LEFT_OF_IT.1));
    }

    #[test]
    fn the_saved_row_survives_a_round_trip() {
        let saved = WindowState { x: -1200, y: 40, width: 1600, height: 1000, maximized: true };
        let json = serde_json::to_string(&saved).expect("serialises");
        let read: WindowState = serde_json::from_str(&json).expect("parses");
        assert_eq!((read.x, read.y, read.width, read.height), (-1200, 40, 1600, 1000));
        assert!(read.maximized);
    }

    #[test]
    fn a_row_from_another_shape_is_ignored_rather_than_guessed_at() {
        assert!(serde_json::from_str::<WindowState>("{\"x\":1}").is_err());
        assert!(serde_json::from_str::<WindowState>("not json").is_err());
    }
}
