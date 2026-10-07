//! The Notes workspace's command surface.
//!
//! Thin, like [`super::remote_cmd`]: every call locks the connection, forwards to
//! [`crate::db::note_queries`] and maps the error. There is no note logic here because there is no
//! note logic in Rust at all — a body is text to the backend (see that module's header), and
//! everything that makes it a *note* (rendering, outline, formatting, templates) is the frontend's.
//!
//! The exception is a note that mirrors a Markdown file of a working tree ("Save in a repository",
//! "Send to Notes"): its file is written beside the row on every save and read back on open, here,
//! where the database lock and the path guard both are — see `crate::repo_files`.
//!
//! The one thing this layer owns is the shape of the failures the frontend must be able to tell
//! apart: a note that no longer exists, and a book move that was refused. Both come back as
//! values rather than as errors — `Option::None` and `false` respectively — because both are
//! ordinary consequences of two windows or of a drag, not faults to raise a toast about.

use tauri::{AppHandle, State};

use super::claude_cmd::AiTask;
use crate::ai;
use crate::ai_runs;
use crate::db::models::{
    NoteBookRow, NoteMeta, NoteRow, NoteSearchHit, NoteTemplateRow, NotesWorkspaceTree,
};
use crate::db::note_queries::NoteTrashRow;
use crate::db::version_queries::{self, DocVersion};
use crate::db::{note_queries, Db};
use crate::fsops;

/// Hits returned by one search. Well past what the panel can show, and the point of the cap is
/// only that a one-character query on a large workspace can't turn into an unbounded transfer.
const SEARCH_LIMIT: i64 = 100;

/// The largest Markdown file "Import Markdown" reads, in bytes — mirrored in
/// `lib/notes/importMarkdown.ts`. A long document is a few hundred kilobytes; a bound rather than
/// none, because a mis-picked log file would otherwise land whole in a note and in every backup.
const MAX_IMPORT_BYTES: u64 = 5 * 1024 * 1024;

// ---------- load ----------

#[tauri::command]
pub fn notes_load_tree(db: State<Db>, workspace_id: String) -> Result<NotesWorkspaceTree, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::load_tree(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// One note's body. The only call in this file that returns `content`; see `note_queries`.
#[tauri::command]
pub fn notes_get_note(db: State<Db>, id: String) -> Result<Option<NoteRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::get_note(&conn, &id).map_err(|e| e.to_string())
}

// ---------- notes ----------

/// `book_id` is required: every note lives in a book. See [`note_queries::create_note`].
#[tauri::command]
pub fn notes_create_note(
    db: State<Db>,
    workspace_id: String,
    book_id: String,
    title: String,
    content: String,
    tags: String,
) -> Result<NoteMeta, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::create_note(&conn, &workspace_id, &book_id, &title, &content, &tags)
        .map_err(|e| e.to_string())
}

/// What a save answers: the note's metadata — `None` when it was deleted while it was being edited,
/// and the frontend drops the editor rather than resurrecting a row the user removed elsewhere —
/// and, for a note that mirrors a file, the version of the file just written, which is what the
/// next save is checked against.
#[derive(serde::Serialize)]
pub struct NoteSaved {
    pub meta: Option<NoteMeta>,
    pub version: Option<fsops::DiskVersion>,
}

