//! CRUD over `notes`, `note_books` and `note_templates` — the Notes workspace.
//!
//! Scoped per workspace like [`super::remote_queries`], and for a related reason: notes are the
//! writing that surrounds a workspace's repositories — a design decision, a runbook, a meeting —
//! and none of that stops being true when you click a different repository.
//!
//! Two rules shape everything in this file.
//!
//! **The list never carries bodies.** [`load_tree`] projects [`NoteMeta`], which is every column
//! of `notes` except `content`; bodies arrive one at a time through [`get_note`]. A workspace of
//! four hundred notes is megabytes of Markdown, and the sidebar draws titles.
//!
//! **Whatever writes `content` rewrites what is derived from it.** `excerpt`, `word_count` and
//! nothing else — but those two are exactly what a list wants from a body it may not read, so a
//! row whose derived columns disagree with its content shows the user a stale preview forever.
//! [`save_note`], [`create_note`] and [`duplicate_note`] are the only writers of `content`, and
//! all three go through [`derive`].
//!
//! What is *not* here: any notion of markdown. A note's body is text to this layer — it is stored,
//! searched as a string, and measured. Rendering, outlines and formatting are the frontend's.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    NoteBookRow, NoteMeta, NoteRow, NoteSearchHit, NoteTemplateRow, NotesWorkspaceTree,
};
use super::queries::now;

/// Every column *except* `content`. See the module comment.
const NOTE_META_COLUMNS: &str = "id, workspace_id, book_id, title, excerpt, tags, pinned, \
                                 word_count, sort_order, created_at, updated_at, scope";
const NOTE_COLUMNS: &str = "id, workspace_id, book_id, title, content, excerpt, tags, pinned, \
                            word_count, sort_order, created_at, updated_at, scope";
const BOOK_COLUMNS: &str =
    "id, workspace_id, parent_id, name, color, sort_order, created_at, updated_at, scope";
const TEMPLATE_COLUMNS: &str = "id, workspace_id, name, description, icon, content, tags, \
                                sort_order, created_at, updated_at";

/// How much of the body the list gets, in characters. Two lines of a gallery card at the width the
/// grid gives one, with enough slack that a card at a wider zoom doesn't run out of text.
const EXCERPT_CHARS: usize = 220;

/// Characters of body either side of a search match. Enough for the phrase around it to be
/// recognisable without the hit list turning into a second reading surface.
const SNIPPET_PAD: usize = 60;

fn map_book(row: &rusqlite::Row) -> rusqlite::Result<NoteBookRow> {
    Ok(NoteBookRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        parent_id: row.get(2)?,
        name: row.get(3)?,
        color: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        scope: row.get(8)?,
    })
}

fn map_meta(row: &rusqlite::Row) -> rusqlite::Result<NoteMeta> {
    Ok(NoteMeta {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        book_id: row.get(2)?,
        title: row.get(3)?,
        excerpt: row.get(4)?,
        tags: row.get(5)?,
        pinned: row.get(6)?,
        word_count: row.get(7)?,
        sort_order: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        scope: row.get(11)?,
    })
}

fn map_note(row: &rusqlite::Row) -> rusqlite::Result<NoteRow> {
    Ok(NoteRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        book_id: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        excerpt: row.get(5)?,
        tags: row.get(6)?,
        pinned: row.get(7)?,
        word_count: row.get(8)?,
        sort_order: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        scope: row.get(12)?,
    })
}

fn map_template(row: &rusqlite::Row) -> rusqlite::Result<NoteTemplateRow> {
    Ok(NoteTemplateRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        icon: row.get(4)?,
        content: row.get(5)?,
        tags: row.get(6)?,
        sort_order: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

// ---------------------------------------------------------------------------
// Derived columns
// ---------------------------------------------------------------------------

/// The excerpt and the word count for a body, computed together because they are always written
/// together. See the module comment for why they are stored at all.
fn derive(content: &str) -> (String, i64) {
    (excerpt_of(content), word_count_of(content) as i64)
}

/// The first stretch of a note as prose: enough of it to recognise the note by, with the marks
/// taken out.
///
/// Not a Markdown parse. This runs on every save and its output is two lines on a card, so the
/// bar is "reads like a sentence", not "is faithful to CommonMark" — a stray asterisk in an
/// excerpt costs nothing, and pulling `marked` into Rust to avoid one would cost a great deal.
///
/// What it does skip outright is the two things that would make the preview *wrong* rather than
/// slightly ugly: a YAML front-matter block (metadata, not prose) and fenced code (the excerpt of
/// a note that opens with a shell snippet should be the paragraph after it, not the shebang).
fn excerpt_of(content: &str) -> String {
    let mut out = String::new();
    let mut lines = content.lines().peekable();

    // Front matter, but only when the very first line opens it — a `---` further down is a
    // horizontal rule and the text after it is the note.
    if lines.peek().map(|l| l.trim_end()) == Some("---") {
        lines.next();
        for line in lines.by_ref() {
            if line.trim_end() == "---" {
                break;
            }
        }
    }

    let mut in_fence = false;
    for line in lines {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || trimmed.is_empty() {
            continue;
        }
        let cleaned = strip_marks(trimmed);
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&cleaned);
        if out.chars().count() >= EXCERPT_CHARS {
            break;
        }
    }

    truncate_chars(&out, EXCERPT_CHARS)
}

/// One line of Markdown as plain text: block prefixes off the front, inline marks removed, links
/// reduced to their label and images dropped entirely.
fn strip_marks(line: &str) -> String {
    let mut rest = line.trim_start();

    // Block prefixes, possibly stacked ("> - item" in a quoted list).
    loop {
        let before = rest;
        rest = rest.trim_start_matches(['#', '>']).trim_start();
        for bullet in ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ "] {
            if let Some(stripped) = rest.strip_prefix(bullet) {
                rest = stripped.trim_start();
                break;
            }
        }
        // An ordered marker: digits then '.' or ')' then a space.
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 {
            let after = &rest[digits..];
            if let Some(stripped) = after.strip_prefix(". ").or_else(|| after.strip_prefix(") ")) {
                rest = stripped.trim_start();
            }
        }
        if rest == before {
            break;
        }
    }

    // A table separator row (`|---|:--:|`) is punctuation with no prose in it at all.
    if rest.starts_with('|') && rest.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
        return String::new();
    }
    // So is a horizontal rule.
    if rest.len() >= 3 && rest.chars().all(|c| matches!(c, '-' | '*' | '_' | ' ')) {
        return String::new();
    }

    let mut out = String::with_capacity(rest.len());
    let chars: Vec<char> = rest.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            // An image contributes nothing readable; a link contributes its label.
            '!' if chars.get(at + 1) == Some(&'[') => {
                if let Some(end) = skip_link(&chars, at + 1) {
                    at = end;
                    continue;
                }
                out.push(chars[at]);
                at += 1;
            }
            '[' => {
                if let Some(end) = skip_link(&chars, at) {
                    // The label, which is what a reader of the excerpt would have read.
                    let close = chars[at..end].iter().position(|&c| c == ']').unwrap_or(0);
                    out.extend(&chars[at + 1..at + close]);
                    at = end;
                    continue;
                }
                at += 1;
            }
            '*' | '_' | '`' | '~' => at += 1,
            c => {
                out.push(c);
                at += 1;
            }
        }
    }

    // Whitespace collapsed so a line of ragged Markdown doesn't reach the card with gaps in it.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The index just past a `[label](target)` starting at `open`, or `None` if it isn't one.
