//! The knowledge index: a cache database of its own (`cache_dir()/knowledge/index.sqlite`) — chunks
//! of every indexed file and document, an FTS5 index over them, and the vectors of the prose ones.
//!
//! A cache, not app data: everything in it is rebuilt from the files and the app's own rows, so it
//! is never backed up and deleting it costs a re-index, not a loss. It is kept out of `codeflow.db`
//! for the same reason — a repository's chunks would multiply the size of every backup for nothing.
//!
//! Two kinds of source share the tables. **Files** (repositories, folders) are incremental by stat:
//! a file whose size and modification time match the stored ones is not read again; one whose
//! content hash matches is not re-chunked. **Documents** (notes, meetings, generated wiki pages,
//! story drafts, review findings, commit messages) are rows of the app's database or of git, kept by
//! a version string the caller chooses (`updated_at`, a commit id): a document whose version matches
//! is not loaded again. Either way what left the set is dropped with its chunks and vectors
//! (cascades, and FTS triggers keep the index in step).
//!
//! **The lock is taken per batch, never for a whole index.** The first index of a large repository
//! reads thousands of files; holding the index's one connection meanwhile kept every search waiting
//! for all of it. A refresh now reads and chunks a batch of files with nothing held, and writes it
//! in one short transaction ([`Writer`]): a search interleaves between two batches and answers from
//! what is already there.
//!
//! A source can be **private** (`sources.private`): a note in a local-only book, a meeting recorded
//! into one. Private chunks are searched for local models and never for cloud ones — the filter is
//! in the queries ([`search_fts_ranked`], [`search_vectors_scoped`]), so no caller can forget it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use super::chunker::{self, Kind};
use super::embed::{from_blob, to_blob};

/// Files over this are not indexed: generated bundles, dumps, lockfiles.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
/// The most files one collection indexes.
pub const MAX_FILES: usize = 20_000;
/// Files one write holds. The index's lock is taken per batch, so a search waits at most one batch
/// of a first index, never the whole of it.
pub const BATCH_FILES: usize = 200;

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
    )?;
    // Added after the first release of the index. A cache could simply be rebuilt, but a column
    // costs nothing to add and a rebuild costs every embedded vector.
    //
    // `private`: the source is in a local-only place (a note's book) and never reaches a cloud
    // engine. `title` / `label`: what a document is called and where it lives (a note's title and
    // its book), the provenance a model is shown. `head`: the commit a repository was indexed at.
    add_column(conn, "sources", "private", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "sources", "title", "TEXT NOT NULL DEFAULT ''")?;
    add_column(conn, "sources", "label", "TEXT NOT NULL DEFAULT ''")?;
    add_column(conn, "collections_meta", "head", "TEXT NOT NULL DEFAULT ''")?;
    Ok(())
}

fn add_column(conn: &Connection, table: &str, column: &str, declaration: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt.query_map([], |r| r.get::<_, String>(1))?.filter_map(Result::ok).any(|name| name == column);
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {declaration};"))?;
    }
    Ok(())
}

/// Bumped by every write that can change what a vector search sees — chunks gone, vectors added, a
/// source turned private — so the in-memory copy of a space ([`search_vectors_scoped`]) knows it is
/// stale without comparing anything.
static GENERATION: AtomicU64 = AtomicU64::new(1);

fn written() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// How a refresh reaches the index: one connection it may hold throughout (tests, a folder of a few
/// files), or the app's, locked once per batch ([`Global`]) so searches interleave.
pub trait Writer {
    fn with<R>(&mut self, work: impl FnOnce(&mut Connection) -> rusqlite::Result<R>) -> Result<R, String>;
}

impl Writer for &mut Connection {
    fn with<R>(&mut self, work: impl FnOnce(&mut Connection) -> rusqlite::Result<R>) -> Result<R, String> {
        work(self).map_err(|e| e.to_string())
    }
}

/// The app's index, locked for each write and released between them.
pub struct Global;

