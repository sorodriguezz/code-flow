//! Looking for a newer CodeFlow from the Rust side — the tray's "Check for updates…" and the boot
//! watchdog — with native dialogs rather than the app's own screens.
//!
//! The ordinary update check lives in the frontend (`updateStore`), and that is the right place for
//! it while the frontend works. This is the path for when it does not: a release whose window never
//! comes up could not update itself out of trouble, because the only code that knew how was the code
//! that failed to load, and the way back was a manual download. Both paths drive the same plugin
//! against the same endpoint and signing key; this one needs nothing from the webview.
//!
//! An install started here tells the frontend as it goes ([`INSTALL_EVENT`]), so the update notice
//! of a window that *is* up shows the download instead of offering to start a second one.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::MessageDialogKind;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{applog, native_dialog};

/// Where every release is published — the manual way in, for when nothing can be installed from
/// here. The repository `tauri.conf.json`'s updater endpoint reads its manifest from, and the one
/// `REPO_URL` in `lib/diagnostics.ts` links to.
pub const RELEASES_URL: &str = "https://github.com/sorodriguezz/code-flow/releases/latest";

/// What the frontend hears while an install started here runs. Mirrors `NativeInstallEvent` in
/// `updateStore.ts`.
pub const INSTALL_EVENT: &str = "update:native-install";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
enum InstallEvent {
    Downloading { done: u64, total: Option<u64> },
    Failed { error: String },
    Installed,
}

/// One check at a time: a second click on the tray item while the first is still asking or
/// downloading would otherwise start a second download of the same release.
static BUSY: AtomicBool = AtomicBool::new(false);

/// The tray's "Check for updates…". Returns at once; the check runs on a thread of its own, because
/// menu events arrive on the main thread and the dialogs block.
pub fn check_from_tray(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("update-check".into())
        .spawn(move || check_and_offer(&app));
    if let Err(e) = spawned {
        applog::error(&format!("update: could not start the check — {e}"));
    }
}

/// Checks, says what it found, and installs when the user says so — then restarts into the new
/// version. Blocking, with native dialogs: never call it on the main thread.
pub fn check_and_offer(app: &AppHandle) {
    if BUSY.swap(true, Ordering::SeqCst) {
        applog::info("update: a check is already running");
        return;
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            BUSY.store(false, Ordering::SeqCst);
        }
    }
    let _done = Done;

    let spanish = crate::tray::spanish(app);
    let w = words(spanish);
    let current = app.package_info().version.to_string();
    applog::info("update: checking, from the tray or the boot watchdog");
    let found = updater(app).and_then(|updater| tauri::async_runtime::block_on(updater.check()));
    match classify(found) {
        Found::Update(update) => offer(app, spanish, *update),
        Found::UpToDate => {
            native_dialog::ask(app, MessageDialogKind::Info, w.up_to_date_title, &up_to_date_body(spanish, &current), &[w.ok]);
        }
        Found::NoBuild => {
            native_dialog::ask(app, MessageDialogKind::Info, w.no_build_title, w.no_build_body, &[w.ok]);
        }
        Found::Failed(error) => trouble(app, spanish, w.check_failed_title, &error),
    }
}

/// Opens the releases page in the browser. Best effort: a machine with no browser association has
/// no better way to be told.
pub fn open_releases_page() {
    if let Err(e) = open::that(RELEASES_URL) {
        applog::info(&format!("update: could not open the releases page — {e}"));
    }
}

/// The plugin's updater, with this app's cleanup on its way out.
///
/// On Windows the install ends the process from inside `Update::install` — the installer takes over
/// and `std::process::exit` follows — after running this hook and nothing else. The plugin's default
/// hook is `cleanup_before_exit` alone; ours runs the whole shutdown first. See `shutdown`.
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let handle = app.clone();
    app.updater_builder()
        .on_before_exit(move || {
            crate::shutdown::run_outside_runtime(|| crate::shutdown::shutdown_cleanup(&handle));
            handle.cleanup_before_exit();
        })
        .build()
}

enum Found {
    Update(Box<Update>),
    UpToDate,
    /// The release exists and has no build for this OS and architecture — an answer, not a failure,
    /// the same way `updateStore` reads it.
    NoBuild,
    Failed(String),
}

fn classify(result: tauri_plugin_updater::Result<Option<Update>>) -> Found {
    match result {
        Ok(Some(update)) => Found::Update(Box::new(update)),
        Ok(None) => Found::UpToDate,
        Err(tauri_plugin_updater::Error::TargetNotFound(_) | tauri_plugin_updater::Error::TargetsNotFound(_)) => {
            Found::NoBuild
        }
        Err(e) => Found::Failed(e.to_string()),
    }
}

