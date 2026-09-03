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
//! webview without a menu anyway.
//!
//! It has since grown past that minimum, because a Mac user reaches for the menu bar for four
//! things before they look anywhere else: **⌘, for settings**, *Check for Updates…*, a **Help**
//! menu, and the **Window** list. None of those existed. Every added item is a message to the
//! frontend rather than logic here — the app already knows how to open its own settings, and a
//! second implementation in Rust would be a second thing to keep in step.

#[cfg(target_os = "macos")]
use tauri::{
    Emitter,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager,
};

#[cfg(target_os = "macos")]
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let name = app.package_info().name.clone();

    // Quit is a custom item rather than `PredefinedMenuItem::quit` so it goes through the same
    // path as the tray's Quit: the close handler hides the window instead of exiting unless
    // `QuittingFlag` is set first, so the predefined item would make ⌘Q *hide* the app.
    let quit = MenuItem::with_id(app, "quit", format!("Quit {name}"), true, Some("Cmd+Q"))?;

    // ⌘, is the chord every Mac app uses for this, and until now pressing it here did nothing.
    // AppKit resolves menu key equivalents before the webview sees the key, so a settings item in
    // the menu is the only way that chord can work at all — the same reason the Edit menu exists.
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("Cmd+,"))?;
    let check_updates = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;

    let shortcuts = MenuItem::with_id(app, "shortcuts", "Keyboard Shortcuts", true, Some("Cmd+Alt+K"))?;
    let tour = MenuItem::with_id(app, "tour", "Guided Tour", true, None::<&str>)?;
    let docs = MenuItem::with_id(app, "docs", "Documentation", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report-issue", "Report an Issue", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "reveal-logs", "Reveal Log Folder", true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // `PredefinedMenuItem::fullscreen` and the window list AppKit maintains itself are what make
    // this a real Window menu rather than three buttons: the list is populated by the platform for
    // every window the app opens, which for this app means every satellite.
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&shortcuts, &tour, &PredefinedMenuItem::separator(app)?, &docs, &report, &logs],
    )?;

    app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu, &help_menu])?)?;

    app.on_menu_event(|app, event| {
        let id = event.id.as_ref();
        if id == "quit" {
            // Cmd+Q is a real quit, so it takes the same closing backup as the tray's.
            crate::backup::auto::flush_on_exit(app);
            app.state::<crate::tray::QuittingFlag>().mark_quitting();
            app.exit(0);
            return;
        }

        // "Reveal the logs" is the one item that is genuinely a Rust action: it opens a folder this
        // side owns and the frontend has no path to.
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
    Ok(())
}
