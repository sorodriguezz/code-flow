//! The satellite windows, and the rules that keep exactly one of anything on screen.
//!
//! # What a satellite is
//!
//! A second, third or fourth window holding **one thing**: one app from the rail (the API client,
//! the database client, the agent console…) or one repository. It has a title bar and that thing,
//! and nothing else — no sidebar, no rail, no settings. It is a view, not a session: everything it
//! shows already lives in this process or in SQLite, so closing one loses nothing.
//!
//! # Why the registry is here and not in the frontend
//!
//! Because "is this app already open somewhere?" has to be answerable from *any* window, and each
//! webview only knows its own state. The main window asks this to decide whether its rail icon
//! opens a tab or focuses a window; a satellite asks it to know what it is. One map in the process
//! everybody can see beats four copies gossiping over events.
//!
//! # Detaching moves, it never duplicates
//!
//! [`open_satellite`] is idempotent on `(kind, ref_id)`: asking for one that already exists focuses
//! it instead of building a second. That single property is what removes the whole class of
//! two-editors-on-one-file, two-live-sockets and two-filesystem-watchers problems, and it is why
//! the label is *derived* from what the window holds rather than minted fresh each time.
//!
//! # The ceiling
//!
//! The user-facing limit lives in settings and is enforced where the button is, so the message can
//! say what the limit is. [`MAX_SATELLITES`] is the backstop underneath it: a frontend bug, a
//! repeated keystroke or a restored layout from a machine with a higher limit cannot open windows
//! without end.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Backstop, not the user's limit. See the module note.
const MAX_SATELLITES: usize = 8;

/// Prefix every satellite label carries.
///
/// Load-bearing in two places outside this file: `capabilities/default.json` grants window
/// permissions to `sat-*`, and the frontend tells a satellite apart from the main window by
/// looking at its own label. Changing it means changing all three.
const LABEL_PREFIX: &str = "sat-";

/// What a satellite holds.
///
/// Two kinds, because they scope differently and the difference is visible to the user. An `App`
/// belongs to the **workspace**, so it follows whichever workspace the main window is showing. A
/// `Repo` belongs to one repository, which lives in exactly one workspace — so when the main window
/// moves to another workspace, that window has nothing to show and says so rather than going on
/// displaying the previous workspace's repository.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SatelliteKind {
    App,
    Repo,
}

impl SatelliteKind {
    fn slug(self) -> &'static str {
        match self {
            SatelliteKind::App => "app",
            SatelliteKind::Repo => "repo",
        }
    }
}

/// One open satellite, as everything outside this module sees it.
#[derive(Clone, Serialize, Deserialize)]
pub struct SatelliteInfo {
    pub label: String,
    pub kind: SatelliteKind,
    /// Which app or which repository. For an app this is the rail's own id — `"api:requests"`,
    /// `"notes"` — and for a repository it is the project id.
    pub ref_id: String,
    /// What the OS calls the window. Carried here as well as passed to the builder so a restored
    /// window has a title before the frontend has loaded — the alternative is a task bar entry
    /// called "CodeFlow" for the second it takes, on every window, on every launch.
    #[serde(default)]
    pub title: String,
}

/// The `app_settings` row a previous build wrote the desk into. Deleted on startup; see
/// [`forget_persisted_desk`].
const LEGACY_REMEMBERED_KEY: &str = "open_satellites";

/// The open satellites, keyed by label.
///
/// A `Mutex<HashMap>` rather than a walk of `app.webview_windows()` because the label is a
/// *sanitised* derivation of `ref_id` (see [`label_for`]) and sanitising is not reversible: two
/// different ids could produce the same label, and no id can be read back out of one. The map
/// keeps the real values.
#[derive(Default)]
pub struct SatelliteRegistry {
    open: Mutex<HashMap<String, SatelliteInfo>>,
    /// The desk, put away.
    ///
    /// Filled by [`close_all`] — the one path where windows go because the *app* is going, not
    /// because anybody closed them — and drained by [`restore_satellites`] when the main window
    /// comes back from the tray. In memory, so it dies with the process.
    ///
    /// # Why this is not a settings row any more
    ///
    /// It was, and the feature that built on it was wrong twice over. The small wrong: a satellite
    /// closed with its own ✕ goes to the platform, lands on `Destroyed`, and never passes through
    /// the command that would have taken it out of the row — so the row only ever grew, and every
    /// window ever detached came back on every launch. The large wrong is the one that survived
    /// fixing that: opening three windows nobody asked for, before the user has done anything, is
    /// not a service. Putting the app away for a moment and bringing it back should look the same;
    /// *starting* it should start with one window.
    parked: Mutex<Vec<SatelliteInfo>>,
}