/// The autosave path.
///
/// **A note that mirrors a file is saved twice** — into the row and out into its working tree —
/// both here, for the reason `diagrams_save_diagram` gives: one writer of the pair is what keeps
/// the note and the file the same thing. The row first, so nothing typed is lost when the file
/// write fails; the failure is returned, which leaves the draft dirty upstairs and the next edit
/// tries again. The file is written only over the version last read (`expected`), and refused with
/// `changed-on-disk:` otherwise, so the frontend can ask — reload, or overwrite (`force`).
#[tauri::command]
pub fn notes_save_note(
    db: State<Db>,
    id: String,
    title: String,
    content: String,
    tags: String,
    expected: Option<fsops::DiskVersion>,
    force: Option<bool>,
) -> Result<NoteSaved, String> {
    let (meta, target) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // Before the write, so the version holds what the note *was*: a snapshot taken afterwards is
        // a copy of the change rather than of what it replaced, which is useless for going back.
        // Its own guards keep this cheap on the autosave path — see `record_version`.
        if let Ok(Some(previous)) = note_queries::get_note(&conn, &id) {
            let _ = version_queries::record_version(
                &conn,
                "note",
                &id,
                &previous.title,
                &previous.content,
                &crate::db::queries::now(),
            );
        }
        let meta = note_queries::save_note(&conn, &id, &title, &content, &tags)
            .map_err(|e| e.to_string())?;
        if meta.is_some() {
            crate::flows::triggers::note_saved(&id);
        }
        // Resolved under the lock and used after it is dropped: a filesystem write is not something
        // to hold the whole database's connection for.
        let target = meta.as_ref().and_then(|m| origin_of(&conn, &m.origin_project_id, &m.origin_path));
        (meta, target)
    };
    let version = match target {
        Some((repo_path, rel_path)) => Some(crate::repo_files::write_linked(
            &repo_path,
            &rel_path,
            &content,
            expected.as_ref(),
            force.unwrap_or(false),
        )?),
        None => None,
    };
    Ok(NoteSaved { meta, version })
}

// ---------- the repository bridge ----------

/// Where a note's file is — the checkout and the path in it — or `None` for a note that lives only
/// here. `None` too when the project has since been removed: a note whose repository is gone stays
/// readable and simply stops syncing, rather than being synced with a guessed checkout.
fn origin_of(
    conn: &rusqlite::Connection,
    project_id: &str,
    rel_path: &str,
) -> Option<(String, String)> {
    if rel_path.is_empty() {
        return None;
    }
    let project = crate::db::queries::get_project(conn, project_id).ok()??;
    Some((project.local_path, rel_path.to_string()))
}

/// A note and how its file is doing — two fields rather than a `Result`, for the reason
/// `diagrams_cmd::DiagramSync` gives: a file that could not be read (a branch without it) is not a
/// failure to open the note, which opens on the last body it had.
#[derive(serde::Serialize)]
pub struct NoteSync {
    /// `None` when the note itself is gone.
    pub row: Option<NoteRow>,
    /// Empty when the working tree was read. Otherwise the reason, already a sentence.
    pub file_error: String,
    /// The version of the file read — what the next save is checked against. `None` for a note
    /// with no file, or when the file could not be read.
    pub version: Option<fsops::DiskVersion>,
}

/// Re-reads a note's file into it, and answers with the note — the read half of the bridge, called
/// when the note is opened and when its working tree changes. A note with no file comes back as it
/// is, so "sync this if it mirrors a file" is one call rather than a branch upstairs.
#[tauri::command]
pub fn notes_pull_file(db: State<Db>, id: String) -> Result<NoteSync, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some(row) = note_queries::get_note(&conn, &id).map_err(|e| e.to_string())? else {
        return Ok(NoteSync { row: None, file_error: String::new(), version: None });
    };
    let Some((repo_path, rel_path)) = origin_of(&conn, &row.origin_project_id, &row.origin_path)
    else {
        return Ok(NoteSync { row: Some(row), file_error: String::new(), version: None });
    };
    match crate::repo_files::read_linked(&repo_path, &rel_path) {
        Ok((content, version)) => {
            let row = note_queries::pull_file(&conn, &id, &content).map_err(|e| e.to_string())?;
            Ok(NoteSync { row, file_error: String::new(), version: Some(version) })
        }
        Err(message) => Ok(NoteSync { row: Some(row), file_error: message, version: None }),
    }
}

/// "Send to Notes": files a Markdown file of a working tree as a note that mirrors it, and answers
/// with the note and the version read.
///
/// Idempotent on `(workspace, project, path)` — see [`note_queries::link_file`]. The title and tags
/// are the caller's (it reads front matter); the body is read here, after the path guard, and is the
/// file exactly — front matter included — since every save writes it back.
#[tauri::command]
pub fn notes_link_file(
    db: State<Db>,
    workspace_id: String,
    project_id: String,
    rel_path: String,
    title: String,
    tags: String,
) -> Result<NoteSync, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let project = crate::db::queries::get_project(&conn, &project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no such repository: {project_id}"))?;
    // Read before any row is touched: a file that cannot be read is not a note, and half a link — a
    // note pointing at a path nothing could open — is worse than none.
    let (content, version) = crate::repo_files::read_linked(&project.local_path, &rel_path)?;
    let row = note_queries::link_file(
        &conn,
        &workspace_id,
        &project_id,
        &project.name,
        &rel_path,
        &title,
        &content,
        &tags,
    )
    .map_err(|e| e.to_string())?;
    Ok(NoteSync { row: Some(row), file_error: String::new(), version: Some(version) })
}