fn skip_link(chars: &[char], open: usize) -> Option<usize> {
    if chars.get(open) != Some(&'[') {
        return None;
    }
    let close = chars[open..].iter().position(|&c| c == ']')? + open;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = chars[close..].iter().position(|&c| c == ')')? + close;
    Some(end + 1)
}

/// Words, counted the way a writer counts them: runs of non-whitespace.
///
/// Marks are not stripped first, on purpose. `**word**` is one word either way, and the cost of
/// being exactly right about a line of `| --- | --- |` is a Markdown parse on every keystroke's
/// worth of save — for a number shown next to "words" in a status bar.
fn word_count_of(content: &str) -> usize {
    content.split_whitespace().count()
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    // Cut at the last word boundary so the excerpt ends on a word rather than mid-syllable —
    // unless there isn't one, which means a single very long token and nothing to gain.
    if let Some(space) = out.rfind(' ') {
        if space > max / 2 {
            out.truncate(space);
        }
    }
    out.push('…');
    out
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/// One workspace's notes, books and templates in a single round trip — and no note bodies.
pub fn load_tree(conn: &Connection, workspace_id: &str) -> rusqlite::Result<NotesWorkspaceTree> {
    let mut statement = conn.prepare(&format!(
        "SELECT {NOTE_META_COLUMNS} FROM notes WHERE workspace_id = ?1 OR scope = 'global' \
         ORDER BY pinned DESC, updated_at DESC"
    ))?;
    let notes = statement
        .query_map(params![workspace_id], map_meta)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare(&format!(
        "SELECT {BOOK_COLUMNS} FROM note_books WHERE workspace_id = ?1 OR scope = 'global' \
         ORDER BY sort_order, name"
    ))?;
    let books = statement
        .query_map(params![workspace_id], map_book)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare(&format!(
        "SELECT {TEMPLATE_COLUMNS} FROM note_templates WHERE workspace_id = ?1 \
         ORDER BY sort_order, name"
    ))?;
    let templates = statement
        .query_map(params![workspace_id], map_template)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(NotesWorkspaceTree { notes, books, templates })
}

/// One note, body included.
pub fn get_note(conn: &Connection, id: &str) -> rusqlite::Result<Option<NoteRow>> {
    conn.query_row(
        &format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1"),
        params![id],
        map_note,
    )
    .optional()
}

fn meta_of(conn: &Connection, id: &str) -> rusqlite::Result<Option<NoteMeta>> {
    conn.query_row(
        &format!("SELECT {NOTE_META_COLUMNS} FROM notes WHERE id = ?1"),
        params![id],
        map_meta,
    )
    .optional()
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/// Writes a new note **into a book**, which every note has.
///
/// `book_id` is not optional and that is the invariant the Notes workspace now rests on: the main
/// view browses books and shows what is inside them, so a note belonging to none would be a note
/// with no surface it could be reached from. `migrations::file_loose_notes_into_a_book` brought the
/// rows written under the old rule inside; this signature is what stops new ones being made.
pub fn create_note(
    conn: &Connection,
    workspace_id: &str,
    book_id: &str,
    title: &str,
    content: &str,
    tags: &str,
) -> rusqlite::Result<NoteMeta> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let (excerpt, word_count) = derive(content);
    // Appended within its book, for the reason `remote_queries::create_host` gives: a list the
    // user has arranged by hand must not be rearranged by adding to it.
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM notes \
         WHERE workspace_id = ?1 AND book_id = ?2",
        params![workspace_id, book_id],
        |row| row.get(0),
    )?;
    // Inherited from the book, never passed in: `notes.scope` is a copy of the book's, and a note
    // written into a global book has to be global or it would be invisible from every workspace
    // but this one — inside a book that is on all of their shelves.
    let scope: String = conn
        .query_row(
            "SELECT scope FROM note_books WHERE id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "workspace".to_string());
    conn.execute(
        &format!("INSERT INTO notes ({NOTE_COLUMNS}) \
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"),
        params![
            id,
            workspace_id,
            book_id,
            title,
            content,
            excerpt,
            tags,
            false,
            word_count,
            sort_order,
            timestamp,
            timestamp,
            scope
        ],
    )?;
    Ok(NoteMeta {
        id,
        workspace_id: workspace_id.to_string(),
        book_id: Some(book_id.to_string()),
        title: title.to_string(),
        excerpt,
        tags: tags.to_string(),
        pinned: false,
        word_count,
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        scope,
    })
}

/// The autosave path: title, body and tags in one statement, with the derived columns rewritten.
///
/// Returns the row's new metadata rather than nothing, because the caller's list is holding the
/// *old* excerpt, word count and `updated_at` — the three things this call changes that the
/// caller could not have computed. Returns `None` if the note was deleted underneath the edit,
/// which is the case a second window makes real.
pub fn save_note(
    conn: &Connection,
    id: &str,
    title: &str,
    content: &str,
    tags: &str,
) -> rusqlite::Result<Option<NoteMeta>> {
    let (excerpt, word_count) = derive(content);
    let changed = conn.execute(
        "UPDATE notes SET title = ?2, content = ?3, excerpt = ?4, tags = ?5, word_count = ?6, \
         updated_at = ?7 WHERE id = ?1",
        params![id, title, content, excerpt, tags, word_count, now()],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    meta_of(conn, id)
}

/// Refiles a note into another book. Appended to the destination for the same reason a new note is.
///
/// There is no "out of every book" — see [`create_note`].
pub fn move_note(
    conn: &Connection,
    id: &str,
    book_id: &str,
) -> rusqlite::Result<Option<NoteMeta>> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM notes \
         WHERE workspace_id = (SELECT workspace_id FROM notes WHERE id = ?1) AND book_id = ?2",
        params![id, book_id],
        |row| row.get(0),
    )?;
    // `updated_at` is deliberately untouched: moving a note is filing, not writing, and letting it
    // jump to the top of "recently edited" would make a tidy-up look like a week of work.
    //
    // `scope` is re-inherited in the same statement, because it is a copy of the destination
    // book's and the destination just changed. Dragging a note into a global book puts it on every
    // shelf; dragging it back out takes it off again.
    let changed = conn.execute(
        "UPDATE notes SET book_id = ?2, sort_order = ?3, \
         scope = COALESCE((SELECT scope FROM note_books WHERE id = ?2), 'workspace') \
         WHERE id = ?1",
        params![id, book_id, sort_order],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    meta_of(conn, id)
}

/// Writes the positions the caller gave: each id's `sort_order` becomes its index in `ids`.
///
/// The caller sends **one book's whole note list**, in the order the user arranged it. Positions are
/// only ever compared within a book (see the `idx_notes_book` index), so a list from one book never
/// disturbs another's — and a gap left behind in the *source* book by a note that moved out is
/// harmless, because nothing reads these numbers except the ordering.
///
/// `updated_at` is deliberately untouched, for the reason [`move_note`] gives and then some.
/// Arranging a list is filing, not writing; and since the hand-made order is what the sidebar shows
/// by default, stamping it here would also make every drag look like an edit in the "last edited"
/// ordering the user can switch back to.
/// In one transaction, because a list is a single fact: a failure part-way through would leave the
/// book holding half of one arrangement and half of another, which is an order nobody chose and
/// which the next drag would then be written on top of.
pub fn reorder_notes(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE notes SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    tx.commit()
}

pub fn set_note_pinned(conn: &Connection, id: &str, pinned: bool) -> rusqlite::Result<()> {
    conn.execute("UPDATE notes SET pinned = ?2 WHERE id = ?1", params![id, pinned])?;
    Ok(())
}

pub fn delete_note(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

/// Copies a note into the same book, under a caller-supplied name.
///
/// The name comes from the caller because "Copy of X" is a translated string and this layer has no
/// language. The copy is never pinned: pinning says "this is the one I keep coming back to", and
/// two identical rows at the top of the list is not what the user asked for by pressing duplicate.
pub fn duplicate_note(
    conn: &Connection,
    id: &str,
    title: &str,
) -> rusqlite::Result<Option<NoteMeta>> {
    let Some(source) = get_note(conn, id)? else {
        return Ok(None);
    };
    let Some(book_id) = source.book_id.as_deref() else {
        // Only reachable on a row the migration could not reach — a note written by a version that
        // allowed no book, in a database restored after this one ran. Copying it would make a
        // second unreachable note rather than a copy the user can open.
        return Ok(None);
    };
    create_note(
        conn,
        &source.workspace_id,
        book_id,
        title,
        &source.content,
        &source.tags,
    )
    .map(Some)
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

pub fn create_book(
    conn: &Connection,
    workspace_id: &str,
    parent_id: Option<&str>,
    name: &str,
    color: &str,
) -> rusqlite::Result<NoteBookRow> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM note_books \
         WHERE workspace_id = ?1 AND parent_id IS ?2",
        params![workspace_id, parent_id],
        |row| row.get(0),
    )?;
    // A sub-book inherits its parent's scope: a workspace-only book inside a global one would be
    // a folder that is present and empty from every workspace but its home. A book made at the
    // root is workspace-scoped, which is where every book starts.
    let scope: String = match parent_id {
        Some(parent) => conn
            .query_row("SELECT scope FROM note_books WHERE id = ?1", params![parent], |row| {
                row.get(0)
            })
            .optional()?
            .unwrap_or_else(|| "workspace".to_string()),
        None => "workspace".to_string(),
    };
    conn.execute(
        &format!(
            "INSERT INTO note_books ({BOOK_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ),
        params![
            id,
            workspace_id,
            parent_id,
            name,
            color,
            sort_order,
            timestamp,
            timestamp,
            scope
        ],
    )?;
    Ok(NoteBookRow {
        id,
        workspace_id: workspace_id.to_string(),
        parent_id: parent_id.map(str::to_string),
        name: name.to_string(),
        color: color.to_string(),
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        scope,
    })
}

pub fn rename_book(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE note_books SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, now()],
    )?;
    Ok(())
}

