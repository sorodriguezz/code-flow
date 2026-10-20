//! The knowledge index: a cache database of its own (`cache_dir()/knowledge/index.sqlite`) — chunks
//! of every indexed file, an FTS5 index over them, and the vectors of the prose ones.
//!
//! A cache, not app data: everything in it is rebuilt from the files, so it is never backed up and
//! deleting it costs a re-index, not a loss. It is kept out of `codeflow.db` for the same reason —
//! a repository's chunks would multiply the size of every backup for nothing.
//!
//! Incremental: a file whose size and modification time match the stored ones is not read again;
//! one whose content hash matches is not re-chunked. Files that left the set are dropped with their
//! chunks and vectors (cascades, and FTS triggers keep the index in step).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use super::chunker::{self, Kind};
use super::embed::{cosine, from_blob, to_blob};

/// Files over this are not indexed: generated bundles, dumps, lockfiles.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
/// The most files one collection indexes.
pub const MAX_FILES: usize = 20_000;

pub fn default_path() -> PathBuf {
    // Tests never touch the real cache (the code map's once did).
    if cfg!(test) {
        return std::env::temp_dir().join(format!("codeflow-test-knowledge-{}", std::process::id())).join("index.sqlite");
    }
    crate::paths::cache_dir().join("knowledge").join("index.sqlite")
}

static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

/// The app's index connection, opened (and created) on first use.
pub fn global() -> Result<MutexGuard<'static, Connection>, String> {
    if CONN.get().is_none() {
        let conn = open_at(&default_path())?;
        let _ = CONN.set(Mutex::new(conn));
    }
    CONN.get().ok_or("index unavailable")?.lock().map_err(|e| e.to_string())
}

pub fn open_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    init(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS sources (
            id          INTEGER PRIMARY KEY,
            collection  TEXT NOT NULL,
            path        TEXT NOT NULL,
            size        INTEGER NOT NULL DEFAULT 0,
            mtime       INTEGER NOT NULL DEFAULT 0,
            hash        TEXT NOT NULL DEFAULT '',
            kind        TEXT NOT NULL DEFAULT 'code',
            indexed_at  INTEGER NOT NULL DEFAULT 0,
            UNIQUE(collection, path)
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id          INTEGER PRIMARY KEY,
            source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
            start_line  INTEGER NOT NULL,
            end_line    INTEGER NOT NULL,
            heading     TEXT NOT NULL DEFAULT '',
            text        TEXT NOT NULL,
            prose       INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            heading, text, content = 'chunks', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.id, new.heading, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, heading, text) VALUES ('delete', old.id, old.heading, old.text);
        END;
        CREATE TABLE IF NOT EXISTS vectors (
            chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
            space    TEXT NOT NULL,
            data     BLOB NOT NULL,
            PRIMARY KEY (chunk_id, space)
        );
        CREATE TABLE IF NOT EXISTS collections_meta (
            collection   TEXT PRIMARY KEY,
            root         TEXT NOT NULL,
            refreshed_at INTEGER NOT NULL
        );
        "#,
    )
}

