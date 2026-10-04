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

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

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
/// Four kinds, because they scope differently and the difference is visible to the user. An `App`
/// belongs to a **workspace** — its own: every window holds the workspace it was opened on or
/// switched to from its own title bar, and follows no other window. A `Repo` belongs to one
/// repository, which lives in exactly one workspace, so its workspace is derived from the
/// repository rather than chosen — and a repository that is removed leaves the window saying so
/// rather than showing somebody else's.
///
/// `Quick` belongs to **nothing**, and that is its entire design. It is the global-hotkey ask box:
/// one composer, one answer, no sidebar and no workspace, raised over whatever the user was doing
/// in whatever application. It is a satellite only in the mechanical sense — it is built by this
/// module, it carries the `sat-` prefix so `capabilities/default.json` covers it, and it appears in
/// the registry so `forget` reaps it — but it is **not** counted against the ceiling, the user's or
/// [`MAX_SATELLITES`]: it is hidden, not closed, between uses, so it is "open" all day, and a limit
/// of four windows that quietly meant three once the hotkey had been pressed was a limit that lied.
/// Everywhere the main window's desk is put away, this one deliberately stays; see [`close_all`].
///
/// `File` is one editor tab of one repository, torn out of the main window's editor into a window of
/// its own — VS Code's floating editor window, and an island like `App` and `Repo`. Its `ref_id` is
/// `"<project id>:<path in the repository>"`. Detaching *moves* the file there, by the rule in the
/// module note: the main window hands its buffer over and stops showing it, so one file never has
/// two editors, and closing the window gives it back. Smaller than the others when it is built and
/// placed where the tab was dropped (see [`open_satellite`]); it counts against the ceilings like any
/// other window, because it is a whole webview like any other.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SatelliteKind {
    App,
    Repo,
    Quick,
    File,
}

impl SatelliteKind {
    fn slug(self) -> &'static str {
        match self {
            SatelliteKind::App => "app",
            SatelliteKind::Repo => "repo",
            SatelliteKind::Quick => "quick",
            SatelliteKind::File => "file",
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
    /// It was declared and never written: `close_all` closed the windows and parked nothing, so the
    /// tray restore always found an empty list and the only test filled it by hand. Parking now
    /// happens in [`SatelliteRegistry::put_away`], which `close_all` calls and the tests go through.
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
    parked: Mutex<Vec<Parked>>,
    /// The satellites that hold work nothing else has — an editor buffer typed into and not saved.
    /// Reported by each window itself through [`set_window_unsaved`], because the webview is the
    /// only place that knows; read by [`close_all`], which hides these instead of closing them.
    unsaved: Mutex<HashSet<String>>,
}

/// One window put away by [`close_all`].
#[derive(Clone)]
struct Parked {
    info: SatelliteInfo,
    /// Hidden rather than closed, because closing it would have destroyed unsaved work — so the
    /// restore shows the same window again instead of building a new one.
    hidden: bool,
}

/// What [`SatelliteRegistry::put_away`] decided: which windows to close and which to hide.
#[derive(Debug, Default, PartialEq, Eq)]
struct PutAway {
    close: Vec<String>,
    hide: Vec<String>,
}

impl SatelliteRegistry {
    /// The satellites that count against the ceilings — every one but the ask box. See
    /// [`SatelliteKind::Quick`].
    fn counted(held: &HashMap<String, SatelliteInfo>) -> usize {
        held.values().filter(|info| info.kind != SatelliteKind::Quick).count()
    }

    /// Parks the desk and says what to do with each window: the half of [`close_all`] that needs no
    /// window system, and the half the tests exercise.
    ///
    /// Replaces whatever was parked before rather than adding to it: this runs once per trip to the
    /// tray and the restore drains it on the way back, so an older list can only be one the user has
    /// already been handed back.
    fn put_away(&self) -> PutAway {
        let unsaved = self.unsaved.lock().map(|set| set.clone()).unwrap_or_default();
        let mut parked = Vec::new();
        let mut plan = PutAway::default();
        if let Ok(held) = self.open.lock() {
            let mut desk: Vec<&SatelliteInfo> =
                held.values().filter(|info| info.kind != SatelliteKind::Quick).collect();
            // A stable order, so the windows come back in the same one every time.
            desk.sort_by(|a, b| a.label.cmp(&b.label));
            for info in desk {
                let hidden = unsaved.contains(&info.label);
                if hidden {
                    plan.hide.push(info.label.clone());
                } else {
                    plan.close.push(info.label.clone());
                }
                parked.push(Parked { info: info.clone(), hidden });
            }
        }
        if let Ok(mut slot) = self.parked.lock() {
            *slot = parked;
        }
        plan
    }

