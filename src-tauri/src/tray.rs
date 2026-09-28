use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, Wry};

/// Flips to `true` only when the user deliberately quits (tray menu "Quit", or the platform's
/// own quit shortcut) — the main window's close button/Alt+F4/red traffic light all raise the
/// same `CloseRequested` event, which is intercepted to hide the window instead *unless* this
/// is set, matching the "stays running in the background, like Docker Desktop" requirement.
#[derive(Default)]
pub struct QuittingFlag(AtomicBool);

impl QuittingFlag {
    pub fn is_quitting(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn mark_quitting(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Brings the main window back, from wherever it went.
///
/// **Every** restore path goes through here, and that is load-bearing rather than tidy: the tray
/// icon's click and its "Show" item, a second launch of the binary (the `single_instance` callback
/// in `lib.rs`), and clicking the Dock icon on macOS. Anything new that raises the window belongs
/// here too, because of what the first line does.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // The exact inverse of `hide_to_background`, and it has to come *before* `show()`.
        //
        // On Windows, hiding to the tray also tells the WebView2 controller it is invisible, which
        // is what stops it rendering and holding a compositor's worth of memory for a window nobody
        // can see. Showing the tao window without undoing that puts a window on screen with a
        // webview inside it that has been told not to draw — the app comes back *blank*, which is a
        // far worse bug than the one the hiding fixes. No-op on the launches where it was never
        // hidden, so it is safe on every path in unconditionally.
        #[cfg(windows)]
        {
            let webview: &tauri::Webview<_> = window.as_ref();
            let _ = webview.show();
            // Lets WebView2 cache normally again after `hide_to_background` told it to travel
            // light. Not part of the ordering constraint above — see the note on the helper.
            crate::set_webview_memory_target(&window, false);
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // The other half of `app:background` (see `lib.rs`'s close handler): the webview never
        // stopped running, so the only thing that tells the frontend it is on screen again — and
        // that an agent chain may start dispatching once more — is this.
        let _ = app.emit("app:foreground", ());
    }
}

/// The tray's labels, in the language the app is set to.
///
/// Decided here rather than translated on the frontend, because the tray is built before any window
/// exists and lives outside the webview entirely — `useT` is not reachable from here and never will
/// be.
///
/// **They follow a language change as it happens.** They used to wait for the next launch, on the
/// reasoning that rebuilding the tray means re-registering the icon, which on Windows briefly
/// removes it from the notification area. Nothing has to be rebuilt: the items are kept and
/// relabelled in place ([`relabel`]), which is what `settings:changed` triggers.
struct TrayLabels {
    show: &'static str,
    quick_ask: &'static str,
    check_updates: &'static str,
    restart: &'static str,
    quit: &'static str,
}

fn labels(app: &AppHandle) -> TrayLabels {
    tray_labels(spanish(app))
}

fn tray_labels(spanish: bool) -> TrayLabels {
    if spanish {
        TrayLabels {
            show: "Mostrar CodeFlow",
            quick_ask: "Nueva consulta rápida",
            check_updates: "Buscar actualizaciones…",
            restart: "Reiniciar CodeFlow",
            quit: "Salir de CodeFlow",
        }
    } else {
        TrayLabels {
            show: "Show CodeFlow",
            quick_ask: "New quick ask",
            check_updates: "Check for updates…",
            restart: "Restart CodeFlow",
            quit: "Quit CodeFlow",
        }
    }
}

/// The settings key the language lives under — `languageStore`'s `KEY`.
pub(crate) const LANGUAGE_KEY: &str = "app_language";

/// Whether the native menus (this tray, the macOS app menu) should speak Spanish.
///
/// The language the user picked, or — until they pick one — the operating system's, the same rule
/// `languageStore` follows on a first run. The menus used to default to English on a fresh install
/// whatever the machine spoke, so the tray and the window disagreed from the first minute.
pub(crate) fn spanish(app: &AppHandle) -> bool {
    let stored = app
        .try_state::<crate::db::Db>()
        .and_then(|db| db.0.lock().ok().and_then(|conn| {
            crate::db::queries::get_setting(&conn, LANGUAGE_KEY).ok().flatten()
        }));
    speaks_spanish(stored.as_deref(), tauri_plugin_os::locale().as_deref())
}

/// [`spanish`]'s rule over plain values: a stored choice wins; with none, any `es*` locale is
/// Spanish and everything else English.
fn speaks_spanish(stored: Option<&str>, locale: Option<&str>) -> bool {
    match stored.map(str::trim) {
        Some("es") => true,
        Some("en") => false,
        _ => locale.is_some_and(|l| l.trim().to_ascii_lowercase().starts_with("es")),
    }
}

/// The operating system's locale (`es-CL`, `en-US`…), for the frontend's first-run language.
#[tauri::command]
pub fn system_locale() -> Option<String> {
    tauri_plugin_os::locale()
}

/// The key a `settings:changed` frame names — see `commands/settings.rs`.
pub(crate) fn changed_setting_key(payload: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get("key")?
        .as_str()
        .map(str::to_string)
}

// ---------- the tray menu's ids ----------

const SHOW: &str = "tray:show";
const QUICK_ASK: &str = "tray:quick-ask";
const CHECK_UPDATES: &str = "tray:check-updates";
const RESTART: &str = "tray:restart";
const QUIT: &str = "tray:quit";

/// Every id the tray's menu uses. `appmenu` holds its own list to this one in a test.
#[cfg(test)]
pub(crate) const TRAY_MENU_IDS: [&str; 5] = [SHOW, QUICK_ASK, CHECK_UPDATES, RESTART, QUIT];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayAction {
    Show,
    QuickAsk,
    CheckUpdates,
    Restart,
    Quit,
}

/// Which tray item an id names — `None` for every id that is not the tray's.
///
/// **Why the ids carry a prefix.** Tauri hands every menu event to every global menu listener, and
/// on macOS there are two: this one and the app menu's (`appmenu.rs`). With the bare ids the two
/// menus shared, one click reached both handlers — Quit ran twice (`quit_guard` had to learn to drop
/// the second), and the app menu's handler, which shows the main window before anything else, also
/// ran for "New quick ask" and "Restart": the ask box, whose whole point is not putting the desk
/// back on screen, brought the desk back on screen. Ids no other menu uses make each handler answer
/// only for its own items; the prefix is what makes that true for every item, not just the ones
/// someone remembered to special-case.
fn tray_action(id: &str) -> Option<TrayAction> {
    match id {
        SHOW => Some(TrayAction::Show),
        QUICK_ASK => Some(TrayAction::QuickAsk),
        CHECK_UPDATES => Some(TrayAction::CheckUpdates),
        RESTART => Some(TrayAction::Restart),
        QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

/// The tray's items, kept so a language change can relabel them in place.
#[derive(Default)]
pub struct TrayMenu(Mutex<Option<[MenuItem<Wry>; 5]>>);

/// Puts the tray's labels in the current language. See [`TrayLabels`].
pub fn relabel(app: &AppHandle) {
    let labels = labels(app);
    let Some(state) = app.try_state::<TrayMenu>() else { return };
    let Ok(held) = state.0.lock() else { return };
    if let Some([show, quick_ask, check_updates, restart, quit]) = held.as_ref() {
        let _ = show.set_text(labels.show);
        let _ = quick_ask.set_text(labels.quick_ask);
        let _ = check_updates.set_text(labels.check_updates);
        let _ = restart.set_text(labels.restart);
        let _ = quit.set_text(labels.quit);
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let labels = labels(app);
    let show_item = MenuItem::with_id(app, SHOW, labels.show, true, None::<&str>)?;
    // Directly under "show", because it is the *other* way into the app and the cheaper one: the
    // ask box needs no workspace, no repository and no window to already be open.
    //
    // It exists in this menu as well as on the global chord for a reason that is not redundancy.
    // The chord can fail to bind — another application owns it, or the user typed an accelerator
    // that does not parse — and when it does, `register_quick_ask_shortcut` returns the error to a
    // settings field the user may not be looking at. This row is what keeps the feature reachable
    // in the meantime, and it is also how somebody discovers the feature exists at all.
    let quick_ask_item = MenuItem::with_id(app, QUICK_ASK, labels.quick_ask, true, None::<&str>)?;
    // Here and not only in Settings, because Settings is inside the window: a release whose window
    // never comes up — or comes up blank — could not update itself out of trouble, and the way back
    // was a manual download. This asks the updater from Rust, with native dialogs, and needs nothing
    // from the webview. See `updates`.
    let check_updates_item =
        MenuItem::with_id(app, CHECK_UPDATES, labels.check_updates, true, None::<&str>)?;
    // Between "show" and "quit" on purpose: it is the thing to try when "show" produced a window
    // that is there but wrong — a wedged webview, a view that stopped repainting — and the only
    // alternative left is quitting and finding the app again.
    let restart_item = MenuItem::with_id(app, RESTART, labels.restart, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, QUIT, labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &quick_ask_item, &check_updates_item, &restart_item, &quit_item],
    )?;
    app.manage(TrayMenu::default());
    if let Ok(mut held) = app.state::<TrayMenu>().0.lock() {
        *held = Some([show_item, quick_ask_item, check_updates_item, restart_item, quit_item]);
    }
    // A language picked in Settings reaches the tray at once. `listen_any` hears the `emit` in
    // `set_setting` — the same delivery `remotectl::bridge` relies on and tests.
    let handle = app.clone();
    app.listen_any("settings:changed", move |event| {
        if changed_setting_key(event.payload()).as_deref() == Some(LANGUAGE_KEY) {
            relabel(&handle);
        }
    });

    // The menu bar gets the mark alone, as a template: macOS paints a template image itself — black
    // on a light bar, white on a dark one, dimmed while another app's menu is open — which a colour
    // icon cannot do, and at 18pt the app's gradient reads as a smudge. Windows and Linux keep the
    // app icon; their trays are drawn in colour by every app.
    #[cfg(target_os = "macos")]
    let (icon, template) = (tauri::include_image!("./icons/tray-template.png"), true);
    #[cfg(not(target_os = "macos"))]
    let (icon, template) = (
        app.default_window_icon().cloned().expect("app icon must be bundled"),
        false,
    );

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .icon_as_template(template)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("CodeFlow")
        .on_menu_event(|app, event| match tray_action(event.id.as_ref()) {
            // Not the tray's item — the app menu's, delivered here too. See `tray_action`.
            None => {}
            Some(TrayAction::Show) => show_main_window(app),
            // Deliberately does NOT raise the main window first. The whole proposition of the ask
            // box is that it costs nothing to reach — putting the desk back on screen in order to
            // ask one question is the thing it exists to avoid.
            Some(TrayAction::QuickAsk) => crate::windows::toggle_quick_ask(app),
            // Answered with native dialogs from a thread of its own, and without raising the window:
            // the window is what this item exists to do without.
            Some(TrayAction::CheckUpdates) => crate::updates::check_from_tray(app),
            // Re-execs the binary: the whole process goes, backend included, which is the point —
            // a reload of the webview alone would leave a wedged Rust side exactly as wedged.
            //
            // The backup is flushed first for the same reason "quit" flushes it: this ends the
            // session, and an ending session is the one a scheduled backup is least likely to have
            // caught. `mark_quitting` so the window closing on the way out is not mistaken for the
            // user pressing the red button and re-hidden to the tray — the restarted process gets
            // a fresh flag of its own.
            Some(TrayAction::Restart) => {
                crate::backup::auto::flush_on_exit(app);
                app.state::<QuittingFlag>().mark_quitting();
                // `request_restart`, not `restart`. A menu event is delivered on the main thread,
                // and `restart` called from there says so in its own docs: it skips `ExitRequested`
                // and `Exit` and re-execs immediately. The exit handler in `lib.rs` is what closes
                // the database sessions and kills the tunnels' `ssh` children, so restarting the
                // short way would leave one stranded forward behind per press — on the button
                // people press repeatedly when something already feels stuck.
                app.request_restart();
            }
            // Asked about unsaved work first — see `quit_guard`, which also does the closing
            // backup and sets the quitting flag once the quit is really going ahead.
            Some(TrayAction::Quit) => crate::quit_guard::request_quit(app),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, .. } = event {
                if button == tauri::tray::MouseButton::Left {
                    show_main_window(tray.app_handle());
                }
            }
        })
        .build(app)?;

    Ok(())
}

// ---------- what the main window's close button does ----------

/// The `app_settings` key for the close button's behaviour: `"tray"` (the default, also what an
/// absent row means) keeps the app running in the background; `"quit"` ends it.
pub const CLOSE_BEHAVIOR_KEY: &str = "close_behavior";

/// Set once the user has been told, the first time, that closing the window keeps the app running.
pub const TRAY_NOTICE_KEY: &str = "tray_notice_seen";

/// What one press of the main window's close button does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Into the background, the way it always did.
    Hide,
    /// A real quit — through `quit_guard`, so unsaved work is asked about first.
    Quit,
    /// The first time: ask the main window to say where the app is going before it goes.
    Notice,
}

/// Whether the notice was already put up in this session. A second press of the close button while
/// it is unanswered — or after it was dismissed — hides, so a window that cannot answer (a wedged
/// webview) can still be put away.
static NOTICE_ASKED: AtomicBool = AtomicBool::new(false);

/// [`close_action`]'s rule over plain values.
fn decide_close(behavior: Option<&str>, notice_seen: bool, asked_this_session: bool) -> CloseAction {
    if behavior.map(str::trim) == Some("quit") {
        return CloseAction::Quit;
    }
    if !notice_seen && !asked_this_session {
        return CloseAction::Notice;
    }
    CloseAction::Hide
}

/// What the close button should do now, from the two settings behind it.
///
/// **Why there is a question at all.** The close button used to hide the window, always and
/// silently: the app vanished from the task bar and went on running in the tray, and nothing on
/// screen said so — the only way to actually quit was a menu the user had no reason to look in. So
/// the first close says where the app is going (and offers to quit instead), and Settings › General
/// has the choice for good.
pub fn close_action(app: &AppHandle) -> CloseAction {
    let (behavior, seen) = app
        .try_state::<crate::db::Db>()
        .and_then(|db| {
            db.0.lock().ok().map(|conn| {
                let behavior = crate::db::queries::get_setting(&conn, CLOSE_BEHAVIOR_KEY).ok().flatten();
                let seen = crate::db::queries::get_setting(&conn, TRAY_NOTICE_KEY).ok().flatten();
                (behavior, seen.is_some_and(|value| value == "1"))
            })
        })
        .unwrap_or((None, true));
    let action = decide_close(behavior.as_deref(), seen, NOTICE_ASKED.load(Ordering::SeqCst));
    if action == CloseAction::Notice {
        NOTICE_ASKED.store(true, Ordering::SeqCst);
    }
    action
}

/// The main window's answer to the first-close notice: "keep it in the tray". Records that the
/// notice was seen, then puts the window away exactly as the close button would have.
#[tauri::command]
pub fn hide_main_to_tray(app: AppHandle) {
    if let Ok(conn) = app.state::<crate::db::Db>().0.lock() {
        let _ = crate::db::queries::set_setting(&conn, TRAY_NOTICE_KEY, "1");
    }
    crate::put_main_away(&app);
}

/// Whether CodeFlow starts when the user logs in.
///
/// The plugin was registered from the start, for the hotkey's sake — a system-wide chord only helps
/// if the app is running — and nothing ever called it. Commands here rather than the plugin's own
/// IPC so the capability file does not grow three permissions for one switch.
#[tauri::command]
pub fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Turns launch-at-login on or off and answers with what the system now says.
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable().map_err(|e| e.to_string())?;
    } else {
        launcher.disable().map_err(|e| e.to_string())?;
    }
    crate::applog::info(&format!("app: launch at login {}", if enabled { "on" } else { "off" }));
    launcher.is_enabled().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A choice wins; without one, any Spanish locale is Spanish — the first-run rule the webview
    /// follows too, so the tray and the window agree from the first minute.
    #[test]
    fn the_native_menus_follow_the_choice_then_the_system() {
        assert!(speaks_spanish(Some("es"), Some("en-US")));
        assert!(!speaks_spanish(Some("en"), Some("es-CL")));
        assert!(speaks_spanish(None, Some("es-CL")));
        assert!(speaks_spanish(None, Some("ES")));
        assert!(!speaks_spanish(None, Some("en-GB")));
        assert!(!speaks_spanish(None, None));
    }

