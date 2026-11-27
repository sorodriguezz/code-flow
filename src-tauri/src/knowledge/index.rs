//! The knowledge index: a database of its own (`paths::knowledge_dir()/index.sqlite`) — chunks of
//! every indexed file and document, an FTS5 index over them, and the vectors of the prose ones —
//! and of the code ones when the setting allows it ([`embeddable`]).
//!
//! Rebuildable, but not a cache: the chunks come back from the files in seconds, the vectors only
//! from hours of embedder time. So it lives under the state root (it was under the cache root
//! through 2.9.2, where «Liberar caché» could take it — [`adopt_legacy`] moves it), is never backed
//! up, and is kept out of `codeflow.db` so a repository's chunks do not multiply every backup.
//!
//! **Vectors belong to text, not to chunks** (`embeddings`, keyed by [`embed_hash`] of what was
//! embedded, and model). A chunk has a vector when an embedding of its `embed_hash` exists in the
//! space. Deleting chunks — a file changed, a branch switched, a collection pruned, «Vaciar índice»,
//! a full re-index — never deletes a vector: the same text indexed again has its vector at once.
//! Until 2.9.2 vectors were rows keyed by `chunk_id` and cascaded with their chunks, and one rebuild
//! of the chunks cost every vector (user, 2026-11-23: 46k vectors, back to zero). A vector no chunk
//! points at waits [`ORPHAN_KEEP_MS`] (at most [`ORPHAN_MAX_ROWS`] of them) in case its text comes
//! back, then [`prune_orphan_vectors`] lets it go. Only deliberate actions drop live vectors: a
//! model removed ([`drop_space`], [`remove_space`]) or code vectors switched off
//! ([`drop_code_vectors`]).
//!
//! Two kinds of source share the tables. **Files** (repositories, folders) are incremental by stat:
//! a file whose size and modification time match the stored ones is not read again; one whose
//! content hash matches is not re-chunked. **Documents** (notes, meetings, generated wiki pages,
//! story drafts, review findings, commit messages) are rows of the app's database or of git, kept by
//! a version string the caller chooses (`updated_at`, a commit id): a document whose version matches
//! is not loaded again. Either way what left the set is dropped with its chunks (cascades, and FTS
//! triggers keep the index in step); their vectors stay, as above.
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

use rusqlite::{params, Connection, OpenFlags};
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
    crate::paths::knowledge_dir().join("index.sqlite")
}

/// Where the index lived through 2.9.2: the cache root.
fn legacy_path() -> PathBuf {
    if cfg!(test) {
        return std::env::temp_dir().join(format!("codeflow-test-knowledge-legacy-{}", std::process::id())).join("index.sqlite");
    }
    crate::paths::cache_dir().join("knowledge").join("index.sqlite")
}

/// Moves an index left at `legacy` (the cache root of 2.9.2 and before) to `target`, once: when
/// `target` does not exist yet. Copied with `VACUUM INTO` rather than renamed — the database is three
/// files (`-wal`, `-shm`) and a rename that moved one and failed on the next would leave neither copy
/// whole; `VACUUM INTO` writes one consistent file with the WAL folded in, to a temporary name renamed
/// into place, and only then is the old one removed. `Ok(true)` when it moved something.
pub fn adopt_legacy(legacy: &Path, target: &Path) -> Result<bool, String> {
    if target.exists() || !legacy.exists() {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let moving = target.with_extension("sqlite.moving");
    let _ = std::fs::remove_file(&moving);
    {
        let old = Connection::open(legacy).map_err(|e| e.to_string())?;
        old.execute("VACUUM INTO ?1", params![moving.to_string_lossy()]).map_err(|e| {
            let _ = std::fs::remove_file(&moving);
            e.to_string()
        })?;
    }
    std::fs::rename(&moving, target).map_err(|e| e.to_string())?;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", legacy.to_string_lossy()));
    }
    Ok(true)
}

struct GlobalIndex {
    path: PathBuf,
    writer: Mutex<Connection>,
}

fn global_index() -> Result<&'static GlobalIndex, String> {
    static INDEX: OnceLock<GlobalIndex> = OnceLock::new();
    static OPENING: Mutex<()> = Mutex::new(());
    if let Some(index) = INDEX.get() {
        return Ok(index);
    }
    // Two first callers must not both copy the old file.
    let _opening = OPENING.lock().map_err(|e| e.to_string())?;
    if let Some(index) = INDEX.get() {
        return Ok(index);
    }
    let target = default_path();
    let path = match adopt_legacy(&legacy_path(), &target) {
        Ok(moved) => {
            if moved {
                crate::applog::info(&format!("knowledge: the index moved out of the cache to {}", target.display()));
            }
            target
        }
        Err(error) => {
            crate::applog::warn(&format!("knowledge: the index could not be moved out of the cache ({error}); using it where it is"));
            legacy_path()
        }
    };
    let writer = Mutex::new(open_at(&path)?);
    Ok(INDEX.get_or_init(|| GlobalIndex { path, writer }))
}

