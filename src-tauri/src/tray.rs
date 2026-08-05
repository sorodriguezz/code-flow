use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

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

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // The other half of `app:background` (see `lib.rs`'s close handler): the webview never
        // stopped running, so the only thing that tells the frontend it is on screen again — and
        // that an agent chain may start dispatching once more — is this.
        let _ = app.emit("app:foreground", ());
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show CodeFlow", true, None::<&str>)?;
    // Between "show" and "quit" on purpose: it is the thing to try when "show" produced a window
    // that is there but wrong — a wedged webview, a view that stopped repainting — and the only
    // alternative left is quitting and finding the app again.
    let restart_item = MenuItem::with_id(app, "restart", "Restart CodeFlow", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit CodeFlow", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &restart_item, &quit_item])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().expect("app icon must be bundled"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("CodeFlow")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            // Re-execs the binary: the whole process goes, backend included, which is the point —
            // a reload of the webview alone would leave a wedged Rust side exactly as wedged.
            //
            // The backup is flushed first for the same reason "quit" flushes it: this ends the
            // session, and an ending session is the one a scheduled backup is least likely to have
            // caught. `mark_quitting` so the window closing on the way out is not mistaken for the
            // user pressing the red button and re-hidden to the tray — the restarted process gets
            // a fresh flag of its own.
            "restart" => {
                crate::backup::auto::flush_on_exit(app);
                app.state::<QuittingFlag>().mark_quitting();
                app.restart();
            }
            "quit" => {
                // Same last step as the in-app quit: the session about to end is the one a
                // scheduled backup is least likely to have caught.
                crate::backup::auto::flush_on_exit(app);
                app.state::<QuittingFlag>().mark_quitting();
                app.exit(0);
            }
            _ => {}
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
