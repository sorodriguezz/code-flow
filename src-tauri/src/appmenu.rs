//! The macOS application menu.
//!
//! This exists for one reason: **without an Edit menu, ⌘X/⌘C/⌘V/⌘A never reach the webview.**
//! On macOS those chords are menu *key equivalents* — AppKit resolves them against the menu bar
//! before any view sees the key event, so an app with no Edit menu has no clipboard at all in its
//! plain `<input>`s and `<textarea>`s. It looks like the field is ignoring the paste; really the
//! keystroke was never delivered.
//!
//! macOS only. On Windows and Linux the menu is drawn *inside* the window, where it would sit on
//! top of the app's custom title bar — and those platforms deliver the clipboard chords to the
//! webview without a menu anyway. What the Help menu offers there (report an issue, the log folder,
//! the version) lives in Settings › General › About & diagnostics, for every platform.
//!
//! It has since grown past that minimum, because a Mac user reaches for the menu bar for four
//! things before they look anywhere else: **⌘, for settings**, *Check for Updates…*, a **Help**
//! menu, and the **Window** list. None of those existed. Every added item is a message to the
//! frontend rather than logic here — the app already knows how to open its own settings, and a
//! second implementation in Rust would be a second thing to keep in step.
//!
//! **It speaks the app's language**, and follows it live: the labels were English-only, so a
//! Spanish install had one English corner. [`setup`] listens for the language setting and rebuilds
//! the whole bar — cheap, and simpler than keeping a handle to each of twenty items.

/// Every id this menu's own items carry. Anything else reaching the handler is another menu's item
/// — the tray's, which Tauri delivers to every global menu listener — and must be left alone: see
/// `tray::tray_action` for what answering it used to do.
const APP_MENU_IDS: [&str; 8] = [
    "quit",
    "settings",
    "check-updates",
    "shortcuts",
    "tour",
    "docs",
    "report-issue",
    "reveal-logs",
];

fn is_app_menu_item(id: &str) -> bool {
    APP_MENU_IDS.contains(&id)
}

/// The bar's words, in one language.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct MenuText {
    about: &'static str,
    check_updates: &'static str,
    settings: &'static str,
    services: &'static str,
    hide: &'static str,
    hide_others: &'static str,
    show_all: &'static str,
    quit: &'static str,
    edit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    window: &'static str,
    minimize: &'static str,
    zoom: &'static str,
    fullscreen: &'static str,
    close_window: &'static str,
    help: &'static str,
    shortcuts: &'static str,
    tour: &'static str,
    docs: &'static str,
    report: &'static str,
    logs: &'static str,
}

/// The words macOS itself uses for the standard items in each language, so the bar reads like
/// every other app's bar on the same machine.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn text(spanish: bool) -> MenuText {
    if spanish {
        MenuText {
            about: "Acerca de CodeFlow",
            check_updates: "Buscar actualizaciones…",
            settings: "Configuración…",
            services: "Servicios",
            hide: "Ocultar CodeFlow",
            hide_others: "Ocultar otros",
            show_all: "Mostrar todo",
            quit: "Salir de CodeFlow",
            edit: "Edición",
            undo: "Deshacer",
            redo: "Rehacer",
            cut: "Cortar",
            copy: "Copiar",
            paste: "Pegar",
            select_all: "Seleccionar todo",
            window: "Ventana",
            minimize: "Minimizar",
            zoom: "Zoom",
            fullscreen: "Pantalla completa",
            close_window: "Cerrar ventana",
            help: "Ayuda",
            shortcuts: "Atajos de teclado",
            tour: "Tour guiado",
            docs: "Documentación",
            report: "Reportar un problema",
            logs: "Mostrar carpeta de logs",
        }
    } else {
        MenuText {
            about: "About CodeFlow",
            check_updates: "Check for Updates…",
            settings: "Settings…",
            services: "Services",
            hide: "Hide CodeFlow",
            hide_others: "Hide Others",
            show_all: "Show All",
            quit: "Quit CodeFlow",
            edit: "Edit",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            window: "Window",
            minimize: "Minimize",
            zoom: "Zoom",
            fullscreen: "Enter Full Screen",
            close_window: "Close Window",
            help: "Help",
            shortcuts: "Keyboard Shortcuts",
            tour: "Guided Tour",
            docs: "Documentation",
            report: "Report an Issue",
            logs: "Reveal Log Folder",
        }
    }
}

#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Listener, Wry,
};

