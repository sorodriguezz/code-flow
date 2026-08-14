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
                                 word_count, sort_order, created_at, updated_at";
const NOTE_COLUMNS: &str = "id, workspace_id, book_id, title, content, excerpt, tags, pinned, \
                            word_count, sort_order, created_at, updated_at";
const BOOK_COLUMNS: &str =
    "id, workspace_id, parent_id, name, color, sort_order, created_at, updated_at";
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
        "SELECT {NOTE_META_COLUMNS} FROM notes WHERE workspace_id = ?1 \
         ORDER BY pinned DESC, updated_at DESC"
    ))?;
    let notes = statement
        .query_map(params![workspace_id], map_meta)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare(&format!(
        "SELECT {BOOK_COLUMNS} FROM note_books WHERE workspace_id = ?1 \
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

pub fn create_note(
    conn: &Connection,
    workspace_id: &str,
    book_id: Option<&str>,
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
         WHERE workspace_id = ?1 AND book_id IS ?2",
        params![workspace_id, book_id],
        |row| row.get(0),
    )?;
    conn.execute(
        &format!("INSERT INTO notes ({NOTE_COLUMNS}) \
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"),
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
            timestamp
        ],
    )?;
    Ok(NoteMeta {
        id,
        workspace_id: workspace_id.to_string(),
        book_id: book_id.map(str::to_string),
        title: title.to_string(),
        excerpt,
        tags: tags.to_string(),
        pinned: false,
        word_count,
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
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

/// Refiles a note. Appended to the destination for the same reason a new note is.
pub fn move_note(
    conn: &Connection,
    id: &str,
    book_id: Option<&str>,
) -> rusqlite::Result<Option<NoteMeta>> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM notes \
         WHERE workspace_id = (SELECT workspace_id FROM notes WHERE id = ?1) AND book_id IS ?2",
        params![id, book_id],
        |row| row.get(0),
    )?;
    // `updated_at` is deliberately untouched: moving a note is filing, not writing, and letting it
    // jump to the top of "recently edited" would make a tidy-up look like a week of work.
    let changed = conn.execute(
        "UPDATE notes SET book_id = ?2, sort_order = ?3 WHERE id = ?1",
        params![id, book_id, sort_order],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    meta_of(conn, id)
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
    create_note(
        conn,
        &source.workspace_id,
        source.book_id.as_deref(),
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
    conn.execute(
        &format!(
            "INSERT INTO note_books ({BOOK_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ),
        params![id, workspace_id, parent_id, name, color, sort_order, timestamp, timestamp],
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
    Ok(true)
}

/// Deletes a book and its subbooks. The notes inside survive at the root — see the table's
/// `ON DELETE SET NULL`, and the comment there for why that is the deliberate outcome.
pub fn delete_book(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM note_books WHERE id = ?1", params![id])?;
    Ok(())
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
        "SELECT id, content FROM notes WHERE workspace_id = ?1 \
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

    fn workspace() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Flow', 'book', '#111', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
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
        let note = create_note(&conn, "w1", None, "T", "uno dos", "[]").unwrap();
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

    #[test]
    fn deleting_a_book_keeps_its_notes_and_removes_its_subbooks() {
        let conn = workspace();
        let parent = create_book(&conn, "w1", None, "Padre", "").unwrap();
        let child = create_book(&conn, "w1", Some(&parent.id), "Hijo", "").unwrap();
        let note = create_note(&conn, "w1", Some(&child.id), "N", "cuerpo", "[]").unwrap();

        delete_book(&conn, &parent.id).unwrap();

        let tree = load_tree(&conn, "w1").unwrap();
        assert!(tree.books.is_empty(), "the subtree goes with the book");
        assert_eq!(tree.notes.len(), 1, "the writing does not");
        assert_eq!(tree.notes[0].id, note.id);
        assert_eq!(tree.notes[0].book_id, None, "it surfaces at the root, where it is visible");
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
        create_note(&conn, "w1", None, "Uno", "el despliegue usa Kubernetes en producción", "[]")
            .unwrap();
        create_note(&conn, "w1", None, "Dos", "nada que ver", "[]").unwrap();

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
        create_note(&conn, "w1", None, "Uno", "cobertura del 100% del módulo", "[]").unwrap();
        create_note(&conn, "w1", None, "Dos", "sin cifras", "[]").unwrap();

        assert_eq!(search_notes(&conn, "w1", "100%", 20).unwrap().len(), 1);
        // Bare `%` would match every row if it reached LIKE unescaped.
        assert_eq!(search_notes(&conn, "w1", "%", 20).unwrap().len(), 1);
    }

    /// The bug SQL `LIKE` caused: it folds case for ASCII only, so an accented capital in the
    /// query never matched its lower-case self in the body — in a Spanish-first app.
    #[test]
    fn search_folds_case_on_accented_letters() {
        let conn = workspace();
        create_note(&conn, "w1", None, "Uno", "la acción del módulo de envío", "[]").unwrap();

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
            None,
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
}