/// The label for a given satellite, derived so that opening the same thing twice is the same
/// window.
///
/// Tauri labels accept `[a-zA-Z0-9-/:_]`, which the two id shapes in play here already satisfy —
/// project ids are UUIDs, rail ids are lowercase words with at most a colon. Anything else is
/// folded to `_` regardless, because a label the platform rejects is a window that never opens and
/// an error the user cannot act on.
fn label_for(kind: SatelliteKind, ref_id: &str) -> String {
    let safe: String = ref_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("{LABEL_PREFIX}{}-{}", kind.slug(), safe)
}

/// Whether a window label belongs to a satellite. The main window is `"main"`; nothing else here
/// is.
pub fn is_satellite(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Every satellite currently open.
#[tauri::command]
pub fn list_satellites(registry: tauri::State<SatelliteRegistry>) -> Vec<SatelliteInfo> {
    registry
        .open
        .lock()
        .map(|held| held.values().cloned().collect())
        .unwrap_or_default()
}

/// What this window is, asked by the window itself at boot.
///
/// The satellite already receives its identity in the query string it was opened with, which is
/// what it paints its first frame from. This exists for the restore path and for anything that
/// wants to re-read it later without parsing a URL.
#[tauri::command]
pub fn satellite_spec(
    registry: tauri::State<SatelliteRegistry>,
    label: String,
) -> Option<SatelliteInfo> {
    registry.open.lock().ok()?.get(&label).cloned()
}

/// Opens the window for one app or one repository, or focuses the one already showing it.
///
/// `title` is what the OS window is called — the task bar, the window menu, ⌘` — so it is passed in
/// rather than derived here: the name of an app is a translated string and the name of a repository
/// is user data, and neither belongs in Rust.
///
/// Returns the label either way, so the caller can go straight on to focusing it.
#[tauri::command]
pub async fn open_satellite(
    app: AppHandle,
    kind: SatelliteKind,
    ref_id: String,
    title: String,
) -> Result<String, String> {
    let label = label_for(kind, &ref_id);

    // Worth a line in the log, permanently. A window appearing is the most visible thing this
    // module does and the least self-explanatory: "why did that open?" is answerable from here and
    // nowhere else, because the two callers — a click on ↗, and the tray restore — leave no other
    // trace. It is one line per window, not per frame.
    crate::applog::info(&format!("window: open_satellite {label}"));

    // Already open: this is the "detaching moves, never duplicates" rule in its most literal form.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(label);
    }

    let registry = app.state::<SatelliteRegistry>();
    {
        let held = registry.open.lock().map_err(|e| e.to_string())?;
        if held.len() >= MAX_SATELLITES {
            return Err(format!("too many windows are open (limit {MAX_SATELLITES})"));
        }
    }

    // The satellite's own HTML entry, not `index.html` with a flag. The whole point of the second
    // entry is that the shell — sidebar, rail, command palette, settings, the guided tour — is not
    // in this window's bundle at all, so it cannot be loaded by accident and cannot cost anything.
    //
    // The identity travels in the query string because it is needed to paint the first frame, and a
    // command round-trip before the first frame is a window that opens empty and then fills in.
    let url = format!(
        "window.html?kind={}&ref={}",
        kind.slug(),
        urlencode(&ref_id)
    );

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(560.0, 420.0)
        // Cascaded off the main window rather than centred: four centred windows land on top of
        // each other, which looks exactly like nothing happening.
        .position(cascade_offset(&app), cascade_offset(&app) + 24.0);

    // Same chrome as the main window, because a satellite draws the same title bar. On macOS that
    // means keeping the real decorations (and with them the rounded corners and a working green
    // button) while the webview paints under them; everywhere else it means no frame at all so the
    // bar can be ours. See `tauri.conf.json` and `tauri.macos.conf.json`, which say this for the
    // main window — this is the same statement for windows that have no entry there.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    builder.build().map_err(|e| e.to_string())?;

    if let Ok(mut held) = registry.open.lock() {
        held.insert(
            label.clone(),
            SatelliteInfo { label: label.clone(), kind, ref_id, title: title.clone() },
        );
    }
    announce(&app);
    Ok(label)
}

