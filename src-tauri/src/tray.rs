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

/// The tray's labels, in the language the app is set to.
///
/// Read from the database at startup rather than translated on the frontend, because the tray is
/// built before any window exists and lives outside the webview entirely — `useT` is not reachable
/// from here and never will be.
///
/// **It does not follow a language change until the next launch**, and that is the trade this
/// makes: rebuilding the tray on every settings write would mean tearing down and re-registering
/// the icon, which on Windows briefly removes it from the notification area. Three strings that
/// update on restart is the better side of that.
struct TrayLabels {
    show: &'static str,
    restart: &'static str,
    quit: &'static str,
}

fn labels(app: &AppHandle) -> TrayLabels {
    let spanish = app
        .try_state::<crate::db::Db>()
        .and_then(|db| db.0.lock().ok().and_then(|conn| {
            crate::db::queries::get_setting(&conn, "app_language").ok().flatten()
        }))
        .is_some_and(|language| language.starts_with("es"));

    if spanish {
        TrayLabels {
            show: "Mostrar CodeFlow",
            restart: "Reiniciar CodeFlow",
            quit: "Salir de CodeFlow",
        }
    } else {
        TrayLabels {
            show: "Show CodeFlow",
            restart: "Restart CodeFlow",
            quit: "Quit CodeFlow",
        }
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let labels = labels(app);
    let show_item = MenuItem::with_id(app, "show", labels.show, true, None::<&str>)?;
    // Between "show" and "quit" on purpose: it is the thing to try when "show" produced a window
    // that is there but wrong — a wedged webview, a view that stopped repainting — and the only
    // alternative left is quitting and finding the app again.
    let restart_item = MenuItem::with_id(app, "restart", labels.restart, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;
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
                // `request_restart`, not `restart`. A menu event is delivered on the main thread,
                // and `restart` called from there says so in its own docs: it skips `ExitRequested`
                // and `Exit` and re-execs immediately. The exit handler in `lib.rs` is what closes
                // the database sessions and kills the tunnels' `ssh` children, so restarting the
                // short way would leave one stranded forward behind per press — on the button
                // people press repeatedly when something already feels stuck.
                app.request_restart();
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
