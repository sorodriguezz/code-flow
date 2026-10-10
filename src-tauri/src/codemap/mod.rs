//! The repository map: what every code file of a project declares, imports and uses, kept current
//! without anyone asking for it to be built.
//!
//! The PR review's blast radius already proved the idea (`review::graph`), and its doc says why it
//! is built here and not by an external indexer: the app installs nothing. This generalises it from
//! one sweep per review into one cached index per repository that the local agent's tools, the
//! review, the documentation and story runs, the map view and the CLI agents (over MCP) all read.
//!
//! **Lazy, incremental, by content.**
//! - Nothing is read until something asks ([`snapshot`]). Opening a repository indexes nothing.
//! - Every file's facts are cached under its **git blob id** — the hash git itself gives that
//!   content. A branch switch re-reads only the files whose bytes changed, and a review reading the
//!   target branch out of the object database hits the same cache without opening a blob.
//! - The working tree is re-checked by size and modification time; a file whose stat is unchanged is
//!   not opened. The watcher marks what changed (`changed_paths`), so a watched repository is
//!   brought up to date file by file; one nobody watches is re-checked when it is asked for after
//!   [`STALE`]. The agent's own writes update their file at once ([`touch`]).
//! - The cache lives in [`crate::paths::cache_dir`], never in the repository: `git status` stays
//!   clean and deleting it costs one rebuild.
//!
//! What counts: the files git would track (its ignore rules, so `node_modules` and `target` are out
//! without configuration), minus what `.gitattributes` marks `linguist-generated` or
//! `linguist-vendored`, minus anything over [`extract::MAX_FILE_BYTES`], binary, or minified.

pub mod extract;
pub mod index;
pub mod mcp;
pub mod resolve;
pub mod summary;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use extract::Facts;
pub use index::Snapshot;
use index::FileRow;

/// How old a check of an unwatched working tree may be before a query re-checks it.
const STALE: Duration = Duration::from_secs(10);
/// A watched one is trusted for longer — its watcher reports every change — but not forever: a
/// burst the watcher dropped would otherwise never be noticed.
const WATCHED_STALE: Duration = Duration::from_secs(300);
/// Files a repository is indexed for, at most — the same ceiling as the editor's file search.
const MAX_FILES: usize = 20_000;
/// The least time between two writes of a repository's cache to disk.
const SAVE_EVERY: Duration = Duration::from_secs(20);
/// Format of the on-disk cache. A different value is a cold start, never a migration.
const CACHE_FORMAT: u32 = 1;

#[derive(Clone)]
struct Entry {
    mtime: u64,
    size: u64,
    blob: String,
}

struct RepoMap {
    root: PathBuf,
    git: bool,
    entries: HashMap<String, Entry>,
    facts: HashMap<String, Arc<Facts>>,
    snapshot: Option<Arc<Snapshot>>,
    checked: Option<Instant>,
    /// Something changed that a file-by-file update cannot describe (a folder moved, a burst the
    /// watcher could not itemise): the next query walks the tree.
    dirty: bool,
    touched: HashSet<String>,
    watched: bool,
    /// The last branch read out of the object database: its commit, its map, and the blobs it
    /// holds (kept in the cache with the working tree's).
    at_ref: Option<(String, Arc<Snapshot>, Vec<String>)>,
    loaded: bool,
    unsaved: bool,
    saved_at: Option<Instant>,
}

static MAPS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<RepoMap>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// How the last build went — for the run log line and the map view's footer.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub files: usize,
    pub symbols: usize,
    /// Files whose content had to be read and parsed (the rest came from the cache).
    pub parsed: usize,
    pub millis: u64,
}

fn canonical(root: &str) -> PathBuf {
    Path::new(root).canonicalize().unwrap_or_else(|_| PathBuf::from(root))
}

fn map_for(root: &str) -> Arc<Mutex<RepoMap>> {
    let root = canonical(root);
    let mut maps = MAPS.lock().unwrap_or_else(|e| e.into_inner());
    maps.entry(root.clone())
        .or_insert_with(|| {
            let git = git2::Repository::open(&root)
                .ok()
                .and_then(|repo| repo.workdir().map(|w| w.canonicalize().unwrap_or_else(|_| w.to_path_buf())))
                .is_some_and(|workdir| workdir == root);
            Arc::new(Mutex::new(RepoMap {
                root,
                git,
                entries: HashMap::new(),
                facts: HashMap::new(),
                snapshot: None,
                checked: None,
                dirty: true,
                touched: HashSet::new(),
                watched: false,
                at_ref: None,
                loaded: false,
                unsaved: false,
                saved_at: None,
            }))
        })
        .clone()
}