/// Opens or migrates the index on first use, and serializes access to its writer.
pub fn global() -> Result<MutexGuard<'static, Connection>, String> {
    global_index()?.writer.lock().map_err(|e| e.to_string())
}

/// Reads committed data from the WAL without waiting for the writer's current batch.
pub fn open_reader() -> Result<Connection, String> {
    Connection::open_with_flags(&global_index()?.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())
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
    // `rank`: how many files of its repository import a code file (the code map's), so the most
    // depended-on code gets its vectors first ([`pending_vectors`], [`set_ranks`]). 0 for the rest.
    add_column(conn, "sources", "rank", "INTEGER NOT NULL DEFAULT 0")?;
    // `embed_hash`: [`embed_hash`] of what the chunk is embedded as (heading, newline, text) — the key
    // its vector is found by in `embeddings`.
    add_column(conn, "chunks", "embed_hash", "TEXT NOT NULL DEFAULT ''")?;
    // The vectors, by the text they were made from and the model that made them (see the module's
    // doc). `code`: made of a code chunk, for [`drop_code_vectors`]. `used_at`: when a chunk last
    // pointed at it — set when the vector is stored and when the chunks pointing at it are deleted, so
    // an orphan's age counts from the moment it was left ([`prune_orphan_vectors`]).
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_chunks_embed ON chunks(embed_hash);
         CREATE TABLE IF NOT EXISTS embeddings (
             hash    TEXT NOT NULL,
             space   TEXT NOT NULL,
             data    BLOB NOT NULL,
             code    INTEGER NOT NULL DEFAULT 0,
             used_at INTEGER NOT NULL,
             PRIMARY KEY (hash, space)
         );
         CREATE INDEX IF NOT EXISTS idx_embeddings_space ON embeddings(space);",
    )?;
    migrate_vectors(conn)
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)", params![name], |r| r.get(0))
}

/// Brings an index of 2.9.2 or before to vectors by text, in one transaction: every chunk gets its
/// `embed_hash`, every vector of the old `vectors` table (by `chunk_id`) and of the old
/// `vector_cache` (already by text) moves to `embeddings`, and the two old tables go. A failure rolls
/// all of it back and the index stays as it was — never half moved, never emptied. Also fills the
/// `embed_hash` of any chunk written without one, which on a current index is none (one indexed
/// probe).
fn migrate_vectors(conn: &Connection) -> rusqlite::Result<()> {
    let old_vectors = table_exists(conn, "vectors")?;
    let old_cache = table_exists(conn, "vector_cache")?;
    let unhashed: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM chunks WHERE embed_hash = '')", [], |r| r.get(0))?;
    if !old_vectors && !old_cache && !unhashed {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let tx = conn.unchecked_transaction()?;
    let hashes: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, heading, text FROM chunks WHERE embed_hash = ''")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        rows.map(|row| row.map(|(id, heading, text)| (id, embed_hash_of(&heading, &text)))).collect::<rusqlite::Result<_>>()?
    };
    {
        let mut update = tx.prepare("UPDATE chunks SET embed_hash = ?1 WHERE id = ?2")?;
        for (id, hash) in &hashes {
            update.execute(params![hash, id])?;
        }
    }
    let mut moved = 0usize;
    if old_vectors {
        moved += tx.execute(
            "INSERT OR IGNORE INTO embeddings (hash, space, data, code, used_at)
             SELECT c.embed_hash, v.space, v.data, s.kind = 'code' AND c.prose = 0, ?1
             FROM vectors v JOIN chunks c ON c.id = v.chunk_id JOIN sources s ON s.id = c.source_id",
            params![now],
        )?;
        tx.execute_batch("DROP TABLE vectors;")?;
    }
    if old_cache {
        moved += tx.execute(
            "INSERT OR IGNORE INTO embeddings (hash, space, data, code, used_at) SELECT hash, space, data, code, kept_at FROM vector_cache",
            [],
        )?;
        tx.execute_batch("DROP TABLE vector_cache;")?;
    }
    tx.commit()?;
    if old_vectors || old_cache {
        // Not in tests: the log is the app's, and a test's index is a temporary file.
        if !cfg!(test) {
            crate::applog::info(&format!("knowledge: {moved} vectors moved to vectors by text; {} passages hashed", hashes.len()));
        }
    }
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
    pub(crate) fn changed(&self) -> bool {
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

/// Writes one chunk with the [`embed_hash`] of what it is embedded as — the key that finds a vector
/// made of the same text before, whatever chunk it was made for.
fn insert_chunk(conn: &Connection, source_id: i64, start_line: u32, end_line: u32, heading: &str, text: &str, prose: bool) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO chunks (source_id, start_line, end_line, heading, text, prose, embed_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![source_id, start_line, end_line, heading, text, prose, embed_hash_of(heading, text)],
    )?;
    Ok(())
}

