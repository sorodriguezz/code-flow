mod ado;
mod ai;
mod api;
mod appmenu;
mod ai_runs;
mod claude;
mod commands;
mod dap;
mod db;
mod debugger;
mod fsops;
mod codex;
mod gemini;
mod git;
mod github;
mod ollama;
mod openai;
mod opencode;
mod paths;
mod pr_link;
mod remote;
mod review_memory;
mod search;
mod secret_scan;
mod secrets;
mod terminal;
mod tray;
mod watcher;

use tauri::Manager;
use api::ApiRegistry;
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

#[cfg(not(target_os = "macos"))]
fn hide_to_background(window: &tauri::Window) {
    let _ = window.hide();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must happen before `db::init()` opens the SQLite connection below — see
    // `paths::reset_marker_path`'s doc comment for why the delete can't happen live.
    if paths::reset_marker_path().exists() {
        let _ = std::fs::remove_dir_all(paths::base_dir());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(db::init().expect("failed to initialize CodeFlow database"))
        .manage(TerminalRegistry::default())
        .manage(ApiRegistry::default())
        .manage(WatcherRegistry::default())
        .manage(tray::QuittingFlag::default())
        .setup(|app| {
            tray::setup(&app.handle())?;
            appmenu::setup(&app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // The custom title bar's close button and the OS's own close paths (Alt+F4, the
            // red traffic light, right-click "Close window" on the taskbar) all raise this
            // same event — hiding instead of exiting is what keeps background jobs (Claude
            // reviews, terminals) alive while the window is "closed", Docker Desktop–style.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !app.state::<tray::QuittingFlag>().is_quitting() {
                    api.prevent_close();
                    hide_to_background(window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_cmd::quit_app,
            commands::app_cmd::reset_app_data,
            commands::repos::pick_folder,
            commands::repos::default_clone_dir,
            commands::repos::create_workspace,
            commands::repos::list_workspaces,
            commands::repos::delete_workspace,
            commands::repos::update_workspace_color,
            commands::repos::update_project_color,
            commands::repos::create_project,
            commands::repos::list_projects,
            commands::repos::get_project,
            commands::repos::delete_project,
            commands::repos::move_project_to_workspace,
            commands::git_ops::get_status,
            commands::git_ops::list_commits,
            commands::git_ops::list_unpushed_commits,
            commands::git_ops::list_branches,
            commands::git_ops::create_branch,
            commands::git_ops::delete_branch,
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
            commands::git_ops::get_commit_diff,
            commands::git_ops::stage_file,
            commands::git_ops::stage_all,
            commands::git_ops::unstage_file,
            commands::git_ops::unstage_all,
            commands::git_ops::discard_file_changes,
            commands::git_ops::discard_all_changes,
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
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_workspace_prompt,
            commands::settings::set_workspace_prompt,
            commands::settings::default_workspace_prompt,
            commands::settings::list_workspace_agents,
            commands::settings::upsert_workspace_agent,
            commands::settings::delete_workspace_agent,
            commands::settings::list_review_runs,
            commands::settings::get_review_run,
            commands::settings::mark_review_finding,
            commands::settings::delete_review_run,
            commands::settings::delete_review_runs_for_pr,
            commands::settings::purge_workspace_review_runs,
            commands::settings::export_review_runs,
            commands::settings::list_review_contexts,
            commands::settings::upsert_review_context,
            commands::settings::delete_review_context,
            commands::settings::list_workspace_mcps,
            commands::settings::upsert_workspace_mcp,
            commands::settings::delete_workspace_mcp,
            commands::skills_cmd::install_workspace_skill,
            commands::skills_cmd::list_workspace_skills,
            commands::skills_cmd::remove_workspace_skill,
            commands::skills_cmd::set_workspace_skill_enabled,
            commands::skills_cmd::create_custom_skill,
            commands::skills_cmd::import_skill_from_folder,
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
            commands::secrets_cmd::set_ai_api_key,
            commands::secrets_cmd::has_ai_api_key,
            commands::secrets_cmd::delete_ai_api_key,
            commands::claude_cmd::generate_commit_message,
            commands::claude_cmd::list_ai_models,
            commands::claude_cmd::check_ai_provider,
            commands::ado_cmd::open_external_url,
            commands::claude_cmd::default_commit_template,
            commands::claude_cmd::default_review_template,
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
            commands::checkpoint_cmd::restore_ai_checkpoint,
            commands::checkpoint_cmd::delete_ai_checkpoint,
            commands::ado_cmd::ado_list_projects,
            commands::ado_cmd::ado_list_repos,
            commands::ado_cmd::auto_link_project,
            commands::ado_cmd::link_project_ado,
            commands::ado_cmd::unlink_project,
            commands::ado_cmd::open_repo_in_browser,
            commands::ado_cmd::list_pull_requests,
            commands::ado_cmd::resolve_pr_link,
            commands::ado_cmd::review_pr_from_link,
            commands::ado_cmd::post_pr_link_review_comment,
            commands::ado_cmd::generate_pr_description,
            commands::ado_cmd::create_pull_request,
            commands::ado_cmd::list_pr_comment_threads,
            commands::ado_cmd::review_pull_request,
            commands::ado_cmd::post_pr_review_comment,
            commands::ado_cmd::act_on_pull_request,
            commands::ado_cmd::pr_review_decision,
            commands::github_cmd::link_project_github,
            commands::github_cmd::github_authenticated_user,
            commands::fs_cmd::list_dir,
            commands::fs_cmd::list_repo_files,
            commands::fs_cmd::search_repo,
            commands::fs_cmd::replace_in_repo,
            commands::fs_cmd::read_file_text,
            commands::fs_cmd::write_file_text,
            commands::fs_cmd::write_file_bytes,
            commands::fs_cmd::move_path,
            commands::fs_cmd::create_dir,
            commands::fs_cmd::create_file,
            commands::fs_cmd::open_in_default_app,
            commands::fs_cmd::reveal_in_file_manager,
            commands::fs_cmd::open_in_vscode,
            commands::activity_cmd::list_chat_conversations,
            commands::activity_cmd::get_chat_conversation,
            commands::activity_cmd::delete_chat_conversation,
            commands::activity_cmd::rename_chat_conversation,
            commands::activity_cmd::list_job_history,
            commands::activity_cmd::rename_job_history_entry,
            commands::activity_cmd::delete_job_history_entry,
            commands::terminal_cmd::open_terminal,
            commands::terminal_cmd::write_terminal,
            commands::terminal_cmd::resize_terminal,
            commands::terminal_cmd::close_terminal,
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
            commands::watcher_cmd::start_watching,
            commands::watcher_cmd::stop_watching,
            // ---- API client (global: no repo, workspace or project involved) ----
            commands::api_cmd::api_load_tree,
            commands::api_cmd::api_create_collection,
            commands::api_cmd::api_update_collection,
            commands::api_cmd::api_delete_collection,
            commands::api_cmd::api_duplicate_collection,
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
            commands::api_cmd::api_read_text_file,
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
        });
}