/// An existing map, without creating one — for the watcher, which must not start indexing a
/// repository nobody has asked about.
fn existing(root: &str) -> Option<Arc<Mutex<RepoMap>>> {
    let root = canonical(root);
    MAPS.lock().ok()?.get(&root).cloned()
}

/// The working tree's map, brought up to date. Blocking: call it from `spawn_blocking` in async code.
pub fn snapshot(root: &str) -> Result<(Arc<Snapshot>, BuildInfo), String> {
    let map = map_for(root);
    let mut map = map.lock().map_err(|e| e.to_string())?;
    map.refresh()
}

/// The map of `refname`'s tree, read from git's object database — the working tree is not touched.
pub fn snapshot_at(root: &str, refname: &str) -> Result<Arc<Snapshot>, String> {
    let map = map_for(root);
    let mut map = map.lock().map_err(|e| e.to_string())?;
    map.at_ref(refname)
}

/// The project map as text for a run that will read the repository — the documentation writer, a
/// story's analyst — so it starts from the structure instead of discovering it. `None` when the map
/// cannot be built. Blocking.
pub fn orientation(root: &str, budget: usize) -> Option<String> {
    let (map, _) = snapshot(root).ok()?;
    if map.file_count() == 0 {
        return None;
    }
    let all = crate::search::list_files(root).unwrap_or_else(|_| map.files.iter().map(|f| f.path.clone()).collect());
    Some(summary::project_map(&map, &all, budget))
}

/// Where a story most plausibly lands in this repository, as a short Markdown list for its analyst.
/// Blocking.
pub fn story_hint(root: &str, story: &str) -> Option<String> {
    let (map, _) = snapshot(root).ok()?;
    let points = summary::starting_points(&map, story, 8);
    if points.is_empty() {
        return None;
    }
    let mut out = String::from(
        "Starting points the repository map suggests (matched by the story's words, not by meaning — open them to check, and look beyond them):\n",
    );
    for (path, names) in points {
        if names.is_empty() {
            out.push_str(&format!("- {path}\n"));
        } else {
            out.push_str(&format!("- {path} — {}\n", names.join(", ")));
        }
    }
    Some(out)
}

/// A file was written by the app itself (the local agent): re-read it on the next query, without
/// walking the tree.
pub fn touch(root: &str, rel: &str) {
    if let Some(map) = existing(root) {
        if let Ok(mut map) = map.lock() {
            map.touched.insert(rel.replace('\\', "/"));
        }
    }
}

/// The watcher saw these paths change.
pub fn changed_paths(root: &str, paths: &[PathBuf]) {
    let Some(map) = existing(root) else { return };
    let Ok(mut map) = map.lock() else { return };
    for path in paths {
        let rel = path.strip_prefix(&map.root).ok().map(|p| p.to_string_lossy().replace('\\', "/"));
        match rel {
            // A folder (or something that is no longer a file and was never one we knew) cannot be
            // itemised from its name: walk the tree next time.
            Some(rel) if path.is_file() || map.entries.contains_key(&rel) => {
                map.touched.insert(rel);
            }
            Some(rel) if rel.is_empty() || rel.starts_with(".git/") || rel == ".git" => {}
            _ => map.dirty = true,
        }
    }
}

/// The watcher lost track (an overflowed event buffer): walk the tree next time.
pub fn invalidate(root: &str) {
    if let Some(map) = existing(root) {
        if let Ok(mut map) = map.lock() {
            map.dirty = true;
        }
    }
}

/// Whether a watcher is reporting this repository's changes — a watched map trusts its last check
/// for longer.
pub fn set_watched(root: &str, watched: bool) {
    let map = map_for(root);
    if let Ok(mut map) = map.lock() {
        map.watched = watched;
        if !watched {
            map.dirty = true;
        }
    };
}

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A file that is code by name but not worth reading: minified bundles and generated blobs.
fn is_minified(path: &str, text: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.contains(".min.") || name.ends_with(".bundle.js") {
        return true;
    }
    let lines = text.lines().count().max(1);
    text.len() / lines > 400
}

fn attr_true(repo: &git2::Repository, path: &str, name: &str) -> bool {
    repo.get_attr(Path::new(path), name, git2::AttrCheckFlags::FILE_THEN_INDEX)
        .ok()
        .flatten()
        .is_some_and(|value| matches!(git2::AttrValue::from_string(Some(value)), git2::AttrValue::True) || value == "true")
}

