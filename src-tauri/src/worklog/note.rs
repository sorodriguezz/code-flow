//! A summary kept as an ordinary note of Notas — in a book of its own at the root («Daily /
//! Semanal», made the first time, found again by name the way a flow's notes find «Flujos»), inside
//! the book of the month it was written («Noviembre 2026» — what Notas files its dated notes by,
//! `src/lib/notes/filing.ts`), titled «Daily — 23 oct 2026», tagged so they are found together.
//! Regenerating writes the same note again, where it is.

use rusqlite::{params, Connection, OptionalExtension};

use super::Format;
use crate::db::models::NoteMeta;
use crate::db::note_queries;

pub fn book_name(lang: &str) -> &'static str {
    if lang == "en" {
        "Daily / Weekly"
    } else {
        "Daily / Semanal"
    }
}

/// The tags a summary note carries: `daily` or `semanal` / `weekly`, as a stored JSON array.
pub fn tags(format: Format, lang: &str) -> String {
    let tag = match (format, lang == "en") {
        (Format::Daily, _) => "daily",
        (Format::Weekly, true) => "weekly",
        (Format::Weekly, false) => "semanal",
    };
    serde_json::to_string(&[tag]).unwrap_or_else(|_| "[]".into())
}

fn book(conn: &Connection, workspace_id: &str, lang: &str) -> Result<String, String> {
    let name = book_name(lang);
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM note_books WHERE workspace_id = ?1 AND parent_id IS NULL AND name IN (?2, ?3) ORDER BY sort_order LIMIT 1",
            params![workspace_id, name, book_name(if lang == "en" { "es" } else { "en" })],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        Some(id) => Ok(id),
        None => note_queries::create_book(conn, workspace_id, None, name, "").map(|b| b.id).map_err(|e| e.to_string()),
    }
}

const MONTHS_ES: [&str; 12] = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const MONTHS_EN: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// «Noviembre 2026» / «November 2026» — the name Notas gives a month's book.
pub fn month_name(year: i32, month: u32, lang: &str) -> String {
    let names = if lang == "en" { &MONTHS_EN } else { &MONTHS_ES };
    format!("{} {year}", names[(month.clamp(1, 12) - 1) as usize])
}

/// The book of that month inside `parent`, found by its name in either language (whatever its
/// case) or made.
fn month_book(conn: &Connection, workspace_id: &str, parent: &str, year: i32, month: u32, lang: &str) -> Result<String, String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM note_books WHERE parent_id = ?1 AND lower(trim(name)) IN (lower(?2), lower(?3)) ORDER BY sort_order LIMIT 1",
            params![parent, month_name(year, month, "es"), month_name(year, month, "en")],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        Some(id) => Ok(id),
        None => note_queries::create_book(conn, workspace_id, Some(parent), &month_name(year, month, lang), "").map(|b| b.id).map_err(|e| e.to_string()),
    }
}

/// Files a new note in the workspace's summaries book, under this month.
pub fn create(conn: &Connection, workspace_id: &str, title: &str, body: &str, format: Format, lang: &str) -> Result<NoteMeta, String> {
    use chrono::Datelike;
    let today = chrono::Local::now().date_naive();
    create_on(conn, workspace_id, title, body, format, lang, today.year(), today.month())
}

fn create_on(conn: &Connection, workspace_id: &str, title: &str, body: &str, format: Format, lang: &str, year: i32, month: u32) -> Result<NoteMeta, String> {
    let root = book(conn, workspace_id, lang)?;
    let book = month_book(conn, workspace_id, &root, year, month, lang)?;
    note_queries::create_note(conn, workspace_id, &book, title, body, &tags(format, lang)).map_err(|e| e.to_string())
}

/// Writes a summary over note `id` («Regenerar»); `None` when the note is gone.
pub fn replace(conn: &Connection, id: &str, title: &str, body: &str, format: Format, lang: &str) -> Result<Option<NoteMeta>, String> {
    note_queries::save_note(conn, id, title, body, &tags(format, lang)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_go_to_one_book_per_workspace_and_month() {
        let db = crate::db::init_scratch().unwrap();
        let conn = db.0.lock().unwrap();
        conn.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', '2026-01-01T00:00:00+00:00')", []).unwrap();
        let a = create_on(&conn, "w1", "Daily — 23 oct 2026", "## Ayer\n", Format::Daily, "es", 2026, 10).unwrap();
        let b = create_on(&conn, "w1", "Semanal — 19–23 oct 2026", "## Resumen\n", Format::Weekly, "es", 2026, 10).unwrap();
        assert_eq!(a.book_id, b.book_id);
        let name = |id: &Option<String>| -> (String, Option<String>) {
            conn.query_row("SELECT name, parent_id FROM note_books WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        let (month, parent) = name(&a.book_id);
        assert_eq!(month, "Octubre 2026");
        assert_eq!(name(&parent).0, "Daily / Semanal");
        // A month's book the user made by hand, in whatever case or language, is the one used.
        conn.execute("UPDATE note_books SET name = 'october 2026' WHERE id = ?1", params![a.book_id]).unwrap();
        let c = create_on(&conn, "w1", "Daily — 24 oct 2026", "## Ayer\n", Format::Daily, "es", 2026, 10).unwrap();
        assert_eq!(c.book_id, a.book_id);
        let d = create_on(&conn, "w1", "Daily — 2 nov 2026", "## Ayer\n", Format::Daily, "es", 2026, 11).unwrap();
        assert_ne!(d.book_id, a.book_id);
        assert_eq!(a.tags, r#"["daily"]"#);
        assert_eq!(b.tags, r#"["semanal"]"#);
        let again = replace(&conn, &a.id, "Daily — 23 oct 2026", "## Ayer\n- otra\n", Format::Daily, "es").unwrap().unwrap();
        assert_eq!(again.id, a.id);
        let books: i64 = conn.query_row("SELECT COUNT(*) FROM note_books WHERE workspace_id = 'w1'", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 3, "the summaries book and two months");
    }
}