/// Marks the vectors of `source_id`'s chunks as left now, before the chunks are deleted: the vectors
/// stay (see the module's doc), and an orphan's wait ([`ORPHAN_KEEP_MS`]) counts from here.
fn leave_vectors(conn: &Connection, source_id: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE embeddings SET used_at = ?2 WHERE hash IN (SELECT embed_hash FROM chunks WHERE source_id = ?1)", params![source_id, now])?;
    Ok(())
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
                leave_vectors(&tx, id, now)?;
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
                        leave_vectors(&tx, id, now)?;
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
                    insert_chunk(&tx, source_id, piece.start_line, piece.end_line, &piece.heading, &piece.text, kind != Kind::Code)?;
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
            leave_vectors(&tx, k.id, now)?;
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
                leave_vectors(&tx, k.id, now)?;
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
            insert_chunk(&tx, source_id, piece.start_line, piece.end_line, &heading, &piece.text, body.prose)?;
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

/// Drops `collection`'s sources and chunks. Their vectors stay, waiting for the same text to be
/// indexed again ([`prune_orphan_vectors`]).
pub fn remove_collection(conn: &Connection, collection: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE embeddings SET used_at = ?2 WHERE hash IN
           (SELECT c.embed_hash FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.collection = ?1)",
        params![collection, chrono::Utc::now().timestamp_millis()],
    )?;
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
    let removed = conn.execute("DELETE FROM embeddings WHERE substr(space, 1, length(?1)) = ?1", params![prefix])?;
    written();
    Ok(removed)
}

/// Drops the vectors of exactly the space `space`.
pub fn remove_space_exact(conn: &Connection, space: &str) -> rusqlite::Result<usize> {
    let removed = conn.execute("DELETE FROM embeddings WHERE space = ?1", params![space])?;
    written();
    Ok(removed)
}

/// Every embedding space the index holds vectors of.
pub fn spaces(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT space FROM embeddings")?;
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
            "SELECT COUNT(*) FROM chunks c JOIN sources s ON s.id = c.source_id JOIN embeddings e ON e.hash = c.embed_hash AND e.space = ?2
             WHERE s.collection = ?1",
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
pub fn has_vectors(conn: &Connection, space: &str, collections: &[String]) -> rusqlite::Result<bool> {
    if collections.is_empty() {
        return Ok(false);
    }
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM chunks c JOIN sources s ON s.id = c.source_id JOIN embeddings e ON e.hash = c.embed_hash AND e.space = ?1
         WHERE s.collection IN ({}))",
        placeholders(collections.len(), 2)
    );
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&space];
    for c in collections {
        values.push(c);
    }
    conn.query_row(&sql, values.as_slice(), |r| r.get::<_, bool>(0))
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

/// Which chunks get vectors, as a `WHERE` term over `chunks c JOIN sources s`: the prose ones, and
/// with `code` the code files' too (`super::KEY_CODE_VECTORS`). Code got none until the bench
/// measured them (`super::code_bench`, 2026-11-17): a question that describes code without naming
/// it found its file in the first five 22% of the time in Spanish by words and the map, 83% by
/// vectors. Commit messages stay lexical either way — they are text, not code.
pub fn embeddable(code: bool) -> &'static str {
    if code {
        "(c.prose = 1 OR s.kind = 'code')"
    } else {
        "c.prose = 1"
    }
}