impl RepoMap {
    fn cache_path(&self) -> PathBuf {
        let key = git2::Oid::hash_object(git2::ObjectType::Blob, self.root.to_string_lossy().as_bytes())
            .map(|oid| oid.to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        // Tests index throwaway repositories: their caches go to the temp dir, never the user's.
        let base = if cfg!(test) { std::env::temp_dir().join("codeflow-codemap-tests") } else { crate::paths::cache_dir().join("codemap") };
        base.join(format!("{key}.json.gz"))
    }

    fn load(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let Ok(bytes) = std::fs::read(self.cache_path()) else { return };
        let mut text = String::new();
        if std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(bytes.as_slice()), &mut text).is_err() {
            return;
        }
        let Ok(cache) = serde_json::from_str::<CacheFile>(&text) else { return };
        if cache.format != CACHE_FORMAT || cache.extractor != extract::VERSION {
            return;
        }
        for (path, (mtime, size, blob)) in cache.entries {
            self.entries.insert(path, Entry { mtime, size, blob });
        }
        for (blob, facts) in cache.facts {
            self.facts.insert(blob, Arc::new(facts));
        }
    }

    /// Writes the cache, in the background, at most every [`SAVE_EVERY`]. Facts no entry and no
    /// cached branch points at are dropped on the way out.
    fn save(&mut self) {
        if !self.unsaved || self.saved_at.is_some_and(|at| at.elapsed() < SAVE_EVERY) {
            return;
        }
        self.unsaved = false;
        self.saved_at = Some(Instant::now());
        let mut live: HashSet<String> = self.entries.values().map(|e| e.blob.clone()).collect();
        if let Some((_, _, blobs)) = &self.at_ref {
            live.extend(blobs.iter().cloned());
        }
        self.facts.retain(|blob, _| live.contains(blob));
        let entries: HashMap<String, (u64, u64, String)> =
            self.entries.iter().map(|(path, e)| (path.clone(), (e.mtime, e.size, e.blob.clone()))).collect();
        let facts: Vec<(String, Arc<Facts>)> = self.facts.iter().map(|(blob, facts)| (blob.clone(), facts.clone())).collect();
        let target = self.cache_path();
        std::thread::spawn(move || {
            let facts: HashMap<String, Facts> = facts.into_iter().map(|(blob, facts)| (blob, (*facts).clone())).collect();
            let cache = CacheFile { format: CACHE_FORMAT, extractor: extract::VERSION, entries, facts };
            let Ok(json) = serde_json::to_vec(&cache) else { return };
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            if std::io::Write::write_all(&mut encoder, &json).is_err() {
                return;
            }
            let Ok(gz) = encoder.finish() else { return };
            if let Some(dir) = target.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = target.with_extension(format!("tmp-{}", std::process::id()));
            if std::fs::write(&tmp, gz).is_ok() {
                let _ = std::fs::rename(&tmp, &target);
            }
        });
    }

    fn list(&self) -> Vec<String> {
        let root = self.root.to_string_lossy().to_string();
        let files = if self.git {
            crate::search::list_files(&root).unwrap_or_default()
        } else {
            crate::local_agent::tools::plain_walk(&self.root, MAX_FILES)
        };
        let repo = self.git.then(|| git2::Repository::open(&self.root).ok()).flatten();
        files
            .into_iter()
            .filter(|path| extract::language_of(path).is_some())
            .filter(|path| {
                repo.as_ref().is_none_or(|repo| !attr_true(repo, path, "linguist-generated") && !attr_true(repo, path, "linguist-vendored"))
            })
            .take(MAX_FILES)
            .collect()
    }

    /// Reads one working-tree file into `self` if its stat moved. `Ok(true)` when it had to be parsed.
    fn update_file(&mut self, rel: &str, parse: &mut Vec<(String, String, String, u64, u64)>) -> bool {
        let full = self.root.join(rel);
        let Ok(meta) = std::fs::metadata(&full) else {
            return self.entries.remove(rel).is_some();
        };
        if !meta.is_file() || meta.len() > extract::MAX_FILE_BYTES || extract::language_of(rel).is_none() {
            return self.entries.remove(rel).is_some();
        }
        let (mtime, size) = (mtime_of(&meta), meta.len());
        if let Some(entry) = self.entries.get(rel) {
            if entry.mtime == mtime && entry.size == size && self.facts.contains_key(&entry.blob) {
                return false;
            }
        }
        let Ok(bytes) = std::fs::read(&full) else { return self.entries.remove(rel).is_some() };
        if crate::search::looks_binary(&bytes) {
            return self.entries.remove(rel).is_some();
        }
        let blob = git2::Oid::hash_object(git2::ObjectType::Blob, &bytes).map(|o| o.to_string()).unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if is_minified(rel, &text) {
            return self.entries.remove(rel).is_some();
        }
        if self.facts.contains_key(&blob) {
            self.entries.insert(rel.to_string(), Entry { mtime, size, blob });
        } else {
            parse.push((rel.to_string(), text, blob, mtime, size));
        }
        true
    }

