//! The push-to-talk chord: held anywhere — in another application too — Codi hears; let go, it
//! stops. The window's Space and its button do the same inside the window; this is for when the
//! hands are in an editor (user, 2026-10-21: «ese mantener apretado debería tener un atajo»).
//!
//! **Bound only while it means something:** Codi's microphone on, in push-to-talk. A system-wide
//! chord takes those keys from every other application, so it is not held a moment longer than
//! that. Both edges of the chord matter here — the process-wide handler in `lib.rs` hands every
//! event to [`handle`] first, pressed and released alike.
//!
//! `unregister_all` (the quick-ask hotkey's rebinding) drops this chord with the rest; [`rebind`]
//! puts it back, as `flows::triggers::rebind_hotkeys` does for the flows' chords.

use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::db::{queries, Db};

/// The setting: an accelerator (`Ctrl+Shift+Space`), `off`, or nothing for [`DEFAULT`].
pub const KEY: &str = "codi_ptt_hotkey";
pub const OFF: &str = "off";
/// Typeable on both systems, free on a stock install, two fingers of one hand to hold: ⌃⇧Space.
/// Not ⌥Space (quick-ask's on macOS) nor Ctrl+Alt+Space (quick-ask's elsewhere), nor ⌃Space
/// (macOS's input-source switch).
pub const DEFAULT: &str = "Ctrl+Shift+Space";

/// The chord bound now, as typed and as the plugin knows it.
fn bound() -> &'static Mutex<Option<(String, Shortcut)>> {
    static BOUND: std::sync::OnceLock<Mutex<Option<(String, Shortcut)>>> = std::sync::OnceLock::new();
    BOUND.get_or_init(Default::default)
}

/// The chord the setting names: [`DEFAULT`] when never chosen, `None` when switched off.
pub fn chosen(app: &AppHandle) -> Option<String> {
    let raw = app
        .state::<Db>()
        .0
        .lock()
        .ok()
        .and_then(|conn| queries::get_setting(&conn, KEY).ok().flatten())
        .unwrap_or_default();
    match raw.trim() {
        "" => Some(DEFAULT.to_string()),
        OFF => None,
        chord => Some(chord.to_string()),
    }
}

/// Binds the chosen chord when Codi's microphone is on in push-to-talk, and unbinds it otherwise.
/// `Err` only when the system refused a chord that should be bound — another application owns it.
pub fn sync(app: &AppHandle) -> Result<(), String> {
    let wanted = if super::mic_on() && super::mode(app) == "ptt" { chosen(app) } else { None };
    let current = bound().lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|(chord, _)| chord.clone());
    if wanted == current {
        return Ok(());
    }
    unbind(app);
    let Some(chord) = wanted else { return Ok(()) };
    let shortcut = Shortcut::from_str(&chord).map_err(|e| format!("\"{chord}\" is not a shortcut: {e}"))?;
    app.global_shortcut().register(shortcut).map_err(|e| {
        crate::applog::info(&format!("codi: push-to-talk chord '{chord}' refused: {e}"));
        format!("could not bind {chord}: {e}")
    })?;
    *bound().lock().unwrap_or_else(|p| p.into_inner()) = Some((chord, shortcut));
    Ok(())
}

/// Lets the chord go, if one is bound. A chord let go mid-press would leave Codi hearing: it stops.
pub fn unbind(app: &AppHandle) {
    let held = bound().lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some((_, shortcut)) = held {
        let _ = app.global_shortcut().unregister(shortcut);
        if super::talking() {
            super::set_talking(app, false);
        }
    }
}

/// After something cleared every chord the process held.
pub fn rebind(app: &AppHandle) {
    let held = bound().lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some((_, shortcut)) = held {
        let _ = app.global_shortcut().register(shortcut);
    }
}

/// The process-wide handler asks this first. True when the event was the push-to-talk chord's.
pub fn handle(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) -> bool {
    let ours = bound().lock().ok().and_then(|held| held.as_ref().map(|(_, bound)| bound.id())) == Some(shortcut.id());
    if !ours {
        return false;
    }
    let down = state == ShortcutState::Pressed;
    // A key held down repeats its press on some systems: only a change is news.
    if down != super::talking() {
        super::set_talking(app, down);
    }
    true
}

/// Records `chord` (or `off`, or `""` for the default) and binds it if it should be bound now. On a
/// refusal the previous choice is bound again and kept.
pub fn set(app: &AppHandle, chord: &str) -> Result<(), String> {
    let chord = chord.trim();
    if !chord.is_empty() && chord != OFF {
        Shortcut::from_str(chord).map_err(|e| format!("\"{chord}\" is not a shortcut: {e}"))?;
    }
    let previous = app.state::<Db>().0.lock().ok().and_then(|conn| queries::get_setting(&conn, KEY).ok().flatten()).unwrap_or_default();
    write(app, chord)?;
    if let Err(error) = sync(app) {
        write(app, &previous)?;
        let _ = sync(app);
        return Err(error);
    }
    Ok(())
}

/// Frees the chord while a new one is being recorded — bound, it would reach Codi instead of the
/// recorder — and takes it back after.
pub fn suspend(app: &AppHandle, suspended: bool) -> Result<(), String> {
    if suspended {
        unbind(app);
        Ok(())
    } else {
        sync(app)
    }
}

fn write(app: &AppHandle, value: &str) -> Result<(), String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_setting(&conn, KEY, value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_chord_parses_and_is_not_quick_asks() {
        assert!(Shortcut::from_str(DEFAULT).is_ok());
        assert_ne!(DEFAULT, crate::windows::DEFAULT_QUICK_ASK_ACCELERATOR);
    }
}
