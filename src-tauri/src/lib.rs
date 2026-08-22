mod ado;
mod ai;
mod applog;
mod api;
mod appmenu;
mod ai_locks;
mod ai_quota;
mod ai_runs;
mod ai_usage;
mod backup;
mod chain_memory;
mod ci;
mod boards;
mod claude;
mod cline;
mod commands;
mod dap;
mod datasource;
mod db;
mod debugger;
mod fsops;
mod codex;
mod gdrive;
mod gemini;
mod git;
mod grok;
mod github;
mod gitlab;
mod npm;
mod lsp;
mod migrate;
mod oauth;
mod onedrive;
mod opencode;
mod paths;
mod power;
mod pr_link;
mod proc;
mod remote;
/// Driving this install from a phone on the same network. Off unless the user turns it on.
mod remotectl;
mod remotes;
mod repo_identity;
mod requirements;
mod reset;
mod review;
mod review_memory;
mod search;
mod secret_scan;
mod secrets;
mod shell_env;
mod shell_profiles;
/// AWS request signing, shared by the API client and the Remote workspace's S3 transport.
mod sigv4;
mod supabase;
mod sysload;
mod keyvault;
mod terminal;
mod tsserver;
mod tray;
mod watcher;
mod window_state;

use tauri::Manager;
use api::ApiRegistry;
use datasource::DbRegistry;
use terminal::TerminalRegistry;
use watcher::WatcherRegistry;

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
pub fn run() {
    // First, before anything that can fail. Everything from here to the window appearing runs with
    // no way to report itself — no console on Windows, no window anywhere — and two of the steps
    // below now move the user's database between directories. See `applog`, which until v1.19 did
    // not exist: `logs/` was created on every launch and had no writer at all.
    applog::init();

    // Then the reset, if one was requested on the previous launch. Must happen before `db::init()`
    // opens the SQLite connection below — see `paths::reset_marker_path`'s doc comment for why the
    // delete can't happen live.
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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The startup layout verdict, decided above and read by `app_paths`. Managed rather
        // than recomputed, because "did this launch migrate" is a fact about *this* launch and
        // asking again later would answer about a different one.
        .manage(layout_status.clone())
        // The state root, unless the migration said it cannot vouch for it.
        //
        // `db::init()` used to run here unconditionally, and that made the whole recovery design
        // unreachable: a copy that failed part-way leaves a truncated `codeflow.db`, opening it
        // returns `SQLITE_CORRUPT` from the schema parse, and the `.expect()` panics *before*
        // `.setup()` — so no window, no notice, no Retry button, on that launch and every one
        // after it. A copy that failed before writing anything is worse in a quieter way: an empty
        // database appears in the new root and the app comes up looking fresh and working.
        //
        // Both are answered by not putting a connection on that file at all until the layout is
        // one this build is willing to write to. See `db::init_scratch`.
        .manage(if layout_status.ok {
            db::init().expect("failed to initialize CodeFlow database")
        } else {
            db::init_scratch().expect("failed to initialize a scratch database")
        })
        .manage(TerminalRegistry::default())
        .manage(ApiRegistry::default())
        .manage(DbRegistry::default())
        // The keyring's unlocked data key. Managed state rather than a value passed around, so
        // there is exactly one place it exists — see `keyvault::session`.
        .manage(keyvault::session::VaultSession::default())
        .manage(WatcherRegistry::default())
        .manage(tray::QuittingFlag::default())
        .manage(window_state::WindowTracker::default())
        .manage(remotectl::RemoteCtl::default())
        .setup(|app| {
            // First, and before anything that can fail out of this closure: the window is created
            // hidden (`"visible": false` in `tauri.conf.json`) so that being resized and maximized
            // back to where the last session left it does not happen in front of the user, and
            // this is what ends that — a `?` above it would leave the app running with no window.
            window_state::restore(app.handle());
            tray::setup(&app.handle())?;
            // The usage meter's way to the database. Set here because `setup` is the only place
            // with an `AppHandle`, and the recording point is deep inside `ai::run`, where threading
            // one down would mean an extra argument on every operation in `ai.rs`.
            ai_usage::attach(app.handle().clone());
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

            // The custom title bar's close button and the OS's own close paths (Alt+F4, the
            // red traffic light, right-click "Close window" on the taskbar) all raise this
            // same event — hiding instead of exiting is what keeps background jobs (Claude
            // reviews, terminals) alive while the window is "closed", Docker Desktop–style.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                // Written down here as well as on the way out, because these two ends of the app
                // are further apart than they look: closing the window leaves it running in the
                // background for hours, and whatever ends that session — a real quit, a reboot, a
                // process killed from the task manager — may never reach the exit handler. The
                // size the user last had is banked at the moment they last had it.
                window_state::save(app);
                if !app.state::<tray::QuittingFlag>().is_quitting() {
                    api.prevent_close();
                    // Said out loud before hiding. The webview keeps running, which is the whole
                    // point of hiding rather than exiting — but it also means anything that
                    // *dispatches* work on its own would keep launching engines with no window to
                    // show them in and no button to stop them with. An agent chain parks on this.
                    let _ = tauri::Emitter::emit(app, "app:background", ());
                    // Database sessions are not background work — they are a connection held open on
                    // somebody's server for a workspace that is now off screen. The ones nobody is
                    // using go back; a query still in flight holds its session and is left alone, and
                    // anything closed here reopens by itself on the next call, so being wrong costs
                    // one connect. Without this, closing the window looks like quitting and holds
                    // every session anyway, which is the worst of both.
                    app.state::<DbRegistry>().close_idle();
                    hide_to_background(window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            tsserver::ts_start,
            tsserver::ts_request,
            tsserver::ts_notify,
            tsserver::ts_status,
            tsserver::ts_stop,
            npm::npm_package_versions,
            npm::npm_latest_versions,
            npm::npm_search,
            npm::npm_package_sizes,
            commands::app_cmd::quit_app,
            commands::app_cmd::check_requirements,
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
            commands::backup_cmd::onedrive_disconnect,
            commands::backup_cmd::backup_set_passphrase,
            commands::backup_cmd::backup_clear_passphrase,
            commands::backup_cmd::backup_passphrase_matches,
            commands::backup_cmd::backup_export_to_file,
            commands::backup_cmd::backup_run_now,
            commands::backup_cmd::backup_pick_and_inspect,
            commands::backup_cmd::backup_inspect_configured,
            commands::backup_cmd::backup_list_at_destination,
            commands::backup_cmd::backup_inspect_drive,
            commands::backup_cmd::backup_inspect_onedrive,
            commands::backup_cmd::backup_restore_file,
            commands::backup_cmd::backup_restore_drive,
            commands::backup_cmd::backup_restore_onedrive,
            commands::backup_cmd::backup_pick_folder,
            commands::backup_cmd::backup_reveal_folder,
            commands::repos::pick_folder,
            commands::repos::scan_folder,
            commands::repos::find_duplicate_projects,
            commands::repos::default_clone_dir,
            commands::repos::create_workspace,
            commands::repos::list_workspaces,
            commands::repos::reorder_workspaces,
            commands::repos::delete_workspace,
            commands::repos::update_workspace_color,
            commands::repos::rename_workspace,
            commands::repos::update_project_color,
            commands::repos::create_project,
            commands::repos::list_projects,
            commands::repos::reorder_projects,
            commands::repos::get_project,
            commands::repos::delete_project,
            commands::repos::move_project_to_workspace,
            commands::git_ops::get_status,
            commands::git_ops::list_commits,
            commands::git_ops::list_unpushed_commits,
            commands::git_ops::list_branches,
            commands::git_ops::create_branch,
            commands::git_ops::delete_branch,
            commands::git_ops::set_branch_locked,
            commands::git_ops::checkout_local_branch,
            commands::git_ops::checkout_detached,
            commands::git_ops::checkout_remote_tracking,
            commands::git_ops::reset_to_commit,
            commands::git_ops::list_stashes,
            commands::git_ops::stash_save,
            commands::git_ops::stash_apply,
            commands::git_ops::stash_pop,
            commands::git_ops::stash_drop,
            commands::git_ops::rename_stash,
            commands::git_ops::get_working_diff,
            commands::git_ops::get_staged_diff,
            commands::git_ops::get_file_diff,
            commands::git_ops::get_commit_diff,
            commands::git_ops::get_commit_file_diff,
            commands::git_ops::get_file_blame,
            commands::git_ops::stage_file,
            commands::git_ops::stage_all,
            commands::git_ops::unstage_file,
            commands::git_ops::unstage_all,
            commands::git_ops::discard_file_changes,
            commands::git_ops::discard_all_changes,
            commands::git_ops::stage_hunk,
            commands::git_ops::unstage_hunk,
            commands::git_ops::discard_hunk,
            commands::git_ops::commit,
            commands::secret_scan_cmd::scan_staged_secrets,
            commands::git_ops::list_remotes,
            commands::git_ops::set_remote_url,
            commands::git_ops::get_git_identity,
            commands::git_ops::set_git_identity,
            commands::git_ops::merge_branch,
            commands::git_ops::is_merging,
            commands::git_ops::list_conflicts,
            commands::git_ops::resolve_conflict_side,
            commands::git_ops::mark_conflict_resolved,
            commands::git_ops::complete_merge,
            commands::git_ops::abort_merge,
            commands::git_ops::git_clone,
            commands::git_ops::git_fetch,
            commands::git_ops::git_pull,
            commands::git_ops::git_push,
            commands::remotectl_cmd::remotectl_status,
            commands::remotectl_cmd::remotectl_set_enabled,
            commands::remotectl_cmd::remotectl_set_port,
            commands::remotectl_cmd::remotectl_set_allow_terminal,
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
            commands::app_cmd::system_load,
            commands::agents_cmd::set_chain_step_input,
            commands::agents_cmd::set_chain_step_skipped,
            commands::agents_cmd::claim_next_chain_step,
            commands::agents_cmd::complete_chain_step,
            commands::agents_cmd::approve_chain_gate,
            commands::agents_cmd::skip_chain_step,
            commands::agents_cmd::retry_chain_step,
            commands::agents_cmd::resume_chain,
            commands::agents_cmd::abort_chain,
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
            commands::agents_cmd::reorder_agent_projects,
            commands::agents_cmd::set_agent_task_group,
            commands::agents_cmd::set_agent_task_pinned,
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
            commands::skills_cmd::list_workspace_skills,
            commands::skills_cmd::remove_workspace_skill,
            commands::skills_cmd::set_workspace_skill_enabled,
            commands::skills_cmd::create_custom_skill,
            commands::skills_cmd::import_skill_from_folder,
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
            commands::secrets_cmd::get_jira_token,
            commands::secrets_cmd::delete_jira_token,
            commands::secrets_cmd::set_monday_token,
            commands::secrets_cmd::get_monday_token,
            commands::secrets_cmd::delete_monday_token,
            commands::claude_cmd::generate_commit_message,
            commands::claude_cmd::draft_pr_comment_reply,
            commands::claude_cmd::list_ai_models,
            commands::claude_cmd::check_ai_provider,
            commands::ado_cmd::open_external_url,
            commands::claude_cmd::default_commit_template,
            commands::claude_cmd::default_analyze_template,
            commands::claude_cmd::default_pr_description_template,
            commands::claude_cmd::default_resolve_conflict_template,
            commands::claude_cmd::analyze_working_changes,
            commands::claude_cmd::resolve_conflict_with_ai,
            commands::claude_cmd::resolve_finding_with_ai,
            commands::claude_cmd::send_chat_message,
            commands::claude_cmd::cancel_ai_run,
            commands::claude_cmd::inline_edit_with_ai,
            commands::checkpoint_cmd::list_ai_checkpoints,
            commands::checkpoint_cmd::ai_checkpoint_changed_paths,
            commands::checkpoint_cmd::restore_ai_checkpoint,
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
            commands::ci_cmd::analyze_pipeline_failure,
            commands::ado_cmd::resolve_pr_link,
            commands::ado_cmd::review_pr_from_link,
            commands::ado_cmd::post_pr_link_review_comment,
            commands::ado_cmd::pr_link_pull_request,
            commands::ado_cmd::pr_link_comment_threads,
            commands::ado_cmd::pr_link_resolve_comment_thread,
            commands::ado_cmd::pr_link_decision,
            commands::ado_cmd::act_on_pr_link,
            commands::ado_cmd::generate_pr_description,
            commands::ado_cmd::create_pull_request,
            commands::ado_cmd::list_pr_comment_threads,
            commands::ado_cmd::resolve_pr_comment_thread,
            commands::ado_cmd::discard_pr_finding,
            commands::ado_cmd::review_pull_request,
            commands::ado_cmd::post_pr_review_comment,
            commands::ado_cmd::act_on_pull_request,
            commands::ado_cmd::pr_review_decision,
            // ---- user stories (workspace-scoped: wiki in, Azure Boards out) ----
            commands::stories_cmd::ado_list_wikis,
            commands::stories_cmd::ado_list_wiki_pages,
            commands::stories_cmd::ado_wiki_pages_content,
            commands::stories_cmd::ado_wiki_page_detail,
            commands::stories_cmd::ado_publish_wiki_page,
            commands::stories_cmd::list_doc_pages,
            commands::stories_cmd::get_doc_page,
            commands::stories_cmd::create_doc_page,
            commands::stories_cmd::import_wiki_page,
            commands::stories_cmd::set_doc_page_content,
            commands::stories_cmd::set_doc_page_title,
            commands::stories_cmd::set_doc_page_target,
            commands::stories_cmd::delete_doc_page,
            commands::stories_cmd::publish_doc_page,
            commands::stories_cmd::generate_doc_page,
            commands::stories_cmd::board_list_item_types,
            commands::stories_cmd::jira_list_projects,
            commands::stories_cmd::monday_whoami,
            commands::stories_cmd::monday_list_boards,
            commands::stories_cmd::monday_board_schema,
            commands::stories_cmd::ado_list_classification_nodes,
            commands::stories_cmd::board_parse_item_ref,
            commands::stories_cmd::board_get_work_item,
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
            commands::github_cmd::link_project_github,
            commands::github_cmd::github_authenticated_user,
            commands::gitlab_cmd::link_project_gitlab,
            commands::gitlab_cmd::gitlab_authenticated_user,
            commands::fs_cmd::list_dir,
            commands::fs_cmd::list_repo_files,
            commands::fs_cmd::search_repo,
            commands::fs_cmd::replace_in_repo,
            commands::fs_cmd::read_file_text,
            commands::fs_cmd::write_file_text,
            commands::fs_cmd::write_file_bytes,
            commands::fs_cmd::move_path,
            commands::fs_cmd::copy_into_repo,
            commands::fs_cmd::create_dir,
            commands::fs_cmd::create_file,
            commands::fs_cmd::rename_path,
            commands::fs_cmd::delete_path,
            commands::fs_cmd::open_in_default_app,
            commands::fs_cmd::reveal_in_file_manager,
            commands::fs_cmd::open_in_vscode,
            commands::activity_cmd::list_chat_conversations,
            commands::activity_cmd::get_chat_conversation,
            commands::activity_cmd::get_turn_trace,
            commands::activity_cmd::get_job_result,
            commands::activity_cmd::delete_chat_conversation,
            commands::activity_cmd::rename_chat_conversation,
            commands::activity_cmd::list_job_history,
            commands::activity_cmd::rename_job_history_entry,
            commands::activity_cmd::delete_job_history_entry,
            commands::activity_cmd::list_workspace_activity,
            commands::activity_cmd::rename_workspace_activity_entry,
            commands::activity_cmd::delete_workspace_activity_entry,
            commands::terminal_cmd::list_shell_profiles,
            commands::terminal_cmd::open_terminal,
            commands::terminal_cmd::write_terminal,
            commands::terminal_cmd::resize_terminal,
            commands::terminal_cmd::close_terminal,
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
            commands::remote_cmd::remote_open_session,
            commands::remote_cmd::remote_open_draft_session,
            commands::remote_cmd::remote_open_forward,
            commands::remote_cmd::remote_close_forward,
            commands::remote_cmd::remote_close_host_forwards,
            commands::remote_cmd::remote_list_forwards,
            commands::remote_cmd::remote_open_screen,
            commands::remote_cmd::remote_close_screen,
            commands::remote_cmd::remote_host_holds,
            commands::remote_cmd::remote_disconnect_host,
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
            commands::remote_cmd::remote_ssh_config_path,
            commands::remote_cmd::remote_scan_ssh_config,
            commands::remote_cmd::remote_import_ssh_config,
            commands::remote_cmd::remote_create_snippet,
            commands::remote_cmd::remote_update_snippet,
            commands::remote_cmd::remote_delete_snippet,
            // ---- Notes (workspace-scoped, like Remote above it) ----
            // ---- The keyring ("Llavero"). Global — no workspace scoping on the vault itself. ----
            commands::keyvault_cmd::keyvault_status,
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
            commands::keyvault_cmd::keyvault_save_blob,
            commands::keyvault_cmd::keyvault_delete_blob,
            commands::keyvault_cmd::keyvault_generate_password,
            commands::keyvault_cmd::keyvault_totp_code,
            commands::keyvault_cmd::keyvault_audit,
            commands::keyvault_cmd::keyvault_read_import_file,
            commands::notes_cmd::notes_load_tree,
            commands::notes_cmd::notes_get_note,
            commands::notes_cmd::notes_create_note,
            commands::notes_cmd::notes_save_note,
            commands::notes_cmd::notes_move_note,
            commands::notes_cmd::notes_reorder_notes,
            commands::notes_cmd::notes_set_pinned,
            commands::notes_cmd::notes_delete_note,
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
            commands::notes_cmd::notes_write_with_ai,
            commands::notes_cmd::notes_set_book_scope,
            commands::notes_cmd::notes_move_book_to_workspace,
            // ---- Diagrams (workspace-scoped, like Notes above it) ----
            commands::diagrams_cmd::diagrams_load_tree,
            commands::diagrams_cmd::diagrams_get_diagram,
            commands::diagrams_cmd::diagrams_load_thumbnails,
            commands::diagrams_cmd::diagrams_create_diagram,
            commands::diagrams_cmd::diagrams_save_diagram,
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
            commands::diagrams_cmd::diagrams_read_drawio,
            commands::debug_cmd::debug_start,
            commands::debug_cmd::debug_start_adapter,
            commands::debug_cmd::debug_stop,
            commands::debug_cmd::debug_continue,
            commands::debug_cmd::debug_pause,
            commands::debug_cmd::debug_step,
            commands::debug_cmd::debug_set_breakpoints,
            commands::debug_cmd::debug_properties,
            commands::debug_cmd::debug_evaluate,
            commands::debug_cmd::debug_is_running,
            commands::lsp_cmd::lsp_start,
            commands::lsp_cmd::lsp_stop,
            commands::lsp_cmd::lsp_stop_project,
            commands::lsp_cmd::lsp_request,
            commands::lsp_cmd::lsp_notify,
            commands::lsp_cmd::lsp_running,
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
            commands::db_cmd::db_ai_assist,
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
            commands::api_cmd::api_reorder_collections,
            commands::api_cmd::api_list_environments,
            commands::api_cmd::api_create_environment,
            commands::api_cmd::api_update_environment,
            commands::api_cmd::api_delete_environment,
            commands::api_cmd::api_duplicate_environment,
            commands::api_cmd::api_list_history,
            commands::api_cmd::api_list_history_meta,
            commands::api_cmd::api_get_history_snapshot,
            commands::api_cmd::api_add_history,
            commands::api_cmd::api_delete_history,
            commands::api_cmd::api_clear_history,
            commands::api_cmd::api_list_cookies,
            commands::api_cmd::api_upsert_cookie,
            commands::api_cmd::api_delete_cookie,
            commands::api_cmd::api_clear_cookies,
            commands::api_cmd::api_send_http,
            commands::api_cmd::api_send_http_tracked,
            commands::api_cmd::api_cancel_http,
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
            commands::api_cmd::api_pick_file,
            commands::api_cmd::api_save_file,
            commands::api_cmd::api_save_binary_file,
            commands::api_cmd::api_read_text_file,
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
        ])
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
            if let tauri::RunEvent::Exit = _event {
                // The quit paths that never touch the close handler: the tray's Quit, ⌘Q, the
                // in-app quit. All three end in `AppHandle::exit`, which is here.
                window_state::save(_app_handle);
                // The last four seconds of every bench terminal's output, which the flusher's timer
                // has not come round for. The shells themselves die with the process — that is what
                // a pty is — so this is the whole of what "don't lose my work" can mean here, and
                // it is the moment it has to happen.
                commands::terminal_cmd::flush_transcripts(_app_handle);
                let registry = _app_handle.state::<DbRegistry>();
                tauri::async_runtime::block_on(registry.close_all());
                // The Remote workspace's own `static` maps, for the reason the comment above gives:
                // `forward`'s registry and the two file-session maps hold children that
                // `process::exit` walks straight past. Without this every quit leaves an `ssh -N`
                // holding a forwarded port, and an `ssh -s … sftp` holding a channel on somebody
                // else's machine, both reparented to init.
                tauri::async_runtime::block_on(remotes::hold::release_all());
                // And every language server, for exactly the reason above: each is a separate
                // process holding an index of the repository, and a reparented `rust-analyzer`
                // keeps several hundred megabytes that nothing is left to reap.
                tauri::async_runtime::block_on(lsp::stop_all());
            }
        });
}