/// "Save in a repository": writes a note as a Markdown file in `.codeflow/notes/` of one of the
/// workspace's repositories, named after the note, and ties the note to it. From then on it is a
/// mirror like a note sent from that repository — see [`notes_save_note`].
#[tauri::command]
pub fn notes_save_to_repo(
    db: State<Db>,
    id: String,
    project_id: String,
) -> Result<NoteSaved, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let note = note_queries::get_note(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That note no longer exists".to_string())?;
    if !note.origin_path.is_empty() {
        return Err(format!("{} is already saved in a repository", note.title));
    }
    let project = crate::db::queries::get_project(&conn, &project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no such repository: {project_id}"))?;
    let rel_path = crate::repo_files::free_path(
        std::path::Path::new(&project.local_path),
        crate::repo_files::NOTES_FOLDER,
        &note.title,
        "md",
        "nota",
        |path| note_queries::origin_taken(&conn, &project_id, path).unwrap_or(true),
    );
    let version = crate::repo_files::create(&project.local_path, &rel_path, &note.content)?;
    let meta = note_queries::set_origin(&conn, &id, &project_id, &rel_path)
        .map_err(|e| e.to_string())?;
    Ok(NoteSaved { meta, version: Some(version) })
}

/// Cuts a note loose from its file, keeping both. See [`note_queries::unlink_file`].
#[tauri::command]
pub fn notes_unlink_file(db: State<Db>, id: String) -> Result<Option<NoteMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::unlink_file(&conn, &id).map_err(|e| e.to_string())
}

// ---------- version history ----------

/// One note's past versions, newest first, without their bodies.
#[tauri::command]
pub fn notes_list_versions(db: State<Db>, id: String) -> Result<Vec<DocVersion>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::list_versions(&conn, "note", &id).map_err(|e| e.to_string())
}

/// One version's full text — read when the reader opens it, not with the list.
#[tauri::command]
pub fn notes_version_content(db: State<Db>, version_id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::version_content(&conn, &version_id).map_err(|e| e.to_string())
}