impl Writer for Global {
    fn with<R>(&mut self, work: impl FnOnce(&mut Connection) -> rusqlite::Result<R>) -> Result<R, String> {
        let mut conn = global()?;
        work(&mut conn).map_err(|e| e.to_string())
    }
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

impl Refreshed {
    fn changed(&self) -> bool {
        self.added + self.updated + self.removed > 0
    }
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What the index holds for one path of a collection.
#[derive(Clone, Debug)]
pub struct Stored {
    pub id: i64,
    pub size: i64,
    pub mtime: i64,
    pub hash: String,
    pub private: bool,
    pub title: String,
    pub label: String,
}

pub fn stored(conn: &Connection, collection: &str) -> rusqlite::Result<HashMap<String, Stored>> {
    let mut stmt = conn.prepare("SELECT id, path, size, mtime, hash, private, title, label FROM sources WHERE collection = ?1")?;
    let rows = stmt
        .query_map(params![collection], |r| {
            Ok((
                r.get::<_, String>(1)?,
                Stored { id: r.get(0)?, size: r.get(2)?, mtime: r.get(3)?, hash: r.get(4)?, private: r.get(5)?, title: r.get(6)?, label: r.get(7)? },
            ))
        })?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(rows)
}

/// One file's way into the index, worked out with nothing locked.
enum Change {
    Remove(i64),
    /// Same content, new stat.
    Touch { id: i64, size: i64, mtime: i64 },
    Write { existing: Option<i64>, path: String, size: i64, mtime: i64, hash: String, kind: Kind, pieces: Vec<chunker::Chunk> },
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Markdown => "markdown",
        Kind::Text => "text",
        Kind::Code => "code",
    }
}

/// Reads `rels` (relative to `root`) against what is stored. `keep` says whether a path still
/// belongs to the collection at all — a file the repository now ignores is dropped like a deleted
/// one.
fn changes_for(root: &Path, rels: &[&String], stored: &HashMap<String, Stored>, keep: &dyn Fn(&str) -> bool, done: &mut Refreshed) -> Vec<Change> {
    let mut out = Vec::new();
    for rel in rels {
        let rel = rel.as_str();
        let known = stored.get(rel);
        let gone = |out: &mut Vec<Change>| {
            if let Some(known) = known {
                out.push(Change::Remove(known.id));
            }
        };
        if !keep(rel) {
            gone(&mut out);
            continue;
        }
        let full = root.join(rel);
        let Ok(meta) = std::fs::metadata(&full) else {
            gone(&mut out);
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            gone(&mut out);
            continue;
        }
        let (size, mtime) = (meta.len() as i64, mtime_of(&meta));
        if known.is_some_and(|k| k.size == size && k.mtime == mtime) {
            done.unchanged += 1;
            continue;
        }
        let Ok(bytes) = std::fs::read(&full) else { continue };
        if crate::search::looks_binary(&bytes) {
            gone(&mut out);
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        if let Some(known) = known.filter(|k| k.hash == hash) {
            out.push(Change::Touch { id: known.id, size, mtime });
            done.unchanged += 1;
            continue;
        }
        let kind = chunker::kind_of(rel);
        // A secret in a file never becomes a retrievable chunk.
        let (clean, _) = crate::secret_scan::redact(&text);
        out.push(Change::Write { existing: known.map(|k| k.id), path: rel.to_string(), size, mtime, hash, kind, pieces: chunker::chunk(rel, &clean) });
    }
    out
}

fn apply(conn: &mut Connection, collection: &str, changes: Vec<Change>, now: i64, done: &mut Refreshed) -> rusqlite::Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let mut dropped = false;
    for change in changes {
        match change {
            Change::Remove(id) => {
                tx.execute("DELETE FROM sources WHERE id = ?1", params![id])?;
                done.removed += 1;
                dropped = true;
            }
            Change::Touch { id, size, mtime } => {
                tx.execute("UPDATE sources SET size = ?1, mtime = ?2 WHERE id = ?3", params![size, mtime, id])?;
            }
            Change::Write { existing, path, size, mtime, hash, kind, pieces } => {
                let source_id = match existing {
                    Some(id) => {
                        tx.execute("DELETE FROM chunks WHERE source_id = ?1", params![id])?;
                        tx.execute(
                            "UPDATE sources SET size = ?1, mtime = ?2, hash = ?3, kind = ?4, indexed_at = ?5 WHERE id = ?6",
                            params![size, mtime, hash, kind_name(kind), now, id],
                        )?;
                        done.updated += 1;
                        dropped = true;
                        id
                    }
                    None => {
                        tx.execute(
                            "INSERT INTO sources (collection, path, size, mtime, hash, kind, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![collection, path, size, mtime, hash, kind_name(kind), now],
                        )?;
                        done.added += 1;
                        tx.last_insert_rowid()
                    }
                };
                for piece in pieces {
                    tx.execute(
                        "INSERT INTO chunks (source_id, start_line, end_line, heading, text, prose) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![source_id, piece.start_line, piece.end_line, piece.heading, piece.text, kind != Kind::Code],
                    )?;
                    done.chunks += 1;
                }
            }
        }
    }
    tx.commit()?;
    if dropped {
        written();
    }
    Ok(())
}

/// Marks `collection` refreshed now, from `root` (a folder, or a name for documents), and at commit
/// `head` when given — `None` keeps the one recorded.
pub fn finish(conn: &Connection, collection: &str, root: &str, head: Option<&str>, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO collections_meta (collection, root, refreshed_at, head) VALUES (?1, ?2, ?3, COALESCE(?4, ''))
         ON CONFLICT(collection) DO UPDATE SET root = excluded.root, refreshed_at = excluded.refreshed_at,
             head = COALESCE(?4, collections_meta.head)",
        params![collection, root, now, head],
    )?;
    Ok(())
}

