use crate::fsops;

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

#[tauri::command]
pub fn open_in_default_app(repo_path: String, rel_path: String) -> Result<(), String> {
    fsops::open_in_default_app(&repo_path, &rel_path)
}

#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    fsops::reveal_in_file_manager(&path)
}