pub fn set_book_color(conn: &Connection, id: &str, color: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE note_books SET color = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, color, now()],
    )?;
    Ok(())
}

/// Whether `book_id` is `ancestor_id` or sits underneath it.
///
/// The guard on [`move_book`]. Dropping a book into its own descendant would produce a ring of
/// rows that is unreachable from the root — every one of them still in the table, none of them on
/// screen, and no way back to them through the UI that lost them. SQLite's foreign key does not
/// prevent this: a cycle satisfies every `parent_id` reference in it.
fn is_within(conn: &Connection, book_id: &str, ancestor_id: &str) -> rusqlite::Result<bool> {
    let mut current = Some(book_id.to_string());
    // Bounded by the number of rows: a database that already contains a cycle (hand-edited, or
    // restored from a version without this guard) must not spin here.
    let depth: i64 =
        conn.query_row("SELECT COUNT(*) FROM note_books", [], |row| row.get(0))?;
    for _ in 0..=depth {
        let Some(id) = current else { return Ok(false) };
        if id == ancestor_id {
            return Ok(true);
        }
        current = conn
            .query_row(
                "SELECT parent_id FROM note_books WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
    }
    Ok(false)
}

/// Refiles a book, subtree and all. `parent_id` of `None` is the root.
///
/// `Ok(false)` means the move was refused because it would have put the book inside itself —
/// a legitimate thing for a drag to attempt, not an error to raise.
pub fn move_book(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
) -> rusqlite::Result<bool> {
    if let Some(parent) = parent_id {
        if parent == id || is_within(conn, parent, id)? {
            return Ok(false);
        }
    }
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM note_books \
         WHERE workspace_id = (SELECT workspace_id FROM note_books WHERE id = ?1) \
           AND parent_id IS ?2",
        params![id, parent_id],
        |row| row.get(0),
    )?;
    conn.execute(
        "UPDATE note_books SET parent_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, parent_id, sort_order, now()],
    )?;
    // Dropping a book into a global one makes it global, and dragging it back to the root takes it
    // off every other shelf — the subtree follows either way. Routed through `set_book_scope`
    // rather than an UPDATE here so there is one place that knows a scope change has to reach the
    // notes as well as the books.
    let scope: String = match parent_id {
        Some(parent) => conn
            .query_row("SELECT scope FROM note_books WHERE id = ?1", params![parent], |row| {
                row.get(0)
            })
            .optional()?
            .unwrap_or_else(|| "workspace".to_string()),
        None => "workspace".to_string(),
    };
    set_book_scope(conn, id, scope == "global")?;
    Ok(true)
}