/// Brings `collection` in line with `files` (relative to `root`), a batch at a time through `writer`.
/// `head`: the commit the files are at, recorded for provenance.
pub fn refresh_files<W: Writer>(writer: &mut W, collection: &str, root: &Path, files: &[String], head: Option<&str>) -> Result<Refreshed, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let known = writer.with(|conn| stored(conn, collection))?;
    let mut done = Refreshed::default();
    let wanted: Vec<&String> = files.iter().take(MAX_FILES).collect();
    let wanted_set: HashSet<&str> = wanted.iter().map(|s| s.as_str()).collect();
    let removals: Vec<Change> = known.iter().filter(|(path, _)| !wanted_set.contains(path.as_str())).map(|(_, k)| Change::Remove(k.id)).collect();
    writer.with(|conn| apply(conn, collection, removals, now, &mut done))?;
    for batch in wanted.chunks(BATCH_FILES) {
        let changes = changes_for(root, batch, &known, &|_| true, &mut done);
        writer.with(|conn| apply(conn, collection, changes, now, &mut done))?;
    }
    writer.with(|conn| finish(conn, collection, &root.to_string_lossy(), head, now))?;
    Ok(done)
}

/// [`refresh_files`] on one connection.
#[cfg(test)]
pub fn refresh(conn: &mut Connection, collection: &str, root: &Path, files: &[String]) -> Result<Refreshed, String> {
    refresh_files(&mut &mut *conn, collection, root, files, None)
}

/// Re-reads only `rels` — what a watcher saw change — without walking the collection. `keep` says
/// whether a path belongs to it (not ignored, not under `.git`). The collection's refresh time is
/// left alone: the walk that sets it is still owed when it comes due.
pub fn refresh_paths<W: Writer>(writer: &mut W, collection: &str, root: &Path, rels: &[String], keep: &dyn Fn(&str) -> bool) -> Result<Refreshed, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let known = writer.with(|conn| stored(conn, collection))?;
    let mut done = Refreshed::default();
    let rels: Vec<&String> = rels.iter().collect();
    for batch in rels.chunks(BATCH_FILES) {
        let changes = changes_for(root, batch, &known, keep, &mut done);
        writer.with(|conn| apply(conn, collection, changes, now, &mut done))?;
    }
    Ok(done)
}

/// A document's identity, read cheaply before deciding whether its text must be loaded.
#[derive(Clone, Debug, PartialEq)]
pub struct DocStamp {
    /// `note:<id>`, `commit:<sha>` — what a citation names.
    pub path: String,
    /// Changes whenever the text does (`updated_at`, a commit id): a match skips the load.
    pub version: String,
    /// Never searched for a cloud engine.
    pub private: bool,
    pub title: String,
    /// Where it lives: a note's book, a story's set, a repository.
    pub label: String,
}

/// A document's text, loaded only for the stamps [`docs_to_load`] names.
#[derive(Clone, Debug)]
pub struct DocBody {
    pub kind: Kind,
    /// Gets vectors (prose) or stays lexical (commit messages: many, short, and exact words).
    pub prose: bool,
    pub text: String,
}

/// The stamps whose text the index lacks or holds an older version of.
pub fn docs_to_load(conn: &Connection, collection: &str, stamps: &[DocStamp]) -> rusqlite::Result<Vec<String>> {
    let known = stored(conn, collection)?;
    Ok(stamps.iter().filter(|s| known.get(&s.path).is_none_or(|k| k.hash != s.version)).map(|s| s.path.clone()).collect())
}

/// Brings a document collection in line with `stamps`, writing the `bodies` that were loaded. A
/// stamp whose body could not be loaded keeps what the index had. `root`: a name for the meta row.
pub fn apply_docs(conn: &mut Connection, collection: &str, root: &str, stamps: &[DocStamp], bodies: &HashMap<String, DocBody>, head: Option<&str>) -> rusqlite::Result<Refreshed> {
    let now = chrono::Utc::now().timestamp_millis();
    let known = stored(conn, collection)?;
    let mut done = Refreshed::default();
    let wanted: HashSet<&str> = stamps.iter().map(|s| s.path.as_str()).collect();
    let mut flagged = false;
    let tx = conn.transaction()?;
    for (path, k) in &known {
        if !wanted.contains(path.as_str()) {
            tx.execute("DELETE FROM sources WHERE id = ?1", params![k.id])?;
            done.removed += 1;
        }
    }
    for stamp in stamps {
        let k = known.get(&stamp.path);
        let (title, _) = crate::secret_scan::redact(&stamp.title);
        let body = bodies.get(&stamp.path).filter(|_| k.is_none_or(|k| k.hash != stamp.version));
        let Some(body) = body else {
            if let Some(k) = k {
                // The text is current; where it lives may not be (a book turned local-only).
                if k.private != stamp.private || k.title != title || k.label != stamp.label {
                    tx.execute("UPDATE sources SET private = ?1, title = ?2, label = ?3 WHERE id = ?4", params![stamp.private, title, stamp.label, k.id])?;
                    flagged = true;
                }
                done.unchanged += 1;
            }
            continue;
        };
        let (clean, _) = crate::secret_scan::redact(&body.text);
        let source_id = match k {
            Some(k) => {
                tx.execute("DELETE FROM chunks WHERE source_id = ?1", params![k.id])?;
                tx.execute(
                    "UPDATE sources SET size = ?1, hash = ?2, kind = ?3, indexed_at = ?4, private = ?5, title = ?6, label = ?7 WHERE id = ?8",
                    params![clean.len() as i64, stamp.version, kind_name(body.kind), now, stamp.private, title, stamp.label, k.id],
                )?;
                done.updated += 1;
                k.id
            }
            None => {
                tx.execute(
                    "INSERT INTO sources (collection, path, size, mtime, hash, kind, indexed_at, private, title, label) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![collection, stamp.path, clean.len() as i64, stamp.version, kind_name(body.kind), now, stamp.private, title, stamp.label],
                )?;
                done.added += 1;
                tx.last_insert_rowid()
            }
        };
        for piece in chunker::chunk_as(body.kind, &clean) {
            // The title rides every chunk's heading — the FTS weighs headings double — so a note is
            // found by what it is called, not only by what its body says.
            let heading = match (title.trim(), piece.heading.trim()) {
                ("", section) => section.to_string(),
                (title, "") => title.to_string(),
                (title, section) if section == title => title.to_string(),
                (title, section) => format!("{title} › {section}"),
            };
            tx.execute(
                "INSERT INTO chunks (source_id, start_line, end_line, heading, text, prose) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![source_id, piece.start_line, piece.end_line, heading, piece.text, body.prose],
            )?;
            done.chunks += 1;
        }
    }
    finish(&tx, collection, root, head, now)?;
    tx.commit()?;
    if done.changed() || flagged {
        written();
    }
    Ok(done)
}

