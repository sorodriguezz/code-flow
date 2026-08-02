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

#[cfg(target_os = "macos")]
use tauri::{
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

    let app_menu = Submenu::with_items(
        app,
        name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
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

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?)?;

    app.on_menu_event(|app, event| {
        if event.id.as_ref() == "quit" {
            // Cmd+Q is a real quit, so it takes the same closing backup as the tray's.
            crate::backup::auto::flush_on_exit(app);
            app.state::<crate::tray::QuittingFlag>().mark_quitting();
            app.exit(0);
        }
    });

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn setup(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}