/// Puts a book — and everything under it — on every workspace's shelf, or takes it back off.
///
/// The whole subtree, for the reason [`create_book`] inherits: a global book whose sub-book is not
/// global renders, from every workspace but its home, as a folder that is there and empty. The
/// notes go too, because `notes.scope` is what [`load_tree`]'s notes query filters on — it is
/// denormalised from here precisely so that read stays one statement with no join, and this is the
/// function that owes it.
///
/// One transaction: a subtree half on the shelf is a state no user asked for and none can see.
pub fn set_book_scope(conn: &Connection, id: &str, global: bool) -> rusqlite::Result<()> {
    let scope = if global { "global" } else { "workspace" };
    const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 \
             UNION ALL \
             SELECT book.id FROM note_books book JOIN subtree ON book.parent_id = subtree.id \
         ) ";
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        &format!("{SUBTREE} UPDATE notes SET scope = ?2 WHERE book_id IN (SELECT id FROM subtree)"),
        params![id, scope],
    )?;
    tx.execute(
        &format!(
            "{SUBTREE} UPDATE note_books SET scope = ?2, updated_at = ?3 \
             WHERE id IN (SELECT id FROM subtree)"
        ),
        params![id, scope, now()],
    )?;
    tx.commit()
}

/// Moves a book and everything under it to another workspace, and files it *there* rather than
/// leaving it global — "move to workspace" is the answer to "this belongs somewhere else", not a
/// second way to spell "everywhere".
///
/// Deliberately not routed through [`move_book`], which is about the tree and refuses to think
/// about workspaces at all. The book lands at the root of its new home, because the parent it had
/// belongs to the workspace it just left.
pub fn move_book_to_workspace(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
) -> rusqlite::Result<()> {
    const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 \
             UNION ALL \
             SELECT book.id FROM note_books book JOIN subtree ON book.parent_id = subtree.id \
         ) ";
    let tx = conn.unchecked_transaction()?;
    let sort_order: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM note_books \
         WHERE workspace_id = ?1 AND parent_id IS NULL",
        params![workspace_id],
        |row| row.get(0),
    )?;
    tx.execute(
        &format!(
            "{SUBTREE} UPDATE notes SET workspace_id = ?2, scope = 'workspace' \
             WHERE book_id IN (SELECT id FROM subtree)"
        ),
        params![id, workspace_id],
    )?;
    tx.execute(
        &format!(
            "{SUBTREE} UPDATE note_books SET workspace_id = ?2, scope = 'workspace', \
             updated_at = ?3 WHERE id IN (SELECT id FROM subtree)"
        ),
        params![id, workspace_id, now()],
    )?;
    tx.execute(
        "UPDATE note_books SET parent_id = NULL, sort_order = ?2 WHERE id = ?1",
        params![id, sort_order],
    )?;
    tx.commit()
}

/// The books' half of [`reorder_notes`]: one parent's children, in the order the user arranged them.
///
/// `updated_at` is left alone here too. Nothing orders books by it, but a reorder that bumped it
/// would make "when did I last touch this book" mean "when did I last drag something past it".
pub fn reorder_books(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE note_books SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    tx.commit()
}

/// Deletes a book, its subbooks, **and every note in any of them**.
///
/// This used to leave the notes behind at the root, which was the recoverable outcome while "no
/// book" was a place a note could be. It no longer is (see [`create_note`]), so there is nowhere to
/// leave them: a surviving note would be a row no view can reach. Deleting a book is therefore a
/// destructive act, and the confirmation the UI puts in front of it says how many notes are about
/// to go — see `notes.deleteBookWithNotes`.
///
/// The notes go first and in the same transaction as the books. The other order would rely on the
/// table's `ON DELETE SET NULL` not firing in between, which is exactly the state — notes with no
/// book — this function exists to avoid producing.
pub fn delete_book(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 \
             UNION ALL \
             SELECT book.id FROM note_books book JOIN subtree ON book.parent_id = subtree.id \
         ) \
         DELETE FROM notes WHERE book_id IN (SELECT id FROM subtree)",
        params![id],
    )?;
    // The subbooks go with it through `note_books.parent_id`'s own `ON DELETE CASCADE`.
    tx.execute("DELETE FROM note_books WHERE id = ?1", params![id])?;
    tx.commit()
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