/// What one refresh did.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct Refreshed {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub chunks: usize,
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Brings `collection` in line with `files` (relative to `root`).
pub fn refresh(conn: &mut Connection, collection: &str, root: &Path, files: &[String]) -> rusqlite::Result<Refreshed> {
    let mut done = Refreshed::default();
    let tx = conn.transaction()?;
    let wanted: HashSet<&str> = files.iter().take(MAX_FILES).map(String::as_str).collect();
    {
        let mut known = tx.prepare("SELECT id, path, size, mtime, hash FROM sources WHERE collection = ?1")?;
        let rows: Vec<(i64, String, i64, i64, String)> = known
            .query_map(params![collection], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut stored: std::collections::HashMap<String, (i64, i64, i64, String)> = std::collections::HashMap::new();
        for (id, path, size, mtime, hash) in rows {
            if !wanted.contains(path.as_str()) {
                tx.execute("DELETE FROM sources WHERE id = ?1", params![id])?;
                done.removed += 1;
            } else {
                stored.insert(path, (id, size, mtime, hash));
            }
        }
        let now = chrono::Utc::now().timestamp_millis();
        for rel in files.iter().take(MAX_FILES) {
            let full = root.join(rel);
            let Ok(meta) = std::fs::metadata(&full) else { continue };
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let (size, mtime) = (meta.len() as i64, mtime_of(&meta));
            if let Some((_, s, m, _)) = stored.get(rel) {
                if *s == size && *m == mtime {
                    done.unchanged += 1;
                    continue;
                }
            }
            let Ok(bytes) = std::fs::read(&full) else { continue };
            if crate::search::looks_binary(&bytes) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
            let kind = chunker::kind_of(rel);
            let kind_name = match kind {
                Kind::Markdown => "markdown",
                Kind::Text => "text",
                Kind::Code => "code",
            };
            let source_id = match stored.get(rel) {
                Some((id, _, _, old_hash)) if *old_hash == hash => {
                    tx.execute("UPDATE sources SET size = ?1, mtime = ?2 WHERE id = ?3", params![size, mtime, id])?;
                    done.unchanged += 1;
                    continue;
                }
                Some((id, _, _, _)) => {
                    tx.execute("DELETE FROM chunks WHERE source_id = ?1", params![id])?;
                    tx.execute(
                        "UPDATE sources SET size = ?1, mtime = ?2, hash = ?3, kind = ?4, indexed_at = ?5 WHERE id = ?6",
                        params![size, mtime, hash, kind_name, now, id],
                    )?;
                    done.updated += 1;
                    *id
                }
                None => {
                    tx.execute(
                        "INSERT INTO sources (collection, path, size, mtime, hash, kind, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![collection, rel, size, mtime, hash, kind_name, now],
                    )?;
                    done.added += 1;
                    tx.last_insert_rowid()
                }
            };
            // A secret in a file never becomes a retrievable chunk.
            let (clean, _) = crate::secret_scan::redact(&text);
            for piece in chunker::chunk(rel, &clean) {
                tx.execute(
                    "INSERT INTO chunks (source_id, start_line, end_line, heading, text, prose) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![source_id, piece.start_line, piece.end_line, piece.heading, piece.text, kind != Kind::Code],
                )?;
                done.chunks += 1;
            }
        }
        tx.execute(
            "INSERT INTO collections_meta (collection, root, refreshed_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(collection) DO UPDATE SET root = excluded.root, refreshed_at = excluded.refreshed_at",
            params![collection, root.to_string_lossy(), now],
        )?;
    }
    tx.commit()?;
    Ok(done)
}

/// When `collection` was last refreshed, in ms since the epoch.
pub fn refreshed_at(conn: &Connection, collection: &str) -> Option<i64> {
    conn.query_row("SELECT refreshed_at FROM collections_meta WHERE collection = ?1", params![collection], |r| r.get(0)).ok()
}

pub fn remove_collection(conn: &Connection, collection: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sources WHERE collection = ?1", params![collection])?;
    conn.execute("DELETE FROM collections_meta WHERE collection = ?1", params![collection])?;
    Ok(())
}

/// Every collection the index holds something of.
pub fn collection_keys(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT collection FROM sources UNION SELECT collection FROM collections_meta")?;
    let keys = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(keys)
}

/// Drops the vectors of every embedding space whose name starts with `prefix` — compared as text,
/// not with `LIKE`, where the `_` of a model id would be a wildcard.
pub fn remove_space(conn: &Connection, prefix: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM vectors WHERE substr(space, 1, length(?1)) = ?1", params![prefix])
}

/// Gives the pages a large delete freed back to the disk: SQLite keeps them in the file otherwise.
pub fn compact(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
}

/// One collection's size, for the Knowledge pane.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStatus {
    pub collection: String,
    pub files: i64,
    pub chunks: i64,
    pub vectors: i64,
    pub refreshed_at: Option<i64>,
}

pub fn status(conn: &Connection, collection: &str, space: Option<&str>) -> rusqlite::Result<CollectionStatus> {
    let files: i64 = conn.query_row("SELECT COUNT(*) FROM sources WHERE collection = ?1", params![collection], |r| r.get(0))?;
    let chunks: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.collection = ?1",
        params![collection],
        |r| r.get(0),
    )?;
    let vectors: i64 = match space {
        Some(space) => conn.query_row(
            "SELECT COUNT(*) FROM vectors v JOIN chunks c ON c.id = v.chunk_id JOIN sources s ON s.id = c.source_id WHERE s.collection = ?1 AND v.space = ?2",
            params![collection, space],
            |r| r.get(0),
        )?,
        None => 0,
    };
    Ok(CollectionStatus { collection: collection.to_string(), files, chunks, vectors, refreshed_at: refreshed_at(conn, collection) })
}