/// When `collection` was last refreshed, in ms since the epoch.
pub fn refreshed_at(conn: &Connection, collection: &str) -> Option<i64> {
    conn.query_row("SELECT refreshed_at FROM collections_meta WHERE collection = ?1", params![collection], |r| r.get(0)).ok()
}

/// When `collection` was last refreshed and the commit it was at (`''` when not a repository).
pub fn meta(conn: &Connection, collection: &str) -> Option<(i64, String)> {
    conn.query_row("SELECT refreshed_at, head FROM collections_meta WHERE collection = ?1", params![collection], |r| Ok((r.get(0)?, r.get(1)?))).ok()
}

pub fn remove_collection(conn: &Connection, collection: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sources WHERE collection = ?1", params![collection])?;
    conn.execute("DELETE FROM collections_meta WHERE collection = ?1", params![collection])?;
    written();
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
    let removed = conn.execute("DELETE FROM vectors WHERE substr(space, 1, length(?1)) = ?1", params![prefix])?;
    written();
    Ok(removed)
}

/// Drops the vectors of exactly the space `space`.
pub fn remove_space_exact(conn: &Connection, space: &str) -> rusqlite::Result<usize> {
    let removed = conn.execute("DELETE FROM vectors WHERE space = ?1", params![space])?;
    written();
    Ok(removed)
}

/// Every embedding space the index holds vectors of.
pub fn spaces(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT space FROM vectors")?;
    let spaces = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(spaces)
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
    /// The commit a repository was indexed at; empty for the rest.
    pub head: String,
}

impl CollectionStatus {
    pub fn empty(collection: &str) -> Self {
        Self { collection: collection.to_string(), files: 0, chunks: 0, vectors: 0, refreshed_at: None, head: String::new() }
    }
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
    let (refreshed_at, head) = match meta(conn, collection) {
        Some((at, head)) => (Some(at), head),
        None => (None, String::new()),
    };
    Ok(CollectionStatus { collection: collection.to_string(), files, chunks, vectors, refreshed_at, head })
}

/// Whether any of `collections` has a vector in `space` — one indexed probe, not a count.
pub fn has_vectors(conn: &Connection, space: &str, collections: &[String]) -> bool {
    if collections.is_empty() {
        return false;
    }
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM vectors v JOIN chunks c ON c.id = v.chunk_id JOIN sources s ON s.id = c.source_id
         WHERE v.space = ?1 AND s.collection IN ({}))",
        placeholders(collections.len(), 2)
    );
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&space];
    for c in collections {
        values.push(c);
    }
    conn.query_row(&sql, values.as_slice(), |r| r.get::<_, bool>(0)).unwrap_or(false)
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
    pub private: bool,
    pub title: String,
    pub label: String,
}

/// A word of a question worth searching for.
#[derive(Clone, Debug, PartialEq)]
pub struct Term {
    /// Lowercased, as the FTS query spells it.
    pub word: String,
    /// Looks like code — `snake_case`, `camelCase`, a digit, a dotted name: one such word matched is
    /// already specific, where one shared English word is not.
    pub code_like: bool,
}

/// The words of a question worth searching for: no stopwords, nothing shorter than two characters,
/// no repeats, sixteen at most.
pub fn query_terms(question: &str) -> Vec<Term> {
    let mut terms: Vec<Term> = Vec::new();
    for raw in question.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        let raw = raw.trim_matches('_');
        let word = raw.to_lowercase();
        if word.chars().count() < 2 || STOPWORDS.contains(&word.as_str()) || terms.iter().any(|t| t.word == word) {
            continue;
        }
        let code_like = raw.contains('_') || raw.chars().any(|c| c.is_ascii_digit()) || raw.chars().skip(1).any(char::is_uppercase);
        terms.push(Term { word, code_like });
        if terms.len() == 16 {
            break;
        }
    }
    terms
}