pub fn create_template(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
    description: &str,
    icon: &str,
    content: &str,
    tags: &str,
) -> rusqlite::Result<NoteTemplateRow> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM note_templates WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;
    conn.execute(
        &format!("INSERT INTO note_templates ({TEMPLATE_COLUMNS}) \
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"),
        params![
            id,
            workspace_id,
            name,
            description,
            icon,
            content,
            tags,
            sort_order,
            timestamp,
            timestamp
        ],
    )?;
    Ok(NoteTemplateRow {
        id,
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        icon: icon.to_string(),
        content: content.to_string(),
        tags: tags.to_string(),
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub fn update_template(conn: &Connection, row: &NoteTemplateRow) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE note_templates SET name = ?2, description = ?3, icon = ?4, content = ?5, \
         tags = ?6, sort_order = ?7, updated_at = ?8 WHERE id = ?1",
        params![
            row.id,
            row.name,
            row.description,
            row.icon,
            row.content,
            row.tags,
            row.sort_order,
            now()
        ],
    )?;
    Ok(())
}

pub fn delete_template(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM note_templates WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Notes whose **body** contains `query`, with the stretch of text around the first match.
///
/// Titles and tags are deliberately not searched here. The frontend is already holding every
/// [`NoteMeta`] in the workspace, so it filters those itself as the user types — no round trip, no
/// debounce, results on the keystroke. What it cannot do is look inside bodies it never loaded,
/// and that is the entire job of this function.
///
/// **Matched in Rust, not by SQL `LIKE`, and the reason is Spanish.** SQLite's `LIKE` folds case
/// for ASCII only, so a body containing `la acción` would not match a search for `ACCIÓN` — while
/// [`snippet_around`], which folds per character, matches it happily. Using `LIKE` as a prefilter
/// therefore hid rows the snippet stage would have accepted, and searching `acción` worked while
/// `ACCIÓN` returned nothing. One matcher, used for both the filter and the snippet, is the only
/// way those two can agree.
///
/// The cost is reading each body until `limit` hits are found. That is affordable for the reason
/// FTS5 is not used either — the extension is not guaranteed present in the bundled SQLite, and a
/// notes workspace is a few hundred rows of a few kilobytes, scanned behind a debounce, one row at
/// a time (`query` streams; the bodies are never all resident). If a workspace ever grows past
/// that, the fix is an FTS5 shadow table behind this same signature.
pub fn search_notes(
    conn: &Connection,
    workspace_id: &str,
    query: &str,
    limit: i64,
) -> rusqlite::Result<Vec<NoteSearchHit>> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let mut statement = conn.prepare(
        "SELECT id, content FROM notes WHERE workspace_id = ?1 OR scope = 'global' \
         ORDER BY pinned DESC, updated_at DESC",
    )?;
    let mut rows = statement.query(params![workspace_id])?;

    let mut hits = Vec::new();
    while let Some(row) = rows.next()? {
        let content: String = row.get(1)?;
        let Some((snippet, start, len)) = snippet_around(&content, needle) else {
            continue;
        };
        hits.push(NoteSearchHit {
            id: row.get(0)?,
            snippet,
            match_start: start as i64,
            match_len: len as i64,
        });
        if hits.len() as i64 >= limit {
            break;
        }
    }
    Ok(hits)
}

/// A window of `content` around the first case-insensitive occurrence of `needle`, plus where the
/// match landed *inside that window*.
///
/// Offsets are in characters rather than bytes, because the only consumer is JavaScript — where a
/// string index is a UTF-16 unit and a byte offset into a Spanish note would land mid-character.
/// Characters are the closest of the three that is correct for everything short of an emoji, and
/// the marker being one unit wide on an astral character is a cosmetic miss in a search snippet.
fn snippet_around(content: &str, needle: &str) -> Option<(String, usize, usize)> {
    let hay: Vec<char> = content.chars().collect();
    // Lowercased one character at a time so the two vectors stay index-for-index with the
    // originals — `to_lowercase()` on the whole string can change its length (ẞ → ss), which would
    // put every offset after the first such character in the wrong place.
    let hay_lower: Vec<char> = hay.iter().map(|c| lower_one(*c)).collect();
    let needle_lower: Vec<char> = needle.chars().map(lower_one).collect();
    if needle_lower.is_empty() || needle_lower.len() > hay_lower.len() {
        return None;
    }

    let at = hay_lower
        .windows(needle_lower.len())
        .position(|window| window == needle_lower.as_slice())?;

    let from = at.saturating_sub(SNIPPET_PAD);
    let to = (at + needle_lower.len() + SNIPPET_PAD).min(hay.len());
    let mut snippet: String = hay[from..to].iter().collect();
    // Newlines would turn a one-line result row into three. The snippet is a fragment shown inline,
    // so its own line breaks are noise.
    snippet = snippet.split_whitespace().collect::<Vec<_>>().join(" ");
    if from > 0 {
        snippet.insert(0, '…');
    }
    if to < hay.len() {
        snippet.push('…');
    }

    // Re-found rather than arithmetic'd: collapsing whitespace above moved everything, and a
    // second search of a 120-character fragment is cheaper than tracking the shift through it.
    let snippet_lower: Vec<char> = snippet.chars().map(lower_one).collect();
    let start = snippet_lower
        .windows(needle_lower.len())
        .position(|window| window == needle_lower.as_slice())
        .unwrap_or(0);
    Some((snippet, start, needle_lower.len()))
}