    /// Every tray id is the tray's and only the tray's: the app menu's ids answer `None` here, which
    /// is what keeps one click from running both handlers. `appmenu` checks the other direction.
    #[test]
    fn the_tray_answers_only_for_its_own_items() {
        for id in TRAY_MENU_IDS {
            assert!(tray_action(id).is_some(), "{id}");
        }
        for foreign in ["quit", "show", "restart", "quick-ask", "check-updates", "settings", "report-issue"] {
            assert_eq!(tray_action(foreign), None, "{foreign}");
        }
        assert_eq!(tray_action(CHECK_UPDATES), Some(TrayAction::CheckUpdates));
    }

    /// Both languages name every item — a blank label is an item that looks like a separator.
    #[test]
    fn both_languages_name_every_item() {
        for spanish in [false, true] {
            let labels = tray_labels(spanish);
            for label in [labels.show, labels.quick_ask, labels.check_updates, labels.restart, labels.quit] {
                assert!(!label.trim().is_empty());
            }
        }
        assert_eq!(tray_labels(true).check_updates, "Buscar actualizaciones…");
    }

    #[test]
    fn a_settings_frame_names_its_key() {
        assert_eq!(
            changed_setting_key(r#"{"key":"app_language","origin":"main"}"#).as_deref(),
            Some("app_language")
        );
        assert_eq!(changed_setting_key("not json"), None);
    }

    /// The first close asks; the choice, once made, is kept; a second press in a session that
    /// already asked goes through rather than asking again.
    #[test]
    fn the_close_button_asks_once_then_does_what_it_was_told() {
        assert_eq!(decide_close(None, false, false), CloseAction::Notice);
        assert_eq!(decide_close(Some("tray"), false, true), CloseAction::Hide);
        assert_eq!(decide_close(Some("tray"), true, false), CloseAction::Hide);
        assert_eq!(decide_close(Some("quit"), false, false), CloseAction::Quit);
        assert_eq!(decide_close(Some("quit"), true, true), CloseAction::Quit);
    }
}