/// The words of a question as an FTS5 query: each word a prefix term, any of them matching, ranked
/// by bm25. `None` when the question has no word to search for.
pub fn fts_query(question: &str) -> Option<String> {
    let terms = query_terms(question);
    (!terms.is_empty()).then(|| terms.iter().map(|t| format!("\"{}\"*", t.word.replace('"', ""))).collect::<Vec<_>>().join(" OR "))
}

/// Words that match everything and say nothing — Spanish and English, the two languages the app
/// is used in. Function words only: they also count against the relevance floor
/// (`knowledge::relevant`), where "which" or "its" would make a question look longer than it is.
pub(crate) const STOPWORDS: &[&str] = &[
    "the", "and", "for", "what", "how", "why", "does", "this", "that", "with", "from", "are", "is", "of", "to", "in", "on", "it",
    "which", "its", "they", "their", "them", "there", "these", "those", "was", "were", "has", "have", "had", "can", "will", "would",
    "should", "could", "into", "than", "then", "when", "where", "who", "whom", "whose", "you", "your", "our", "we", "not", "but",
    "all", "any", "also", "about", "did", "do", "be", "been", "an", "as", "at", "by", "or", "if", "so", "my", "me",
    "el", "la", "los", "las", "de", "del", "que", "qué", "como", "cómo", "por", "para", "con", "una", "uno", "un", "es", "en", "se",
    "su", "sus", "al", "lo", "y", "o", "este", "esta", "esto", "usa", "hace", "cuál", "cual", "cuando", "cuándo", "donde", "dónde",
    "quién", "quien", "ese", "esa", "eso", "estos", "estas", "esos", "esas", "sobre", "entre", "pero", "sin", "ya", "le", "les",
    "nos", "mi", "mis", "tu", "tus", "más", "muy", "son", "está", "están", "ser", "fue", "han", "hay",
];

/// `text` folded the way the FTS tokenizer folds it (lowercase, no diacritics), as its words.
fn folded_words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(fold).collect()
}

/// Lowercase without the accents Spanish writes — `remove_diacritics 2` does the same to the index,
/// so "días" in a question and "dias" in a file are one word to both.
pub fn fold(word: &str) -> String {
    word.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            other => other,
        })
        .collect()
}

/// Which of `terms` a hit contains, by the prefix rule the FTS query uses. A `snake_case` term is
/// the run of its parts, as the tokenizer splits it.
pub fn matched_terms<'a>(terms: &'a [Term], hit: &Hit) -> Vec<&'a Term> {
    matched_in(terms, &format!("{} {} {}", hit.title, hit.heading, hit.text), false)
}

/// Which of `terms` `text` contains. `stems`: a long plain word counts by its first six letters, so
/// "validación" finds "validamos" and "registro" "registrar" — Spanish conjugates where the FTS
/// query's prefix rule cannot follow.
fn matched_in<'a>(terms: &'a [Term], text: &str, stems: bool) -> Vec<&'a Term> {
    let words = folded_words(text);
    terms
        .iter()
        .filter(|term| {
            let parts: Vec<String> = term.word.split('_').filter(|p| !p.is_empty()).map(fold).collect();
            match parts.as_slice() {
                [] => false,
                [only] => {
                    let wanted: String = if stems && !term.code_like { only.chars().take(STEM_CHARS).collect() } else { only.clone() };
                    words.iter().any(|w| w.starts_with(wanted.as_str()))
                }
                parts => words.windows(parts.len()).any(|run| {
                    run.iter().zip(parts).enumerate().all(|(i, (w, p))| if i + 1 == parts.len() { w.starts_with(p.as_str()) } else { w == p })
                }),
            }
        })
        .collect()
}

/// The letters a plain word is matched by in [`covers`].
const STEM_CHARS: usize = 6;

/// Whether `text` answers to the question's `terms` well enough to be put in front of a model that
/// did not ask for it: every word of a one- or two-word question, half of a longer one (two at
/// least), or one word that looks like code. Stricter than the search's own floor
/// (`knowledge::relevant`), which only has to keep a result worth listing to a model that searched.
pub fn covers(terms: &[Term], text: &str) -> bool {
    if terms.is_empty() {
        return false;
    }
    let matched = matched_in(terms, text, true);
    if matched.iter().any(|t| t.code_like) {
        return true;
    }
    let needed = if terms.len() <= 2 { terms.len() } else { 2.max(terms.len().div_ceil(2)) };
    matched.len() >= needed
}

fn placeholders(n: usize, from: usize) -> String {
    (0..n).map(|i| format!("?{}", i + from)).collect::<Vec<_>>().join(", ")
}

const HIT_COLUMNS: &str = "c.id, s.collection, s.path, c.start_line, c.end_line, c.heading, c.text, c.prose, s.private, s.title, s.label";