    fn refresh(&mut self) -> Result<(Arc<Snapshot>, BuildInfo), String> {
        let started = Instant::now();
        self.load();
        let stale_after = if self.watched { WATCHED_STALE } else { STALE };
        let fresh = self.checked.is_some_and(|at| at.elapsed() < stale_after);
        if let Some(snapshot) = &self.snapshot {
            if fresh && !self.dirty && self.touched.is_empty() {
                let info = BuildInfo { files: snapshot.file_count(), symbols: snapshot.symbol_count(), parsed: 0, millis: 0 };
                return Ok((snapshot.clone(), info));
            }
        }
        let mut parse = Vec::new();
        let mut changed = false;
        if self.dirty || !fresh || self.snapshot.is_none() {
            let listed = self.list();
            let keep: HashSet<&str> = listed.iter().map(String::as_str).collect();
            let before = self.entries.len();
            self.entries.retain(|path, _| keep.contains(path.as_str()));
            changed |= self.entries.len() != before;
            for rel in &listed {
                changed |= self.update_file(rel, &mut parse);
            }
            self.dirty = false;
        } else {
            let touched: Vec<String> = self.touched.iter().cloned().collect();
            for rel in touched {
                // A new file the watcher reported is indexed only if git would track it.
                if !self.entries.contains_key(&rel) && self.git {
                    let ignored = git2::Repository::open(&self.root).ok().is_some_and(|repo| repo.is_path_ignored(Path::new(&rel)).unwrap_or(false));
                    if ignored {
                        continue;
                    }
                }
                changed |= self.update_file(&rel, &mut parse);
            }
        }
        self.touched.clear();
        let parsed = parse.len();
        for (rel, facts, blob, mtime, size) in extract_all(parse) {
            self.facts.insert(blob.clone(), Arc::new(facts));
            self.entries.insert(rel, Entry { mtime, size, blob });
        }
        self.checked = Some(Instant::now());
        if changed || parsed > 0 || self.snapshot.is_none() {
            let rows: Vec<FileRow> = self
                .entries
                .iter()
                .filter_map(|(path, entry)| self.facts.get(&entry.blob).map(|facts| FileRow { path: path.clone(), facts: facts.clone() }))
                .collect();
            self.snapshot = Some(Arc::new(Snapshot::build(rows)));
            self.unsaved = true;
        }
        self.save();
        let snapshot = self.snapshot.clone().ok_or("the map could not be built")?;
        let info = BuildInfo { files: snapshot.file_count(), symbols: snapshot.symbol_count(), parsed, millis: started.elapsed().as_millis() as u64 };
        Ok((snapshot, info))
    }