fn offer(app: &AppHandle, spanish: bool, update: Update) {
    let w = words(spanish);
    let title = available_title(spanish, &update.version);
    let body = available_body(spanish, &update.current_version, update.body.as_deref());
    if native_dialog::ask(app, MessageDialogKind::Info, &title, &body, &[w.install, w.not_now]) != Some(0) {
        applog::info(&format!("update: {} found, left for later", update.version));
        return;
    }
    applog::info(&format!("update: downloading {}", update.version));
    let _ = app.emit(INSTALL_EVENT, InstallEvent::Downloading { done: 0, total: None });
    let mut throttle = Throttle::default();
    let mut done: u64 = 0;
    let downloaded = tauri::async_runtime::block_on(update.download(
        |chunk, total| {
            done += chunk as u64;
            if throttle.worth_telling(done, total) {
                let _ = app.emit(INSTALL_EVENT, InstallEvent::Downloading { done, total });
            }
        },
        || {},
    ));
    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(e) => return install_failed(app, spanish, &e.to_string()),
    };
    // Outside `block_on`, on purpose: on Windows this is where the process ends, through the exit
    // hook, and that hook's cleanup blocks on async work of its own.
    if let Err(e) = update.install(bytes) {
        return install_failed(app, spanish, &e.to_string());
    }
    applog::info(&format!("update: {} installed, restarting", update.version));
    let _ = app.emit(INSTALL_EVENT, InstallEvent::Installed);
    app.request_restart();
}

fn install_failed(app: &AppHandle, spanish: bool, error: &str) {
    let _ = app.emit(INSTALL_EVENT, InstallEvent::Failed { error: error.to_string() });
    trouble(app, spanish, words(spanish).install_failed_title, error);
}

/// A failure, with the manual way in offered beside it.
fn trouble(app: &AppHandle, spanish: bool, title: &str, error: &str) {
    applog::warn(&format!("update: {title} — {error}"));
    let w = words(spanish);
    if native_dialog::ask(app, MessageDialogKind::Error, title, error, &[w.releases, w.close]) == Some(0) {
        open_releases_page();
    }
}

/// Decides which download chunks are worth an event: one per percent when the size is known, one per
/// megabyte when it is not. A release is tens of megabytes in chunks of a few kilobytes, and an event
/// per chunk would be thousands of IPC messages to move a bar a hundred times.
#[derive(Default)]
struct Throttle {
    last_percent: Option<u64>,
    last_bytes: u64,
}

impl Throttle {
    fn worth_telling(&mut self, done: u64, total: Option<u64>) -> bool {
        match total.filter(|total| *total > 0) {
            Some(total) => {
                let percent = (done.saturating_mul(100) / total).min(100);
                if self.last_percent == Some(percent) {
                    return false;
                }
                self.last_percent = Some(percent);
                true
            }
            None => {
                if done.saturating_sub(self.last_bytes) < 1 << 20 {
                    return false;
                }
                self.last_bytes = done;
                true
            }
        }
    }
}

// ---------- the words ----------

/// The dialogs' labels, in the app's language — decided here for the reason `tray::TrayLabels` gives.
struct Words {
    install: &'static str,
    not_now: &'static str,
    ok: &'static str,
    close: &'static str,
    releases: &'static str,
    up_to_date_title: &'static str,
    no_build_title: &'static str,
    no_build_body: &'static str,
    check_failed_title: &'static str,
    install_failed_title: &'static str,
}

fn words(spanish: bool) -> Words {
    if spanish {
        Words {
            install: "Instalar y reiniciar",
            not_now: "Ahora no",
            ok: "Aceptar",
            close: "Cerrar",
            releases: "Abrir página de versiones",
            up_to_date_title: "CodeFlow está al día",
            no_build_title: "Nada que instalar",
            no_build_body: "La versión publicada no tiene build para esta plataforma.",
            check_failed_title: "No se pudo buscar actualizaciones",
            install_failed_title: "No se pudo instalar la actualización",
        }
    } else {
        Words {
            install: "Install and restart",
            not_now: "Not now",
            ok: "OK",
            close: "Close",
            releases: "Open releases page",
            up_to_date_title: "CodeFlow is up to date",
            no_build_title: "Nothing to install",
            no_build_body: "The published release has no build for this platform.",
            check_failed_title: "Couldn't check for updates",
            install_failed_title: "Couldn't install the update",
        }
    }
}

