use tauri::State;

use crate::claude;
use crate::db::{queries, Db};

#[tauri::command]
pub async fn generate_commit_message(db: State<'_, Db>, diff: String) -> Result<String, String> {
    let (binary, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let binary = queries::get_setting(&conn, "claude_binary_path").map_err(|e| e.to_string())?;
        let template = queries::get_setting(&conn, "claude_commit_template").map_err(|e| e.to_string())?;
        (binary, template)
    };
    let binary = binary.unwrap_or_else(|| "claude".to_string());
    let template = template.unwrap_or_default();
    claude::generate_commit_message(&binary, &diff, &template).await
}

#[tauri::command]
pub fn default_commit_template() -> String {
    claude::DEFAULT_COMMIT_TEMPLATE.to_string()
}
