// The test harness links the same libgit2 the app does, and link.exe says the same thing about its
// nine hundred exported `git_*` functions — see `main.rs` for the whole story. Under `test` only:
// the lint can be controlled solely at the root of a crate that gets linked, which this one is as
// a test harness and is not as the library, where rustc reports the attribute as unused.
#![cfg_attr(all(windows, test), allow(linker_messages))]

mod ado;
mod ai;
mod applog;
mod asr;
mod autostart;
mod background;
mod api;
mod appmenu;
mod ai_locks;
mod ai_memory;
mod ai_accounts;
mod ai_prompt_files;
mod ai_quota;
mod ai_runs;
mod ai_usage;
mod user_errors;
mod provider_state;
mod provider_caps;
mod backup_models;
mod cli_updates;
mod chain_review;
mod storage;
mod local_agent;
mod backup;
/// Opening the database at startup without a panic, and the watchdog for a frontend that never loads.
mod boot_guard;
mod caveman;
mod agentcli;
mod agentstatus;
mod chain_memory;
mod custom;
mod chat_mcp;
mod archify_suggest;
mod codemap;
mod context;
mod chat_title;
mod git_exclude;
mod ci;
mod boards;
mod claude;
mod codi;
mod cline;
mod commands;
mod containers;
mod dap;
mod datasource;
mod db;
mod deps;
mod desktop;
mod debugger;
mod dictation;
mod evals;
mod experiences;
mod meetings;
mod speech;
mod voice_fit;
mod flows;
mod external_editor;
mod fsops;
mod explorer_bridge;
mod clipboard_text;
mod codex;
mod gdrive;
mod gemini;
mod git;
mod glass;
mod grok;
mod http_clients;
mod bitbucket;
mod github;
mod gitlab;
mod jupyter;
mod knowledge;
mod learning;
mod json_schemas;
mod npm;
mod localai;
mod local_history;
mod hybrid;
mod mcp_registry;
mod model_registry;
mod lsp;
mod migrate;
mod native_dialog;
mod oauth;
mod onedrive;
mod opencode;
mod paths;
mod architecture;
mod power;
mod pr_link;
mod refrepos;
mod prettier;
mod proc;
mod provider_skills;
mod quit_guard;
mod remote;
mod sandbox;
mod scaffold;
/// Driving this install from a phone on the same network. Off unless the user turns it on.
mod remotectl;
mod remotes;
mod repo_files;
mod repo_identity;
mod requirements;
mod tool_setup;
mod usage_stats;
mod reset;
mod review;
mod review_memory;
mod reviewer;
mod search;
mod secret_clipboard;
mod secret_scan;
mod secrets;
mod services;
mod repo_env;
mod shell_env;
mod shell_integration;
mod shell_profiles;
/// `cf guard`'s rules for a destructive shell line, compiled from the sidecar's own file so the app's
/// agent asks about exactly what Claude Code's hook asks about.
#[path = "../cf/src/rules.rs"]
#[allow(dead_code)]
mod shell_rules;
/// The one cleanup every way out of the app runs — the `Exit` event and a Windows update alike.
mod shutdown;
mod slow;
/// AWS request signing, shared by the API client and the Remote workspace's S3 transport.
mod sigv4;
mod skill_builder;
mod skill_meta;
mod skills_registry;
mod supabase;
mod sysload;
mod keep_awake;
mod keyvault;
mod known_hosts;
mod terminal;
mod tool_gateway;
mod tsserver;
mod tray;
/// The update check that needs no webview: the tray's "Check for updates…" and the boot watchdog.
mod updates;
mod watcher;
mod window_state;
mod windows;
mod workspace_chat;
mod worklog;

use tauri::Manager;
use api::ApiRegistry;
use datasource::DbRegistry;
use terminal::TerminalRegistry;
use watcher::WatcherRegistry;

/// What the login item passes, so a launch at login can be told from one by hand.
const AUTOSTARTED_FLAG: &str = "--autostarted";

/// Whether this launch starts without a window: at login, with Flujos' "without opening the window"
/// on. The app then runs from the tray — triggers armed, schedules firing — and opening CodeFlow
/// (the dock, the tray, a second launch through `single_instance`) shows the window it kept hidden.
fn launched_in_background(app: &tauri::AppHandle) -> bool {
    if !std::env::args().any(|arg| arg == AUTOSTARTED_FLAG) {
        return false;
    }
    let db = app.state::<db::Db>();
    let Ok(conn) = db.0.lock() else { return false };
    db::queries::get_setting(&conn, "flows_background_at_login").ok().flatten().as_deref() == Some("1")
        || db::queries::get_setting(&conn, codi::keys::AT_LOGIN).ok().flatten().as_deref() == Some("on")
}

/// Whether this launch at login opens Codi — in its corner, listening — with the main window kept
/// in the background (the user, 2026-10-22: «que Codi se inicie por sí solo al encender el PC»).
fn codi_at_login(app: &tauri::AppHandle) -> bool {
    std::env::args().any(|arg| arg == AUTOSTARTED_FLAG)
        && app
            .state::<db::Db>()
            .0
            .lock()
            .ok()
            .and_then(|conn| db::queries::get_setting(&conn, codi::keys::AT_LOGIN).ok().flatten())
            .as_deref()
            == Some("on")
}

/// Hides the window for the "keep running in the background" close path.
///
/// macOS gives a fullscreened window its own Space, and hiding it there leaves that Space
/// standing but empty — the user lands on a black screen with nothing to click. So the window
/// has to leave fullscreen *first* and only hide once AppKit finishes the (animated, roughly
/// half-second) transition. tao clears its fullscreen flag inside `windowDidExitFullScreen`,
/// so polling `is_fullscreen()` is an exact "transition finished" signal rather than a guess
/// at the animation's duration.
///
/// Only reachable since macOS switched to native decorations: a borderless window has no
/// working green button, so there was no way to be in fullscreen when closing.
#[cfg(target_os = "macos")]
fn hide_to_background(window: &tauri::Window) {
    if !window.is_fullscreen().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let _ = window.set_fullscreen(false);
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        // Bounded (~2s) so a transition that never reports completion still ends with a
        // hidden window instead of one stuck on screen.
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if !window.is_fullscreen().unwrap_or(false) {
                break;
            }
        }
        let _ = window.hide();
    });
}

/// Hides the window for the "keep running in the background" close path, off macOS.
///
/// The Windows half is not a nicety. `window.hide()` hides the tao HWND and stops there; the
/// WebView2 controller parented to it is never told anything, so it goes on compositing, goes on
/// running its render loop and goes on holding its full working set for a window nobody can see —
/// on the path people take *specifically* to get the app out of the way. `Webview::hide()` reaches
/// `ICoreWebView2Controller::put_IsVisible(false)`, which is the documented way to say it.
///
/// **What it does not stop, which is the point:** JavaScript, timers, IPC and everything the Rust
/// side is doing keep running exactly as before. `IsVisible` governs rendering, not execution. A
/// review, an agent chain or a terminal running when the user closes the window keeps running —
/// that is the whole reason this app hides instead of exiting, and nothing here touches it. What
/// *is* suspended along with rendering is `requestAnimationFrame`, so a frontend animation that
/// schedules its own teardown on a rAF frame stalls until the window is shown again (see the note
/// in `NotificationBell.tsx`, which is written not to depend on one).
///
/// Whoever brings the window back has to undo both halves, and undo the webview's first — see
/// [`tray::show_main_window`], which is the single door every restore path goes through.
///
/// macOS is deliberately not part of this: `orderOut:` already parks WKWebView's display link, and
/// the macOS variant above has the fullscreen dance to do first.
/// The version whose first launch last refreshed the shell's icons — see
/// [`refresh_icon_cache_after_update`].
const LAST_RUN_VERSION_KEY: &str = "last_run_version";