/// Chunks of `collections` with no vector in `space` yet ([`embeddable`]), the most useful first:
/// what semantic search is for — notes, documents, folders, decision records (`.md`, `.txt`) —
/// before code and commit messages; within code, the files most of the repository imports
/// ([`set_ranks`]) — the ones a question about how something works most often lands on — and
/// within each, what was indexed most recently (a file just changed) before what has sat there for
/// weeks. It was oldest first: a backlog of thousands spent its first hour on old code while the new
/// ADR waited (2026-11-09).
pub fn pending_vectors(conn: &Connection, space: &str, collections: &[String], limit: usize, code: bool) -> rusqlite::Result<Vec<(i64, String)>> {
    if collections.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT c.id, c.heading || char(10) || c.text FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE {} AND s.collection IN ({})
           AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.hash = c.embed_hash AND e.space = ?1)
         ORDER BY
           CASE WHEN s.collection LIKE 'notes:%' OR s.collection LIKE 'docs:%' OR s.collection LIKE 'folder:%' THEN 0
                WHEN s.kind IN ('markdown', 'text') THEN 1
                WHEN s.collection LIKE 'commits:%' THEN 3
                ELSE 2 END,
           s.rank DESC,
           s.indexed_at DESC,
           c.id
         LIMIT {}",
        embeddable(code),
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

/// The vectors held for one embedding model, across every workspace: how many, and the bytes their
/// data takes (the index's own overhead aside).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUsage {
    pub space: String,
    pub vectors: usize,
    pub bytes: u64,
}

/// Every embedding model with vectors in the index, the largest first. A model switched away from
/// keeps its vectors (switching back reuses them), and this is how the settings pane can say what
/// they cost and offer to let them go. `vectors`: the ones a passage of the index points at; `bytes`:
/// all of the model's, the ones waiting for their text to come back included — «Borrar» frees them
/// with the rest.
pub fn space_usage(conn: &Connection) -> rusqlite::Result<Vec<SpaceUsage>> {
    let mut stmt = conn.prepare(
        "SELECT e.space, SUM(EXISTS (SELECT 1 FROM chunks c WHERE c.embed_hash = e.hash)), COALESCE(SUM(LENGTH(e.data)), 0)
         FROM embeddings e GROUP BY e.space ORDER BY 3 DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SpaceUsage { space: r.get(0)?, vectors: r.get::<_, i64>(1)?.max(0) as usize, bytes: r.get::<_, i64>(2)?.max(0) as u64 })
    })?;
    rows.collect()
}

/// Drops every vector of one embedding model — the user's «Borrar» on it. The chunks stay; choosing
/// the model again embeds them anew. Returns how many went.
pub fn drop_space(conn: &Connection, space: &str) -> rusqlite::Result<usize> {
    let removed = conn.execute("DELETE FROM embeddings WHERE space = ?1", params![space])?;
    written();
    Ok(removed)
}

/// How many chunks of `collections` that get vectors ([`embeddable`]) still have none in `space` —
/// what a vectorizing pass has left, for its progress.
pub fn count_pending_vectors(conn: &Connection, space: &str, collections: &[String], code: bool) -> rusqlite::Result<usize> {
    if collections.is_empty() {
        return Ok(0);
    }
    let sql = format!(
        "SELECT COUNT(*) FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE {} AND s.collection IN ({})
           AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.hash = c.embed_hash AND e.space = ?1)",
        embeddable(code),
        placeholders(collections.len(), 2),
    );
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&space];
    for c in collections {
        values.push(c);
    }
    conn.query_row(&sql, values.as_slice(), |r| r.get::<_, i64>(0)).map(|n| n.max(0) as usize)
}

/// Writes how many files import each of `ranks`' paths in `collection` — read off the code map by
/// the vectorizing pass ([`pending_vectors`] orders code by it). Only rows whose rank changed are
/// written; a path the index does not hold is ignored. Not a change a search can see, so the held
/// vectors stay current. Returns how many rows changed.
pub fn set_ranks(conn: &mut Connection, collection: &str, ranks: &[(String, i64)]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut changed = 0;
    {
        let mut stmt = tx.prepare("UPDATE sources SET rank = ?3 WHERE collection = ?1 AND path = ?2 AND rank != ?3")?;
        for (path, rank) in ranks {
            changed += stmt.execute(params![collection, path, rank])?;
        }
    }
    tx.commit()?;
    Ok(changed)
}

/// Drops the vectors of every code chunk, in every model — code vectors switched off. The chunks
/// stay, lexical as before; switching back embeds them anew. A vector a prose chunk shares (the same
/// text in a Markdown file) stays. Returns how many live vectors went.
pub fn drop_code_vectors(conn: &Connection) -> rusqlite::Result<usize> {
    let removed = conn.execute(
        "DELETE FROM embeddings WHERE hash IN
           (SELECT c.embed_hash FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.prose = 0 AND s.kind = 'code')
           AND hash NOT IN (SELECT embed_hash FROM chunks WHERE prose = 1)",
        [],
    )?;
    conn.execute("DELETE FROM embeddings WHERE code = 1 AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.embed_hash = embeddings.hash)", [])?;
    written();
    Ok(removed)
}

