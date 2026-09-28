//! The Notes workspace's command surface.
//!
//! Thin, like [`super::remote_cmd`]: every call locks the connection, forwards to
//! [`crate::db::note_queries`] and maps the error. There is no note logic here because there is no
//! note logic in Rust at all — a body is text to the backend (see that module's header), and
//! everything that makes it a *note* (rendering, outline, formatting, templates) is the frontend's.
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

/// The autosave path. `None` means the note was deleted while it was being edited — the frontend
/// drops the editor rather than resurrecting a row the user removed elsewhere.
#[tauri::command]
pub fn notes_save_note(
    db: State<Db>,
    id: String,
    title: String,
    content: String,
    tags: String,
) -> Result<Option<NoteMeta>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Before the write, so the version holds what the note *was*: a snapshot taken afterwards is a
    // copy of the change rather than of what it replaced, which is useless for going back. Its own
    // guards keep this cheap on the autosave path — see `record_version`.
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
    note_queries::save_note(&conn, &id, &title, &content, &tags).map_err(|e| e.to_string())
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
