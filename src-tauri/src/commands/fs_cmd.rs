use crate::fsops;
use crate::search;

#[tauri::command]
pub fn list_dir(repo_path: String, sub_path: Option<String>) -> Result<Vec<fsops::FileEntry>, String> {
    fsops::list_dir(&repo_path, sub_path)
}

#[tauri::command]
pub fn read_file_text(repo_path: String, rel_path: String) -> Result<String, String> {
    fsops::read_file_text(&repo_path, &rel_path)
}

#[tauri::command]
pub fn write_file_text(repo_path: String, rel_path: String, content: String) -> Result<(), String> {
    fsops::write_file_text(&repo_path, &rel_path, &content)
}

/// Saves an exported binary (today: a code snapshot PNG) to the absolute path the user picked in
/// the native save dialog.
#[tauri::command]
pub fn write_file_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    fsops::write_file_bytes(&path, &contents)
}

/// Moves a file or folder into `dest_dir` (repo-relative, `""` for the root) — the explorer's
/// drag-and-drop. Returns the new repo-relative path.
#[tauri::command]
pub fn move_path(repo_path: String, from_rel: String, dest_dir: String) -> Result<String, String> {
    fsops::move_path(&repo_path, &from_rel, &dest_dir)
}

/// Copies files and folders dropped in from Finder/Explorer into the project — the editor's
/// external drop. `dest_dir` is repo-relative (`""` for the root); `sources` are the absolute
/// paths the platform handed over with the drag. Returns what landed and what was left alone.
#[tauri::command]
pub fn copy_into_repo(
    repo_path: String,
    dest_dir: String,
    sources: Vec<String>,
) -> Result<fsops::ImportOutcome, String> {
    fsops::copy_into(&repo_path, &dest_dir, &sources)
}

#[tauri::command]
pub fn create_dir(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::create_dir(&repo_path, &rel_path)
}

#[tauri::command]
pub fn create_file(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::create_file(&repo_path, &rel_path)
}

/// Renames a file or folder in place — the explorer's context menu and F2. Returns the new
/// repo-relative path so the editor can re-point any tab that was showing it.
#[tauri::command]
pub fn rename_path(repo_path: String, from_rel: String, new_name: String) -> Result<String, String> {
    fsops::rename_path(&repo_path, &from_rel, &new_name)
}

/// Sends a file or folder to the OS trash.
#[tauri::command]
pub fn delete_path(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::delete_path(&repo_path, &rel_path)
}

#[tauri::command]
pub fn open_in_default_app(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::open_in_default_app(&repo_path, &rel_path)
}

#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    fsops::reveal_in_file_manager(&path)
}

#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    fsops::open_in_vscode(&path)
}

/// Every non-ignored file in the repo — what "go to file" filters over. Listed once per open
/// rather than streamed: even a large repo is a few thousand short strings, and filtering in the
/// frontend keeps typing instant.
#[tauri::command]
pub fn list_repo_files(repo_path: String) -> Result<Vec<String>, String> {
    search::list_files(&repo_path)
}

/// Content search across the repo's text files, with the toggles the find box exposes.
#[tauri::command]
pub fn search_repo(
    repo_path: String,
    query: String,
    options: search::SearchOptions,
    max_results: usize,
) -> Result<search::SearchOutcome, String> {
    search::search(&repo_path, &query, &options, max_results)
}

/// Rewrites every match across the repo — or within one file when `only_path` is given. Returns
/// what it touched, plus the checkpoint taken beforehand so the whole thing can be undone.
#[tauri::command]
pub fn replace_in_repo(
    repo_path: String,
    query: String,
    replacement: String,
    options: search::SearchOptions,
    only_path: Option<String>,
) -> Result<search::ReplaceOutcome, String> {
    search::replace_all(&repo_path, &query, &replacement, &options, only_path.as_deref())
}