/// On the first launch of a new version on Windows, asks Explorer to rebuild its icon cache.
///
/// Explorer caches the icon of every shortcut and pinned app by the path it points at, and an
/// update replaces the `.exe` in place: same path, so the Start menu, the desktop and the taskbar
/// went on showing the icon the old binary had — Tauri's logo, long after the app itself carried
/// its own (reported on Windows after the 2026-09-23 logo change). Neither installer tells the
/// shell: Tauri's NSIS template only calls `SHChangeNotify` for file associations, which this app
/// has none of, and the MSI has no hook at all. The NSIS side is also handled in
/// `installer/hooks.nsh`; this covers the MSI, and any install the hook predates.
///
/// `ie4uinit.exe -show` is Windows' own "refresh the icon cache" for the signed-in user. Run once per
/// version, detached, with its console hidden; a failure changes nothing but the icon. Compiled on
/// every platform (`cfg!`, not `#[cfg]`) so the non-Windows builds still type-check it.
fn refresh_icon_cache_after_update(app: &tauri::AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let version = app.package_info().version.to_string();
    let db = app.state::<db::Db>();
    let Ok(conn) = db.0.lock() else { return };
    let last = db::queries::get_setting(&conn, LAST_RUN_VERSION_KEY).ok().flatten();
    if last.as_deref() == Some(version.as_str()) {
        return;
    }
    let _ = db::queries::set_setting(&conn, LAST_RUN_VERSION_KEY, &version);
    drop(conn);
    std::thread::spawn(|| {
        if let Err(e) = proc::std_command("ie4uinit.exe").arg("-show").status() {
            applog::info(&format!("icons: could not refresh the shell's icon cache — {e}"));
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn hide_to_background(window: &tauri::Window) {
    #[cfg(windows)]
    if let Some(webview_window) = window.get_webview_window(window.label()) {
        // `as_ref()` is the `WebviewWindow -> Webview` view, and the annotation is what selects it:
        // `WebviewWindow::hide` is the *window's* hide — the one we already have on the line below —
        // and only the inner `Webview` carries the controller-level one.
        let webview: &tauri::Webview<_> = webview_window.as_ref();
        let _ = webview.hide();
        set_webview_memory_target(&webview_window, true);
    }
    let _ = window.hide();
}

/// Puts the main window in the background — the close button's usual outcome (see
/// `tray::close_action` for the other two).
///
/// The sequence the close handler used to run in line, moved here so the first-close notice's
/// "keep it in the tray" answer (`tray::hide_main_to_tray`) does exactly what the button does.
/// Whether the main window has been put away (in the tray) — for background loops that slow down
/// while nobody is looking. Cleared by `tray::show_main_window`.
pub(crate) static MAIN_AWAY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn put_main_away(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    MAIN_AWAY.store(true, std::sync::atomic::Ordering::Relaxed);
    // The `Window` half, which is what the hiding needs: `Webview::window()`, reached through the
    // same `as_ref()` view `tray::show_main_window` uses.
    let webview: &tauri::Webview<_> = main.as_ref();
    let window = webview.window();
    // Said out loud before hiding. The webview keeps running, which is the whole point of hiding
    // rather than exiting — but it also means anything that *dispatches* work on its own would keep
    // launching engines with no window to show them in and no button to stop them with. An agent
    // chain parks on this.
    let _ = tauri::Emitter::emit(app, "app:background", ());
    // Database sessions are not background work — they are a connection held open on somebody's
    // server for a workspace that is now off screen. The ones nobody is using go back; a query still
    // in flight holds its session and is left alone, and anything closed here reopens by itself on
    // the next call, so being wrong costs one connect. Without this, closing the window looks like
    // quitting and holds every session anyway, which is the worst of both.
    app.state::<DbRegistry>().close_idle();
    // Before the main window leaves the screen, not after: a satellite has no rail to reattach
    // itself to, so one left alone is an app the user cannot navigate. See `windows::close_all`.
    windows::close_all(app);
    hide_to_background(&window);
}

/// Minimising a window on Windows tells its WebView2 nothing: the page goes on reading as visible,
/// so every pause keyed to `document.visibilityState` (the flow clocks, the ports and container
/// polls, the auto-fetch, the status-bar meters) kept running in a minimised window. macOS's
/// WKWebView reports a minimised window as hidden by itself. Here the controller is told, the
/// same `put_IsVisible` the tray path uses, and told again when the window comes back.
///
/// Only a webview this hid is shown again — never one the tray path hid, whose return
/// `tray::show_main_window` owns, with an ordering of its own.
#[cfg(windows)]
fn follow_minimize(window: &tauri::Window) {
    use std::collections::HashSet;
    use std::sync::Mutex;
    static HIDDEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let Some(webview_window) = window.get_webview_window(window.label()) else { return };
    let webview: &tauri::Webview<_> = webview_window.as_ref();
    let minimized = window.is_minimized().unwrap_or(false);
    let Ok(mut hidden) = HIDDEN.lock() else { return };
    let hidden = hidden.get_or_insert_with(HashSet::new);
    if minimized {
        if hidden.insert(window.label().to_string()) {
            let _ = webview.hide();
        }
    } else if hidden.remove(window.label()) {
        let _ = webview.show();
    }
}

/// Tells WebView2 how hard to hold on to its caches. Windows only; the enum has no counterpart on
/// the other platforms and none of them need one.
///
/// `put_IsVisible(false)` above stops the compositing, which is the expensive *rendering* half.
/// What it does not touch is everything the renderer is holding: the V8 heap, the decoded-image
/// cache, the font and glyph caches, the GPU-side resource caches and the browser process's own —
/// all still sized for an app in the foreground, for a window that may now sit in the tray for
/// hours. `MemoryUsageTargetLevel` is WebView2's first-class answer to exactly that state, and its
/// documented meaning is "the app is inactive, release what you are only caching".
///
/// **It is not a suspend, and deliberately not.** `ICoreWebView2_3::TrySuspend` is the API that
/// stops execution; this one does not. JavaScript, timers, IPC and every running agent chain go on
/// exactly as they do today — which is the whole reason this app hides instead of exiting.
///
/// `with_webview` posts to the main-thread event loop, so the level change lands shortly *after*
/// the `hide()`/`show()` beside it rather than before. That is fine in both directions: LOW
/// arriving a few milliseconds late costs nothing, and NORMAL only re-permits caching, which
/// refills on demand. It is emphatically not the ordering constraint `tray::show_main_window`
/// documents — `webview.show()` before `window.show()`, or the app comes back blank — and must not
/// be confused with it.
///
/// Silently does nothing on a WebView2 Runtime older than 1.0.1722.45: the `ICoreWebView2_19`
/// query fails and behaviour is identical to before this existed.
#[cfg(windows)]
pub(crate) fn set_webview_memory_target(webview_window: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface as _;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = webview_window.with_webview(move |platform| unsafe {
        if let Ok(core) = platform.controller().CoreWebView2() {
            if let Ok(v19) = core.cast::<ICoreWebView2_19>() {
                let _ = v19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The executable's other job: `ssh`'s askpass helper on Windows (see `remotes::askpass`). `None`
/// when this run is the app.
pub fn askpass_helper() -> Option<i32> {
    remotes::askpass::helper_main()
}

pub fn run() {
    // First, before anything that can fail. Everything from here to the window appearing runs with
    // no way to report itself — no console on Windows, no window anywhere — and two of the steps
    // below now move the user's database between directories. See `applog`, which until v1.19 did
    // not exist: `logs/` was created on every launch and had no writer at all.
    // Read *before* `init`, which writes this session's own marker — asking afterwards would only
    // ever find the one we just wrote.
    let unclean = applog::last_session_was_unclean();
    applog::init();
    // Straight after the log exists and before anything that can fail: from here to the window
    // appearing there is nowhere else a panic could report itself.
    applog::install_panic_hook();
    if unclean {
        applog::warn(
            "previous session did not shut down cleanly (crash, force-quit or power loss) — \
             unsaved editor buffers from it are offered back in the editor",
        );
    }

    // Then the reset, if one was requested on the previous launch. Must happen before
    // `boot_guard::open` opens the SQLite connection in `setup` — see `paths::reset_marker_path`'s
    // doc comment for why the delete can't happen live.
    //
    // Ahead of `import_login_path` rather than behind it, which it used to be: that call keeps a
    // cache file under the cache root and rewrites it from a background thread, so a wipe running
    // afterwards would be racing it — the delete would land first and the late write would recreate
    // the directory holding a value the user just asked to be rid of. Wiping first leaves the
    // import to find no cache, which is exactly what a reset should look like to it.
    let wiped = reset::run_if_requested();

    // And then the layout migration, which has to be after the reset and not before: a user who
    // asked for everything to be deleted, and whose old data is still sitting in the pre-v1.19
    // directory, must not have it copied back in. Running the wipe first leaves nothing for this to
    // find, so the ordering carries the whole argument — there is no "was a reset just performed"
    // flag to thread through, and deliberately so.
    let layout = migrate::run_at_startup();
    let layout_status = migrate::status(&layout);
    if wiped {
        applog::info("layout: a reset ran on this launch, so there was nothing to migrate");
    }

    // Any `llama-server` this app left behind last time. Only ever finds one when the previous run
    // was killed outright — Force Quit, End Task, a crash — because every path that runs Rust
    // destructors kills the child and clears the note. See the comment block in `localai::engine`
    // for why this checks the executable path before it kills a pid.
    localai::engine::sweep_stale();
    // The hybrid task's executor is a second `llama-server` with a pidfile of its own, and the
    // same reasoning applies to it — with a model that can be twenty gigabytes.
    localai::executor::sweep_stale();
    localai::embedder::sweep_stale();
    // …and any other one of ours whose parent is gone, which a pidfile (one process a slot) misses.
    std::thread::spawn(localai::engine::sweep_orphans);
    // The fine-tuning pane's `mlx_lm server`, by the same reasoning (checked to be our venv's Python).
    learning::serving::sweep_stale();

    // And the prompt files a session that never ran its destructors left behind — every brief a
    // killed run wrote for its CLI, diffs included. Only a dead process's are touched, which is
    // what makes this safe before the single-instance check. See `ai_prompt_files`.
    ai_prompt_files::sweep_stale();

    // Before anything can spawn a thread, and it has to be: this writes a process-wide environment
    // variable, which is only sound while this is still the only thread. Everything after it — the
    // AI CLIs, the pty, `git`, `ssh` — resolves programs against the `PATH` it leaves behind, so a
    // widening that landed later would be a widening half the app had already read past.
    //
    // It no longer *blocks* on a login shell to do it: the answer is cached from the previous launch
    // and adopted in microseconds, with the re-probe moved to a background thread that only rewrites
    // the cache. Only a genuinely first launch waits, and then for at most 1.5s. See `shell_env`.
    shell_env::import_login_path();

    // rustls 0.23 panics from `ClientConfig::builder()` when it can't tell which crypto provider to
    // use, and several dependencies (reqwest, mongodb, tokio-postgres-rustls, tonic) each build one.
    // Naming the process default here makes that unambiguous once, instead of every call site
    // having to pass a provider explicitly. `Err` means something already installed one — which is
    // just as good an answer.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        // First, and it has to be first: this is what makes a second launch raise the window that
        // is already running instead of opening a rival one.
        //
        // Two instances on one SQLite file is not merely untidy — each would run its own
        // `recover_after_restart` and demote the other's live rows to `interrupted`, and the
        // per-repository lease that keeps two engines out of one working copy is a *per-process*
        // registry, so it would not see across them at all.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `codeflow --flow <name>` from a terminal, a git hook or a launcher: a flow to start,
            // not a window to show.
            if argv.iter().any(|arg| arg == "--flow") {
                crate::flows::triggers::watchers::handle_args(app, &argv);
                return;
            }
            // Windows and Linux hand a `codeflow://` link to a second launch as an argument; macOS
            // delivers it to the running app through the deep-link plugin (see `setup`).
            let links: Vec<&String> = argv.iter().filter(|arg| arg.starts_with("codeflow://")).collect();
            if !links.is_empty() {
                links.into_iter().for_each(|link| crate::flows::triggers::watchers::handle_url(app, link));
                return;
            }
            tray::show_main_window(app);
        }))
        // The `codeflow://` scheme: registered with the OS here, opened in `setup`.
        .plugin(tauri_plugin_deep_link::init())
        // A meeting's recording, streamed from disk to the player — see `meetings_cmd::serve_audio`.
        .register_asynchronous_uri_scheme_protocol("cf-meeting", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(commands::meetings_cmd::serve_audio(&app, &request)));
        })
        // After the single instance, never before it — see above. Neither of these is a reason to
        // let a rival process reach this far.
        //
        // The quick-ask hotkey. Its handler lives here rather than in `windows.rs` because the
        // plugin takes one for the whole process at build time; `register_quick_ask_shortcut` then
        // binds and rebinds the accelerator against it. Only one chord is ever registered, so the
        // handler does not need to ask which one fired.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // Codi's push-to-talk chord is the one that wants both edges: held is heard.
                    if codi::hotkey::handle(app, shortcut, event.state) {
                        return;
                    }
                    // Pressed only. Both edges are delivered, and acting on the release as well
                    // would open the ask box and toggle it shut again on a single tap.
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        // A chord a flow listens for starts that flow and nothing else; every other
                        // chord the process holds is the quick-ask one.
                        if flows::triggers::hotkey_pressed(app, shortcut) {
                            return;
                        }
                        windows::toggle_quick_ask(app);
                    }
                })
                .build(),
        )
        // Launch at login, registered so the preference has somewhere to land. Nothing calls it
        // yet: it is the companion to the hotkey rather than a feature of its own — a system-wide
        // chord that only works once you have remembered to start the app is a chord nobody builds
        // a habit around — and wiring the setting is a frontend change this backend does not own.
        // `MacosLauncher::LaunchAgent` because the alternative (a login item) is the one macOS
        // shows in a list the user cannot explain, under a name that is not the app's.
        // Launched at login, the app is told so (`--autostarted`), and stays in the tray without a
        // window when Flujos asked for that — see `launched_in_background`.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTARTED_FLAG]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        // Native OS notifications. The app deliberately keeps running in the tray with the window
        // hidden, so "your review finished" had nowhere to land except a bell nobody could see.
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The startup layout verdict, decided above and read by `app_paths`. Managed rather
        // than recomputed, because "did this launch migrate" is a fact about *this* launch and
        // asking again later would answer about a different one.
        .manage(layout_status.clone())
        // The database is not managed here any more: `setup` opens it, first thing. See the note
        // there for why.
        .manage(TerminalRegistry::default())
        // The Services supervisor. An `Arc` because its tasks outlive every command that starts
        // them: a dependency wait, a readiness gate and an autorestart backoff all hold it.
        .manage(std::sync::Arc::new(services::Supervisor::default()))
        .manage(ApiRegistry::default())
        .manage(DbRegistry::default())
        // The keyring's unlocked data key. Managed state rather than a value passed around, so
        // there is exactly one place it exists — see `keyvault::session`.
        .manage(keyvault::session::VaultSession::default())
        .manage(WatcherRegistry::default())
        // The cancel channels for model downloads and in-flight completions. Same shape
        // and same neighbourhood as `ApiRegistry` above; see `localai::LocalAiRegistry`.
        .manage(localai::LocalAiRegistry::default())
        // The dictation engine's one install at a time — see `commands::dictation_cmd`.
        .manage(commands::dictation_cmd::DictationRegistry::default())
        // «Reuniones»: the one recording, the queue that finishes meetings — see `commands::meetings_cmd`.
        .manage(commands::meetings_cmd::MeetingsState::default())
        .manage(commands::speech_cmd::SpeechInstalls::default())
        .manage(tray::QuittingFlag::default())
        // Whether a quit the user asked for is waiting on the unsaved-work question. See `quit_guard`.
        .manage(quit_guard::QuitGuard::default())
        .manage(window_state::WindowTracker::default())
        .manage(remotectl::RemoteCtl::default())
        // Which app or repository is open in a window of its own. Managed rather than derived
        // from the platform's window list because the label is a lossy derivation of the id it
        // holds — see `windows::label_for`.
        .manage(windows::SatelliteRegistry::default())
        // One open SQLite connection per DBML diagram whose scratch database has been built.
        // Held rather than reopened per call because the attach limit and the progress handler
        // are properties of a *connection* — reopening per statement would mean re-establishing
        // both, and the first time that was forgotten the limit would be silently gone.
        .manage(sandbox::SandboxRegistry::default())
        .setup(|app| {
            background::init(app.handle());
            // The database, before anything else here reaches for it — and here, not at `.manage()`
            // time where it used to be opened, for two reasons.
            //
            // It is the first point after the single-instance check: the plugin turns a second launch
            // away while the app is being built, and a `.manage()` argument is evaluated before that.
            // A second launch used to open the live database, run the migrations and "recover" the
            // first instance's running work as interrupted before it was told to leave.
            //
            // And `setup` is where a failure can be answered. `db::init().expect(…)` panicked before
            // any window existed on every launch whose database would not open or migrate — the same
            // panic on every launch after it. Now a failure, or a database a newer build migrated,
            // becomes a native dialog, and the launch runs on a scratch database meanwhile, with no
            // window, tray or background work: `take_over` returns early for exactly that. When the
            // layout migration could not vouch for the state root, no connection is put on it at all
            // (`db::init_scratch`) and `DataDirsNotice` blocks the window, as before. See `boot_guard`.
            boot_guard::open(app.handle());
            // Before `take_over`, so no launch is without it: the cleanup for the exits that skip
            // `RunEvent::Exit` — a Windows update installed from the frontend above all. See `shutdown`.
            {
                let handle = app.handle().clone();
                shutdown::install_exit_hook(app.handle(), move || {
                    shutdown::run_outside_runtime(|| shutdown::shutdown_cleanup(&handle));
                });
            }
            // A `codeflow://flow/<name>` link opened by the OS while the app is running (macOS), or the one
            // that launched it. Only ever starts a flow whose trigger asks first by default.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        crate::flows::triggers::watchers::handle_url(&handle, url.as_str());
                    }
                });
            }
            if boot_guard::take_over(app.handle()) {
                return Ok(());
            }
            // The loopback endpoint `cf` calls: one socket and one task, bound to 127.0.0.1 on a
            // port the OS picks. See `agentcli`.
            agentcli::start(app.handle());
            // The active flows' triggers: schedules, webhooks, watchers, pollers, chords. After the
            // takeover check, so a launch that is only answering a recovery question arms nothing.
            flows::triggers::start(app.handle());
            flows::waits::arm(app.handle());
            // Launch at login: the time of a launch the login item made — Settings shows it, the
            // proof the option works — and the registration pointed back at this copy of the app.
            autostart::on_launch(app.handle(), std::env::args().any(|arg| arg == AUTOSTARTED_FLAG));
            // «Evitar que el equipo se suspenda», from the stored choice. See `keep_awake`.
            keep_awake::start(app.handle());
            // «Reuniones»: meetings a crash or a quit cut short, the audio retention, the call detector.
            commands::meetings_cmd::start(app.handle());
            // The main window, built here from its own entry in `tauri.conf.json` (which says
            // `"create": false`) rather than by Tauri before `setup` runs — the one difference being
            // `enable_clipboard_access`, which that config has no field for. Without it WebView2 (and
            // WebKitGTK) refuse `navigator.clipboard.readText()`, so on Windows nothing that reads the
            // clipboard worked: pasting into a terminal — the CLI sign-in dialog's pasted code among
            // them — the vault, a PR link. macOS ignores the flag; WKWebView always allowed it.
            //
            // Safe to allow because no third-party script runs in these webviews: the draw.io editor
            // is vendored and same-origin, and API responses render in `sandbox=""` frames.
            //
            // Only when no `main` exists yet. A `tauri dev` started before `"create": false` was in
            // the config keeps building with the config it read at its start, so Tauri had already
            // made the window — and a second `build()` of the same label failed `setup`, which is a
            // panic at launch. That window simply goes without clipboard access until the next
            // `tauri dev`; a build never sees two configs.
            //
            // The see-through setting rides along for the same reason — it needs the builder: a
            // script that stamps the look before the first paint, and the native backdrop put on
            // while the window is still hidden. See `glass`. Which is also why
            // `tauri.macos.conf.json` says `"create": false` now: its `windows` array replaces this
            // file's wholesale, so without it macOS had Tauri build the window and never came here.
            if app.get_webview_window("main").is_none() {
                if let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() {
                    let look = glass::stored(app.handle());
                    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                        .enable_clipboard_access();
                    if let Some(script) = glass::init_script(&look) {
                        builder = builder.initialization_script(script);
                    }
                    let window = builder.build()?;
                    glass::on_create(&window, &look);
                }
            }
            // First, and before anything that can fail out of this closure: the window is created
            // hidden (`"visible": false` in `tauri.conf.json`) so that being resized and maximized
            // back to where the last session left it does not happen in front of the user, and
            // this is what ends that — a `?` above it would leave the app running with no window.
            window_state::restore_with(app.handle(), !launched_in_background(app.handle()));
            if launched_in_background(app.handle()) {
                // Hidden from the start is away: what Codi opens brings it back (`codi::ui::act`).
                MAIN_AWAY.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            if codi_at_login(app.handle()) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = windows::open_codi(handle.clone()).await {
                        applog::warn(&format!("codi: could not open at login: {error}"));
                        return;
                    }
                    let worker = handle.clone();
                    match tokio::task::spawn_blocking(move || codi::start(&worker)).await {
                        Ok(Err(error)) => applog::warn(&format!("codi: the microphone did not open at login: {error}")),
                        Err(error) => applog::warn(&format!("codi: the microphone did not open at login: {error}")),
                        Ok(Ok(_)) => {}
                    }
                });
            }
            // From here the frontend has ~30 s to say it rendered; a release whose window never comes
            // up is then offered an update from Rust, since its own update check never ran.
            boot_guard::arm_watchdog(app.handle());
            refresh_icon_cache_after_update(app.handle());
            // A row an earlier build left behind: it held the satellites open at the last quit, and
            // reopening them at launch turned out to be the wrong idea twice over. See
            // `windows::SatelliteRegistry::parked`.
            windows::forget_persisted_desk(app.handle());
            // A screenshot Codi read another app from is deleted as it is read; one an interrupted
            // read left behind goes now. See `desktop::read`.
            desktop::read::sweep_at_launch();
            // The quick-ask chord, bound for this session from whatever the user last chose.
            //
            // Logged rather than returned, and only here: a `?` on this would mean an accelerator
            // some other application already owns — Spotlight, Raycast, a window manager — stops
            // CodeFlow from starting at all, which is a catastrophic answer to a hotkey conflict.
            // The path where failure *is* returned is `register_quick_ask_shortcut`, called from
            // the settings field the accelerator was typed into, which is the one place there is
            // somebody to tell. The tray's "New quick ask" keeps the feature reachable meanwhile.
            {
                let stored = app
                    .state::<db::Db>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|conn| {
                        db::queries::get_setting(&conn, windows::QUICK_ASK_ACCELERATOR_KEY)
                            .ok()
                            .flatten()
                    });
                // `None` is the user having switched the hotkey off: bind nothing. An empty or
                // missing row is "never chosen" and gets this platform's default.
                if let Some(accelerator) = windows::resolve_quick_ask_accelerator(stored.as_deref()) {
                    if let Err(e) =
                        windows::register_quick_ask_shortcut(app.handle().clone(), accelerator)
                    {
                        applog::info(&format!("window: quick-ask hotkey unavailable — {e}"));
                    }
                }
            }
            // Startup sweeps, on a thread of their own so the window does not wait for them: every
            // DBML scratch database whose diagram is gone, notes trashed more than thirty days ago
            // (with their history), and note or diagram history whose document is already gone.
            // Failing is not worth a startup error — whatever is left is reclaimed next launch.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let known: std::collections::HashSet<String> = handle
                        .state::<db::Db>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|conn| {
                            let mut stmt = conn.prepare("SELECT id FROM diagrams").ok()?;
                            let rows = stmt.query_map([], |row| row.get::<_, String>(0)).ok()?;
                            Some(rows.flatten().collect())
                        })
                        .unwrap_or_default();
                    // Only when the table could be read. An empty set from a failed read would mean
                    // "no diagrams exist", and the sweep would delete every sandbox the user has.
                    if !known.is_empty() {
                        sandbox::sweep(&known);
                    }
                    // See `note_queries::purge_expired_trash` and `diagrams_cmd::sweep_orphan_versions`.
                    if let Ok(conn) = handle.state::<db::Db>().0.lock() {
                        if let Err(e) = db::note_queries::purge_expired_trash(&conn, chrono::Utc::now()) {
                            applog::info(&format!("notes: trash sweep failed — {e}"));
                        }
                        let _ = commands::diagrams_cmd::sweep_orphan_versions(&conn);
                    }
                    // Caches of repositories that are no longer projects, and abandoned model
                    // downloads. Read under the lock, swept outside it.
                    let projects: Vec<(String, String)> = handle
                        .state::<db::Db>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|conn| {
                            let mut stmt = conn.prepare("SELECT id, local_path FROM projects").ok()?;
                            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).ok()?;
                            Some(rows.flatten().collect())
                        })
                        .unwrap_or_default();
                    // Same guard as the sandboxes: an unreadable table is not "no projects".
                    if !projects.is_empty() {
                        // The reference repositories' clones keep their maps too: they are mapped
                        // like projects, and nothing else would keep their caches from ageing out.
                        let references: Vec<String> = handle
                            .state::<db::Db>()
                            .0
                            .lock()
                            .ok()
                            .and_then(|conn| refrepos::list(&conn).ok())
                            .unwrap_or_default()
                            .iter()
                            .map(|r| r.path().to_string_lossy().to_string())
                            .collect();
                        let mut roots: Vec<String> = projects.iter().map(|(_, path)| path.clone()).collect();
                        roots.extend(references);
                        codemap::sweep_cache(&roots);
                        review::checkout::sweep(&projects.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>());
                    }
                    localai::models::sweep_partials();
                });
            }
            // Retention and vacuum for the database, a minute after launch and daily after.
            db::housekeeping::start(&app.handle());
            // The reference repositories' schedule: each one updated on its own interval.
            refrepos::spawn(app.handle().clone());
            tray::setup(&app.handle())?;
            // The usage meter's way to the database. Set here because `setup` is the only place
            // with an `AppHandle`, and the recording point is deep inside `ai::run`, where threading
            // one down would mean an extra argument on every operation in `ai.rs`.
            ai_usage::attach(app.handle().clone());
            // After `ai_usage::attach`: both read the database through `ai_usage::with_conn`, which
            // answers nothing before it.
            // Fine-tuning: a run a quit cut short becomes resumable, an idle adapter server is
            // stopped, and the assisted/supervised modes find their window. See `learning`.
            commands::learning_cmd::start(app.handle());
            // The knowledge index's leftovers: projects, workspaces and folders deleted before the
            // index learned to follow them, and vectors of an embedding model since removed.
            knowledge::prune_in_background();
            // The same trick for the local completion engine: it announces every move between
            // off / warming / ready / failed, and the editor's status bar draws it. See
            // `localai::engine::attach`.
            localai::engine::attach(app.handle().clone());
            appmenu::setup(&app.handle())?;
            // The branches that come locked without anyone having clicked a padlock. Seeded here,
            // before the first window can ask for anything, because the guards that read this list
            // live in the git layer — which is handed a repository path and no database at all.
            // A read that fails leaves the shipped defaults in place, which is the safe direction:
            // the failure mode is a padlock too many, not a lock silently missing.
            if let Ok(conn) = app.state::<db::Db>().0.lock() {
                if let Ok(stored) = db::queries::get_setting(&conn, git::lock_rules::SETTING_KEY) {
                    git::lock_rules::set_rules(git::lock_rules::resolve_stored(stored.as_deref()));
                }
            }
            // The IRIS driver reaches its bundled Java runtime through this. Recorded here because
            // `setup` is the only place with an `AppHandle`, and the datasource layer deliberately
            // has no Tauri types in it.
            if let Ok(dir) = app.path().resource_dir() {
                paths::set_resource_dir(dir);
            }
            // The scheduled backup. Ticks on the clock rather than on every edit, and an unchanged
            // configuration costs it a hash — see `backup::auto`.
            backup::auto::spawn(app.handle().clone());
            // Locks the keyring when it has been left idle. Not what *enforces* auto-lock — every
            // read checks the idle window itself — but what makes the lock visible on screen
            // rather than at the user's next click. See `keyvault::session::spawn_autolock`.
            keyvault::session::spawn_autolock(app.handle().clone());
            // The agent console's terminal bench writes down what its shells printed, on a timer.
            // Here for the same reason as everything above it — `setup` is where the `AppHandle`
            // is — and cheap when the bench is empty, which is most installs most of the time.
            commands::terminal_cmd::spawn_transcript_flush(app.handle().clone());
            // Watches running services for the ports they open and Compose for its containers.
            // Idle while nothing runs — one look a second at an empty map.
            services::supervisor::spawn_monitor(app.handle().clone());
            // The remote-control server, in two halves that must happen in this order.
            //
            // `attach` registers the Rust-side listeners that republish app events onto the
            // WebSocket fan-out. It is unconditional and does not depend on the server being on:
            // the listeners cost nothing with no phone connected, and registering them once here
            // means toggling the server later cannot leak a subscription or miss one.
            //
            // `autostart` is the half that binds a port, and only when the stored setting says so.
            // It cannot fail out of `setup` — a port taken by something else must not stop the app
            // from launching — so it reports through the settings screen instead. See its comment.
            remotectl::bridge::attach(app.handle());
            remotectl::autostart(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Where the window is and how big, kept current as it happens rather than asked for
            // at the end: by the time the app is quitting, a window may already be gone, and on
            // the close path below it is about to be hidden — which is not a size to reopen at.
            // Cheap enough to sit under a drag; see `window_state::record`.
            if matches!(
                event,
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
            ) {
                window_state::record(window);
            }
            // Codi's window opens where it was left (`windows::codi_spot`).
            if matches!(event, tauri::WindowEvent::Moved(_)) && window.label() == windows::codi_label() {
                windows::remember_codi_spot(window);
            }
            #[cfg(windows)]
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                follow_minimize(window);
            }

            // The custom title bar's close button and the OS's own close paths (Alt+F4, the
            // red traffic light, right-click "Close window" on the taskbar) all raise this
            // same event — hiding instead of exiting is what keeps background jobs (Claude
            // reviews, terminals) alive while the window is "closed", Docker Desktop–style.
            // A satellite that has actually gone comes out of the registry, which is what
            // un-marks its icon in the main window's rail. `Destroyed` and not `CloseRequested`:
            // see `windows::forget`.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                windows::forget(window.app_handle(), window.label());
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                // A satellite closing is just a window closing: nothing it held was only there.
                // Everything below is about the main window, and running it for a satellite would
                // hide the *main* window on the first satellite the user closes.
                if windows::is_satellite(window.label()) {
                    return;
                }
                // Written down here as well as on the way out, because these two ends of the app
                // are further apart than they look: closing the window leaves it running in the
                // background for hours, and whatever ends that session — a real quit, a reboot, a
                // process killed from the task manager — may never reach the exit handler. The
                // size the user last had is banked at the moment they last had it.
                window_state::save(app);
                if !app.state::<tray::QuittingFlag>().is_quitting() {
                    api.prevent_close();
                    // Into the background (the default), a real quit (the user's setting — asked
                    // about unsaved work first, see `quit_guard`), or, the first time, a word from
                    // the main window about where the app is going. See `tray::close_action`.
                    match tray::close_action(app) {
                        tray::CloseAction::Hide => put_main_away(app),
                        // Codi open keeps the app: it drives the main window, which goes on running
                        // hidden while the user talks to it. Quitting is still the tray's and ⌘Q's.
                        tray::CloseAction::Quit if app.get_webview_window(&windows::codi_label()).is_some() => {
                            put_main_away(app)
                        }
                        tray::CloseAction::Quit => quit_guard::request_quit(app),
                        tray::CloseAction::Notice => {
                            let _ = tauri::Emitter::emit_to(app, "main", "app:close-notice", ());
                        }
                    }
                }
            }
        })
        .invoke_handler(invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // macOS: clicking the Dock icon while the window is hidden (but the app is still
            // running in the background) should reopen it, same as any normal Mac app. This
            // variant only exists in the macOS build of `RunEvent` at all.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show_main_window(_app_handle);
            }

            // Whether the app ends at all: a quit the user asked for waits here while the main
            // window asks about unsaved work. Its own block, apart from the `Exit` cleanup below —
            // this one decides, that one tidies up once it is decided. See `quit_guard`.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &_event {
                quit_guard::on_exit_requested(_app_handle, *code, api);
            }

            // The last moment anything of ours runs. Every quit path — the tray's Quit, ⌘Q, the
            // window's close button once the quitting flag is set, `reset_app_data` — ends in
            // `AppHandle::exit`, which requests this event and then calls `std::process::exit`. No
            // destructor runs after that: not the managed `DbRegistry`, not the `static` map holding
            // the tunnels' child processes. So a database session left open would be discovered by
            // the server only as a socket that stopped answering, and the `ssh -N -L` behind a
            // tunnelled connection would not be discovered at all — it survives, holding a forwarded
            // port and an authenticated session on the bastion, reparented to init.
            //
            // Blocking is correct here: the point is to finish before the process does.
            //
            // The steps themselves are `shutdown::shutdown_cleanup`, one function run once, because
            // this event is not the only way out: a Windows update install ends the process from
            // inside the updater, which never raises it. See `shutdown`.
            if let tauri::RunEvent::Exit = _event {
                shutdown::shutdown_cleanup(_app_handle);
            }
        });
}