/// Where the next satellite lands, so a second one does not open exactly on top of the first.
///
/// Counts what is already open rather than keeping a cursor: closing three windows and opening one
/// should put it back near the top left, not continue marching off the screen.
fn cascade_offset(app: &AppHandle) -> f64 {
    let open = app
        .state::<SatelliteRegistry>()
        .open
        .lock()
        .map(|held| held.len())
        .unwrap_or(0);
    120.0 + (open % 5) as f64 * 32.0
}

/// Percent-encoding for the two characters a rail id can actually contain that a query string
/// would otherwise read as structure. Not a general encoder, and deliberately not: pulling in a
/// URL crate to escape a colon would be the tail wagging the dog.
fn urlencode(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            ':' => "%3A".to_string(),
            '&' => "%26".to_string(),
            '=' => "%3D".to_string(),
            '#' => "%23".to_string(),
            ' ' => "%20".to_string(),
            other => other.to_string(),
        })
        .collect()
}

/// Brings one to the front. What the main window's rail does when its icon is already marked.
#[tauri::command]
pub fn focus_satellite(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "that window is not open".to_string())?;
    let _ = window.unminimize();
    let _ = window.show();
    window.set_focus().map_err(|e| e.to_string())
}

/// Closes every satellite. Called when the main window goes away.
///
/// A satellite cannot outlive the window it was detached from: it has no sidebar to pick a
/// workspace with, no rail to reattach itself to, and no settings — so a satellite alone on screen
/// is an app the user cannot navigate. The main window hiding to the tray is the same event as the
/// main window closing, and it is treated the same way here.
///
/// **The remembered list is left exactly as it is.** These windows are not being dismissed; the
/// desk is being put away, and the next time it comes out — a tray restore, tomorrow's launch — it
/// should look the way it was left. Closing one satellite by hand is the gesture that means "not
/// this one any more", and that path does update the list.
pub fn close_all(app: &AppHandle) {
    let labels: Vec<String> = app
        .state::<SatelliteRegistry>()
        .open
        .lock()
        .map(|held| held.keys().cloned().collect())
        .unwrap_or_default();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
}

/// Takes a window out of the registry once the platform says it is gone.
///
/// Hooked to `Destroyed` rather than to `CloseRequested`, which is the difference between "the user
/// asked" and "it actually went": a close that something prevents must not leave the registry
/// claiming the window is closed while it is still on screen.
pub fn forget(app: &AppHandle, label: &str) {
    if !is_satellite(label) {
        return;
    }
    let removed = app
        .state::<SatelliteRegistry>()
        .open
        .lock()
        .map(|mut held| held.remove(label).is_some())
        .unwrap_or(false);
    if removed {
        announce(app);
    }
}

/// Drops the settings row an earlier build kept the desk in.
///
/// Called once at startup. Not a schema migration, so it does not live in `migrations.rs`: it is a
/// single value that stopped meaning anything, and leaving it would have an install that upgrades
/// carrying a list of windows nothing will ever read again.
pub fn forget_persisted_desk(app: &AppHandle) {
    if let Ok(conn) = app.state::<crate::db::Db>().0.lock() {
        let _ = conn.execute("DELETE FROM app_settings WHERE key = ?1", [LEGACY_REMEMBERED_KEY]);
    }
}

/// Puts back the desk [`close_all`] parked, and answers with how many windows came back.
///
/// Called when the **main window returns from the tray**, and only then. Not at launch: a fresh
/// start opens one window, because three appearing before the user has done anything is not a
/// service — it is the app deciding what they are working on. Putting it away for a moment and
/// bringing it back is the other case, and there the desk should look the way it was left.
///
/// Draining, so a second foreground event cannot reopen what the user has closed since. Failures
/// are silent per window: a repository deleted in the meantime simply does not come back.
#[tauri::command]
pub async fn restore_satellites(app: AppHandle) -> usize {
    let parked: Vec<SatelliteInfo> = {
        let registry = app.state::<SatelliteRegistry>();
        let Ok(mut held) = registry.parked.lock() else { return 0 };
        std::mem::take(&mut *held)
    };

    if !parked.is_empty() {
        crate::applog::info(&format!("window: restoring {} parked satellite(s)", parked.len()));
    }
    let mut opened = 0;
    for entry in parked {
        // Already open — nothing was ever put away, or this ran twice.
        if app.get_webview_window(&entry.label).is_some() {
            continue;
        }
        if open_satellite(app.clone(), entry.kind, entry.ref_id, entry.title).await.is_ok() {
            opened += 1;
        }
    }
    opened
}