/// The `limit` best chunks of `collections` for `question` by bm25 (heading weighed double), with
/// their bm25 — lower is better, as SQLite has it. `include_private`: local-only sources too (a
/// local model asks).
pub fn search_fts_ranked(conn: &Connection, collections: &[String], question: &str, limit: usize, include_private: bool) -> rusqlite::Result<Vec<(Hit, f64)>> {
    let Some(query) = fts_query(question) else { return Ok(Vec::new()) };
    if collections.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {HIT_COLUMNS}, bm25(chunks_fts, 2.0, 1.0)
         FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN sources s ON s.id = c.source_id
         WHERE chunks_fts MATCH ?1 AND s.collection IN ({}) {}
         ORDER BY bm25(chunks_fts, 2.0, 1.0) LIMIT {}",
        placeholders(collections.len(), 2),
        if include_private { "" } else { "AND s.private = 0" },
        limit
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&query];
    for c in collections {
        values.push(c);
    }
    let rows = stmt.query_map(values.as_slice(), |r| Ok((row_to_hit(r)?, r.get::<_, f64>(11)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// [`search_fts_ranked`] without the ranks, private sources included.
#[cfg(test)]
pub fn search_fts(conn: &Connection, collections: &[String], question: &str, limit: usize) -> rusqlite::Result<Vec<Hit>> {
    Ok(search_fts_ranked(conn, collections, question, limit, true)?.into_iter().map(|(hit, _)| hit).collect())
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
        private: r.get(8)?,
        title: r.get(9)?,
        label: r.get(10)?,
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
    tx.commit()?;
    written();
    Ok(())
}

/// One stored vector, normalised, with what a search filters it by.
struct Unit {
    chunk_id: i64,
    collection: Arc<str>,
    private: bool,
    vector: Vec<f32>,
}

/// A space's vectors held in memory: a search used to read and decode every vector of the space from
/// SQLite for each question. Kept for one space (the configured one — there is rarely another) and
/// one index file, dropped when the index changes ([`GENERATION`]) or after [`VECTOR_IDLE`] unused.
struct SpaceCache {
    path: String,
    space: String,
    generation: u64,
    units: Arc<Vec<Unit>>,
    used: Instant,
}

static VECTOR_CACHE: Mutex<Option<SpaceCache>> = Mutex::new(None);
static EVICTOR: AtomicBool = AtomicBool::new(false);
/// A space larger than this is read from the database per question rather than held.
const VECTOR_CACHE_BYTES: usize = 192 << 20;
const VECTOR_IDLE: Duration = Duration::from_secs(10 * 60);

fn normalised(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut vector {
            *x /= norm;
        }
    }
    vector
}

fn load_units(conn: &Connection, space: &str) -> rusqlite::Result<Vec<Unit>> {
    let mut stmt = conn.prepare(
        "SELECT v.chunk_id, s.collection, s.private, v.data FROM vectors v JOIN chunks c ON c.id = v.chunk_id JOIN sources s ON s.id = c.source_id
         WHERE v.space = ?1",
    )?;
    let mut names: HashMap<String, Arc<str>> = HashMap::new();
    let rows = stmt
        .query_map(params![space], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?, r.get::<_, Vec<u8>>(3)?)))?
        .filter_map(Result::ok)
        .map(|(chunk_id, collection, private, blob)| {
            let collection = names.entry(collection.clone()).or_insert_with(|| Arc::from(collection.as_str())).clone();
            Unit { chunk_id, collection, private, vector: normalised(from_blob(&blob)) }
        })
        .collect();
    Ok(rows)
}

/// The space's vectors, from memory when they are current there.
fn units(conn: &Connection, space: &str) -> rusqlite::Result<Arc<Vec<Unit>>> {
    let path = conn.path().unwrap_or_default().to_string();
    let generation = GENERATION.load(Ordering::SeqCst);
    // An in-memory database (a test) has no identity to cache under.
    if path.is_empty() {
        return Ok(Arc::new(load_units(conn, space)?));
    }
    if let Ok(mut cache) = VECTOR_CACHE.lock() {
        if let Some(entry) = cache.as_mut().filter(|c| c.path == path && c.space == space && c.generation == generation) {
            entry.used = Instant::now();
            return Ok(entry.units.clone());
        }
    }
    let units = Arc::new(load_units(conn, space)?);
    let bytes: usize = units.iter().map(|u| u.vector.len() * 4 + 32).sum();
    if bytes <= VECTOR_CACHE_BYTES {
        if let Ok(mut cache) = VECTOR_CACHE.lock() {
            *cache = Some(SpaceCache { path, space: space.to_string(), generation, units: units.clone(), used: Instant::now() });
        }
        start_evictor();
    }
    Ok(units)
}

/// A thread that lets the held space go once nobody has searched for [`VECTOR_IDLE`] — the copy is
/// tens of megabytes, worth keeping while questions come and not for the rest of the day.
fn start_evictor() {
    if EVICTOR.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        let Ok(mut cache) = VECTOR_CACHE.lock() else { break };
        let idle = cache.as_ref().is_none_or(|c| c.used.elapsed() >= VECTOR_IDLE);
        if idle {
            *cache = None;
            EVICTOR.store(false, Ordering::SeqCst);
            break;
        }
    });
}