    fn at_ref(&mut self, refname: &str) -> Result<Arc<Snapshot>, String> {
        self.load();
        let repo = git2::Repository::open(&self.root).map_err(|e| e.message().to_string())?;
        let commit = crate::git::diff::resolve_branch_commit(&repo, refname)?;
        let commit_id = commit.id().to_string();
        if let Some((cached, snapshot, _)) = &self.at_ref {
            if *cached == commit_id {
                return Ok(snapshot.clone());
            }
        }
        let tree = commit.tree().map_err(|e| e.message().to_string())?;
        let mut blobs: Vec<(String, git2::Oid)> = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) && blobs.len() < MAX_FILES {
                if let Some(name) = entry.name() {
                    let path = format!("{dir}{name}").replace('\\', "/");
                    if extract::language_of(&path).is_some() {
                        blobs.push((path, entry.id()));
                    }
                }
            }
            git2::TreeWalkResult::Ok
        })
        .map_err(|e| e.message().to_string())?;
        let mut parse = Vec::new();
        let mut rows_known: Vec<(String, String)> = Vec::new();
        let ids: Vec<String> = blobs.iter().map(|(_, oid)| oid.to_string()).collect();
        for (path, oid) in blobs {
            let blob_id = oid.to_string();
            if self.facts.contains_key(&blob_id) {
                rows_known.push((path, blob_id));
                continue;
            }
            if attr_true(&repo, &path, "linguist-generated") || attr_true(&repo, &path, "linguist-vendored") {
                continue;
            }
            let Ok(blob) = repo.find_blob(oid) else { continue };
            if blob.size() as u64 > extract::MAX_FILE_BYTES || blob.is_binary() {
                continue;
            }
            let text = String::from_utf8_lossy(blob.content()).into_owned();
            if is_minified(&path, &text) {
                continue;
            }
            parse.push((path, text, blob_id, 0, 0));
        }
        let mut rows: Vec<FileRow> = rows_known
            .into_iter()
            .filter_map(|(path, blob)| self.facts.get(&blob).map(|facts| FileRow { path, facts: facts.clone() }))
            .collect();
        for (path, facts, blob, _, _) in extract_all(parse) {
            let facts = Arc::new(facts);
            self.facts.insert(blob, facts.clone());
            rows.push(FileRow { path, facts });
        }
        let snapshot = Arc::new(Snapshot::build(rows));
        self.at_ref = Some((commit_id, snapshot.clone(), ids));
        self.unsaved = true;
        self.save();
        Ok(snapshot)
    }
}