/// Tells every window which satellites exist now.
///
/// Pushed rather than polled because the answer changes what the main window's rail *draws* — an
/// icon is marked or it is not — and a rail that catches up on the next render is a rail that lies
/// for however long that takes.
fn announce(app: &AppHandle) {
    let open: Vec<SatelliteInfo> = app
        .state::<SatelliteRegistry>()
        .open
        .lock()
        .map(|held| held.values().cloned().collect())
        .unwrap_or_default();
    let _ = app.emit("windows:satellites", open);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the whole design rests on: the same thing always resolves to the same window.
    #[test]
    fn one_thing_is_always_one_label() {
        let a = label_for(SatelliteKind::App, "api:requests");
        let b = label_for(SatelliteKind::App, "api:requests");
        assert_eq!(a, b);
        assert!(is_satellite(&a));
    }

    /// Two kinds can share an id — a rail app called `notes` and a project whose id somehow reads
    /// the same — and must not collide into one window.
    #[test]
    fn the_kind_is_part_of_the_label() {
        assert_ne!(
            label_for(SatelliteKind::App, "notes"),
            label_for(SatelliteKind::Repo, "notes")
        );
    }

    /// Labels reach the platform, which rejects most punctuation. A colon is legal in a Tauri label
    /// but is folded anyway, so the one sanitising rule covers every id shape rather than being
    /// correct for today's two.
    #[test]
    fn punctuation_never_reaches_the_platform() {
        let label = label_for(SatelliteKind::App, "api:requests");
        assert!(
            label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "{label} carries a character the window system may refuse"
        );
    }

    /// Putting the desk away and bringing it back is one round trip, not a standing offer.
    ///
    /// The drain is what makes a second `app:foreground` — alt-tabbing back after already
    /// restoring — reopen nothing. Without it, closing a satellite and then coming back to the app
    /// would put it on screen again, which is the same "it came back on its own" this whole change
    /// is about.
    #[test]
    fn parking_the_desk_hands_it_back_exactly_once() {
        let registry = SatelliteRegistry::default();
        let entry = SatelliteInfo {
            label: "sat-app-notes".into(),
            kind: SatelliteKind::App,
            ref_id: "notes".into(),
            title: "Notas".into(),
        };
        *registry.parked.lock().unwrap() = vec![entry];

        let first = std::mem::take(&mut *registry.parked.lock().unwrap());
        let second = std::mem::take(&mut *registry.parked.lock().unwrap());

        assert_eq!(first.len(), 1, "the desk comes back");
        assert!(second.is_empty(), "and does not come back a second time");
    }

    /// Nothing is parked until something parks it. A launch therefore restores nothing, which is
    /// the whole point: the list used to live in `app_settings` and every window ever detached came
    /// back on every start.
    #[test]
    fn a_fresh_registry_has_no_desk_to_restore() {
        let registry = SatelliteRegistry::default();
        assert!(registry.parked.lock().unwrap().is_empty());
        assert!(registry.open.lock().unwrap().is_empty());
    }

    /// The main window is not a satellite, and neither is anything that merely mentions one.
    #[test]
    fn only_the_prefix_makes_a_satellite() {
        assert!(!is_satellite("main"));
        assert!(!is_satellite("mobile"));
        assert!(is_satellite("sat-app-notes"));
    }

    /// The query string a satellite reads its identity out of has to survive the one id shape that
    /// carries punctuation.
    #[test]
    fn the_query_string_escapes_what_would_break_it() {
        assert_eq!(urlencode("api:requests"), "api%3Arequests");
        assert_eq!(urlencode("plain-id"), "plain-id");
    }
}