    /// Takes the parked desk, once. See [`restore_satellites`].
    fn take_parked(&self) -> Vec<Parked> {
        self.parked.lock().map(|mut held| std::mem::take(&mut *held)).unwrap_or_default()
    }
}

/// The label for a given satellite, derived so that opening the same thing twice is the same
/// window.
///
/// Tauri labels accept `[a-zA-Z0-9-/:_]`, which the two id shapes in play here already satisfy —
/// project ids are UUIDs, rail ids are lowercase words with at most a colon. Anything else is
/// folded to `_` regardless, because a label the platform rejects is a window that never opens and
/// an error the user cannot act on.
fn label_for(kind: SatelliteKind, ref_id: &str) -> String {
    // A file's id is a path, and paths are exactly the ids the folding below would merge:
    // `src/a-b.ts` and `src/a_b.ts` fold to the same label, and the second window would "already
    // exist" — the first one would come forward instead. So a file's label is a digest of its id
    // rather than a spelling of it. Stable across runs (no random seed), which the restore needs.
    if kind == SatelliteKind::File {
        return format!("{LABEL_PREFIX}{}-{:016x}", kind.slug(), fnv1a64(ref_id));
    }
    let safe: String = ref_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("{LABEL_PREFIX}{}-{}", kind.slug(), safe)
}

/// FNV-1a, 64 bits — a digest for [`label_for`], where all that matters is that two paths a person
/// has open at once never share one. Not a security property, so no crate for it.
fn fnv1a64(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
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
/// `workspace_id` is the workspace of the window it was opened from, and the window opens on it.
/// `None` is a restore from the tray, where the window goes back to the workspace it recorded for
/// itself. A window that is already open ignores it: it keeps the workspace it was switched to.
///
/// Returns the label either way, so the caller can go straight on to focusing it.
///
/// `x`/`y` place the window's top-left corner, in logical screen pixels — where a tab dragged out of
/// the editor was let go. Absent, the window cascades off the others as it always has.
#[tauri::command]
pub async fn open_satellite(
    app: AppHandle,
    kind: SatelliteKind,
    ref_id: String,
    title: String,
    workspace_id: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
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
        if SatelliteRegistry::counted(&held) >= MAX_SATELLITES {
            return Err(format!("too many windows are open (limit {MAX_SATELLITES})"));
        }
    }

    // The satellite's own HTML entry, not `index.html` with a flag. The whole point of the second
    // entry is that the shell — sidebar, rail, command palette, settings, the guided tour — is not
    // in this window's bundle at all, so it cannot be loaded by accident and cannot cost anything.
    //
    // The identity travels in the query string because it is needed to paint the first frame, and a
    // command round-trip before the first frame is a window that opens empty and then fills in.
    let mut url = format!(
        "window.html?kind={}&ref={}",
        kind.slug(),
        urlencode(&ref_id)
    );
    // In the query string for the same reason as the identity: the window picks its workspace
    // while it boots, before any command could answer. Recording it in a setting for the window to
    // read instead would race the window's own first read.
    if let Some(workspace) = workspace_id.as_deref().filter(|w| !w.is_empty()) {
        url.push_str(&format!("&ws={}", urlencode(workspace)));
    }

    let look = crate::glass::stored(&app);
    // A floating editor is one file, not a screen of the app: it opens at the size of a reference
    // window you keep beside your work, and may be made much smaller than a screen would tolerate.
    let ((width, height), (min_width, min_height)) = match kind {
        SatelliteKind::File => ((820.0, 600.0), (360.0, 240.0)),
        _ => ((1100.0, 760.0), (560.0, 420.0)),
    };
    // Where the tab was dropped, when it was dropped; cascaded off the main window otherwise rather
    // than centred: four centred windows land on top of each other, which looks exactly like
    // nothing happening.
    let (left, top) = match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => (x, y),
        _ => (cascade_offset(&app), cascade_offset(&app) + 24.0),
    };
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        // As the main window (see `lib.rs`): without it WebView2 refuses every clipboard read.
        .enable_clipboard_access()
        // Always, as the main window is (`tauri.conf.json`): the see-through setting can only be
        // switched live on a window that was built able to show it. See `glass`.
        .transparent(true)
        .title(&title)
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .position(left, top);
    if let Some(script) = crate::glass::init_script(&look) {
        builder = builder.initialization_script(script);
    }

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
        // The traffic lights where the main window has them — `trafficLightPosition` in
        // `tauri.macos.conf.json`, read from there so the two cannot drift. A satellite draws the
        // same 44px title row as the main window now, and at AppKit's default spot the lights sat
        // above the row's middle and ran straight into the title that followed them.
        if let Some(position) = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .and_then(|window| window.traffic_light_position.as_ref())
        {
            builder = builder.traffic_light_position(tauri::LogicalPosition::new(position.x, position.y));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    crate::glass::on_create(&window, &look);

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
            // Two a floating editor's path can carry and a rail id never did: `URLSearchParams`
            // reads `+` as a space and `%` as the start of an escape, so `c++/a.cpp` or `100%.md`
            // would come out the other end as a different file.
            '%' => "%25".to_string(),
            '+' => "%2B".to_string(),
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

/// Puts every satellite away. Called when the main window goes to the tray.
///
/// A satellite cannot stay on screen without the window it was detached from: it has no rail to
/// reattach itself to and no settings — so a satellite alone on screen is an app the user cannot
/// navigate. The main window hiding to the tray is the same event as the main window closing, and
/// it is treated the same way here.
///
/// **The desk is parked, not dismissed.** What was open is recorded in
/// [`SatelliteRegistry::parked`] and the tray restore ([`restore_satellites`]) puts it back — only
/// that restore: a launch starts with one window. Closing one satellite by hand is the gesture that
/// means "not this one any more", and it never passes through here.
///
/// **A satellite holding unsaved work is hidden, not closed.** Closing destroys its webview, and an
/// editor buffer nobody saved exists only there — so the close button of the *main* window used to
/// throw away the unsaved tabs of every detached editor, silently. Asking first was the
/// alternative, and the worse one: the user pressed the button that means "put the app away", and
/// a question about another window's files is not what that gesture asks for. Hidden, the window
/// keeps its buffers exactly as the hidden main window keeps its own, and the restore shows it
/// again. A real quit still asks about all of it (`quit_guard`). Which windows those are, each
/// window says for itself — see [`set_window_unsaved`].
///
/// # The one exception: [`SatelliteKind::Quick`]
///
/// The rule above rests on a premise — "a satellite alone on screen is an app the user cannot
/// navigate" — and the quick-ask window is the one satellite the premise is false for. It has no
/// sidebar and no rail *by design*: it is a composer and an answer, reachable from a global hotkey
/// while the user is in another application entirely, and it needs nothing from the main window to
/// be usable.
///
/// Sweeping it up here would make it worse than not shipping it. The main window hides to the tray
/// on its close button, on ⌘W and on Alt+F4 — gestures a user performs precisely *because* they are
/// done with the desk and are going back to their editor, which is exactly the moment the ask box
/// becomes the only reason the app is still running. A hotkey that works until you put the window
/// away, and then silently opens nothing, is a feature that trains people not to use it.
///
/// It is still closed on quit: the process going takes every window with it, which is the real
/// lifetime this window is scoped to.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    let plan = app.state::<SatelliteRegistry>().put_away();
    if !plan.close.is_empty() || !plan.hide.is_empty() {
        crate::applog::info(&format!(
            "window: putting the desk away — {} closed, {} hidden (unsaved work)",
            plan.close.len(),
            plan.hide.len()
        ));
    }
    for label in plan.close {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
    for label in plan.hide {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.hide();
        }
    }
}

/// A window saying whether it holds unsaved work — the satellites' half of [`close_all`]'s rule.
///
/// Called by `lib/unsavedWork.ts` whenever the set of unsaved things in that window changes. The
/// caller is the window itself, so the label comes from the webview rather than from an argument
/// any window could fill in for another. The main window's answer is ignored: it is never closed
/// by [`close_all`], only hidden, so there is nothing to protect.
#[tauri::command]
pub fn set_window_unsaved(
    webview: tauri::Webview,
    registry: tauri::State<SatelliteRegistry>,
    unsaved: bool,
) {
    let label = webview.label();
    if !is_satellite(label) {
        return;
    }
    if let Ok(mut set) = registry.unsaved.lock() {
        if unsaved {
            set.insert(label.to_string());
        } else {
            set.remove(label);
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
    let registry = app.state::<SatelliteRegistry>();
    let removed = registry
        .open
        .lock()
        .map(|mut held| held.remove(label).is_some())
        .unwrap_or(false);
    if let Ok(mut unsaved) = registry.unsaved.lock() {
        unsaved.remove(label);
    }
    // The repository this window was watching. Its own teardown releases the claim when the page
    // unloads cleanly, but a window the platform destroys runs no JavaScript on the way out, and a
    // claim left behind is a native watcher running for nobody until the app quits.
    crate::watcher::release_holder(
        &app.state::<crate::watcher::WatcherRegistry>(),
        &crate::watcher::window_holder(label),
    );
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
///
/// A window [`close_all`] hid — the ones holding unsaved work — is shown again rather than rebuilt:
/// it never went away, and its buffers are still in it.
#[tauri::command]
pub async fn restore_satellites(app: AppHandle) -> usize {
    let parked = app.state::<SatelliteRegistry>().take_parked();

    if !parked.is_empty() {
        crate::applog::info(&format!("window: restoring {} parked satellite(s)", parked.len()));
    }
    let mut opened = 0;
    for Parked { info, hidden } in parked {
        if let Some(window) = app.get_webview_window(&info.label) {
            // Hidden with its work in it: bring it back. Anything else already on screen was never
            // put away, or this ran twice.
            if hidden {
                let _ = window.show();
                opened += 1;
            }
            continue;
        }
        // No workspace: a restored window goes back to the one it recorded, not to the main
        // window's.
        if open_satellite(app.clone(), info.kind, info.ref_id, info.title, None, None, None).await.is_ok() {
            opened += 1;
        }
    }
    opened
}

// ===================== the quick-ask window =====================

/// The one quick-ask window's `ref_id`, and therefore its label: `sat-quick-ask`.
///
/// A constant rather than a parameter because there is exactly one, always. The satellite registry
/// is keyed by label and [`open_satellite`]'s "asking for one that already exists focuses it" rule
/// is what makes the hotkey idempotent — pressing the chord twice raises the box, it does not build
/// a second one. Giving each press its own id would trade that for a screenful of ask boxes and
/// would hit [`MAX_SATELLITES`] in eight presses.
const QUICK_REF_ID: &str = "ask";

/// The accelerator the ask box is bound to when the user has expressed no preference.
///
/// ⌥Space on macOS is what ChatGPT's own desktop app uses there, which is the whole argument: a
/// chord people already have in their fingers for "ask something" beats one this app picked for
/// being free.
///
/// **Not on Windows.** Alt+Space is the system's own window menu there — restore, move, size,
/// close — in every application, and a global hotkey on it took that menu away from all of them for
/// as long as CodeFlow ran. Ctrl+Alt+Space is free on a stock install and one finger from the old
/// chord. Linux follows Windows: its desktops put the window menu on Alt+Space too.
///
/// Rebindable, and switchable off, precisely because it is a claim on the whole machine — see
/// [`register_quick_ask_shortcut`] and [`QUICK_ASK_OFF`].
#[cfg(target_os = "macos")]
pub const DEFAULT_QUICK_ASK_ACCELERATOR: &str = "Alt+Space";
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_QUICK_ASK_ACCELERATOR: &str = "Ctrl+Alt+Space";

/// The `app_settings` key holding the user's accelerator, read at startup by `lib.rs`.
pub const QUICK_ASK_ACCELERATOR_KEY: &str = "quick_ask_accelerator";

/// The stored value that means "no global hotkey at all".
///
/// A value of its own rather than an empty row, because empty already has a meaning: "never
/// chosen", which gets the default. Folding "off" into it is how switching the hotkey off came back
/// on at the next launch.
pub const QUICK_ASK_OFF: &str = "off";

/// The chord to bind, from what is stored: `None` when the user switched it off.
pub fn resolve_quick_ask_accelerator(stored: Option<&str>) -> Option<String> {
    match stored.map(str::trim) {
        None | Some("") => Some(DEFAULT_QUICK_ASK_ACCELERATOR.to_string()),
        Some(value) if value.eq_ignore_ascii_case(QUICK_ASK_OFF) => None,
        Some(value) => Some(value.to_string()),
    }
}

/// What the settings screen shows for the hotkey.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAskShortcut {
    /// The chord bound right now from the stored preference — `None` when switched off.
    pub accelerator: Option<String>,
    /// This platform's default, for the "reset" control.
    pub default_accelerator: String,
}

/// The stored preference, resolved. Read-only: binding is [`register_quick_ask_shortcut`]'s.
#[tauri::command]
pub fn get_quick_ask_shortcut(db: tauri::State<crate::db::Db>) -> QuickAskShortcut {
    let stored = db
        .0
        .lock()
        .ok()
        .and_then(|conn| crate::db::queries::get_setting(&conn, QUICK_ASK_ACCELERATOR_KEY).ok().flatten());
    QuickAskShortcut {
        accelerator: resolve_quick_ask_accelerator(stored.as_deref()),
        default_accelerator: DEFAULT_QUICK_ASK_ACCELERATOR.to_string(),
    }
}

/// Drops the system-wide chord, leaving the ask box reachable from the tray and the palette only.
#[tauri::command]
pub fn unregister_quick_ask_shortcut(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    crate::applog::info("window: quick-ask shortcut switched off");
    Ok(())
}

/// Raises the ask box, building it if it is not there.
///
/// Its own builder rather than a branch inside [`open_satellite`], because almost nothing about the
/// geometry is shared: this window is small, centred, resizable only within a narrow band, has no
/// task-bar entry to alt-tab to, and floats above other applications — which is the only way a box
/// summoned by a global hotkey can work at all, since the application the user was in keeps the
/// focus the moment it is drawn behind it.
///
/// It is still registered in [`SatelliteRegistry`], and that is deliberate: `forget` must reap it
/// on `Destroyed`, the claim on its label is what keeps it to one window, and [`close_all`] has to
/// be able to *see* it in order to skip it. It is the one entry the ceilings do not count.
pub async fn open_quick_ask(app: AppHandle) -> Result<String, String> {
    let label = label_for(SatelliteKind::Quick, QUICK_REF_ID);
    crate::applog::info(&format!("window: open_quick_ask {label}"));

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(label);
    }

    let registry = app.state::<SatelliteRegistry>();
    {
        let mut held = registry.open.lock().map_err(|e| e.to_string())?;
        /*
         * The slot is **claimed here, before the build**, and that ordering is the whole point.
         *
         * `get_webview_window` above answers "is it already on screen?", and between that question
         * and the window existing there is a window of time this function is not alone in: it is
         * `async`, it is reached from a hotkey that can be tapped twice, and it was until recently
         * reached twice for a single press (see `register_quick_ask_shortcut`). Two calls that both
         * found nothing both went on to build, and the result was two identical undecorated windows
         * centred on top of each other — an ask box that survived its own close button and looked
         * like it was refusing to be dragged, because the one underneath was not moving.
         *
         * Claiming the label under the same lock that checks it makes the second call a no-op. It
         * is released again if the build fails, so a refusal does not leave a slot claimed for a
         * window that never existed.
         */
        if held.contains_key(&label) {
            return Ok(label);
        }
        // No ceiling check: the ask box is one window, never counted against either limit (see
        // `SatelliteKind::Quick`), and the label claim above is what keeps it to one.
        held.insert(
            label.clone(),
            SatelliteInfo {
                label: label.clone(),
                kind: SatelliteKind::Quick,
                ref_id: QUICK_REF_ID.to_string(),
                title: "CodeFlow".to_string(),
            },
        );
    }

    let url = format!("window.html?kind={}&ref={}", SatelliteKind::Quick.slug(), QUICK_REF_ID);

    let look = crate::glass::stored(&app);
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        // As the main window (see `lib.rs`): without it WebView2 refuses every clipboard read.
        .enable_clipboard_access()
        // As every other window — see `open_satellite`.
        .transparent(true)
        .title("CodeFlow")
        .inner_size(720.0, 420.0)
        .min_inner_size(520.0, 220.0)
        .center()
        // Above the application the user was working in, because that application still has the
        // focus when this appears and a box that opens behind it is a chord that did nothing.
        .always_on_top(true)
        // Not a destination to alt-tab into. It is summoned and dismissed; leaving a task-bar entry
        // behind would make it a fourth CodeFlow window in the switcher that nobody put there.
        .skip_taskbar(true)
        // No frame on any platform, unlike the other satellites: there is no title bar to draw,
        // because there is nothing in this window a title bar would be about.
        .decorations(false)
        .resizable(true);

    // A resized ask box should not be remembered anywhere or restored by `window_state` — it is
    // summoned at a size, used, and dismissed. Nothing here opts it in, which is the point of
    // saying so: `window_state` tracks the main window by label.
    #[cfg(target_os = "macos")]
    {
        // Follows the user onto whichever desktop/space they are on. Without it the chord switches
        // spaces out from under them to show a window that was opened on another one — the single
        // most disorienting thing a global hotkey can do.
        builder = builder.visible_on_all_workspaces(true);
    }
    if let Some(script) = crate::glass::init_script(&look) {
        builder = builder.initialization_script(script);
    }

    match builder.build() {
        Ok(window) => crate::glass::on_create(&window, &look),
        Err(e) => {
            // Hands the claim back. A slot held for a window that failed to open would count against
            // `MAX_SATELLITES` for the life of the process, and — worse here — the guard above would
            // read it as "already open" and answer every future press of the chord with a no-op.
            if let Ok(mut held) = registry.open.lock() {
                held.remove(&label);
            }
            return Err(e.to_string());
        }
    }

    announce(&app);
    Ok(label)
}

/// What the hotkey, the tray item and the frontend all call. See [`open_quick_ask`].
#[tauri::command]
pub async fn quick_ask_open(app: AppHandle) -> Result<String, String> {
    open_quick_ask(app).await
}

/// Puts the main window back on screen, from a window that is not it.
///
/// # Why `setFocus` from the frontend was not enough
///
/// The `focus-main` message on the window bus does exactly what it says: the main window calls
/// `setFocus()` on itself. That is the right amount of work for the case it was written for — a
/// satellite re-attaching, where the main window is on screen and merely behind something.
///
/// The ask box is the case where it is not. Its entire premise is that it is reachable *while the
/// desk is away*: the main window hides to the tray on its close button, on ⌘W and on Alt+F4, and
/// `close_all` deliberately spares this one window so the hotkey goes on working afterwards (see
/// the note there). So "Open in CodeFlow" is routinely pressed with the main window hidden — and
/// `setFocus()` on a window the platform has hidden raises nothing. The conversation was handed
/// over correctly, to a window the user never saw.
///
/// [`crate::tray::show_main_window`] is the single door every restore path already goes through —
/// the tray's *Show*, a left click on the icon, a second launch, the macOS Dock `Reopen` — and it
/// is the one that knows the whole of the inverse of hiding: `show` before `unminimize` before
/// `set_focus`, the WebView2 controller told to draw again on Windows, and `app:foreground` emitted
/// so the frontend knows it is being looked at. This is that door, with a doorbell on the outside.
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::tray::show_main_window(&app);
}

/// Destroys the ask box, webview and all.
///
/// The heavier of the two ways it goes away, and the one that is not the ordinary one: dismissing
/// it — Escape, or the hotkey pressed while it is up — **hides** it, because it is re-summoned many
/// times in a session and rebuilding a webview each time is the difference between "instant" and "a
/// beat" (`QuickAskWindow.tsx` says the same thing at its own Escape handler). This is the command
/// for genuinely being done with it: it releases the webview and takes the window out of the
/// registry, which is what frees its slot against [`MAX_SATELLITES`].
///
/// Nothing is lost either way. The conversation is in SQLite from the moment the question is
/// asked — it is already the first row of the main window's sidebar — so a rebuilt box starting
/// empty is the correct state rather than a loss.
#[tauri::command]
pub fn quick_ask_close(app: AppHandle) -> Result<(), String> {
    let label = label_for(SatelliteKind::Quick, QUICK_REF_ID);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Binds (or rebinds) the system-wide chord that raises the ask box.
///
/// # Why this returns `Err` rather than logging
///
/// A global accelerator is a claim on a chord for the whole machine, and the two ways it fails are
/// both invisible: the string does not parse (`"Alt+Spce"`, a modifier name from a different
/// platform's vocabulary), or the chord is already owned by another application — Spotlight,
/// Alfred, Raycast and a dozen window managers all live in exactly the same keys this feature wants.
/// Neither produces anything the user can see. They press the chord, nothing happens, and there is
/// no surface anywhere in the app that would explain why: the setting still shows what they typed.
///
/// So the failure is returned, loudly, to the one context that can say something about it — the
/// settings field the accelerator was typed into. A silently unbound hotkey is the worst available
/// outcome and is the one this signature exists to prevent.
///
/// **Every previous binding is dropped first.** Rebinding without unregistering would leave the old
/// chord live as well, so a user who moved the hotkey three times would have three of them — and,
/// worse, would have no way to get rid of the ones they moved away from short of restarting.
#[tauri::command]
pub fn register_quick_ask_shortcut(app: AppHandle, accelerator: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        return Err("a quick-ask shortcut needs an accelerator".to_string());
    }

    let manager = app.global_shortcut();
    // Not conditional on there being one: the plugin's own bookkeeping is the authority on what is
    // registered, and this process may have inherited a binding from an earlier call in this
    // session that failed halfway.
    manager.unregister_all().map_err(|e| e.to_string())?;

    // `register`, and **not** `on_shortcut`. The difference is one call per press.
    //
    // The plugin dispatches a press to *both* handlers it can find: the one attached to the
    // shortcut itself and the process-wide one given to `Builder::with_handler` — see
    // `set_event_handler` in the plugin, which calls each in turn with no `else` between them. This
    // function used to attach its own, and `lib.rs` already installs the process-wide one, so a
    // single ⌥Space ran `toggle_quick_ask` twice.
    //
    // What that looked like is worth writing down, because nothing about it says "the hotkey fired
    // twice": two calls reach the `get_webview_window` guard in `open_quick_ask` before either has
    // built anything, so both go on to build — and the result is **two identical undecorated
    // windows, centred, exactly on top of each other**. One ask box that will not go away when you
    // close it, whose composer is not the one you can see, and which appears to ignore being
    // dragged because the window underneath stays where it was.
    //
    // So the handler stays in exactly one place, which is where `lib.rs` says it is, and this
    // function does the one thing its name claims: bind the chord.
    manager.register(accelerator).map_err(|e| {
        crate::applog::info(&format!("window: quick-ask shortcut '{accelerator}' refused: {e}"));
        format!("could not bind '{accelerator}': {e}")
    })?;

    crate::applog::info(&format!("window: quick-ask shortcut bound to '{accelerator}'"));
    Ok(())
}

/// What one press of the chord does: raise the box, or put it away if it is already up.
///
/// A toggle rather than "always open", because the chord is the only control this window is
/// guaranteed to have — it is summoned over another application, so the user's hands are on the
/// keyboard and nowhere near its close button. Pressing it again has to be the way out, or the
/// hotkey is a one-way door.
///
/// **Hidden, not closed** — the same choice Escape makes inside the window, for the same reason:
/// this is pressed many times in a session and a rebuilt webview is a visible beat before the box
/// appears. [`quick_ask_close`] is the other one, for being done with it.
pub fn toggle_quick_ask(app: &AppHandle) {
    let label = label_for(SatelliteKind::Quick, QUICK_REF_ID);
    if let Some(window) = app.get_webview_window(&label) {
        // Focused means "you are looking at it and pressed the chord again" — dismiss. Anything
        // else — hidden, or up but behind another application — is a request to raise it. Checking
        // focus rather than visibility is what makes the second case work: a visible box the user
        // cannot see because their editor is over it must come forward, not disappear.
        if window.is_focused().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
    let handle = app.clone();
    // The builder is async and this is called from the hotkey callback, which is not.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = open_quick_ask(handle).await {
            crate::applog::info(&format!("window: quick ask could not open: {e}"));
        }
    });
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

    fn info(label: &str, kind: SatelliteKind, ref_id: &str) -> SatelliteInfo {
        SatelliteInfo { label: label.into(), kind, ref_id: ref_id.into(), title: String::new() }
    }

    /// A running (mock) app with these satellites in its registry. No windows exist behind them,
    /// which `close_all` tolerates: a label whose window is already gone is simply skipped.
    fn desk(entries: &[(&str, SatelliteKind, &str)]) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(SatelliteRegistry::default());
        {
            let registry = app.state::<SatelliteRegistry>();
            let mut held = registry.open.lock().unwrap();
            for (label, kind, ref_id) in entries {
                held.insert(label.to_string(), info(label, *kind, ref_id));
            }
        }
        app
    }

    const NOTES: (&str, SatelliteKind, &str) = ("sat-app-notes", SatelliteKind::App, "notes");
    const REPO: (&str, SatelliteKind, &str) = ("sat-repo-p1", SatelliteKind::Repo, "p1");
    const ASK: (&str, SatelliteKind, &str) = ("sat-quick-ask", SatelliteKind::Quick, QUICK_REF_ID);

    /// **The regression.** `close_all` closed the windows and parked nothing, so the tray restore
    /// always found an empty list — the only test filled `parked` by hand. Through `close_all` now,
    /// and the restore's drain after it.
    #[test]
    fn putting_the_desk_away_parks_it_for_the_restore() {
        let app = desk(&[NOTES, REPO, ASK]);
        close_all(app.handle());

        let registry = app.state::<SatelliteRegistry>();
        let parked = registry.take_parked();
        let labels: Vec<&str> = parked.iter().map(|p| p.info.label.as_str()).collect();
        assert_eq!(labels, ["sat-app-notes", "sat-repo-p1"], "the ask box is never put away");
        assert!(parked.iter().all(|p| !p.hidden));
        // Drained: a second `app:foreground` — alt-tabbing back after already restoring — must not
        // reopen what the user has closed since.
        assert!(registry.take_parked().is_empty(), "the desk comes back exactly once");
    }

    /// Closing the main window used to destroy every detached editor, unsaved tabs and all. A
    /// window that reported unsaved work is hidden instead, and the restore shows it again.
    #[test]
    fn a_window_holding_unsaved_work_is_hidden_not_closed() {
        let app = desk(&[NOTES, REPO]);
        let registry = app.state::<SatelliteRegistry>();
        registry.unsaved.lock().unwrap().insert("sat-repo-p1".into());

        assert_eq!(
            registry.put_away(),
            PutAway { close: vec!["sat-app-notes".into()], hide: vec!["sat-repo-p1".into()] }
        );
        let parked = registry.take_parked();
        assert!(parked.iter().any(|p| p.info.label == "sat-repo-p1" && p.hidden));
        assert!(parked.iter().any(|p| p.info.label == "sat-app-notes" && !p.hidden));
    }

    /// Nothing is parked until something parks it. A launch therefore restores nothing, which is
    /// the whole point: the list used to live in `app_settings` and every window ever detached came
    /// back on every start.
    #[test]
    fn a_fresh_registry_has_no_desk_to_restore() {
        let registry = SatelliteRegistry::default();
        assert!(registry.take_parked().is_empty());
        assert!(registry.open.lock().unwrap().is_empty());
    }

    /// The label the spec names, and the property that makes the hotkey idempotent: one ask box,
    /// always at the same address.
    #[test]
    fn the_quick_ask_window_is_a_singleton_at_a_known_label() {
        let label = label_for(SatelliteKind::Quick, QUICK_REF_ID);
        assert_eq!(label, "sat-quick-ask");
        assert!(is_satellite(&label), "it must be covered by the `sat-*` capability");
        assert_eq!(label, label_for(SatelliteKind::Quick, QUICK_REF_ID));
    }

    /// The ask box is hidden, not closed, between uses — "open" all day — so counting it made a
    /// limit of four windows mean three once the hotkey had been pressed.
    #[test]
    fn the_ask_box_never_counts_against_the_ceiling() {
        let app = desk(&[NOTES, ASK]);
        let registry = app.state::<SatelliteRegistry>();
        let held = registry.open.lock().unwrap();
        assert_eq!(SatelliteRegistry::counted(&held), 1);
    }

    /// Unset gets the default, "off" gets nothing, anything else is the user's chord.
    #[test]
    fn the_hotkey_setting_tells_unset_from_off() {
        assert_eq!(
            resolve_quick_ask_accelerator(None).as_deref(),
            Some(DEFAULT_QUICK_ASK_ACCELERATOR)
        );
        assert_eq!(
            resolve_quick_ask_accelerator(Some("  ")).as_deref(),
            Some(DEFAULT_QUICK_ASK_ACCELERATOR)
        );
        assert_eq!(resolve_quick_ask_accelerator(Some(QUICK_ASK_OFF)), None);
        assert_eq!(
            resolve_quick_ask_accelerator(Some("Ctrl+Shift+Space")).as_deref(),
            Some("Ctrl+Shift+Space")
        );
    }

    /// Alt+Space is the window menu of every application on Windows; the default must not take it.
    #[test]
    fn the_default_hotkey_leaves_the_windows_system_menu_alone() {
        if cfg!(target_os = "macos") {
            assert_eq!(DEFAULT_QUICK_ASK_ACCELERATOR, "Alt+Space");
        } else {
            assert_ne!(DEFAULT_QUICK_ASK_ACCELERATOR, "Alt+Space");
        }
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
        // A floating editor's id is a path, and `URLSearchParams` would read these two back wrong.
        assert_eq!(urlencode("p1:c++/100%.md"), "p1%3Ac%2B%2B/100%25.md");
    }

    /// A file's id is a path, and two paths that fold to the same spelling are still two files —
    /// with the sanitised label the second window would have "already existed".
    #[test]
    fn two_files_never_share_a_window() {
        let a = label_for(SatelliteKind::File, "p1:src/a-b.ts");
        let b = label_for(SatelliteKind::File, "p1:src/a_b.ts");
        assert_ne!(a, b);
        assert_eq!(a, label_for(SatelliteKind::File, "p1:src/a-b.ts"), "the restore needs it stable");
        assert!(is_satellite(&a));
        assert!(
            a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "{a} carries a character the window system may refuse"
        );
        assert_ne!(a, label_for(SatelliteKind::Repo, "p1:src/a-b.ts"));
    }

    /// A floating editor is a webview like any other, so it is a window like any other for the
    /// ceilings — unlike the ask box.
    #[test]
    fn a_floating_editor_counts_against_the_ceiling() {
        let app = desk(&[NOTES, ASK, ("sat-file-1", SatelliteKind::File, "p1:src/main.rs")]);
        let registry = app.state::<SatelliteRegistry>();
        let held = registry.open.lock().unwrap();
        assert_eq!(SatelliteRegistry::counted(&held), 2);
    }
}
