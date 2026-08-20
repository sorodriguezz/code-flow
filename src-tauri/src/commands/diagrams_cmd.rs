//! The Diagrams workspace's command surface.
//!
//! Thin, like [`super::notes_cmd`]: every call locks the connection, forwards to
//! [`crate::db::diagram_queries`] and maps the error. There is no diagram logic here because there
//! is no diagram logic in Rust at all — a document is text to the backend, and everything that
//! makes it a *diagram* (the editor, the shapes, the routing) lives above this line.
//!
//! Two shapes of failure the frontend has to be able to tell apart, and both come back as values
//! rather than errors, for the reason `notes_cmd` gives: a diagram that no longer exists is
//! `None`, and a folder move that would have nested a folder in itself is `false`. Neither is the
//! user doing something wrong, so neither should put a red toast on screen.

use tauri::{AppHandle, State};

use crate::db::models::{
    DiagramFolderRow, DiagramMeta, DiagramRow, DiagramTemplateRow, DiagramThumbnail,
    DiagramsWorkspaceTree,
};
use crate::db::{diagram_queries, Db};

use super::claude_cmd::{load_ai_config, AiTask};
use crate::ai;
use crate::ai_runs;

/// The biggest `.drawio` file the importer will read, in bytes. Generous for a diagram — the
/// largest thing draw.io itself ships is a fraction of it — and a bound rather than none, because
/// the alternative is that pointing the dialog at a video wedges the app.
const MAX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;

/// How many thumbnails one request may ask for. Comfortably above what a gallery draws at once and
/// comfortably below SQLite's default 999-parameter ceiling.
const THUMBNAIL_BATCH: usize = 400;

// ---------- load ----------

#[tauri::command]
pub fn diagrams_load_tree(
    db: State<Db>,
    workspace_id: String,
) -> Result<DiagramsWorkspaceTree, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::load_tree(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// One diagram's document. The only call in this file that returns `doc`; see `diagram_queries`.
#[tauri::command]
pub fn diagrams_get_diagram(db: State<Db>, id: String) -> Result<Option<DiagramRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::get_diagram(&conn, &id).map_err(|e| e.to_string())
}

/// The pictures of the diagrams the gallery is about to draw. Capped, because `ids` comes from the
/// frontend and one prepared statement should not be asked to bind ten thousand parameters —
/// SQLite's own limit is 999 by default, and a request past it is a bug upstream, not a user
/// action worth erroring over.
#[tauri::command]
pub fn diagrams_load_thumbnails(
    db: State<Db>,
    ids: Vec<String>,
) -> Result<Vec<DiagramThumbnail>, String> {
    let capped = if ids.len() > THUMBNAIL_BATCH { &ids[..THUMBNAIL_BATCH] } else { &ids[..] };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::load_thumbnails(&conn, capped).map_err(|e| e.to_string())
}

// ---------- diagrams ----------

/// `folder_id` is optional: null is the root, which is where a diagram made from the gallery goes.
#[tauri::command]
pub fn diagrams_create_diagram(
    db: State<Db>,
    workspace_id: String,
    folder_id: Option<String>,
    title: String,
    doc: String,
    format: String,
    tags: String,
) -> Result<DiagramMeta, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::create_diagram(
        &conn,
        &workspace_id,
        folder_id.as_deref(),
        &title,
        &doc,
        &format,
        &tags,
    )
    .map_err(|e| e.to_string())
}

/// The autosave path. `None` means the diagram was deleted while it was open.
#[tauri::command]
pub fn diagrams_save_diagram(
    db: State<Db>,
    id: String,
    doc: String,
    format: String,
    thumbnail: String,
) -> Result<Option<DiagramMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::save_diagram(&conn, &id, &doc, &format, &thumbnail).map_err(|e| e.to_string())
}

/// Rejects a blank title here rather than in the tree, so that every path into a rename — the
/// explorer, the gallery, a future shortcut — is held to the same rule by one check.
#[tauri::command]
pub fn diagrams_rename_diagram(
    db: State<Db>,
    id: String,
    title: String,
) -> Result<Option<DiagramMeta>, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("A diagram needs a title".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::rename_diagram(&conn, &id, trimmed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_set_tags(
    db: State<Db>,
    id: String,
    tags: String,
) -> Result<Option<DiagramMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::set_diagram_tags(&conn, &id, &tags).map_err(|e| e.to_string())
}

/// Refiles a diagram. `None` for the folder is the root, and a real destination.
#[tauri::command]
pub fn diagrams_move_diagram(
    db: State<Db>,
    id: String,
    folder_id: Option<String>,
) -> Result<Option<DiagramMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::move_diagram(&conn, &id, folder_id.as_deref()).map_err(|e| e.to_string())
}