/// The whole bar, in the language the app is set to.
#[cfg(target_os = "macos")]
fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let words = text(crate::tray::spanish(app));

    // Quit is a custom item rather than `PredefinedMenuItem::quit` so it goes through the same
    // path as the tray's Quit: the close handler hides the window instead of exiting unless
    // `QuittingFlag` is set first, so the predefined item would make ⌘Q *hide* the app.
    let quit = MenuItem::with_id(app, "quit", words.quit, true, Some("Cmd+Q"))?;

    // ⌘, is the chord every Mac app uses for this, and until now pressing it here did nothing.
    // AppKit resolves menu key equivalents before the webview sees the key, so a settings item in
    // the menu is the only way that chord can work at all — the same reason the Edit menu exists.
    let settings = MenuItem::with_id(app, "settings", words.settings, true, Some("Cmd+,"))?;
    let check_updates = MenuItem::with_id(app, "check-updates", words.check_updates, true, None::<&str>)?;

    let shortcuts = MenuItem::with_id(app, "shortcuts", words.shortcuts, true, Some("Cmd+Alt+K"))?;
    let tour = MenuItem::with_id(app, "tour", words.tour, true, None::<&str>)?;
    let docs = MenuItem::with_id(app, "docs", words.docs, true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report-issue", words.report, true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "reveal-logs", words.logs, true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        app.package_info().name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, Some(words.about), None)?,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(words.services))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(words.hide))?,
            &PredefinedMenuItem::hide_others(app, Some(words.hide_others))?,
            &PredefinedMenuItem::show_all(app, Some(words.show_all))?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        words.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(words.undo))?,
            &PredefinedMenuItem::redo(app, Some(words.redo))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(words.cut))?,
            &PredefinedMenuItem::copy(app, Some(words.copy))?,
            &PredefinedMenuItem::paste(app, Some(words.paste))?,
            &PredefinedMenuItem::select_all(app, Some(words.select_all))?,
        ],
    )?;

    // `PredefinedMenuItem::fullscreen` and the window list AppKit maintains itself are what make
    // this a real Window menu rather than three buttons: the list is populated by the platform for
    // every window the app opens, which for this app means every satellite.
    let window_menu = Submenu::with_items(
        app,
        words.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(words.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(words.zoom))?,
            &PredefinedMenuItem::fullscreen(app, Some(words.fullscreen))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(words.close_window))?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        words.help,
        true,
        &[&shortcuts, &tour, &PredefinedMenuItem::separator(app)?, &docs, &report, &logs],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu, &help_menu])
}

#[cfg(target_os = "macos")]
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(build(app)?)?;

    // Rebuilt, not relabelled, when the language changes: one `set_menu` against twenty handles.
    // Failing leaves the previous bar up, which is a bar in the old language and nothing worse.
    let handle = app.clone();
    app.listen_any("settings:changed", move |event| {
        if crate::tray::changed_setting_key(event.payload()).as_deref() != Some(crate::tray::LANGUAGE_KEY) {
            return;
        }
        match build(&handle) {
            Ok(menu) => {
                let _ = handle.set_menu(menu);
            }
            Err(e) => crate::applog::info(&format!("menu: could not rebuild the app menu — {e}")),
        }
    });

    app.on_menu_event(|app, event| {
        let id = event.id.as_ref();
        // The tray's items arrive here too — Tauri hands every menu event to every global
        // listener. They are the tray's to answer; see `APP_MENU_IDS`.
        if !is_app_menu_item(id) {
            return;
        }
        if id == "quit" {
            // Cmd+Q is a real quit, so it goes the tray's way: asked about unsaved work, then the
            // same closing backup. See `quit_guard`.
            crate::quit_guard::request_quit(app);
            return;
        }

        if id == "reveal-logs" {
            // The one item that is genuinely a Rust action: it opens a folder this side owns and
            // the frontend has no path to. Best effort — a machine with no file manager association
            // is not a failure worth a dialog.
            let _ = open::that(crate::paths::logs_dir());
            return;
        }

        // Everything else is a request the app already knows how to serve. Emitted rather than
        // reimplemented: "open settings" means restoring the window, opening the dialog on the last
        // section and honouring whatever the frontend does about unsaved input — three behaviours
        // that exist once, in TypeScript.
        //
        // The window is shown first, because this app hides to the tray rather than exiting: a menu
        // item that opened settings inside a hidden window would look like it did nothing.
        crate::tray::show_main_window(app);
        let _ = app.emit("cf://menu", id.to_string());
    });

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn setup(_app: &tauri::AppHandle) -> tauri::Result<()> {
    // Referenced so the id list and its check are not dead code off macOS: the test below holds
    // them to the tray's ids on every platform CI builds.
    let _ = is_app_menu_item;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One click reaches both menus' handlers; each must answer only for its own items. The tray
    /// checks its half in `tray::tests`.
    #[test]
    fn the_app_menu_never_answers_for_a_tray_item() {
        for id in crate::tray::TRAY_MENU_IDS {
            assert!(!is_app_menu_item(id), "{id} is claimed by both menus");
        }
        for id in APP_MENU_IDS {
            assert!(is_app_menu_item(id));
        }
    }

    /// Both languages name every item — a blank label is an item that looks like a separator.
    #[test]
    fn both_languages_name_every_item() {
        for spanish in [false, true] {
            let words = text(spanish);
            for label in [
                words.about, words.check_updates, words.settings, words.services, words.hide,
                words.hide_others, words.show_all, words.quit, words.edit, words.undo, words.redo,
                words.cut, words.copy, words.paste, words.select_all, words.window, words.minimize,
                words.zoom, words.fullscreen, words.close_window, words.help, words.shortcuts,
                words.tour, words.docs, words.report, words.logs,
            ] {
                assert!(!label.trim().is_empty());
            }
        }
        assert_eq!(text(true).quit, "Salir de CodeFlow");
    }
}
