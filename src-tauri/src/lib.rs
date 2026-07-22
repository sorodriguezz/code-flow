mod ado;
mod claude;
mod commands;
mod db;
mod fsops;
mod git;
mod paths;
mod remote;
mod secrets;
mod terminal;
mod watcher;

use terminal::TerminalRegistry;
use watcher::WatcherRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(db::init().expect("failed to initialize CodeFlow database"))
        .manage(TerminalRegistry::default())
        .manage(WatcherRegistry::default())
        .invoke_handler(tauri::generate_handler![
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
            commands::git_ops::get_working_diff,
            commands::git_ops::get_staged_diff,
            commands::git_ops::get_commit_diff,
            commands::git_ops::stage_file,
            commands::git_ops::stage_all,
            commands::git_ops::unstage_file,
            commands::git_ops::unstage_all,
            commands::git_ops::discard_file_changes,
            commands::git_ops::commit,
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
            commands::settings::list_review_contexts,
            commands::settings::upsert_review_context,
            commands::settings::delete_review_context,
            commands::settings::list_workspace_md_files,
            commands::settings::upsert_workspace_md_file,
            commands::settings::delete_workspace_md_file,
            commands::settings::list_workspace_mcps,
            commands::settings::upsert_workspace_mcp,
            commands::settings::delete_workspace_mcp,
            commands::skills_cmd::install_workspace_skill,
            commands::skills_cmd::list_workspace_skills,
            commands::skills_cmd::remove_workspace_skill,
            commands::secrets_cmd::set_ado_pat,
            commands::secrets_cmd::get_ado_pat,
            commands::secrets_cmd::delete_ado_pat,
            commands::claude_cmd::generate_commit_message,
            commands::claude_cmd::default_commit_template,
            commands::claude_cmd::default_review_template,
            commands::ado_cmd::ado_list_projects,
            commands::ado_cmd::ado_list_repos,
            commands::ado_cmd::auto_link_project_ado,
            commands::ado_cmd::link_project_ado,
            commands::ado_cmd::unlink_project_ado,
            commands::ado_cmd::list_pull_requests,
            commands::ado_cmd::review_pull_request,
            commands::ado_cmd::post_pr_review_comment,
            commands::fs_cmd::list_dir,
            commands::fs_cmd::read_file_text,
            commands::fs_cmd::write_file_text,
            commands::fs_cmd::open_in_default_app,
            commands::fs_cmd::reveal_in_file_manager,
            commands::terminal_cmd::open_terminal,
            commands::terminal_cmd::write_terminal,
            commands::terminal_cmd::resize_terminal,
            commands::terminal_cmd::close_terminal,
            commands::watcher_cmd::start_watching,
            commands::watcher_cmd::stop_watching,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