/// One lexical or semantic match.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub chunk_id: i64,
    pub collection: String,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub heading: String,
    pub text: String,
    pub prose: bool,
}

/// The words of a question as an FTS5 query: each word a prefix term, any of them matching, ranked
/// by bm25. `None` when the question has no word to search for.
pub fn fts_query(question: &str) -> Option<String> {
    let mut words: Vec<String> = Vec::new();
    for word in question.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        let word = word.trim_matches('_').to_lowercase();
        if word.chars().count() < 2 || STOPWORDS.contains(&word.as_str()) || words.contains(&word) {
            continue;
        }
        words.push(word);
        if words.len() == 16 {
            break;
        }
    }
    (!words.is_empty()).then(|| words.iter().map(|w| format!("\"{}\"*", w.replace('"', ""))).collect::<Vec<_>>().join(" OR "))
}

/// Words that match everything and say nothing — Spanish and English, the two languages the app
/// is used in.
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "what", "how", "why", "does", "this", "that", "with", "from", "are", "is", "of", "to", "in", "on", "it",
    "el", "la", "los", "las", "de", "del", "que", "qué", "como", "cómo", "por", "para", "con", "una", "uno", "un", "es", "en", "se",
    "su", "sus", "al", "lo", "y", "o", "este", "esta", "esto", "usa", "hace",
];

fn placeholders(n: usize, from: usize) -> String {
    (0..n).map(|i| format!("?{}", i + from)).collect::<Vec<_>>().join(", ")
}

pub fn search_fts(conn: &Connection, collections: &[String], question: &str, limit: usize) -> rusqlite::Result<Vec<Hit>> {
    let Some(query) = fts_query(question) else { return Ok(Vec::new()) };
    if collections.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT c.id, s.collection, s.path, c.start_line, c.end_line, c.heading, c.text, c.prose
         FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN sources s ON s.id = c.source_id
         WHERE chunks_fts MATCH ?1 AND s.collection IN ({})
         ORDER BY bm25(chunks_fts, 2.0, 1.0) LIMIT {}",
        placeholders(collections.len(), 2),
        limit
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&query];
    for c in collections {
        values.push(c);
    }
    let rows = stmt.query_map(values.as_slice(), row_to_hit)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn row_to_hit(r: &rusqlite::Row<'_>) -> rusqlite::Result<Hit> {
    Ok(Hit {
        chunk_id: r.get(0)?,
        collection: r.get(1)?,
        path: r.get(2)?,
        start_line: r.get(3)?,
        end_line: r.get(4)?,
        heading: r.get(5)?,
        text: r.get(6)?,
        prose: r.get(7)?,
    })
}

