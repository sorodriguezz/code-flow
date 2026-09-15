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
use crate::fsops;
use crate::db::version_queries::{self, DocVersion};
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
///
/// **A linked diagram is saved twice**: into the row, and out into the working tree it came from.
/// Both here rather than one here and one in the caller, so no window and no code path can write
/// half of it — the pair is what "the diagram and the file are the same thing" means, and a second
/// writer is how they start to disagree.
///
/// The order is the row first, then the file, and the failure is reported rather than swallowed:
/// the row is saved either way (so nothing the user drew is lost), and an `Err` leaves the draft
/// dirty upstairs, so the next edit tries the file again. See `diagramsStore.flush`.
#[tauri::command]
pub fn diagrams_save_diagram(
    db: State<Db>,
    id: String,
    doc: String,
    format: String,
    thumbnail: String,
) -> Result<Option<DiagramMeta>, String> {
    let (meta, target) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // Before the write, so the snapshot holds what the diagram *was* — see the same call in
        // `notes_save_note`. The thumbnail is deliberately not versioned: it is derived from the
        // doc, and storing fifty copies of an SVG to recover a drawing that regenerates it is waste.
        if let Ok(Some(previous)) = diagram_queries::get_diagram(&conn, &id) {
            let _ = version_queries::record_version(
                &conn,
                "diagram",
                &id,
                &previous.title,
                &previous.doc,
                &crate::db::queries::now(),
            );
        }
        let meta = diagram_queries::save_diagram(&conn, &id, &doc, &format, &thumbnail)
            .map_err(|e| e.to_string())?;
        // Resolved while the lock is held and used after it is dropped: a filesystem write is not
        // something to hold the whole database's connection for.
        let target = meta.as_ref().and_then(|m| origin_of(&conn, m));
        (meta, target)
    };

    if let Some((repo_path, rel_path)) = target {
        fsops::write_file_text(&repo_path, &rel_path, &doc)?;
    }
    Ok(meta)
}

// ---------- the repository bridge ----------

/// Where a linked diagram's file is, or `None` when it is an ordinary one.
///
/// `None` also for a link whose project has since been removed from the workspace. That is a
/// diagram whose repository is gone, and the only thing worse than failing to sync it would be
/// guessing at a checkout to sync it with.
fn origin_of(conn: &rusqlite::Connection, meta: &DiagramMeta) -> Option<(String, String)> {
    if meta.origin_path.is_empty() {
        return None;
    }
    let project = crate::db::queries::get_project(conn, &meta.origin_project_id).ok()??;
    Some((project.local_path, meta.origin_path.clone()))
}

/// The same, from a full row. Two callers, two shapes, one rule.
fn origin_of_row(conn: &rusqlite::Connection, row: &DiagramRow) -> Option<(String, String)> {
    if row.origin_path.is_empty() {
        return None;
    }
    let project = crate::db::queries::get_project(conn, &row.origin_project_id).ok()??;
    Some((project.local_path, row.origin_path.clone()))
}

/// A linked diagram and how its file is doing.
///
/// Two fields rather than a `Result`, because "the file could not be read" is not a failure of the
/// call: the diagram opens either way, on the last document it had. A branch without that file
/// checked out is the ordinary way to reach this, and refusing to open the diagram over it would
/// make switching branches destroy the thing the user was looking at.
#[derive(serde::Serialize)]
pub struct DiagramSync {
    /// `None` when the diagram itself is gone — deleted from another window.
    pub row: Option<DiagramRow>,
    /// Empty when the working tree was read. Otherwise the reason, already a sentence.
    pub file_error: String,
}

/// Files a `.dbml` file from a working tree as a diagram, and answers with it.
///
/// Idempotent on `(workspace, project, path)`: the second call on the same file returns the same
/// diagram with its document refreshed from disk, which is what makes the button in the editor safe
/// to press twice. The folder it lands in is the repository's — found by project id, created on
/// first use, and an ordinary folder from then on. See `diagram_queries::link_file`.
#[tauri::command]
pub fn diagrams_link_file(
    db: State<Db>,
    workspace_id: String,
    project_id: String,
    rel_path: String,
    title: String,
    format: String,
) -> Result<DiagramRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let project = crate::db::queries::get_project(&conn, &project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no such repository: {project_id}"))?;
    // Read before the row is touched: a file that cannot be read is not a diagram, and half a link
    // — a row pointing at a path nothing could open — is worse than none.
    let doc = fsops::read_file_text(&project.local_path, &rel_path)?;
    diagram_queries::link_file(
        &conn,
        &workspace_id,
        &project_id,
        &project.name,
        &rel_path,
        &title,
        &doc,
        &format,
    )
    .map_err(|e| e.to_string())
}

/// Re-reads a linked diagram's file into its row.
///
/// The read half of the bridge, called when the diagram is opened and when the working tree
/// changes underneath it. An unlinked diagram is returned untouched, so callers do not have to
/// check first — "sync this if it is a bridge" is one call, not a branch.
#[tauri::command]
pub fn diagrams_pull_file(db: State<Db>, id: String) -> Result<DiagramSync, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some(row) = diagram_queries::get_diagram(&conn, &id).map_err(|e| e.to_string())? else {
        return Ok(DiagramSync { row: None, file_error: String::new() });
    };
    let Some((repo_path, rel_path)) = origin_of_row(&conn, &row) else {
        return Ok(DiagramSync { row: Some(row), file_error: String::new() });
    };
    match fsops::read_file_text(&repo_path, &rel_path) {
        Ok(doc) => {
            let row = diagram_queries::pull_file(&conn, &id, &doc).map_err(|e| e.to_string())?;
            Ok(DiagramSync { row, file_error: String::new() })
        }
        Err(message) => Ok(DiagramSync { row: Some(row), file_error: message }),
    }
}

