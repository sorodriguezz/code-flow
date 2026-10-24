//! «Resumen de tu trabajo» from the Notas form — see `crate::worklog`.

use tauri::AppHandle;

use crate::worklog::render::Request;
use crate::worklog::run::{self, Outcome};

/// Collects the period's work and writes the summary. With `save`, keeps it as a note of
/// `workspace_id` — over `note_id` when it is a «Regenerar» of that note.
#[tauri::command]
pub async fn worklog_generate(
    app: AppHandle,
    request: Request,
    workspace_id: String,
    save: bool,
    note_id: Option<String>,
) -> Result<Outcome, String> {
    if save {
        run::generate_into_note(&app, request, &workspace_id, note_id.as_deref()).await
    } else {
        run::generate(&app, request).await
    }
}