/// The IPC handler, in shards.
///
/// One `tauri::generate_handler!` over all ~1,200 commands expands to a single closure holding a
/// 1,200-arm `match`, every arm carrying its command's argument decoding, async dispatch and reply
/// encoding — and LLVM inlines those arms into that one function. A function that size optimises on
/// one thread and super-linearly, inside the compile of this crate, on every release. Here each
/// shard is its own `generate_handler!` in its own `#[inline(never)]` function, so the shards land
/// in separate codegen units and optimise in parallel, and a table keyed by command name (a
/// command's name is its function's name: none of them uses `rename`) picks the shard.
///
/// Measured on CI (2026-10-16, release profile, dependencies from the Release workflow's cache):
/// compiling this crate took 24m31s on `macos-latest` with the one handler and 7m30s sharded. On
/// `windows-latest` it made no difference (19m16s against 19m44s) — MSVC's bottleneck is elsewhere.
///
/// Adding a command: append it to any shard. Shard size is not load-bearing.
macro_rules! sharded_invoke_handler {
    ($( $shard:ident => [ $( $($seg:ident)::+ ),* $(,)? ] )*) => {
        $(
            #[inline(never)]
            fn $shard(invoke: tauri::ipc::Invoke) -> bool {
                dispatch(tauri::generate_handler![ $( $($seg)::+ ),* ], invoke)
            }
        )*

        /// Every command's name, each paired with the shard that dispatches it.
        fn invoke_routes() -> &'static std::collections::HashMap<&'static str, fn(tauri::ipc::Invoke) -> bool> {
            static ROUTES: std::sync::OnceLock<std::collections::HashMap<&'static str, fn(tauri::ipc::Invoke) -> bool>> =
                std::sync::OnceLock::new();
            ROUTES.get_or_init(|| {
                let mut routes = std::collections::HashMap::new();
                $( $(
                    let previous = routes.insert(
                        command_name(stringify!($($seg)::+)),
                        $shard as fn(tauri::ipc::Invoke) -> bool,
                    );
                    debug_assert!(previous.is_none(), "two commands named {}", stringify!($($seg)::+));
                )* )*
                routes
            })
        }

        /// How many commands the shards list — the route table must hold exactly this many.
        #[cfg(test)]
        const INVOKE_COMMAND_COUNT: usize = [$( $( stringify!($($seg)::+), )* )*].len();
    };
}

/// Gives the closure `generate_handler!` returns the parameter type that calling it in place would
/// leave uninferred.
fn dispatch(handler: impl Fn(tauri::ipc::Invoke) -> bool, invoke: tauri::ipc::Invoke) -> bool {
    handler(invoke)
}

/// `commands :: git :: git_status` (however `stringify!` spaces it) → `git_status`.
fn command_name(path: &'static str) -> &'static str {
    path.rsplit("::").next().unwrap_or(path).trim()
}

fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    let routes = invoke_routes();
    move |invoke| match routes.get(invoke.message.command()) {
        Some(shard) => {
            // A sync command runs inside this call, on the thread that dispatched it (the main
            // thread, so the window waits); an async one only gets spawned here. So this measures
            // exactly the hitches — see `slow`.
            let command = invoke.message.command().to_string();
            let started = std::time::Instant::now();
            let handled = shard(invoke);
            let took = started.elapsed();
            if took > slow::IPC_THRESHOLD {
                slow::report(format!("ipc {command}"), || {
                    format!("ipc: {command} kept its thread for {} ms", slow::ms(took))
                });
            }
            handled
        }
        None => false,
    }
}