fn available_title(spanish: bool, version: &str) -> String {
    if spanish {
        format!("CodeFlow {version} está disponible")
    } else {
        format!("CodeFlow {version} is available")
    }
}

/// How much of a release's notes fits in a message box before it stops being one.
const NOTES_LIMIT: usize = 600;

fn available_body(spanish: bool, current: &str, notes: Option<&str>) -> String {
    let mut body = if spanish { format!("Tienes la {current}.") } else { format!("You have {current}.") };
    if let Some(notes) = notes.map(str::trim).filter(|notes| !notes.is_empty()) {
        body.push_str("\n\n");
        body.push_str(&clip(notes, NOTES_LIMIT));
    }
    body
}

fn up_to_date_body(spanish: bool, current: &str) -> String {
    if spanish {
        format!("Ya tienes la última versión ({current}).")
    } else {
        format!("You're on the latest version ({current}).")
    }
}

/// `text` cut to at most `limit` characters, on a character boundary, with an ellipsis when it was cut.
fn clip(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", text[..end].trim_end()),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_build_for_this_platform_is_an_answer_not_a_failure() {
        assert!(matches!(classify(Ok(None)), Found::UpToDate));
        assert!(matches!(
            classify(Err(tauri_plugin_updater::Error::TargetNotFound("darwin-aarch64".into()))),
            Found::NoBuild
        ));
        assert!(matches!(
            classify(Err(tauri_plugin_updater::Error::TargetsNotFound(vec!["windows-x86_64".into()]))),
            Found::NoBuild
        ));
        assert!(matches!(
            classify(Err(tauri_plugin_updater::Error::ReleaseNotFound)),
            Found::Failed(message) if message.contains("release JSON")
        ));
    }

    #[test]
    fn a_download_tells_the_frontend_once_per_percent() {
        let mut throttle = Throttle::default();
        let total = Some(1_000_000);
        assert!(throttle.worth_telling(5_000, total)); // 0 %
        assert!(!throttle.worth_telling(9_000, total)); // still 0 %
        assert!(throttle.worth_telling(10_000, total)); // 1 %
        assert!(!throttle.worth_telling(10_500, total));
        assert!(throttle.worth_telling(1_000_000, total)); // 100 %

        // Without a size, once a megabyte.
        let mut sizeless = Throttle::default();
        assert!(!sizeless.worth_telling(512 * 1024, None));
        assert!(sizeless.worth_telling(1 << 20, None));
        assert!(!sizeless.worth_telling((1 << 20) + 10, None));
        assert!(sizeless.worth_telling(2 << 20, None));
    }

    #[test]
    fn long_release_notes_are_clipped_on_a_character_boundary() {
        assert_eq!(clip("corto", 10), "corto");
        let long = "ñ".repeat(700);
        let clipped = clip(&long, NOTES_LIMIT);
        assert_eq!(clipped.chars().count(), NOTES_LIMIT + 1);
        assert!(clipped.ends_with('…'));
        assert_eq!(available_body(true, "2.0.4", Some("  ")), "Tienes la 2.0.4.");
        assert_eq!(available_body(false, "2.0.4", Some("Fixes.")), "You have 2.0.4.\n\nFixes.");
    }

    #[test]
    fn the_install_event_matches_what_the_store_reads() {
        let downloading = serde_json::to_value(InstallEvent::Downloading { done: 5, total: Some(10) }).unwrap();
        assert_eq!(downloading, serde_json::json!({ "phase": "downloading", "done": 5, "total": 10 }));
        let failed = serde_json::to_value(InstallEvent::Failed { error: "offline".into() }).unwrap();
        assert_eq!(failed, serde_json::json!({ "phase": "failed", "error": "offline" }));
        assert_eq!(serde_json::to_value(InstallEvent::Installed).unwrap(), serde_json::json!({ "phase": "installed" }));
    }

    #[test]
    fn both_languages_name_every_button() {
        for spanish in [false, true] {
            let w = words(spanish);
            for label in [
                w.install, w.not_now, w.ok, w.close, w.releases, w.up_to_date_title, w.no_build_title,
                w.no_build_body, w.check_failed_title, w.install_failed_title,
            ] {
                assert!(!label.trim().is_empty());
            }
            // `native_dialog::ask` tells buttons apart by their labels.
            assert_ne!(w.install, w.not_now);
            assert_ne!(w.releases, w.close);
        }
    }
}
