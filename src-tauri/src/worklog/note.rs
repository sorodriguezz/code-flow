//! A summary kept as an ordinary note of Notas — in a book of its own at the root («Daily /
//! Semanal», made the first time, found again by name the way a flow's notes find «Flujos»), titled
//! «Daily — 23 oct 2026», tagged so they are found together. Regenerating writes the same note again.

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

/// Files a new note in the workspace's summaries book.
pub fn create(conn: &Connection, workspace_id: &str, title: &str, body: &str, format: Format, lang: &str) -> Result<NoteMeta, String> {
    let book = book(conn, workspace_id, lang)?;
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
    fn summaries_go_to_one_book_per_workspace() {
        let db = crate::db::init_scratch().unwrap();
        let conn = db.0.lock().unwrap();
        conn.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', '2026-01-01T00:00:00+00:00')", []).unwrap();
        let a = create(&conn, "w1", "Daily — 23 oct 2026", "## Ayer\n", Format::Daily, "es").unwrap();
        let b = create(&conn, "w1", "Semanal — 19–23 oct 2026", "## Resumen\n", Format::Weekly, "es").unwrap();
        assert_eq!(a.book_id, b.book_id);
        assert_eq!(a.tags, r#"["daily"]"#);
        assert_eq!(b.tags, r#"["semanal"]"#);
        let again = replace(&conn, &a.id, "Daily — 23 oct 2026", "## Ayer\n- otra\n", Format::Daily, "es").unwrap().unwrap();
        assert_eq!(again.id, a.id);
        let books: i64 = conn.query_row("SELECT COUNT(*) FROM note_books WHERE workspace_id = 'w1'", [], |r| r.get(0)).unwrap();
        assert_eq!(books, 1);
    }
}