sharded_invoke_handler! {
    shard_00 => [
        tsserver::ts_start,
        tsserver::ts_request,
        tsserver::ts_notify,
        commands::editor_cmd::format_with_prettier,
        commands::editor_cmd::create_editor_checkpoint,
        commands::editor_cmd::json_schema_catalog,
        commands::editor_cmd::json_schema_fetch,
        npm::npm_latest_versions,
        npm::npm_search,
        npm::npm_package_sizes,
        scaffold::scaffold_detect_tools,
        scaffold::scaffold_versions,
        scaffold::scaffold_spring_metadata,
        scaffold::scaffold_spring_generate,
        scaffold::scaffold_quarkus_generate,
        scaffold::scaffold_check_dest,
        scaffold::scaffold_write_files,
        scaffold::scaffold_run,
        scaffold::scaffold_claim,
        scaffold::scaffold_discard,
        commands::app_cmd::quit_app,
        quit_guard::quit_guard_arm,
        quit_guard::quit_guard_ack,
        quit_guard::quit_guard_cancel,
        quit_guard::quit_app_confirmed,
        boot_guard::boot_ready,
        commands::app_cmd::check_requirements,
        commands::app_cmd::tool_setup_status,
        commands::app_cmd::tool_setup_install,
        commands::app_cmd::usage_record,
        commands::app_cmd::usage_set_context,
        commands::app_cmd::usage_report,
        commands::app_cmd::usage_rows,
        commands::app_cmd::usage_clear,
        commands::app_cmd::reset_app_data,
        commands::app_cmd::app_paths,
        commands::app_cmd::delete_legacy_data,
        commands::app_cmd::retry_layout_migration,
        commands::app_cmd::acknowledge_shared_root,
        commands::backup_cmd::backup_state,
        commands::backup_cmd::backup_save_settings,
        commands::backup_cmd::backup_reset_auto,
        commands::backup_cmd::backup_save_drive,
        commands::backup_cmd::backup_save_onedrive,
        commands::backup_cmd::onedrive_status,
        commands::backup_cmd::onedrive_connect,
    ]
    shard_01 => [
        commands::backup_cmd::onedrive_disconnect,
        commands::backup_cmd::backup_set_passphrase,
        commands::backup_cmd::backup_clear_passphrase,
        commands::backup_cmd::backup_passphrase_matches,
        commands::backup_cmd::backup_export_to_file,
        commands::backup_cmd::backup_run_now,
        commands::backup_cmd::backup_pick_and_inspect,
        commands::backup_cmd::backup_list_at_destination,
        commands::backup_cmd::backup_restore_file,
        commands::backup_cmd::backup_restore_drive,
        commands::backup_cmd::backup_restore_onedrive,
        commands::backup_cmd::backup_pick_folder,
        commands::backup_cmd::backup_reveal_folder,
        agentcli::agentcli_answer,
        agentcli::agentcli_endpoint,
        agentcli::agentcli_focus,
        windows::open_satellite,
        windows::focus_satellite,
        windows::list_satellites,
        windows::restore_satellites,
        windows::quick_ask_open,
        windows::attention_open,
        windows::quick_ask_close,
        windows::show_main_window,
        windows::register_quick_ask_shortcut,
        windows::unregister_quick_ask_shortcut,
        tray::system_locale,
        applog::log_frontend_error,
        applog::app_diagnostics,
        applog::diagnostics_report,
        applog::third_party_notices,
        tray::hide_main_to_tray,
        tray::autostart_enabled,
        tray::set_autostart,
        autostart::autostart_status,
        autostart::autostart_open_system_settings,
        keep_awake::keep_awake_status,
        keep_awake::set_keep_awake,
        windows::get_quick_ask_shortcut,
        windows::set_window_unsaved,
    ]
    shard_02 => [
        glass::set_window_glass,
        commands::chat_cmd::chat_create_conversation,
        commands::chat_cmd::chat_send,
        commands::chat_cmd::chat_turn_checkpoints,
        commands::chat_cmd::chat_list_conversations,
                    commands::chat_cmd::chat_get_conversation,
        commands::chat_cmd::chat_rename_conversation,
        commands::chat_cmd::chat_set_engine,
        commands::chat_cmd::chat_set_unread,
        commands::chat_cmd::chat_inflight_turns,
        commands::chat_cmd::chat_set_effort,
        commands::chat_cmd::chat_create_workspace_conversation,
        commands::chat_cmd::chat_list_workspace_conversations,
        commands::chat_cmd::workspace_chat_snapshot,
        commands::chat_cmd::chat_effort_support,
        commands::chat_cmd::chat_model_effort_support,
        commands::chat_cmd::chat_model_reads_images,
        commands::chat_cmd::chat_list_groups,
        commands::chat_cmd::chat_create_group,
        commands::chat_cmd::chat_rename_group,
        commands::chat_cmd::chat_delete_group,
        commands::chat_cmd::chat_set_group_pinned,
        commands::chat_cmd::chat_set_group_archived,
        commands::chat_cmd::chat_set_group_collapsed,
        commands::chat_cmd::chat_reorder_groups,
        commands::chat_cmd::chat_set_conversation_group,
        commands::chat_cmd::chat_set_group_instructions,
        commands::chat_attach::chat_group_attach_file,
        commands::chat_attach::chat_group_list_context,
        commands::chat_attach::chat_group_remove_context,
        commands::chat_attach::chat_attach_file,
        commands::chat_attach::chat_attach_bytes,
        commands::chat_attach::chat_list_attachments,
        commands::chat_attach::chat_list_staged_attachments,
        commands::chat_attach::chat_remove_attachment,
        commands::chat_attach::chat_attach_pending_file,
        commands::chat_attach::chat_attach_pending_bytes,
        commands::chat_attach::chat_remove_pending_attachment,
        commands::chat_attach::chat_adopt_pending_attachments,
        commands::chat_attach::repo_chat_attach_file,
    ]
    shard_03 => [
        commands::chat_attach::repo_chat_attach_bytes,
        commands::chat_attach::repo_chat_remove_attachment,
        commands::chat_attach::chat_sweep_attachments,
        commands::chat_attach::chat_list_outputs,
        commands::chat_attach::chat_save_output,
        commands::chat_attach::chat_read_output,
        commands::chat_attach::chat_attachment_preview,
        commands::chat_cmd::chat_delete_conversation,
        commands::chat_cmd::chat_set_pinned,
        commands::chat_cmd::chat_set_archived,
        commands::chat_cmd::chat_search_conversations,
        commands::chat_cmd::chat_provider_commands,
        commands::chat_cmd::chat_provider_skills,
        commands::chat_cmd::chat_mcp_servers,
        commands::chat_cmd::chat_mcp_set,
        commands::mcp_cmd::mcp_list,
        commands::mcp_cmd::mcp_save,
        commands::mcp_cmd::mcp_delete,
        commands::mcp_cmd::mcp_approve,
        commands::mcp_cmd::mcp_import_candidates,
        commands::mcp_cmd::mcp_import,
        commands::chat_cmd::chat_branch_conversation,
        commands::chat_cmd::chat_compact,
        commands::chat_cmd::chat_continue_in_new_thread,
        commands::chat_cmd::chat_context_window,
        commands::chat_cmd::chat_set_caveman,
        commands::chat_cmd::chat_caveman_levels,
        commands::chat_cmd::chat_caveman_resolve,
        commands::chat_cmd::chat_uncompact,
        commands::sandbox_cmd::sandbox_open,
        commands::sandbox_cmd::sandbox_status,
        commands::sandbox_cmd::sandbox_counts,
        commands::sandbox_cmd::sandbox_page,
        commands::sandbox_cmd::sandbox_execute,
        commands::sandbox_cmd::sandbox_migrate,
        commands::sandbox_cmd::sandbox_export_sql,
        commands::sandbox_cmd::sandbox_export_file,
        commands::sandbox_cmd::sandbox_cancel,
        commands::sandbox_cmd::sandbox_wipe,
        commands::sandbox_cmd::sandbox_close,
        commands::sandbox_cmd::sandbox_sweep,
    ]
    shard_04 => [
        commands::containers_cmd::containers_detect,
        commands::containers_cmd::containers_list,
        commands::containers_cmd::containers_act,
        commands::containers_cmd::containers_text,
        commands::containers_cmd::containers_analyze_logs,
        commands::containers_cmd::containers_container_detail,
        commands::containers_cmd::containers_logs_tail,
        commands::containers_cmd::containers_namespaces,
        commands::containers_cmd::containers_reach,
        commands::containers_cmd::containers_apply,
        commands::containers_cmd::containers_open_session,
        commands::containers_cmd::containers_start_runtime,
        commands::containers_cmd::containers_forward_open,
        commands::containers_cmd::containers_forward_close,
        commands::containers_cmd::containers_forwards,
        commands::containers_cmd::containers_hub_search,
        commands::containers_cmd::containers_hub_tags,
        commands::containers_cmd::containers_run,
        commands::containers_cmd::containers_stats,
        commands::containers_cmd::containers_files,
        commands::containers_cmd::containers_file_delete,
        commands::containers_cmd::containers_file_upload,
        commands::containers_cmd::containers_file_download,
        commands::containers_cmd::containers_update_limits,
        commands::containers_cmd::containers_create_volume,
        commands::containers_cmd::containers_backup_volume,
        commands::containers_cmd::containers_restore_volume,
        commands::containers_cmd::containers_create_network,
        commands::containers_cmd::containers_image_history,
        commands::containers_cmd::containers_disk_usage,
        commands::containers_cmd::containers_docker_context_add,
        commands::containers_kube_cmd::containers_kube_tools,
        commands::containers_kube_cmd::containers_kube_accounts,
        commands::containers_kube_cmd::containers_kube_clouds,
        commands::containers_kube_cmd::containers_kube_add,
        commands::containers_kube_cmd::containers_kube_origins,
        commands::containers_kube_cmd::containers_kube_remove,
        commands::containers_kube_cmd::containers_kube_test,
        commands::containers_kube_cmd::containers_kube_use_azure_cli,
        commands::containers_kube_cmd::containers_kube_aks_status,
        commands::containers_kube_cmd::containers_kube_topology,
        commands::containers_azure_cmd::azure_found,
        commands::containers_azure_cmd::azure_subscriptions,
        commands::containers_azure_cmd::azure_groups,
        commands::containers_azure_cmd::azure_resources,
        commands::containers_azure_cmd::azure_show,
        commands::containers_azure_cmd::azure_health,
        commands::containers_azure_cmd::azure_activity,
        commands::containers_azure_cmd::azure_logs,
        commands::containers_azure_cmd::azure_workspaces,
        commands::containers_azure_cmd::azure_query,
        commands::containers_azure_cmd::azure_topology,
        commands::services_cmd::list_services,
        commands::services_cmd::list_service_groups,
        commands::services_cmd::create_service,
    ]
    shard_05 => [
        commands::services_cmd::update_service,
        commands::services_cmd::delete_service,
        commands::services_cmd::create_service_group,
        commands::services_cmd::rename_service_group,
        commands::services_cmd::delete_service_group,
        commands::services_cmd::services_start,
        commands::services_cmd::services_stop,
        commands::services_cmd::services_restart,
        commands::services_cmd::services_runtime,
        commands::services_cmd::service_log,
        commands::services_cmd::service_clear_log,
        commands::services_cmd::service_export_log,
        commands::services_cmd::service_detect,
        commands::services_cmd::service_env_files,
        commands::services_cmd::services_detect_workspace,
        commands::services_cmd::services_listening_ports,
        commands::services_cmd::services_free_port,
        commands::services_cmd::service_path_exists,
        commands::repos::pick_folder,
        commands::repos::scan_folder,
        commands::repos::project_path_health,
        commands::repos::find_duplicate_projects,
        commands::repos::default_clone_dir,
        commands::repos::create_workspace,
        commands::repos::list_workspaces,
        commands::repos::reorder_workspaces,
        commands::repos::delete_workspace,
        commands::repos::update_workspace_color,
        commands::repos::rename_workspace,
        commands::repos::update_project_color,
        commands::repos::update_workspace_icon,
        commands::repos::rename_project,
        commands::repos::repo_summaries,
        commands::repos::create_project,
        commands::repos::list_projects,
        commands::repos::get_workspace_identity,
        commands::repos::list_workspace_identities,
        commands::repos::set_workspace_identity,
        commands::repos::get_effective_identity,
        commands::repos::reorder_projects,
        commands::repos::get_project,
        commands::repos::delete_project,
        commands::repos::move_project_to_workspace,
    ]
    shard_06 => [
        commands::git_ops::init_repository,
        commands::git_ops::get_status,
        commands::git_ops::list_commits,
        commands::git_ops::list_unpushed_commits,
        commands::git_ops::list_branches,
        commands::git_ops::create_branch,
        commands::git_ops::delete_branch,
        commands::git_ops::branch_unmerged_count,
        commands::git_ops::set_branch_locked,
        commands::git_ops::checkout_local_branch,
        commands::git_ops::checkout_detached,
        commands::git_ops::checkout_remote_tracking,
        commands::git_ops::track_remote_branch,
        commands::git_ops::reset_to_commit,
        commands::git_ops::list_commits_page,
        commands::git_ops::get_revisions_diff,
        commands::git_ops::format_patch,
        commands::git_ops::rename_branch,
        commands::git_ops::rebase_plan,
        commands::git_ops::rebase_interactive,
        commands::git_ops::rebase_onto,
        commands::git_ops::file_history,
        commands::git_ops::head_commit_message,
        commands::git_ops::amend_commit,
        commands::git_ops::revert_commit,
        commands::git_ops::cherry_pick_commit,
        commands::git_ops::list_tags,
        commands::git_ops::create_tag,
        commands::git_ops::delete_tag,
        commands::git_ops::list_stashes,
        commands::git_ops::stash_save,
        commands::git_ops::stash_apply,
        commands::git_ops::stash_pop,
        commands::git_ops::stash_drop,
        commands::git_ops::rename_stash,
        commands::git_ops::get_working_diff,
        commands::git_ops::get_staged_diff,
        commands::git_ops::get_file_diff,
        commands::git_ops::file_at_revision,
        commands::git_ops::get_commit_diff,
        commands::git_ops::get_commit_file_diff,
        commands::git_ops::get_file_blame,
        commands::git_ops::stage_file,
        commands::git_ops::stage_all,
        commands::git_ops::unstage_file,
        commands::git_ops::unstage_all,
        commands::git_ops::discard_file_changes,
    ]
    shard_07 => [
        commands::git_ops::quick_diff_base,
        commands::git_ops::discard_all_changes,
        commands::git_ops::stage_hunk,
        commands::git_ops::unstage_hunk,
        commands::git_ops::discard_hunk,
        commands::git_ops::commit,
        commands::secret_scan_cmd::scan_staged_secrets,
        commands::git_ops::list_remotes,
        commands::git_ops::set_remote_url,
        commands::git_ops::add_remote,
        commands::git_ops::remove_remote,
        commands::git_ops::get_git_identity,
        commands::git_ops::set_git_identity,
        commands::git_ops::set_repo_git_identity,
        commands::git_ops::merge_branch,
        commands::git_ops::resolve_conflict_side,
        commands::git_ops::mark_conflict_resolved,
        commands::git_ops::get_operation_state,
        commands::git_ops::continue_operation,
        commands::git_ops::abort_operation,
        commands::git_ops::git_clone,
        commands::git_ops::git_fetch,
        commands::git_ops::git_file_side,
        commands::git_ops::git_lfs_pull,
        commands::git_ops::git_lfs_track,
        commands::git_ops::git_pull,
        commands::git_ops::git_pull_with,
        commands::git_ops::git_fetch_branch,
        commands::git_ops::git_pull_branch,
        commands::git_ops::git_push,
        commands::git_ops::git_push_branch,
        commands::git_ops::git_push_force_with_lease,
        commands::git_ops::stage_lines,
        commands::git_ops::unstage_lines,
        commands::git_ops::discard_lines,
        commands::git_ops::get_repo_features,
        commands::git_ops::get_conflict_detail,
        commands::git_ops::get_conflict_merge_text,
        commands::git_ops::resolve_conflict_with_text,
    ]
    shard_08 => [
        commands::git_ops::resolve_conflict_deleted,
        commands::git_ops::list_reflog,
        commands::git_ops::get_undo_plan,
        commands::git_ops::undo_last_operation,
        commands::git_ops::restore_reflog_entry,
        commands::git_ops::list_submodules,
        commands::git_ops::git_submodule_update,
        commands::git_ops::list_worktrees,
        commands::git_ops::add_worktree,
        commands::git_ops::remove_worktree,
        commands::git_ops::prune_worktrees,
        commands::git_ops::git_push_tag,
        commands::git_ops::git_push_all_tags,
        commands::git_ops::git_delete_remote_tag,
        commands::git_ops::git_delete_remote_branch,
        commands::git_ops::get_bisect_state,
        commands::git_ops::bisect_start,
        commands::git_ops::bisect_mark,
        commands::git_ops::bisect_reset,
        commands::remotectl_cmd::remotectl_status,
        commands::remotectl_cmd::remotectl_set_enabled,
        commands::remotectl_cmd::remotectl_set_port,
        commands::remotectl_cmd::remotectl_set_allow_terminal,
        commands::remotectl_cmd::remotectl_set_tls,
        commands::remotectl_cmd::remotectl_publish_notifications,
        commands::remotectl_cmd::remotectl_start_pairing,
        commands::remotectl_cmd::remotectl_cancel_pairing,
        commands::remotectl_cmd::remotectl_list_devices,
        commands::remotectl_cmd::remotectl_list_terminals,
        commands::remotectl_cmd::remotectl_revoke_device,
        commands::remotectl_cmd::remotectl_revoke_all,
        commands::remotectl_cmd::remotectl_forget_device,
        commands::remotectl_cmd::remotectl_forget_all_revoked,
        commands::remotectl_cmd::notify_state_change,
        commands::settings::get_setting,
        commands::settings::get_settings,
        commands::settings::set_setting,
        commands::ai_accounts_cmd::ai_accounts_list,
        commands::ai_accounts_cmd::ai_account_create,
        commands::ai_accounts_cmd::ai_account_rename,
    ]
    shard_09 => [
        commands::ai_accounts_cmd::ai_account_delete,
        commands::ai_accounts_cmd::ai_account_status,
        commands::ai_accounts_cmd::ai_account_logout,
        commands::ai_accounts_cmd::ai_account_set_workspace_default,
        commands::settings::get_locked_branch_rules,
        commands::settings::set_locked_branch_rules,
        commands::settings::default_locked_branch_rules,
        commands::settings::get_workspace_prompt,
        commands::settings::set_workspace_prompt,
        commands::settings::default_workspace_prompt,
        commands::settings::get_review_engine_config,
        commands::settings::set_review_engine_config,
        commands::settings::reset_review_engine_config,
        commands::settings::list_workspace_agents,
        commands::settings::upsert_workspace_agent,
        commands::settings::delete_workspace_agent,
        commands::agents_cmd::list_agent_tasks,
        commands::agents_cmd::get_agent_task,
        commands::agents_cmd::create_agent_task,
        commands::agents_cmd::create_agent_worktree,
        commands::agents_cmd::update_agent_task_run,
        commands::agents_cmd::set_agent_task_project,
        commands::agents_cmd::rename_agent_task,
        commands::agents_cmd::delete_agent_task,
        commands::agents_cmd::list_agent_chains,
        commands::agents_cmd::list_gated_chains,
        commands::agents_cmd::get_chain_detail,
        commands::agents_cmd::create_agent_chain,
        commands::agents_cmd::create_story_chain,
        commands::app_cmd::ai_usage_stats,
        commands::app_cmd::ai_quota_status,
        commands::app_cmd::power_status,
        commands::app_cmd::power_save_set,
        // «Salud de dependencias» — the Revisor's «Dependencias» section (deps/).
        commands::deps_cmd::deps_config_get,
        commands::deps_cmd::deps_analyze,
        commands::deps_cmd::deps_reports,
        commands::deps_cmd::deps_update_plan,
        commands::deps_cmd::deps_update_apply,
        commands::deps_cmd::deps_check_alerts,

        commands::worklog_cmd::worklog_generate,
        commands::tickets_cmd::tickets_list,
        commands::tickets_cmd::tickets_azure_projects,
        commands::tickets_cmd::tickets_detail,
        commands::tickets_cmd::tickets_states,
        commands::tickets_cmd::tickets_move,
        commands::tickets_cmd::tickets_links,
        commands::tickets_cmd::tickets_unlink,
        commands::tickets_cmd::tickets_branch_name,
        commands::tickets_cmd::tickets_start,
        commands::tickets_cmd::tickets_pr_reference,
        commands::tickets_cmd::tickets_apply_reference,
        commands::tickets_cmd::tickets_on_pr_created,
        commands::tickets_cmd::tickets_on_pr_merged,
        commands::tickets_cmd::tickets_sync,
        commands::repo_env_cmd::repo_env_defaults,
        commands::repo_env_cmd::repo_env_scan,
        commands::repo_env_cmd::repo_env_usage,
        commands::repo_env_cmd::repo_env_reveal,
        commands::repo_env_cmd::repo_env_move_to_vault,
        commands::repo_env_cmd::repo_env_add_key,
        commands::repo_env_cmd::repo_env_service_files,
        commands::mock_cmd::api_mock_get_config,
        commands::mock_cmd::api_mock_save_config,
        commands::mock_cmd::api_mock_start,
        commands::mock_cmd::api_mock_stop,
        commands::mock_cmd::api_mock_list,
        commands::mock_cmd::api_mock_log,
        commands::mock_cmd::api_mock_clear_log,
        commands::mock_cmd::api_mock_workspace,
        commands::mock_cmd::api_mock_start_with_services,
        commands::app_cmd::system_load,
        commands::agents_cmd::set_chain_step_input,
        commands::agents_cmd::set_chain_step_skipped,
        commands::agents_cmd::claim_next_chain_step,
        commands::agents_cmd::complete_chain_step,
        commands::agents_cmd::approve_chain_gate,
        commands::agents_cmd::skip_chain_step,
        commands::agents_cmd::retry_chain_step,
        commands::agents_cmd::chain_use_backup,
        commands::agents_cmd::chain_review_info,
        commands::agents_cmd::list_parked_chains,
        agentcli::automation_set_enabled,
        commands::architecture_cmd::architecture_scan_system,
        commands::architecture_cmd::architecture_sequence_from,
        agentcli::automation_status,
        commands::agents_cmd::chain_extra_lap,
    ]
    shard_10 => [
        commands::agents_cmd::resume_chain,
        commands::agents_cmd::abort_chain,
        commands::agents_cmd::set_chain_resume_at,
        commands::agents_cmd::list_scheduled_resumes,
        commands::agents_cmd::delete_chain,
        commands::agents_cmd::harvest_chain_step,
        commands::agents_cmd::run_chain_step_check,
        commands::agents_cmd::rerun_chain_from,
        commands::agents_cmd::create_continuation_chain,
        commands::agents_cmd::list_chain_templates,
        commands::agents_cmd::upsert_chain_template,
        commands::agents_cmd::delete_chain_template,
        commands::agents_cmd::list_agent_projects,
        commands::agents_cmd::upsert_agent_project,
        commands::agents_cmd::delete_agent_project,
        commands::agents_cmd::set_agent_task_group,
        commands::agents_cmd::set_agent_task_pinned,
        commands::agents_cmd::set_agent_task_planning,
        commands::agents_cmd::set_agent_task_archived,
        commands::agents_cmd::set_chain_group,
        commands::agents_cmd::set_chain_pinned,
        commands::agents_cmd::list_workspace_chain_steps,
        commands::settings::list_review_runs,
        commands::settings::get_review_run,
        commands::settings::mark_review_finding,
        commands::settings::list_fp_suppressions,
        commands::settings::remove_fp_suppression,
        commands::settings::delete_review_run,
        commands::settings::delete_review_runs_for_pr,
        commands::settings::purge_workspace_review_runs,
        commands::settings::export_review_runs,
        commands::settings::import_review_runs,
        commands::settings::list_review_contexts,
        commands::settings::upsert_review_context,
        commands::settings::delete_review_context,
        commands::skills_cmd::install_workspace_skill,
        commands::skills_cmd::skills_registry_search,
        commands::skills_cmd::skills_registry_describe,
        commands::skills_cmd::skill_generate,
        commands::skills_cmd::default_skill_template,
        commands::skills_cmd::skill_save_draft,
        commands::skills_cmd::skill_write_bundle,
        commands::skills_cmd::export_workspace_skill,
        commands::skills_cmd::list_workspace_skills,
        commands::skills_cmd::remove_workspace_skill,
        commands::skills_cmd::set_workspace_skill_enabled,
        commands::skills_cmd::create_custom_skill,
        commands::skills_cmd::import_skill_from_folder,
    ]
    shard_11 => [
        commands::skills_cmd::import_skill_from_file,
        commands::skills_cmd::list_skill_files,
        commands::skills_cmd::read_skill_file,
        commands::skills_cmd::write_skill_file,
        commands::skills_cmd::delete_skill_file,
        commands::secrets_cmd::set_ado_pat,
        commands::secrets_cmd::get_ado_pat,
        commands::secrets_cmd::delete_ado_pat,
        commands::secrets_cmd::set_github_token,
        commands::secrets_cmd::get_github_token,
        commands::secrets_cmd::delete_github_token,
        commands::secrets_cmd::set_gitlab_token,
        commands::secrets_cmd::get_gitlab_token,
        commands::secrets_cmd::delete_gitlab_token,
        commands::secrets_cmd::set_jira_token,
        commands::secrets_cmd::delete_jira_token,
        commands::secrets_cmd::set_monday_token,
        commands::secrets_cmd::delete_monday_token,
        commands::secrets_cmd::set_linear_token,
        commands::secrets_cmd::delete_linear_token,
        commands::claude_cmd::claude_chat_plugins,
        commands::claude_cmd::generate_commit_message,
        commands::claude_cmd::draft_pr_comment_reply,
        commands::claude_cmd::list_ai_models,
        commands::claude_cmd::check_ai_provider,
        commands::ado_cmd::open_external_url,
        commands::claude_cmd::default_commit_template,
        commands::claude_cmd::default_analyze_template,
        commands::claude_cmd::default_pipeline_template,
        commands::claude_cmd::default_sample_rows_template,
        commands::claude_cmd::default_resolve_conflict_template,
        commands::claude_cmd::analyze_working_changes,
        commands::claude_cmd::resolve_conflict_with_ai,
        commands::claude_cmd::resolve_finding_with_ai,
        commands::fix_verify::fix_verify_command,
        commands::claude_cmd::send_chat_message,
        commands::claude_cmd::cancel_ai_run,
        commands::claude_cmd::ai_read_only_engines,
        commands::claude_cmd::ai_classify_failure,
        commands::claude_cmd::user_error_classify,
        commands::claude_cmd::provider_last_error,
        commands::claude_cmd::provider_caps,
        commands::claude_cmd::storage_usage,
        commands::claude_cmd::storage_clear,
        commands::claude_cmd::cli_updates_check,
        commands::claude_cmd::cli_updates_skip,
        commands::claude_cmd::cli_updates_install,
        commands::claude_cmd::provider_clear_error,
        commands::claude_cmd::provider_diagnostics,
        commands::claude_cmd::inline_edit_with_ai,
        commands::notebook_cmd::notebook_discover_kernels,
        commands::notebook_cmd::notebook_kernel_start,
        commands::notebook_cmd::notebook_kernel_execute,
    ]
    shard_12 => [
        commands::notebook_cmd::notebook_kernel_input,
        commands::notebook_cmd::notebook_kernel_interrupt,
        commands::notebook_cmd::notebook_kernel_restart,
        commands::notebook_cmd::notebook_kernel_shutdown,
        commands::notebook_cmd::notebook_ai,
        commands::notebook_cmd::default_notebook_template,
        commands::checkpoint_cmd::list_ai_checkpoints,
        commands::checkpoint_cmd::ai_checkpoint_changed_paths,
        commands::checkpoint_cmd::restore_ai_checkpoint,
        commands::checkpoint_cmd::ai_checkpoint_file,
        commands::tests_cmd::run_test_command,
        commands::checkpoint_cmd::restore_ai_checkpoint_paths,
        commands::checkpoint_cmd::delete_ai_checkpoint,
        commands::ado_cmd::ado_verify_pat,
        commands::ado_cmd::ado_check_org,
        commands::ado_cmd::ado_list_projects,
        commands::ado_cmd::ado_list_repos,
        commands::ado_cmd::auto_link_project,
        commands::ado_cmd::link_project_ado,
        commands::ado_cmd::unlink_project,
        commands::ado_cmd::open_repo_in_browser,
        commands::ado_cmd::list_pull_requests,
        commands::ci_cmd::pipeline_availability,
        commands::ci_cmd::list_pipeline_runs,
        commands::ci_cmd::pipeline_run_detail,
        commands::ci_cmd::fetch_pipeline_job_log,
        commands::ci_cmd::save_pipeline_job_log,
        commands::ci_cmd::ci_actionlint,
        commands::ci_cmd::rerun_pipeline,
        commands::ci_cmd::cancel_pipeline,
        commands::ci_cmd::analyze_pipeline_failure,
        commands::ci_cmd::pipeline_launch_context,
        commands::ci_cmd::pipeline_definition_file,
        commands::ci_cmd::start_pipeline,
        commands::ci_cmd::review_pipeline_gate,
        commands::ci_cmd::play_pipeline_job,
        commands::ci_cmd::list_pipeline_artifacts,
        commands::ci_cmd::download_pipeline_artifact,
        commands::ci_cmd::cancel_pipeline_artifact_download,
        commands::ado_cmd::resolve_pr_link,
        commands::ado_cmd::review_pr_from_link,
        commands::ado_cmd::post_pr_link_review_comment,
        commands::ado_cmd::pr_link_pull_request,
        commands::ado_cmd::pr_link_comment_threads,
        commands::ado_cmd::pr_link_resolve_comment_thread,
    ]
    shard_13 => [
        commands::ado_cmd::pr_link_decision,
        commands::ado_cmd::act_on_pr_link,
        commands::ado_cmd::generate_pr_description,
        commands::ado_cmd::create_pull_request,
        commands::ado_cmd::search_work_items,
        commands::ado_cmd::list_pr_comment_threads,
        commands::ado_cmd::resolve_pr_comment_thread,
        commands::ado_cmd::discard_pr_finding,
        commands::ado_cmd::review_pull_request,
        commands::ado_cmd::preview_pr_review,
        commands::ado_cmd::post_pr_review_comment,
        commands::ado_cmd::act_on_pull_request,
        commands::ado_cmd::pr_review_decision,
        commands::ado_cmd::list_pull_requests_page,
        commands::ado_cmd::get_pull_request,
        commands::ado_cmd::publish_pr_review,
        commands::ado_cmd::pr_merge_options,
        commands::ado_cmd::merge_pull_request,
        commands::ado_cmd::pr_link_merge_options,
        commands::ado_cmd::merge_pr_link,
        commands::ado_cmd::pr_checks,
        commands::ado_cmd::pr_link_checks,
        // ---- user stories (workspace-scoped: wiki in, Azure Boards out) ----
        commands::stories_cmd::ado_list_wikis,
        commands::stories_cmd::ado_list_wiki_pages,
        commands::stories_cmd::ado_wiki_pages_content,
        commands::stories_cmd::ado_wiki_page_detail,
        commands::stories_cmd::list_doc_pages,
        commands::stories_cmd::get_doc_page,
        commands::stories_cmd::reload_doc_page_from_wiki,
        commands::stories_cmd::preview_story_board_update,
        commands::stories_cmd::update_story_on_board,
        commands::stories_cmd::create_doc_page,
        commands::stories_cmd::import_wiki_page,
        commands::stories_cmd::set_doc_page_content,
        commands::stories_cmd::set_doc_page_title,
        commands::stories_cmd::set_doc_page_target,
        commands::stories_cmd::delete_doc_page,
        commands::stories_cmd::publish_doc_page,
        commands::stories_cmd::generate_doc_page,
    ]
    shard_14 => [
        commands::stories_cmd::board_list_item_types,
        commands::stories_cmd::jira_list_projects,
        commands::stories_cmd::monday_whoami,
        commands::stories_cmd::linear_whoami,
        commands::stories_cmd::linear_list_teams,
        commands::stories_cmd::monday_list_boards,
        commands::stories_cmd::monday_board_schema,
        commands::stories_cmd::ado_list_classification_nodes,
        commands::stories_cmd::board_parse_item_ref,
        commands::stories_cmd::board_get_work_item,
        commands::stories_cmd::story_batch_board_states,
        commands::stories_cmd::story_source_document,
        commands::stories_cmd::story_source_url,
        commands::stories_cmd::review_work_item,
        commands::stories_cmd::board_update_work_item,
        commands::stories_cmd::board_create_child_tasks,
        commands::stories_cmd::list_work_item_reviews,
        commands::stories_cmd::save_work_item_review,
        commands::stories_cmd::delete_work_item_review,
        commands::stories_cmd::list_story_batches,
        commands::stories_cmd::get_story_batch,
        commands::stories_cmd::create_story_batch,
        commands::stories_cmd::rename_story_batch,
        commands::stories_cmd::set_story_batch_target,
        commands::stories_cmd::set_story_batch_instructions,
        commands::stories_cmd::set_story_batch_answers,
        commands::stories_cmd::set_story_batch_verify_projects,
        commands::stories_cmd::set_story_batch_feature_project,
        commands::stories_cmd::delete_story_batch,
        commands::stories_cmd::generate_stories,
        commands::stories_cmd::story_batch_prompt,
        commands::stories_cmd::verify_stories,
        commands::stories_cmd::write_story_feature_file,
        commands::stories_cmd::add_story_draft,
        commands::stories_cmd::save_story_draft,
        commands::stories_cmd::delete_story_draft,
        commands::stories_cmd::publish_stories,
            commands::stories_cmd::find_story_duplicates,
        commands::github_cmd::link_project_github,
        commands::github_cmd::github_authenticated_user,
        commands::publish_cmd::publish_targets,
        commands::publish_cmd::publish_create,
        commands::publish_cmd::publish_push,
        commands::gitlab_cmd::link_project_gitlab,
        commands::gitlab_cmd::gitlab_authenticated_user,
        commands::bitbucket_cmd::link_project_bitbucket,
        commands::bitbucket_cmd::bitbucket_verify_credential,
        commands::bitbucket_cmd::bitbucket_check_workspace,
        commands::bitbucket_cmd::set_bitbucket_credential,
    ]
    shard_15 => [
        commands::bitbucket_cmd::delete_bitbucket_credential,
        commands::fs_cmd::list_dir,
        commands::fs_cmd::list_repo_files,
        commands::fs_cmd::search_repo,
        commands::fs_cmd::replace_in_repo,
        commands::fs_cmd::read_file_text,
        commands::fs_cmd::read_file_bytes,
        commands::fs_cmd::write_file_text,
        commands::fs_cmd::read_editor_file,
        commands::fs_cmd::stat_editor_file,
        commands::fs_cmd::write_editor_file,
        commands::fs_cmd::local_history_list,
        commands::fs_cmd::local_history_read,
        commands::fs_cmd::write_file_bytes,
        commands::fs_cmd::read_picked_json,
        commands::fs_cmd::move_path,
        commands::fs_cmd::copy_into_repo,
        commands::fs_cmd::copy_path,
        commands::fs_cmd::copy_external_path,
        explorer_bridge::system_clipboard_files,
        explorer_bridge::system_clipboard_stamp,
        clipboard_text::clipboard_write_text,
        clipboard_text::clipboard_read_text,
        explorer_bridge::window_under_cursor,
        commands::fs_cmd::dir_tree,
        commands::fs_cmd::create_dir,
        commands::fs_cmd::create_file,
        commands::fs_cmd::rename_path,
        commands::fs_cmd::delete_path,
        commands::fs_cmd::open_in_default_app,
        commands::fs_cmd::reveal_in_file_manager,
        commands::external_editor_cmd::external_editor_state,
        commands::external_editor_cmd::open_in_external_editor,
        commands::activity_cmd::list_chat_conversations,
        commands::activity_cmd::get_chat_conversation,
        commands::activity_cmd::get_turn_trace,
        commands::activity_cmd::get_job_result,
        commands::activity_cmd::delete_chat_conversation,
        commands::activity_cmd::rename_chat_conversation,
        commands::chat_cmd::chat_move_from_panel,
        commands::activity_cmd::reset_chat_context,
        commands::activity_cmd::branch_chat_conversation,
        commands::activity_cmd::chat_context_resets,
        commands::activity_cmd::list_job_history,
        commands::activity_cmd::rename_job_history_entry,
        commands::activity_cmd::delete_job_history_entry,
        commands::activity_cmd::list_workspace_activity,
        commands::activity_cmd::rename_workspace_activity_entry,
    ]
    shard_16 => [
        commands::activity_cmd::delete_workspace_activity_entry,
        commands::terminal_cmd::list_shell_profiles,
        commands::terminal_cmd::open_terminal,
        commands::terminal_cmd::write_terminal,
        commands::terminal_cmd::resize_terminal,
        commands::terminal_cmd::close_terminal,
        commands::terminal_cmd::terminal_path_kinds,
        commands::terminal_cmd::terminal_foreground,
        commands::terminal_cmd::terminal_agent_states,
        commands::terminal_cmd::terminal_set_agent,
        commands::terminal_cmd::agent_launch_files,
        commands::terminal_cmd::list_workspace_terminals,
        commands::terminal_cmd::add_workspace_terminal,
        commands::terminal_cmd::resume_workspace_terminal,
        commands::terminal_cmd::rename_workspace_terminal,
        commands::terminal_cmd::remove_workspace_terminal,
        commands::terminal_cmd::clear_workspace_terminals,
        commands::terminal_cmd::add_bench_tab,
        commands::terminal_cmd::set_bench_layout,
        commands::terminal_cmd::rename_bench_tab,
        commands::terminal_cmd::remove_bench_tab,
        // The Remote workspace. Note the absence of write/resize/close: a remote session is a
        // terminal session, driven by the five above.
        commands::remote_cmd::remote_load_tree,
        commands::remote_cmd::remote_create_host,
        commands::remote_cmd::remote_update_host,
        commands::remote_cmd::remote_delete_host,
        commands::remote_cmd::remote_duplicate_host,
        commands::remote_cmd::remote_reorder_hosts,
        commands::remote_cmd::remote_create_group,
        commands::remote_cmd::remote_rename_group,
        commands::remote_cmd::remote_delete_group,
        commands::remote_cmd::remote_set_password,
        commands::remote_cmd::remote_get_password,
        commands::remote_cmd::remote_type_password,
        commands::remote_cmd::remote_askpass_supported,
        commands::remote_cmd::remote_open_session,
        commands::remote_cmd::remote_open_draft_session,
        commands::remote_cmd::remote_open_forward,
        commands::remote_cmd::remote_close_forward,
        commands::remote_cmd::remote_list_forwards,
        commands::remote_cmd::remote_open_screen,
        commands::remote_cmd::remote_close_screen,
        commands::remote_cmd::remote_host_holds,
        commands::remote_cmd::remote_disconnect_host,
    ]
    shard_17 => [
        commands::remote_cmd::remote_queues,
        commands::remote_cmd::remote_queue_depths,
        commands::remote_cmd::remote_queue_peek,
        commands::remote_cmd::remote_queue_receive,
        commands::remote_cmd::remote_queue_put,
        commands::remote_cmd::remote_queue_delete_message,
        commands::remote_cmd::remote_queue_clear,
        commands::remote_cmd::remote_queue_create,
        commands::remote_cmd::remote_queue_remove,
        commands::remote_cmd::remote_tables,
        commands::remote_cmd::remote_table_query,
        commands::remote_cmd::remote_table_upsert,
        commands::remote_cmd::remote_table_delete_entity,
        commands::remote_cmd::remote_table_create,
        commands::remote_cmd::remote_table_remove,
        commands::remote_cmd::remote_ping,
        commands::remote_cmd::remote_list_logs,
        commands::remote_cmd::remote_clear_logs,
        commands::remote_cmd::remote_list_files,
        commands::remote_cmd::remote_list_local_files,
        commands::remote_cmd::remote_download_file,
        commands::remote_cmd::remote_upload_file,
        commands::remote_cmd::remote_make_dir,
        commands::remote_cmd::remote_remove_file,
        commands::remote_cmd::remote_rename_file,
        commands::remote_cmd::remote_close_files,
        commands::remote_cmd::remote_read_text,
        commands::remote_cmd::remote_write_text,
        commands::remote_cmd::remote_cancel_transfer,
        commands::remote_cmd::remote_paths_exist,
        commands::remote_cmd::remote_parse_ssh_command,
        commands::remote_cmd::remote_parse_azure_connection,
        commands::remote_cmd::remote_delete_container,
        commands::remote_cmd::remote_blob_copy,
        commands::remote_cmd::remote_blob_properties,
        commands::remote_cmd::remote_blob_snapshot,
        commands::remote_cmd::remote_blob_snapshots,
        commands::remote_cmd::remote_blob_delete_snapshot,
        commands::remote_cmd::remote_blob_restore_snapshot,
        commands::remote_cmd::remote_discover_azure,
        commands::remote_cmd::remote_check_cloud,
        commands::remote_cmd::remote_list_keys,
        commands::remote_cmd::remote_pageant_pipe,
        commands::remote_cmd::remote_import_ppk,
    ]
    shard_18 => [
        commands::remote_cmd::remote_generate_key,
        commands::remote_cmd::remote_ssh_config_path,
        commands::remote_cmd::remote_scan_ssh_config,
        commands::remote_cmd::remote_import_ssh_config,
        commands::remote_cmd::remote_create_snippet,
        commands::remote_cmd::remote_update_snippet,
        commands::remote_cmd::remote_delete_snippet,
        // ---- Notes (workspace-scoped, like Remote above it) ----
        // ---- The keyring ("Llavero"). Global — no workspace scoping on the vault itself. ----
        commands::keyvault_cmd::keyvault_status,
        commands::keyvault_cmd::keyvault_copy_secret,
            commands::keyvault_cmd::keyvault_set_biometric,
        commands::keyvault_cmd::keyvault_initialise,
        commands::keyvault_cmd::keyvault_unlock,
        commands::keyvault_cmd::keyvault_unlock_remembered,
        commands::keyvault_cmd::keyvault_lock,
        commands::keyvault_cmd::keyvault_touch,
        commands::keyvault_cmd::keyvault_change_password,
        commands::keyvault_cmd::keyvault_set_autolock,
        commands::keyvault_cmd::keyvault_forget_password,
        commands::keyvault_cmd::keyvault_reset,
        commands::keyvault_cmd::keyvault_load_tree,
        commands::keyvault_cmd::keyvault_list_trash,
        commands::keyvault_cmd::keyvault_password_health,
        commands::keyvault_cmd::keyvault_get_item,
        commands::keyvault_cmd::keyvault_create_item,
        commands::keyvault_cmd::keyvault_update_item,
        commands::keyvault_cmd::keyvault_move_item,
        commands::keyvault_cmd::keyvault_set_item_workspace,
        commands::keyvault_cmd::keyvault_set_favorite,
        commands::keyvault_cmd::keyvault_delete_item,
        commands::keyvault_cmd::keyvault_restore_item,
        commands::keyvault_cmd::keyvault_purge_item,
        commands::keyvault_cmd::keyvault_empty_trash,
        commands::keyvault_cmd::keyvault_create_folder,
        commands::keyvault_cmd::keyvault_rename_folder,
        commands::keyvault_cmd::keyvault_set_folder_color,
        commands::keyvault_cmd::keyvault_set_folder_workspace,
        commands::keyvault_cmd::keyvault_move_folder,
        commands::keyvault_cmd::keyvault_delete_folder,
        commands::keyvault_cmd::keyvault_list_blobs,
        commands::keyvault_cmd::keyvault_add_blob,
        commands::keyvault_cmd::keyvault_read_blob,
    ]
    shard_19 => [
        commands::keyvault_cmd::keyvault_delete_blob,
        commands::keyvault_cmd::keyvault_generate_password,
        commands::keyvault_cmd::keyvault_totp_code,
        commands::keyvault_cmd::keyvault_audit,
        commands::keyvault_cmd::keyvault_read_import_file,
        commands::keyvault_cmd::keyvault_export,
        commands::keyvault_cmd::keyvault_import_export,
        commands::notes_cmd::notes_load_tree,
        commands::notes_cmd::notes_get_note,
        commands::notes_cmd::notes_create_note,
        commands::notes_cmd::notes_save_note,
        commands::notes_cmd::notes_pull_file,
        commands::notes_cmd::notes_link_file,
        commands::notes_cmd::notes_save_to_repo,
        commands::notes_cmd::notes_unlink_file,
        commands::notes_cmd::notes_move_note,
        commands::notes_cmd::notes_reorder_notes,
        commands::notes_cmd::notes_set_pinned,
        commands::notes_cmd::notes_delete_note,
        commands::notes_cmd::notes_list_trash,
        commands::notes_cmd::notes_restore_note,
        commands::notes_cmd::notes_purge_note,
        commands::notes_cmd::notes_empty_trash,
        commands::notes_cmd::notes_count_links,
        commands::notes_cmd::notes_rewrite_links,
        commands::notes_cmd::notes_read_import,
        commands::notes_cmd::notes_duplicate_note,
        commands::notes_cmd::notes_create_book,
        commands::notes_cmd::notes_rename_book,
        commands::notes_cmd::notes_set_book_color,
        commands::notes_cmd::notes_move_book,
        commands::notes_cmd::notes_reorder_books,
        commands::notes_cmd::notes_delete_book,
        commands::notes_cmd::notes_create_template,
        commands::notes_cmd::notes_update_template,
        commands::notes_cmd::notes_delete_template,
        commands::notes_cmd::notes_search,
        commands::notes_cmd::notes_backlinks,
        commands::notes_cmd::notes_graph,
        commands::notes_cmd::notes_read_vault,
        commands::notes_cmd::notes_export_docx,
        commands::notes_cmd::notes_list_versions,
        commands::notes_cmd::notes_version_content,
    ]
    shard_20 => [
        commands::notes_cmd::notes_delete_version,
        commands::notes_cmd::notes_clear_versions,
        commands::notes_cmd::notes_write_with_ai,
        commands::notes_cmd::notes_set_book_scope,
        commands::notes_cmd::notes_move_book_to_workspace,
        // ---- Diagrams (workspace-scoped, like Notes above it) ----
        commands::flows_cmd::flows_node_catalog,
        commands::flows_cmd::flows_connectors,
        commands::flows_cmd::flows_connector_options,
        commands::flows_cmd::flows_connector_test,
        commands::flows_cmd::flows_build_with_ai,
        commands::flows_cmd::flows_shares,
        commands::flows_cmd::flows_share,
        commands::flows_cmd::flows_join_shared,
        commands::flows_cmd::flows_share_tick,
        commands::flows_cmd::flows_share_sync,
        commands::flows_cmd::flows_share_resolve,
        commands::flows_cmd::flows_share_rotate,
        commands::flows_cmd::flows_share_leave,
        commands::flows_cmd::flows_load_tree,
        commands::flows_cmd::flows_get_flow,
        commands::flows_cmd::flows_create_flow,
        commands::flows_cmd::flows_save_flow,
        commands::flows_cmd::flows_rename_flow,
        commands::flows_cmd::flows_move_flow,
        commands::flows_cmd::flows_reorder_flows,
        commands::flows_cmd::flows_reorder_folders,
        commands::flows_cmd::flows_set_scope,
        commands::flows_cmd::flows_move_to_workspace,
        commands::flows_cmd::flows_duplicate_flow,
        commands::flows_cmd::flows_delete_flow,
        commands::flows_cmd::flows_create_folder,
        commands::flows_cmd::flows_rename_folder,
        commands::flows_cmd::flows_delete_folder,
        commands::flows_cmd::flows_list_versions,
        commands::flows_cmd::flows_version_content,
        commands::flows_cmd::flows_delete_version,
        commands::flows_cmd::flows_clear_versions,
        commands::flows_cmd::flows_run,
        commands::flows_cmd::flows_retry_run,
    ]
    shard_21 => [
        commands::flows_cmd::flows_app_event,
        commands::flows_cmd::flows_tunnel_status,
        commands::flows_cmd::flows_tunnel_set,
        commands::flows_cmd::flows_mcp_info,
        commands::flows_cmd::flows_mcp_rotate,
        commands::flows_cmd::flows_confirm_link,
        commands::flows_cmd::flows_cli_command,
        commands::flows_cmd::flows_run_form,
        commands::flows_cmd::flows_bridge_answer,
        commands::flows_cmd::flows_cancel_run,
        commands::flows_cmd::flows_debug_resume,
        commands::flows_cmd::flows_list_waits,
        commands::flows_cmd::flows_trust_flow,
        commands::flows_cmd::flows_export_flow,
        commands::flows_cmd::flows_import_flow,
        commands::flows_cmd::flows_decide_wait,
        commands::flows_cmd::flows_active_runs,
        commands::flows_cmd::flows_list_runs,
        commands::flows_cmd::flows_failed_runs,
        commands::flows_cmd::flows_missing_programs,
        commands::flows_cmd::flows_metrics,
        commands::flows_cmd::flows_run_periods,
        commands::flows_cmd::flows_list_templates,
        commands::flows_cmd::flows_save_template,
        commands::flows_cmd::flows_update_template,
        commands::flows_cmd::flows_delete_template,
        commands::flows_cmd::flows_create_from_template,
        commands::flows_cmd::flows_repo_scan,
        commands::flows_cmd::flows_repo_import,
        commands::flows_cmd::flows_repo_save,
        commands::flows_cmd::flows_repo_pull,
        commands::flows_cmd::flows_repo_unlink,
        commands::flows_cmd::flows_get_run,
        commands::flows_cmd::flows_run_node_data,
        commands::flows_cmd::flows_run_log,
        commands::flows_cmd::flows_delete_run,
        commands::flows_cmd::flows_clear_runs,
        commands::flows_cmd::flows_preview_expression,
        commands::flows_cmd::flows_ai_transform_code,
        commands::flows_cmd::flows_tests_list,
        commands::flows_cmd::flows_test_save,
        commands::flows_cmd::flows_test_delete,
        commands::flows_cmd::flows_tests_run,
    ]
    shard_22 => [
        commands::flows_cmd::flows_published_nodes,
        commands::flows_cmd::flows_context_entries,
        commands::flows_cmd::flows_context_run,
        commands::flows_cmd::flows_chat_assistants,
        commands::flows_cmd::flows_tables_list,
        commands::flows_cmd::flows_table_create,
        commands::flows_cmd::flows_table_rename,
        commands::flows_cmd::flows_table_delete,
        commands::flows_cmd::flows_table_rows,
        commands::flows_cmd::flows_table_put_row,
        commands::flows_cmd::flows_table_delete_rows,
        commands::flows_cmd::flows_table_clear,
        commands::flows_cmd::flows_table_import,
        commands::flows_cmd::flows_list_pins,
        commands::flows_cmd::flows_pin_node,
        commands::flows_cmd::flows_unpin_node,
        commands::flows_cmd::flows_list_variables,
        commands::flows_cmd::flows_put_variable,
        commands::flows_cmd::flows_rename_variable,
        commands::flows_cmd::flows_delete_variable,
        commands::flows_cmd::flows_set_variable_scope,
        commands::flows_cmd::flows_list_credentials,
        commands::flows_cmd::flows_create_credential,
        commands::flows_cmd::flows_update_credential,
        commands::flows_cmd::flows_oauth_connect,
        commands::flows_cmd::flows_ai_models,
        commands::flows_cmd::flows_delete_credential,
        commands::flows_cmd::flows_set_credential_scope,
        commands::flows_cmd::flows_set_active,
        commands::flows_cmd::flows_trigger_status,
        commands::flows_cmd::flows_armed_names,
        commands::flows_cmd::flows_webhook_base,
        commands::flows_cmd::flows_run_edits,
        commands::flows_cmd::flows_undo_edits,
        commands::flows_cmd::flows_local_models,
    ]
    shard_23 => [
        commands::flows_cmd::flows_test_credential,
        commands::diagrams_cmd::diagrams_load_tree,
        commands::diagrams_cmd::diagrams_search_content,
        commands::diagrams_cmd::diagrams_get_diagram,
        commands::diagrams_cmd::diagrams_load_thumbnails,
        commands::diagrams_cmd::diagrams_create_diagram,
        commands::diagrams_cmd::diagrams_save_diagram,
        commands::diagrams_cmd::diagrams_link_file,
        commands::diagrams_cmd::diagrams_pull_file,
        commands::diagrams_cmd::diagrams_unlink_file,
        commands::diagrams_cmd::diagrams_save_to_repo,
        commands::diagrams_cmd::diagrams_list_versions,
        commands::diagrams_cmd::diagrams_version_content,
        commands::diagrams_cmd::diagrams_delete_version,
        commands::diagrams_cmd::diagrams_clear_versions,
        commands::diagrams_cmd::diagrams_rename_diagram,
        commands::diagrams_cmd::diagrams_set_tags,
        commands::diagrams_cmd::diagrams_move_diagram,
        commands::diagrams_cmd::diagrams_reorder_diagrams,
        commands::diagrams_cmd::diagrams_set_pinned,
        commands::diagrams_cmd::diagrams_delete_diagram,
        commands::diagrams_cmd::diagrams_duplicate_diagram,
        commands::diagrams_cmd::diagrams_create_folder,
        commands::diagrams_cmd::diagrams_rename_folder,
        commands::diagrams_cmd::diagrams_set_folder_color,
        commands::diagrams_cmd::diagrams_move_folder,
        commands::diagrams_cmd::diagrams_reorder_folders,
        commands::diagrams_cmd::diagrams_delete_folder,
        commands::diagrams_cmd::diagrams_create_template,
        commands::diagrams_cmd::diagrams_update_template,
        commands::diagrams_cmd::diagrams_delete_template,
        commands::diagrams_cmd::diagrams_draw_with_ai,
        commands::diagrams_cmd::diagrams_archify_project,
        commands::diagrams_cmd::diagrams_archify_suggestions,
        commands::diagrams_cmd::diagrams_archify_refine,
        commands::diagrams_cmd::diagrams_archify_repo_for,
        commands::diagrams_cmd::diagrams_keep_version,
        commands::diagrams_cmd::diagrams_fill_rows_with_ai,
        commands::diagrams_cmd::diagrams_read_import,
        commands::debug_cmd::debug_start,
        commands::debug_cmd::debug_start_adapter,
    ]
    shard_24 => [
        commands::debug_cmd::debug_stop,
        commands::debug_cmd::debug_continue,
        commands::debug_cmd::debug_pause,
        commands::debug_cmd::debug_step,
        commands::debug_cmd::debug_set_breakpoints,
        commands::debug_cmd::debug_set_exception_filters,
        commands::debug_cmd::debug_properties,
        commands::debug_cmd::debug_scopes,
        commands::debug_cmd::debug_evaluate,
        commands::debug_cmd::debug_is_running,
        commands::debug_cmd::debug_session,
        commands::debug_cmd::debug_python,
        commands::reviewer_cmd::reviewer_status,
        commands::reviewer_cmd::reviewer_rule,
        commands::reviewer_cmd::reviewer_issue_decide,
        commands::reviewer_cmd::reviewer_hotspot_review,
        commands::reviewer_cmd::reviewer_changed_lines,
        commands::reviewer_cmd::reviewer_disk_used,
        commands::reviewer_cmd::reviewer_install,
        commands::reviewer_cmd::reviewer_cancel_install,
        commands::reviewer_cmd::reviewer_uninstall,
        commands::reviewer_cmd::reviewer_server_start,
        commands::reviewer_cmd::reviewer_server_stop,
        commands::reviewer_cmd::reviewer_server_log,
        commands::reviewer_cmd::reviewer_save_config,
        commands::reviewer_cmd::reviewer_apply_rules,
        commands::reviewer_cmd::reviewer_save_server,
        commands::reviewer_cmd::reviewer_delete_server,
        commands::reviewer_cmd::reviewer_server_catalog,
        commands::reviewer_cmd::reviewer_detect,
        commands::reviewer_cmd::reviewer_run,
        commands::reviewer_cmd::reviewer_cancel_run,
        commands::reviewer_cmd::reviewer_active_run,
        commands::reviewer_cmd::reviewer_last_run,
        commands::codemap_cmd::codemap_graph,
        commands::codemap_cmd::codemap_global,
        commands::codemap_cmd::codemap_outline,
        commands::codemap_cmd::codemap_find,
        commands::codemap_cmd::codemap_usages,
        commands::codemap_cmd::codemap_key_symbols,
        commands::codemap_cmd::codemap_health,
        commands::localai_cmd::localai_state,
        commands::localai_cmd::background_status,
        commands::localai_cmd::background_stop,
        commands::knowledge_cmd::knowledge_vectorizing,
        commands::localai_cmd::localai_set_enabled,
        commands::localai_cmd::localai_set_model,
        commands::localai_cmd::localai_download_model,
    ]
    shard_25 => [
        commands::localai_cmd::localai_cancel_download,
        commands::dictation_cmd::dictation_status,
        commands::dictation_cmd::dictation_install,
        commands::dictation_cmd::dictation_cancel_install,
        commands::dictation_cmd::dictation_remove,
        commands::dictation_cmd::dictation_inputs,
        commands::dictation_cmd::dictation_mic_permission,
        commands::dictation_cmd::dictation_mic_request,
        commands::dictation_cmd::dictation_mic_settings,
        commands::dictation_cmd::dictation_record_start,
        commands::dictation_cmd::dictation_record_finish,
        commands::dictation_cmd::dictation_record_cancel,
        commands::dictation_cmd::dictation_cancel,
        commands::meetings_cmd::meetings_status,
        commands::meetings_cmd::meetings_install,
        commands::speech_cmd::speech_status,
        commands::speech_cmd::speech_say,
        commands::speech_cmd::speech_stop,
        commands::speech_cmd::speech_say_voice,
        commands::speech_cmd::audio_outputs,
        commands::speech_cmd::audio_play,
        commands::speech_cmd::speech_set_key,
        commands::speech_cmd::speech_install_voice,
        commands::speech_cmd::speech_cancel_install,
        commands::speech_cmd::speech_remove_voice,
        commands::speech_cmd::speech_summarize,
        commands::voice_cmd::voice_fit,
        commands::voice_clone_cmd::voice_clone_status,
        commands::voice_clone_cmd::voice_clone_accept_terms,
        commands::voice_clone_cmd::voice_clone_prepare,
        commands::voice_clone_cmd::voice_clone_remove,
        commands::voice_clone_cmd::voice_clone_record_start,
        commands::voice_clone_cmd::voice_clone_record_finish,
        commands::voice_clone_cmd::voice_clone_record_cancel,
        commands::voice_clone_cmd::voice_clone_save,
        commands::voice_clone_cmd::voice_clone_delete,
        commands::codi_cmd::codi_status,
        commands::codi_cmd::codi_open_window,
        commands::codi_cmd::codi_set_mic,
        commands::codi_cmd::codi_set_sound,
        commands::codi_cmd::codi_talk,
        commands::codi_cmd::codi_ptt_hotkey,
        commands::codi_cmd::codi_set_ptt_hotkey,
        commands::codi_cmd::codi_suspend_ptt_hotkey,
        commands::codi_cmd::codi_order,
        commands::codi_cmd::codi_confirm,
        commands::codi_cmd::codi_hush,
        commands::codi_cmd::codi_narrate,
        commands::codi_cmd::codi_research,
        commands::codi_cmd::codi_know,
        commands::codi_cmd::codi_explain,
        commands::codi_cmd::codi_explain_pipeline,
        commands::codi_cmd::codi_announce,
        commands::codi_cmd::codi_tell,
        commands::codi_cmd::codi_run_command,
        commands::codi_cmd::codi_window_to_corner,
        commands::codi_cmd::codi_set_at_login,
        windows::quick_ask_take_draft,
        commands::codi_cmd::codi_routines,
        commands::codi_cmd::codi_set_routines,
        commands::codi_cmd::codi_run_routine,
        commands::codi_cmd::desktop_permissions,
        commands::codi_cmd::desktop_ask_permission,
        commands::codi_cmd::codi_forget_all,
        commands::codi_cmd::codi_recollections,
        commands::codi_cmd::codi_forget,
        commands::codi_cmd::codi_installed_apps,
        commands::codi_cmd::codi_action_catalog,
        commands::codi_cmd::codi_prepare,
        commands::codi_cmd::codi_register_actions,
        commands::codi_cmd::codi_act_result,
        commands::codi_cmd::codi_act,
        commands::voice_cmd::voice_measure,
        commands::claude_cmd::default_spoken_summary_template,
        commands::meetings_cmd::meetings_cancel_install,
        commands::meetings_cmd::meetings_remove_voices,
        commands::meetings_cmd::meetings_set_cloud_key,
        commands::meetings_cmd::meetings_test_cloud,
        commands::meetings_cmd::meetings_bench,
        commands::meetings_cmd::meetings_system_audio_settings,
        commands::meetings_cmd::meetings_reveal_recordings,
        commands::meetings_cmd::meetings_start,
        commands::meetings_cmd::meetings_pause,
        commands::meetings_cmd::meetings_monitor,
        commands::meetings_cmd::meetings_set_mic_gain,
        commands::meetings_cmd::meetings_set_mic_muted,
        commands::meetings_cmd::meetings_stop,
        commands::meetings_cmd::meetings_discard,
        commands::meetings_cmd::meetings_delete,
        commands::meetings_cmd::meetings_delete_audio,
        commands::meetings_cmd::meetings_transcribe,
        commands::meetings_cmd::meetings_cancel_job,
        commands::meetings_cmd::meetings_reprocess,
        commands::meetings_cmd::meetings_import,
    ]
    shard_26 => [
        commands::meetings_cmd::meetings_for_note,
        commands::meetings_cmd::meetings_notes_with,
        commands::meetings_cmd::meetings_detail,
        commands::meetings_cmd::meetings_audio,
        commands::meetings_cmd::meetings_peaks,
        commands::meetings_cmd::meetings_export_audio,
        commands::meetings_cmd::meetings_update_line,
        commands::meetings_cmd::meetings_set_line_speaker,
        commands::meetings_cmd::meetings_rename_speaker,
        commands::meetings_cmd::meetings_merge_speakers,
        commands::meetings_cmd::meetings_add_speaker,
        commands::meetings_cmd::meetings_set_book_local_only,
        commands::meetings_cmd::meetings_voices,
        commands::meetings_cmd::meetings_save_voice,
        commands::meetings_cmd::meetings_rename_voice,
        commands::meetings_cmd::meetings_delete_voice,
        commands::meetings_cmd::meetings_recipes,
        commands::meetings_cmd::meetings_save_recipe,
        commands::meetings_cmd::meetings_delete_recipe,
        commands::meetings_cmd::meetings_ai,
        commands::localai_cmd::localai_delete_model,
        commands::localai_cmd::localai_stop_engine,
        commands::localai_cmd::localai_complete,
        commands::localai_cmd::localai_cancel_completion,
        commands::localexec_cmd::local_exec_state,
        commands::localexec_cmd::local_exec_probe,
        commands::localexec_cmd::local_exec_download_model,
        commands::localexec_cmd::local_exec_cancel_download,
        commands::localexec_cmd::local_exec_delete_model,
        commands::localexec_cmd::local_exec_stop_engine,
        commands::localexec_cmd::local_exec_set_key,
        commands::localexec_cmd::local_exec_ollama_pull,
        commands::localexec_cmd::local_exec_ollama_cancel_pull,
        commands::localexec_cmd::local_exec_ollama_delete,
        commands::evals_cmd::ai_eval_run,
        commands::evals_cmd::ai_eval_status,
        commands::evals_cmd::ai_eval_cancel,
        commands::evals_cmd::ai_eval_list,
        commands::evals_cmd::ai_eval_delete,
        commands::evals_cmd::ai_eval_compare,
        commands::evals_cmd::ai_model_registry_list,
        commands::evals_cmd::ai_tool_audit_list,
        commands::evals_cmd::ai_runtime_status,
        commands::experiences_cmd::ai_experience_record,
        commands::experiences_cmd::ai_experiences_list,
        commands::experiences_cmd::ai_experience_get,
        commands::experiences_cmd::ai_experiences_counts,
        commands::experiences_cmd::ai_experience_set_quality,
        commands::experiences_cmd::ai_experience_delete,
        commands::experiences_cmd::ai_experiences_clear,
        commands::experiences_cmd::ai_experiences_export,
        commands::experiences_cmd::ai_training_allowed,
        commands::experiences_cmd::ai_set_training_allowed,
        commands::knowledge_cmd::knowledge_overview,
        commands::knowledge_cmd::knowledge_add_folder,
        commands::knowledge_cmd::knowledge_update_folder,
        commands::knowledge_cmd::knowledge_remove_folder,
        commands::knowledge_cmd::knowledge_clear,
        commands::knowledge_cmd::knowledge_set_cloud,
        commands::knowledge_cmd::knowledge_set_embed_model,
        commands::knowledge_cmd::knowledge_reindex,
        commands::knowledge_cmd::knowledge_search,
        commands::refrepos_cmd::reference_repos_list,
        commands::refrepos_cmd::reference_repos_branches,
        commands::refrepos_cmd::reference_repo_add,
        commands::refrepos_cmd::reference_repo_update,
        commands::refrepos_cmd::reference_repo_pull,
        commands::refrepos_cmd::reference_repo_set_branch,
        commands::refrepos_cmd::reference_repo_reindex,
        commands::refrepos_cmd::reference_repo_remove,
        commands::refrepos_cmd::reference_repos_for_workspace,
        commands::knowledge_cmd::knowledge_download_model,
        commands::knowledge_cmd::knowledge_cancel_download,
        commands::knowledge_cmd::knowledge_delete_model,
        commands::learning_cmd::learning_overview,
        commands::learning_cmd::learning_serving,
        commands::learning_cmd::learning_adapter_names,
        commands::learning_cmd::learning_set_mode,
        commands::learning_cmd::learning_prepare_env,
        commands::learning_cmd::learning_build_dataset,
        commands::learning_cmd::learning_delete_dataset,
        commands::learning_cmd::learning_start_run,
        commands::learning_cmd::learning_resume_run,
        commands::learning_cmd::learning_cancel_run,
        commands::learning_cmd::learning_delete_run,
        commands::learning_cmd::learning_run_log,
        commands::learning_cmd::learning_evaluate,
        commands::learning_cmd::learning_cancel_evaluation,
        commands::learning_cmd::learning_publish,
        commands::learning_cmd::learning_rollback,
        commands::learning_cmd::learning_rename_adapter,
        commands::learning_cmd::learning_delete_adapter,
        commands::learning_cmd::learning_stop_serving,
        commands::memory_cmd::ai_memory_list,
        commands::memory_cmd::ai_memory_create,
        commands::memory_cmd::ai_memory_edit,
        commands::memory_cmd::ai_memory_set_status,
        commands::memory_cmd::ai_memory_delete,
        commands::memory_cmd::ai_memory_revisions,
        commands::memory_cmd::ai_memory_propose,
        commands::memory_cmd::ai_memory_review,
        commands::memory_cmd::ai_memory_confirm,
        commands::memory_cmd::ai_memory_settle_clash,
        commands::hybrid_cmd::create_hybrid_task,
        commands::hybrid_cmd::hybrid_triage,
        commands::hybrid_cmd::upsert_hybrid_template,
        commands::hybrid_cmd::hybrid_view,
        commands::hybrid_cmd::approve_hybrid_plan,
        commands::hybrid_cmd::hybrid_changed_paths,
    ]
    shard_27 => [
        commands::hybrid_cmd::hybrid_undo,
        commands::lsp_cmd::lsp_start,
        commands::lsp_cmd::lsp_stop_project,
        commands::lsp_cmd::lsp_request,
        commands::lsp_cmd::lsp_notify,
        commands::lsp_cmd::lsp_capabilities,
        commands::lsp_cmd::lsp_probe,
        commands::watcher_cmd::start_watching,
        commands::watcher_cmd::stop_watching,
        // ---- API client (global: no repo, workspace or project involved) ----
        commands::db_cmd::db_load_tree,
        commands::db_cmd::db_create_connection,
        commands::db_cmd::db_update_connection,
        commands::db_cmd::db_delete_connection,
        commands::db_cmd::db_duplicate_connection,
        commands::db_cmd::db_reorder_connections,
        commands::db_cmd::db_reorder_groups,
        commands::db_cmd::db_create_group,
        commands::db_cmd::db_rename_group,
        commands::db_cmd::db_delete_group,
        commands::db_cmd::db_set_connection_group,
        commands::db_cmd::db_set_connection_scope,
        commands::db_cmd::db_move_connection_to_workspace,
        commands::db_cmd::db_set_group_scope,
        commands::db_cmd::db_move_group_to_workspace,
        commands::db_cmd::db_set_password,
        commands::db_cmd::db_has_password,
        commands::db_cmd::db_create_console,
        commands::db_cmd::db_update_console,
        commands::db_cmd::db_delete_console,
        commands::db_cmd::db_list_history,
        commands::db_cmd::db_add_history,
        commands::db_cmd::db_delete_history,
        commands::db_cmd::db_clear_history,
        commands::db_cmd::db_connect,
        commands::db_cmd::db_disconnect,
        commands::db_cmd::db_connected,
        commands::db_cmd::db_children,
        commands::db_cmd::db_schema_catalog,
    ]
    shard_28 => [
        commands::db_cmd::db_execute,
        commands::db_cmd::db_explain,
        commands::db_cmd::db_table_data,
        commands::db_cmd::db_row_count,
        commands::db_cmd::db_apply_edits,
        commands::db_cmd::db_foreign_keys,
        commands::db_cmd::db_schema_objects,
        commands::db_cmd::db_schema_diagram,
        commands::db_cmd::db_object_ddl,
        commands::db_cmd::db_cancel,
        commands::db_cmd::db_statement_writes,
        commands::db_cmd::db_save_xlsx,
        commands::db_cmd::db_drivers_overview,
        commands::db_cmd::db_drivers_reveal,
        commands::db_cmd::db_driver_download,
        commands::db_cmd::db_driver_delete_files,
        commands::db_cmd::db_driver_delete_runtime,
        commands::db_cmd::db_driver_settings,
        commands::db_cmd::db_driver_save_settings,
        commands::db_cmd::db_driver_delete_settings,
        commands::db_cmd::db_ai_assist,
        commands::db_cmd::db_transaction_state,
        commands::db_cmd::db_export_rows,
        commands::db_cmd::db_csv_inspect,
        commands::db_cmd::db_import_csv,
        commands::db_cmd::db_backup_check,
        commands::db_cmd::db_backup_run,
        commands::db_cmd::db_restore_run,
        commands::db_cmd::db_backup_cancel,
        commands::ssh_cmd::ssh_scan_host_key,
        commands::ssh_cmd::ssh_trust_host_key,
        commands::api_cmd::api_load_tree,
        commands::api_cmd::api_create_collection,
        commands::api_cmd::api_update_collection,
        commands::api_cmd::api_delete_collection,
        commands::api_cmd::api_duplicate_collection,
        commands::api_cmd::api_set_collection_scope,
        commands::api_cmd::api_move_collection_to_workspace,
        commands::api_cmd::api_create_folder,
        commands::api_cmd::api_update_folder,
        commands::api_cmd::api_delete_folder,
        commands::api_cmd::api_create_request,
        commands::api_cmd::api_update_request,
        commands::api_cmd::api_delete_request,
        commands::api_cmd::api_duplicate_request,
        commands::api_cmd::api_move_node,
    ]
    shard_29 => [
        commands::api_cmd::api_reorder_collections,
        commands::api_cmd::api_list_environments,
        commands::api_cmd::api_create_environment,
        commands::api_cmd::api_update_environment,
        commands::api_cmd::api_delete_environment,
        commands::api_cmd::api_duplicate_environment,
        commands::api_cmd::api_list_history_meta,
        commands::api_cmd::api_get_history_snapshot,
        commands::api_cmd::api_add_history,
        commands::api_cmd::api_delete_history,
        commands::api_cmd::api_clear_history,
        commands::api_cmd::api_list_cookies,
        commands::api_cmd::api_upsert_cookie,
        commands::api_cmd::api_delete_cookie,
        commands::api_cmd::api_clear_cookies,
        commands::api_cmd::api_import_tree,
        commands::api_cmd::api_script_trust_lookup,
        commands::api_cmd::api_script_trust_record,
        commands::api_cmd::api_seal_stored_secrets,
        commands::api_cmd::api_load_open_tabs,
        commands::api_cmd::api_save_open_tabs,
        commands::api_cmd::api_load_settings,
        commands::api_cmd::api_save_settings,
        commands::api_cmd::api_send_http,
        commands::api_cmd::api_send_http_tracked,
        commands::api_cmd::api_cancel_http,
        commands::api_cmd::api_load_test,
        commands::api_cmd::api_load_stop,
        commands::api_cmd::api_scan_routes,
        commands::api_cmd::api_ai,
        commands::api_cmd::api_oauth_authorize,
        commands::api_cmd::api_read_file_base64,
        commands::api_cmd::api_ws_connect,
        commands::api_cmd::api_ws_send,
        commands::api_cmd::api_socketio_connect,
        commands::api_cmd::api_socketio_emit,
        commands::api_cmd::api_mqtt_connect,
        commands::api_cmd::api_mqtt_publish,
        commands::api_cmd::api_mqtt_subscribe,
        commands::api_cmd::api_mqtt_unsubscribe,
        commands::api_cmd::api_stream_disconnect,
        commands::api_cmd::api_grpc_describe,
        commands::api_cmd::api_grpc_call,
    ]
    shard_30 => [
        commands::api_cmd::api_pick_file,
        commands::api_cmd::api_save_file,
        commands::api_cmd::api_save_binary_file,
        commands::api_cmd::api_read_text_file,
        commands::api_cmd::api_read_collection_dir,
        commands::api_cmd::gdrive_status,
        commands::api_cmd::gdrive_set_client_secret,
        commands::api_cmd::gdrive_connect,
        commands::api_cmd::gdrive_disconnect,
        commands::api_cmd::supabase_install_sql,
        commands::api_cmd::supabase_set_anon_key,
        commands::api_cmd::supabase_has_key,
        commands::api_cmd::supabase_anon_key,
        commands::api_cmd::supabase_share_token,
        commands::api_cmd::supabase_check,
        commands::api_cmd::supabase_probe,
        commands::api_cmd::supabase_share,
        commands::api_cmd::supabase_rename_share,
        commands::api_cmd::supabase_join,
        commands::api_cmd::supabase_rotate,
        commands::api_cmd::supabase_leave,
        commands::api_cmd::supabase_watermark,
        commands::api_cmd::supabase_sync,
        commands::api_cmd::api_shared_collections,
        commands::api_cmd::api_backfill_share_projects,
        commands::api_cmd::api_sync_conflicts,
        commands::api_cmd::api_resolve_conflict,
        commands::architecture_cmd::architecture_ai,
        commands::architecture_cmd::architecture_generate,
        commands::architecture_cmd::architecture_scan_repo,
        commands::architecture_cmd::architecture_cloud_contexts,
        commands::architecture_cmd::architecture_cloud_scopes,
        commands::architecture_cmd::architecture_cloud_plan,
        commands::architecture_cmd::architecture_cloud_read,
    ]
}

#[cfg(test)]
mod invoke_handler_tests {
    #[test]
    fn every_command_has_exactly_one_route() {
        assert_eq!(super::invoke_routes().len(), super::INVOKE_COMMAND_COUNT);
        assert!(super::invoke_routes().contains_key("ts_start"));
        assert!(super::invoke_routes().contains_key("api_resolve_conflict"));
    }

    #[test]
    fn command_name_is_the_last_segment() {
        assert_eq!(super::command_name("commands :: git :: git_status"), "git_status");
        assert_eq!(super::command_name("npm::npm_search"), "npm_search");
    }
}