/// Prose chunks of `collections` with no vector in `space` yet, oldest first.
pub fn pending_vectors(conn: &Connection, space: &str, collections: &[String], limit: usize) -> rusqlite::Result<Vec<(i64, String)>> {
    if collections.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT c.id, c.heading || char(10) || c.text FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.prose = 1 AND s.collection IN ({})
           AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.chunk_id = c.id AND v.space = ?1)
         ORDER BY c.id LIMIT {}",
        placeholders(collections.len(), 2),
        limit
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&space];
    for c in collections {
        values.push(c);
    }
    let rows = stmt.query_map(values.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn store_vectors(conn: &mut Connection, space: &str, items: &[(i64, Vec<f32>)]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for (chunk_id, vector) in items {
        tx.execute(
            "INSERT OR REPLACE INTO vectors (chunk_id, space, data) VALUES (?1, ?2, ?3)",
            params![chunk_id, space, to_blob(vector)],
        )?;
    }
    tx.commit()
}

/// The `limit` chunks of `collections` closest to `query` in `space`, by cosine — exhaustively, which
/// for the tens of thousands of prose chunks a workspace has is a few milliseconds.
pub fn search_vectors(conn: &Connection, space: &str, collections: &[String], query: &[f32], limit: usize) -> rusqlite::Result<Vec<(Hit, f32)>> {
    if collections.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT c.id, s.collection, s.path, c.start_line, c.end_line, c.heading, c.text, c.prose, v.data
         FROM vectors v JOIN chunks c ON c.id = v.chunk_id JOIN sources s ON s.id = c.source_id
         WHERE v.space = ?1 AND s.collection IN ({})",
        placeholders(collections.len(), 2)
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&space];
    for c in collections {
        values.push(c);
    }
    let mut scored: Vec<(Hit, f32)> = stmt
        .query_map(values.as_slice(), |r| {
            let blob: Vec<u8> = r.get(8)?;
            Ok((row_to_hit(r)?, cosine(query, &from_blob(&blob))))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    Ok(scored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempdir::Dir, Connection) {
        let dir = tempdir::Dir::new();
        std::fs::create_dir_all(dir.0.join("docs")).unwrap();
        std::fs::write(dir.0.join("docs/adr.md"), "# Storage\n\nWe chose SQLite for the inventory service.\n\n# Retention\n\nRows are kept 90 days.\n").unwrap();
        std::fs::write(dir.0.join("src.ts"), "export function cartTotal(items) {\n  return items.length;\n}\n").unwrap();
        let conn = open_at(&dir.0.join("index.sqlite")).unwrap();
        (dir, conn)
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!("codeflow-knowledge-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn files() -> Vec<String> {
        vec!["docs/adr.md".into(), "src.ts".into()]
    }

    #[test]
    fn refresh_is_incremental() {
        let (dir, mut conn) = fixture();
        let first = refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        assert_eq!((first.added, first.unchanged), (2, 0));
        assert!(first.chunks >= 3);
        let again = refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        assert_eq!((again.added, again.updated, again.unchanged), (0, 0, 2));
        // A change re-chunks one file; a removal drops it.
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(dir.0.join("src.ts"), "export function computeCartTotal(items) {}\n").unwrap();
        let changed = refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        assert_eq!(changed.updated, 1);
        let gone = refresh(&mut conn, "repo:p", &dir.0, &["docs/adr.md".to_string()]).unwrap();
        assert_eq!(gone.removed, 1);
        assert_eq!(status(&conn, "repo:p", None).unwrap().files, 1);
    }

    #[test]
    fn fts_finds_words_across_languages_and_ranks_headings() {
        let (dir, mut conn) = fixture();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        let hits = search_fts(&conn, &["repo:p".to_string()], "¿Qué base de datos (sqlite) usa el inventario?", 5).unwrap();
        assert_eq!(hits[0].path, "docs/adr.md");
        assert_eq!(hits[0].heading, "Storage");
        let code = search_fts(&conn, &["repo:p".to_string()], "cartTotal", 5).unwrap();
        assert_eq!(code[0].path, "src.ts");
        assert!(!code[0].prose);
        assert!(search_fts(&conn, &["other".to_string()], "sqlite", 5).unwrap().is_empty(), "scoped to collections");
        assert!(fts_query("¿y el?").is_none());
    }

    #[test]
    fn vectors_are_pending_only_for_prose_and_searched_by_cosine() {
        let (dir, mut conn) = fixture();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        let cols = vec!["repo:p".to_string()];
        let pending = pending_vectors(&conn, "s1", &cols, 100).unwrap();
        assert_eq!(pending.len(), 2, "the two Markdown sections, not the code");
        let items: Vec<(i64, Vec<f32>)> = pending.iter().enumerate().map(|(i, (id, _))| (*id, if i == 0 { vec![1.0, 0.0] } else { vec![0.0, 1.0] })).collect();
        store_vectors(&mut conn, "s1", &items).unwrap();
        assert!(pending_vectors(&conn, "s1", &cols, 100).unwrap().is_empty());
        assert_eq!(pending_vectors(&conn, "s2", &cols, 100).unwrap().len(), 2, "another space starts empty");
        let best = search_vectors(&conn, "s1", &cols, &[0.9, 0.1], 1).unwrap();
        assert_eq!(best[0].0.heading, "Storage");
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors, 2);
    }

    #[test]
    fn secrets_never_reach_the_index() {
        let (dir, mut conn) = fixture();
        // Built at run time so the source never holds a token-shaped literal (GitHub push protection).
        let token = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        std::fs::write(dir.0.join(".env.md"), format!("token: {token}\n")).unwrap();
        refresh(&mut conn, "repo:p", &dir.0, &[".env.md".to_string()]).unwrap();
        assert!(search_fts(&conn, &["repo:p".to_string()], &token, 5).unwrap().is_empty());
    }
}