/// Drops one of a note's versions.
///
/// Housekeeping rather than an undo: the list is capped at fifty and pruned on save, so nothing
/// *needs* deleting — this is for the reader who wants a shorter list to read. Scoped to `note` by
/// [`version_queries::delete_version`], so a diagram's version id sent here deletes nothing.
#[tauri::command]
pub fn notes_delete_version(db: State<Db>, version_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::delete_version(&conn, "note", &version_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Drops every version of one note, leaving the note itself alone.
///
/// What a purge from the trash does on the note's way out, reached deliberately instead of as a
/// side effect — "clear the history and keep working" is a thing people want, and it must not be
/// spelled "delete the note and undo it".
#[tauri::command]
pub fn notes_clear_versions(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    version_queries::delete_versions(&conn, "note", &id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Refiles a note into another book. There is no "out of every book" — see [`notes_create_note`].
#[tauri::command]
pub fn notes_move_note(
    db: State<Db>,
    id: String,
    book_id: String,
) -> Result<Option<NoteMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::move_note(&conn, &id, &book_id).map_err(|e| e.to_string())
}

/// Writes one book's note order. `ids` is that book's whole list, in the order the user arranged it.
///
/// Separate from [`notes_move_note`] rather than folded into it, because a drop can be either or
/// both: dragging within a book only reorders, dragging across books moves *and* reorders, and the
/// frontend issues the move first so the positions are written against the list the note has already
/// joined. See `notesStore.dropNote`.
#[tauri::command]
pub fn notes_reorder_notes(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::reorder_notes(&conn, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_set_pinned(db: State<Db>, id: String, pinned: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::set_note_pinned(&conn, &id, pinned).map_err(|e| e.to_string())
}

/// Moves a note to the trash — with its history, which goes only when the note does. See
/// [`note_queries::trash_note`] and the trash commands below.
#[tauri::command]
pub fn notes_delete_note(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::trash_note(&conn, &id).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- trash ----------

/// The trash this workspace sees: its own trashed notes and the global ones.
#[tauri::command]
pub fn notes_list_trash(db: State<Db>, workspace_id: String) -> Result<Vec<NoteTrashRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::list_trash(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Takes a note out of the trash. `fallback_book_name` names the book made for it when its own book
/// is gone and the workspace has none — translated, so it comes from the caller. `None` means there
/// was no trashed note by that id (restored or emptied from another window).
#[tauri::command]
pub fn notes_restore_note(
    db: State<Db>,
    id: String,
    fallback_book_name: String,
) -> Result<Option<NoteMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::restore_note(&conn, &id, fallback_book_name.trim()).map_err(|e| e.to_string())
}

/// Deletes one trashed note for good, history included.
#[tauri::command]
pub fn notes_purge_note(db: State<Db>, id: String) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::purge_note(&conn, &id).map_err(|e| e.to_string())
}

/// Empties the trash this workspace sees, for good. Answers with how many notes went.
#[tauri::command]
pub fn notes_empty_trash(db: State<Db>, workspace_id: String) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::empty_trash(&conn, &workspace_id).map_err(|e| e.to_string())
}

// ---------- renaming ----------

/// How many other notes link to `title` — asked before a rename rewrites anything, so the question
/// can say how much it is about to change.
#[tauri::command]
pub fn notes_count_links(
    db: State<Db>,
    workspace_id: String,
    title: String,
    exclude_id: String,
) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::count_linking_notes(&conn, &workspace_id, &title, &exclude_id)
        .map_err(|e| e.to_string())
}

/// Points every `[[old_title]]` in the workspace's other notes at `new_title`, in one transaction,
/// and answers with the notes it rewrote. See [`note_queries::rewrite_links`].
#[tauri::command]
pub fn notes_rewrite_links(
    db: State<Db>,
    workspace_id: String,
    old_title: String,
    new_title: String,
    exclude_id: String,
) -> Result<Vec<NoteMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::rewrite_links(&conn, &workspace_id, &old_title, &new_title, &exclude_id)
        .map_err(|e| e.to_string())
}

/// `title` comes from the caller because "Copy of …" is a translated string — see
/// [`note_queries::duplicate_note`].
#[tauri::command]
pub fn notes_duplicate_note(
    db: State<Db>,
    id: String,
    title: String,
) -> Result<Option<NoteMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::duplicate_note(&conn, &id, &title).map_err(|e| e.to_string())
}

// ---------- books ----------

#[tauri::command]
pub fn notes_create_book(
    db: State<Db>,
    workspace_id: String,
    parent_id: Option<String>,
    name: String,
    color: String,
) -> Result<NoteBookRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::create_book(&conn, &workspace_id, parent_id.as_deref(), name.trim(), &color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_rename_book(db: State<Db>, id: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::rename_book(&conn, &id, name.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_set_book_color(db: State<Db>, id: String, color: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::set_book_color(&conn, &id, &color).map_err(|e| e.to_string())
}

/// Puts a book and everything under it on every workspace's shelf, or takes it back off.
#[tauri::command]
pub fn notes_set_book_scope(db: State<Db>, id: String, global: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::set_book_scope(&conn, &id, global).map_err(|e| e.to_string())
}

/// Moves a book and everything under it to another workspace, and files it there.
#[tauri::command]
pub fn notes_move_book_to_workspace(
    db: State<Db>,
    id: String,
    workspace_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::move_book_to_workspace(&conn, &id, &workspace_id).map_err(|e| e.to_string())
}

/// `false` means the drop was refused: it would have put the book inside its own subtree. Not an
/// error — a drag can reasonably attempt it, and the answer is that nothing moved.
#[tauri::command]
pub fn notes_move_book(
    db: State<Db>,
    id: String,
    parent_id: Option<String>,
) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::move_book(&conn, &id, parent_id.as_deref()).map_err(|e| e.to_string())
}

/// The books' half of [`notes_reorder_notes`]: one parent's children, in their new order.
#[tauri::command]
pub fn notes_reorder_books(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::reorder_books(&conn, &ids).map_err(|e| e.to_string())
}

/// Removes the book and its subbooks, and moves **every note inside them to the trash**.
///
/// A note has to belong to a book, so the notes cannot stay where they were; the trash is where
/// they survive, history included, until it is emptied. The count in the confirmation the UI shows
/// first says how many are about to move. See [`note_queries::delete_book`].
#[tauri::command]
pub fn notes_delete_book(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::delete_book(&conn, &id).map_err(|e| e.to_string())
}

// ---------- templates ----------

#[tauri::command]
pub fn notes_create_template(
    db: State<Db>,
    workspace_id: String,
    name: String,
    description: String,
    icon: String,
    content: String,
    tags: String,
) -> Result<NoteTemplateRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::create_template(
        &conn,
        &workspace_id,
        name.trim(),
        &description,
        &icon,
        &content,
        &tags,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_update_template(db: State<Db>, row: NoteTemplateRow) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::update_template(&conn, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_delete_template(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::delete_template(&conn, &id).map_err(|e| e.to_string())
}

// ---------- search ----------

/// Notes whose **body** matched. Titles and tags are filtered in the frontend, which already holds
/// them — see [`note_queries::search_notes`].
#[tauri::command]
pub fn notes_search(
    db: State<Db>,
    workspace_id: String,
    query: String,
) -> Result<Vec<NoteSearchHit>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::search_notes(&conn, &workspace_id, &query, SEARCH_LIMIT)
        .map_err(|e| e.to_string())
}

/// The notes that point at this one with a `[[wiki link]]`.
///
/// The other direction of a feature that only worked forwards — see `note_queries::backlinks`.
/// Capped at the same `SEARCH_LIMIT` as the search, and for the same reason: this reads bodies.
#[tauri::command]
pub fn notes_backlinks(
    db: State<Db>,
    workspace_id: String,
    title: String,
    exclude_id: String,
) -> Result<Vec<NoteSearchHit>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    note_queries::backlinks(&conn, &workspace_id, &title, &exclude_id, SEARCH_LIMIT)
        .map_err(|e| e.to_string())
}

// ---------- import ----------

/// Reads a Markdown file the user just picked in a dialog, for "Import Markdown".
///
/// Narrow on purpose, like `diagrams_read_import`: one file, a size cap, UTF-8 or nothing — a
/// general "read any file" command would be a much larger capability to have added for this.
#[tauri::command]
pub fn notes_read_import(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "{path} is {} MB — too large for a note",
            meta.len() / (1024 * 1024)
        ));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

// ---------- writing with AI ----------

/// Writes Markdown to drop into the open note.
///
/// **Routed like every other AI action in the app**, through `AiTask::Notes`. The dialog used to
/// carry its own provider/model pickers and remember the choice per workspace, which made this the
/// one feature whose engine was set somewhere other than Settings → AI → model per task — two
/// places to set the same thing, and the one people looked in first was the wrong one. It is its
/// own task rather than borrowing `AiTask::Inline` precisely so the choice is still available:
/// writing prose into a note and rewriting a fragment of code are jobs a person routinely wants on
/// different engines.
///
/// `selection` may be empty — that is "write something here" rather than "replace this".
#[tauri::command]
pub async fn notes_write_with_ai(
    app: AppHandle,
    db: State<'_, Db>,
    title: String,
    content: String,
    selection: String,
    instruction: String,
    run_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
    // The workspace the caller is in, so its default account applies. Optional: a caller that
    // does not say gets the task's pin or the provider's default. See `crate::ai_accounts`.
        crate::commands::claude_cmd::load_ai_config_in(&conn, AiTask::Notes, workspace_id.as_deref())?
    };
    // `scoped` is what puts the run in the AI run log and makes it cancellable, the same way every
    // other long call in the app is.
    ai_runs::scoped(app, run_id, async {
        ai::write_note(
            &*config.engine,
            &config.binary,
            &config.model,
            &title,
            &content,
            &selection,
            &instruction,
        )
        .await
    })
    .await
}