/// The `limit` chunks of `collections` closest to `query` in `space`, by cosine — exhaustively over
/// the space held in memory, which for the tens of thousands of prose chunks a workspace has is a
/// few milliseconds. `include_private`: local-only sources too.
pub fn search_vectors_scoped(conn: &Connection, space: &str, collections: &[String], query: &[f32], limit: usize, include_private: bool) -> rusqlite::Result<Vec<(Hit, f32)>> {
    if collections.is_empty() || query.is_empty() {
        return Ok(Vec::new());
    }
    let wanted: HashSet<&str> = collections.iter().map(String::as_str).collect();
    let query = normalised(query.to_vec());
    let units = units(conn, space)?;
    let mut scored: Vec<(i64, f32)> = units
        .iter()
        .filter(|u| (include_private || !u.private) && wanted.contains(&*u.collection) && u.vector.len() == query.len())
        .map(|u| (u.chunk_id, u.vector.iter().zip(&query).map(|(a, b)| a * b).sum::<f32>()))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    if scored.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {HIT_COLUMNS} FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id IN ({})",
        placeholders(scored.len(), 1)
    );
    let mut stmt = conn.prepare(&sql)?;
    let ids: Vec<&dyn rusqlite::ToSql> = scored.iter().map(|(id, _)| id as &dyn rusqlite::ToSql).collect();
    let mut hits: HashMap<i64, Hit> = stmt.query_map(ids.as_slice(), row_to_hit)?.filter_map(Result::ok).map(|h| (h.chunk_id, h)).collect();
    Ok(scored.into_iter().filter_map(|(id, score)| hits.remove(&id).map(|hit| (hit, score))).collect())
}