/// Parses every file in `parse` across the machine's cores.
fn extract_all(parse: Vec<(String, String, String, u64, u64)>) -> Vec<(String, Facts, String, u64, u64)> {
    if parse.is_empty() {
        return Vec::new();
    }
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8).min(parse.len());
    let chunk = parse.len().div_ceil(workers);
    let mut chunks: Vec<Vec<(String, String, String, u64, u64)>> = Vec::new();
    let mut parse = parse;
    while !parse.is_empty() {
        let rest = parse.split_off(chunk.min(parse.len()));
        chunks.push(std::mem::replace(&mut parse, rest));
    }
    std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .into_iter()
                        .map(|(path, text, blob, mtime, size)| {
                            let facts = extract::extract(&path, &text);
                            (path, facts, blob, mtime, size)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    format: u32,
    extractor: u32,
    entries: HashMap<String, (u64, u64, String)>,
    facts: HashMap<String, Facts>,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("codeflow-codemap-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn repo() -> TempDir {
        let dir = TempDir::new();
        let repo = git2::Repository::init(&dir.0).unwrap();
        std::fs::create_dir_all(dir.0.join("src")).unwrap();
        std::fs::create_dir_all(dir.0.join("node_modules/lib")).unwrap();
        std::fs::write(dir.0.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(dir.0.join(".gitattributes"), "src/gen.ts linguist-generated\n").unwrap();
        std::fs::write(dir.0.join("src/pricing.ts"), "export function applyDiscount(p: number) { return p; }\n").unwrap();
        std::fs::write(dir.0.join("src/cart.ts"), "import { applyDiscount } from './pricing';\nexport const t = applyDiscount(1);\n").unwrap();
        std::fs::write(dir.0.join("src/gen.ts"), "export function generated() {}\n").unwrap();
        std::fs::write(dir.0.join("node_modules/lib/index.js"), "export function vendored() {}\n").unwrap();
        std::fs::write(dir.0.join("README.md"), "# x\n").unwrap();
        // Committed so a branch can be read back out of the object database.
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        dir
    }

    /// `CODEMAP_BENCH_ROOT=/path/to/repo cargo test --lib codemap::tests::bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench() {
        let Ok(root) = std::env::var("CODEMAP_BENCH_ROOT") else { return };
        let started = Instant::now();
        let (map, info) = snapshot(&root).unwrap();
        eprintln!("cold: {} files, {} symbols, parsed {} in {} ms", info.files, info.symbols, info.parsed, started.elapsed().as_millis());
        let started = Instant::now();
        let (_, info) = snapshot(&root).unwrap();
        eprintln!("warm: parsed {} in {} ms", info.parsed, started.elapsed().as_millis());
        for (lang, n) in summary::languages(&map) {
            eprintln!("  {lang}: {n}");
        }
        let precise = map.files.iter().filter(|f| f.facts.precise).count();
        eprintln!("precise (tree-sitter): {precise}");
        for name in std::env::var("CODEMAP_BENCH_NAMES").unwrap_or_default().split(',').filter(|n| !n.is_empty()) {
            let report = map.usages(name, None, 8);
            eprintln!("\n--- usages of {name}:\n{}", summary::usages_text(&report, name));
            eprintln!("--- find {name}:\n{}", summary::symbols_text(&map.find_symbol(name, 5), name));
        }
        let all: Vec<String> = map.files.iter().map(|f| f.path.clone()).collect();
        let text = summary::project_map(&map, &all, 6_000);
        eprintln!("\n--- project map ({} chars):\n{}", text.len(), text);
        let started = Instant::now();
        let g = summary::graph(&map, "");
        eprintln!("\ngraph focus {:?}: {} nodes, {} edges in {} ms", g.focus, g.nodes.len(), g.edges.len(), started.elapsed().as_millis());
        // Fixtures for a browser probe of the «Mapa» view: `CODEMAP_BENCH_DUMP=<dir>`.
        if let Ok(out) = std::env::var("CODEMAP_BENCH_DUMP") {
            let out = PathBuf::from(out);
            let _ = std::fs::create_dir_all(&out);
            let build = BuildInfo { files: map.file_count(), symbols: map.symbol_count(), parsed: 0, millis: 0 };
            let mut graphs = serde_json::Map::new();
            for focus in ["", "src", "src/components", "src/lib", "src-tauri/src", "src/state"] {
                let g = summary::graph(&map, focus);
                graphs.insert(focus.to_string(), serde_json::json!({ "graph": g, "build": build }));
            }
            std::fs::write(out.join("graphs.json"), serde_json::Value::Object(graphs).to_string()).unwrap();
            let global = summary::global_graph(&map, 140);
            std::fs::write(out.join("global.json"), serde_json::json!({ "graph": global, "build": build }).to_string()).unwrap();
            let mut outlines = serde_json::Map::new();
            for row in map.files.iter().filter(|f| f.path.starts_with("src/state/") || f.path.starts_with("src/lib/codemap") || f.path.contains("CodeMapView")) {
                outlines.insert(row.path.clone(), serde_json::to_value(map.outline(&row.path)).unwrap());
            }
            std::fs::write(out.join("outlines.json"), serde_json::Value::Object(outlines).to_string()).unwrap();
            std::fs::write(out.join("keys.json"), serde_json::to_string(&map.key_symbols(40)).unwrap()).unwrap();
            std::fs::write(out.join("find-ui.json"), serde_json::to_string(&map.find_symbol("useUiStore", 30)).unwrap()).unwrap();
            std::fs::write(out.join("usages-ui.json"), serde_json::to_string(&map.usages("useUiStore", None, 200)).unwrap()).unwrap();
        }
    }

    #[test]
    fn indexes_what_git_tracks_and_skips_generated_and_ignored() {
        let dir = repo();
        let root = dir.0.to_string_lossy().to_string();
        let (map, info) = snapshot(&root).unwrap();
        let paths: Vec<&str> = map.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["src/cart.ts", "src/pricing.ts"], "no README, no node_modules, no generated file");
        assert_eq!(info.parsed, 2);
        let usages = map.usages("applyDiscount", Some("src/pricing.ts"), 10);
        assert_eq!(usages.usages.len(), 1);
    }

    #[test]
    fn a_touched_file_is_re_read_without_walking_and_an_unchanged_one_is_not() {
        let dir = repo();
        let root = dir.0.to_string_lossy().to_string();
        let (_, first) = snapshot(&root).unwrap();
        assert_eq!(first.parsed, 2);
        let (again, info) = snapshot(&root).unwrap();
        assert_eq!(info.parsed, 0, "fresh and nothing changed");
        std::fs::write(dir.0.join("src/cart.ts"), "export function checkout() {}\n").unwrap();
        touch(&root, "src/cart.ts");
        let (after, info) = snapshot(&root).unwrap();
        assert_eq!(info.parsed, 1);
        assert!(!Arc::ptr_eq(&again, &after));
        assert_eq!(after.find_symbol("checkout", 5).len(), 1);
    }

    #[test]
    fn a_branch_is_read_from_the_object_database_through_the_same_cache() {
        let dir = repo();
        let root = dir.0.to_string_lossy().to_string();
        snapshot(&root).unwrap();
        // The working tree moves on; HEAD still has the committed content.
        std::fs::write(dir.0.join("src/pricing.ts"), "export function renamed() {}\n").unwrap();
        let head = snapshot_at(&root, "HEAD").unwrap();
        assert_eq!(head.find_symbol("applyDiscount", 5).len(), 1);
        assert!(head.find_symbol("generated", 5).is_empty(), "attributes apply to a branch too");
    }
}