/// Stores the vectors the embedder made for `items` (chunk id, vector), under the text each chunk
/// holds — so every chunk with that text, now or later, has it. A chunk deleted while its vector was
/// being made stores nothing, rather than failing the pass (it used to: «FOREIGN KEY constraint
/// failed» stopped vectorizing, 2026-11-19).
pub fn store_vectors(conn: &mut Connection, space: &str, items: &[(i64, Vec<f32>)]) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO embeddings (hash, space, data, code, used_at)
             SELECT c.embed_hash, ?2, ?3, s.kind = 'code' AND c.prose = 0, ?4 FROM chunks c JOIN sources s ON s.id = c.source_id
             WHERE c.id = ?1 AND c.embed_hash != ''",
        )?;
        for (chunk_id, vector) in items {
            stmt.execute(params![chunk_id, space, to_blob(vector), now])?;
        }
    }
    tx.commit()?;
    written();
    Ok(())
}

/// What a vector is made from, as [`pending_vectors`] hands it to the embedder: the heading, a
/// newline, the text — hashed. The key of `embeddings`.
pub(crate) fn embed_hash_of(heading: &str, text: &str) -> String {
    embed_hash(&format!("{heading}\n{text}"))
}

fn embed_hash(input: &str) -> String {
    format!("{:x}", Sha256::digest(input.as_bytes()))
}

/// How long a vector no passage points at any more waits for its text to come back (a branch
/// switched back to, a file reverted, a collection indexed again), and how many such vectors are kept
/// at most — the longest-left go first. Vectors a passage points at are never let go by age or count.
pub const ORPHAN_KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const ORPHAN_MAX_ROWS: i64 = 100_000;