/// [`search_vectors_scoped`] with private sources included.
#[cfg(test)]
pub fn search_vectors(conn: &Connection, space: &str, collections: &[String], query: &[f32], limit: usize) -> rusqlite::Result<Vec<(Hit, f32)>> {
    search_vectors_scoped(conn, space, collections, query, limit, true)
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

    pub(crate) mod tempdir {
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
    fn a_watched_path_is_re_read_alone_and_an_ignored_one_dropped() {
        let (dir, mut conn) = fixture();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(dir.0.join("src.ts"), "export function grandTotal(items) {}\n").unwrap();
        std::fs::write(dir.0.join("new.md"), "# Fresh\n\nA page the walk has not seen.\n").unwrap();
        let rels = vec!["src.ts".to_string(), "new.md".to_string(), "docs/adr.md".to_string()];
        let done = refresh_paths(&mut &mut conn, "repo:p", &dir.0, &rels, &|rel| rel != "docs/adr.md").unwrap();
        assert_eq!((done.added, done.updated, done.removed), (1, 1, 1));
        assert_eq!(search_fts(&conn, &["repo:p".to_string()], "grandTotal", 5).unwrap()[0].path, "src.ts");
        assert!(search_fts(&conn, &["repo:p".to_string()], "sqlite", 5).unwrap().is_empty(), "the ignored file left the index");
    }

    #[test]
    fn the_commit_a_collection_was_indexed_at_is_kept_until_another_is_named() {
        let (dir, mut conn) = fixture();
        refresh_files(&mut &mut conn, "repo:p", &dir.0, &files(), Some("abc1234")).unwrap();
        assert_eq!(meta(&conn, "repo:p").unwrap().1, "abc1234");
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        assert_eq!(status(&conn, "repo:p", None).unwrap().head, "abc1234", "a refresh that names no commit keeps it");
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
    fn terms_know_what_looks_like_code_and_what_a_hit_contains() {
        let terms = query_terms("¿Cuántos días guarda apply_discount en cartTotal?");
        let words: Vec<&str> = terms.iter().map(|t| t.word.as_str()).collect();
        assert_eq!(words, vec!["cuántos", "días", "guarda", "apply_discount", "carttotal"]);
        assert_eq!(terms.iter().filter(|t| t.code_like).count(), 2);
        let hit = Hit {
            chunk_id: 1,
            collection: "repo:p".into(),
            path: "a.md".into(),
            start_line: 1,
            end_line: 1,
            heading: String::new(),
            text: "Se guardan 90 dias; apply_discount() lo calcula".into(),
            prose: true,
            private: false,
            title: String::new(),
            label: String::new(),
        };
        let matched: Vec<&str> = matched_terms(&terms, &hit).iter().map(|t| t.word.as_str()).collect();
        assert_eq!(matched, vec!["días", "guarda", "apply_discount"], "accents fold and prefixes match, as in the FTS");
    }

    #[test]
    fn a_passage_covers_a_question_by_most_of_its_words_or_one_that_looks_like_code() {
        let terms = query_terms("¿cómo validamos el formulario de registro?");
        assert!(covers(&terms, "La validación del formulario usa zod; el registro manda un correo."), "stems follow Spanish conjugation");
        assert!(!covers(&terms, "El formulario de contacto tiene tres campos."), "one word of three is not the question");
        assert!(covers(&query_terms("¿qué hace cartTotal?"), "export function cartTotal(items) {"), "one word that looks like code is enough");
        let two = query_terms("login flujo");
        assert!(!covers(&two, "El login usa OAuth."), "a two-word question needs both");
        assert!(covers(&two, "El flujo de login usa OAuth."));
        assert!(!covers(&[], "anything"));
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
        assert!(has_vectors(&conn, "s1", &cols) && !has_vectors(&conn, "s2", &cols));
    }

    /// The held copy of a space follows the index: a vector stored after the first search is found
    /// by the second, and a file whose chunks went takes its vectors out of the copy too.
    #[test]
    fn the_vectors_held_in_memory_follow_every_write() {
        let (dir, mut conn) = fixture();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        let cols = vec!["repo:p".to_string()];
        let pending = pending_vectors(&conn, "s1", &cols, 100).unwrap();
        store_vectors(&mut conn, "s1", &[(pending[0].0, vec![1.0, 0.0])]).unwrap();
        assert_eq!(search_vectors(&conn, "s1", &cols, &[0.0, 1.0], 5).unwrap().len(), 1);
        store_vectors(&mut conn, "s1", &[(pending[1].0, vec![0.0, 1.0])]).unwrap();
        let both = search_vectors(&conn, "s1", &cols, &[0.0, 1.0], 5).unwrap();
        assert_eq!(both.len(), 2);
        assert_eq!(both[0].0.heading, "Retention", "the new vector is in the held copy");
        refresh(&mut conn, "repo:p", &dir.0, &["src.ts".to_string()]).unwrap();
        assert!(search_vectors(&conn, "s1", &cols, &[0.0, 1.0], 5).unwrap().is_empty(), "the removed file's vectors left it");
    }

    #[test]
    fn documents_are_loaded_only_when_their_version_moves_and_private_ones_stay_local() {
        let mut conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let stamp = |path: &str, version: &str, private: bool| DocStamp { path: path.into(), version: version.into(), private, title: format!("Title {path}"), label: "Book".into() };
        let body = |text: &str| DocBody { kind: Kind::Markdown, prose: true, text: text.into() };
        let stamps = vec![stamp("note:a", "1", false), stamp("note:b", "1", true)];
        assert_eq!(docs_to_load(&conn, "notes:w", &stamps).unwrap(), vec!["note:a", "note:b"]);
        let bodies: HashMap<String, DocBody> =
            [("note:a".to_string(), body("Los pedidos se guardan 90 días.")), ("note:b".to_string(), body("Sueldos del almacén."))].into_iter().collect();
        let done = apply_docs(&mut conn, "notes:w", "notes", &stamps, &bodies, None).unwrap();
        assert_eq!(done.added, 2);
        assert!(docs_to_load(&conn, "notes:w", &stamps).unwrap().is_empty(), "same versions: nothing to load");
        let cols = vec!["notes:w".to_string()];
        let local = search_fts_ranked(&conn, &cols, "almacén sueldos", 5, true).unwrap();
        assert_eq!(local[0].0.path, "note:b");
        assert_eq!(local[0].0.heading, "Title note:b", "the title rides the heading");
        assert!(search_fts_ranked(&conn, &cols, "almacén sueldos", 5, false).unwrap().is_empty(), "never for a cloud engine");
        // The book turned shareable: no reload, the flag follows.
        let opened = vec![stamp("note:a", "1", false), stamp("note:b", "1", false)];
        let done = apply_docs(&mut conn, "notes:w", "notes", &opened, &HashMap::new(), None).unwrap();
        assert_eq!(done.unchanged, 2);
        assert_eq!(search_fts_ranked(&conn, &cols, "sueldos", 5, false).unwrap().len(), 1);
        // A note that left the set goes with its chunks.
        let done = apply_docs(&mut conn, "notes:w", "notes", &opened[..1], &HashMap::new(), None).unwrap();
        assert_eq!(done.removed, 1);
        assert!(search_fts(&conn, &cols, "sueldos", 5).unwrap().is_empty());
    }

    #[test]
    fn secrets_never_reach_the_index() {
        let (dir, mut conn) = fixture();
        // Built at run time so the source never holds a token-shaped literal (GitHub push protection).
        let token = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        std::fs::write(dir.0.join(".env.md"), format!("token: {token}\n")).unwrap();
        refresh(&mut conn, "repo:p", &dir.0, &[".env.md".to_string()]).unwrap();
        assert!(search_fts(&conn, &["repo:p".to_string()], &token, 5).unwrap().is_empty());
        let stamps = vec![DocStamp { path: "note:s".into(), version: "1".into(), private: false, title: String::new(), label: String::new() }];
        let bodies: HashMap<String, DocBody> = [("note:s".to_string(), DocBody { kind: Kind::Text, prose: true, text: format!("deploy with {token}") })].into_iter().collect();
        apply_docs(&mut conn, "notes:w", "notes", &stamps, &bodies, None).unwrap();
        assert!(search_fts(&conn, &["notes:w".to_string()], &token, 5).unwrap().is_empty(), "nor through a note");
    }
}