/// Cuts a diagram loose from its file, keeping the document. See `diagram_queries::unlink_file`.
#[tauri::command]
pub fn diagrams_unlink_file(db: State<Db>, id: String) -> Result<Option<DiagramMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::unlink_file(&conn, &id).map_err(|e| e.to_string())
}

// ---------- version history ----------

#[tauri::command]
pub fn diagrams_list_versions(db: State<Db>, id: String) -> Result<Vec<DocVersion>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::list_versions(&conn, "diagram", &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn diagrams_version_content(db: State<Db>, version_id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::version_content(&conn, &version_id).map_err(|e| e.to_string())
}

/// Drops one of a diagram's versions. See [`notes_delete_version`] — same table, same reasoning.
#[tauri::command]
pub fn diagrams_delete_version(db: State<Db>, version_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::delete_version(&conn, "diagram", &version_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Drops every version of one diagram, leaving the diagram itself alone.
#[tauri::command]
pub fn diagrams_clear_versions(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::delete_versions(&conn, "diagram", &id).map_err(|e| e.to_string())?;
    Ok(())
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
pub fn diagrams_delete_diagram(
    db: State<Db>,
    sandbox: State<crate::sandbox::SandboxRegistry>,
    id: String,
) -> Result<(), String> {
    // The scratch database goes **before** the row, and that order is the whole reason this is
    // here rather than in a cleanup pass. `sandbox_sweep` deletes files with no diagram, so a
    // failure between the two leaves an orphan the next launch reclaims; doing it the other way
    // round would leave a diagram whose sandbox was deleted out from under it.
    let _ = crate::sandbox::wipe(&sandbox, &id);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    diagram_queries::delete_diagram(&conn, &id).map_err(|e| e.to_string())?;
    // Same reasoning as `notes_delete_note`: the document is gone, so its snapshots have nothing
    // left to be snapshots of.
    let _ = version_queries::delete_versions(&conn, "diagram", &id);
    Ok(())
}

/// `title` is passed in because "Copy of …" is translated and Rust has no language.
///
/// **The copy gets no test data.** `sandbox_dir()` is not touched, so the new diagram opens with a
/// clean Build button. Duplicating to compare two variants means writing the fixtures again — the
/// one point in the lifecycle where that happens, and preferable to a copy that silently carries
/// rows written against the schema you are about to change.
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

/// Asks an engine for sample rows for a DBML schema, as JSON.
///
/// Sibling of [`diagrams_draw_with_ai`] and routed through the same config and run log, but the
/// answer is *data for a database* rather than a picture — so nothing it says reaches SQLite
/// unchecked: `lib/dbml/aiFill.ts` validates every value against the schema and builds the
/// `INSERT`s itself. See [`ai::fill_rows`].
#[tauri::command]
pub async fn diagrams_fill_rows_with_ai(
    app: AppHandle,
    db: State<'_, Db>,
    schema: String,
    instruction: String,
    // How many rows per table to ask for. Advice to the model, not a limit — the cap that protects
    // the sandbox is `AI_FILL_MAX_ROWS` in the frontend, where the rows are actually counted.
    rows: Option<u32>,
    // The tables this pass is for, or empty for all of them. A big schema is filled in several
    // passes because one answer covering fifteen tables is an answer the engine truncates.
    only: Option<Vec<String>>,
    // `tabla.columna: v1, v2, …` for the keys already in the sandbox, so a later pass can point
    // its foreign keys at rows that exist rather than guessing ids.
    keys: Option<String>,
    run_id: Option<String>,
) -> Result<String, String> {
    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (
            load_ai_config(&conn, AiTask::SampleRows)?,
            crate::commands::claude_cmd::shared_template(&conn, "sample_rows_template", "")?,
        )
    };
    ai_runs::scoped(app, run_id, async {
        ai::fill_rows(
            &*config.engine,
            &config.binary,
            &config.model,
            &template,
            &schema,
            &instruction,
            rows.unwrap_or(20),
            &only.unwrap_or_default(),
            keys.as_deref().unwrap_or(""),
        )
        .await
    })
    .await
}

// ---------- import ----------

/// Reads a diagram file the user just picked in a dialog — a `.drawio` drawing or a `.dbml` schema.
///
/// **Narrow on purpose.** This could have been a general "read any file" command, and a general one
/// is a much larger thing to have added to the app: the frontend could then read anything the
/// process can. This reads one file, checks it is text, and caps the size.
///
/// It does not care *which* of the two dialects it is holding, and should not: both are text, the
/// format is decided from the extension by the caller that opened the dialog, and a validator here
/// would be a second, worse parser in front of the editor that is about to open the document.
#[tauri::command]
pub fn diagrams_read_import(path: String) -> Result<String, String> {
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
    // `read_to_string` rather than reading bytes and converting: both dialects are text — XML and
    // DBML — so a file that is not valid UTF-8 is not one of them, and saying so beats importing
    // mojibake.
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}