/// Lets go of the vectors no passage has pointed at for [`ORPHAN_KEEP_MS`], and of the longest-left
/// past [`ORPHAN_MAX_ROWS`]. Returns how many went.
pub fn prune_orphan_vectors(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    let orphan = "NOT EXISTS (SELECT 1 FROM chunks c WHERE c.embed_hash = e.hash)";
    let old = conn.execute(&format!("DELETE FROM embeddings AS e WHERE e.used_at < ?1 AND {orphan}"), params![now - ORPHAN_KEEP_MS])?;
    let over = conn.execute(
        &format!("DELETE FROM embeddings WHERE rowid IN (SELECT e.rowid FROM embeddings e WHERE {orphan} ORDER BY e.used_at DESC LIMIT -1 OFFSET ?1)"),
        params![ORPHAN_MAX_ROWS],
    )?;
    if old + over > 0 {
        written();
    }
    Ok(old + over)
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
/// A space larger than this is read from the database per question rather than held. It was
/// 192 MiB while only prose had vectors; code roughly doubles a workspace's count (a 1,024-dimension
/// vector is 4 KiB: 96k of them fit), and reading them all from SQLite for every question is
/// seconds, not milliseconds. The copy is let go after [`VECTOR_IDLE`] unused.
const VECTOR_CACHE_BYTES: usize = 384 << 20;
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
        "SELECT c.id, s.collection, s.private, e.data FROM chunks c JOIN embeddings e ON e.hash = c.embed_hash AND e.space = ?1
         JOIN sources s ON s.id = c.source_id",
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
/// the space held in memory, which for the tens of thousands of chunks a workspace has is a few
/// milliseconds. `include_private`: local-only sources too.
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

    /// A branch switched away from and back: the passages that left keep their vectors, and coming
    /// back finds them at once — nothing is pending, nothing goes to the embedder.
    #[test]
    fn vectors_of_text_that_comes_back_are_there_at_once() {
        let (dir, mut conn) = fixture();
        let cols = vec!["repo:p".to_string()];
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        let first = pending_vectors(&conn, "s1", &cols, 100, false).unwrap();
        let items: Vec<(i64, Vec<f32>)> = first.iter().enumerate().map(|(i, (id, _))| (*id, vec![i as f32 + 1.0, 0.5])).collect();
        store_vectors(&mut conn, "s1", &items).unwrap();
        let original = std::fs::read_to_string(dir.0.join("docs/adr.md")).unwrap();

        // The other branch: the document is different, its passages leave; their vectors wait.
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(dir.0.join("docs/adr.md"), "# Storage\n\nWe chose Postgres.\n").unwrap();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors, 0);
        assert_eq!(space_usage(&conn).unwrap()[0].vectors, 0, "kept, not counted as live");
        let other: Vec<(i64, Vec<f32>)> = pending_vectors(&conn, "s1", &cols, 100, false).unwrap().iter().map(|(id, _)| (*id, vec![0.1, 0.9])).collect();
        store_vectors(&mut conn, "s1", &other).unwrap();

        // Back: the same text, new chunk ids, the old vectors — nothing pending.
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(dir.0.join("docs/adr.md"), &original).unwrap();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        assert!(pending_vectors(&conn, "s1", &cols, 100, false).unwrap().is_empty(), "every passage came back with its vector");
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors as usize, first.len());
        assert_eq!(pending_vectors(&conn, "s2", &cols, 100, false).unwrap().len(), first.len(), "another model's vectors are its own");
        let best = search_vectors(&conn, "s1", &cols, &[2.0, 0.5], 1).unwrap();
        assert_eq!(best[0].0.heading, "Retention", "the vector found is the one stored for that text");

        // Only the Postgres passage waits now; a prune lets it go once it has waited long enough.
        let now = chrono::Utc::now().timestamp_millis();
        assert_eq!(prune_orphan_vectors(&conn, now).unwrap(), 0, "not yet");
        assert_eq!(prune_orphan_vectors(&conn, now + ORPHAN_KEEP_MS + 1).unwrap(), 1);
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors as usize, first.len(), "live vectors are never pruned");
        drop_space(&conn, "s1").unwrap();
        assert!(space_usage(&conn).unwrap().is_empty());
    }

    /// The loss of 2026-11-23: a collection emptied and indexed again from scratch (every chunk a new
    /// id) has every vector it had.
    #[test]
    fn a_collection_emptied_and_indexed_again_keeps_every_vector() {
        let (dir, mut conn) = fixture();
        let cols = vec!["repo:p".to_string()];
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        let pending = pending_vectors(&conn, "s1", &cols, 100, true).unwrap();
        let items: Vec<(i64, Vec<f32>)> = pending.iter().map(|(id, _)| (*id, vec![1.0, 0.0])).collect();
        store_vectors(&mut conn, "s1", &items).unwrap();
        let max_before: i64 = conn.query_row("SELECT MAX(id) FROM chunks", [], |r| r.get(0)).unwrap();

        remove_collection(&conn, "repo:p").unwrap();
        compact(&conn).unwrap();
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().chunks, 0);
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();

        assert!(pending_vectors(&conn, "s1", &cols, 100, true).unwrap().is_empty(), "nothing to embed again");
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors as usize, items.len());
        assert!(has_vectors(&conn, "s1", &cols).unwrap());
        let min_after: i64 = conn.query_row("SELECT MIN(id) FROM chunks", [], |r| r.get(0)).unwrap();
        assert!(min_after <= max_before, "the chunks really are new rows (ids reused from 1): {min_after} vs {max_before}");
    }

    /// A chunk deleted while its vector was being made: storing it is a no-op, not an error.
    #[test]
    fn a_vector_for_a_chunk_that_left_is_dropped_quietly() {
        let (dir, mut conn) = fixture();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        store_vectors(&mut conn, "s1", &[(987_654, vec![1.0, 0.0])]).unwrap();
        assert!(space_usage(&conn).unwrap().is_empty());
    }

    /// An index of 2.9.2 (vectors by chunk id, a cache of left ones by text) is brought over whole:
    /// every vector ends up by text and nothing is pending.
    #[test]
    fn an_index_of_2_9_2_keeps_every_vector_when_opened() {
        let dir = tempdir::Dir::new();
        let path = dir.0.join("old.sqlite");
        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE sources (id INTEGER PRIMARY KEY, collection TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
                     mtime INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'code', indexed_at INTEGER NOT NULL DEFAULT 0,
                     private INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', rank INTEGER NOT NULL DEFAULT 0,
                     UNIQUE(collection, path));
                 CREATE TABLE chunks (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                     start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, heading TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, prose INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE vectors (chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE, space TEXT NOT NULL, data BLOB NOT NULL,
                     PRIMARY KEY (chunk_id, space));
                 CREATE TABLE collections_meta (collection TEXT PRIMARY KEY, root TEXT NOT NULL, refreshed_at INTEGER NOT NULL, head TEXT NOT NULL DEFAULT '');
                 CREATE TABLE vector_cache (hash TEXT NOT NULL, space TEXT NOT NULL, data BLOB NOT NULL, code INTEGER NOT NULL DEFAULT 0,
                     kept_at INTEGER NOT NULL, PRIMARY KEY (hash, space));
                 INSERT INTO sources (id, collection, path, kind) VALUES (1, 'notes:w', 'note:a', 'markdown'), (2, 'repo:p', 'a.ts', 'code');
                 INSERT INTO chunks (id, source_id, start_line, end_line, heading, text, prose) VALUES
                     (1, 1, 1, 2, 'Pedidos', 'Se guardan 90 días.', 1),
                     (2, 1, 3, 4, 'Sueldos', 'Del almacén.', 1),
                     (3, 2, 1, 3, '', 'export const total = 1;', 0);
                 INSERT INTO vectors (chunk_id, space, data) VALUES (1, 's1', x'0000803f00000000'), (3, 's1', x'000000000000803f');",
            )
            .unwrap();
            let left = embed_hash_of("Viejo", "Un pasaje que se fue.");
            old.execute("INSERT INTO vector_cache (hash, space, data, code, kept_at) VALUES (?1, 's1', x'00', 0, 5)", params![left]).unwrap();
        }
        let conn = open_at(&path).unwrap();
        assert!(!table_exists(&conn, "vectors").unwrap() && !table_exists(&conn, "vector_cache").unwrap());
        let unhashed: i64 = conn.query_row("SELECT COUNT(*) FROM chunks WHERE embed_hash = ''", [], |r| r.get(0)).unwrap();
        assert_eq!(unhashed, 0);
        let cols = vec!["notes:w".to_string(), "repo:p".to_string()];
        let pending = pending_vectors(&conn, "s1", &cols, 100, true).unwrap();
        assert_eq!(pending.len(), 1, "only the chunk that never had a vector: {pending:?}");
        assert!(pending[0].1.contains("almacén"));
        assert_eq!(status(&conn, "notes:w", Some("s1")).unwrap().vectors, 1);
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors, 1);
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 3, "two live and the one the cache held");
        let best = search_vectors(&conn, "s1", &cols, &[1.0, 0.0], 1).unwrap();
        assert_eq!(best[0].0.heading, "Pedidos", "the same vector, under its text");
        // Opened again: nothing to do, nothing lost.
        drop(conn);
        let again = open_at(&path).unwrap();
        assert_eq!(status(&again, "notes:w", Some("s1")).unwrap().vectors, 1);
    }

    /// The index of 2.9.2 in the cache root is moved, WAL and all, to the state root once; an index
    /// already there is never overwritten.
    #[test]
    fn the_old_index_moves_out_of_the_cache_whole_and_once() {
        let dir = tempdir::Dir::new();
        let legacy = dir.0.join("cache/knowledge/index.sqlite");
        let target = dir.0.join("state/knowledge/index.sqlite");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let fixture_dir = tempdir::Dir::new();
        std::fs::write(fixture_dir.0.join("a.md"), "# Uno\n\nTexto del pasaje.\n").unwrap();
        let held = {
            let mut old = open_at(&legacy).unwrap();
            // Kept open with its writes still in the WAL, as an app that crashed would leave it.
            old.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
            refresh(&mut old, "repo:p", &fixture_dir.0, &["a.md".to_string()]).unwrap();
            let pending = pending_vectors(&old, "s1", &["repo:p".to_string()], 10, false).unwrap();
            store_vectors(&mut old, "s1", &[(pending[0].0, vec![1.0, 0.0])]).unwrap();
            old
        };
        assert!(adopt_legacy(&legacy, &target).unwrap());
        drop(held);
        assert!(!legacy.exists(), "the old file goes once the copy is in place");
        let conn = open_at(&target).unwrap();
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors, 1, "the vector in the WAL came too");
        // A second launch: nothing to move, and an index already in place is never replaced.
        assert!(!adopt_legacy(&legacy, &target).unwrap());
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, b"not an index").unwrap();
        assert!(!adopt_legacy(&legacy, &target).unwrap());
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors, 1);
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
        let pending = pending_vectors(&conn, "s1", &cols, 100, false).unwrap();
        assert_eq!(pending.len(), 2, "the two Markdown sections, not the code");
        let items: Vec<(i64, Vec<f32>)> = pending.iter().enumerate().map(|(i, (id, _))| (*id, if i == 0 { vec![1.0, 0.0] } else { vec![0.0, 1.0] })).collect();
        store_vectors(&mut conn, "s1", &items).unwrap();
        assert!(pending_vectors(&conn, "s1", &cols, 100, false).unwrap().is_empty());
        assert_eq!(pending_vectors(&conn, "s2", &cols, 100, false).unwrap().len(), 2, "another space starts empty");
        let best = search_vectors(&conn, "s1", &cols, &[0.9, 0.1], 1).unwrap();
        assert_eq!(best[0].0.heading, "Storage");
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors, 2);
        assert!(has_vectors(&conn, "s1", &cols).unwrap() && !has_vectors(&conn, "s2", &cols).unwrap());
    }

    /// With code vectors on, the code file's chunk is pending too, after the prose; switched off, its
    /// vectors go and the prose's stay.
    #[test]
    fn code_gets_vectors_when_asked_and_loses_them_when_not() {
        let (dir, mut conn) = fixture();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        let cols = vec!["repo:p".to_string()];
        let pending = pending_vectors(&conn, "s1", &cols, 100, true).unwrap();
        assert_eq!(pending.len(), 3, "the two Markdown sections and the code");
        assert!(pending[2].1.contains("cartTotal"), "prose first, code after");
        assert_eq!(count_pending_vectors(&conn, "s1", &cols, true).unwrap(), 3);
        assert_eq!(count_pending_vectors(&conn, "s1", &cols, false).unwrap(), 2);
        let items: Vec<(i64, Vec<f32>)> = pending.iter().map(|(id, _)| (*id, vec![1.0, 0.0])).collect();
        store_vectors(&mut conn, "s1", &items).unwrap();
        assert_eq!(count_pending_vectors(&conn, "s1", &cols, true).unwrap(), 0);
        assert_eq!(drop_code_vectors(&conn).unwrap(), 1);
        assert_eq!(status(&conn, "repo:p", Some("s1")).unwrap().vectors, 2, "the prose keeps its vectors");
        assert_eq!(pending_vectors(&conn, "s1", &cols, 100, true).unwrap().len(), 1, "switched on again, the code is pending again");
    }

    /// Code is embedded most-imported first: a file the repository depends on before a leaf, recency
    /// only between equals.
    #[test]
    fn the_most_imported_code_is_embedded_first() {
        let (dir, mut conn) = fixture();
        std::fs::write(dir.0.join("util.ts"), "export const shared = 1;\n").unwrap();
        let mut all = files();
        all.push("util.ts".into());
        refresh(&mut conn, "repo:p", &dir.0, &all).unwrap();
        let cols = vec!["repo:p".to_string()];
        let code_order = |conn: &Connection| -> Vec<String> {
            pending_vectors(conn, "s1", &cols, 100, true).unwrap().into_iter().map(|(_, text)| text).filter(|t| !t.contains("Storage") && !t.contains("Retention")).collect()
        };
        let before = code_order(&conn);
        assert_eq!(before.len(), 2);
        let ranks = vec![("util.ts".to_string(), 7), ("src.ts".to_string(), 0), ("gone.ts".to_string(), 3)];
        assert_eq!(set_ranks(&mut conn, "repo:p", &ranks).unwrap(), 1, "only util.ts changed; an unknown path is ignored");
        assert_eq!(set_ranks(&mut conn, "repo:p", &ranks).unwrap(), 0, "nothing to write the second time");
        let after = code_order(&conn);
        assert!(after[0].contains("shared"), "the imported file first: {after:?}");
        let prose = pending_vectors(&conn, "s1", &cols, 100, true).unwrap();
        assert!(prose[0].1.contains("Storage") || prose[0].1.contains("Retention"), "prose still before any code");
    }

    /// What each model's vectors cost, and letting one model's go without touching the other's.
    #[test]
    fn a_models_vectors_are_counted_and_dropped_alone() {
        let (dir, mut conn) = fixture();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        let cols = vec!["repo:p".to_string()];
        let pending = pending_vectors(&conn, "s1", &cols, 100, false).unwrap();
        let items: Vec<(i64, Vec<f32>)> = pending.iter().map(|(id, _)| (*id, vec![1.0, 0.0])).collect();
        store_vectors(&mut conn, "old", &items).unwrap();
        store_vectors(&mut conn, "new", &items[..1]).unwrap();
        let usage = space_usage(&conn).unwrap();
        assert_eq!(usage.iter().map(|u| (u.space.as_str(), u.vectors)).collect::<Vec<_>>(), vec![("old", 2), ("new", 1)]);
        assert!(usage[0].bytes > 0);
        assert_eq!(drop_space(&conn, "old").unwrap(), 2);
        assert_eq!(space_usage(&conn).unwrap().len(), 1);
        assert_eq!(pending_vectors(&conn, "old", &cols, 100, false).unwrap().len(), 2, "the chunks stay, to be embedded again");
    }

    /// The held copy of a space follows the index: a vector stored after the first search is found
    /// by the second, and a file whose chunks went takes its vectors out of the copy too.
    #[test]
    fn the_vectors_held_in_memory_follow_every_write() {
        let (dir, mut conn) = fixture();
        refresh(&mut conn, "repo:p", &dir.0, &files()).unwrap();
        let cols = vec!["repo:p".to_string()];
        let pending = pending_vectors(&conn, "s1", &cols, 100, false).unwrap();
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