/// `char::to_lowercase` yields an iterator because one character can lowercase into several. Taking
/// the first keeps the 1:1 index mapping the search above depends on, and the characters where the
/// two differ are not ones a case-insensitive match distinguishes anyway.
fn lower_one(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A workspace with one book in it, `b1` — because a note without a book is no longer a state
    /// this module can produce. See [`create_note`].
    fn workspace() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Flow', 'book', '#111', 0, '2026-01-01T00:00:00+00:00');
             INSERT INTO note_books (id, workspace_id, parent_id, name, color, sort_order,
                                     created_at, updated_at)
                 VALUES ('b1', 'w1', NULL, 'Cuaderno', '', 0,
                         '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
    }

    /// A second workspace beside `w1`, for the scope tests.
    fn with_second_workspace(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w2', 'Otro', 'book', '#222', 1, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
    }

    /// The point of the feature: a global book, and the notes in it, are on the other workspace's
    /// shelf too — while a workspace-scoped one stays where it was made.
    #[test]
    fn a_global_book_and_its_notes_show_up_in_every_workspace() {
        let conn = workspace();
        with_second_workspace(&conn);
        create_note(&conn, "w1", "b1", "Runbook", "cuerpo", "[]").unwrap();

        assert!(load_tree(&conn, "w2").unwrap().books.is_empty(), "not global yet");

        set_book_scope(&conn, "b1", true).unwrap();

        let other = load_tree(&conn, "w2").unwrap();
        assert_eq!(other.books.len(), 1, "the global book is on w2's shelf");
        assert_eq!(other.notes.len(), 1, "and so is the note inside it");
        assert_eq!(other.notes[0].scope, "global");

        // And back off again, which must reach the note as well as the book.
        set_book_scope(&conn, "b1", false).unwrap();
        let other = load_tree(&conn, "w2").unwrap();
        assert!(other.books.is_empty() && other.notes.is_empty());
    }

    /// `set_book_scope` walks the subtree. A sub-book left behind would render, from every other
    /// workspace, as a folder that is there and empty.
    #[test]
    fn making_a_book_global_reaches_the_whole_subtree() {
        let conn = workspace();
        with_second_workspace(&conn);
        let child = create_book(&conn, "w1", Some("b1"), "Sub", "").unwrap();
        create_note(&conn, "w1", &child.id, "Dentro", "x", "[]").unwrap();

        set_book_scope(&conn, "b1", true).unwrap();

        let other = load_tree(&conn, "w2").unwrap();
        assert_eq!(other.books.len(), 2, "parent and child both travel");
        assert_eq!(other.notes.len(), 1, "and the note under the child");
    }

    /// A note written into a global book has to be global, or it would be invisible from every
    /// workspace but one — inside a book that is on all of their shelves.
    #[test]
    fn a_note_inherits_the_scope_of_the_book_it_is_written_into() {
        let conn = workspace();
        with_second_workspace(&conn);
        set_book_scope(&conn, "b1", true).unwrap();

        let note = create_note(&conn, "w1", "b1", "Nueva", "cuerpo", "[]").unwrap();
        assert_eq!(note.scope, "global");
        assert_eq!(load_tree(&conn, "w2").unwrap().notes.len(), 1);
    }

    /// Filing a note into a global book puts it on every shelf; dragging it back out takes it off.
    #[test]
    fn moving_a_note_re_inherits_the_destination_books_scope() {
        let conn = workspace();
        with_second_workspace(&conn);
        let global = create_book(&conn, "w1", None, "Compartido", "").unwrap();
        set_book_scope(&conn, &global.id, true).unwrap();
        let note = create_note(&conn, "w1", "b1", "Local", "x", "[]").unwrap();

        let moved = move_note(&conn, &note.id, &global.id).unwrap().unwrap();
        assert_eq!(moved.scope, "global");

        let back = move_note(&conn, &note.id, "b1").unwrap().unwrap();
        assert_eq!(back.scope, "workspace");
    }

    /// Search reads its own statement rather than `load_tree`'s, so it has its own way to miss the
    /// global rows.
    #[test]
    fn search_finds_notes_in_a_global_book_from_another_workspace() {
        let conn = workspace();
        with_second_workspace(&conn);
        create_note(&conn, "w1", "b1", "Runbook", "el procedimiento de despliegue", "[]").unwrap();
        set_book_scope(&conn, "b1", true).unwrap();

        let hits = search_notes(&conn, "w2", "despliegue", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    /// "Move to workspace" files the book *there* rather than leaving it everywhere — and takes the
    /// subtree and the notes with it.
    #[test]
    fn moving_a_book_to_another_workspace_files_it_there() {
        let conn = workspace();
        with_second_workspace(&conn);
        let child = create_book(&conn, "w1", Some("b1"), "Sub", "").unwrap();
        create_note(&conn, "w1", &child.id, "Dentro", "x", "[]").unwrap();

        move_book_to_workspace(&conn, "b1", "w2").unwrap();

        let source = load_tree(&conn, "w1").unwrap();
        assert!(source.books.is_empty() && source.notes.is_empty(), "it left w1");
        let destination = load_tree(&conn, "w2").unwrap();
        assert_eq!(destination.books.len(), 2);
        assert_eq!(destination.notes.len(), 1);
        assert!(destination.books.iter().all(|b| b.scope == "workspace"), "filed, not global");
        let root = destination.books.iter().find(|b| b.id == "b1").unwrap();
        assert!(root.parent_id.is_none(), "it lands at the root of its new home");
    }

    #[test]
    fn the_excerpt_is_prose_with_the_marks_taken_out() {
        let excerpt = excerpt_of(
            "---\ntags: [a]\n---\n\n# Título\n\n```sh\nrm -rf /\n```\n\nEl **primer** párrafo con un [enlace](http://x) y una ![imagen](y.png).",
        );
        assert_eq!(
            excerpt,
            "Título El primer párrafo con un enlace y una .",
            "front matter and fenced code are skipped; heading and inline marks are stripped"
        );
    }

    #[test]
    fn an_excerpt_is_capped_on_a_word_boundary() {
        let excerpt = excerpt_of(&"palabra ".repeat(200));
        assert!(excerpt.chars().count() <= EXCERPT_CHARS + 1, "plus the ellipsis");
        assert!(excerpt.ends_with('…'));
        assert!(!excerpt.ends_with("palab…"), "cut between words, not inside one");
    }

    #[test]
    fn saving_rewrites_what_is_derived_from_the_body() {
        let conn = workspace();
        let note = create_note(&conn, "w1", "b1", "T", "uno dos", "[]").unwrap();
        assert_eq!(note.word_count, 2);

        let saved = save_note(&conn, &note.id, "T", "uno dos tres cuatro", "[]")
            .unwrap()
            .unwrap();
        assert_eq!(saved.word_count, 4);
        assert_eq!(saved.excerpt, "uno dos tres cuatro");

        // And the list — which never reads `content` — agrees with the body that was written.
        let listed = load_tree(&conn, "w1").unwrap().notes.remove(0);
        assert_eq!(listed.excerpt, "uno dos tres cuatro");
        assert_eq!(listed.word_count, 4);
    }

    /// The bug the hand-made order exists to fix: with the sidebar ordered by `updated_at`, every
    /// autosave threw the note being written to the top and rearranged the list under the cursor.
    #[test]
    fn saving_a_note_leaves_its_place_in_the_hand_made_order() {
        let conn = workspace();
        let first = create_note(&conn, "w1", "b1", "Uno", "", "[]").unwrap();
        let second = create_note(&conn, "w1", "b1", "Dos", "", "[]").unwrap();
        assert_eq!((first.sort_order, second.sort_order), (0, 1), "appended, not prepended");

        let saved = save_note(&conn, &first.id, "Uno", "un cuerpo nuevo", "[]").unwrap().unwrap();
        assert_eq!(saved.sort_order, 0, "writing a note is not rearranging the list");
    }

    #[test]
    fn reordering_writes_the_positions_the_caller_gave_and_nothing_else() {
        let conn = workspace();
        let book = create_book(&conn, "w1", None, "Libro", "").unwrap();
        let a = create_note(&conn, "w1", &book.id, "A", "", "[]").unwrap();
        let b = create_note(&conn, "w1", &book.id, "B", "", "[]").unwrap();
        let c = create_note(&conn, "w1", &book.id, "C", "", "[]").unwrap();

        reorder_notes(&conn, &[c.id.clone(), a.id.clone(), b.id.clone()]).unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        let order_of = |id: &str| tree.notes.iter().find(|n| n.id == id).unwrap().sort_order;
        assert_eq!((order_of(&c.id), order_of(&a.id), order_of(&b.id)), (0, 1, 2));

        let touched = tree.notes.iter().find(|n| n.id == a.id).unwrap();
        assert_eq!(touched.updated_at, a.updated_at, "arranging a list is filing, not writing");
    }

    #[test]
    fn reordering_one_book_does_not_disturb_another() {
        let conn = workspace();
        let left = create_book(&conn, "w1", None, "Izquierda", "").unwrap();
        let right = create_book(&conn, "w1", None, "Derecha", "").unwrap();
        let a = create_note(&conn, "w1", &left.id, "A", "", "[]").unwrap();
        let b = create_note(&conn, "w1", &left.id, "B", "", "[]").unwrap();
        let x = create_note(&conn, "w1", &right.id, "X", "", "[]").unwrap();
        let y = create_note(&conn, "w1", &right.id, "Y", "", "[]").unwrap();

        reorder_notes(&conn, &[b.id.clone(), a.id.clone()]).unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        let order_of = |id: &str| tree.notes.iter().find(|n| n.id == id).unwrap().sort_order;
        assert_eq!((order_of(&b.id), order_of(&a.id)), (0, 1));
        assert_eq!((order_of(&x.id), order_of(&y.id)), (0, 1), "the other book is untouched");
    }

    #[test]
    fn books_are_reordered_the_same_way_and_load_in_that_order() {
        let conn = workspace();
        let a = create_book(&conn, "w1", None, "A", "").unwrap();
        let b = create_book(&conn, "w1", None, "B", "").unwrap();
        let c = create_book(&conn, "w1", None, "C", "").unwrap();

        // The whole sibling list, `b1` included — which is what the UI sends, and the reason it
        // does: positions are indexes into one list, so leaving a sibling out of it leaves that
        // sibling's number to collide with somebody else's.
        reorder_books(
            &conn,
            &[c.id.clone(), b.id.clone(), a.id.clone(), "b1".to_string()],
        )
        .unwrap();

        let books = load_tree(&conn, "w1").unwrap().books;
        assert_eq!(
            books.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["C", "B", "A", "Cuaderno"],
            "load_tree already orders by sort_order — the drag decides the list"
        );
    }

    /// The rule "every note has a book" leaves nowhere to put a deleted book's notes, so the delete
    /// takes them — the whole subtree's, not just the top book's.
    #[test]
    fn deleting_a_book_takes_its_subbooks_and_every_note_inside_them() {
        let conn = workspace();
        let parent = create_book(&conn, "w1", None, "Padre", "").unwrap();
        let child = create_book(&conn, "w1", Some(&parent.id), "Hijo", "").unwrap();
        create_note(&conn, "w1", &parent.id, "Arriba", "cuerpo", "[]").unwrap();
        create_note(&conn, "w1", &child.id, "Abajo", "cuerpo", "[]").unwrap();
        let elsewhere = create_note(&conn, "w1", "b1", "Otro", "cuerpo", "[]").unwrap();

        delete_book(&conn, &parent.id).unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(
            tree.books.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            vec!["b1"],
            "the subtree goes with the book",
        );
        assert_eq!(
            tree.notes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec![elsewhere.id.as_str()],
            "and so does everything written in it — but nothing outside it",
        );
        assert!(
            tree.notes.iter().all(|n| n.book_id.is_some()),
            "no note is ever left without a book",
        );
    }

    /// The upgrade path. A note written when "no book" was an ordinary place has to be brought
    /// inside one, or the books-first view has nowhere to show it from and it is simply gone.
    #[test]
    fn the_migration_files_notes_that_had_no_book() {
        let conn = workspace();
        conn.execute(
            "INSERT INTO notes (id, workspace_id, book_id, title, content, excerpt, tags, pinned, \
                                word_count, sort_order, created_at, updated_at) \
             VALUES ('n1', 'w1', NULL, 'Suelta', 'cuerpo', 'cuerpo', '[]', 0, 1, 0, ?1, ?1)",
            params!["2026-01-01T00:00:00+00:00"],
        )
        .unwrap();

        super::super::migrations::run(&conn).unwrap();

        let filed = get_note(&conn, "n1").unwrap().unwrap();
        assert_eq!(
            filed.book_id.as_deref(),
            Some("b1"),
            "into the workspace's first book rather than into one invented next to it",
        );
        assert_eq!(filed.updated_at, "2026-01-01T00:00:00+00:00", "filing is not writing");
    }

    #[test]
    fn a_book_cannot_be_dropped_inside_itself() {
        let conn = workspace();
        let parent = create_book(&conn, "w1", None, "Padre", "").unwrap();
        let child = create_book(&conn, "w1", Some(&parent.id), "Hijo", "").unwrap();
        let grandchild = create_book(&conn, "w1", Some(&child.id), "Nieto", "").unwrap();

        assert!(!move_book(&conn, &parent.id, Some(&grandchild.id)).unwrap());
        assert!(!move_book(&conn, &parent.id, Some(&parent.id)).unwrap());
        assert!(move_book(&conn, &grandchild.id, None).unwrap(), "outwards is always fine");

        let books = load_tree(&conn, "w1").unwrap().books;
        let parent_of = |id: &str| {
            books.iter().find(|f| f.id == id).unwrap().parent_id.clone()
        };
        assert_eq!(parent_of(&parent.id), None, "the refused moves changed nothing");
        assert_eq!(parent_of(&grandchild.id), None);
    }

    #[test]
    fn search_looks_inside_bodies_and_says_where_it_landed() {
        let conn = workspace();
        create_note(&conn, "w1", "b1", "Uno", "el despliegue usa Kubernetes en producción", "[]")
            .unwrap();
        create_note(&conn, "w1", "b1", "Dos", "nada que ver", "[]").unwrap();

        let hits = search_notes(&conn, "w1", "KUBERNETES", 20).unwrap();
        assert_eq!(hits.len(), 1, "case-insensitive, and only the body that matched");
        let hit = &hits[0];
        let start = hit.match_start as usize;
        let matched: String = hit
            .snippet
            .chars()
            .skip(start)
            .take(hit.match_len as usize)
            .collect();
        assert_eq!(matched, "Kubernetes", "the offset indexes the snippet, not the body");
    }

    #[test]
    fn search_treats_wildcards_as_characters() {
        let conn = workspace();
        create_note(&conn, "w1", "b1", "Uno", "cobertura del 100% del módulo", "[]").unwrap();
        create_note(&conn, "w1", "b1", "Dos", "sin cifras", "[]").unwrap();

        assert_eq!(search_notes(&conn, "w1", "100%", 20).unwrap().len(), 1);
        // Bare `%` would match every row if it reached LIKE unescaped.
        assert_eq!(search_notes(&conn, "w1", "%", 20).unwrap().len(), 1);
    }

    /// The bug SQL `LIKE` caused: it folds case for ASCII only, so an accented capital in the
    /// query never matched its lower-case self in the body — in a Spanish-first app.
    #[test]
    fn search_folds_case_on_accented_letters() {
        let conn = workspace();
        create_note(&conn, "w1", "b1", "Uno", "la acción del módulo de envío", "[]").unwrap();

        for query in ["ACCIÓN", "acción", "Módulo", "MÓDULO", "EnVíO"] {
            assert_eq!(
                search_notes(&conn, "w1", query, 20).unwrap().len(),
                1,
                "{query} should match"
            );
        }
        assert!(
            search_notes(&conn, "w1", "accion", 20).unwrap().is_empty(),
            "folding case is not stripping accents — 'accion' is a different word"
        );
    }

    #[test]
    fn a_snippet_offset_survives_accented_text() {
        let conn = workspace();
        create_note(
            &conn,
            "w1",
            "b1",
            "Uno",
            "áéíóú ñandú çedilla — la configuración del servidor",
            "[]",
        )
        .unwrap();
        let hits = search_notes(&conn, "w1", "configuración", 20).unwrap();
        let hit = &hits[0];
        let matched: String = hit
            .snippet
            .chars()
            .skip(hit.match_start as usize)
            .take(hit.match_len as usize)
            .collect();
        assert_eq!(matched, "configuración");
    }

    /// Every read in this module is filtered by workspace, and this is the test that says so out
    /// loud.
    ///
    /// It locks a contract the backend already kept and the frontend did not: the store that calls
    /// `load_tree` holds its own `workspace_id` and sends it back on every write, so a store left
    /// pointing at the workspace it was first opened in files new notes there while the user is
    /// looking at another one. The fix for that lives in `notesStore.ts`, but the reason it works
    /// is this — `load_tree('w2')` owes the caller `w2`'s shelf and nothing else.
    #[test]
    fn a_workspace_sees_only_its_own_notes_books_and_templates() {
        let conn = workspace();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w2', 'Otro', 'book', '#222', 1, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();

        let here = create_book(&conn, "w1", None, "Aqui", "").unwrap();
        let there = create_book(&conn, "w2", None, "Alla", "").unwrap();
        create_note(&conn, "w1", &here.id, "Nota de w1", "cuerpo", "[]").unwrap();
        create_note(&conn, "w2", &there.id, "Nota de w2", "cuerpo", "[]").unwrap();
        create_template(&conn, "w1", "Plantilla de w1", "", "file-text", "", "[]").unwrap();
        create_template(&conn, "w2", "Plantilla de w2", "", "file-text", "", "[]").unwrap();

        let second = load_tree(&conn, "w2").unwrap();
        assert_eq!(
            second.notes.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(),
            ["Nota de w2"],
        );
        assert_eq!(
            second.books.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
            ["Alla"],
        );
        assert_eq!(
            second.templates.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["Plantilla de w2"],
        );

        // And the other way round, so a passing test cannot mean "load_tree returns nothing".
        let first = load_tree(&conn, "w1").unwrap();
        assert_eq!(
            first.notes.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(),
            ["Nota de w1"],
        );
        assert!(first.books.iter().any(|b| b.name == "Aqui"));
        assert!(first.books.iter().all(|b| b.name != "Alla"));
    }
}