/// One container's whole diagram list, in the order the user arranged it. A drag that crossed
/// folders calls `diagrams_move_diagram` first; see `diagram_queries::move_diagram`.
#[tauri::command]
pub fn diagrams_reorder_diagrams(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::reorder_diagrams(&conn, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_set_pinned(db: State<Db>, id: String, pinned: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::set_diagram_pinned(&conn, &id, pinned).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_delete_diagram(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::delete_diagram(&conn, &id).map_err(|e| e.to_string())
}

/// `title` is passed in because "Copy of …" is translated and Rust has no language.
#[tauri::command]
pub fn diagrams_duplicate_diagram(
    db: State<Db>,
    id: String,
    title: String,
) -> Result<Option<DiagramMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::duplicate_diagram(&conn, &id, &title).map_err(|e| e.to_string())
}

// ---------- folders ----------

#[tauri::command]
pub fn diagrams_create_folder(
    db: State<Db>,
    workspace_id: String,
    parent_id: Option<String>,
    name: String,
    color: String,
) -> Result<DiagramFolderRow, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("A folder needs a name".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::create_folder(&conn, &workspace_id, parent_id.as_deref(), trimmed, &color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_rename_folder(db: State<Db>, id: String, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("A folder needs a name".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::rename_folder(&conn, &id, trimmed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_set_folder_color(db: State<Db>, id: String, color: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::set_folder_color(&conn, &id, &color).map_err(|e| e.to_string())
}

/// `false` means the drop was refused: it would have put the folder inside its own subtree.
#[tauri::command]
pub fn diagrams_move_folder(
    db: State<Db>,
    id: String,
    parent_id: Option<String>,
) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::move_folder(&conn, &id, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_reorder_folders(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::reorder_folders(&conn, &ids).map_err(|e| e.to_string())
}

/// Removes the folder, its subfolders **and every diagram in them**. Confirm before calling.
#[tauri::command]
pub fn diagrams_delete_folder(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::delete_folder(&conn, &id).map_err(|e| e.to_string())
}

// ---------- templates ----------

#[tauri::command]
pub fn diagrams_create_template(
    db: State<Db>,
    workspace_id: String,
    name: String,
    description: String,
    icon: String,
    doc: String,
    format: String,
    tags: String,
) -> Result<DiagramTemplateRow, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("A template needs a name".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::create_template(
        &conn,
        &workspace_id,
        trimmed,
        &description,
        &icon,
        &doc,
        &format,
        &tags,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_update_template(db: State<Db>, row: DiagramTemplateRow) -> Result<(), String> {
    if row.name.trim().is_empty() {
        return Err("A template needs a name".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::update_template(&conn, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_delete_template(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::delete_template(&conn, &id).map_err(|e| e.to_string())
}

// ---------- AI ----------

/// Asks an engine to describe a diagram. Answers with JSON for the frontend to lay out — see
/// [`ai::draw_diagram`] for why the engine is not allowed to place anything itself.
///
/// `outline` is the labels of the open diagram, extracted in the frontend, or empty. The document
/// itself is deliberately not sent: mxGraph XML is mostly geometry and style, which costs tokens
/// and tells a model nothing it can use.
#[tauri::command]
pub async fn diagrams_draw_with_ai(
    app: AppHandle,
    db: State<'_, Db>,
    title: String,
    outline: String,
    instruction: String,
    // The diagram's dialect. Decides which prompt runs and how the reply is unwrapped — see
    // `ai::draw_diagram`. `None` is the drawing one, which is what an older frontend sends.
    format: Option<String>,
    run_id: Option<String>,
) -> Result<String, String> {
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        load_ai_config(&conn, AiTask::Diagram)?
    };
    // `scoped` is what puts the run in the AI run log and makes it cancellable, the same way every
    // other long call in the app is.
    ai_runs::scoped(app, run_id, async {
        ai::draw_diagram(
            &*config.engine,
            &config.binary,
            &config.model,
            &title,
            &outline,
            &instruction,
            format.as_deref().unwrap_or("mxgraph"),
        )
        .await
    })
    .await
}

// ---------- import ----------

/// Reads a `.drawio` file the user just picked in a dialog.
///
/// **Narrow on purpose.** This could have been a general "read any file" command, and a general one
/// is a much larger thing to have added to the app: the frontend could then read anything the
/// process can. This reads one file, checks it is text, and caps the size.
#[tauri::command]
pub fn diagrams_read_drawio(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "{path} is {} MB — too large for a diagram",
            meta.len() / (1024 * 1024)
        ));
    }
    // `read_to_string` rather than reading bytes and converting: a `.drawio` is XML, so a file that
    // is not valid UTF-8 is not one, and saying so beats importing mojibake.
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}
